import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { test } from "node:test";
import { Context, Effect, Fiber, Layer } from "effect";
import { WebSocketServer } from "ws";
import { makeT3Client, T3Client, T3TransportError, type T3ClientOptions } from "../src/t3.js";
import type { JsonRecord, SourceItem } from "../src/types.js";

const token = "read-scope-test-token";

interface MockServer {
  baseUrl: string;
  http: ReturnType<typeof createServer>;
  webSockets: WebSocketServer;
  close(): Promise<void>;
}

interface HungHandshakeServer {
  baseUrl: string;
  accepted: Promise<void>;
  close(): Promise<void>;
}

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const makeProjection = (threadId: string): JsonRecord => ({
  thread: {
    id: threadId,
    title: "Supervisor test",
    projectId: "project-1",
    lineage: { parentThreadId: null, relationshipToParent: null }
  },
  runs: [
    {
      id: "run-cancelled",
      ordinal: 1,
      status: "cancelled",
      requestedAt: "2026-10-07T10:00:00.000Z",
      startedAt: null,
      completedAt: "2026-10-07T10:00:01.000Z",
      rootNodeId: null
    },
    {
      id: "run-completed",
      ordinal: 2,
      status: "completed",
      requestedAt: "2026-10-07T10:01:00.000Z",
      startedAt: "2026-10-07T10:01:01.000Z",
      completedAt: "2026-10-07T10:02:00.000Z",
      rootNodeId: "node-root"
    }
  ],
  messages: []
});

const makeBoundedProjection = (threadId: string, overrides: JsonRecord = {}): JsonRecord => ({
  ...makeProjection(threadId),
  nodes: [],
  runtimeRequests: [],
  turnItems: [],
  subagents: [],
  providerThreads: [],
  ...overrides
});

const makeBoundedCompletionSnapshot = (threadId: string, overrides: JsonRecord = {}): JsonRecord => ({
  snapshotSequence: 19,
  schemaVersion: 2,
  projection: makeBoundedProjection(threadId),
  historyCursor: "history-cursor-1",
  hasMoreHistory: true,
  latestLocalTurnOrdinal: 2,
  payloadBudgetExceeded: false,
  ...overrides
});

const makeShellSnapshot = (threads: JsonRecord[]): JsonRecord => ({
  schemaVersion: 2,
  snapshotSequence: 20,
  projects: [],
  threads,
});

const sendJson = (response: ServerResponse, status: number, value: unknown): void => {
  const body = JSON.stringify(value);
  response.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
  response.end(body);
};

const startMockServer = async (
  onHttp: (request: IncomingMessage, response: ServerResponse) => void
): Promise<MockServer> => {
  const http = createServer(onHttp);
  const webSockets = new WebSocketServer({ server: http, path: "/ws" });
  await new Promise<void>((resolve, reject) => {
    http.once("error", reject);
    http.listen(0, "127.0.0.1", resolve);
  });
  const address = http.address();
  if (address === null || typeof address === "string") throw new Error("mock server did not bind a TCP port");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    http,
    webSockets,
    close: async () => {
      for (const socket of webSockets.clients) socket.terminate();
      await new Promise<void>((resolve, reject) => {
        webSockets.close((error) => error ? reject(error) : resolve());
      });
      await new Promise<void>((resolve, reject) => {
        http.close((error) => error ? reject(error) : resolve());
      });
    }
  };
};

const startHungHandshakeServer = async (): Promise<HungHandshakeServer> => {
  const server = createServer();
  const sockets = new Set<Duplex>();
  const connectionAccepted = deferred<void>();
  server.on("upgrade", (_request, socket) => {
    sockets.add(socket);
    connectionAccepted.resolve();
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("mock server did not bind a TCP port");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    accepted: connectionAccepted.promise,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    }
  };
};

const getClient = async (
  baseUrl: string,
  extra: Omit<T3ClientOptions, "baseUrl" | "token"> = {}
) => {
  const layer = makeT3Client({ baseUrl, token, ...extra });
  return Effect.runPromise(Effect.scoped(Effect.gen(function*() {
    const context = yield* Layer.build(layer);
    return Context.get(context, T3Client);
  })));
};

const deferred = <A = void>() => {
  let resolve!: (value: A) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<A>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

const within = <A>(promise: Promise<A>, milliseconds = 2500): Promise<A> =>
  new Promise<A>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out waiting for mock T3 event")), milliseconds);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });

test("descriptor and full projection use read-only authenticated protocol 2 requests", async () => {
  const requests: Array<{ path: string; authorization: string | undefined; protocol: string | undefined }> = [];
  const threadId = "thread/with space";
  const server = await startMockServer((request, response) => {
    requests.push({
      path: request.url ?? "",
      authorization: request.headers.authorization,
      protocol: request.headers["x-t3-orchestration-protocol"] as string | undefined
    });
    if (request.url === "/.well-known/t3/environment") {
      sendJson(response, 200, {
        environmentId: "environment-1",
        orchestrationProtocolVersion: 2,
        serverVersion: "nightly-test",
        additionalField: true
      });
      return;
    }
    sendJson(response, 200, {
      snapshotSequence: 19,
      projection: makeProjection(threadId),
      additionalField: "preserved"
    });
  });

  try {
    const client = await getClient(server.baseUrl);
    const descriptor = await Effect.runPromise(client.descriptor());
    const snapshot = await Effect.runPromise(client.projection(threadId));
    assert.equal(descriptor.environmentId, "environment-1");
    assert.equal(descriptor.orchestrationProtocolVersion, 2);
    assert.equal(descriptor.additionalField, true);
    assert.equal(snapshot.snapshotSequence, 19);
    assert.equal(snapshot.projection.thread.id, threadId);
    assert.equal(snapshot.projection.runs[0]?.rootNodeId, null);
    assert.equal(snapshot.projection.runs[1]?.rootNodeId, "node-root");
    assert.equal(snapshot.additionalField, "preserved");
    assert.deepEqual(requests, [
      {
        path: "/.well-known/t3/environment",
        authorization: `Bearer ${token}`,
        protocol: undefined
      },
      {
        path: `/api/orchestration/threads/${encodeURIComponent(threadId)}`,
        authorization: `Bearer ${token}`,
        protocol: "2"
      }
    ]);
  } finally {
    await server.close();
  }
});

test("thread shell reader requires native root ancestry and uses the bounded shell route", async () => {
  const requests: Array<{path: string; authorization: string | undefined; protocol: string | undefined}> = [];
  const shell = {
    id: "child-thread",
    title: "Question thread",
    projectId: null,
    lineage: {parentThreadId: "managed-root", relationshipToParent: "fork", rootThreadId: "managed-root"},
  };
  const server = await startMockServer((request, response) => {
    requests.push({
      path: request.url ?? "",
      authorization: request.headers.authorization,
      protocol: request.headers["x-t3-orchestration-protocol"] as string | undefined,
    });
    sendJson(response, 200, makeShellSnapshot([shell]));
  });
  try {
    const client = await getClient(server.baseUrl);
    assert.ok(client.threadShells);
    const threads = await Effect.runPromise(client.threadShells());
    assert.equal(threads[0]?.lineage.rootThreadId, "managed-root");
    assert.deepEqual(requests, [{
      path: "/api/orchestration/shell",
      authorization: `Bearer ${token}`,
      protocol: "2",
    }]);
  } finally {
    await server.close();
  }
});

test("thread shell reader rejects a shell without root ancestry", async () => {
  const server = await startMockServer((_request, response) => {
    sendJson(response, 200, makeShellSnapshot([{
      id: "child-thread",
      title: "Question thread",
      projectId: null,
      lineage: {parentThreadId: "managed-root", relationshipToParent: "fork"},
    }]));
  });
  try {
    const client = await getClient(server.baseUrl);
    assert.ok(client.threadShells);
    await assert.rejects(Effect.runPromise(client.threadShells()), T3TransportError);
  } finally {
    await server.close();
  }
});

test("bounded completion projection uses the encoded bounded route and accepts its window metadata", async () => {
  const requests: Array<{ path: string; authorization: string | undefined; protocol: string | undefined }> = [];
  const threadId = "thread/with space";
  const server = await startMockServer((request, response) => {
    requests.push({
      path: request.url ?? "",
      authorization: request.headers.authorization,
      protocol: request.headers["x-t3-orchestration-protocol"] as string | undefined
    });
    sendJson(response, 200, makeBoundedCompletionSnapshot(threadId, {
      payloadBudgetExceeded: true,
      additionalField: "preserved"
    }));
  });

  try {
    const client = await getClient(server.baseUrl);
    assert.ok(client.boundedCompletionProjection);
    const snapshot = await Effect.runPromise(client.boundedCompletionProjection(threadId));
    assert.equal(snapshot.snapshotSequence, 19);
    assert.equal(snapshot.schemaVersion, 2);
    assert.equal(snapshot.projection.thread.id, threadId);
    assert.equal(snapshot.historyCursor, "history-cursor-1");
    assert.equal(snapshot.hasMoreHistory, true);
    assert.equal(snapshot.latestLocalTurnOrdinal, 2);
    assert.equal(snapshot.payloadBudgetExceeded, true);
    assert.equal(snapshot.additionalField, "preserved");
    assert.deepEqual(requests, [{
      path: `/api/orchestration/threads/${encodeURIComponent(threadId)}/bounded`,
      authorization: `Bearer ${token}`,
      protocol: "2"
    }]);
  } finally {
    await server.close();
  }
});

test("bounded completion projection rejects mismatched thread, schema, and window fields", async () => {
  const threadId = "thread-1";
  let responseBody: JsonRecord = makeBoundedCompletionSnapshot(threadId);
  const server = await startMockServer((_request, response) => sendJson(response, 200, responseBody));
  const turnItem = { id: "turn-1", ordinal: 3 };
  const invalidSnapshots: Array<{ name: string; value: JsonRecord }> = [
    {
      name: "thread mismatch",
      value: makeBoundedCompletionSnapshot(threadId, {
        projection: makeBoundedProjection("other-thread")
      })
    },
    {
      name: "snapshot schema mismatch",
      value: makeBoundedCompletionSnapshot(threadId, { schemaVersion: 3 })
    },
    {
      name: "projection schema mismatch",
      value: makeBoundedCompletionSnapshot(threadId, {
        projection: makeBoundedProjection(threadId, { schemaVersion: 3 })
      })
    },
    {
      name: "invalid hasMoreHistory flag",
      value: makeBoundedCompletionSnapshot(threadId, { hasMoreHistory: "true" })
    },
    {
      name: "history cursor missing while history remains",
      value: makeBoundedCompletionSnapshot(threadId, { historyCursor: null })
    },
    {
      name: "history cursor present without more history",
      value: makeBoundedCompletionSnapshot(threadId, { hasMoreHistory: false })
    },
    {
      name: "invalid latest local ordinal",
      value: makeBoundedCompletionSnapshot(threadId, { latestLocalTurnOrdinal: -1 })
    },
    {
      name: "latest local ordinal below the included window",
      value: makeBoundedCompletionSnapshot(threadId, {
        projection: makeBoundedProjection(threadId, { turnItems: [turnItem] }),
        latestLocalTurnOrdinal: 2
      })
    },
    {
      name: "invalid payload budget flag",
      value: makeBoundedCompletionSnapshot(threadId, { payloadBudgetExceeded: "true" })
    },
    {
      name: "compact turn item marker",
      value: makeBoundedCompletionSnapshot(threadId, { turnItemsOmitLocalVisible: true })
    }
  ];

  for (const field of ["nodes", "runtimeRequests", "turnItems", "subagents", "providerThreads"] as const) {
    const missingProjectionField = makeBoundedProjection(threadId);
    delete missingProjectionField[field];
    invalidSnapshots.push({
      name: `missing projection ${field}`,
      value: makeBoundedCompletionSnapshot(threadId, { projection: missingProjectionField })
    });
    invalidSnapshots.push({
      name: `invalid records in projection ${field}`,
      value: makeBoundedCompletionSnapshot(threadId, {
        projection: makeBoundedProjection(threadId, { [field]: [null] })
      })
    });
  }

  try {
    const client = await getClient(server.baseUrl);
    assert.ok(client.boundedCompletionProjection);
    for (const invalid of invalidSnapshots) {
      responseBody = invalid.value;
      await assert.rejects(
        Effect.runPromise(client.boundedCompletionProjection(threadId)),
        T3TransportError,
        invalid.name
      );
    }
  } finally {
    await server.close();
  }
});

test("full projection reader continues rejecting bounded history windows", async () => {
  const threadId = "thread-1";
  let responseBody: JsonRecord = {
    snapshotSequence: 19,
    projection: makeProjection(threadId),
    hasMoreHistory: true
  };
  const server = await startMockServer((_request, response) => sendJson(response, 200, responseBody));

  try {
    const client = await getClient(server.baseUrl);
    await assert.rejects(Effect.runPromise(client.projection(threadId)), T3TransportError);
    responseBody = {
      snapshotSequence: 19,
      projection: makeProjection(threadId),
      historyCursor: "history-cursor-1"
    };
    await assert.rejects(Effect.runPromise(client.projection(threadId)), T3TransportError);
  } finally {
    await server.close();
  }
});

test("descriptor rejects an unknown orchestration protocol", async () => {
  const server = await startMockServer((_request, response) => {
    sendJson(response, 200, {
      environmentId: "environment-1",
      orchestrationProtocolVersion: 3,
      serverVersion: "future-server"
    });
  });

  try {
    const client = await getClient(server.baseUrl);
    await assert.rejects(Effect.runPromise(client.descriptor()), T3TransportError);
  } finally {
    await server.close();
  }
});

test("HTTP response budget and failures do not disclose bearer credentials or response bodies", async () => {
  const server = await startMockServer((request, response) => {
    if (request.url === "/.well-known/t3/environment") {
      sendJson(response, 401, { message: `invalid ${token}` });
      return;
    }
    sendJson(response, 200, { payload: "x".repeat(512) });
  });

  try {
    const client = await getClient(server.baseUrl, { maxResponseBytes: 64 });
    let authFailure: unknown;
    try {
      await Effect.runPromise(client.descriptor());
    } catch (error) {
      authFailure = error;
    }
    assert.ok(authFailure instanceof T3TransportError);
    assert.match(authFailure.message, /HTTP 401/);
    assert.equal(authFailure.message.includes(token), false);

    let budgetFailure: unknown;
    try {
      await Effect.runPromise(client.projection("thread-1"));
    } catch (error) {
      budgetFailure = error;
    }
    assert.ok(budgetFailure instanceof T3TransportError);
    assert.match(budgetFailure.message, /byte limit/);
    assert.equal(budgetFailure.code, "response_too_large");
    assert.equal(budgetFailure.message.includes(token), false);
  } finally {
    await server.close();
  }
});

test("HTTP streamed response limit has a typed response_too_large code", async () => {
  const server = await startMockServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.write('{"payload":"');
    response.end(`${"x".repeat(512)}"}`);
  });

  try {
    const client = await getClient(server.baseUrl, { maxResponseBytes: 64 });
    assert.ok(client.boundedCompletionProjection);
    await assert.rejects(
      Effect.runPromise(client.boundedCompletionProjection("thread-1")),
      (error: unknown) => error instanceof T3TransportError && error.code === "response_too_large"
    );
  } finally {
    await server.close();
  }
});

test("bounded completion response above the one MiB advisory budget stays below the HTTP cap", async () => {
  const threadId = "thread-large";
  const targetBytes = 8_879_187;
  const snapshot = makeBoundedCompletionSnapshot(threadId, { payloadBudgetExceeded: true });
  snapshot.padding = "";
  const baseBytes = Buffer.byteLength(JSON.stringify(snapshot));
  snapshot.padding = "x".repeat(targetBytes - baseBytes);
  assert.equal(Buffer.byteLength(JSON.stringify(snapshot)), targetBytes);

  const server = await startMockServer((_request, response) => sendJson(response, 200, snapshot));

  try {
    const client = await getClient(server.baseUrl);
    assert.ok(client.boundedCompletionProjection);
    const received = await Effect.runPromise(client.boundedCompletionProjection(threadId));
    assert.equal(received.payloadBudgetExceeded, true);
    assert.equal(received.padding, "x".repeat(targetBytes - baseBytes));
  } finally {
    await server.close();
  }
});

test("HTTP 404 exposes only a safe status hint", async () => {
  const server = await startMockServer((_request, response) => {
    sendJson(response, 404, { message: `missing resource for ${token}` });
  });

  try {
    const client = await getClient(server.baseUrl);
    let failure: unknown;
    try {
      await Effect.runPromise(client.projection("missing-thread"));
    } catch (error) {
      failure = error;
    }
    assert.ok(failure instanceof T3TransportError);
    assert.equal(failure.httpStatus, 404);
    assert.equal(failure.message.includes(token), false);
    assert.equal(failure.message.includes("missing resource"), false);
  } finally {
    await server.close();
  }
});

test("HTTP requests time out and abort their underlying fetch", async () => {
  const aborted = deferred<void>();
  const server = await startMockServer((request, response) => {
    request.on("close", () => aborted.resolve());
    setTimeout(() => {
      if (!response.destroyed) sendJson(response, 200, {
        environmentId: "environment-1",
        orchestrationProtocolVersion: 2,
        serverVersion: "nightly-test"
      });
    }, 150);
  });

  try {
    const client = await getClient(server.baseUrl, { httpTimeoutMs: 25 });
    let failure: unknown;
    try {
      await Effect.runPromise(client.descriptor());
    } catch (error) {
      failure = error;
    }
    assert.ok(failure instanceof T3TransportError);
    assert.match(failure.message, /timed out/);
    await within(aborted.promise);
  } finally {
    await server.close();
  }
});

test("watch handles RPC envelopes and waits for durable ingestion before acknowledging chunks", async () => {
  const subscriptions: JsonRecord[] = [];
  const acknowledgements: string[] = [];
  const requestsSeen = deferred<void>();
  const acknowledgementsSeen = deferred<void>();
  const pongSeen = deferred<void>();
  const callbackStarted = deferred<void>();
  const remoteClosed = deferred<void>();
  const items: SourceItem[] = [];
  let releaseIngest: (() => void) | undefined;

  const server = await startMockServer((_request, response) => {
    sendJson(response, 404, {});
  });
  server.webSockets.on("connection", (socket, request) => {
    assert.equal(request.url, "/ws?orchestrationProtocol=2");
    assert.equal(request.headers.authorization, `Bearer ${token}`);
    socket.once("close", () => remoteClosed.resolve());
    socket.on("message", (data) => {
      const frame: unknown = JSON.parse(data.toString());
      if (!isRecord(frame)) return;
      if (frame._tag === "Request") {
        subscriptions.push(frame);
        if (subscriptions.length === 2) {
          requestsSeen.resolve();
          const activeSnapshot = {
            kind: "snapshot",
            snapshot: { schemaVersion: 2, snapshotSequence: 11, projects: [], threads: [], archivedThreads: [] },
            resolvedRepositoryIdentityRoots: ["/workspace/repo"]
          };
          const activeUpdate = { kind: "thread.updated", sequence: 12, thread: { id: "thread-1" } };
          const archiveSnapshot = { kind: "snapshot", snapshot: { schemaVersion: 2, snapshotSequence: 4, projects: [], threads: [] } };
          socket.send(JSON.stringify([
            { _tag: "Ping" },
            { _tag: "Chunk", requestId: "1", values: [activeSnapshot, activeUpdate] },
            { _tag: "Chunk", requestId: "2", values: [archiveSnapshot] }
          ]));
        }
        return;
      }
      if (frame._tag === "Pong") pongSeen.resolve();
      if (frame._tag === "Ack" && typeof frame.requestId === "string") {
        acknowledgements.push(frame.requestId);
        if (acknowledgements.length === 2) acknowledgementsSeen.resolve();
      }
    });
  });

  try {
    const client = await getClient(server.baseUrl);
    const watch = client.watch(7, (item) => Effect.callback<void>((resume) => {
      items.push(item);
      if (item.stream === "active" && item.item.kind === "snapshot") {
        callbackStarted.resolve();
        releaseIngest = () => resume(Effect.void);
        return;
      }
      resume(Effect.void);
    }));
    const fiber = Effect.runFork(watch);
    await within(requestsSeen.promise);
    await within(pongSeen.promise);
    await within(callbackStarted.promise);
    assert.deepEqual(acknowledgements, []);
    assert.equal(items.length, 1);
    assert.deepEqual(subscriptions, [
      {
        _tag: "Request",
        id: "1",
        tag: "orchestration.subscribeShell",
        payload: { afterSequence: 7, requestCompletionMarker: true },
        headers: []
      },
      {
        _tag: "Request",
        id: "2",
        tag: "orchestration.subscribeArchivedShell",
        payload: {},
        headers: []
      }
    ]);

    releaseIngest?.();
    await within(acknowledgementsSeen.promise);
    assert.deepEqual(acknowledgements, ["1", "2"]);
    assert.deepEqual(items.map((item) => item.stream), ["active", "active", "archive"]);
    assert.deepEqual(items[0]?.item.resolvedRepositoryIdentityRoots, ["/workspace/repo"]);

    await Effect.runPromise(Fiber.interrupt(fiber));
    await within(remoteClosed.promise);
  } finally {
    await server.close();
  }
});

test("watch bounds a websocket peer that completes the handshake but never answers native Ping", async () => {
  const pingSeen = deferred<void>();
  const remoteClosed = deferred<void>();
  const server = await startMockServer((_request, response) => sendJson(response, 404, {}));
  server.webSockets.on("connection", (socket) => {
    socket.once("close", () => remoteClosed.resolve());
    socket.on("message", (data) => {
      const frame: unknown = JSON.parse(data.toString());
      if (isRecord(frame) && frame._tag === "Ping") pingSeen.resolve();
    });
  });

  try {
    const client = await getClient(server.baseUrl, {
      webSocketHandshakeTimeoutMs: 100,
      heartbeatIntervalMs: 10,
      heartbeatTimeoutMs: 25
    });
    let failure: unknown;
    try {
      await Effect.runPromise(client.watch(undefined, () => Effect.void));
    } catch (error) {
      failure = error;
    }
    await within(pingSeen.promise);
    assert.ok(failure instanceof T3TransportError);
    assert.match(failure.message, /heartbeat timed out/);
    await within(remoteClosed.promise);
  } finally {
    await server.close();
  }
});

test("watch keeps a quiet websocket alive when the peer answers native Ping", async () => {
  let pingCount = 0;
  const twoPingsAnswered = deferred<void>();
  const remoteClosed = deferred<void>();
  const server = await startMockServer((_request, response) => sendJson(response, 404, {}));
  server.webSockets.on("connection", (socket) => {
    socket.once("close", () => remoteClosed.resolve());
    socket.on("message", (data) => {
      const frame: unknown = JSON.parse(data.toString());
      if (!isRecord(frame) || frame._tag !== "Ping") return;
      pingCount += 1;
      socket.send(JSON.stringify({ _tag: "Pong" }));
      if (pingCount === 2) twoPingsAnswered.resolve();
    });
  });

  try {
    const client = await getClient(server.baseUrl, {
      webSocketHandshakeTimeoutMs: 100,
      heartbeatIntervalMs: 10,
      heartbeatTimeoutMs: 40
    });
    const fiber = Effect.runFork(client.watch(undefined, () => Effect.void));
    await within(twoPingsAnswered.promise);
    await Effect.runPromise(Fiber.interrupt(fiber));
    await within(remoteClosed.promise);
  } finally {
    await server.close();
  }
});

test("watch bounds a websocket handshake that never completes", async () => {
  const server = await startHungHandshakeServer();

  try {
    const client = await getClient(server.baseUrl, { webSocketHandshakeTimeoutMs: 100 });
    let failure: unknown;
    try {
      await Effect.runPromise(client.watch(undefined, () => Effect.void));
    } catch (error) {
      failure = error;
    }
    assert.ok(failure instanceof T3TransportError);
    assert.match(failure.message, /handshake timed out/);
    await within(server.accepted);
  } finally {
    await server.close();
  }
});

test("watch fails closed on subscription Exit and Defect frames so the caller can reconnect", async () => {
  for (const terminal of [
    { _tag: "Exit", requestId: "1", exit: { _tag: "Success", value: null } },
    { _tag: "Defect", requestId: "2", defect: { message: "private server detail" } }
  ]) {
    const sent = deferred<void>();
    const server = await startMockServer((_request, response) => sendJson(response, 404, {}));
    server.webSockets.on("connection", (socket) => {
      socket.once("message", () => {
        socket.send(JSON.stringify(terminal));
        sent.resolve();
      });
    });

    try {
      const client = await getClient(server.baseUrl);
      let failure: unknown;
      try {
        await Effect.runPromise(client.watch(undefined, () => Effect.void));
      } catch (error) {
        failure = error;
      }
      await within(sent.promise);
      assert.ok(failure instanceof T3TransportError);
      assert.equal(failure.message.includes("private server detail"), false);
    } finally {
      await server.close();
    }
  }
});

test("watch rejects shell snapshots with an unsupported schema version", async () => {
  const sent = deferred<void>();
  const acknowledgements: string[] = [];
  const server = await startMockServer((_request, response) => sendJson(response, 404, {}));
  server.webSockets.on("connection", (socket) => {
    socket.on("message", (data) => {
      const frame: unknown = JSON.parse(data.toString());
      if (!isRecord(frame)) return;
      if (frame._tag === "Request" && frame.id === "1") {
        socket.send(JSON.stringify({
          _tag: "Chunk",
          requestId: "1",
          values: [{
            kind: "snapshot",
            snapshot: { schemaVersion: 3, snapshotSequence: 2, projects: [], threads: [], archivedThreads: [] }
          }]
        }));
        sent.resolve();
      } else if (frame._tag === "Ack" && typeof frame.requestId === "string") {
        acknowledgements.push(frame.requestId);
      }
    });
  });

  try {
    const client = await getClient(server.baseUrl);
    let failure: unknown;
    try {
      await Effect.runPromise(client.watch(undefined, () => Effect.void));
    } catch (error) {
      failure = error;
    }
    await within(sent.promise);
    assert.ok(failure instanceof T3TransportError);
    assert.deepEqual(acknowledgements, []);
  } finally {
    await server.close();
  }
});

test("watch propagates ingestion failures without acknowledging their chunk", async () => {
  const sent = deferred<void>();
  const acknowledgements: string[] = [];
  const server = await startMockServer((_request, response) => sendJson(response, 404, {}));
  server.webSockets.on("connection", (socket) => {
    socket.on("message", (data) => {
      const frame: unknown = JSON.parse(data.toString());
      if (!isRecord(frame)) return;
      if (frame._tag === "Request" && frame.id === "1") {
        socket.send(JSON.stringify({
          _tag: "Chunk",
          requestId: "1",
          values: [{ kind: "thread.removed", sequence: 2, threadId: "thread-1" }]
        }));
        sent.resolve();
      } else if (frame._tag === "Ack" && typeof frame.requestId === "string") {
        acknowledgements.push(frame.requestId);
      }
    });
  });

  try {
    const client = await getClient(server.baseUrl);
    await assert.rejects(
      Effect.runPromise(client.watch(undefined, () => Effect.fail(new Error("durable store unavailable")))),
      /durable store unavailable/
    );
    await within(sent.promise);
    assert.deepEqual(acknowledgements, []);
  } finally {
    await server.close();
  }
});
