import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Effect } from "effect";
import test from "node:test";
import { makeStore, Store, StoreError, type StoreShape } from "../src/store.js";
import type { ProjectInfo, RecapContext, SourceItem, ThreadInfo } from "../src/types.js";

const project = (id = "project-1", title = "Project one", workspaceRoot = "/work/project-one"): ProjectInfo => ({
  id,
  title,
  workspaceRoot,
});

const thread = (id = "thread-1", projectId: string | null = "project-1"): ThreadInfo => ({
  id,
  title: `Conversation ${id}`,
  projectId,
  lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: id },
  archivedAt: null,
});

const recapContext: RecapContext = {
  finalAnswer: "The completed work.",
  messages: [{ role: "user", text: "Please finish the task." }],
  thread: thread(),
  project: project(),
};

const sourceItem = (stream: SourceItem["stream"], item: Record<string, unknown>): SourceItem => ({ stream, item });

const withStore = <A>(
  directory: string,
  use: (store: StoreShape) => Effect.Effect<A, StoreError>,
): Promise<A> => Effect.runPromise(Effect.scoped(Effect.provide(Store.use(use), makeStore(directory))));

const withTemporaryDirectory = async <A>(run: (directory: string) => Promise<A>): Promise<A> => {
  const directory = mkdtempSync(join(tmpdir(), "telegramvisor-store-"));
  try {
    return await run(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
};

test("Telegram enablement survives reopen and excludes disabled-period completions without resetting source activation", async () => {
  await withTemporaryDirectory(async (directory) => {
    await withStore(directory, (store) => store.activate("environment-1", 1_000));
    assert.equal(await withStore(directory, (store) => store.configureTelegram("environment-1", true, 2_000)), 1_000);
    assert.equal(await withStore(directory, (store) => store.configureTelegram("environment-1", true, 3_000)), 1_000);
    assert.equal(await withStore(directory, (store) => store.configureTelegram("environment-1", false, 4_000)), 4_000);
    assert.equal(await withStore(directory, (store) => store.configureTelegram("environment-1", false, 5_000)), 5_000);
    assert.equal(await withStore(directory, (store) => store.configureTelegram("environment-1", true, 6_000)), 6_000);
    assert.equal(await withStore(directory, (store) => store.configureTelegram("environment-1", true, 7_000)), 6_000);
    assert.equal(await withStore(directory, (store) => store.activate("environment-1", 8_000)), 1_000);
    await assert.rejects(withStore(directory, (store) => store.configureTelegram("other-environment", true, 9_000)));
  });
});

test("pending recap context survives a long Telegram pause and receives a fresh retention window", async () => {
  await withTemporaryDirectory(async (directory) => {
    const day = 24 * 60 * 60 * 1_000;
    const id = await withStore(directory, (store) => Effect.gen(function* () {
      yield* store.activate("environment-1", 1_000);
      yield* store.configureTelegram("environment-1", true, 1_000);
      const id = yield* store.enqueue("environment-1", "thread-1", "run-1", recapContext, 2_000);
      yield* store.configureTelegram("environment-1", false, 3_000);
      return id;
    }));
    assert.ok(id);
    await withStore(directory, (store) => Effect.gen(function* () {
      assert.equal((yield* store.prune(30 * day, false)).contexts, 0);
      assert.deepEqual((yield* store.getJob(id))?.context, recapContext);
      yield* store.configureTelegram("environment-1", true, 30 * day);
      assert.equal((yield* store.prune(30 * day)).contexts, 0);
      assert.equal((yield* store.prune(36 * day)).contexts, 0);
      assert.deepEqual((yield* store.getJob(id))?.context, recapContext);
      assert.equal((yield* store.prune(38 * day)).contexts, 1);
      assert.equal((yield* store.getJob(id))?.context, null);
      assert.equal((yield* store.getJob(id))?.state, "pending");
      assert.equal(yield* store.hasIdentity("environment-1", "thread-1", "run-1"), true);
    }));
  });
});

test("activation, thread hints, and stream cursors survive reopen with private file modes", async () => {
  await withTemporaryDirectory(async (directory) => {
    const activatedAt = await withStore(directory, (store) => store.activate("environment-1", 1_000));
    assert.equal(activatedAt, 1_000);
    assert.equal(await withStore(directory, (store) => store.activate("environment-1", 2_000)), 1_000);
    await assert.rejects(
      withStore(directory, (store) => store.activate("environment-2", 3_000)),
      (error: unknown) => error instanceof StoreError && error._tag === "environment_mismatch",
    );
    assert.equal(await withStore(directory, (store) => store.activate("environment-1", 4_000)), 1_000);

    await withStore(directory, (store) => Effect.gen(function* () {
      yield* store.ingest(sourceItem("active", {
        kind: "project.updated",
        sequence: 3,
        project: project(),
      }));
      yield* store.ingest(sourceItem("active", {
        kind: "thread.updated",
        sequence: 4,
        location: "active",
        thread: thread(),
      }));
    }));

    const persisted = await withStore(directory, (store) => Effect.gen(function* () {
      return {
        cursor: yield* store.cursor("active"),
        hints: yield* store.dueHints(),
        foundProject: yield* store.project("thread-1"),
      };
    }));
    assert.equal(persisted.cursor, 4);
    assert.equal(persisted.hints.length, 1);
    assert.equal(persisted.hints[0]?.shell?.id, "thread-1");
    assert.equal(persisted.foundProject?.title, "Project one");

    const databasePath = join(directory, "telegramvisor.sqlite3");
    assert.equal(statSync(directory).mode & 0o777, 0o700);
    assert.equal(statSync(databasePath).mode & 0o777, 0o600);
  });
});

test("hint completion compares revisions so a concurrent event stays dirty", async () => {
  await withTemporaryDirectory(async (directory) => {
    const firstRevision = await withStore(directory, (store) => Effect.gen(function* () {
      yield* store.ingest(sourceItem("active", {
        kind: "thread.updated",
        sequence: 10,
        thread: thread(),
      }));
      return (yield* store.dueHints())[0]?.revision ?? 0;
    }));

    const result = await withStore(directory, (store) => Effect.gen(function* () {
      yield* store.ingest(sourceItem("active", {
        kind: "thread.updated",
        sequence: 11,
        thread: { ...thread(), title: "Updated title" },
      }));
      const staleCompletion = yield* store.doneHint("thread-1", firstRevision);
      const hints = yield* store.dueHints();
      const currentCompletion = yield* store.doneHint("thread-1", hints[0]?.revision ?? 0);
      return { staleCompletion, hints, currentCompletion };
    }));

    assert.equal(result.staleCompletion, false);
    assert.equal(result.hints.length, 1);
    assert.ok((result.hints[0]?.revision ?? 0) > firstRevision);
    assert.equal(result.hints[0]?.shell?.title, "Updated title");
    assert.equal(result.currentCompletion, true);
    assert.deepEqual(await withStore(directory, (store) => store.dueHints()), []);
  });
});

test("metadata enrichment updates projects without replacing thread inventory or moving the cursor backward", async () => {
  await withTemporaryDirectory(async (directory) => {
    const result = await withStore(directory, (store) => Effect.gen(function* () {
      yield* store.ingest(sourceItem("active", {
        kind: "snapshot",
        snapshot: {
          schemaVersion: 2,
          snapshotSequence: 10,
          projects: [project(), project("project-2", "Project two", "/work/project-two")],
          threads: [thread("thread-1")],
          archivedThreads: [],
        },
      }));
      const cursorBeforeEnrichment = yield* store.cursor("active");
      const hintsBeforeEnrichment = yield* store.dueHints();
      yield* store.ingest(sourceItem("active", {
        kind: "snapshot",
        resolvedRepositoryIdentityRoots: ["/work/project-one"],
        snapshot: {
          schemaVersion: 2,
          snapshotSequence: 100,
          projects: [project("project-1", "Enriched title", "/work/project-one")],
          threads: [],
          archivedThreads: [],
        },
      }));
      const cursorAfterEnrichment = yield* store.cursor("active");
      const hintsAfterEnrichment = yield* store.dueHints();
      yield* store.ingest(sourceItem("active", {
        kind: "thread.updated",
        sequence: 11,
        thread: { ...thread("thread-2"), title: "Replay at sequence eleven" },
      }));
      return {
        cursorBeforeEnrichment,
        cursorAfterEnrichment,
        hintsBeforeEnrichment,
        hintsAfterEnrichment,
      };
    }));

    const found = await withStore(directory, (store) => Effect.gen(function* () {
      return {
        cursor: yield* store.cursor("active"),
        first: yield* store.thread("thread-1"),
        second: yield* store.thread("thread-2"),
        foundProject: yield* store.project("thread-1"),
        stats: yield* store.stats(),
      };
    }));
    assert.equal(result.cursorBeforeEnrichment, 10);
    assert.equal(result.cursorAfterEnrichment, 10);
    assert.deepEqual(result.hintsAfterEnrichment.map(({ threadId, revision }) => ({ threadId, revision })),
      result.hintsBeforeEnrichment.map(({ threadId, revision }) => ({ threadId, revision })));
    assert.equal(found.cursor, 11);
    assert.equal(found.first?.id, "thread-1");
    assert.equal(found.second?.title, "Replay at sequence eleven");
    assert.equal(found.foundProject?.title, "Enriched title");
    assert.equal(found.stats.threads, 2);
  });
});

test("archive removal retains the known shell for later archived-thread lookup", async () => {
  await withTemporaryDirectory(async (directory) => {
    await withStore(directory, (store) => Effect.gen(function* () {
      yield* store.ingest(sourceItem("archive", {
        kind: "snapshot",
        snapshot: {
          schemaVersion: 2,
          snapshotSequence: 5,
          projects: [project()],
          threads: [{ ...thread("archived-1"), archivedAt: "2025-01-01T00:00:00.000Z" }],
        },
      }));
      yield* store.ingest(sourceItem("archive", {
        kind: "thread.removed",
        sequence: 6,
        threadId: "archived-1",
      }));
    }));

    const result = await withStore(directory, (store) => Effect.gen(function* () {
      return {
        cursor: yield* store.cursor("archive"),
        shell: yield* store.thread("archived-1"),
        projectInfo: yield* store.project("archived-1"),
        hint: (yield* store.dueHints()).find(({ threadId }) => threadId === "archived-1"),
      };
    }));
    assert.equal(result.cursor, 6);
    assert.equal(result.shell?.id, "archived-1");
    assert.equal(result.projectInfo?.title, "Project one");
    assert.equal(result.hint?.shell?.id, "archived-1");
  });
});

test("failed event ingestion leaves its cursor unacknowledged", async () => {
  await withTemporaryDirectory(async (directory) => {
    await assert.rejects(() => withStore(directory, (store) => store.ingest(sourceItem("active", {
      kind: "thread.updated",
      sequence: 1,
      thread: { id: "malformed", title: "Missing lineage" },
    }))));
    assert.equal(await withStore(directory, (store) => store.cursor("active")), 0);
    assert.deepEqual(await withStore(directory, (store) => store.dueHints()), []);
  });
});

test("deferred failing hints cannot starve fresh thread changes", async () => {
  await withTemporaryDirectory(async (directory) => {
    const result = await withStore(directory, (store) => Effect.gen(function* () {
      for (let index = 1; index <= 20; index += 1) {
        yield* store.ingest(sourceItem("active", {
          kind: "thread.updated",
          sequence: index,
          thread: thread(`invalid-${index}`),
        }));
      }
      const firstBatch = yield* store.dueHints(1_000, 20);
      for (const hint of firstBatch) yield* store.deferHint(hint.threadId, hint.revision, 1_000, 60_000);
      yield* store.ingest(sourceItem("active", {
        kind: "thread.updated",
        sequence: 21,
        thread: thread("new-thread"),
      }));
      return {
        firstBatch,
        dueAfterBackoff: yield* store.dueHints(61_001, 5),
        stats: yield* store.stats(),
      };
    }));

    assert.equal(result.firstBatch.length, 20);
    assert.equal(result.dueAfterBackoff[0]?.threadId, "new-thread");
    assert.equal(result.stats.deferredHints, 20);
    assert.equal(result.stats.waitingHints, 0);
  });
});

test("settling hints wait briefly without counting as failures or reducing readiness", async () => {
  await withTemporaryDirectory(async (directory) => {
    const result = await withStore(directory, (store) => Effect.gen(function* () {
      yield* store.ingest(sourceItem("active", {
        kind: "thread.updated",
        sequence: 1,
        thread: thread(),
      }));
      const hint = (yield* store.dueHints())[0];
      assert.ok(hint);
      const deferred = yield* store.deferHint(hint.threadId, hint.revision, 1_000, 5_000, "settling");
      const beforeDue = yield* store.dueHints(5_999, 10);
      const due = yield* store.dueHints(6_000, 10);
      const stats = yield* store.stats();
      return { deferred, beforeDue, due, stats };
    }));

    assert.equal(result.deferred, true);
    assert.deepEqual(result.beforeDue, []);
    assert.equal(result.due[0]?.threadId, "thread-1");
    assert.equal(result.stats.deferredHints, 0);
    assert.equal(result.stats.waitingHints, 1);
  });
});

test("legacy hint tables gain retry and defer-kind columns on open", async () => {
  await withTemporaryDirectory(async (directory) => {
    const database = new DatabaseSync(join(directory, "telegramvisor.sqlite3"));
    database.exec(`
      CREATE TABLE hints (
        thread_id TEXT PRIMARY KEY,
        revision INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);
    database.close();

    await withStore(directory, (store) => store.stats());
    const migrated = new DatabaseSync(join(directory, "telegramvisor.sqlite3"));
    try {
      const columns = migrated.prepare("PRAGMA table_info(hints)").all() as Array<Record<string, unknown>>;
      assert.ok(columns.some((column) => column.name === "next_attempt_at"));
      assert.ok(columns.some((column) => column.name === "defer_kind"));
    } finally {
      migrated.close();
    }
  });
});

test("stored thread shells drop conversation and goal text while retaining policy fields", async () => {
  await withTemporaryDirectory(async (directory) => {
    const privateValues = [
      "private latest visible message body",
      "private provider goal objective",
      "private last error details",
      "private background task description",
      "private runtime request text",
    ];
    const shell = {
      ...thread(),
      status: "running",
      latestVisibleMessage: { id: "message", role: "assistant", text: privateValues[0] },
      goal: { status: "active", objective: privateValues[1] },
      lastError: privateValues[2],
      pendingBackgroundTasks: [{ kind: "monitor", status: "running", description: privateValues[3] }],
      pendingRuntimeRequest: { id: "request", kind: "user_input", text: privateValues[4] },
    };
    const persisted = await withStore(directory, (store) => Effect.gen(function* () {
      yield* store.ingest(sourceItem("active", { kind: "thread.updated", sequence: 1, thread: shell }));
      return yield* store.thread("thread-1");
    }));

    assert.equal(persisted?.status, "running");
    assert.equal(persisted?.lineage.rootThreadId, "thread-1");
    assert.deepEqual(persisted?.pendingBackgroundTasks, [{ kind: "monitor", status: "running" }]);
    assert.deepEqual(persisted?.pendingRuntimeRequest, { id: "request", kind: "user_input" });
    const onDisk = readdirSync(directory).map((name) => readFileSync(join(directory, name)));
    for (const privateValue of privateValues) {
      assert.ok(!onDisk.some((content) => content.includes(Buffer.from(privateValue))));
      assert.ok(!JSON.stringify(persisted).includes(privateValue));
    }
  });
});

test("send transitions preserve the identity and make uncertain outcomes reconciliation-only", async () => {
  await withTemporaryDirectory(async (directory) => {
    const queuedId = await withStore(directory, (store) => store.enqueue(
      "environment-1",
      "thread-1",
      "run-1",
      recapContext,
      1_000,
    ));
    assert.ok(queuedId);

    const recovered = await withStore(directory, (store) => Effect.gen(function* () {
      const prepared = yield* store.setReady(queuedId, "A complete Telegram message", 1_100);
      const claimed = yield* store.claimSend(queuedId, 1_200);
      const interrupted = yield* store.recoverSending(1_300);
      const job = yield* store.getJob(queuedId);
      const normalDue = yield* store.dueJobs(1_300 + 120_000);
      const unknownBeforeBackoff = yield* store.dueJobs(1_300 + 30_000, ["unknown"]);
      const unknownDue = yield* store.dueJobs(1_300 + 120_000, ["unknown"]);
      const unsafeRetry = yield* store.retry(queuedId, "not found", 1_300);
      const unsafeReject = yield* store.rejectSend(queuedId, "not found", 1_300);
      const retainedUnknown = yield* store.prune(1_300 + 31 * 24 * 60 * 60 * 1_000);
      const unknownAfterRetention = yield* store.getJob(queuedId);
      const reconciled = yield* store.markSent(queuedId, 99, 1_500);
      return {
        prepared,
        claimed,
        interrupted,
        job,
        normalDue,
        unknownBeforeBackoff,
        unknownDue,
        unsafeRetry,
        unsafeReject,
        reconciled,
        retainedUnknown,
        unknownAfterRetention,
      };
    }));

    assert.equal(recovered.prepared, true);
    assert.equal(recovered.claimed, true);
    assert.equal(recovered.interrupted, 1);
    assert.equal(recovered.job?.state, "unknown");
    assert.equal(recovered.job?.text, "A complete Telegram message");
    assert.equal(recovered.job?.context, null);
    assert.deepEqual(recovered.normalDue, []);
    assert.deepEqual(recovered.unknownBeforeBackoff, []);
    assert.equal(recovered.unknownDue[0]?.id, queuedId);
    assert.equal(recovered.unsafeRetry, false);
    assert.equal(recovered.unsafeReject, false);
    assert.equal(recovered.reconciled, true);
    assert.equal(recovered.unknownAfterRetention?.state, "unknown");
    assert.equal(recovered.retainedUnknown.sentMetadata, 0);
  });
});

test("a confirmed non-executed send rejection returns the saved message to ready", async () => {
  await withTemporaryDirectory(async (directory) => {
    const queuedId = await withStore(directory, (store) => store.enqueue(
      "environment-1",
      "thread-1",
      "run-1",
      recapContext,
      10,
    ));
    assert.ok(queuedId);

    const result = await withStore(directory, (store) => Effect.gen(function* () {
      yield* store.setReady(queuedId, "Saved message", 20);
      yield* store.claimSend(queuedId, 30);
      const rejected = yield* store.rejectSend(queuedId, "rate limited", 40, 500);
      const beforeDue = yield* store.dueJobs(539);
      const afterDue = yield* store.dueJobs(540);
      return { rejected, beforeDue, afterDue };
    }));
    assert.equal(result.rejected, true);
    assert.deepEqual(result.beforeDue, []);
    assert.equal(result.afterDue[0]?.state, "ready");
    assert.equal(result.afterDue[0]?.text, "Saved message");
  });
});

test("identity tombstones outlive pruned sent metadata and prevent replay", async () => {
  await withTemporaryDirectory(async (directory) => {
    const firstId = await withStore(directory, (store) => store.enqueue(
      "environment-1",
      "thread-1",
      "run-1",
      recapContext,
      1_000,
    ));
    assert.ok(firstId);

    const pruned = await withStore(directory, (store) => Effect.gen(function* () {
      yield* store.setReady(firstId, "Sent message", 1_100);
      yield* store.claimSend(firstId, 1_200);
      yield* store.markSent(firstId, 42, 1_300);
      const identityBeforePrune = yield* store.hasIdentity("environment-1", "thread-1", "run-1");
      const result = yield* store.prune(1_300 + 31 * 24 * 60 * 60 * 1_000);
      const removed = yield* store.getJob(firstId);
      const replay = yield* store.enqueue("environment-1", "thread-1", "run-1", recapContext, 40_000_000);
      const identityAfterPrune = yield* store.hasIdentity("environment-1", "thread-1", "run-1");
      const missingIdentity = yield* store.hasIdentity("environment-1", "thread-1", "run-2");
      const stats = yield* store.stats();
      return { result, removed, replay, identityBeforePrune, identityAfterPrune, missingIdentity, stats };
    }));

    assert.equal(pruned.result.sentMetadata, 1);
    assert.equal(pruned.removed, null);
    assert.equal(pruned.replay, null);
    assert.equal(pruned.identityBeforePrune, true);
    assert.equal(pruned.identityAfterPrune, true);
    assert.equal(pruned.missingIdentity, false);
    assert.equal(pruned.stats.identities, 1);
  });
});

test("skipped recap identities survive reopen and prevent replay without retaining conversation text", async () => {
  await withTemporaryDirectory(async (directory) => {
    const id = await withStore(directory, (store) => store.enqueue("environment-1", "thread-1", "run-1", recapContext, 1_000));
    assert.ok(id);
    assert.equal(await withStore(directory, (store) => store.skipRecap(id)), true);
    const reopened = await withStore(directory, (store) => Effect.gen(function* () {
      const job = yield* store.getJob(id);
      const repeatedSkip = yield* store.skipRecap(id);
      const identity = yield* store.hasIdentity("environment-1", "thread-1", "run-1");
      const replay = yield* store.enqueue("environment-1", "thread-1", "run-1", recapContext, 2_000);
      const due = yield* store.dueJobs(2_000);
      const stats = yield* store.stats();
      return { job, repeatedSkip, identity, replay, due, stats };
    }));
    assert.equal(reopened.job, null);
    assert.equal(reopened.repeatedSkip, false);
    assert.equal(reopened.identity, true);
    assert.equal(reopened.replay, null);
    assert.deepEqual(reopened.due, []);
    assert.equal(reopened.stats.identities, 1);
    assert.equal(reopened.stats.jobs.sent, 0);
  });
});

test("skip decisions cannot delete prepared or uncertain Telegram deliveries", async () => {
  await withTemporaryDirectory(async (directory) => {
    await withStore(directory, (store) => Effect.gen(function* () {
      const id = yield* store.enqueue("environment-1", "thread-1", "run-1", recapContext, 1_000);
      assert.ok(id);
      yield* store.setReady(id, "A meaningful result", 1_100);
      assert.equal(yield* store.skipRecap(id), false);
      yield* store.claimSend(id, 1_200);
      assert.equal(yield* store.skipRecap(id), false);
      yield* store.markUnknown(id, "uncertain", 1_300);
      assert.equal(yield* store.skipRecap(id), false);
      assert.equal((yield* store.getJob(id))?.state, "unknown");
    }));
  });
});

test("recap context expires after seven days while the payload-free identity remains", async () => {
  await withTemporaryDirectory(async (directory) => {
    const id = await withStore(directory, (store) => store.enqueue(
      "environment-1",
      "thread-1",
      "run-1",
      recapContext,
      1_000,
    ));
    assert.ok(id);

    const result = await withStore(directory, (store) => Effect.gen(function* () {
      const pruned = yield* store.prune(1_000 + 8 * 24 * 60 * 60 * 1_000);
      const job = yield* store.getJob(id);
      const replay = yield* store.enqueue("environment-1", "thread-1", "run-1", recapContext, 2_000);
      return { pruned, job, replay };
    }));
    assert.equal(result.pruned.contexts, 1);
    assert.equal(result.job?.state, "pending");
    assert.equal(result.job?.context, null);
    assert.equal(result.replay, null);
  });
});

test("full replies are atomic, ordered and restart-safe without replaying uncertain parts", async () => {
  await withTemporaryDirectory(async (directory) => {
    const parent = await withStore(directory, (store) => store.enqueueReply("environment", "thread", "run", ["part one", "part two"], 1_000));
    assert.ok(parent);
    await withStore(directory, (store) => Effect.gen(function* () {
      assert.equal(yield* store.enqueueReply("environment", "thread", "run", ["different payload"], 2_000), null);
      assert.equal(yield* store.enqueue("environment", "thread", "run", recapContext, 2_000), null);
      const due = yield* store.dueJobs(2_000);
      assert.equal(due.length, 1);
      assert.equal(due[0]?.text, "part one");
      assert.equal(yield* store.claimSend(`${parent}-answer-2`, 2_000), false);
      yield* store.claimSend(due[0]!.id, 2_000);
    }));
    await withStore(directory, (store) => Effect.gen(function* () {
      yield* store.recoverSending(3_000);
      assert.deepEqual(yield* store.dueJobs(100_000), []);
      const unknown = yield* store.dueJobs(100_000, ["unknown"]);
      assert.equal(unknown.length, 1);
      assert.equal(unknown[0]?.deliveryKey, `${parent}-answer-1`);
      assert.equal(yield* store.claimSend(`${parent}-answer-2`, 100_000), false);
      yield* store.enqueueReply("environment", "other", "other-run", ["independent reply"], 3_000);
      assert.equal((yield* store.dueJobs(100_000))[0]?.threadId, "other");
      yield* store.markSent(`${parent}-answer-1`, 91, 100_000);
      const next = (yield* store.dueJobs(100_000)).find((job) => job.threadId === "thread");
      assert.equal(next?.text, "part two");
      yield* store.claimSend(next!.id, 100_000);
      yield* store.rejectSend(next!.id, "rate limited", 100_100, 100);
      const retry = (yield* store.dueJobs(100_200)).find((job) => job.threadId === "thread");
      assert.equal(retry?.deliveryKey, `${parent}-answer-2`);
      assert.equal(retry?.text, "part two");
      yield* store.claimSend(retry!.id, 100_200);
      yield* store.markSent(retry!.id, 92, 100_300);
      yield* store.prune(100_300 + 31 * 24 * 60 * 60 * 1_000);
      assert.equal(yield* store.hasIdentity("environment", "thread", "run"), true);
      assert.equal(yield* store.enqueueReply("environment", "thread", "run", ["replay"], 100_400), null);
    }));
  });
});
