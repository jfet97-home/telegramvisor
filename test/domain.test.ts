import assert from "node:assert/strict";
import test from "node:test";
import {
  buildContext,
  deliveryKey,
  eligibleRuns,
  freshRuntimeRequestStatus,
  formatMessage,
  formatReplyParts,
  projectionHasOngoingWork,
  telegramRouteUpdateId,
  isMainThread,
} from "../src/domain.js";
import type { MessageInfo, ProjectInfo, Projection, RunInfo, ThreadInfo } from "../src/types.js";

const thread = (overrides: Partial<ThreadInfo> = {}): ThreadInfo => ({
  id: "thread-1",
  title: "A conversation",
  projectId: "project-1",
  lineage: { parentThreadId: null, relationshipToParent: null },
  ...overrides,
});

const project: ProjectInfo = {
  id: "project-1",
  title: "A project",
  workspaceRoot: "/work/project",
};

const run = (overrides: Partial<RunInfo> & { threadId?: string } = {}): RunInfo => ({
  id: "run-1",
  threadId: "thread-1",
  ordinal: 1,
  status: "completed",
  requestedAt: "2025-01-01T00:00:00.000Z",
  startedAt: "2025-01-01T00:00:01.000Z",
  completedAt: "2025-01-01T00:01:00.000Z",
  rootNodeId: "root-1",
  providerThreadId: "provider-1",
  ...overrides,
});

const message = (overrides: Partial<MessageInfo> = {}): MessageInfo => ({
  id: "message-1",
  threadId: "thread-1",
  runId: "run-1",
  nodeId: "assistant-1",
  role: "assistant",
  text: "The completed answer.",
  streaming: false,
  createdAt: "2025-01-01T00:01:00.000Z",
  updatedAt: "2025-01-01T00:01:00.000Z",
  ...overrides,
});

const nodesFor = (
  currentThreadId: string,
  runs: RunInfo[],
  messages: MessageInfo[],
): Array<Record<string, unknown>> => {
  const nodes: Array<Record<string, unknown>> = [];
  for (const currentRun of runs) {
    if (typeof currentRun.rootNodeId !== "string") continue;
    const providerThreadId = typeof currentRun.providerThreadId === "string" ? currentRun.providerThreadId : null;
    nodes.push({
      id: currentRun.rootNodeId,
      threadId: currentThreadId,
      runId: currentRun.id,
      parentNodeId: null,
      rootNodeId: currentRun.rootNodeId,
      kind: "root_turn",
      status: "completed",
      providerThreadId,
    });
    for (const currentMessage of messages) {
      if (
        currentMessage.runId !== currentRun.id ||
        currentMessage.role !== "assistant" ||
        typeof currentMessage.nodeId !== "string" ||
        currentMessage.nodeId === currentRun.rootNodeId
      ) continue;
      nodes.push({
        id: currentMessage.nodeId,
        threadId: currentThreadId,
        runId: currentRun.id,
        parentNodeId: currentRun.rootNodeId,
        rootNodeId: currentRun.rootNodeId,
        kind: "assistant_message",
        status: currentMessage.streaming ? "running" : "completed",
        providerThreadId,
      });
    }
  }
  return nodes;
};

const projection = (overrides: Partial<Projection> = {}): Projection => {
  const current: Projection = {
    thread: thread(),
    runs: [run()],
    messages: [message()],
    ...overrides,
  };
  if (!Object.hasOwn(overrides, "nodes")) {
    current.nodes = nodesFor(current.thread.id, current.runs, current.messages);
  }
  return current;
};

test("main-thread filtering rejects deleted chats and subagents without hardcoded chat IDs", () => {
  assert.equal(isMainThread(thread()), true);
  assert.equal(isMainThread(thread({ lineage: { parentThreadId: "parent", relationshipToParent: "fork" } })), true);
  assert.equal(isMainThread(thread({ lineage: { parentThreadId: "parent", relationshipToParent: "subagent" } })), false);
  assert.equal(isMainThread(thread({ id: "instance-router" })), true);
  assert.equal(isMainThread(thread({ deletedAt: "2025-01-01T00:00:00.000Z" })), false);
});

test("eligibility returns every successful post-activation run with a root final answer", () => {
  const current = projection({
    runs: [
      run({ id: "run-1", ordinal: 1, completedAt: "2025-01-02T00:00:00.000Z", rootNodeId: "root-1" }),
      run({ id: "run-2", ordinal: 2, completedAt: "2025-01-03T00:00:00.000Z", rootNodeId: "root-2" }),
      run({ id: "old", ordinal: 0, completedAt: "2024-12-31T23:59:59.999Z", rootNodeId: "root-old" }),
      run({ id: "failed", ordinal: 3, status: "failed", completedAt: "2025-01-04T00:00:00.000Z", rootNodeId: "root-failed" }),
      run({ id: "streaming", ordinal: 4, completedAt: "2025-01-05T00:00:00.000Z", rootNodeId: "root-streaming" }),
    ],
    messages: [
      message({ runId: "run-1", nodeId: "answer-1" }),
      message({ id: "final-2", runId: "run-2", nodeId: "answer-2" }),
      message({ id: "old-answer", runId: "old", nodeId: "answer-old" }),
      message({ id: "failed-answer", runId: "failed", nodeId: "answer-failed" }),
      message({ id: "partial", runId: "streaming", nodeId: "answer-streaming", streaming: true }),
    ],
  });

  assert.deepEqual(eligibleRuns(current, Date.parse("2025-01-01T00:00:00.000Z")).map(({ id }) => id), ["run-1", "run-2"]);
  assert.deepEqual(eligibleRuns(current, Date.parse("2025-01-02T00:00:00.000Z")).map(({ id }) => id), ["run-2"]);
});

test("foreground, runtime, background, and undelivered subagent work block completion", () => {
  const current = projection();
  assert.deepEqual(eligibleRuns({ ...current, thread: thread({ activeRunId: "active" }) }, 0), []);
  assert.deepEqual(eligibleRuns({ ...current, thread: thread({ pendingBackgroundTasks: [{ kind: "unknown" }] }) }, 0), []);
  assert.deepEqual(eligibleRuns({ ...current, thread: thread({ pendingBackgroundTasks: [{ kind: "command" }] }) }, 0).length, 1);
  assert.deepEqual(eligibleRuns({ ...current, runtimeRequests: [{ status: "pending" }] }, 0), []);
  assert.deepEqual(eligibleRuns({ ...current, subagents: [{ status: "completed", completionDelivery: { state: "claimed" } }] }, 0), []);
  assert.deepEqual(eligibleRuns({ ...current, subagents: [{ status: "running", completionDelivery: { state: "delivered" } }] }, 0), []);
});

test("fresh terminal runtime-request status clears stale shell hints while missing evidence fails closed", () => {
  const requestHint = {id: "owner-request", nodeId: "assistant-1", runId: "run-1", status: "pending"};
  const shell = thread({pendingRuntimeRequest: requestHint});
  for (const status of ["resolved", "expired", "cancelled"]) {
    const current = projection({runtimeRequests: [{id: "owner-request", nodeId: "assistant-1", runId: "run-1", status}]});
    assert.equal(freshRuntimeRequestStatus(current, {requestId: "owner-request", nodeId: "assistant-1"}), status);
    assert.deepEqual(eligibleRuns(current, 0, shell).map(({id}) => id), ["run-1"], status);
    assert.equal(projectionHasOngoingWork(current, shell), false, status);
  }

  const missing = projection({runtimeRequests: []});
  assert.equal(freshRuntimeRequestStatus(missing, {requestId: "owner-request", nodeId: "assistant-1"}), "unknown");
  assert.deepEqual(eligibleRuns(missing, 0, shell), [], "an absent matching request keeps the shell hint fail-closed");
  assert.equal(projectionHasOngoingWork(missing, shell), true);
  const mismatched = projection({runtimeRequests: [{id: "owner-request", nodeId: "other-node", status: "resolved"}]});
  assert.equal(freshRuntimeRequestStatus(mismatched, {requestId: "owner-request", nodeId: "assistant-1"}), "unknown");
  assert.deepEqual(eligibleRuns(mismatched, 0, shell), []);
});

test("a pending owner request remains ongoing after its run ends and does not mask other work", () => {
  const pending = projection({runtimeRequests: [{id: "owner-request", nodeId: "assistant-1", runId: "run-1", status: "pending"}]});
  assert.equal(freshRuntimeRequestStatus(pending, {requestId: "owner-request", nodeId: "assistant-1"}), "pending");
  assert.deepEqual(eligibleRuns(pending, 0), [], "terminal run status does not imply the request expired");
  assert.equal(projectionHasOngoingWork(pending), true);

  const otherWork = projection({
    runtimeRequests: [{id: "owner-request", nodeId: "assistant-1", runId: "run-1", status: "resolved"}],
    subagents: [{parentRunId: "run-1", status: "running"}],
  });
  assert.deepEqual(eligibleRuns(otherWork, 0), []);
  assert.equal(projectionHasOngoingWork(otherWork), true, "resolved requests do not hide active child work");
});

test("later running or queued turns cannot delay an already completed turn", () => {
  for (const status of ["queued", "running", "waiting"]) {
    const later = run({ id: "later", ordinal: 2, status, completedAt: null, rootNodeId: "root-later" });
    const current = projection({
      thread: thread({ activeRunId: status === "queued" ? null : "later", activityRunStatus: status }),
      runs: [run(), later],
      runtimeRequests: [{ status: "pending", runId: "later" }],
      turnItems: [{ type: "dynamic_tool", status: "running", runId: "later" }],
      subagents: [{ parentRunId: "later", status: "running", completionDelivery: { state: "pending" } }],
      providerThreads: [{ id: "provider-1", goal: { status: "active" } }],
    });
    assert.deepEqual(eligibleRuns(current, 0).map(({ id }) => id), ["run-1"], status);
  }
});

test("a completed turn still waits for its own tools, approval and child delivery during a later turn", () => {
  const later = run({ id: "later", ordinal: 2, status: "running", completedAt: null, rootNodeId: "root-later" });
  const base = projection({ thread: thread({ activeRunId: "later" }), runs: [run(), later] });
  for (const scope of [
    { runtimeRequests: [{ status: "pending", runId: "run-1" }] },
    { runtimeRequests: [{ status: "pending", nodeId: "assistant-1" }] },
    { turnItems: [{ type: "dynamic_tool", status: "running", runId: "run-1" }] },
    { subagents: [{ parentRunId: "run-1", status: "running" }] },
    { subagents: [{ parentNodeId: "root-1", status: "completed", completionDelivery: { state: "claimed" } }] },
  ]) assert.deepEqual(eligibleRuns({ ...base, ...scope }, 0), []);
  assert.deepEqual(eligibleRuns({
    ...base,
    subagents: [{ parentRunId: "run-1", status: "completed", completionDelivery: { state: "delivered" } }],
  }, 0).map(({ id }) => id), ["run-1"]);
});

test("provider background rosters are scoped to the current provider thread", () => {
  const currentThread = thread({ activeProviderThreadId: "provider-current" });
  const oldRoster = { id: "provider-old", pendingBackgroundTasks: [{ kind: "monitor" }] };
  const currentRoster = { id: "provider-current", pendingBackgroundTasks: [] };
  const projectionWithRosters = (providerThreads: Array<Record<string, unknown>>): Projection => projection({
    thread: currentThread,
    runs: [run({ providerThreadId: "provider-current" })],
    providerThreads,
  });

  assert.deepEqual(eligibleRuns(projectionWithRosters([oldRoster, currentRoster]), 0).map(({ id }) => id), ["run-1"]);
  assert.deepEqual(eligibleRuns(projectionWithRosters([oldRoster, {
    id: "provider-current",
    pendingBackgroundTasks: [{ kind: "monitor" }],
  }]), 0), []);

  const fallback = projection({
    thread: thread({ activeProviderThreadId: null }),
    runs: [run({ providerThreadId: "provider-latest" })],
    providerThreads: [oldRoster, { id: "provider-latest", pendingBackgroundTasks: [{ kind: "subagent" }] }],
  });
  assert.deepEqual(eligibleRuns(fallback, 0), []);
});

test("active goals hold completion but paused or limited goals do not", () => {
  const current = (status: string): Projection => projection({
    thread: thread({ activeProviderThreadId: "provider-1" }),
    providerThreads: [{ id: "provider-1", goal: { status } }],
  });
  assert.deepEqual(eligibleRuns(current("active"), 0), []);
  for (const status of ["paused", "blocked", "usage_limited", "budget_limited", "complete"]) {
    assert.equal(eligibleRuns(current(status), 0).length, 1, `${status} should not hold a completed turn`);
  }
});

test("active dynamic tools and subagents hold completion with command and persistent exceptions", () => {
  const current = projection();
  assert.deepEqual(eligibleRuns({
    ...current,
    turnItems: [{ type: "dynamic_tool", status: "running", runId: "run-1", input: { persistent: false } }],
  }, 0), []);
  assert.equal(eligibleRuns({
    ...current,
    turnItems: [{ type: "dynamic_tool", status: "running", runId: "run-1", input: { persistent: true } }],
  }, 0).length, 1);
  assert.equal(eligibleRuns({
    ...current,
    turnItems: [{ type: "command_execution", status: "running", runId: "run-1" }],
  }, 0).length, 1);
  assert.deepEqual(eligibleRuns({
    ...current,
    turnItems: [{ type: "subagent", status: "waiting", runId: "run-1" }],
  }, 0), []);

  const rolledBackWork = projection({
    runs: [run({ id: "rolled-back", ordinal: 0, status: "rolled_back", rootNodeId: "root-abandoned" }), run()],
    turnItems: [{ type: "dynamic_tool", status: "running", runId: "rolled-back", input: { persistent: false } }],
  });
  assert.deepEqual(eligibleRuns(rolledBackWork, 0).map(({ id }) => id), ["run-1"]);
});

test("active pull request watches hold completion except stack-dismissed links", () => {
  const watched = thread({ pullRequests: [{ source: "manual", watch: { startedAt: "2025-01-01T00:00:00.000Z" } }] });
  const dismissed = thread({ pullRequests: [{ source: "stack-dismissed", watch: { startedAt: "2025-01-01T00:00:00.000Z" } }] });
  assert.deepEqual(eligibleRuns(projection({ thread: watched }), 0), []);
  assert.equal(eligibleRuns(projection({ thread: dismissed }), 0).length, 1);
});

test("context uses only the target turn and excludes earlier, later or non-conversation output", () => {
  const target = run({ id: "target", ordinal: 2, completedAt: "2025-01-03T00:00:00.000Z", rootNodeId: "root-target" });
  const prior = run({ id: "prior", ordinal: 1, completedAt: "2025-01-02T00:00:00.000Z", rootNodeId: "root-prior" });
  const base = projection({
    runs: [prior, target],
    messages: [
      message({ id: "question", runId: "prior", role: "user", text: "What should I do?", nodeId: null, createdAt: "2025-01-01T00:00:00.000Z" }),
      message({ id: "old-answer", runId: "prior", text: "Start with the first step.", nodeId: "assistant-prior", createdAt: "2025-01-02T00:00:00.000Z" }),
      message({ id: "tool", runId: "target", role: "tool", text: "private tool output", createdAt: "2025-01-02T12:00:00.000Z" }),
      message({ id: "reasoning", runId: "target", nodeId: "reasoning-node", text: "private reasoning", createdAt: "2025-01-02T12:00:01.000Z" }),
      message({ id: "future", runId: "target", role: "user", text: "After completion", nodeId: null, createdAt: "2025-01-04T00:00:00.000Z" }),
      message({ id: "final-old", runId: "target", nodeId: "assistant-target-old", text: "An earlier final.", createdAt: "2025-01-02T23:00:00.000Z", updatedAt: "2025-01-02T23:00:00.000Z" }),
      message({ id: "final-latest", runId: "target", nodeId: "assistant-target-final", text: "The latest final.", createdAt: "2025-01-02T23:30:00.000Z", updatedAt: "2025-01-03T00:00:00.000Z" }),
    ],
  });
  const current = {
    ...base,
    nodes: (base.nodes as Array<Record<string, unknown>>).map((node) =>
      node.id === "reasoning-node" ? { ...node, kind: "reasoning" } : node
    ),
  };

  const context = buildContext(current, "target", project);
  assert.equal(context.finalAnswer, "The latest final.");
  assert.deepEqual(context.messages.map(({ text }) => text), [
    "An earlier final.",
  ]);
  assert.equal(context.thread.id, "thread-1");
  assert.equal(context.project?.workspaceRoot, project.workspaceRoot);
});

test("queued requests are associated by message ID and prioritized without earlier accomplishments", () => {
  const target = run({ id: "target", ordinal: 2, userMessageId: "queued-request", rootNodeId: "root-target" });
  const current = projection({
    runs: [run(), target],
    messages: [
      message({ text: "Opened and reviewed a major PR.", updatedAt: "2025-01-01T00:00:30.000Z" }),
      message({ id: "queued-request", runId: null, role: "user", nodeId: null, text: "Discord mirroring is automatic, no problem.", createdAt: "2025-01-01T00:00:00.000Z" }),
      message({ id: "update", runId: "target", nodeId: "update-target", text: "Clarifying the posting policy. ".repeat(1_000), createdAt: "2025-01-01T00:00:50.000Z", updatedAt: "2025-01-01T00:00:50.000Z" }),
      message({ id: "final", runId: "target", nodeId: "final-target", text: "Understood, automatic mirroring is fine." }),
    ],
  });
  const context = buildContext(current, "target", project, 1_024);
  assert.equal(context.finalAnswer, "Understood, automatic mirroring is fine.");
  assert.equal(context.messages[0]?.text, "Discord mirroring is automatic, no problem.");
  assert.ok(JSON.stringify(context).length <= 1_024);
  assert.ok(!JSON.stringify(context).includes("major PR"));
});

test("long final answers cannot evict the request that identifies repeated work", () => {
  const request = "Repeat the earlier report verbatim; do not do any new work.";
  const current = projection({
    runs: [run({ userMessageId: "request" })],
    messages: [
      message({ id: "request", role: "user", nodeId: null, text: request, createdAt: "2025-01-01T00:00:00.000Z" }),
      message({ text: "Verified the deployment and completed the investigation. ".repeat(1_200) + "REPORT_END" }),
    ],
  });
  for (const bound of [60_000, 1_024]) {
    const context = buildContext(current, "run-1", project, bound);
    assert.equal(context.messages[0]?.text, request);
    assert.ok(context.finalAnswer.endsWith("REPORT_END"));
    assert.ok(JSON.stringify(context).length <= bound);
  }
});

test("context caps serialized content at 60000 characters and preserves the final answer tail", () => {
  const hugeFinal = `BEGIN ${"😀é".repeat(40_000)} FINAL_END`;
  const current = projection({ messages: [message({ text: hugeFinal })] });
  const context = buildContext(current, "run-1", project);

  assert.ok(JSON.stringify(context).length <= 60_000);
  assert.ok(context.finalAnswer.startsWith("BEGIN"));
  assert.ok(context.finalAnswer.endsWith("FINAL_END"));
  assert.doesNotMatch(context.finalAnswer, /[\uD800-\uDBFF]$/u);
});

test("root answers follow assistant nodes, excluding null roots, subagent descendants, and provider branches", () => {
  const cancelled = run({
    id: "cancelled",
    ordinal: 1,
    status: "cancelled",
    completedAt: "2025-01-02T00:00:00.000Z",
    rootNodeId: null,
  });
  const completed = run({
    id: "completed",
    ordinal: 2,
    status: "completed",
    completedAt: "2025-01-03T00:00:00.000Z",
    rootNodeId: "root-main",
    providerThreadId: "provider-main",
  });
  const current = projection({
    runs: [cancelled, completed],
    messages: [
      message({ id: "cancelled-message", runId: "cancelled", nodeId: null, text: "Not a root answer." }),
      message({ id: "question", runId: "completed", role: "user", nodeId: "root-main", text: "What happened?", createdAt: "2025-01-02T00:00:00.000Z" }),
      message({
        id: "commentary-message",
        runId: "completed",
        nodeId: "assistant-commentary",
        text: "A progress update.",
        createdAt: "2025-01-02T12:00:00.000Z",
        updatedAt: "2025-01-02T12:00:00.000Z",
      }),
      message({ id: "final-message", runId: "completed", nodeId: "assistant-final", text: "The actual final.", updatedAt: "2025-01-03T00:00:00.000Z" }),
      message({ id: "foreign-message", runId: "completed", nodeId: "assistant-foreign", text: "Other provider output.", updatedAt: "2025-01-03T00:01:00.000Z" }),
      message({ id: "child-message", runId: "completed", nodeId: "assistant-child", text: "Subagent output.", updatedAt: "2025-01-03T00:02:00.000Z" }),
    ],
    nodes: [
      {
        id: "root-main", threadId: "thread-1", runId: "completed", parentNodeId: null,
        rootNodeId: "root-main", kind: "root_turn", status: "completed", providerThreadId: "provider-main",
      },
      {
        id: "assistant-commentary", threadId: "thread-1", runId: "completed", parentNodeId: "root-main",
        rootNodeId: "root-main", kind: "assistant_message", status: "completed", providerThreadId: "provider-main",
      },
      {
        id: "assistant-final", threadId: "thread-1", runId: "completed", parentNodeId: "root-main",
        rootNodeId: "root-main", kind: "assistant_message", status: "completed", providerThreadId: "provider-main",
      },
      {
        id: "assistant-foreign", threadId: "thread-1", runId: "completed", parentNodeId: "root-main",
        rootNodeId: "root-main", kind: "assistant_message", status: "completed", providerThreadId: "provider-other",
      },
      {
        id: "subagent-task", threadId: "thread-1", runId: "completed", parentNodeId: "root-main",
        rootNodeId: "root-main", kind: "subagent", status: "completed", providerThreadId: "provider-main",
      },
      {
        id: "assistant-child", threadId: "thread-1", runId: "completed", parentNodeId: "subagent-task",
        rootNodeId: "root-main", kind: "assistant_message", status: "completed", providerThreadId: "provider-main",
      },
    ],
  });

  assert.deepEqual(eligibleRuns(current, Date.parse("2025-01-01T00:00:00.000Z")).map(({ id }) => id), ["completed"]);
  const context = buildContext(current, "completed", project);
  assert.equal(context.finalAnswer, "The actual final.");
  assert.deepEqual(context.messages.map(({ text }) => text), ["What happened?", "A progress update."]);
  assert.notEqual(
    current.messages.find(({ text }) => text === context.finalAnswer)?.id,
    current.messages.find(({ text }) => text === context.finalAnswer)?.nodeId,
  );
});

test("message formatting preserves the thread ID, omits scratch projects, and stays within Telegram limits", () => {
  const fullId = "thread-" + "a".repeat(505);
  const currentThread = thread({ id: fullId, title: `A\nconversation${"x".repeat(220)}` });
  const words = Array.from({ length: 40 }, (_, index) => `w${index}`).join(" ");
  const scratch = {
    ...project,
    title: "Scratch project",
    workspaceRoot: "/Users/example/.t3/scratch/session",
  };

  const text = formatMessage(currentThread, scratch, words);
  assert.ok(text.includes(`Thread: ${fullId}`));
  assert.ok(!text.includes("Project:"));
  assert.ok(!text.includes("\nconversation"));
  assert.equal(text.split(/\s+/u).slice(-1)[0], "w29");
  assert.ok(text.length <= 4_000);
  assert.ok(!formatMessage(currentThread, { ...project, title: " No Project " }, "A short recap").includes("Project:"));
});

test("message formatting counts UTF-16 units without splitting Unicode words", () => {
  const recap = Array.from({ length: 40 }, (_, index) => `${"😀".repeat(80)}${index}`).join(" ");
  const text = formatMessage(thread(), project, recap);
  assert.ok(text.length <= 4_000);
  assert.doesNotMatch(text, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u);
});

test("delivery key is stable for an environment, thread, and run identity", () => {
  const first = deliveryKey("environment", "thread", "run");
  assert.equal(first, deliveryKey("environment", "thread", "run"));
  assert.notEqual(first, deliveryKey("other-environment", "thread", "run"));
  assert.match(first, /^t3-completion-[a-f0-9]{64}$/u);
});

test("Telegram origin comes only from the originating durable MCP message ID", () => {
  const id = "message:mcp:90d829bb-aada-40db-b243-797c00ac8f36:thread-send:telegram-route-135456335";
  const target = run({ userMessageId: id });
  const request = message({ id, role: "user", nodeId: "root-1", text: "A short question" });
  const current = projection({ runs: [target], messages: [request, message()] });
  assert.equal(telegramRouteUpdateId(current, target), 135456335);
  for (const invalid of [
    { ...request, id: "ordinary-message", text: id },
    { ...request, role: "assistant" },
    { ...request, nodeId: "other-root" },
    { ...request, threadId: "other-thread" },
    { ...request, id: id + "-extra" },
    { ...request, id: id.replace("135456335", "9007199254740992") },
  ]) {
    const invalidRun = { ...target, userMessageId: invalid.id };
    assert.equal(telegramRouteUpdateId({ ...current, messages: [invalid] }, invalidRun), null);
  }
});

test("forwarded full answers preserve every character across routable Unicode-safe parts", () => {
  const answer = "  Yes.\n\n" + "Keep this exact answer 😀 é ".repeat(500) + "\nEND  ";
  const current = projection({ messages: [message({ text: answer })] });
  const parts = formatReplyParts(current, current.runs[0]!, project);
  assert.ok(parts.length > 1);
  assert.ok(parts.every((part) => part.length <= 4_000));
  const bodies = parts.map((part) => {
    assert.match(part, /^Chat: A conversation\nProject: A project\nThread: thread-1\n\n/u);
    return part.slice(part.indexOf("\n\n") + 2);
  });
  assert.equal(bodies.join(""), answer);
  for (const part of parts) assert.doesNotMatch(part, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u);
  assert.throws(() => formatReplyParts(projection({ messages: [message({ text: "broken \uD800" })] }), run(), project));
  assert.throws(() => formatReplyParts(projection({ messages: [message({ text: "x".repeat(1_000_001) })] }), run(), project));
});
