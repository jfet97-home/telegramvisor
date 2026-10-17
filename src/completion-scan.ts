import { Effect } from "effect";
import { buildContext, eligibleRuns, formatReplyParts, telegramRouteUpdateId, timestampMs } from "./domain.js";
import { classifyCompletionRun, summarizeRecentCompletionCoverage } from "./completion-coverage.js";
import { StoreError, type StoreShape } from "./store.js";
import { T3TransportError, type T3ClientShape, type T3ProjectionSnapshot, type T3BoundedCompletionSnapshot } from "./t3.js";

export class CompletionWindowReadError extends T3TransportError {}

export type CompletionHistory = {kind: "full"; snapshot: T3ProjectionSnapshot} |
  {kind: "recent"; snapshot: T3BoundedCompletionSnapshot};

/** Keeps the complete reader for ordinary chats and remembers oversized chats until restart. */
export const readCompletionHistory = (t3: T3ClientShape, threadId: string, oversized: Set<string>): Effect.Effect<CompletionHistory, T3TransportError> => {
  const recent = () => {
    if (!t3.boundedCompletionProjection) return Effect.fail(new CompletionWindowReadError("T3 recent completion reader is unavailable"));
    return t3.boundedCompletionProjection(threadId).pipe(
      Effect.map(snapshot => ({kind: "recent" as const, snapshot})),
      Effect.mapError(error => new CompletionWindowReadError(error.message, error.httpStatus, error.code)),
    );
  };
  if (oversized.has(threadId)) return recent();
  return t3.projection(threadId).pipe(
    Effect.map(snapshot => ({kind: "full" as const, snapshot}) as CompletionHistory),
    Effect.catch(error => {
      if (error.code !== "response_too_large") return Effect.fail(error);
      oversized.add(threadId);
      if (oversized.size > 50_000) oversized.delete(oversized.values().next().value!);
      return recent();
    }),
  );
};

/** Preserves the original complete-history completion policy. */
export const collectFullCompletions = (
  store: StoreShape, snapshot: T3ProjectionSnapshot, environmentId: string, notificationsAfter: number, now: number,
) => Effect.gen(function* () {
  const projection = snapshot.projection;
  const threadId = projection.thread.id;
  const project = yield* store.project(threadId);
  let queued = 0;
  for (const run of eligibleRuns(projection, notificationsAfter)) {
    if (yield* store.hasIdentity(environmentId, threadId, run.id)) continue;
    const updateId = telegramRouteUpdateId(projection, run);
    const jobId = updateId === null
      ? yield* store.enqueue(environmentId, threadId, run.id, yield* Effect.try(() => buildContext(projection, run.id, project)), now)
      : yield* store.enqueueReply(environmentId, threadId, run.id, yield* Effect.try(() => formatReplyParts(projection, run, project)), now);
    if (jobId) queued += 1;
  }
  let settling = false;
  for (const run of projection.runs) {
    const completedAt = timestampMs(run.completedAt);
    if (run.status === "completed" && completedAt !== null && completedAt > notificationsAfter &&
      !(yield* store.hasIdentity(environmentId, threadId, run.id))) {settling = true;break;}
  }
  return {settling, queued, coverage: null};
});

/** Collects only native completions whose request and result are present in this window. */
export const collectRecentCompletions = (
  store: StoreShape,
  snapshot: T3BoundedCompletionSnapshot,
  environmentId: string,
  notificationsAfter: number,
  now: number,
) => Effect.gen(function* () {
  const projection = snapshot.projection;
  const threadId = projection.thread.id;
  const coverage = summarizeRecentCompletionCoverage(projection, snapshot);
  const project = yield* store.project(threadId);
  const eligible = new Set(eligibleRuns(projection, notificationsAfter).map(run => run.id));
  let settling = false;
  let queued = 0;
  const relevant = projection.runs.filter(run => run.status === "completed" &&
    (timestampMs(run.completedAt) ?? -Infinity) > notificationsAfter);
  if (coverage.olderHistory === "limited" && relevant.length > 0) {
    if (!store.recordCompletionGap) return yield* Effect.fail(new StoreError("completion coverage reporting unavailable"));
    yield* store.recordCompletionGap(threadId, "older_history_not_read", null, now);
  }
  for (const run of relevant) {
    if (yield* store.hasIdentity(environmentId, threadId, run.id)) continue;
    const evidence = classifyCompletionRun(projection, run.id);
    if (evidence.state === "incomplete") {
      if (!store.recordCompletionGap) return yield* Effect.fail(new StoreError("completion coverage reporting unavailable"));
      yield* store.recordCompletionGap(threadId, "incomplete_turn", run.id, now);
      continue;
    }
    if (evidence.state !== "complete" || !eligible.has(run.id)) {
      settling = true;
      continue;
    }
    const updateId = telegramRouteUpdateId(projection, run);
    const jobId = updateId === null
      ? yield* store.enqueue(environmentId, threadId, run.id, yield* Effect.try(() => buildContext(projection, run.id, project)), now)
      : yield* store.enqueueReply(environmentId, threadId, run.id, yield* Effect.try(() => formatReplyParts(projection, run, project)), now);
    if (jobId) queued += 1;
  }
  return {settling, queued, coverage};
});
