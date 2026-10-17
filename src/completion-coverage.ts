import {
  mainRunNodeReader,
  nativeUserMessageVisible,
  timestampMs,
} from "./domain.js";
import type { Projection } from "./types.js";

export type CompletionEvidenceIssueReason =
  | "run_missing"
  | "run_ambiguous"
  | "run_thread_mismatch"
  | "primary_request_missing"
  | "primary_request_ambiguous"
  | "primary_request_provenance_mismatch"
  | "root_missing"
  | "root_ambiguous"
  | "root_provenance_mismatch";

export type CompletionRunEvidence =
  | {
      state: "complete";
      runId: string;
      requestMessageId: string;
      rootNodeId: string;
      finalAnswerMessageId: string;
    }
  | {
      state: "settling";
      runId: string;
      reason: "root_not_terminal" | "final_answer_not_observed";
    }
  | {
      state: "incomplete";
      runId: string;
      reason: CompletionEvidenceIssueReason;
    }
  | {
      state: "ignored";
      runId: string;
      reason: "run_not_completed";
    };

export interface CompletionHistoryWindow {
  hasMoreHistory?: unknown;
  historyCursor?: unknown;
}

export interface CompletionRunAnchor {
  runId: string;
  ordinal: number;
  completedAt: string | null;
}

export interface CompletionCoverageIssue {
  runId: string;
  reason: CompletionEvidenceIssueReason;
}

export interface CompletionSettlingRun {
  runId: string;
  reason: "root_not_terminal" | "final_answer_not_observed";
}

export interface RecentCompletionCoverage {
  status: "recent_only";
  olderHistory: "complete" | "limited";
  historyBoundary: "complete" | "truncated" | "unverified";
  oldestObservedRun: CompletionRunAnchor | null;
  incompleteRuns: CompletionCoverageIssue[];
  settlingRuns: CompletionSettlingRun[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const incomplete = (
  runId: string,
  reason: CompletionEvidenceIssueReason,
): CompletionRunEvidence => ({ state: "incomplete", runId, reason });

export const classifyCompletionRun = (
  projection: Projection,
  runId: string,
): CompletionRunEvidence => {
  const matches = projection.runs.filter((run) => run.id === runId);
  if (matches.length === 0) return incomplete(runId, "run_missing");
  if (matches.length > 1) return incomplete(runId, "run_ambiguous");

  const run = matches[0]!;
  if (run.status !== "completed") return { state: "ignored", runId, reason: "run_not_completed" };
  if (run.threadId !== projection.thread.id) return incomplete(runId, "run_thread_mismatch");

  const rootNodeId = typeof run.rootNodeId === "string" && run.rootNodeId.length > 0
    ? run.rootNodeId
    : null;
  if (rootNodeId === null) return incomplete(runId, "root_missing");

  const userMessageId = typeof run.userMessageId === "string" && run.userMessageId.length > 0
    ? run.userMessageId
    : null;
  if (userMessageId === null) return incomplete(runId, "primary_request_missing");

  const requestMatches = projection.messages.filter((message) => message.id === userMessageId);
  if (requestMatches.length === 0) return incomplete(runId, "primary_request_missing");
  if (requestMatches.length > 1) return incomplete(runId, "primary_request_ambiguous");

  const request = requestMatches[0]!;
  if (
    request.role !== "user" ||
    request.threadId !== projection.thread.id ||
    request.runId !== run.id ||
    request.nodeId !== rootNodeId ||
    request.streaming !== false
  ) return incomplete(runId, "primary_request_provenance_mismatch");

  const providerThreadId = typeof run.providerThreadId === "string" ? run.providerThreadId : null;
  const nodeValues = Array.isArray(projection.nodes) ? projection.nodes : [];
  const roots = nodeValues.filter((value) => isRecord(value) && value.id === rootNodeId);
  if (roots.length === 0) return incomplete(runId, "root_missing");
  if (roots.length > 1) return incomplete(runId, "root_ambiguous");

  const root = roots[0];
  if (
    !isRecord(root) ||
    providerThreadId === null ||
    root.kind !== "root_turn" ||
    root.id !== rootNodeId ||
    root.threadId !== projection.thread.id ||
    root.runId !== run.id ||
    root.rootNodeId !== rootNodeId ||
    root.providerThreadId !== providerThreadId ||
    (root.parentNodeId !== null && root.parentNodeId !== undefined)
  ) return incomplete(runId, "root_provenance_mismatch");

  if (root.status !== "completed") return { state: "settling", runId, reason: "root_not_terminal" };

  if (!nativeUserMessageVisible(projection, run, request)) {
    return incomplete(runId, "primary_request_provenance_mismatch");
  }

  const readMainNode = mainRunNodeReader(projection, run);
  const nodeIdCounts = new Map<string, number>();
  for (const value of nodeValues) {
    if (isRecord(value) && typeof value.id === "string") {
      nodeIdCounts.set(value.id, (nodeIdCounts.get(value.id) ?? 0) + 1);
    }
  }
  const hasUnambiguousRootPath = (nodeId: string): boolean => {
    const visited = new Set<string>();
    let currentNodeId = nodeId;
    while (currentNodeId !== rootNodeId) {
      if (visited.has(currentNodeId) || nodeIdCounts.get(currentNodeId) !== 1) return false;
      visited.add(currentNodeId);
      const currentNode = readMainNode(currentNodeId);
      if (!currentNode || typeof currentNode.parentNodeId !== "string") return false;
      currentNodeId = currentNode.parentNodeId;
    }
    return nodeIdCounts.get(rootNodeId) === 1;
  };
  const answers = projection.messages.flatMap((message, index) => {
    if (
      message.role !== "assistant" ||
      message.threadId !== projection.thread.id ||
      message.runId !== run.id ||
      message.streaming === true ||
      typeof message.text !== "string" ||
      message.text.trim() === "" ||
      typeof message.nodeId !== "string"
    ) return [];

    const node = readMainNode(message.nodeId);
    if (!node || !hasUnambiguousRootPath(message.nodeId) || node.kind !== "assistant_message" || node.status !== "completed") return [];
    return [{
      index,
      message,
      updatedAt: timestampMs(message.updatedAt) ?? timestampMs(message.createdAt) ?? -Infinity,
    }];
  });

  if (answers.length === 0) return { state: "settling", runId, reason: "final_answer_not_observed" };

  answers.sort((left, right) => left.updatedAt - right.updatedAt || left.index - right.index);
  return {
    state: "complete",
    runId,
    requestMessageId: request.id,
    rootNodeId,
    finalAnswerMessageId: answers.at(-1)!.message.id,
  };
};

const historyBoundary = (window?: CompletionHistoryWindow): RecentCompletionCoverage["historyBoundary"] => {
  const cursorPresent = window?.historyCursor !== undefined && window.historyCursor !== null;
  if (window?.hasMoreHistory === true || cursorPresent) return "truncated";
  if (window?.hasMoreHistory === false) return "complete";
  return "unverified";
};

const oldestObservedRun = (projection: Projection): CompletionRunAnchor | null => {
  const runs = projection.runs
    .filter((run) => run.threadId === projection.thread.id && Number.isFinite(run.ordinal))
    .sort((left, right) => left.ordinal - right.ordinal);
  const oldest = runs[0];
  return oldest === undefined
    ? null
    : { runId: oldest.id, ordinal: oldest.ordinal, completedAt: oldest.completedAt };
};

export const summarizeRecentCompletionCoverage = (
  projection: Projection,
  window?: CompletionHistoryWindow,
): RecentCompletionCoverage => {
  const historyBoundaryStatus = historyBoundary(window);
  const completedRunIds = [...new Set(projection.runs
    .filter((run) => run.status === "completed")
    .map((run) => run.id))];
  const evidence = completedRunIds.map((runId) => classifyCompletionRun(projection, runId));

  return {
    status: "recent_only",
    olderHistory: historyBoundaryStatus === "complete" ? "complete" : "limited",
    historyBoundary: historyBoundaryStatus,
    oldestObservedRun: oldestObservedRun(projection),
    incompleteRuns: evidence.flatMap((run) => run.state === "incomplete"
      ? [{ runId: run.runId, reason: run.reason }]
      : []),
    settlingRuns: evidence.flatMap((run) => run.state === "settling"
      ? [{ runId: run.runId, reason: run.reason }]
      : []),
  };
};
