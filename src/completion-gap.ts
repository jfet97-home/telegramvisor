import type { CompletionRecoveryOperation } from "./completion-recovery.js";

export type CompletionGapReason = "older_history_not_read" | "incomplete_turn";

export interface CompletionGap {
  id: string;
  threadId: string;
  runId: string | null;
  reason: CompletionGapReason;
  createdAt: number;
  updatedAt: number;
  recovery: CompletionRecoveryOperation | null;
}
