import { createHash } from "node:crypto";
import {
  InputDomainError,
  inputDefinitionHash,
  isEligibleInputThread,
  makeInputId,
  normalizeInputRequest,
} from "./input-domain.js";
import { renderInputCard } from "./input-ui.js";
import type { InputEvent, InputThread, NativeInputRequest, RenderedInputMessage } from "./input-domain.js";
import type {
  InputStoreCapacity,
  InputStoreApi,
  TrackedInputRequest,
} from "./input-store.js";
import type { InputTelegramApi } from "./input-telegram.js";
import type { InputReplyCleanup } from "./input-reply-cleanup.js";

const INPUT_POLL_INTERVAL_MS = 1_000;
const INPUT_DISCOVERY_INTERVAL_MS = 5_000;
const INPUT_REFRESH_AFTER_MS = 24 * 60 * 60 * 1_000;
const INPUT_SEND_INTENT_MAX_AGE_MS = 24 * 60 * 60 * 1_000;
const MAX_THREADS = 10_000;
const MAX_REQUESTS_PER_THREAD = 500;

export interface InputNativeDescriptor {
  readonly environmentId: string;
  readonly currentRouterThreadId?: string | null;
}

export type NativeResponseResult =
  | { readonly kind: "accepted" }
  | { readonly kind: "rejected"; readonly reason?: string }
  | { readonly kind: "unknown"; readonly reason?: string };

/** Native transport interface required by the input coordinator. */
export interface InputNativeClient {
  readonly descriptor: () => Promise<InputNativeDescriptor>;
  readonly listThreads: () => Promise<readonly InputThread[]>;
  readonly listRequests: (threadId: string) => Promise<readonly NativeInputRequest[]>;
  readonly readRequest: (
    threadId: string,
    requestId: string,
    previous?: NativeInputRequest,
  ) => Promise<NativeInputRequest | null>;
  readonly respond: (
    threadId: string,
    requestId: string,
    answers: Readonly<Record<string, string | readonly string[] | null>>,
  ) => Promise<NativeResponseResult>;
}

export interface InputCoordinatorDependencies {
  readonly store: InputStoreApi;
  readonly telegram: InputTelegramApi;
  readonly native: InputNativeClient;
  readonly replyCleanup?: InputReplyCleanup;
  readonly routerOnlyInput?: boolean;
  readonly interactiveThreadId?: string;
  readonly excludedThreadIds?: readonly string[];
  readonly readThreadPolicy?: () => { readonly excludedThreadIds: readonly string[]; readonly interactiveThreadId: string | null };
  readonly now?: () => number;
  readonly pollIntervalMs?: number;
  readonly refreshPresentationOnStart?: boolean;
  readonly onError?: (phase: string) => void;
}

export interface InputCoordinatorStatus {
  readonly lastCycleAt: string | null;
  readonly lastErrorPhase: string | null;
  readonly requests: number;
  readonly messages: number;
  readonly pendingCleanup: number;
  readonly uncertain: number;
  readonly capacity: InputStoreCapacity;
  readonly replyCleanupExpired: number;
}

export interface InputCoordinatorApi {
  readonly runOnce: (forceDiscovery?: boolean) => Promise<void>;
  readonly run: (signal: AbortSignal) => Promise<void>;
  readonly status: () => InputCoordinatorStatus;
}

const stableKey = (prefix: string, ...parts: string[]): string => {
  const digest = createHash("sha256").update(parts.join("\u0000")).digest("hex").slice(0, 40);
  return `${prefix}-${digest}`;
};

const requestKey = (inputId: string, revision: string): string => `${inputId}\u0000${revision}`;

const isValidDescriptor = (value: InputNativeDescriptor): boolean =>
  typeof value.environmentId === "string" && value.environmentId.length > 0 && value.environmentId.length <= 512 &&
  (value.currentRouterThreadId === undefined || value.currentRouterThreadId === null ||
    typeof value.currentRouterThreadId === "string" && value.currentRouterThreadId.length <= 512);

const normalizeThread = (thread: InputThread, currentRouterThreadId: string | null | undefined): InputThread | null => {
  if (!thread || typeof thread.id !== "string" || thread.id.length === 0 || thread.id.length > 512) return null;
  return {
    ...thread,
    currentRouter: thread.currentRouter === true || thread.id === currentRouterThreadId,
  };
};

const responseKind = (result: NativeResponseResult): "accepted" | "rejected" | "unknown" =>
  result.kind === "accepted" || result.kind === "rejected" ? result.kind : "unknown";

const abortableDelay = (durationMs: number, signal: AbortSignal): Promise<void> => new Promise((resolve) => {
  if (signal.aborted) { resolve(); return; }
  const timer = setTimeout(done, durationMs);
  timer.unref();
  function done(): void {
    clearTimeout(timer);
    signal.removeEventListener("abort", done);
    resolve();
  }
  signal.addEventListener("abort", done, { once: true });
});

export const makeInputCoordinator = (dependencies: InputCoordinatorDependencies): InputCoordinatorApi => {
  const now = dependencies.now ?? Date.now;
  const intervalMs = dependencies.pollIntervalMs ?? INPUT_POLL_INTERVAL_MS;
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 100 || intervalMs > 300_000) {
    throw new RangeError("input polling interval is invalid");
  }
  let running: Promise<void> | null = null;
  let phase = "idle";
  let lastCycleAt: string | null = null;
  let lastErrorPhase: string | null = null;
  let cycleHadErrors = false;
  let lastDiscoveryAt: number | null = null;
  let routerThreadId: string | null = dependencies.interactiveThreadId ?? null;
  const excludedThreadIds = (): readonly string[] => dependencies.readThreadPolicy?.().excludedThreadIds ?? dependencies.excludedThreadIds ?? [];
  const isEligibleThread = (thread: InputThread): boolean =>
    isEligibleInputThread(thread) &&
    (thread.id === routerThreadId || !excludedThreadIds().includes(thread.id));
  let refreshPresentationOnStart = dependencies.refreshPresentationOnStart === true;

  const status = (): InputCoordinatorStatus => {
    const input = dependencies.store.stats();
    const replies = dependencies.replyCleanup?.stats();
    return { lastCycleAt, lastErrorPhase, ...input, replyCleanupExpired: replies?.expired ?? 0,
      pendingCleanup: input.pendingCleanup + (replies?.pending ?? 0) + (replies?.unknown ?? 0),
      uncertain: input.uncertain + (replies?.unknown ?? 0),
    };
  };

  const reportError = (errorPhase: string): void => {
    cycleHadErrors = true;
    lastErrorPhase = errorPhase;
    dependencies.onError?.(errorPhase);
  };

  const exactNativeRequest = async (
    threadId: string,
    requestId: string,
    previous?: NativeInputRequest,
  ): Promise<NativeInputRequest | null> => {
    const raw = await dependencies.native.readRequest(threadId, requestId, previous);
    if (raw === null) return null;
    const request = normalizeInputRequest(raw);
    if (request.threadId !== threadId || request.requestId !== requestId) throw new InputDomainError("native request ownership did not match");
    return request;
  };

  const sameRequest = (tracked: TrackedInputRequest, current: NativeInputRequest): boolean =>
    tracked.threadId === current.threadId && tracked.requestId === current.requestId &&
    tracked.requestRevision === current.revisionHash && tracked.definitionHash === inputDefinitionHash(current);

  const syncRequests = async (): Promise<{ environmentId: string; threads: Map<string, InputThread>; seen: Set<string> }> => {
    phase = "native_descriptor";
    const descriptor = await dependencies.native.descriptor();
    if (!isValidDescriptor(descriptor)) throw new InputDomainError("native descriptor is malformed");
    dependencies.store.bindEnvironment(descriptor.environmentId);
    routerThreadId = dependencies.readThreadPolicy ? dependencies.readThreadPolicy().interactiveThreadId : dependencies.interactiveThreadId ?? descriptor.currentRouterThreadId ?? null;

    phase = "native_threads";
    const listedThreads = await dependencies.native.listThreads();
    if (!Array.isArray(listedThreads) || listedThreads.length > MAX_THREADS) throw new InputDomainError("native thread list exceeds its bound");
    const threads = new Map<string, InputThread>();
    for (const rawThread of listedThreads) {
      const thread = normalizeThread(rawThread, routerThreadId);
      if (thread) threads.set(thread.id, thread);
      else reportError("native_thread_invalid");
    }
    const seen = new Set<string>();
    for (const thread of threads.values()) {
      if (!isEligibleThread(thread)) continue;
      phase = "native_requests";
      let requests: readonly NativeInputRequest[];
      try { requests = await dependencies.native.listRequests(thread.id); }
      catch {
        reportError("native_requests");
        continue;
      }
      if (!Array.isArray(requests) || requests.length > MAX_REQUESTS_PER_THREAD) {
        reportError("native_requests");
        continue;
      }
      for (const rawRequest of requests) {
        let request: NativeInputRequest;
        try { request = normalizeInputRequest(rawRequest); }
        catch {
          if (rawRequest && typeof rawRequest === "object" && "requestId" in rawRequest && "revisionHash" in rawRequest &&
            typeof rawRequest.requestId === "string" && typeof rawRequest.revisionHash === "string") {
            const requestThreadId = "threadId" in rawRequest && typeof rawRequest.threadId === "string"
              ? rawRequest.threadId
              : thread.id;
            const inputId = makeInputId(descriptor.environmentId, requestThreadId, rawRequest.requestId);
            if ("terminal" in rawRequest && rawRequest.terminal === true) {
              dependencies.store.setRequestTerminal(inputId, rawRequest.revisionHash, now());
            } else dependencies.store.invalidateRequest(inputId, rawRequest.revisionHash, now());
          }
          reportError("native_request_unsupported");
          continue;
        }
        if (request.threadId !== thread.id || request.requestKind === "approval") {
          const inputId = makeInputId(descriptor.environmentId, request.threadId, request.requestId);
          dependencies.store.invalidateRequest(inputId, request.revisionHash, now());
          continue;
        }
        const inputId = makeInputId(descriptor.environmentId, request.threadId, request.requestId);
        const key = requestKey(inputId, request.revisionHash);
        if (dependencies.store.isTombstoned(inputId, request.revisionHash)) continue;
        seen.add(key);
        const tracked = dependencies.store.getRequest(inputId, request.revisionHash);
        if (request.terminal) {
          if (tracked && sameRequest(tracked, request) && request.terminalState === "resolved") {
            dependencies.replyCleanup?.expedite(inputId, request.revisionHash);
          }
          if (tracked) dependencies.store.setRequestTerminal(inputId, request.revisionHash, now());
          continue;
        }
        if (tracked && tracked.definitionHash !== inputDefinitionHash(request)) {
          dependencies.store.invalidateRequest(inputId, request.revisionHash, now());
          reportError("native_revision_mismatch");
          continue;
        }
        dependencies.store.upsertRequest(descriptor.environmentId, request, now());
      }
    }
    return { environmentId: descriptor.environmentId, threads, seen };
  };

  const reconcileTrackedRequests = async (
    environmentId: string,
    threads: Map<string, InputThread>,
    seen: Set<string>,
  ): Promise<void> => {
    phase = "native_reconcile";
    for (const tracked of dependencies.store.listRequests()) {
      if (tracked.environmentId !== environmentId || tracked.nativeTerminal ||
        seen.has(requestKey(tracked.inputId, tracked.requestRevision))) continue;
      const thread = threads.get(tracked.threadId);
      if (thread && !isEligibleThread(thread)) {
        dependencies.store.invalidateRequest(tracked.inputId, tracked.requestRevision, now());
        continue;
      }
      let current: NativeInputRequest | null;
      try { current = await exactNativeRequest(tracked.threadId, tracked.requestId, tracked.request); }
      catch (cause) {
        if (cause instanceof InputDomainError) {
          dependencies.store.invalidateRequest(tracked.inputId, tracked.requestRevision, now());
        }
        reportError("native_reconcile");
        continue;
      }
      if (!current || current.terminal || !sameRequest(tracked, current) || current.requestKind === "approval") {
        if (current?.terminal) {
          if (sameRequest(tracked, current) && current.terminalState === "resolved") dependencies.replyCleanup?.expedite(tracked.inputId, tracked.requestRevision);
          dependencies.store.setRequestTerminal(tracked.inputId, tracked.requestRevision, now());
        }
        else dependencies.store.invalidateRequest(tracked.inputId, tracked.requestRevision, now());
        continue;
      }
      if (thread && isEligibleThread(thread)) {
        dependencies.store.upsertRequest(environmentId, current, now());
      } else if (!thread) {
        dependencies.store.invalidateRequest(tracked.inputId, tracked.requestRevision, now());
      }
    }
  };

  const processRetirements = async (): Promise<void> => {
    phase = "telegram_retirement";
    for (const tracked of dependencies.store.requestsNeedingRetirement()) {
      if (tracked.submissionState === "accepted") {
        dependencies.replyCleanup?.expedite(tracked.inputId, tracked.requestRevision);
      }
      if (tracked.retirementState === "none") {
        const deliveryKey = stableKey("input-retire", tracked.inputId, tracked.requestRevision);
        if (!dependencies.store.beginRetirement(tracked.inputId, tracked.requestRevision, deliveryKey, now())) continue;
        let result;
        try { result = await dependencies.telegram.retireInputRequest(tracked.inputId, tracked.requestRevision, deliveryKey); }
        catch { result = { kind: "unknown" as const, reason: "transport_error" }; }
        dependencies.store.recordRetirement(
          tracked.inputId,
          tracked.requestRevision,
          result.kind === "done" ? "sent" : "unknown",
          now(),
        );
      } else if ((tracked.retirementState === "unknown" || tracked.retirementState === "intent") && tracked.retirementKey) {
        try {
          const snapshot = await dependencies.telegram.getInputRequest(tracked.inputId, tracked.requestRevision);
          if (!snapshot.active) {
            dependencies.store.recordRetirement(tracked.inputId, tracked.requestRevision, "sent", now());
            continue;
          }
          const result = await dependencies.telegram.retireInputRequest(
            tracked.inputId,
            tracked.requestRevision,
            tracked.retirementKey,
          );
          if (result.kind === "done") {
            dependencies.store.recordRetirement(tracked.inputId, tracked.requestRevision, "sent", now());
          } else {
            dependencies.store.recordRetirement(tracked.inputId, tracked.requestRevision, "unknown", now());
          }
        } catch { reportError("telegram_retirement_reconcile"); }
      }
    }
  };

  const reconcileRequestMessages = async (): Promise<void> => {
    phase = "telegram_send_reconcile";
    for (const tracked of dependencies.store.listRequests()) {
      const messages = dependencies.store.messagesForRequest(tracked.inputId, tracked.requestRevision);
      const interactive = !dependencies.routerOnlyInput || tracked.threadId === routerThreadId;
      const needsSnapshot = interactive && messages.some((message) =>
        message.state === "unknown" && message.cleanupError !== "send_unconfirmed_expired" ||
        message.cleanupState === "waiting") ||
        tracked.retirementState === "intent" || tracked.retirementState === "unknown";
      let snapshot = null;
      if (needsSnapshot) {
        try { snapshot = await dependencies.telegram.getInputRequest(tracked.inputId, tracked.requestRevision); }
        catch { reportError("telegram_input_reconcile"); }
      }
      if (snapshot) {
        const delivered = new Map(snapshot.messages.map((message) => [message.deliveryKey, message]));
        for (const message of messages) {
          const recovered = delivered.get(message.deliveryKey);
          if (recovered && (recovered.messageId !== message.messageId ||
            message.state !== "sent" && (recovered.state === "recovered" || recovered.state === "sent"))) {
            dependencies.store.recordMessagePresented(message.deliveryKey, recovered.messageId, now(), null, null);
          }
        }
        if (!snapshot.active && tracked.lifecycle === "active") {
          dependencies.store.invalidateRequest(tracked.inputId, tracked.requestRevision, now());
        }
        if (!snapshot.active && tracked.retirementKey &&
          (tracked.retirementState === "unknown" || tracked.retirementState === "intent")) {
          dependencies.store.recordRetirement(tracked.inputId, tracked.requestRevision, "sent", now());
        }
      }
      for (const message of messages) {
        if (message.state === "unknown" && message.cleanupError !== "send_unconfirmed_expired" &&
          (message.messageId === null || !interactive)) {
          try {
            const status = await dependencies.telegram.getDeliveryStatus(message.deliveryKey);
            if (status.state === "sent" && status.messageId !== null &&
              (!message.isEdit || status.messageId === message.messageId)) {
              dependencies.store.recordMessagePresented(message.deliveryKey, status.messageId, now(), null, null);
            }
          } catch { reportError("telegram_input_reconcile"); }
        }
        if (message.cleanupState === "unknown" && message.cleanupKey) {
          try {
            const status = await dependencies.telegram.getDeliveryStatus(message.cleanupKey);
            if (status.state === "sent" && status.mutationConfirmed === true) dependencies.store.recordMessageDeleted(message.deliveryKey, now());
            else dependencies.store.expireUnknownDeletion(message.deliveryKey, now());
          } catch { reportError("telegram_input_reconcile"); }
        }
      }
    }
  };

  const sendPreparedMessages = async (): Promise<void> => {
    phase = "telegram_input_send";
    for (const message of dependencies.store.dueMessages(now(), 500)) {
      if (message.state !== "prepared" && message.state !== "rejected") continue;
      const policyRequest = dependencies.store.getRequest(message.inputId, message.requestRevision);
      if (dependencies.routerOnlyInput && policyRequest?.threadId !== routerThreadId &&
        !message.text.startsWith("Input needed in: ")) {
        dependencies.store.abandonPreparedMessage(message.deliveryKey, now());
        continue;
      }
      if (message.state === "prepared" && now() - message.createdAt >= INPUT_SEND_INTENT_MAX_AGE_MS) {
        dependencies.store.abandonPreparedMessage(message.deliveryKey, now());
        continue;
      }
      if (!dependencies.store.beginMessageSend(message.deliveryKey, now())) continue;
      const request = dependencies.store.getRequest(message.inputId, message.requestRevision);
      const rendered: RenderedInputMessage = {
        questionId: message.questionId,
        fragment: message.fragment,
        presentationRevision: message.presentationRevision,
        focusId: message.focusId,
        text: message.text,
        buttons: message.buttons,
      };
      if (!request || request.currentGeneration !== message.generation) {
        dependencies.store.recordMessageUnknown(message.deliveryKey, "render_unavailable", now());
        continue;
      }
      let result;
      try {
        result = dependencies.routerOnlyInput && request.threadId !== routerThreadId
          ? await dependencies.telegram.sendInputNotification(rendered, message.deliveryKey,
            message.isEdit && message.messageId !== null ? message.messageId : undefined)
          : message.isEdit && message.messageId !== null
          ? await dependencies.telegram.editInputMessage(
            message.inputId,
            message.requestRevision,
            message.draftRevision,
            message.messageId,
            rendered,
            message.deliveryKey,
          )
          : await dependencies.telegram.sendInputMessage(
            message.inputId,
            message.requestRevision,
            message.draftRevision,
            rendered,
            message.deliveryKey,
          );
      } catch { result = { kind: "unknown" as const, reason: "transport_error" }; }
      if (result.kind === "sent") {
        dependencies.store.recordMessagePresented(
          message.deliveryKey,
          result.messageId,
          now(),
          message.isEdit ? null : now(),
          message.isEdit ? null : now(),
        );
      }
      else if (result.kind === "rejected") {
        dependencies.store.recordMessageRejected(message.deliveryKey, result.reason, now(), result.retryAfterMs);
        reportError("telegram_input_rejected");
      } else dependencies.store.recordMessageUnknown(message.deliveryKey, result.reason, now());
    }
  };

  const renderActiveRequests = async (): Promise<void> => {
    phase = "telegram_input_render";
    for (const tracked of dependencies.store.listRequests()) {
      try {
        if (tracked.lifecycle !== "active" || tracked.nativeTerminal ||
          tracked.submissionState === "intent" || tracked.submissionState === "accepted") continue;
        const currentMessages = dependencies.store.messagesForRequest(tracked.inputId, tracked.requestRevision)
          .filter((message) => message.generation === tracked.currentGeneration);
        const policyMismatch = dependencies.routerOnlyInput && tracked.threadId !== routerThreadId &&
          currentMessages.some((message) => !message.text.startsWith("Input needed in: "));
        if (policyMismatch) {
          for (const message of currentMessages) {
            if (message.state === "prepared" || message.state === "rejected") dependencies.store.abandonPreparedMessage(message.deliveryKey, now());
          }
        }
        const interactive = !dependencies.routerOnlyInput || tracked.threadId === routerThreadId;
        const agedForRefresh = interactive && currentMessages.some((message) => message.state === "sent" &&
          (refreshPresentationOnStart || now() - (message.sentAt ?? message.createdAt) >= INPUT_REFRESH_AFTER_MS)) || policyMismatch === true;
        const rejected = tracked.submissionState === "rejected" && tracked.submissionDraftRevision === tracked.draftRevision;
        if (tracked.renderedDraftRevision === tracked.draftRevision &&
          tracked.renderedPresentationRevision === tracked.presentationRevision && !agedForRefresh) continue;
        const rendered = dependencies.routerOnlyInput && tracked.threadId !== routerThreadId
          ? { questionId: null, fragment: 0, presentationRevision: tracked.presentationRevision,
            focusId: tracked.presentation.focusId ?? null,
            text: `Input needed in: ${Array.from(tracked.request.displayTitle?.trim().replace(/[\r\n\p{Cc}]/gu, " ") ?? "").slice(0, 128).join("") || "T3 chat"}\nOpen that chat in T3 to answer its pending questions.`,
            buttons: [],
          } satisfies RenderedInputMessage
          : renderInputCard({
          request: tracked.request,
          answers: tracked.answers,
          presentation: tracked.presentation,
          draftRevision: tracked.draftRevision,
          presentationRevision: tracked.presentationRevision,
          submissionRejected: rejected,
          submissionUncertain: tracked.submissionState === "unknown",
        });
        dependencies.store.ensurePresentation(
          tracked.inputId,
          tracked.requestRevision,
          tracked.draftRevision,
          tracked.presentationRevision,
          tracked.presentation,
          rendered,
          now(),
          agedForRefresh,
        );
      } catch {
        reportError("telegram_input_render");
      }
    }
    refreshPresentationOnStart = false;
  };

  const submitEvent = async (eventId: string, tracked: TrackedInputRequest): Promise<void> => {
    if (dependencies.routerOnlyInput && tracked.threadId !== routerThreadId) {
      dependencies.store.completeEvent(eventId);
      return;
    }
    phase = "native_submit_read";
    const current = await exactNativeRequest(tracked.threadId, tracked.requestId, tracked.request);
    if (!current || current.terminal || !sameRequest(tracked, current) || current.requestKind === "approval") {
      if (current?.terminal) {
        if (sameRequest(tracked, current) && current.terminalState === "resolved") dependencies.replyCleanup?.expedite(tracked.inputId, tracked.requestRevision);
        dependencies.store.setRequestTerminal(tracked.inputId, tracked.requestRevision, now());
      }
      else dependencies.store.invalidateRequest(tracked.inputId, tracked.requestRevision, now());
      dependencies.store.completeEvent(eventId);
      return;
    }
    const intent = dependencies.store.prepareSubmission(
      tracked.inputId,
      tracked.requestRevision,
      tracked.draftRevision,
      now(),
    );
    if (!intent) {
      dependencies.store.completeEvent(eventId);
      return;
    }
    phase = "native_submit";
    let result: NativeResponseResult;
    try {
      result = await dependencies.native.respond(intent.threadId, intent.requestId, intent.answers);
    } catch {
      result = { kind: "unknown", reason: "transport_error" };
    }
    const state = responseKind(result);
    dependencies.store.recordSubmission(intent.inputId, intent.requestRevision, state, now());
    if (state === "accepted") dependencies.replyCleanup?.expedite(intent.inputId, intent.requestRevision);
    dependencies.store.completeEvent(eventId);
    if (state === "unknown") reportError("native_submit_unknown");
  };

  const processInbox = async (): Promise<void> => {
    phase = "telegram_input_inbox";
    let events: readonly InputEvent[];
    try { events = await dependencies.telegram.readInputInbox(100); }
    catch {
      reportError("telegram_input_inbox_read");
      return;
    }
    if (events.length === 0) return;
    let eligibleThreads: Set<string>;
    try {
      const listed = await dependencies.native.listThreads();
      if (!Array.isArray(listed) || listed.length > MAX_THREADS) throw new InputDomainError("native thread list exceeds its bound");
      eligibleThreads = new Set(listed.map((thread) => normalizeThread(thread, routerThreadId))
        .filter((thread): thread is InputThread => thread !== null && isEligibleThread(thread)).map((thread) => thread.id));
    } catch {
      reportError("native_event_threads");
      return;
    }
    const acknowledgedIds: string[] = [];
    const checkedRequests = new Map<string, NativeInputRequest | null>();
    for (const event of events) {
      try {
        let tracked = dependencies.store.getRequest(event.inputId, event.requestRevision);
        if (tracked?.lifecycle === "active" && !eligibleThreads.has(tracked.threadId)) {
          dependencies.store.invalidateRequest(tracked.inputId, tracked.requestRevision, now());
          tracked = dependencies.store.getRequest(event.inputId, event.requestRevision);
        }
        if (tracked && tracked.lifecycle === "active" && !tracked.nativeTerminal && event.action !== "stale") {
          phase = "native_event_read";
          let current: NativeInputRequest | null;
          try {
            const key = JSON.stringify([tracked.threadId, tracked.requestId]);
            if (!checkedRequests.has(key) || event.action === "submit") {
              checkedRequests.set(key, await exactNativeRequest(tracked.threadId, tracked.requestId, tracked.request));
            }
            current = checkedRequests.get(key) ?? null;
          }
          catch {
            reportError("native_event_read");
            continue;
          }
          if (!current || current.terminal || !sameRequest(tracked, current) || current.requestKind === "approval") {
            if (current?.terminal) {
              if (sameRequest(tracked, current) && current.terminalState === "resolved") dependencies.replyCleanup?.expedite(tracked.inputId, tracked.requestRevision);
              dependencies.store.setRequestTerminal(tracked.inputId, tracked.requestRevision, now());
            }
            else dependencies.store.invalidateRequest(tracked.inputId, tracked.requestRevision, now());
            tracked = dependencies.store.getRequest(event.inputId, event.requestRevision);
          }
        }
        phase = "input_event_apply";
        const allowInteractive = !dependencies.routerOnlyInput || tracked?.threadId === routerThreadId;
        if (allowInteractive && tracked && dependencies.store.messagesForRequest(event.inputId, event.requestRevision)
          .some((message) => message.messageId === event.messageId)) {
          dependencies.replyCleanup?.track(event, now());
          if (tracked.submissionState === "accepted") {
            dependencies.replyCleanup?.expedite(tracked.inputId, tracked.requestRevision);
          }
        }
        const result = dependencies.store.applyEvent(event, now(), allowInteractive);
        if (result.kind === "submit" && tracked) {
          try { await submitEvent(event.eventId, tracked); }
          catch {
            reportError(phase === "native_submit_read" ? "native_submit_read" : "native_submit_persist");
            continue;
          }
        }
        acknowledgedIds.push(event.eventId);
      } catch {
        reportError(phase === "input_event_apply" ? "input_event_persist" : "input_event_process");
      }
    }
    if (acknowledgedIds.length === 0) return;
    phase = "telegram_input_ack";
    const deliveryKey = stableKey("input-ack", ...[...acknowledgedIds].sort());
    try {
      const acknowledgement = await dependencies.telegram.acknowledgeInputEvents(acknowledgedIds, deliveryKey);
      if (acknowledgement.kind === "done") dependencies.store.acknowledgeEvents(acknowledgedIds, now());
      else reportError("telegram_input_ack_uncertain");
    } catch { reportError("telegram_input_ack"); }
  };

  const deleteObsoleteMessages = async (): Promise<void> => {
    phase = "telegram_input_cleanup";
    for (const message of dependencies.store.dueCleanupMessages(now(), 500)) {
      try {
        if (message.cleanupState === "unknown") {
          if (!message.cleanupKey) continue;
          const status = await dependencies.telegram.getDeliveryStatus(message.cleanupKey);
          if (status.state === "sent" && status.mutationConfirmed === true) dependencies.store.recordMessageDeleted(message.deliveryKey, now());
          else dependencies.store.expireUnknownDeletion(message.deliveryKey, now());
          continue;
        }
        if (message.cleanupState !== "pending" || message.messageId === null || !message.cleanupKey) continue;
        if (!dependencies.store.beginMessageDeletion(message.deliveryKey, now())) continue;
        const result = await dependencies.telegram.deleteMessage(message.messageId, message.cleanupKey);
        if (result.kind === "done") dependencies.store.recordMessageDeleted(message.deliveryKey, now());
        else if (result.kind === "rejected") {
          dependencies.store.recordMessageDeleteRejected(message.deliveryKey, result.reason, now(), result.retryAfterMs);
        } else dependencies.store.recordMessageDeleteUnknown(message.deliveryKey, result.reason, now());
      } catch {
        try { dependencies.store.recordMessageDeleteUnknown(message.deliveryKey, "transport_error", now()); }
        catch { reportError("telegram_input_cleanup_persist"); }
        reportError("telegram_input_cleanup");
      }
    }
  };

  const deleteFinishedReplies = async (): Promise<void> => {
    const cleanup = dependencies.replyCleanup;
    if (!cleanup) return;
    phase = "telegram_input_reply_cleanup";
    for (const reply of cleanup.due(now())) {
      try {
        const tracked = dependencies.store.getRequest(reply.inputId, reply.revision);
        if (!reply.ready && tracked?.submissionState === "accepted") {
          cleanup.expedite(reply.inputId, reply.revision);
          continue;
        }
        if (!reply.ready) {
          if (tracked?.lifecycle !== "active" && (tracked || dependencies.store.isTombstoned(reply.inputId, reply.revision))) {
            cleanup.retain(reply.key);
            continue;
          }
          cleanup.defer(reply.key, now());
          continue;
        }
        if (reply.state === "unknown") {
          const result = await dependencies.telegram.getDeliveryStatus(reply.key);
          if (result.state === "sent" && result.mutationConfirmed === true) cleanup.complete(reply.key);
          else reportError("telegram_input_reply_cleanup_uncertain");
          continue;
        }
        if (now() - reply.createdAt >= 47 * 60 * 60 * 1_000) {
          cleanup.expire(reply.key);
          reportError("telegram_input_reply_cleanup_expired");
          continue;
        }
        if (!cleanup.begin(reply.key)) continue;
        const result = await dependencies.telegram.deleteMessage(reply.messageId, reply.key);
        if (result.kind === "done") cleanup.complete(reply.key);
        else if (result.kind === "rejected") {
          if (result.reason === "message_not_found") { cleanup.complete(reply.key); continue; }
          if (result.reason === "message_cannot_be_deleted") {
            cleanup.unavailable(reply.key);
            reportError("telegram_input_reply_cleanup_expired");
            continue;
          }
          cleanup.rejected(reply.key, now(), result.retryAfterMs);
          reportError("telegram_input_reply_cleanup_rejected");
        } else reportError("telegram_input_reply_cleanup_uncertain");
      } catch { reportError("telegram_input_reply_cleanup"); }
    }
  };

  let lastPolicy: string | null = null;
  const cycle = async (forceDiscovery: boolean): Promise<void> => {
    cycleHadErrors = false;
    if (dependencies.readThreadPolicy) {
      const policy = dependencies.readThreadPolicy();
      const signature = JSON.stringify(policy);
      if (signature !== lastPolicy) forceDiscovery = true;
      lastPolicy = signature;
      routerThreadId = policy.interactiveThreadId;
    }
    const processFirst = !forceDiscovery && lastDiscoveryAt !== null;
    if (processFirst) {
      await processInbox();
      await renderActiveRequests();
      await sendPreparedMessages();
    }
    const discoveryDue = forceDiscovery || lastDiscoveryAt === null || now() - lastDiscoveryAt >= INPUT_DISCOVERY_INTERVAL_MS;
    if (discoveryDue) {
      const { environmentId, threads, seen } = await syncRequests();
      await reconcileTrackedRequests(environmentId, threads, seen);
      lastDiscoveryAt = now();
    }
    await processRetirements();
    await reconcileRequestMessages();
    await renderActiveRequests();
    await sendPreparedMessages();
    if (!processFirst || discoveryDue) await processInbox();
    await renderActiveRequests();
    await sendPreparedMessages();
    await processRetirements();
    await reconcileRequestMessages();
    await deleteObsoleteMessages();
    await deleteFinishedReplies();
    lastCycleAt = new Date(now()).toISOString();
    if (!cycleHadErrors) lastErrorPhase = null;
  };

  const runOnce = (forceDiscovery = true): Promise<void> => {
    if (running) return running;
    running = cycle(forceDiscovery).catch((cause: unknown) => {
      reportError(phase);
      throw cause;
    }).finally(() => { running = null; });
    return running;
  };

  const run = async (signal: AbortSignal): Promise<void> => {
    while (!signal.aborted) {
      try { await runOnce(false); }
      catch { /* errors retain their metadata-only phase for health reporting */ }
      if (!signal.aborted) await abortableDelay(intervalMs, signal);
    }
  };

  return { runOnce, run, status };
};
