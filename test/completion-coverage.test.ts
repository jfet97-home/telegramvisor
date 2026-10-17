import assert from "node:assert/strict";
import test from "node:test";
import { eligibleRuns, telegramRouteUpdateId } from "../src/domain.js";
import {
  classifyCompletionRun,
  summarizeRecentCompletionCoverage,
} from "../src/completion-coverage.js";
import type { MessageInfo, Projection, RunInfo, ThreadInfo } from "../src/types.js";

const thread = (): ThreadInfo => ({
  id: "thread-1",
  title: "A conversation",
  projectId: "project-1",
  lineage: { parentThreadId: null, relationshipToParent: null },
});

const run = (id: string, ordinal: number): RunInfo => ({
  id,
  threadId: "thread-1",
  ordinal,
  status: "completed",
  requestedAt: `2025-01-0${ordinal}T00:00:00.000Z`,
  startedAt: `2025-01-0${ordinal}T00:00:01.000Z`,
  completedAt: `2025-01-0${ordinal}T00:01:00.000Z`,
  rootNodeId: `root-${id}`,
  providerThreadId: `provider-${id}`,
  userMessageId: `request-${id}`,
});

const message = (overrides: Partial<MessageInfo> = {}): MessageInfo => ({
  id: "message-1",
  threadId: "thread-1",
  runId: "run-1",
  nodeId: "answer-run-1",
  role: "assistant",
  text: "The completed answer.",
  streaming: false,
  createdAt: "2025-01-01T00:01:00.000Z",
  updatedAt: "2025-01-01T00:01:00.000Z",
  ...overrides,
});

const projection = (runIds: Array<[string, number]> = [["run-1", 1]]): Projection => {
  const runs = runIds.map(([id, ordinal]) => run(id, ordinal));
  const messages = runs.flatMap((currentRun) => [
    message({
      id: currentRun.userMessageId!,
      runId: currentRun.id,
      nodeId: currentRun.rootNodeId,
      role: "user",
      text: `Request for ${currentRun.id}.`,
      createdAt: currentRun.requestedAt,
      updatedAt: currentRun.requestedAt,
    }),
    message({
      id: `answer-${currentRun.id}`,
      runId: currentRun.id,
      nodeId: `assistant-${currentRun.id}`,
      text: `Answer for ${currentRun.id}.`,
      createdAt: currentRun.completedAt!,
      updatedAt: currentRun.completedAt!,
    }),
  ]);
  const nodes = runs.flatMap((currentRun) => [
    {
      id: currentRun.rootNodeId,
      threadId: "thread-1",
      runId: currentRun.id,
      parentNodeId: null,
      rootNodeId: currentRun.rootNodeId,
      kind: "root_turn",
      status: "completed",
      providerThreadId: currentRun.providerThreadId,
    },
    {
      id: `assistant-${currentRun.id}`,
      threadId: "thread-1",
      runId: currentRun.id,
      parentNodeId: currentRun.rootNodeId,
      rootNodeId: currentRun.rootNodeId,
      kind: "assistant_message",
      status: "completed",
      providerThreadId: currentRun.providerThreadId,
    },
  ]);
  return { thread: thread(), runs, messages, nodes };
};

const subset = (current: Projection, runIds: string[]): Projection => ({
  ...current,
  runs: current.runs.filter((currentRun) => runIds.includes(currentRun.id)),
  messages: current.messages.filter((currentMessage) =>
    typeof currentMessage.runId === "string" && runIds.includes(currentMessage.runId)
  ),
  nodes: (current.nodes as Array<Record<string, unknown>>).filter((node) =>
    typeof node.runId === "string" && runIds.includes(node.runId)
  ),
});

test("complete runs retain the same classification when a recent cohort selects a subset", () => {
  const current = projection([["run-1", 1], ["run-2", 2], ["run-3", 3]]);
  const allRunEvidence = current.runs.map((currentRun) =>
    classifyCompletionRun(current, currentRun.id)
  );

  for (const currentRun of current.runs) {
    const selected = subset(current, [currentRun.id]);
    assert.deepEqual(classifyCompletionRun(selected, currentRun.id),
      allRunEvidence.find((evidence) => evidence.runId === currentRun.id));
  }
});

test("a missing Telegram primary request is incomplete instead of becoming a recap", () => {
  const current = projection();
  const currentRun = current.runs[0]!;
  const telegramMessageId = "message:mcp:90d829bb-aada-40db-b243-797c00ac8f36:thread-send:telegram-route-135456335";
  currentRun.userMessageId = telegramMessageId;
  current.messages = current.messages.filter((currentMessage) => currentMessage.role !== "user");

  assert.equal(telegramRouteUpdateId(current, currentRun), null);
  assert.deepEqual(classifyCompletionRun(current, currentRun.id), {
    state: "incomplete",
    runId: currentRun.id,
    reason: "primary_request_missing",
  });
});

test("foreign and duplicate primary requests fail their run provenance checks", () => {
  const foreign = projection();
  foreign.messages = foreign.messages.map((currentMessage) => currentMessage.role === "user"
    ? { ...currentMessage, runId: "another-run" }
    : currentMessage);
  const foreignEvidence = classifyCompletionRun(foreign, "run-1");
  assert.equal(foreignEvidence.state, "incomplete");
  if (foreignEvidence.state === "incomplete") {
    assert.equal(foreignEvidence.reason, "primary_request_provenance_mismatch");
  }

  const duplicate = projection();
  duplicate.messages.push({ ...duplicate.messages.find((currentMessage) => currentMessage.role === "user")! });
  assert.deepEqual(classifyCompletionRun(duplicate, "run-1"), {
    state: "incomplete",
    runId: "run-1",
    reason: "primary_request_ambiguous",
  });
});

test("missing and foreign roots fail closed before an answer can complete the run", () => {
  const missing = projection();
  missing.nodes = (missing.nodes as Array<Record<string, unknown>>).filter((node) => node.kind !== "root_turn");
  assert.deepEqual(classifyCompletionRun(missing, "run-1"), {
    state: "incomplete",
    runId: "run-1",
    reason: "root_missing",
  });

  const foreign = projection();
  foreign.nodes = (foreign.nodes as Array<Record<string, unknown>>).map((node) =>
    node.kind === "root_turn" ? { ...node, runId: "another-run" } : node
  );
  const foreignEvidence = classifyCompletionRun(foreign, "run-1");
  assert.equal(foreignEvidence.state, "incomplete");
  if (foreignEvidence.state === "incomplete") {
    assert.equal(foreignEvidence.reason, "root_provenance_mismatch");
  }

  const duplicate = projection();
  duplicate.nodes = [
    ...(duplicate.nodes as Array<Record<string, unknown>>),
    (duplicate.nodes as Array<Record<string, unknown>>).find((node) => node.kind === "root_turn")!,
  ];
  assert.deepEqual(classifyCompletionRun(duplicate, "run-1"), {
    state: "incomplete",
    runId: "run-1",
    reason: "root_ambiguous",
  });
});

test("a completed run with a coherent request and root remains settling while its answer is absent", () => {
  const current = projection();
  current.messages = current.messages.filter((currentMessage) => currentMessage.role !== "assistant");
  current.nodes = (current.nodes as Array<Record<string, unknown>>).filter((node) => node.kind !== "assistant_message");

  assert.deepEqual(classifyCompletionRun(current, "run-1"), {
    state: "settling",
    runId: "run-1",
    reason: "final_answer_not_observed",
  });
  const coverage = summarizeRecentCompletionCoverage(current, { hasMoreHistory: false });
  assert.deepEqual(coverage.incompleteRuns, []);
  assert.deepEqual(coverage.settlingRuns, [{ runId: "run-1", reason: "final_answer_not_observed" }]);
});

test("non-completed runs are ignored instead of becoming missing-final gaps", () => {
  const current = projection();
  current.runs[0]!.status = "running";
  current.runs[0]!.completedAt = null;
  current.runs[0]!.userMessageId = null;
  current.messages = [];
  current.nodes = [];

  assert.deepEqual(classifyCompletionRun(current, "run-1"), {
    state: "ignored",
    runId: "run-1",
    reason: "run_not_completed",
  });
  assert.deepEqual(summarizeRecentCompletionCoverage(current).incompleteRuns, []);
  assert.deepEqual(summarizeRecentCompletionCoverage(current).settlingRuns, []);
});

test("completion evidence does not bypass existing run-scoped busy checks", () => {
  const current = projection();
  const activation = Date.parse("2024-12-31T00:00:00.000Z");

  for (const busy of [
    { turnItems: [{ type: "dynamic_tool", status: "running", runId: "run-1" }] },
    { subagents: [{ parentRunId: "run-1", status: "running" }] },
  ]) {
    const busyProjection = { ...current, ...busy } as Projection;
    assert.equal(classifyCompletionRun(busyProjection, "run-1").state, "complete");
    assert.deepEqual(eligibleRuns(busyProjection, activation), []);
  }
});

test("recent coverage reports its oldest anchor without inferring older completion from identity overlap", () => {
  const current = projection([["run-1", 1], ["run-2", 2]]);
  const unverified = summarizeRecentCompletionCoverage(current);
  assert.equal(unverified.status, "recent_only");
  assert.equal(unverified.olderHistory, "limited");
  assert.equal(unverified.historyBoundary, "unverified");
  assert.deepEqual(unverified.oldestObservedRun, {
    runId: "run-1",
    ordinal: 1,
    completedAt: "2025-01-01T00:01:00.000Z",
  });

  const truncated = summarizeRecentCompletionCoverage(current, {
    hasMoreHistory: true,
    historyCursor: "older-page",
  });
  assert.equal(truncated.olderHistory, "limited");
  assert.equal(truncated.historyBoundary, "truncated");

  const completeSelection = summarizeRecentCompletionCoverage(current, {
    hasMoreHistory: false,
    historyCursor: null,
  });
  assert.equal(completeSelection.olderHistory, "complete");
  assert.equal(completeSelection.historyBoundary, "complete");
});
