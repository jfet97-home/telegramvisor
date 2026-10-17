import { createHash } from "node:crypto";
import type { Projection, ThreadInfo } from "./types.js";

const activeRunStatuses = new Set(["preparing", "queued", "starting", "running", "waiting"]);

export type CompletionRecoveryDispatchMode =
  | {type: "steer_active"; targetRunId: string}
  | {type: "queue_after_active"};

export type CompletionRecoveryOperationState =
  | "dispatching"
  | "accepted"
  | "reconciled"
  | "uncertain"
  | "rejected";

export interface CompletionRecoveryOperation {
  gapId: string;
  threadId: string;
  commandId: string;
  messageId: string;
  text: string;
  dispatchMode: CompletionRecoveryDispatchMode;
  state: CompletionRecoveryOperationState;
  sequence: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface CompletionRecoveryOperations {
  findByGapId(gapId: string): CompletionRecoveryOperation | null | Promise<CompletionRecoveryOperation | null>;
  reserveOnce(operation: CompletionRecoveryOperation): Promise<{operation: CompletionRecoveryOperation; created: boolean}>;
  /** Applies outcomes monotonically; a late native receipt may upgrade uncertainty but cannot downgrade a confirmed result. */
  finish(
    gapId: string,
    commandId: string,
    outcome: {state: Exclude<CompletionRecoveryOperationState, "dispatching">; sequence: number | null; updatedAt: number},
  ): void | Promise<void>;
}

export type CompletionRecoveryResultStatus =
  | "requested"
  | "already_requested"
  | "uncertain"
  | "rejected"
  | "deferred"
  | "unavailable";

export type CompletionRecoveryReason =
  | "native_request_accepted"
  | "operation_already_exists"
  | "operation_visible_in_t3"
  | "delivery_outcome_unknown"
  | "native_request_rejected"
  | "gap_not_actionable"
  | "thread_not_allowed"
  | "target_unavailable"
  | "owner_input_pending"
  | "target_busy";

export interface CompletionRecoveryResult {
  status: CompletionRecoveryResultStatus;
  reason: CompletionRecoveryReason;
  operation: CompletionRecoveryOperation | null;
}

export interface CompletionRecoveryDependencies {
  readProjection(threadId: string, signal: AbortSignal): Promise<Projection>;
  nativeRpc(tag: string, payload: Record<string, unknown>, signal: AbortSignal): Promise<unknown>;
  operations: CompletionRecoveryOperations;
  isGapActionable(gapId: string, threadId: string): boolean | Promise<boolean>;
  isThreadAllowed(threadId: string): boolean | Promise<boolean>;
  now?: () => number;
}

export interface CompletionRecoveryRequest {
  gapId: string;
  threadId: string;
}

export const COMPLETION_RECOVERY_PROMPT =
  "Supervisor recovery follow-up: recent completion coverage for this chat was incomplete. Scope this follow-up only to work already requested in this chat; do not inspect or troubleshoot Supervisor, its dashboard, or other services. Please check the current results and evidence available now, then report what has finished, which checks or tests have actually completed, and what remains or is unresolved. Treat unavailable past run details as unknown: do not reconstruct or invent historical run IDs, timestamps, metadata, or completion evidence. This is a fresh recovery update, not proof of the earlier completion. Do not repeat actions only to prove they happened; continue useful current work only when it remains part of the task, and report that work through the ordinary current-run response.";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const validId = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 512 && !/[\u0000-\u001f\u007f]/u.test(value);

const stableIds = (gapId: string, threadId: string) => {
  const digest = createHash("sha256").update(`${gapId}\0${threadId}`).digest("hex").slice(0, 32);
  return {
    commandId: `supervisor-completion-recovery:${digest}`,
    messageId: `supervisor-notice:completion-recovery:${digest}`,
  };
};

const pendingOwnerInput = (projection: Projection): boolean => {
  if (!Array.isArray(projection.runtimeRequests)) return true;
  const nodes = new Map<string, Record<string, unknown>>();
  if (Array.isArray(projection.nodes)) {
    for (const value of projection.nodes) {
      if (isRecord(value) && typeof value.id === "string") nodes.set(value.id, value);
    }
  }
  const runIds = new Set(projection.runs
    .filter(run => run.threadId === undefined || run.threadId === projection.thread.id)
    .map(run => run.id));
  return projection.runtimeRequests.some(value => {
    if (!isRecord(value)) return true;
    if (value.status !== "pending") return false;
    if (typeof value.nodeId !== "string") return true;
    const node = nodes.get(value.nodeId);
    if (!node) return true;
    if (node.threadId !== projection.thread.id || node.kind === "subagent") return false;
    return typeof node.runId !== "string" || runIds.has(node.runId);
  });
};

const hasRunningProviderTurn = (projection: Projection, run: Projection["runs"][number]): boolean => {
  const activeAttemptId = run.activeAttemptId;
  if (typeof activeAttemptId !== "string" || !Array.isArray(projection.providerTurns)) return false;
  return projection.providerTurns.some(turn => isRecord(turn) && turn.runAttemptId === activeAttemptId &&
    turn.status === "running" && (typeof run.rootNodeId !== "string" || turn.nodeId === run.rootNodeId));
};

const recoveryMode = (projection: Projection): CompletionRecoveryDispatchMode | null => {
  const thread = projection.thread;
  const runs = projection.runs.filter(run => run.threadId === undefined || run.threadId === thread.id);
  const activeRuns = runs.filter(run => activeRunStatuses.has(run.status));
  const reportedRunning = thread.status === "running" || thread.activityRunStatus === "running";
  if (Object.prototype.hasOwnProperty.call(thread, "activeRunId")) {
    const activeRunId = thread.activeRunId;
    if (activeRunId === null) return activeRuns.length === 0 && !reportedRunning ? {type: "queue_after_active"} : null;
    if (typeof activeRunId !== "string") return null;
    if (activeRuns.length !== 1 || activeRuns[0]?.id !== activeRunId) return null;
    const run = activeRuns[0];
    return run?.status === "running" && hasRunningProviderTurn(projection, run)
      ? {type: "steer_active", targetRunId: run.id}
      : null;
  }
  if (activeRuns.length === 0) return reportedRunning ? null : {type: "queue_after_active"};
  if (activeRuns.length !== 1) return null;
  const run = activeRuns[0];
  return run?.status === "running" && hasRunningProviderTurn(projection, run)
    ? {type: "steer_active", targetRunId: run.id}
    : null;
};

const eligibleMainThread = (thread: ThreadInfo, threadId: string): boolean => {
  const lineage = thread.lineage;
  const isOrdinaryMain = lineage?.parentThreadId === null && lineage.relationshipToParent === null;
  const isForkMain = typeof lineage?.parentThreadId === "string" && lineage.relationshipToParent === "fork";
  return thread.id === threadId && !thread.archivedAt && !thread.deletedAt && (isOrdinaryMain || isForkMain);
};

const acceptedSequence = (value: unknown): number | null =>
  isRecord(value) && Number.isSafeInteger(value.sequence) && Number(value.sequence) >= 0
    ? Number(value.sequence)
    : null;

const visibleRecoveryMessage = (projection: Projection, operation: CompletionRecoveryOperation): boolean =>
  projection.thread.id === operation.threadId && projection.messages.some(message =>
    message.id === operation.messageId && message.role === "user" && message.text === operation.text &&
    (typeof message.threadId !== "string" || message.threadId === operation.threadId));

const copyWithOutcome = (
  operation: CompletionRecoveryOperation,
  outcome: {state: Exclude<CompletionRecoveryOperationState, "dispatching">; sequence: number | null; updatedAt: number},
): CompletionRecoveryOperation => ({...operation, ...outcome});

const isDefiniteRejection = (cause: unknown): boolean =>
  cause instanceof Error && "outcome" in cause && cause.outcome === "rejected" &&
  "definiteRejection" in cause && cause.definiteRejection === true;

export class CompletionRecovery {
  private readonly now: () => number;

  constructor(private readonly dependencies: CompletionRecoveryDependencies) {
    this.now = dependencies.now ?? Date.now;
  }

  async request(request: CompletionRecoveryRequest, signal: AbortSignal): Promise<CompletionRecoveryResult> {
    if (!validId(request.gapId) || !validId(request.threadId))
      return {status: "unavailable", reason: "gap_not_actionable", operation: null};

    const existing = await this.dependencies.operations.findByGapId(request.gapId);
    if (existing) {
      if (existing.threadId !== request.threadId)
        return {status: "unavailable", reason: "gap_not_actionable", operation: existing};
      return this.reconcileExisting(existing, signal);
    }

    if (!(await this.allowedGap(request.gapId, request.threadId)))
      return {status: "unavailable", reason: "gap_not_actionable", operation: null};
    if (!(await this.allowedThread(request.threadId)))
      return {status: "unavailable", reason: "thread_not_allowed", operation: null};

    let projection: Projection;
    try {
      projection = await this.dependencies.readProjection(request.threadId, signal);
    } catch {
      return {status: "unavailable", reason: "target_unavailable", operation: null};
    }
    if (signal.aborted || projection.thread.id !== request.threadId || !eligibleMainThread(projection.thread, request.threadId))
      return {status: "unavailable", reason: "target_unavailable", operation: null};
    if (pendingOwnerInput(projection))
      return {status: "deferred", reason: "owner_input_pending", operation: null};
    const dispatchMode = recoveryMode(projection);
    if (!dispatchMode) return {status: "deferred", reason: "target_busy", operation: null};
    if (!(await this.allowedGap(request.gapId, request.threadId)))
      return {status: "unavailable", reason: "gap_not_actionable", operation: null};
    if (!(await this.allowedThread(request.threadId)))
      return {status: "unavailable", reason: "thread_not_allowed", operation: null};

    const createdAt = this.now();
    const ids = stableIds(request.gapId, request.threadId);
    const operation: CompletionRecoveryOperation = {
      gapId: request.gapId,
      threadId: request.threadId,
      ...ids,
      text: COMPLETION_RECOVERY_PROMPT,
      dispatchMode,
      state: "dispatching",
      sequence: null,
      createdAt,
      updatedAt: createdAt,
    };
    const reservation = await this.dependencies.operations.reserveOnce(operation);
    if (!reservation.created) {
      if (reservation.operation.threadId !== request.threadId)
        return {status: "unavailable", reason: "gap_not_actionable", operation: reservation.operation};
      return this.reconcileExisting(reservation.operation, signal);
    }
    if (reservation.operation.gapId !== operation.gapId || reservation.operation.threadId !== operation.threadId ||
      reservation.operation.state !== "dispatching" || reservation.operation.commandId !== operation.commandId ||
      reservation.operation.messageId !== operation.messageId ||
      reservation.operation.text !== operation.text || reservation.operation.dispatchMode.type !== operation.dispatchMode.type ||
      reservation.operation.dispatchMode.type === "steer_active" && operation.dispatchMode.type === "steer_active" &&
        reservation.operation.dispatchMode.targetRunId !== operation.dispatchMode.targetRunId) {
      return {status: "uncertain", reason: "delivery_outcome_unknown", operation: reservation.operation};
    }

    try {
      const receipt = await this.dependencies.nativeRpc("orchestration.dispatchCommand", {
        type: "message.dispatch",
        createdBy: "system",
        creationSource: "server",
        commandId: operation.commandId,
        threadId: operation.threadId,
        messageId: operation.messageId,
        text: operation.text,
        attachments: [],
        dispatchMode: operation.dispatchMode,
      }, signal);
      const sequence = acceptedSequence(receipt);
      if (sequence === null) {
        const outcome = {state: "uncertain" as const, sequence: null, updatedAt: this.now()};
        await this.dependencies.operations.finish(operation.gapId, operation.commandId, outcome);
        return {status: "uncertain", reason: "delivery_outcome_unknown", operation: copyWithOutcome(operation, outcome)};
      }
      const outcome = {state: "accepted" as const, sequence, updatedAt: this.now()};
      await this.dependencies.operations.finish(operation.gapId, operation.commandId, outcome);
      return {status: "requested", reason: "native_request_accepted", operation: copyWithOutcome(operation, outcome)};
    } catch (cause) {
      const rejected = isDefiniteRejection(cause);
      const outcome = {state: rejected ? "rejected" as const : "uncertain" as const, sequence: null, updatedAt: this.now()};
      await this.dependencies.operations.finish(operation.gapId, operation.commandId, outcome);
      return rejected
        ? {status: "rejected", reason: "native_request_rejected", operation: copyWithOutcome(operation, outcome)}
        : {status: "uncertain", reason: "delivery_outcome_unknown", operation: copyWithOutcome(operation, outcome)};
    }
  }

  private async reconcileExisting(operation: CompletionRecoveryOperation, signal: AbortSignal): Promise<CompletionRecoveryResult> {
    if (operation.state === "accepted" || operation.state === "reconciled")
      return {status: "already_requested", reason: "operation_already_exists", operation};
    if (operation.state === "rejected")
      return {status: "rejected", reason: "native_request_rejected", operation};

    let visible = false;
    try {
      const projection = await this.dependencies.readProjection(operation.threadId, signal);
      visible = visibleRecoveryMessage(projection, operation);
    } catch {
      visible = false;
    }
    if (visible) {
      const outcome = {state: "reconciled" as const, sequence: operation.sequence, updatedAt: this.now()};
      await this.dependencies.operations.finish(operation.gapId, operation.commandId, outcome);
      return {status: "already_requested", reason: "operation_visible_in_t3", operation: copyWithOutcome(operation, outcome)};
    }
    if (operation.state === "dispatching") {
      const outcome = {state: "uncertain" as const, sequence: operation.sequence, updatedAt: this.now()};
      await this.dependencies.operations.finish(operation.gapId, operation.commandId, outcome);
      return {status: "uncertain", reason: "delivery_outcome_unknown", operation: copyWithOutcome(operation, outcome)};
    }
    return {status: "uncertain", reason: "delivery_outcome_unknown", operation};
  }

  private async allowedGap(gapId: string, threadId: string): Promise<boolean> {
    try {return await this.dependencies.isGapActionable(gapId, threadId);} catch {return false;}
  }

  private async allowedThread(threadId: string): Promise<boolean> {
    try {return await this.dependencies.isThreadAllowed(threadId);} catch {return false;}
  }
}
