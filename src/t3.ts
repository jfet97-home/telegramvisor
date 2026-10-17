import { Context, Effect, Layer } from "effect";
import WebSocket from "ws";
import type { JsonRecord, Projection, SourceItem, ThreadInfo } from "./types.js";

const ORCHESTRATION_PROTOCOL = 2;
const MAX_HTTP_RESPONSE_BYTES = 32 * 1024 * 1024;
const MAX_WEBSOCKET_FRAME_BYTES = 32 * 1024 * 1024;
const MAX_BUFFERED_WEBSOCKET_BYTES = 32 * 1024 * 1024;
const MAX_BUFFERED_WEBSOCKET_FRAMES = 8;
const DEFAULT_HTTP_TIMEOUT_MS = 20_000;
const DEFAULT_WEBSOCKET_HANDSHAKE_TIMEOUT_MS = 10_000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000;
const DEFAULT_HEARTBEAT_TIMEOUT_MS = 40_000;

export interface T3EnvironmentDescriptor extends JsonRecord {
  environmentId: string;
  orchestrationProtocolVersion: 2;
  serverVersion: string;
}

export interface T3ProjectionSnapshot extends JsonRecord {
  snapshotSequence: number;
  projection: Projection;
}

export interface T3BoundedCompletionProjection extends Projection {
  nodes: JsonRecord[];
  runtimeRequests: JsonRecord[];
  turnItems: JsonRecord[];
  subagents: JsonRecord[];
  providerThreads: NonNullable<Projection["providerThreads"]>;
}

export interface T3BoundedCompletionSnapshot extends JsonRecord {
  snapshotSequence: number;
  schemaVersion?: 2;
  projection: T3BoundedCompletionProjection;
  historyCursor: string | null;
  hasMoreHistory: boolean;
  latestLocalTurnOrdinal: number | null;
  payloadBudgetExceeded: boolean;
}

export interface T3ThreadShell extends ThreadInfo {
  lineage: ThreadInfo["lineage"] & {rootThreadId: string};
}

export type T3TransportErrorCode = "response_too_large";

export class T3TransportError extends Error {
  readonly _tag = "T3TransportError";
  readonly httpStatus?: number;
  readonly code?: T3TransportErrorCode;

  constructor(message: string, httpStatus?: number, code?: T3TransportErrorCode) {
    super(message);
    this.name = "T3TransportError";
    if (httpStatus !== undefined) this.httpStatus = httpStatus;
    if (code !== undefined) this.code = code;
  }
}

export interface T3ClientShape {
  descriptor(): Effect.Effect<T3EnvironmentDescriptor, T3TransportError>;
  threadShells?(): Effect.Effect<T3ThreadShell[], T3TransportError>;
  projection(threadId: string): Effect.Effect<T3ProjectionSnapshot, T3TransportError>;
  boundedCompletionProjection?(threadId: string): Effect.Effect<T3BoundedCompletionSnapshot, T3TransportError>;
  watch<E = never, R = never>(
    cursor: number | undefined,
    onItem: (item: SourceItem) => Effect.Effect<void, E, R>
  ): Effect.Effect<never, T3TransportError | E, R>;
}

export class T3Client extends Context.Service<T3Client, T3ClientShape>()("T3Client") {}

export interface T3ClientOptions {
  baseUrl: string;
  token: string;
  httpTimeoutMs?: number;
  maxResponseBytes?: number;
  webSocketHandshakeTimeoutMs?: number;
  heartbeatIntervalMs?: number;
  heartbeatTimeoutMs?: number;
}

interface WebSocketFrame {
  data: WebSocket.RawData;
  isBinary: boolean;
  bytes: number;
}

type ResumeFrame = (effect: Effect.Effect<WebSocketFrame, T3TransportError>) => void;

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isRecordArray = (value: unknown): value is JsonRecord[] =>
  Array.isArray(value) && value.every(isRecord);

const isString = (value: unknown): value is string => typeof value === "string";

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

const isSequence = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

const isNativeIdentifier = (value: unknown): value is string =>
  isNonEmptyString(value) && value.length <= 512 && !/[\u0000-\u001f\u007f]/u.test(value);

const isStringOrNull = (value: unknown): value is string | null =>
  value === null || isString(value);

const isRun = (value: unknown): boolean => {
  if (!isRecord(value)) return false;
  return isString(value.id) &&
    Number.isSafeInteger(value.ordinal) &&
    isString(value.status) &&
    isString(value.requestedAt) &&
    isStringOrNull(value.startedAt) &&
    isStringOrNull(value.completedAt) &&
    isStringOrNull(value.rootNodeId);
};

const isMessage = (value: unknown): boolean => {
  if (!isRecord(value)) return false;
  return isString(value.id) &&
    isStringOrNull(value.runId) &&
    isStringOrNull(value.nodeId) &&
    isString(value.role) &&
    isString(value.text) &&
    typeof value.streaming === "boolean" &&
    isString(value.createdAt) &&
    isString(value.updatedAt);
};

const isProjection = (value: unknown, threadId?: string): value is Projection => {
  if (!isRecord(value) || !isRecord(value.thread)) return false;
  const thread = value.thread;
  if (!isNonEmptyString(thread.id) || (threadId !== undefined && thread.id !== threadId)) return false;
  if (!isString(thread.title) || !(thread.projectId === null || isString(thread.projectId))) return false;
  if (!isRecord(thread.lineage) ||
    !isStringOrNull(thread.lineage.parentThreadId) ||
    !isStringOrNull(thread.lineage.relationshipToParent)) return false;
  if (!Array.isArray(value.runs) || !value.runs.every(isRun)) return false;
  if (!Array.isArray(value.messages) || !value.messages.every(isMessage)) return false;
  if (value.subagents !== undefined && (!Array.isArray(value.subagents) || !value.subagents.every(isRecord))) return false;
  if (value.turnItems !== undefined && (!Array.isArray(value.turnItems) || !value.turnItems.every(isRecord))) return false;
  if (value.schemaVersion !== undefined && value.schemaVersion !== ORCHESTRATION_PROTOCOL) return false;
  return true;
};

const validateSnapshotItem = (value: unknown, stream: SourceItem["stream"]): JsonRecord | undefined => {
  if (!isRecord(value) || !isString(value.kind)) return undefined;
  if (value.kind === "synchronized") return stream === "active" ? value : undefined;
  if (value.kind === "snapshot") {
    if (!isRecord(value.snapshot) ||
      value.snapshot.schemaVersion !== ORCHESTRATION_PROTOCOL ||
      !isSequence(value.snapshot.snapshotSequence) ||
      !Array.isArray(value.snapshot.projects) ||
      !Array.isArray(value.snapshot.threads)) return undefined;
    if (stream === "active" && !Array.isArray(value.snapshot.archivedThreads)) return undefined;
    if (stream === "active" && value.resolvedRepositoryIdentityRoots !== undefined &&
      (!Array.isArray(value.resolvedRepositoryIdentityRoots) ||
        !value.resolvedRepositoryIdentityRoots.every(isString))) return undefined;
    return value;
  }
  if (value.kind === "thread.updated") {
    if (!isSequence(value.sequence) || !isRecord(value.thread) || !isNonEmptyString(value.thread.id)) return undefined;
    if (value.location !== undefined && value.location !== "active" && value.location !== "archive") return undefined;
    return value;
  }
  if (value.kind === "thread.removed") {
    if (!isSequence(value.sequence) || !isNonEmptyString(value.threadId)) return undefined;
    if (value.location !== undefined && value.location !== "active" && value.location !== "archive") return undefined;
    return value;
  }
  if (stream === "active" && value.kind === "project.updated") {
    return isSequence(value.sequence) && isRecord(value.project) && isNonEmptyString(value.project.id)
      ? value
      : undefined;
  }
  if (stream === "active" && value.kind === "project.removed") {
    return isSequence(value.sequence) && isNonEmptyString(value.projectId) ? value : undefined;
  }
  return undefined;
};

const flattenEnvelopes = (input: unknown): JsonRecord[] | undefined => {
  const result: JsonRecord[] = [];
  const pending: unknown[] = [input];
  let visited = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    visited += 1;
    if (visited > MAX_BUFFERED_WEBSOCKET_FRAMES * 1024) return undefined;
    if (Array.isArray(current)) {
      for (let index = current.length - 1; index >= 0; index -= 1) pending.push(current[index]);
      continue;
    }
    if (!isRecord(current)) return undefined;
    result.push(current);
  }
  return result.length === 0 ? undefined : result;
};

const rawDataBytes = (data: WebSocket.RawData): number => {
  if (Array.isArray(data)) return data.reduce((total, part) => total + part.byteLength, 0);
  if (data instanceof ArrayBuffer) return data.byteLength;
  return data.byteLength;
};

const rawDataToText = (data: WebSocket.RawData): string => {
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  return data.toString("utf8");
};

const decodeEnvelopes = (data: WebSocket.RawData): JsonRecord[] | undefined => {
  try {
    return flattenEnvelopes(JSON.parse(rawDataToText(data)) as unknown);
  } catch {
    return undefined;
  }
};

const makeWebSocketUrl = (baseUrl: URL): URL => {
  const url = new URL("/ws?orchestrationProtocol=2", baseUrl);
  url.protocol = baseUrl.protocol === "https:" ? "wss:" : "ws:";
  return url;
};

const makeHttpUrl = (baseUrl: URL, path: string): URL => new URL(path, baseUrl);

const readResponseBody = async (
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
  operation: string
): Promise<unknown> => {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null && Number(contentLength) > maxBytes) {
    void response.body?.cancel().catch(() => undefined);
    throw new T3TransportError(
      `T3 ${operation} response exceeded the byte limit`,
      undefined,
      "response_too_large"
    );
  }
  if (response.body === null) throw new T3TransportError(`T3 ${operation} response was empty`);

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      if (signal.aborted) throw new T3TransportError(`T3 ${operation} request was interrupted`);
      const result = await reader.read();
      if (result.done) break;
      totalBytes += result.value.byteLength;
      if (totalBytes > maxBytes) {
        void reader.cancel().catch(() => undefined);
        throw new T3TransportError(
          `T3 ${operation} response exceeded the byte limit`,
          undefined,
          "response_too_large"
        );
      }
      chunks.push(result.value);
    }
  } catch (error) {
    if (error instanceof T3TransportError) throw error;
    throw new T3TransportError(`T3 ${operation} response could not be read`);
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    throw new T3TransportError(`T3 ${operation} response was not valid JSON`);
  }
};

const makeFrameMailbox = (socket: WebSocket) => {
  let frames: WebSocketFrame[] = [];
  let bufferedBytes = 0;
  let bufferedCount = 0;
  let waiter: ResumeFrame | undefined;
  let failure: T3TransportError | undefined;

  const fail = (error: T3TransportError) => {
    if (failure !== undefined) return;
    failure = error;
    const pending = waiter;
    waiter = undefined;
    pending?.(Effect.fail(error));
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) socket.terminate();
  };

  const onMessage = (data: WebSocket.RawData, isBinary: boolean) => {
    socket.pause();
    const bytes = rawDataBytes(data);
    if (bytes > MAX_WEBSOCKET_FRAME_BYTES ||
      bufferedCount >= MAX_BUFFERED_WEBSOCKET_FRAMES ||
      bufferedBytes + bytes > MAX_BUFFERED_WEBSOCKET_BYTES) {
      fail(new T3TransportError("T3 websocket message exceeded the byte limit"));
      return;
    }
    const frame = { data, isBinary, bytes };
    bufferedBytes += bytes;
    bufferedCount += 1;
    const pending = waiter;
    if (pending !== undefined) {
      waiter = undefined;
      pending(Effect.succeed(frame));
    } else {
      frames.push(frame);
    }
  };

  const onClose = () => fail(new T3TransportError("T3 websocket closed"));
  const onError = () => fail(new T3TransportError("T3 websocket failed"));

  socket.on("message", onMessage);
  socket.on("close", onClose);
  socket.on("error", onError);

  return {
    take: (): Effect.Effect<WebSocketFrame, T3TransportError> =>
      Effect.callback<WebSocketFrame, T3TransportError>((resume) => {
        if (failure !== undefined) {
          resume(Effect.fail(failure));
          return;
        }
        const frame = frames.shift();
        if (frame !== undefined) {
          resume(Effect.succeed(frame));
          return;
        }
        waiter = resume;
        return Effect.sync(() => {
          if (waiter === resume) waiter = undefined;
        });
      }),
    release: (frame: WebSocketFrame) => {
      bufferedBytes = Math.max(0, bufferedBytes - frame.bytes);
      bufferedCount = Math.max(0, bufferedCount - 1);
    },
    fail,
    resume: () => socket.resume(),
    close: () => {
      socket.off("message", onMessage);
      socket.off("close", onClose);
      socket.off("error", onError);
      frames = [];
      waiter = undefined;
      bufferedBytes = 0;
      bufferedCount = 0;
    }
  };
};

const makeNativeHeartbeat = (
  socket: WebSocket,
  mailbox: ReturnType<typeof makeFrameMailbox>,
  intervalMs: number,
  timeoutMs: number
) => {
  let pendingPong = false;
  let disposed = false;
  let failed = false;
  let intervalId: ReturnType<typeof setInterval> | undefined;
  let deadlineId: ReturnType<typeof setTimeout> | undefined;
  let failureResume: ((effect: Effect.Effect<never, T3TransportError>) => void) | undefined;

  const clearDeadline = () => {
    if (deadlineId !== undefined) clearTimeout(deadlineId);
    deadlineId = undefined;
  };

  const fail = (error: T3TransportError) => {
    if (disposed || failed) return;
    failed = true;
    clearDeadline();
    if (intervalId !== undefined) clearInterval(intervalId);
    mailbox.fail(error);
    failureResume?.(Effect.fail(error));
  };

  const effect = Effect.callback<never, T3TransportError>((resume) => {
    failureResume = resume;
    intervalId = setInterval(() => {
      if (disposed || failed || pendingPong) return;
      if (socket.readyState !== WebSocket.OPEN) {
        fail(new T3TransportError("T3 websocket heartbeat found a closed connection"));
        return;
      }
      pendingPong = true;
      deadlineId = setTimeout(() => {
        fail(new T3TransportError("T3 websocket heartbeat timed out"));
      }, timeoutMs);
      try {
        socket.send(JSON.stringify({ _tag: "Ping" }), (error) => {
          if (error) fail(new T3TransportError("T3 websocket heartbeat send failed"));
        });
      } catch {
        fail(new T3TransportError("T3 websocket heartbeat send failed"));
      }
    }, intervalMs);

    return Effect.sync(() => {
      disposed = true;
      if (intervalId !== undefined) clearInterval(intervalId);
      clearDeadline();
      failureResume = undefined;
    });
  });

  return {
    effect,
    onPong: () => {
      if (!pendingPong || failed || disposed) return;
      pendingPong = false;
      clearDeadline();
    }
  };
};

const acquireSocket = (
  url: URL,
  token: string,
  handshakeTimeoutMs: number
): Effect.Effect<WebSocket, T3TransportError> =>
  Effect.tryPromise({
    try: (signal) => new Promise<WebSocket>((resolve, reject) => {
      let socket: WebSocket;
      try {
        socket = new WebSocket(url, {
          headers: { Authorization: `Bearer ${token}` },
          maxPayload: MAX_WEBSOCKET_FRAME_BYTES
        });
      } catch {
        reject(new T3TransportError("T3 websocket connection failed"));
        return;
      }

      const cleanup = () => {
        clearTimeout(timeoutId);
        socket.off("open", onOpen);
        socket.off("error", onError);
        socket.off("close", onClose);
        signal.removeEventListener("abort", onAbort);
      };
      const onOpen = () => {
        cleanup();
        resolve(socket);
      };
      const onError = () => {
        cleanup();
        terminateQuietly();
        reject(new T3TransportError("T3 websocket connection failed"));
      };
      const onClose = () => {
        cleanup();
        reject(new T3TransportError("T3 websocket connection closed before opening"));
      };
      const terminateQuietly = () => {
        const absorbError = () => undefined;
        socket.once("error", absorbError);
        socket.once("close", () => socket.off("error", absorbError));
        try {
          socket.terminate();
        } catch {
          socket.off("error", absorbError);
        }
      };
      const onAbort = () => {
        cleanup();
        terminateQuietly();
        reject(new T3TransportError("T3 websocket connection interrupted"));
      };
      const timeoutId = setTimeout(() => {
        cleanup();
        terminateQuietly();
        reject(new T3TransportError("T3 websocket handshake timed out"));
      }, handshakeTimeoutMs);
      socket.once("open", onOpen);
      socket.once("error", onError);
      socket.once("close", onClose);
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    }),
    catch: (cause) => cause instanceof T3TransportError
      ? cause
      : new T3TransportError("T3 websocket connection failed")
  });

const sendWebSocketFrame = (socket: WebSocket, frame: JsonRecord): Effect.Effect<void, T3TransportError> =>
  Effect.tryPromise({
    try: () => new Promise<void>((resolve, reject) => {
      if (socket.readyState !== WebSocket.OPEN) {
        reject(new T3TransportError("T3 websocket is not open"));
        return;
      }
      socket.send(JSON.stringify(frame), (error) => {
        if (error) reject(new T3TransportError("T3 websocket send failed"));
        else resolve();
      });
    }),
    catch: (cause) => cause instanceof T3TransportError ? cause : new T3TransportError("T3 websocket send failed")
  });

const makeDescriptor = (value: unknown): T3EnvironmentDescriptor | undefined => {
  if (!isRecord(value) ||
    !isNonEmptyString(value.environmentId) ||
    !isNonEmptyString(value.serverVersion) ||
    value.orchestrationProtocolVersion !== ORCHESTRATION_PROTOCOL) return undefined;
  return value as T3EnvironmentDescriptor;
};

const makeThreadShells = (value: unknown): T3ThreadShell[] | undefined => {
  if (!isRecord(value) || value.schemaVersion !== ORCHESTRATION_PROTOCOL || !isSequence(value.snapshotSequence) ||
    !Array.isArray(value.threads)) return undefined;
  const threads = value.threads;
  if (!threads.every(thread => isRecord(thread) && isNativeIdentifier(thread.id) &&
    typeof thread.title === "string" && thread.title.length <= 16_384 &&
    (thread.projectId === null || isNativeIdentifier(thread.projectId)) && isRecord(thread.lineage) &&
    (thread.lineage.parentThreadId === null || isNativeIdentifier(thread.lineage.parentThreadId)) &&
    (thread.lineage.relationshipToParent === null || isNativeIdentifier(thread.lineage.relationshipToParent)) &&
    isNativeIdentifier(thread.lineage.rootThreadId))) return undefined;
  return threads as T3ThreadShell[];
};

const makeProjectionSnapshot = (value: unknown, threadId: string): T3ProjectionSnapshot | undefined => {
  if (!isRecord(value) ||
    !isSequence(value.snapshotSequence) ||
    (value.schemaVersion !== undefined && value.schemaVersion !== ORCHESTRATION_PROTOCOL) ||
    !isProjection(value.projection, threadId) ||
    value.hasMoreHistory === true ||
    (value.historyCursor !== undefined && value.historyCursor !== null)) return undefined;
  return value as T3ProjectionSnapshot;
};

const makeBoundedCompletionSnapshot = (
  value: unknown,
  threadId: string
): T3BoundedCompletionSnapshot | undefined => {
  if (!isRecord(value) ||
    !isSequence(value.snapshotSequence) ||
    (value.schemaVersion !== undefined && value.schemaVersion !== ORCHESTRATION_PROTOCOL) ||
    !isProjection(value.projection, threadId) ||
    typeof value.hasMoreHistory !== "boolean" ||
    !isStringOrNull(value.historyCursor) ||
    (value.hasMoreHistory ? !isNonEmptyString(value.historyCursor) : value.historyCursor !== null) ||
    !(value.latestLocalTurnOrdinal === null || isSequence(value.latestLocalTurnOrdinal)) ||
    typeof value.payloadBudgetExceeded !== "boolean" ||
    (value.turnItemsOmitLocalVisible !== undefined && value.turnItemsOmitLocalVisible !== false)) return undefined;

  const projection = value.projection as Projection;
  for (const field of ["nodes", "runtimeRequests", "turnItems", "subagents", "providerThreads"] as const) {
    if (!isRecordArray(projection[field])) return undefined;
  }

  const turnItems = projection.turnItems;
  if (!isRecordArray(turnItems)) return undefined;
  let latestIncludedOrdinal: number | null = null;
  for (const item of turnItems) {
    if (!isSequence(item.ordinal)) return undefined;
    latestIncludedOrdinal = latestIncludedOrdinal === null
      ? item.ordinal
      : Math.max(latestIncludedOrdinal, item.ordinal);
  }
  if (latestIncludedOrdinal !== null &&
    (value.latestLocalTurnOrdinal === null || value.latestLocalTurnOrdinal < latestIncludedOrdinal)) return undefined;

  return value as T3BoundedCompletionSnapshot;
};

const makeService = (options: T3ClientOptions): T3ClientShape => {
  const baseUrl = new URL(options.baseUrl);
  if (baseUrl.protocol !== "http:" && baseUrl.protocol !== "https:") {
    throw new T3TransportError("T3 base URL must use HTTP or HTTPS");
  }
  if (!isNonEmptyString(options.token)) throw new T3TransportError("T3 token must not be empty");
  const token = options.token.trim();
  const httpTimeoutMs = options.httpTimeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS;
  const maxResponseBytes = Math.min(options.maxResponseBytes ?? MAX_HTTP_RESPONSE_BYTES, MAX_HTTP_RESPONSE_BYTES);
  const webSocketHandshakeTimeoutMs = options.webSocketHandshakeTimeoutMs ?? DEFAULT_WEBSOCKET_HANDSHAKE_TIMEOUT_MS;
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
  const heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? DEFAULT_HEARTBEAT_TIMEOUT_MS;
  if (!Number.isSafeInteger(httpTimeoutMs) || httpTimeoutMs <= 0 || httpTimeoutMs > DEFAULT_HTTP_TIMEOUT_MS) {
    throw new T3TransportError("T3 HTTP timeout must be between 1 and 20000 milliseconds");
  }
  if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes <= 0) {
    throw new T3TransportError("T3 HTTP response limit must be positive");
  }
  if (!Number.isSafeInteger(webSocketHandshakeTimeoutMs) ||
    webSocketHandshakeTimeoutMs <= 0 ||
    webSocketHandshakeTimeoutMs > DEFAULT_WEBSOCKET_HANDSHAKE_TIMEOUT_MS) {
    throw new T3TransportError("T3 websocket handshake timeout must be between 1 and 10000 milliseconds");
  }
  if (!Number.isSafeInteger(heartbeatIntervalMs) || heartbeatIntervalMs <= 0 ||
    heartbeatIntervalMs > DEFAULT_HEARTBEAT_INTERVAL_MS) {
    throw new T3TransportError("T3 websocket heartbeat interval must be between 1 and 15000 milliseconds");
  }
  if (!Number.isSafeInteger(heartbeatTimeoutMs) || heartbeatTimeoutMs <= 0 ||
    heartbeatTimeoutMs > DEFAULT_HEARTBEAT_TIMEOUT_MS) {
    throw new T3TransportError("T3 websocket heartbeat timeout must be between 1 and 40000 milliseconds");
  }
  baseUrl.username = "";
  baseUrl.password = "";
  baseUrl.search = "";
  baseUrl.hash = "";

  const getJson = (path: string, operation: string, protocolHeader: boolean): Effect.Effect<unknown, T3TransportError> =>
    Effect.tryPromise({
      try: async (signal) => {
        let didTimeout = false;
        const timeoutController = new AbortController();
        const combinedSignal = AbortSignal.any([signal, timeoutController.signal]);
        const timeoutId = setTimeout(() => {
          didTimeout = true;
          timeoutController.abort();
        }, httpTimeoutMs);
        try {
          const headers: Record<string, string> = {
            Accept: "application/json",
            Authorization: `Bearer ${token}`
          };
          if (protocolHeader) headers["x-t3-orchestration-protocol"] = String(ORCHESTRATION_PROTOCOL);
          const response = await fetch(makeHttpUrl(baseUrl, path), { headers, signal: combinedSignal });
          if (!response.ok) {
            void response.body?.cancel().catch(() => undefined);
            throw new T3TransportError(`T3 ${operation} returned HTTP ${response.status}`, response.status);
          }
          return await readResponseBody(response, maxResponseBytes, combinedSignal, operation);
        } catch (cause) {
          if (cause instanceof T3TransportError) throw cause;
          throw new T3TransportError(didTimeout ? `T3 ${operation} request timed out` : `T3 ${operation} request failed`);
        } finally {
          clearTimeout(timeoutId);
        }
      },
      catch: (cause) => cause instanceof T3TransportError
        ? cause
        : new T3TransportError(`T3 ${operation} request failed`)
    });

  return {
    descriptor: () => getJson("/.well-known/t3/environment", "environment descriptor", false).pipe(
      Effect.flatMap((value) => {
        const descriptor = makeDescriptor(value);
        return descriptor === undefined
          ? Effect.fail(new T3TransportError("T3 environment descriptor has an unsupported protocol or shape"))
          : Effect.succeed(descriptor);
      })
    ),
    threadShells: () => getJson("/api/orchestration/shell", "thread shell snapshot", true).pipe(
      Effect.flatMap(value => {
        const threads = makeThreadShells(value);
        return threads === undefined
          ? Effect.fail(new T3TransportError("T3 thread shell snapshot has an unsupported schema or shape"))
          : Effect.succeed(threads);
      })
    ),
    projection: (threadId) => {
      if (!isNonEmptyString(threadId)) return Effect.fail(new T3TransportError("T3 thread id must not be empty"));
      const path = `/api/orchestration/threads/${encodeURIComponent(threadId)}`;
      return getJson(path, "thread projection", true).pipe(
        Effect.flatMap((value) => {
          const snapshot = makeProjectionSnapshot(value, threadId);
          return snapshot === undefined
            ? Effect.fail(new T3TransportError("T3 thread projection has an unsupported schema or shape"))
            : Effect.succeed(snapshot);
        })
      );
    },
    boundedCompletionProjection: (threadId) => {
      if (!isNonEmptyString(threadId)) return Effect.fail(new T3TransportError("T3 thread id must not be empty"));
      const path = `/api/orchestration/threads/${encodeURIComponent(threadId)}/bounded`;
      return getJson(path, "bounded completion projection", true).pipe(
        Effect.flatMap((value) => {
          const snapshot = makeBoundedCompletionSnapshot(value, threadId);
          return snapshot === undefined
            ? Effect.fail(new T3TransportError("T3 bounded completion projection has an unsupported schema or shape"))
            : Effect.succeed(snapshot);
        })
      );
    },
    watch<E = never, R = never>(
      cursor: number | undefined,
      onItem: (item: SourceItem) => Effect.Effect<void, E, R>
    ): Effect.Effect<never, T3TransportError | E, R> {
      if (cursor !== undefined && !isSequence(cursor)) {
        return Effect.fail(new T3TransportError("T3 orchestration cursor must be a non-negative integer"));
      }
      const url = makeWebSocketUrl(baseUrl);
      return Effect.scoped(Effect.gen(function*() {
        const socket = yield* acquireSocket(url, token, webSocketHandshakeTimeoutMs);
        yield* Effect.acquireRelease(
          Effect.succeed(socket),
          (openedSocket) => Effect.sync(() => openedSocket.terminate())
        );
        const mailbox = makeFrameMailbox(socket);
        const heartbeat = makeNativeHeartbeat(socket, mailbox, heartbeatIntervalMs, heartbeatTimeoutMs);
        yield* Effect.addFinalizer(() => Effect.sync(() => mailbox.close()));

        const activePayload: JsonRecord = {
          ...(cursor === undefined ? {} : { afterSequence: cursor }),
          requestCompletionMarker: true
        };
        yield* sendWebSocketFrame(socket, {
          _tag: "Request",
          id: "1",
          tag: "orchestration.subscribeShell",
          payload: activePayload,
          headers: []
        });
        yield* sendWebSocketFrame(socket, {
          _tag: "Request",
          id: "2",
          tag: "orchestration.subscribeArchivedShell",
          payload: {},
          headers: []
        });

        const handleEnvelope = (envelope: JsonRecord): Effect.Effect<void, T3TransportError | E, R> => {
          if (envelope._tag === "Ping") return sendWebSocketFrame(socket, { _tag: "Pong" });
          if (envelope._tag === "Pong") return Effect.sync(() => heartbeat.onPong());
          if (envelope._tag === "Exit") return Effect.fail(new T3TransportError("T3 subscription ended"));
          if (envelope._tag === "Defect") return Effect.fail(new T3TransportError("T3 subscription failed"));
          const values = envelope.values;
          if (envelope._tag !== "Chunk" ||
            (envelope.requestId !== "1" && envelope.requestId !== "2") ||
            !Array.isArray(values)) {
            return Effect.fail(new T3TransportError("T3 websocket message used an unsupported protocol frame"));
          }

          const chunkValues: unknown[] = values;
          const stream: SourceItem["stream"] = envelope.requestId === "1" ? "active" : "archive";
          return Effect.gen(function*() {
            for (const value of chunkValues) {
              const item = validateSnapshotItem(value, stream);
              if (item === undefined) {
                return yield* Effect.fail(new T3TransportError("T3 subscription item has an unsupported schema or shape"));
              }
              yield* onItem({ stream, item });
            }
            yield* sendWebSocketFrame(socket, { _tag: "Ack", requestId: envelope.requestId as string });
          });
        };

        const handleFrame = (frame: WebSocketFrame): Effect.Effect<void, T3TransportError | E, R> =>
          Effect.acquireUseRelease(
            Effect.succeed(frame),
            (current) => {
              if (current.isBinary) return Effect.fail(new T3TransportError("T3 websocket sent a binary message"));
              return Effect.gen(function*() {
                const envelopes = yield* Effect.sync(() => decodeEnvelopes(current.data));
                if (envelopes === undefined) {
                  return yield* Effect.fail(new T3TransportError("T3 websocket message was not valid protocol JSON"));
                }
                yield* Effect.forEach(envelopes, handleEnvelope, { discard: true });
              });
            },
            (current) => Effect.sync(() => mailbox.release(current))
          );

        const processNextFrame = Effect.gen(function*() {
          const frame = yield* mailbox.take();
          yield* handleFrame(frame);
          yield* Effect.sync(() => mailbox.resume());
        });

        return yield* Effect.raceFirst(Effect.forever(processNextFrame), heartbeat.effect);
      }));
    }
  };
};

export const makeT3Client = (options: T3ClientOptions): Layer.Layer<T3Client> =>
  Layer.succeed(T3Client, makeService(options));
