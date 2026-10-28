import { Cause, Effect, Option, Schedule } from "effect";
import { createServer } from "node:http";
import { deliveryKey, formatMessage, isMainThread } from "./domain.js";
import { currentRecapSettings } from "./recap-settings.js";
import { RecapError, Recapper } from "./recap.js";
import { Store, StoreError, type StoreShape, type StoreStats } from "./store.js";
import { T3Client, T3TransportError } from "./t3.js";
import { TelegramClient } from "./telegram.js";
import type { TelegramvisorConfig, ThreadInfo } from "./types.js";
import type { InputStoreCapacity } from "./input-store.js";
import { collectRecentCompletions, collectFullCompletions, readCompletionHistory, CompletionWindowReadError } from "./completion-scan.js";
import { isManagedThread } from "./managed-threads.js";

export interface TelegramvisorStatus {
  startedAt: string;
  activation: string | null;
  environmentId: string | null;
  t3Connected: boolean;
  storeState: "starting" | "ready" | "degraded";
  modelState: "disabled" | "idle" | "ready" | "degraded";
  telegramState: "disabled" | "starting" | "ready" | "degraded";
  deliveryState: "disabled" | "idle" | "ready" | "degraded";
  heartbeat: number;
  scanHeartbeat: number;
  deliveryHeartbeat: number;
  deliveryBusySince: number | null;
  model: "gpt-6-luna";
  reasoning: "max";
  lastModelSuccessAt: string | null;
  lastDeliveryAt: string | null;
  lastErrorPhase: string | null;
  inputState: "disabled" | "starting" | "ready" | "degraded";
  inputHeartbeat: number;
  inputRequests: number;
  inputUncertain: number;
  inputBlockingUncertain: number;
  inputRetiredUnconfirmedSends: number;
  inputMessages: number;
  inputPendingCleanup: number;
  inputReplyCleanupExpired: number;
  inputLastErrorPhase: string | null;
  inputCapacity: InputStoreCapacity | null;
  store: StoreStats | null;
}

export const createStatus = (config?: Pick<TelegramvisorConfig, "telegramEnabled" | "recapSettings">): TelegramvisorStatus => ({
  inputReplyCleanupExpired: 0,
  startedAt: new Date().toISOString(), activation: null, environmentId: null,
  t3Connected: false, storeState: "starting",
  modelState: config?.telegramEnabled && config.recapSettings?.get().enabled ? "idle" : "disabled",
  telegramState: config?.telegramEnabled ? "starting" : "disabled",
  deliveryState: config?.telegramEnabled ? "idle" : "disabled",
  heartbeat: Date.now(), scanHeartbeat: Date.now(), deliveryHeartbeat: Date.now(), deliveryBusySince: null,
  model: "gpt-6-luna", reasoning: "max",
  lastModelSuccessAt: null, lastDeliveryAt: null, lastErrorPhase: null, store: null,
  inputState: "disabled", inputHeartbeat: Date.now(), inputRequests: 0, inputUncertain: 0,
  inputMessages: 0, inputPendingCleanup: 0, inputLastErrorPhase: null, inputCapacity: null,
  inputBlockingUncertain: 0, inputRetiredUnconfirmedSends: 0,
});

const log = (event: string, fields: Record<string, string | number | boolean | null> = {}) =>
  Effect.sync(() => console.log(JSON.stringify({ time: new Date().toISOString(), event, ...fields })));

const logRecapAttemptFailure = (jobId: string, cause: Cause.Cause<unknown>) => {
  const error = Option.getOrNull(Cause.findErrorOption(cause));
  if (!(error instanceof RecapError)) return Effect.void;
  const fields: Record<string, string | number | boolean | null> = { jobId, code: error.code };
  if (error.failureClass) fields.failureClass = error.failureClass;
  if (error.exitCode !== undefined) fields.exitCode = error.exitCode;
  if (error.signal) fields.signal = error.signal;
  if (error.spawnErrno) fields.spawnErrno = error.spawnErrno;
  return log("recap_attempt_failed", fields);
};

const guard = <A, E, R>(effect: Effect.Effect<A, E, R>, phase: string, status: TelegramvisorStatus) =>
  effect.pipe(Effect.catchCause((cause) => {
    if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause);
    status.lastErrorPhase = phase;
    if (phase === "maintenance" || phase === "scan" || phase === "delivery") status.storeState = "degraded";
    return log("operation_deferred", { phase }).pipe(Effect.andThen(Effect.sleep("10 seconds")));
  }));

export const readiness = (status: TelegramvisorStatus, config: TelegramvisorConfig, now = Date.now()) => {
  const alive = now - status.heartbeat < 60_000;
  const scanProgress = now - status.scanHeartbeat < 120_000;
  const inputProgress = !config.telegramEnabled || status.inputState === "disabled" ||
    (status.inputState === "ready" && now - status.inputHeartbeat < 120_000);
  const deliveryProgress = !config.telegramEnabled || (status.deliveryBusySince === null
    ? now - status.deliveryHeartbeat < 120_000
    : now - status.deliveryBusySince < config.modelTimeoutMs * 2 + 60_000);
  const notificationsReady = !config.telegramEnabled || (
    status.telegramState === "ready" && status.modelState !== "degraded" &&
    (status.store?.deferredHints ?? 0) === 0
  );
  const ready = alive && scanProgress && deliveryProgress && inputProgress && status.activation !== null &&
    status.t3Connected && status.storeState === "ready" && notificationsReady;
  return { alive, ready, scanProgress, deliveryProgress, inputProgress };
};

const healthServer = (config: TelegramvisorConfig, status: TelegramvisorStatus) => Effect.acquireRelease(
  Effect.tryPromise(() => new Promise<ReturnType<typeof createServer>>((resolve, reject) => {
    const server = createServer((request, response) => {
      if (request.url !== "/health" && request.url !== "/live") {
        response.writeHead(404).end();
        return;
      }
      const health = readiness(status, config);
      const healthy = request.url === "/live" ? health.alive : health.ready;
      response.writeHead(healthy ? 200 : 503, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ ok: healthy, readiness: health, ...status }));
    });
    server.once("error", reject);
    server.listen(config.healthPort, "0.0.0.0", () => resolve(server));
  })),
  (server) => Effect.promise(() => new Promise<void>((resolve) => server.close(() => resolve()))),
);

const settleInterruptedSend = (store: StoreShape, jobId: string) => Effect.gen(function* () {
  const job = yield* store.getJob(jobId);
  if (job?.state === "sending") yield* store.markUnknown(jobId, "interrupted_send", Date.now());
}).pipe(Effect.orElseSucceed(() => undefined));

const checkManagedThread = (config: TelegramvisorConfig, thread: ThreadInfo) => Effect.try({
  try: () => isManagedThread(config, thread),
  catch: (cause) => cause instanceof Error ? cause : new Error("managed_thread_check_failed"),
});

export const refreshTelegramStatus = (status: TelegramvisorStatus) => Effect.gen(function* () {
  const telegram = yield* TelegramClient;
  yield* telegram.getBotInfo();
  status.telegramState = "ready";
}).pipe(Effect.catch(() => Effect.sync(() => {
  status.telegramState = "degraded";
  status.lastErrorPhase = "telegram";
})));

export const runTelegramvisor = (config: TelegramvisorConfig, status: TelegramvisorStatus) => Effect.gen(function* () {
  const store = yield* Store;
  const t3 = yield* T3Client;
  const recapper = config.telegramEnabled ? Option.getOrThrow(yield* Effect.serviceOption(Recapper)) : null;
  const telegram = config.telegramEnabled ? Option.getOrThrow(yield* Effect.serviceOption(TelegramClient)) : null;
  yield* healthServer(config, status);
  if (config.telegramEnabled) yield* store.recoverSending(Date.now());
  yield* log("telegramvisor_started", {
    model: status.model, reasoning: status.reasoning,
    telegramEnabled: config.telegramEnabled === true,
    inputEnabled: config.telegramEnabled === true && config.inputEnabled === true,
  });

  const maintenance = Effect.gen(function* () {
    status.heartbeat = Date.now();
    status.store = yield* store.stats();
    if (status.activation !== null) yield* store.prune(Date.now(), config.telegramEnabled === true);
    status.storeState = "ready";
    if (readiness(status, config).ready) status.lastErrorPhase = null;
    yield* Effect.sleep("30 seconds");
  }).pipe((effect) => guard(effect, "maintenance", status), Effect.forever);
  yield* Effect.forkScoped(maintenance);

  const descriptor = yield* t3.descriptor().pipe(
    Effect.tapError(() => Effect.sync(() => { status.lastErrorPhase = "t3_authentication"; })),
    Effect.retry(Schedule.spaced("10 seconds")),
  );
  const activatedAt = yield* store.activate(descriptor.environmentId, Date.now());
  const notificationsAfter = yield* store.configureTelegram(descriptor.environmentId, config.telegramEnabled === true, Date.now());
  status.environmentId = descriptor.environmentId;
  status.activation = new Date(activatedAt).toISOString();
  const watch = Effect.gen(function* () {
    const cursor = yield* store.cursor("active");
    yield* t3.watch(cursor === 0 ? undefined : cursor, (item) => store.ingest(item).pipe(
      Effect.tap(() => Effect.sync(() => { status.t3Connected = true; })),
    ));
  }).pipe(
    Effect.ensuring(Effect.sync(() => { status.t3Connected = false; })),
    (effect) => guard(effect, "t3_stream", status),
    Effect.forever,
  );

  const nextCompletionRead = new Map<string, number>();
  const oversizedCompletionThreads = new Set<string>();
  const scan = Effect.gen(function* () {
    status.scanHeartbeat = Date.now();
    const hints = yield* store.dueHints(Date.now(), 20);
    for (const hint of hints) {
      yield* Effect.gen(function* () {
        if (!config.telegramEnabled) {
          yield* store.doneHint(hint.threadId, hint.revision);
          return;
        }
        if (hint.shell && typeof hint.shell.lineage?.rootThreadId === "string") {
          if (!isMainThread(hint.shell) || (yield* checkManagedThread(config, hint.shell))) {
            yield* store.doneHint(hint.threadId, hint.revision);
            return;
          }
        }
        const dueAt = nextCompletionRead.get(hint.threadId) ?? 0;
        if (dueAt > Date.now()) {
          yield* store.deferHint(hint.threadId, hint.revision, Date.now(), Math.max(1, dueAt - Date.now()), "settling");
          return;
        }
        const history = yield* readCompletionHistory(t3, hint.threadId, oversizedCompletionThreads);
        const snapshot = history.snapshot;
        if (history.kind === "recent" && history.snapshot.payloadBudgetExceeded) nextCompletionRead.set(hint.threadId, Date.now() + 60_000);
        else nextCompletionRead.delete(hint.threadId);
        if (nextCompletionRead.size > 50_000) nextCompletionRead.delete(nextCompletionRead.keys().next().value!);
        const projection = snapshot.projection;
        if (!isMainThread(projection.thread) ||
          (yield* checkManagedThread(config, projection.thread))) {yield* store.doneHint(hint.threadId, hint.revision);return;}
        const recapSettings = currentRecapSettings(config);
        const recapsAfter = recapSettings.enabled ? recapSettings.enabledAt : Infinity;
        const result = history.kind === "recent"
          ? yield* collectRecentCompletions(store, history.snapshot, descriptor.environmentId, notificationsAfter, Date.now(), recapsAfter)
          : yield* collectFullCompletions(store, history.snapshot, descriptor.environmentId, notificationsAfter, Date.now(), recapsAfter);
        if (result.queued > 0) yield* log("recent_completions_queued", {threadId: hint.threadId, count: result.queued});
        if (result.coverage && (result.coverage.olderHistory === "limited" || result.coverage.incompleteRuns.length > 0))
          yield* log("completion_coverage_limited", {threadId: hint.threadId, incompleteRuns: result.coverage.incompleteRuns.length});
        if (result.settling) yield* store.deferHint(hint.threadId, hint.revision, Date.now(), Math.max(5_000, (nextCompletionRead.get(hint.threadId) ?? 0) - Date.now()), "settling");
        else yield* store.doneHint(hint.threadId, hint.revision);
      }).pipe(Effect.catch((error) => Effect.gen(function* () {
        status.lastErrorPhase = "thread_scan";
        if (error instanceof StoreError) status.storeState = "degraded";
        if (error instanceof T3TransportError && !(error instanceof CompletionWindowReadError) && error.httpStatus === 404) {
          yield* store.doneHint(hint.threadId, hint.revision);
          yield* log("thread_not_found", { threadId: hint.threadId });
        } else {
          yield* store.deferHint(hint.threadId, hint.revision, Date.now(), 60_000);
          yield* log("thread_scan_deferred", { threadId: hint.threadId, responseTooLarge: error instanceof T3TransportError && error.code === "response_too_large" });
        }
      })));
      status.scanHeartbeat = Date.now();
    }
    yield* Effect.sleep("2 seconds");
  }).pipe((effect) => guard(effect, "scan", status), Effect.forever);

  const deliver = Effect.gen(function* () {
    if (!telegram || !recapper) return;
    status.deliveryHeartbeat = Date.now();
    if (!currentRecapSettings(config).enabled) status.modelState = "disabled";
    else if (status.modelState === "disabled") status.modelState = "idle";
    const jobs = yield* store.dueJobs(Date.now(), ["pending", "ready", "unknown"], 10);
    for (const job of jobs) {
      status.deliveryBusySince = Date.now();
      const action = Effect.gen(function* () {
        const isRecap = job.deliveryKey === deliveryKey(job.environmentId, job.threadId, job.runId);
        const settings = currentRecapSettings(config);
        const recapAllowed = () => {
          const current = currentRecapSettings(config);
          return current.enabled && current.generation === settings.generation && job.createdAt >= current.enabledAt;
        };
        if (isRecap && job.state !== "unknown" && !recapAllowed()) {yield* store.skipRecap(job.id, true);return;}
        if (job.state === "pending") {
          if (!job.context) {
            status.modelState = "degraded";
            status.lastErrorPhase = "context_expired";
            yield* store.retry(job.id, "context_expired", Date.now(), 24 * 60 * 60 * 1_000);
            yield* log("recap_context_expired", { jobId: job.id });
            return;
          }
          const recap = yield* recapper.recap(job.context);
          if (!recapAllowed()) {yield* store.skipRecap(job.id, true);return;}
          status.modelState = "ready";
          status.lastModelSuccessAt = new Date().toISOString();
          if (recap === null) {
            if (yield* store.skipRecap(job.id)) yield* log("recap_skipped", { jobId: job.id });
            return;
          }
          const text = yield* Effect.try(() => formatMessage(job.context!.thread, job.context!.project, recap));
          yield* store.setReady(job.id, text, Date.now());
          yield* log("recap_prepared", { jobId: job.id, words: recap.trim().split(/\s+/u).length });
        } else if (job.state === "unknown") {
          const delivery = yield* telegram.getDeliveryStatus(job.deliveryKey);
          if (delivery.state === "sent" && delivery.messageId !== null) {
            yield* store.markSent(job.id, delivery.messageId, Date.now());
            status.deliveryState = "ready";
            status.lastDeliveryAt = new Date().toISOString();
            yield* log("delivery_reconciled", { jobId: job.id, messageId: delivery.messageId });
          } else {
            const lookupSucceeded = delivery.state === "sent" || delivery.state === "sending" || delivery.state === "not_found" ||
              (delivery.state === "unknown" && delivery.reason === "delivery_unknown");
            if (!lookupSucceeded) status.telegramState = "degraded";
            status.deliveryState = "degraded";
            yield* store.markUnknown(job.id, "delivery_unconfirmed", Date.now());
          }
        } else if (job.state === "ready") {
          yield* telegram.getBotInfo();
          status.telegramState = "ready";
          if (isRecap && !recapAllowed()) {yield* store.skipRecap(job.id, true);return;}
          if (job.text === null || !(yield* store.claimSend(job.id, Date.now()))) return;
          yield* Effect.gen(function* () {
            const result = yield* telegram.sendMessage(job.deliveryKey, job.text!);
            if (result.kind === "sent") {
              yield* store.markSent(job.id, result.messageId, Date.now());
              status.lastDeliveryAt = new Date().toISOString();
              status.deliveryState = "ready";
              yield* log("telegram_sent", { jobId: job.id, messageId: result.messageId });
            } else if (result.kind === "rejected") {
              status.telegramState = "degraded";
              status.deliveryState = "degraded";
              yield* store.rejectSend(job.id, result.reason, Date.now());
              yield* log("telegram_rejected", { jobId: job.id, code: result.telegramCode });
            } else {
              status.telegramState = "degraded";
              status.deliveryState = "degraded";
              yield* store.markUnknown(job.id, result.reason, Date.now());
              yield* log("telegram_uncertain", { jobId: job.id });
            }
          }).pipe(Effect.ensuring(settleInterruptedSend(store, job.id)));
        }
      }).pipe(Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause);
        status.lastErrorPhase = "notification";
        if (job.state === "pending") status.modelState = "degraded";
        else { status.telegramState = "degraded"; status.deliveryState = "degraded"; }
        return logRecapAttemptFailure(job.id, cause).pipe(Effect.andThen(store.getJob(job.id).pipe(Effect.flatMap((current) => {
          if (current?.state === "unknown") return store.markUnknown(job.id, "notification_failed", Date.now());
          return store.retry(job.id, "notification_failed", Date.now(), 60_000);
        }), Effect.andThen(log("notification_deferred", { jobId: job.id })))));
      }));
      yield* action;
      status.deliveryHeartbeat = Date.now();
      status.deliveryBusySince = null;
    }
    yield* Effect.sleep("2 seconds");
  }).pipe((effect) => guard(effect, "delivery", status), Effect.forever);

  const checkTelegram = Effect.gen(function* () {
    if (!telegram) return;
    yield* refreshTelegramStatus(status).pipe(Effect.provideService(TelegramClient, telegram));
    yield* Effect.sleep("30 seconds");
  }).pipe(Effect.forever);

  yield* Effect.all(config.telegramEnabled ? [watch, scan, deliver, checkTelegram] : [watch, scan], { concurrency: "unbounded", discard: true });
});
