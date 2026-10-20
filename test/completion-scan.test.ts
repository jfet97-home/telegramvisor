import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Effect } from "effect";
import { Store, makeStore } from "../src/store.js";
import { collectRecentCompletions, collectFullCompletions, readCompletionHistory, CompletionWindowReadError } from "../src/completion-scan.js";
import { buildContext, eligibleRuns, formatReplyParts, telegramRouteUpdateId } from "../src/domain.js";
import { T3TransportError, type T3ClientShape, type T3BoundedCompletionSnapshot } from "../src/t3.js";
import type { CompletionRecoveryOperation } from "../src/completion-recovery.js";

const snapshot = (): T3BoundedCompletionSnapshot => ({snapshotSequence: 2, historyCursor: "older", hasMoreHistory: true,
  latestLocalTurnOrdinal: 2, payloadBudgetExceeded: false, projection: {
    thread: {id: "chat", title: "Invoice fix", projectId: null, lineage: {parentThreadId: null, relationshipToParent: null}, activeRunId: null},
    runs: [{id: "run", threadId: "chat", ordinal: 2, providerThreadId: "provider", status: "completed", requestedAt: "2026-10-17T10:00:00Z",
      startedAt: "2026-10-17T10:00:00Z", completedAt: "2026-10-17T10:01:00Z", rootNodeId: "root", userMessageId: "request"}],
    nodes: [
      {id: "root", kind: "root_turn", threadId: "chat", runId: "run", rootNodeId: "root", parentNodeId: null, providerThreadId: "provider", status: "completed"},
      {id: "answer-node", kind: "assistant_message", threadId: "chat", runId: "run", rootNodeId: "root", parentNodeId: "root", providerThreadId: "provider", status: "completed"},
    ],
    messages: [
      {id: "request", threadId: "chat", runId: "run", nodeId: "root", role: "user", text: "Fix the invoice calculation and check it.", streaming: false, createdAt: "2026-10-17T10:00:00Z", updatedAt: "2026-10-17T10:00:00Z"},
      {id: "answer", threadId: "chat", runId: "run", nodeId: "answer-node", role: "assistant", text: "Invoice calculation fixed; six tests pass.", streaming: false, createdAt: "2026-10-17T10:01:00Z", updatedAt: "2026-10-17T10:01:00Z"},
    ], runtimeRequests: [], subagents: [], providerThreads: [], turnItems: [],
  }});

test("recent collection preserves identities across restart without pretending older history was processed", async () => {
  const directory = await mkdtemp(join(tmpdir(), "completion-window-"));
  try {
    const run = () => Effect.runPromise(Effect.gen(function* () {
      const store = yield* Store;
      yield* store.activate("environment", 1);
      const result = yield* collectRecentCompletions(store, snapshot(), "environment", 1, 100);
      const stats = yield* store.stats();
      assert.equal(stats.identities, 1);
      assert.equal(stats.jobs.pending, 1);
      assert.equal(stats.completionCoverageGaps, 1);
      assert.equal(yield* store.hasIdentity("environment", "chat", "unseen-old-run"), false);
      return result.queued;
    }).pipe(Effect.provide(makeStore(directory)), Effect.scoped));
    assert.equal(await run(), 1);
    assert.equal(await run(), 0);
  } finally {await rm(directory, {recursive: true, force: true});}
});

for (const recapsAfter of [-Infinity, Infinity]) {
test(`a cut-off Telegram request creates a coverage gap with recap cutoff ${recapsAfter}`, async () => {
  const directory = await mkdtemp(join(tmpdir(), "completion-boundary-"));
  try {
    await Effect.runPromise(Effect.gen(function* () {
      const store = yield* Store;
      yield* store.activate("environment", 1);
      const value = snapshot();
      value.projection.runs[0]!.userMessageId = "message:mcp:90d829bb-aada-40db-b243-797c00ac8f36:thread-send:telegram-route-123";
      value.projection.messages.shift();
      const result = yield* collectRecentCompletions(store, value, "environment", 1, 100, recapsAfter);
      assert.equal(result.settling, false);
      assert.equal(result.queued, 0);
      const stats = yield* store.stats();
      assert.equal(stats.identities, 0);
      assert.equal(stats.jobs.pending, 0);
      assert.equal((yield* store.completionGaps!())[0]?.reason, "incomplete_turn");
    }).pipe(Effect.provide(makeStore(directory)), Effect.scoped));
  } finally {await rm(directory, {recursive: true, force: true});}
});
}

test("complete cohort results equal a full fixture including exact Telegram answer routing", () => {
  const recent = snapshot().projection;
  const full = structuredClone(recent);
  full.runs.unshift({...full.runs[0]!, id: "older", ordinal: 1, completedAt: "1970-01-01T00:00:00Z"});
  const requestId = "message:mcp:90d829bb-aada-40db-b243-797c00ac8f36:thread-send:telegram-route-123";
  for (const value of [full, recent]) {value.runs.find(run => run.id === "run")!.userMessageId = requestId;value.messages[0]!.id = requestId;}
  assert.deepEqual(eligibleRuns(full, 1).map(run => run.id), eligibleRuns(recent, 1).map(run => run.id));
  assert.deepEqual(buildContext(full, "run", null), buildContext(recent, "run", null));
  assert.deepEqual(formatReplyParts(full, full.runs[1]!, null), formatReplyParts(recent, recent.runs[0]!, null));
  assert.equal(telegramRouteUpdateId(full, full.runs[1]!), telegramRouteUpdateId(recent, recent.runs[0]!));
});

for (const kind of ["full", "recent"] as const) {
  test(`${kind} collection keeps Telegram replies while recaps are off and excludes disabled-period recaps`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "completion-recap-opt-in-"));
    try {
      await Effect.runPromise(Effect.gen(function* () {
        const store = yield* Store;
        const value = snapshot();
        const collect = (recapsAfter: number) => kind === "full"
          ? collectFullCompletions(store, value, "environment", 1, 100, recapsAfter)
          : collectRecentCompletions(store, value, "environment", 1, 100, recapsAfter);
        assert.equal((yield* collect(Infinity)).queued, 0);
        assert.equal((yield* collect(Infinity)).settling, false);
        const completedAt = Date.parse(value.projection.runs[0]!.completedAt!);
        assert.equal((yield* collect(completedAt + 1)).queued, 0);
        assert.equal((yield* collect(completedAt + 1)).settling, false);
        assert.equal((yield* collect(completedAt - 1)).queued, 1);
        const requestId = "message:mcp:90d829bb-aada-40db-b243-797c00ac8f36:thread-send:telegram-route-123";
        value.projection.runs[0]!.id = "reply-run";
        value.projection.runs[0]!.userMessageId = requestId;
        for (const message of value.projection.messages) message.runId = "reply-run";
        for (const node of value.projection.nodes as Array<{runId: string}>) node.runId = "reply-run";
        value.projection.messages[0]!.id = requestId;
        assert.equal((yield* collect(Infinity)).queued, 1);
        assert.equal((yield* store.stats()).jobs.ready, 1);
      }).pipe(Effect.provide(makeStore(directory)), Effect.scoped));
    } finally {await rm(directory, {recursive: true, force: true});}
  });
}

test("durable recovery reservation and positive outcomes survive concurrent updates and restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "completion-recovery-store-"));
  let gapId = "";
  try {
    await Effect.runPromise(Effect.gen(function* () {
      const store = yield* Store;
      const gap = yield* store.recordCompletionGap!("chat", "older_history_not_read", null, 1);
      gapId = gap.id;
      const operation: CompletionRecoveryOperation = {gapId, threadId: "chat", commandId: "command", messageId: "message", text: "Check current results.",
        dispatchMode: {type: "queue_after_active"}, state: "dispatching", sequence: null, createdAt: 2, updatedAt: 2};
      assert.equal((yield* store.reserveCompletionRecovery!(operation)).created, true);
      assert.equal((yield* store.reserveCompletionRecovery!(operation)).created, false);
      yield* store.finishCompletionRecovery!(gapId, "command", {state: "uncertain", sequence: null, updatedAt: 3});
      yield* store.finishCompletionRecovery!(gapId, "command", {state: "accepted", sequence: 20, updatedAt: 4});
      yield* store.finishCompletionRecovery!(gapId, "command", {state: "uncertain", sequence: null, updatedAt: 5});
      yield* store.recordCompletionGap!("chat", "incomplete_turn", "run", 6);
    }).pipe(Effect.provide(makeStore(directory)), Effect.scoped));
    await Effect.runPromise(Effect.gen(function* () {
      const store = yield* Store;
      const gap = yield* store.completionGap!(gapId);
      assert.equal(gap?.recovery?.state, "accepted");
      assert.equal(gap?.recovery?.sequence, 20);
      assert.equal(gap?.reason, "incomplete_turn");
      assert.equal((yield* store.stats()).identities, 0);
    }).pipe(Effect.provide(makeStore(directory)), Effect.scoped));
  } finally {await rm(directory, {recursive: true, force: true});}
});

test("a long agent or Telegram turn still uses the full reader without a false coverage gap", async () => {
  const directory = await mkdtemp(join(tmpdir(), "completion-full-path-"));
  try {
    await Effect.runPromise(Effect.gen(function* () {
      const store = yield* Store;
      yield* store.activate("environment", 1);
      const full = snapshot();
      const requestId = "message:mcp:90d829bb-aada-40db-b243-797c00ac8f36:thread-send:telegram-route-42";
      full.projection.runs[0]!.userMessageId = requestId;full.projection.messages[0]!.id = requestId;
      full.projection.turnItems = Array.from({length: 100}, (_, ordinal) => ({type: "dynamic_tool", status: "completed", ordinal}));
      let boundedReads = 0;
      const t3 = {projection: () => Effect.succeed({snapshotSequence: 2, projection: full.projection}),
        boundedCompletionProjection: () => {boundedReads++;return Effect.succeed({...full, projection: {...full.projection, messages: full.projection.messages.slice(1)}});}} as unknown as T3ClientShape;
      const history = yield* readCompletionHistory(t3, "chat", new Set());
      assert.equal(history.kind, "full");
      const result = yield* collectFullCompletions(store, history.snapshot, "environment", 1, 100);
      assert.equal(result.queued, 1);assert.equal(boundedReads, 0);
      const stats = yield* store.stats();assert.equal(stats.completionCoverageGaps, 0);assert.equal(stats.jobs.ready, 1);
      const job = (yield* store.dueJobs(100))[0]!;assert.ok(job.text?.endsWith(full.projection.messages[1]!.text));
    }).pipe(Effect.provide(makeStore(directory)), Effect.scoped));
  } finally {await rm(directory, {recursive: true, force: true});}
});

test("only a typed full-read size failure enters and remembers the recent path", async () => {
  let fullReads = 0;let boundedReads = 0;
  const t3 = {projection: () => {fullReads++;return Effect.fail(new T3TransportError("size", undefined, "response_too_large"));},
    boundedCompletionProjection: () => {boundedReads++;return Effect.succeed(snapshot());}} as unknown as T3ClientShape;
  const oversized = new Set<string>();
  assert.equal((await Effect.runPromise(readCompletionHistory(t3, "chat", oversized))).kind, "recent");
  assert.equal((await Effect.runPromise(readCompletionHistory(t3, "chat", oversized))).kind, "recent");
  assert.equal(fullReads, 1);assert.equal(boundedReads, 2);
  await Effect.runPromise(readCompletionHistory(t3, "chat", new Set()));
  assert.equal(fullReads, 2);
});

test("a bounded endpoint 404 remains a window failure rather than proving a missing chat", async () => {
  const t3 = {projection: () => Effect.fail(new T3TransportError("size", undefined, "response_too_large")),
    boundedCompletionProjection: () => Effect.fail(new T3TransportError("bounded endpoint unavailable", 404))} as unknown as T3ClientShape;
  const result = await Effect.runPromise(readCompletionHistory(t3, "chat", new Set()).pipe(Effect.result));
  assert.equal(result._tag, "Failure");
  if (result._tag === "Failure") {assert.ok(result.failure instanceof CompletionWindowReadError);assert.equal(result.failure.httpStatus, 404);}
});
