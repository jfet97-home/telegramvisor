import assert from "node:assert/strict";
import test from "node:test";
import {
  COMPLETION_RECOVERY_PROMPT,
  CompletionRecovery,
  type CompletionRecoveryOperation,
  type CompletionRecoveryOperations,
} from "../src/completion-recovery.js";
import type { Projection } from "../src/types.js";

class RejectedNativeRpcError extends Error {
  readonly outcome = "rejected";
  readonly definiteRejection = true;
}

class UncertainNativeRpcError extends Error {
  readonly outcome = "rejected";
  readonly definiteRejection = false;
}

const gapId = "gap-1";
const threadId = "main-thread";

const projection = (overrides: Partial<Projection> = {}): Projection => ({
  thread: {
    id: threadId,
    title: "Current work",
    projectId: null,
    lineage: {parentThreadId: null, relationshipToParent: null},
    activeRunId: null,
    archivedAt: null,
    deletedAt: null,
  },
  runs: [],
  messages: [],
  runtimeRequests: [],
  nodes: [],
  providerTurns: [],
  ...overrides,
});

class MemoryOperations implements CompletionRecoveryOperations {
  readonly rows = new Map<string, CompletionRecoveryOperation>();

  findByGapId(id: string): CompletionRecoveryOperation | null {
    return this.rows.get(id) ?? null;
  }

  async reserveOnce(operation: CompletionRecoveryOperation) {
    const prior = this.rows.get(operation.gapId);
    if (prior) return {operation: prior, created: false};
    this.rows.set(operation.gapId, operation);
    return {operation, created: true};
  }

  finish(id: string, commandId: string, outcome: Parameters<CompletionRecoveryOperations["finish"]>[2]): void {
    const current = this.rows.get(id);
    if (!current || current.commandId !== commandId) return;
    if (current.state === "accepted" || current.state === "rejected") return;
    if (current.state === "reconciled" && outcome.state !== "accepted") return;
    if (current.state === "uncertain" && !["accepted", "reconciled", "rejected"].includes(outcome.state)) return;
    this.rows.set(id, {...current, ...outcome});
  }
}

const makeHarness = (options: {
  current?: Projection;
  projections?: Projection[];
  rpc?: (payload: Record<string, unknown>) => Promise<unknown>;
  gapAllowed?: boolean;
  threadAllowed?: boolean;
} = {}) => {
  const operations = new MemoryOperations();
  const nativeCalls: Array<{tag: string; payload: Record<string, unknown>}> = [];
  let readCount = 0;
  let projectionIndex = 0;
  const service = new CompletionRecovery({
    readProjection: async () => {
      readCount++;
      const values = options.projections ?? [options.current ?? projection()];
      const result = values[Math.min(projectionIndex, values.length - 1)]!;
      projectionIndex++;
      return result;
    },
    nativeRpc: async (tag, payload) => {
      nativeCalls.push({tag, payload});
      return options.rpc ? options.rpc(payload) : {sequence: 7};
    },
    operations,
    isGapActionable: async (id, thread) => id === gapId && thread === threadId && options.gapAllowed !== false,
    isThreadAllowed: async id => id === threadId && options.threadAllowed !== false,
    now: () => 1_800_000_000_000,
  });
  return {service, operations, nativeCalls, readCount: () => readCount};
};

const request = () => ({gapId, threadId});
const signal = () => new AbortController().signal;

test("an idle gap gets one stable ordinary follow-up with a bounded recovery prompt", async () => {
  const harness = makeHarness();
  const first = await harness.service.request(request(), signal());
  assert.equal(first.status, "requested");
  assert.equal(first.reason, "native_request_accepted");
  assert.equal(first.operation?.state, "accepted");
  assert.equal(first.operation?.dispatchMode.type, "queue_after_active");
  assert.equal(first.operation?.text, COMPLETION_RECOVERY_PROMPT);
  assert.ok(!first.operation?.text.includes(gapId));
  assert.ok(!first.operation?.text.includes("run-"));
  assert.equal(harness.nativeCalls.length, 1);
  assert.equal(harness.nativeCalls[0]?.tag, "orchestration.dispatchCommand");
  assert.deepEqual(harness.nativeCalls[0]?.payload, {
    type: "message.dispatch",
    createdBy: "system",
    creationSource: "server",
    commandId: first.operation?.commandId,
    threadId,
    messageId: first.operation?.messageId,
    text: COMPLETION_RECOVERY_PROMPT,
    attachments: [],
    dispatchMode: {type: "queue_after_active"},
  });

  const repeated = await harness.service.request(request(), signal());
  assert.equal(repeated.status, "already_requested");
  assert.equal(repeated.operation?.commandId, first.operation?.commandId);
  assert.equal(repeated.operation?.messageId, first.operation?.messageId);
  assert.equal(harness.nativeCalls.length, 1);
});

test("an active target is steered only when its provider turn is verified", async () => {
  const activeRun = {
    id: "active-run",
    ordinal: 2,
    status: "running",
    requestedAt: "2026-10-17T08:00:00Z",
    startedAt: "2026-10-17T08:00:01Z",
    completedAt: null,
    rootNodeId: "root-node",
    activeAttemptId: "attempt-1",
    threadId,
  };
  const current = projection({
    thread: {...projection().thread, activeRunId: "active-run"},
    runs: [activeRun],
    providerTurns: [{runAttemptId: "attempt-1", status: "running", nodeId: "root-node"}],
  });
  const harness = makeHarness({current});
  const result = await harness.service.request(request(), signal());
  assert.equal(result.status, "requested");
  assert.deepEqual(result.operation?.dispatchMode, {type: "steer_active", targetRunId: "active-run"});
});

test("an active run without a verified provider turn is deferred instead of queued", async () => {
  const current = projection({
    thread: {...projection().thread, activeRunId: "active-run"},
    runs: [{id: "active-run", ordinal: 2, status: "running", requestedAt: "", startedAt: "", completedAt: null, rootNodeId: "root", activeAttemptId: "attempt", threadId}],
    providerTurns: [],
  });
  const harness = makeHarness({current});
  const result = await harness.service.request(request(), signal());
  assert.equal(result.status, "deferred");
  assert.equal(result.reason, "target_busy");
  assert.equal(harness.operations.rows.size, 0);
  assert.equal(harness.nativeCalls.length, 0);
});

test("an unresolved running thread status is not treated as idle", async t => {
  for (const status of ["running", "activityRunStatus"] as const) {
    await t.test(status, async () => {
      const thread = {...projection().thread};
      delete thread.activeRunId;
      if (status === "running") thread.status = "running";
      else thread.activityRunStatus = "running";
      const harness = makeHarness({current: projection({thread})});
      const result = await harness.service.request(request(), signal());
      assert.equal(result.status, "deferred");
      assert.equal(result.reason, "target_busy");
      assert.equal(harness.nativeCalls.length, 0);
    });
  }
});

test("an ordinary fork remains eligible for recovery", async () => {
  const current = projection({
    thread: {...projection().thread, lineage: {parentThreadId: "origin-thread", relationshipToParent: "fork"}},
  });
  const harness = makeHarness({current});
  const result = await harness.service.request(request(), signal());
  assert.equal(result.status, "requested");
  assert.deepEqual(result.operation?.dispatchMode, {type: "queue_after_active"});
});

test("pending owner input defers recovery before reserving or sending", async () => {
  const current = projection({
    runtimeRequests: [{id: "approval", nodeId: "main-node", status: "pending"}],
    nodes: [{id: "main-node", threadId, runId: "run-1", kind: "root_turn"}],
    runs: [{id: "run-1", ordinal: 1, status: "completed", requestedAt: "", startedAt: null, completedAt: null, rootNodeId: "main-node", threadId}],
  });
  const harness = makeHarness({current});
  const result = await harness.service.request(request(), signal());
  assert.equal(result.status, "deferred");
  assert.equal(result.reason, "owner_input_pending");
  assert.equal(harness.operations.rows.size, 0);
  assert.equal(harness.nativeCalls.length, 0);
});

test("archived, deleted and child targets are not contacted", async t => {
  const cases: Array<[string, Projection]> = [
    ["archived", projection({thread: {...projection().thread, archivedAt: "2026-10-17T00:00:00Z"}})],
    ["deleted", projection({thread: {...projection().thread, deletedAt: "2026-10-17T00:00:00Z"}})],
    ["child", projection({thread: {...projection().thread, lineage: {parentThreadId: "parent", relationshipToParent: "subagent"}}})],
  ];
  for (const [label, current] of cases) {
    await t.test(label, async () => {
      const harness = makeHarness({current});
      const result = await harness.service.request(request(), signal());
      assert.equal(result.status, "unavailable");
      assert.equal(result.reason, "target_unavailable");
      assert.equal(harness.operations.rows.size, 0);
      assert.equal(harness.nativeCalls.length, 0);
    });
  }
});

test("uncertain dispatch reconciles by exact message identity and never resends", async () => {
  const message = {
    id: "message",
    runId: "new-run",
    nodeId: "node",
    threadId,
    role: "user",
    text: COMPLETION_RECOVERY_PROMPT,
    streaming: false,
    createdAt: "2026-10-17T08:00:00Z",
    updatedAt: "2026-10-17T08:00:00Z",
  };
  const harness = makeHarness({
    projections: [projection(), projection(), projection()],
    rpc: async () => {throw new Error("transport closed after send");},
  });
  const first = await harness.service.request(request(), signal());
  assert.equal(first.status, "uncertain");
  assert.equal(first.operation?.state, "uncertain");
  const absent = await harness.service.request(request(), signal());
  assert.equal(absent.status, "uncertain");
  assert.equal(harness.nativeCalls.length, 1);

  const current = projection({messages: [{...message, id: first.operation!.messageId}]});
  const withVisibleMessage = makeHarness({
    projections: [current],
  });
  withVisibleMessage.operations.rows.set(gapId, {...first.operation!, state: "uncertain"});
  const reconciled = await withVisibleMessage.service.request(request(), signal());
  assert.equal(reconciled.status, "already_requested");
  assert.equal(reconciled.reason, "operation_visible_in_t3");
  assert.equal(reconciled.operation?.state, "reconciled");
  assert.equal(withVisibleMessage.nativeCalls.length, 0);
});

test("a late native receipt upgrades a concurrent uncertain reconciliation", async () => {
  let resolveRpc!: (value: unknown) => void;
  let markRpcEntered!: () => void;
  const rpcEntered = new Promise<void>(resolve => {markRpcEntered = resolve;});
  const rpcResult = new Promise<unknown>(resolve => {resolveRpc = resolve;});
  const harness = makeHarness({rpc: async () => {markRpcEntered();return rpcResult;}});
  const original = harness.service.request(request(), signal());
  await rpcEntered;

  const duplicate = await harness.service.request(request(), signal());
  assert.equal(duplicate.status, "uncertain");
  assert.equal(harness.operations.rows.get(gapId)?.state, "uncertain");
  assert.equal(harness.nativeCalls.length, 1);

  resolveRpc({sequence: 9});
  const accepted = await original;
  assert.equal(accepted.status, "requested");
  assert.equal(harness.operations.rows.get(gapId)?.state, "accepted");
});

test("a definite native rejection is retained and cannot be duplicated by another click", async () => {
  const error = new RejectedNativeRpcError("rejected");
  const harness = makeHarness({rpc: async () => {throw error;}});
  const first = await harness.service.request(request(), signal());
  assert.equal(first.status, "rejected");
  assert.equal(first.operation?.state, "rejected");
  const repeated = await harness.service.request(request(), signal());
  assert.equal(repeated.status, "rejected");
  assert.equal(harness.nativeCalls.length, 1);
});

test("a pre-send rejection without definite native evidence remains uncertain", async () => {
  const harness = makeHarness({rpc: async () => {throw new UncertainNativeRpcError("pre-send failure");}});
  const result = await harness.service.request(request(), signal());
  assert.equal(result.status, "uncertain");
  assert.equal(result.operation?.state, "uncertain");
  assert.equal(harness.nativeCalls.length, 1);
});

test("a gap blocked by current chat policy remains read-only", async () => {
  const harness = makeHarness({threadAllowed: false});
  const result = await harness.service.request(request(), signal());
  assert.equal(result.status, "unavailable");
  assert.equal(result.reason, "thread_not_allowed");
  assert.equal(harness.readCount(), 0);
  assert.equal(harness.nativeCalls.length, 0);
});
