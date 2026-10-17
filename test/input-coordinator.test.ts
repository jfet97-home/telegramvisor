import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { makeInputId, renderInputBatch } from "../src/input-domain.js";
import type { InputEvent, InputThread, NativeInputRequest } from "../src/input-domain.js";
import { makeInputCoordinator } from "../src/input-coordinator.js";
import type { InputNativeClient, NativeResponseResult } from "../src/input-coordinator.js";
import { INPUT_CLEANUP_UNCERTAINTY_TTL_MS, makeInputStore } from "../src/input-store.js";
import { InputReplyCleanup } from "../src/input-reply-cleanup.js";
import { initialInputPresentation, renderInputCard } from "../src/input-ui.js";
import { makeInputTelegramClient } from "../src/input-telegram.js";
import type {
  InputDeliveryStatus,
  InputMutationResult,
  InputRequestSnapshot,
  InputSendResult,
  InputTelegramApi,
} from "../src/input-telegram.js";
import type { RenderedInputMessage } from "../src/input-domain.js";

const makeRequest = (revisionHash = "revision-1", requestId = "request-1"): NativeInputRequest => ({
  threadId: "router-thread",
  requestId,
  revisionHash,
  capability: "question-response",
  displayTitle: "Router chat",
  terminal: false,
  terminalState: null,
  questions: [
    { id: "single", prompt: "Choose one", kind: "single_choice", required: true, allowCustomAnswer: true, choices: [{ value: "a", label: "Alpha" }, { value: "b", label: "Beta" }] },
    { id: "multi", prompt: "Choose all", kind: "multi_choice", required: true, allowCustomAnswer: false, choices: [{ value: "x", label: "X" }, { value: "y", label: "Y" }] },
    { id: "notes", prompt: "Notes", kind: "free_text", required: false, allowCustomAnswer: true, choices: [] },
  ],
});

class FakeNative implements InputNativeClient {
  environmentId = "environment-1";
  currentRouterThreadId: string | null = "router-thread";
  threads: InputThread[] = [
    { id: "router-thread", active: false, kind: "main", currentRouter: true },
    { id: "delegated-thread", active: true, delegated: true, kind: "subagent" },
    { id: "approval-thread", active: true, approvalRequest: true, kind: "main" },
  ];
  requests = new Map<string, NativeInputRequest[]>([["router-thread", [makeRequest()]]]);
  listRequestCalls: string[] = [];
  readCalls: string[] = [];
  readPrevious: Array<NativeInputRequest | undefined> = [];
  failedThreadReads = new Set<string>();
  failedRequestReads = new Set<string>();
  responseResults: NativeResponseResult[] = [{ kind: "accepted" }];
  responseCalls: Array<{ threadId: string; requestId: string; answers: unknown }> = [];

  descriptor = async () => ({ environmentId: this.environmentId, currentRouterThreadId: this.currentRouterThreadId });
  listThreads = async () => this.threads;
  listRequests = async (threadId: string) => {
    this.listRequestCalls.push(threadId);
    if (this.failedThreadReads.has(threadId)) throw new Error("thread unavailable");
    return this.requests.get(threadId) ?? [];
  };
  readRequest = async (threadId: string, requestId: string, previous?: NativeInputRequest) => {
    this.readCalls.push(`${threadId}:${requestId}`);
    this.readPrevious.push(previous);
    if (this.failedRequestReads.has(threadId)) throw new Error("request unavailable");
    return [...(this.requests.get(threadId) ?? [])].find((request) => request.requestId === requestId) ?? null;
  };
  respond = async (threadId: string, requestId: string, answers: Readonly<Record<string, string | readonly string[] | null>>) => {
    this.responseCalls.push({ threadId, requestId, answers });
    return this.responseResults.shift() ?? { kind: "accepted" };
  };
}

interface SentMessage {
  inputId: string;
  requestRevision: string;
  draftRevision: number;
  message: RenderedInputMessage;
  deliveryKey: string;
  messageId: number;
  result: InputSendResult;
}

class FakeTelegram implements InputTelegramApi {
  sendInputNotification = async (message: RenderedInputMessage, deliveryKey: string, messageId?: number): Promise<InputSendResult> => {
    const input = this.notificationRequest!;
    return messageId === undefined
      ? this.sendInputMessage(input.inputId, input.requestRevision, input.draftRevision, message, deliveryKey)
      : this.editInputMessage(input.inputId, input.requestRevision, input.draftRevision, messageId, message, deliveryKey);
  };
  notificationRequest: { inputId: string; requestRevision: string; draftRevision: number } | null = null;
  readonly sends: SentMessage[] = [];
  readonly edits: SentMessage[] = [];
  readonly deletes: Array<{ messageId: number; deliveryKey: string }> = [];
  readonly retirements: Array<{ inputId: string; requestRevision: string; deliveryKey: string }> = [];
  inbox: InputEvent[] = [];
  retainAcknowledged = false;
  nextMessageId = 1_000;
  sendBehavior: ((message: SentMessage) => InputSendResult) | null = null;
  readonly statuses = new Map<string, InputDeliveryStatus>();
  readonly rejectedKeys = new Set<string>();
  readonly retired = new Set<string>();
  deferUnknownMessageRecovery = false;
  forgetUnknownMessages = false;
  loseRetirementAcknowledgment = false;
  deleteBehavior: ((messageId: number, deliveryKey: string) => InputMutationResult) | null = null;
  inputRequestReads = 0;
  deliveryStatusReads: string[] = [];

  sendInputMessage = async (
    inputId: string,
    requestRevision: string,
    draftRevision: number,
    message: RenderedInputMessage,
    deliveryKey: string,
  ): Promise<InputSendResult> => {
    const messageId = this.nextMessageId++;
    const sent: SentMessage = { inputId, requestRevision, draftRevision, message, deliveryKey, messageId, result: { kind: "sent", messageId } };
    this.sends.push(sent);
    const result = this.sendBehavior?.(sent) ?? { kind: "sent" as const, messageId };
    sent.result = result;
    if (result.kind === "sent") this.statuses.set(deliveryKey, { state: "sent", messageId: result.messageId });
    else if (result.kind === "unknown" && !this.rejectedKeys.has(deliveryKey)) {
      this.statuses.set(deliveryKey, this.deferUnknownMessageRecovery
        ? { state: "unknown", reason: "timeout" }
        : { state: "sent", messageId });
    } else this.statuses.set(deliveryKey, { state: "not_found" });
    return result;
  };

  editInputMessage = async (
    inputId: string,
    requestRevision: string,
    draftRevision: number,
    messageId: number,
    message: RenderedInputMessage,
    deliveryKey: string,
  ): Promise<InputSendResult> => {
    const edited: SentMessage = { inputId, requestRevision, draftRevision, message, deliveryKey, messageId, result: { kind: "sent", messageId } };
    this.edits.push(edited);
    const result = this.sendBehavior?.(edited) ?? { kind: "sent" as const, messageId };
    edited.result = result;
    if (result.kind === "sent") this.statuses.set(deliveryKey, { state: "sent", messageId });
    else if (result.kind === "unknown" && !this.rejectedKeys.has(deliveryKey)) {
      this.statuses.set(deliveryKey, this.deferUnknownMessageRecovery
        ? { state: "unknown", reason: "timeout" }
        : { state: "sent", messageId });
    } else this.statuses.set(deliveryKey, { state: "not_found" });
    return result;
  };

  readInputInbox = async (): Promise<readonly InputEvent[]> => this.inbox;
  acknowledgeInputEvents = async (eventIds: readonly string[]): Promise<InputMutationResult> => {
    if (!this.retainAcknowledged) this.inbox = this.inbox.filter((event) => !eventIds.includes(event.eventId));
    return { kind: "done" };
  };
  getInputRequest = async (inputId: string, requestRevision: string): Promise<InputRequestSnapshot> => {
    this.inputRequestReads += 1;
    const key = `${inputId}\u0000${requestRevision}`;
    const matches = [...this.sends, ...this.edits].filter((message) => message.inputId === inputId && message.requestRevision === requestRevision);
    return {
      active: !this.retired.has(key),
      messages: (this.forgetUnknownMessages ? [] : matches.filter((message) => message.result.kind === "sent" ||
        message.result.kind === "unknown" && (!this.deferUnknownMessageRecovery || this.retired.has(key))))
        .map((message) => ({ messageId: message.messageId, deliveryKey: message.deliveryKey })),
      pendingDeliveryKeys: this.forgetUnknownMessages ? [] : matches
        .filter((message) => message.result.kind === "unknown").map((message) => message.deliveryKey),
    };
  };
  retireInputRequest = async (inputId: string, requestRevision: string, deliveryKey: string): Promise<InputMutationResult> => {
    this.retirements.push({ inputId, requestRevision, deliveryKey });
    this.retired.add(`${inputId}\u0000${requestRevision}`);
    return this.loseRetirementAcknowledgment
      ? { kind: "unknown", reason: "mcp_error" }
      : { kind: "done" };
  };
  deleteMessage = async (messageId: number, deliveryKey: string): Promise<InputMutationResult> => {
    this.deletes.push({ messageId, deliveryKey });
    const result = this.deleteBehavior?.(messageId, deliveryKey) ?? { kind: "done" as const };
    if (result.kind !== "unknown") this.statuses.set(deliveryKey, result.kind === "done"
      ? { state: "sent", messageId: null }
      : { state: "not_found" });
    return result;
  };
  getDeliveryStatus = async (deliveryKey: string): Promise<InputDeliveryStatus> => {
    this.deliveryStatusReads.push(deliveryKey);
    return this.statuses.get(deliveryKey) ?? { state: "not_found" };
  };
}

const withHarness = async <A>(
  run: (args: {
    native: FakeNative;
    telegram: FakeTelegram;
    now: () => number;
    advance: (milliseconds: number) => void;
    runOnce: () => Promise<void>;
    status: () => ReturnType<ReturnType<typeof makeInputCoordinator>["status"]>;
    store: ReturnType<typeof makeInputStore>;
  }) => Promise<A>,
  policy: { routerOnlyInput?: boolean; interactiveThreadId?: string; excludedThreadIds?: readonly string[]; readThreadPolicy?: () => { excludedThreadIds: string[]; interactiveThreadId: string | null } } = {},
): Promise<A> => {
  const directory = await mkdtemp(join(tmpdir(), "t3-input-coordinator-"));
  const native = new FakeNative();
  const telegram = new FakeTelegram();
  let clock = 100_000;
  const now = () => clock;
  const advance = (milliseconds: number) => { clock += milliseconds; };
  const store = makeInputStore(directory);
  const replyCleanup = new InputReplyCleanup(directory);
  const coordinator = makeInputCoordinator({ store, replyCleanup, telegram, native, now, pollIntervalMs: 100, ...policy });
  try { return await run({ native, telegram, now, advance, runOnce: coordinator.runOnce, status: coordinator.status, store }); }
  finally {
    store.close();
    replyCleanup.close();
    await rm(directory, { recursive: true, force: true });
  }
};

const allViews = (telegram: FakeTelegram): SentMessage[] => [...telegram.sends, ...telegram.edits];

test("excluded chats do not produce input notices while the explicit router remains interactive", async () => {
  await withHarness(async ({ native, telegram, store, runOnce }) => {
    native.threads.push({ id: "teams-thread", kind: "main", active: true });
    native.requests.set("teams-thread", [{ ...makeRequest(), threadId: "teams-thread" }]);
    await runOnce();
    assert.ok(!native.listRequestCalls.includes("teams-thread"));
    assert.equal(store.getRequest(makeInputId("environment-1", "teams-thread", "request-1"), "revision-1"), null);
    assert.equal(telegram.sends.length, 1);
    assert.equal(telegram.sends[0]!.inputId, makeInputId("environment-1", "router-thread", "request-1"));
    assert.ok(telegram.sends[0]!.message.buttons.length > 0);
  }, { routerOnlyInput: true, interactiveThreadId: "router-thread", excludedThreadIds: ["router-thread", "teams-thread"] });
});

test("saved forms from an excluded chat are retired without answering its native request", async () => {
  await withHarness(async ({ native, telegram, store, now, runOnce }) => {
    const request = { ...makeRequest(), threadId: "teams-thread" };
    native.threads.push({ id: "teams-thread", kind: "main", active: true });
    native.requests.set("teams-thread", [request]);
    const tracked = store.upsertRequest("environment-1", request, now());
    const message = store.ensurePresentation(tracked.inputId, request.revisionHash, 0, 0,
      initialInputPresentation(), renderInputCard({ request, answers: {}, presentation: initialInputPresentation(), draftRevision: 0, presentationRevision: 0 }), now())!;
    store.beginMessageSend(message.deliveryKey, now());
    store.recordMessagePresented(message.deliveryKey, 999, now(), null, null);
    telegram.inbox = [{ eventId: "excluded-submit", updateId: 10, messageId: 999,
      inputId: tracked.inputId, requestRevision: request.revisionHash, draftRevision: 0,
      questionId: null, action: "submit", deliveryKey: message.deliveryKey }];
    await runOnce();
    assert.equal(native.responseCalls.length, 0);
    assert.ok(!native.readCalls.some((call) => call.startsWith("teams-thread:")));
    assert.ok(telegram.deletes.some((deleted) => deleted.messageId === 999));
    assert.equal(telegram.inbox.length, 0);
    assert.notEqual(store.getRequest(tracked.inputId, request.revisionHash)?.lifecycle, "active");
  }, { excludedThreadIds: ["teams-thread"] });
});

test("nonexcluded chats still produce plain input-needed notices", async () => {
  await withHarness(async ({ native, telegram, runOnce }) => {
    native.threads.push({ id: "other-thread", kind: "main", active: true });
    native.requests.set("other-thread", [{ ...makeRequest(), threadId: "other-thread", displayTitle: "Another chat" }]);
    const inputId = makeInputId("environment-1", "other-thread", "request-1");
    telegram.notificationRequest = { inputId, requestRevision: "revision-1", draftRevision: 0 };
    await runOnce();
    const notice = telegram.sends.find((message) => message.inputId === inputId)!;
    assert.match(notice.message.text, /Input needed in: Another chat/u);
    assert.deepEqual(notice.message.buttons, []);
  }, { routerOnlyInput: true, interactiveThreadId: "router-thread", excludedThreadIds: ["router-thread", "teams-thread"] });
});

const currentQuestionMessage = (telegram: FakeTelegram, questionId: string, inputId = makeInputId("environment-1", "router-thread", "request-1"), revision = "revision-1") =>
  allViews(telegram).reverse().find((message) => message.inputId === inputId && message.requestRevision === revision && message.message.questionId === questionId)!;

const currentReviewMessage = (telegram: FakeTelegram, inputId = makeInputId("environment-1", "router-thread", "request-1"), revision = "revision-1") =>
  allViews(telegram).reverse().find((message) => message.inputId === inputId && message.requestRevision === revision && message.message.questionId === null)!;

const callback = (sent: SentMessage, overrides: Partial<InputEvent> = {}): InputEvent => ({
  eventId: "event-1",
  updateId: 1,
  messageId: sent.messageId,
  inputId: sent.inputId,
  requestRevision: sent.requestRevision,
  draftRevision: sent.draftRevision,
  questionId: sent.message.questionId,
  action: "select",
  value: "a",
  deliveryKey: sent.deliveryKey,
  ...(sent.message.presentationRevision === undefined ? {} : { presentationRevision: sent.message.presentationRevision }),
  ...overrides,
});

const submitCallback = (sent: SentMessage, eventId: string, updateId: number): Omit<InputEvent, "value"> => {
  const { value: ignored, ...submit } = callback(sent, {
    eventId,
    updateId,
    questionId: null,
    action: "submit",
  });
  void ignored;
  return submit;
};

const navigate = (sent: SentMessage, value: string, eventId: string, updateId: number): InputEvent => callback(sent, {
  eventId,
  updateId,
  action: "navigate",
  value,
});

const review = (sent: SentMessage, eventId: string, updateId: number): InputEvent => callback(sent, {
  eventId,
  updateId,
  action: "review",
  value: "review:0",
});

const submitAllRequired = async (args: { native: FakeNative; telegram: FakeTelegram; runOnce: () => Promise<void> }): Promise<SentMessage> => {
  let sent = currentQuestionMessage(args.telegram, "single");
  args.telegram.inbox = [callback(sent, { eventId: "choose-single", value: "a" })];
  await args.runOnce();
  sent = currentQuestionMessage(args.telegram, "single");
  args.telegram.inbox = [navigate(sent, "question:1:0", "move-to-multi", 2)];
  await args.runOnce();
  sent = currentQuestionMessage(args.telegram, "multi");
  args.telegram.inbox = [callback(sent, { eventId: "choose-multi", updateId: 3, value: "y" })];
  await args.runOnce();
  sent = currentQuestionMessage(args.telegram, "multi");
  args.telegram.inbox = [review(sent, "open-review", 4)];
  await args.runOnce();
  let finalReview = currentReviewMessage(args.telegram);
  const pages = Number(/page \d+\/(\d+)/u.exec(finalReview.message.text)?.[1] ?? 1);
  for (let page = 1; page < pages; page += 1) {
    args.telegram.inbox = [navigate(finalReview, `review:${page}`, `review-page-${page}`, 4 + page)];
    await args.runOnce();
    finalReview = currentReviewMessage(args.telegram);
  }
  return finalReview;
};

test("fast input cycles process the inbox before discovery and avoid rescanning on every poll", async () => {
  const directory = await mkdtemp(join(tmpdir(), "t3-fast-input-"));
  const native = new FakeNative();
  const telegram = new FakeTelegram();
  const store = makeInputStore(directory);
  const controller = new AbortController();
  const order: string[] = [];
  let clock = 1_000;
  let polls = 0;
  const descriptor = native.descriptor;
  native.descriptor = async () => { order.push("discovery"); return descriptor(); };
  telegram.readInputInbox = async () => {
    polls += 1;
    order.push(`inbox-${polls}`);
    if (polls === 2) clock += 6_000;
    if (polls === 3) controller.abort();
    return [];
  };
  try {
    await makeInputCoordinator({ native, telegram, store, now: () => clock, pollIntervalMs: 100 }).run(controller.signal);
    assert.equal(polls, 3);
    assert.equal(order.filter((item) => item === "discovery").length, 2);
    assert.ok(order.indexOf("inbox-2") < order.lastIndexOf("discovery"));
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("fresh thread eligibility rejects an answer when its chat is archived after discovery", async () => {
  await withHarness(async ({ native, telegram, runOnce, store }) => {
    await runOnce();
    const view = currentQuestionMessage(telegram, "single");
    telegram.readInputInbox = async () => {
      native.threads = [{ id: "router-thread", kind: "main", currentRouter: true, archived: true }];
      return [callback(view, { eventId: "archived-after-scan", updateId: 10, value: "b" })];
    };
    await runOnce();
    assert.equal(store.getRequest(view.inputId, view.requestRevision)?.answers.single, undefined);
    assert.equal(native.responseCalls.length, 0);
  });
});

test("startup refresh updates a confirmed card once without a new message or draft change", async () => {
  await withHarness(async ({ native, telegram, runOnce, store, now }) => {
    await runOnce();
    const first = currentQuestionMessage(telegram, "single");
    const coordinator = makeInputCoordinator({ native, telegram, store, now, refreshPresentationOnStart: true });
    await coordinator.runOnce();
    const updated = currentQuestionMessage(telegram, "single");
    assert.equal(updated.messageId, first.messageId);
    assert.equal(store.getRequest(first.inputId, first.requestRevision)?.draftRevision, 0);
    assert.equal(telegram.edits.length, 1);
    await coordinator.runOnce();
    assert.equal(telegram.edits.length, 1);
    assert.equal(telegram.sends.length, 1);
  });
});

test("current blocked router input is tracked while delegated and approval threads are excluded", async () => {
  await withHarness(async ({ native, telegram, runOnce, store }) => {
    const approval = { ...makeRequest("approval-revision", "approval-request"), requestKind: "approval" as const };
    native.requests.set("router-thread", [makeRequest(), approval]);
    await runOnce();
    assert.deepEqual(native.listRequestCalls, ["router-thread"]);
    assert.equal(telegram.sends.length, 1);
    const tracked = store.listRequests();
    assert.equal(tracked.length, 1);
    assert.equal(tracked[0]?.threadId, "router-thread");
    assert.equal(tracked[0]?.requestId, "request-1");
  });
});

test("batched option callbacks render their coalesced presentation revision", async () => {
  await withHarness(async ({ telegram, runOnce, advance, store }) => {
    await runOnce();
    const initial = currentQuestionMessage(telegram, "single");
    telegram.inbox = [navigate(initial, "question:1:0", "navigate-to-multi", 1)];
    await runOnce();

    const multi = currentQuestionMessage(telegram, "multi");
    const before = store.getRequest(multi.inputId, multi.requestRevision)!;
    telegram.sendBehavior = () => ({ kind: "rejected", reason: "stale_presentation" });
    telegram.inbox = [
      callback(multi, { eventId: "coalesced-select-x", updateId: 2, action: "select", value: "x" }),
      callback(multi, { eventId: "coalesced-select-y", updateId: 3, action: "select", value: "y" }),
    ];
    await runOnce();

    const after = store.getRequest(multi.inputId, multi.requestRevision)!;
    const edited = telegram.edits.at(-1)!;
    assert.deepEqual(after.answers.multi?.value, ["x", "y"]);
    assert.equal(after.presentationRevision, before.presentationRevision + 2);
    assert.equal(edited.message.presentationRevision, after.presentationRevision);
    assert.equal(edited.messageId, multi.messageId);
    const rejected = store.messagesForRequest(multi.inputId, multi.requestRevision)
      .find((message) => message.deliveryKey === edited.deliveryKey)!;
    assert.equal(rejected.state, "rejected");
    assert.equal(rejected.error, "stale_presentation");

    telegram.sendBehavior = null;
    advance(5_001);
    await runOnce();
    assert.equal(store.messagesForRequest(multi.inputId, multi.requestRevision)
      .find((message) => message.deliveryKey === edited.deliveryKey)?.state, "sent");
  });
});

test("a request storage failure leaves healthy input and cleanup progressing", async () => {
  await withHarness(async ({ native, telegram, runOnce, status, store }) => {
    const healthyRequest = makeRequest();
    const poisonRequest = makeRequest("poison-revision", "poison-request");
    native.requests.set("router-thread", [healthyRequest, poisonRequest]);
    const poisonInputId = makeInputId("environment-1", "router-thread", poisonRequest.requestId);
    const ensurePresentation = store.ensurePresentation;
    store.ensurePresentation = (...args) => {
      if (args[0] === poisonInputId) throw new Error("simulated request storage failure");
      return ensurePresentation(...args);
    };

    await runOnce();
    const healthyInputId = makeInputId("environment-1", healthyRequest.threadId, healthyRequest.requestId);
    assert.equal(telegram.sends.filter((message) => message.inputId === healthyInputId).length, 1);
    assert.equal(telegram.sends.some((message) => message.inputId === poisonInputId), false);
    assert.equal(status().lastErrorPhase, "telegram_input_render");

    const healthyCard = currentQuestionMessage(telegram, "single", healthyInputId);
    telegram.inbox = [callback(healthyCard, { eventId: "healthy-answer-with-poison", updateId: 1, value: "b" })];
    await runOnce();

    assert.equal(store.getRequest(healthyInputId, healthyRequest.revisionHash)?.answers.single?.value, "b");
    assert.deepEqual(telegram.inbox, []);
    assert.equal(telegram.deletes.length, 0);
    assert.equal(status().lastErrorPhase, "telegram_input_render");
  });
});

test("one unpersisted answer stays unacknowledged while healthy same-card edits progress", async () => {
  await withHarness(async ({ native, telegram, runOnce, status, store }) => {
    const healthyRequest = makeRequest();
    const failingRequest = makeRequest("failing-revision", "failing-request");
    native.requests.set("router-thread", [healthyRequest, failingRequest]);
    await runOnce();
    const healthyId = makeInputId("environment-1", healthyRequest.threadId, healthyRequest.requestId);
    const failingId = makeInputId("environment-1", failingRequest.threadId, failingRequest.requestId);
    const healthyCard = currentQuestionMessage(telegram, "single", healthyId, healthyRequest.revisionHash);
    const failingCard = currentQuestionMessage(telegram, "single", failingId, failingRequest.revisionHash);
    const applyEvent = store.applyEvent;
    store.applyEvent = (event, timestamp) => {
      if (event.eventId === "unpersisted-answer") throw new Error("simulated answer persistence failure");
      return applyEvent(event, timestamp);
    };
    telegram.inbox = [
      callback(failingCard, { eventId: "unpersisted-answer", updateId: 1, value: "b" }),
      callback(healthyCard, { eventId: "healthy-answer", updateId: 2, value: "b" }),
    ];

    await runOnce();

    assert.equal(store.getRequest(failingId, failingRequest.revisionHash)?.answers.single, undefined);
    assert.equal(store.getRequest(healthyId, healthyRequest.revisionHash)?.answers.single?.value, "b");
    assert.deepEqual(telegram.inbox.map((item) => item.eventId), ["unpersisted-answer"]);
    assert.equal(telegram.deletes.length, 0);
    assert.equal(status().lastErrorPhase, "input_event_persist");

    store.applyEvent = applyEvent;
    await runOnce();
    assert.equal(store.getRequest(failingId, failingRequest.revisionHash)?.answers.single?.value, "b");
    assert.deepEqual(telegram.inbox, []);
  });
});

test("one Telegram card navigates questions, edits, review, and submit without changing its message ID", async () => {
  await withHarness(async ({ native, telegram, runOnce, store }) => {
    await runOnce();
    const finalReview = await submitAllRequired({ native, telegram, runOnce });
    const tracked = store.getRequest(finalReview.inputId, finalReview.requestRevision)!;
    const views = allViews(telegram).filter((view) => view.inputId === finalReview.inputId);
    assert.equal(telegram.sends.filter((view) => view.inputId === finalReview.inputId).length, 1);
    assert.ok(views.length >= 4 && views.length <= 6);
    assert.equal(new Set(views.map((view) => view.messageId)).size, 1);
    assert.equal(tracked.draftRevision, 2);
    assert.equal(tracked.answers.single?.value, "a");
    assert.deepEqual(tracked.answers.multi?.value, ["y"]);
    assert.equal(tracked.presentation.kind, "review");
    telegram.inbox = [submitCallback(finalReview, "submit-reviewed-draft", 99)];
    await runOnce();
    assert.equal(native.responseCalls.length, 1);
    assert.deepEqual(native.responseCalls[0]?.answers, { single: "a", multi: ["y"] });
    assert.equal(telegram.deletes.length, 1);
    assert.equal(telegram.deletes[0]?.messageId, views[0]?.messageId);
  });
});

test("saved prepared and rejected other-chat forms become plain notifications without publishing questions", async () => {
  for (const state of ["prepared", "rejected"] as const) {
    await withHarness(async ({ native, telegram, store, now, runOnce }) => {
      const request = { ...makeRequest(), threadId: "other-thread", displayTitle: "Another chat" };
      native.threads.push({ id: "other-thread", active: true, kind: "main" });
      native.requests.set("other-thread", [request]);
      const tracked = store.upsertRequest("environment-1", request, now());
      telegram.notificationRequest = { inputId: tracked.inputId, requestRevision: request.revisionHash, draftRevision: 0 };
      const old = store.ensurePresentation(tracked.inputId, request.revisionHash, 0, 0, initialInputPresentation(),
        renderInputCard({ request, answers: {}, presentation: initialInputPresentation(), draftRevision: 0, presentationRevision: 0 }), now())!;
      if (state === "rejected") {
        store.beginMessageSend(old.deliveryKey, now());
        store.recordMessageRejected(old.deliveryKey, "rate_limit", now(), 60_000);
      }
      await runOnce();
      const notices = allViews(telegram).filter((message) => message.inputId === tracked.inputId);
      assert.equal(notices.length, 1);
      assert.match(notices[0]!.message.text, /^Input needed in: Another chat/u);
      assert.deepEqual(notices[0]!.message.buttons, []);
      assert.equal(store.messagesForRequest(tracked.inputId, request.revisionHash).find((row) => row.deliveryKey === old.deliveryKey)?.state, "abandoned");
      assert.equal(native.responseCalls.length, 0);
    }, { routerOnlyInput: true, interactiveThreadId: "router-thread" });
  }
});

test("unknown plain notification edits recover through their original generic ledger key", async () => {
  await withHarness(async ({ native, telegram, store, now, runOnce }) => {
    const request = { ...makeRequest(), threadId: "other-thread", displayTitle: "Another chat" };
    native.threads.push({ id: "other-thread", active: true, kind: "main" });
    native.requests.set("other-thread", [request]);
    const inputId = makeInputId("environment-1", "other-thread", "request-1");
    telegram.notificationRequest = { inputId, requestRevision: request.revisionHash, draftRevision: 0 };
    await runOnce();
    const tracked = store.getRequest(inputId, request.revisionHash)!;
    const old = telegram.sends.find((message) => message.inputId === inputId)!;
    const edit = store.ensurePresentation(inputId, request.revisionHash, tracked.draftRevision, tracked.presentationRevision,
      tracked.presentation, { ...old.message, text: "Input needed in: Renamed chat\nOpen it in T3.", buttons: [] }, now(), true)!;
    assert.equal(edit.messageId, old.messageId);
    telegram.sendBehavior = (message) => message.inputId === inputId ? { kind: "unknown", reason: "lost_ack" } : { kind: "sent", messageId: message.messageId };
    await runOnce();
    assert.ok(telegram.deliveryStatusReads.includes(edit.deliveryKey));
    assert.equal(store.messagesForRequest(inputId, request.revisionHash).find((message) => message.deliveryKey === edit.deliveryKey)?.state, "sent");
    assert.equal(telegram.inputRequestReads, 0);
  }, { routerOnlyInput: true, interactiveThreadId: "router-thread" });
});

test("cancelled native input preserves unsubmitted owner replies while resolved input cleans them", async () => {
  for (const terminalState of ["cancelled", "resolved"]) {
    await withHarness(async ({ native, telegram, advance, runOnce }) => {
      await runOnce();
      const question = currentQuestionMessage(telegram, "single");
      telegram.inbox = [callback(question, { action: "answer", text: "unsubmitted text", contributionId: "2001", eventId: "terminal-owner", updateId: 1 })];
      await runOnce();
      native.requests.set("router-thread", [{ ...makeRequest(), terminal: true, terminalState }]);
      advance(6_000);
      await runOnce();
      assert.equal(telegram.deletes.some((row) => row.messageId === 2001), terminalState === "resolved");
    });
  }
});

test("only the configured Telegram chat gets a form while other chats get input notifications", async () => {
  await withHarness(async ({ native, telegram, runOnce }) => {
    native.currentRouterThreadId = null;
    native.threads.push({ id: "other-thread", active: true, kind: "main" });
    native.requests.set("other-thread", [{ ...makeRequest(), threadId: "other-thread", displayTitle: "Another chat" }]);
    telegram.notificationRequest = { inputId: makeInputId("environment-1", "other-thread", "request-1"), requestRevision: "revision-1", draftRevision: 0 };
    await runOnce();
    const notification = telegram.sends.find((message) => message.inputId === makeInputId("environment-1", "other-thread", "request-1"))!;
    assert.match(notification.message.text, /Input needed in: Another chat/u);
    assert.ok(!notification.message.text.includes("Choose one"));
    assert.deepEqual(notification.message.buttons, []);
    assert.equal(notification.message.questionId, null);
    assert.ok(currentQuestionMessage(telegram, "single").message.buttons.length > 0);
    telegram.inbox = [submitCallback(notification, "notification-submit", 1)];
    await runOnce();
    telegram.inbox = [submitCallback(notification, "notification-submit", 1)];
    await runOnce();
    assert.equal(native.responseCalls.length, 0);
    assert.equal(telegram.sends.filter((message) => message.inputId === notification.inputId).length, 1);
    native.requests.set("other-thread", []);
    await runOnce();
    assert.ok(telegram.deletes.some((message) => message.messageId === notification.messageId));
  }, { routerOnlyInput: true, interactiveThreadId: "router-thread" });
});

test("questionnaire reply cleanup waits for acceptance and includes superseded answers", async () => {
  await withHarness(async ({ native, telegram, runOnce }) => {
    const request = makeRequest();
    native.requests.set("router-thread", [{ ...request, questions: request.questions.slice(0, 1) }]);
    await runOnce();
    let question = currentQuestionMessage(telegram, "single");
    telegram.inbox = [callback(question, { action: "answer", text: "first", contributionId: "2001", eventId: "owner-first", updateId: 1 })];
    await runOnce();
    question = currentQuestionMessage(telegram, "single");
    telegram.inbox = [callback(question, { action: "answer", text: "second", contributionId: "2002", eventId: "owner-second", updateId: 2 })];
    await runOnce();
    assert.equal(telegram.deletes.some((item) => item.messageId === 2001 || item.messageId === 2002), false);
    question = currentQuestionMessage(telegram, "single");
    telegram.inbox = [callback(question, { action: "review", value: "review:0", eventId: "owner-review", updateId: 3 })];
    await runOnce();
    const review = currentReviewMessage(telegram);
    telegram.inbox = [submitCallback(review, "owner-submit", 4)];
    await runOnce();
    assert.deepEqual(telegram.deletes.filter((item) => item.messageId > 2000).map((item) => item.messageId), [2001, 2002]);
    await runOnce();
    assert.equal(telegram.deletes.filter((item) => item.messageId > 2000).length, 2);
  });
});

test("direct text replies need no help tap and retain their quoted question after navigation", async () => {
  await withHarness(async ({ telegram, runOnce, store }) => {
    await runOnce();
    const first = currentQuestionMessage(telegram, "single");
    telegram.inbox = [callback(first, { eventId: "direct-first", updateId: 1, action: "answer", text: "own answer", contributionId: "direct-1" })];
    await runOnce();
    let view = currentQuestionMessage(telegram, "single");
    assert.equal(store.getRequest(view.inputId, view.requestRevision)?.answers.single?.value, "own answer");
    telegram.inbox = [navigate(view, "question:2:0", "direct-next", 2)];
    await runOnce();
    const notes = currentQuestionMessage(telegram, "notes");
    telegram.inbox = [callback(notes, { eventId: "direct-notes", updateId: 3, action: "answer", text: "notes without a tap", contributionId: "direct-2" })];
    await runOnce();
    assert.equal(store.getRequest(notes.inputId, notes.requestRevision)?.answers.notes?.value, "notes without a tap");
    telegram.inbox = [callback(first, { eventId: "direct-delayed-first", updateId: 4, action: "answer", text: "delayed first reply", contributionId: "direct-3" })];
    await runOnce();
    assert.equal(store.getRequest(notes.inputId, notes.requestRevision)?.answers.single?.value, "own answer");
    assert.equal(store.getRequest(notes.inputId, notes.requestRevision)?.answers.notes?.value, "notes without a tap");
    view = currentQuestionMessage(telegram, "notes");
    telegram.inbox = [callback(view, { eventId: "direct-clear", updateId: 5, action: "clear" })];
    await runOnce();
    telegram.inbox = [callback(notes, { eventId: "direct-stale-after-clear", updateId: 6, action: "answer", text: "old quoted notes", contributionId: "direct-4" })];
    await runOnce();
    assert.equal(store.getRequest(notes.inputId, notes.requestRevision)?.answers.notes, undefined);
  });
});

test("clearing a text answer resets its focus and a new focus accepts replacement text", async () => {
  await withHarness(async ({ telegram, runOnce, store }) => {
    await runOnce();
    const first = currentQuestionMessage(telegram, "single");
    telegram.inbox = [callback(first, { eventId: "focus-before-clear", updateId: 1, action: "edit_text", focusId: "first-focus" })];
    await runOnce();
    let view = currentQuestionMessage(telegram, "single");
    telegram.inbox = [callback(view, { eventId: "text-before-clear", updateId: 2, action: "answer", text: "original", contributionId: "original-text", focusId: "first-focus", focusPresentationRevision: first.message.presentationRevision! })];
    await runOnce();
    view = currentQuestionMessage(telegram, "single");
    telegram.inbox = [callback(view, { eventId: "clear-text", updateId: 3, action: "clear" })];
    await runOnce();
    view = currentQuestionMessage(telegram, "single");
    assert.equal(view.message.focusId, null);
    assert.equal(store.getRequest(view.inputId, view.requestRevision)?.presentation.focusQuestionId, null);
    assert.match(view.message.text, /Reply to this message|reply to this message/u);
    telegram.inbox = [callback(view, { eventId: "focus-after-clear", updateId: 4, action: "edit_text", focusId: "replacement-focus" })];
    const focusSource = view;
    await runOnce();
    view = currentQuestionMessage(telegram, "single");
    telegram.inbox = [callback(view, { eventId: "replacement-text", updateId: 5, action: "answer", text: "replacement", contributionId: "replacement-text", focusId: "replacement-focus", focusPresentationRevision: focusSource.message.presentationRevision! })];
    await runOnce();
    assert.equal(store.getRequest(view.inputId, view.requestRevision)?.answers.single?.value, "replacement");
  });
});

test("rapid multi-select clicks from one keyboard collect both choices", async () => {
  await withHarness(async ({ telegram, runOnce, store }) => {
    await runOnce();
    const single = currentQuestionMessage(telegram, "single");
    telegram.inbox = [navigate(single, "question:1:0", "move-to-multi", 1)];
    await runOnce();
    const multi = currentQuestionMessage(telegram, "multi");
    telegram.inbox = [
      callback(multi, { eventId: "select-x", updateId: 2, questionId: "multi", value: "x" }),
      callback(multi, { eventId: "select-y", updateId: 3, questionId: "multi", value: "y" }),
    ];
    await runOnce();
    const tracked = store.getRequest(multi.inputId, multi.requestRevision)!;
    assert.equal(tracked.draftRevision, 2);
    assert.deepEqual(tracked.answers.multi?.value, ["x", "y"]);
  });
});

test("navigation clears displayed focus while original quoted replies keep their question", async () => {
  await withHarness(async ({ telegram, runOnce, store }) => {
    await runOnce();
    const initialSingle = currentQuestionMessage(telegram, "single");
    telegram.inbox = [callback(initialSingle, {
      eventId: "focus-single",
      updateId: 1,
      action: "edit_text",
      focusId: "focus-single-id",
    })];
    await runOnce();
    let single = currentQuestionMessage(telegram, "single");
    telegram.inbox = [navigate(single, "question:1:0", "move-to-multi", 2)];
    await runOnce();
    const multi = currentQuestionMessage(telegram, "multi");
    const inputId = multi.inputId;
    const revision = multi.requestRevision;
    assert.equal(store.getRequest(inputId, revision)?.presentation.focusQuestionId, null);
    assert.equal(store.getRequest(inputId, revision)?.presentation.focusId, null);
    assert.equal(multi.message.focusId, null);

    telegram.inbox = [navigate(initialSingle, "question:0:0", "stale-navigation", 3)];
    await runOnce();
    assert.equal(store.getRequest(inputId, revision)?.presentation.questionIndex, 1);

    telegram.inbox = [navigate(multi, "question:2:0", "move-to-notes", 4)];
    await runOnce();
    let notes = currentQuestionMessage(telegram, "notes");
    assert.equal(notes.message.focusId, null);
    telegram.inbox = [callback(notes, {
      eventId: "focus-notes-after-navigation",
      updateId: 5,
      action: "edit_text",
      questionId: "notes",
      focusId: "focus-notes-id",
    })];
    await runOnce();
    notes = currentQuestionMessage(telegram, "notes");
    assert.equal(store.getRequest(inputId, revision)?.presentation.focusQuestionId, "notes");
    assert.equal(store.getRequest(inputId, revision)?.presentation.focusId, "focus-notes-id");
    assert.equal(notes.message.focusId, "focus-notes-id");

    telegram.inbox = [callback(initialSingle, {
      eventId: "late-single-text",
      updateId: 6,
      action: "answer",
      questionId: "single",
      draftRevision: 0,
      text: "late Q1 answer",
      contributionId: "reply-1",
      focusId: "focus-single-id",
      focusPresentationRevision: initialSingle.message.presentationRevision ?? 0,
    })];
    await runOnce();
    let tracked = store.getRequest(inputId, revision)!;
    assert.equal(tracked.answers.single?.value, "late Q1 answer");
    assert.equal(tracked.presentation.questionIndex, 2);
    assert.equal(tracked.presentation.focusQuestionId, "notes");
    assert.equal(tracked.presentation.focusId, "focus-notes-id");
    notes = currentQuestionMessage(telegram, "notes");

    telegram.inbox = [callback(notes, {
      eventId: "edit-original-single-text",
      updateId: 7,
      action: "answer",
      questionId: "single",
      draftRevision: 0,
      text: "edited Q1 answer",
      contributionId: "reply-1",
      edited: true,
      focusId: "focus-single-id",
      focusPresentationRevision: initialSingle.message.presentationRevision ?? 0,
    })];
    await runOnce();
    assert.equal(store.getRequest(inputId, revision)?.answers.single?.value, "edited Q1 answer");

    notes = currentQuestionMessage(telegram, "notes");
    telegram.inbox = [navigate(notes, "question:0:0", "return-to-single", 8)];
    await runOnce();
    single = currentQuestionMessage(telegram, "single");
    const newFocusSource = single;
    telegram.inbox = [callback(single, {
      eventId: "focus-new-single-reply",
      updateId: 9,
      action: "edit_text",
      focusId: "focus-single-id-2",
    })];
    await runOnce();
    single = currentQuestionMessage(telegram, "single");
    telegram.inbox = [callback(single, {
      eventId: "new-single-contribution",
      updateId: 10,
      action: "answer",
      questionId: "single",
      draftRevision: 2,
      text: "new owning answer",
      contributionId: "reply-2",
      focusId: "focus-single-id-2",
      focusPresentationRevision: newFocusSource.message.presentationRevision ?? 0,
    })];
    await runOnce();
    tracked = store.getRequest(inputId, revision)!;
    assert.equal(tracked.answers.single?.value, "new owning answer");
    single = currentQuestionMessage(telegram, "single");
    telegram.inbox = [navigate(single, "question:1:0", "navigate-after-new-reply", 11)];
    await runOnce();
    const multiAfterNewAnswer = currentQuestionMessage(telegram, "multi");
    telegram.inbox = [callback(multiAfterNewAnswer, {
      eventId: "superseded-single-edit",
      updateId: 12,
      action: "answer",
      questionId: "single",
      draftRevision: 0,
      text: "stale old edit",
      contributionId: "reply-1",
      edited: true,
      focusId: "focus-single-id",
      focusPresentationRevision: initialSingle.message.presentationRevision ?? 0,
    })];
    await runOnce();
    assert.equal(store.getRequest(inputId, revision)?.answers.single?.value, "new owning answer");
    assert.equal(new Set(allViews(telegram).filter((view) => view.inputId === inputId).map((view) => view.messageId)).size, 1);
  });
});

test("legacy active cards preserve their draft and collapse to one edited message after migration", async () => {
  const directory = await mkdtemp(join(tmpdir(), "t3-input-legacy-ui-"));
  const native = new FakeNative();
  const telegram = new FakeTelegram();
  const store = makeInputStore(directory);
  try {
    const request = makeRequest();
    const tracked = store.upsertRequest("environment-1", request, 150_000);
    const legacy = store.ensureGeneration(
      tracked.inputId,
      request.revisionHash,
      0,
      renderInputBatch({ request, answers: tracked.answers }),
      150_001,
    )!;
    for (const message of legacy) {
      assert.equal(store.beginMessageSend(message.deliveryKey, 150_002), true);
      assert.equal(store.recordMessageSent(message.deliveryKey, 700 + message.ordinal, 150_003), true);
    }
    const legacySent = store.messagesForRequest(tracked.inputId, request.revisionHash)
      .filter((message) => message.generation === legacy[0]?.generation);
    const oldQuestion = legacySent.find((message) => message.questionId === "single")!;
    const answer = store.applyEvent(callback({
      inputId: tracked.inputId,
      requestRevision: request.revisionHash,
      draftRevision: 0,
      message: { questionId: "single", fragment: 0, text: "", buttons: [] },
      deliveryKey: oldQuestion.deliveryKey,
      messageId: oldQuestion.messageId!,
      result: { kind: "sent", messageId: oldQuestion.messageId! },
    }, { eventId: "legacy-saved-answer", updateId: 1, value: "b" }), 150_003);
    assert.equal(answer.kind, "changed");
    const coordinator = makeInputCoordinator({ store, telegram, native, now: () => 150_004 });
    await coordinator.runOnce();
    const current = store.getRequest(tracked.inputId, request.revisionHash)!;
    const currentMessages = store.messagesForRequest(tracked.inputId, request.revisionHash)
      .filter((message) => message.generation === current.currentGeneration);
    assert.equal(current.answers.single?.value, "b");
    assert.equal(currentMessages.length, 1);
    assert.equal(telegram.sends.length, 0);
    assert.equal(telegram.edits.length, 1);
    assert.equal(telegram.edits[0]?.messageId, oldQuestion.messageId);
    assert.ok(new Set(telegram.deletes.map((item) => item.messageId)).size <= 2);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("out-of-order operations from one question cannot replace its newer answer", async () => {
  await withHarness(async ({ telegram, runOnce, store }) => {
    await runOnce();
    const single = currentQuestionMessage(telegram, "single");
    telegram.inbox = [
      callback(single, { eventId: "newer-choice", updateId: 10, value: "b" }),
      callback(single, { eventId: "older-choice", updateId: 9, value: "a" }),
    ];
    await runOnce();
    const tracked = store.getRequest(single.inputId, single.requestRevision)!;
    assert.equal(tracked.draftRevision, 1);
    assert.equal(tracked.answers.single?.value, "b");
  });
});

test("an inaccessible thread degrades health without blocking other request delivery", async () => {
  await withHarness(async ({ native, telegram, runOnce, status }) => {
    native.threads.push({ id: "unavailable-thread", active: true, kind: "main" });
    native.failedThreadReads.add("unavailable-thread");
    await runOnce();
    assert.equal(telegram.sends.length, 1);
    assert.equal(status().lastErrorPhase, "native_requests");
    await runOnce();
    assert.equal(status().lastErrorPhase, "native_requests");
    native.failedThreadReads.clear();
    await runOnce();
    assert.equal(status().lastErrorPhase, null);
  });
});

test("an inaccessible request event stays pending while another thread answer is processed", async () => {
  await withHarness(async ({ native, telegram, runOnce, status, store }) => {
    const inaccessibleRequest: NativeInputRequest = {
      ...makeRequest("inaccessible-revision", "inaccessible-request"),
      threadId: "inaccessible-thread",
    };
    native.threads.push({ id: "inaccessible-thread", active: true, kind: "main" });
    native.requests.set("inaccessible-thread", [inaccessibleRequest]);
    await runOnce();
    const inaccessibleId = makeInputId("environment-1", "inaccessible-thread", "inaccessible-request");
    const blockedMessage = currentQuestionMessage(telegram, "single", inaccessibleId, "inaccessible-revision");
    const availableMessage = currentQuestionMessage(telegram, "single");
    native.failedRequestReads.add("inaccessible-thread");
    telegram.inbox = [
      callback(blockedMessage, { eventId: "blocked-question", updateId: 1, value: "b" }),
      callback(availableMessage, { eventId: "available-question", updateId: 2, value: "b" }),
    ];
    await runOnce();
    assert.equal(store.getRequest(availableMessage.inputId, availableMessage.requestRevision)?.answers.single?.value, "b");
    assert.deepEqual(telegram.inbox.map((item) => item.eventId), ["blocked-question"]);
    assert.equal(status().lastErrorPhase, "native_event_read");
    native.failedRequestReads.clear();
    await runOnce();
    assert.equal(store.getRequest(inaccessibleId, "inaccessible-revision")?.answers.single?.value, "b");
    assert.deepEqual(telegram.inbox, []);
    assert.equal(status().lastErrorPhase, null);
  });
});

test("an accepted native response retires Telegram controls but remains pending until T3 becomes terminal", async () => {
  await withHarness(async ({ native, telegram, runOnce, store }) => {
    await runOnce();
    const submit = await submitAllRequired({ native, telegram, runOnce });
    telegram.inbox = [submitCallback(submit, "submit-batch", 3)];
    await runOnce();
    const inputId = submit.inputId;
    const tracked = store.getRequest(inputId, "revision-1")!;
    assert.equal(native.responseCalls.length, 1);
    assert.deepEqual(native.responseCalls[0]?.answers, { single: "a", multi: ["y"] });
    assert.equal(tracked.submissionState, "accepted");
    assert.equal(tracked.nativeTerminal, false);
    assert.equal(tracked.lifecycle, "retired");
    await runOnce();
    assert.equal(native.responseCalls.length, 1);
    native.requests.set("router-thread", [
      { ...makeRequest(), terminal: true, terminalState: "resolved" },
    ]);
    await runOnce();
    assert.equal(store.isTombstoned(inputId, "revision-1"), true);
    assert.ok(telegram.retirements.length >= 1);
  });
});

test("a lost send acknowledgement is recovered after native termination and cleaned exactly once", async () => {
  await withHarness(async ({ native, telegram, runOnce, store, status }) => {
    let first = true;
    telegram.deferUnknownMessageRecovery = true;
    telegram.sendBehavior = (message) => {
      if (first) { first = false; return { kind: "unknown", reason: "timeout" }; }
      return { kind: "sent", messageId: message.messageId };
    };
    await runOnce();
    assert.equal(store.stats().uncertain, 1);
    assert.equal(status().uncertain, 1);
    native.requests.set("router-thread", [{ ...makeRequest(), terminal: true, terminalState: "cancelled" }]);
    await runOnce();
    assert.equal(telegram.retirements.length, 1);
    assert.equal(telegram.sends.length, 1);
    assert.equal(telegram.deletes.length, 1);
    assert.equal(new Set(telegram.deletes.map((item) => item.messageId)).size, 1);
    assert.equal(store.stats().pendingCleanup, 0);
    assert.ok(telegram.inputRequestReads > 0);
  });
});

test("aged retired unknown sends stay unconfirmed and stop blocking readiness without replay", async () => {
  await withHarness(async ({ native, telegram, runOnce, advance, store, status }) => {
    telegram.deferUnknownMessageRecovery = true;
    telegram.sendBehavior = () => ({ kind: "unknown", reason: "invalid_response" });
    await runOnce();
    const tracked = store.listRequests()[0]!;
    const original = store.messagesForRequest(tracked.inputId, tracked.requestRevision)
      .find((message) => message.state === "unknown")!;
    assert.equal(status().uncertain, 1);
    assert.equal(original.messageId, null);

    native.requests.set("router-thread", [{ ...makeRequest(), terminal: true, terminalState: "cancelled" }]);
    telegram.forgetUnknownMessages = true;
    telegram.statuses.set(original.deliveryKey, { state: "not_found" });
    await runOnce();
    assert.equal(store.getRequest(tracked.inputId, tracked.requestRevision)?.retirementState, "sent");
    assert.equal(status().uncertain, 1);

    advance(INPUT_CLEANUP_UNCERTAINTY_TTL_MS - 1);
    await runOnce();
    assert.equal(store.messagesForRequest(tracked.inputId, tracked.requestRevision)
      .find((message) => message.deliveryKey === original.deliveryKey)?.cleanupState, "waiting");
    assert.equal(status().uncertain, 1);

    advance(2);
    await runOnce();
    const expired = store.messagesForRequest(tracked.inputId, tracked.requestRevision)
      .find((message) => message.deliveryKey === original.deliveryKey)!;
    assert.equal(expired.state, "unknown");
    assert.equal(expired.error, "invalid_response");
    assert.equal(expired.messageId, null);
    assert.equal(expired.deliveryKey, original.deliveryKey);
    assert.equal(expired.cleanupState, "expired");
    assert.equal(expired.cleanupError, "send_unconfirmed_expired");
    assert.equal(status().uncertain, 0);
    assert.equal(telegram.sends.length, 1);
    assert.equal(telegram.deletes.length, 0);

    const requestReads = telegram.inputRequestReads;
    const deliveryReads = telegram.deliveryStatusReads.length;
    await runOnce();
    assert.equal(telegram.inputRequestReads, requestReads);
    assert.equal(telegram.deliveryStatusReads.length, deliveryReads);
    assert.equal(telegram.sends.length, 1);
  });
});

test("a lost send fragment is carried under its original key while confirmed cards refresh", async () => {
  await withHarness(async ({ native, telegram, advance, runOnce, store }) => {
    telegram.deferUnknownMessageRecovery = true;
    let first = true;
    telegram.sendBehavior = (message) => {
      if (first) { first = false; return { kind: "unknown", reason: "timeout" }; }
      return { kind: "sent", messageId: message.messageId };
    };
    await runOnce();
    const inputId = makeInputId("environment-1", "router-thread", "request-1");
    const originalUnknown = store.messagesForRequest(inputId, "revision-1").find((message) => message.state === "unknown")!;
    const initialKeys = telegram.sends.map((message) => message.deliveryKey);
    advance(24 * 60 * 60 * 1_000 + 1);
    await runOnce();
    const tracked = store.getRequest(inputId, "revision-1")!;
    const refreshed = store.messagesForRequest(inputId, "revision-1")
      .filter((message) => message.generation === tracked.currentGeneration);
    const carried = refreshed.find((message) => message.ordinal === originalUnknown.ordinal)!;
    assert.equal(carried.deliveryKey, originalUnknown.deliveryKey);
    assert.equal(carried.text, originalUnknown.text);
    assert.equal(carried.state, "unknown");
    assert.equal(telegram.sends.filter((message) => message.deliveryKey === originalUnknown.deliveryKey).length, 1);
    assert.equal(telegram.sends.length, initialKeys.length);
    assert.equal(telegram.edits.length, 0);
    assert.equal(telegram.deletes.length, 0);
    assert.ok(telegram.deletes.every((item) => !initialKeys.includes(item.deliveryKey)));
    const possibleLateMessageId = telegram.sends.find((message) => message.deliveryKey === originalUnknown.deliveryKey)?.messageId;

    native.requests.set("router-thread", [{ ...makeRequest(), terminal: true, terminalState: "cancelled" }]);
    await runOnce();
    assert.ok(telegram.deletes.some((item) => item.messageId === possibleLateMessageId));
    assert.equal(store.stats().pendingCleanup, 0);
  });
});

test("duplicate callbacks are idempotent and stale submit controls cannot submit a changed draft", async () => {
  await withHarness(async ({ native, telegram, runOnce, store }) => {
    await runOnce();
    const oldSingle = currentQuestionMessage(telegram, "single");
    telegram.retainAcknowledged = true;
    const choose = callback(oldSingle, { eventId: "same-selection", value: "a" });
    telegram.inbox = [choose];
    await runOnce();
    const tracked = store.getRequest(oldSingle.inputId, oldSingle.requestRevision)!;
    assert.equal(tracked.answers.single?.value, "a");
    assert.equal(tracked.draftRevision, 1);
    const newSubmit = [...telegram.sends].reverse().find((message) => message.message.questionId === null);
    assert.equal(newSubmit, undefined);
    const sendsAfterFirst = telegram.sends.length;
    await runOnce();
    assert.equal(store.getRequest(oldSingle.inputId, oldSingle.requestRevision)?.draftRevision, 1);
    assert.equal(telegram.sends.length, sendsAfterFirst);
    telegram.retainAcknowledged = false;
    const staleSubmit = submitCallback(oldSingle, "stale-submit", 2);
    telegram.inbox = [staleSubmit];
    await runOnce();
    assert.equal(native.responseCalls.length, 0);
  });
});

test("unknown native submissions are never blindly replayed after restart-like polling", async () => {
  await withHarness(async ({ native, telegram, runOnce, store }) => {
    await runOnce();
    const submit = await submitAllRequired({ native, telegram, runOnce });
    native.responseResults = [{ kind: "unknown", reason: "timeout" }];
    telegram.inbox = [submitCallback(submit, "unknown-submit", 3)];
    await runOnce();
    const tracked = store.getRequest(submit.inputId, submit.requestRevision)!;
    assert.equal(tracked.submissionState, "unknown");
    assert.equal(tracked.lifecycle, "active");
    assert.equal(native.responseCalls.length, 1);
    const currentMessages = store.messagesForRequest(submit.inputId, submit.requestRevision)
      .filter((message) => message.generation === tracked.currentGeneration);
    const questionMessages = currentMessages.filter((message) => message.questionId !== null);
    const statusMessage = currentMessages.find((message) => message.questionId === null);
    assert.equal(questionMessages.length, 0);
    assert.equal(currentMessages.length, 1);
    assert.ok(currentMessages.every((message) => message.buttons.length === 0));
    assert.match(statusMessage?.text ?? "", /may have received this submission/u);
    assert.ok(allViews(telegram).some((message) => message.message.text.includes("Alpha")));
    await runOnce();
    assert.equal(native.responseCalls.length, 1);
    assert.equal(store.getRequest(submit.inputId, submit.requestRevision)?.submissionState, "unknown");
  });
});

test("restart during native intent keeps an active frozen request and renders uncertainty status", async () => {
  const directory = await mkdtemp(join(tmpdir(), "t3-input-submit-recovery-"));
  const native = new FakeNative();
  const telegram = new FakeTelegram();
  let clock = 120_000;
  const now = () => clock;
  let store = makeInputStore(directory);
  try {
    let tracked = store.upsertRequest("environment-1", makeRequest(), now());
    const sendGeneration = (messages: ReturnType<typeof store.ensureGeneration>): void => {
      assert.ok(messages);
      for (const message of messages) {
        assert.equal(store.beginMessageSend(message.deliveryKey, clock), true);
        const sentAt = Math.max(clock, message.createdAt) + 1;
        assert.equal(store.recordMessageSent(message.deliveryKey, 900 + message.ordinal + tracked.draftRevision * 10, sentAt), true);
        clock = sentAt + 1;
      }
    };
    sendGeneration(store.ensureGeneration(
      tracked.inputId, tracked.requestRevision, tracked.draftRevision,
      renderInputBatch({ request: tracked.request, answers: tracked.answers }), now(),
    ));
    const single = store.messagesForRequest(tracked.inputId, tracked.requestRevision).find((message) => message.questionId === "single")!;
    const singleEvent: InputEvent = {
      eventId: "restart-single", updateId: 1, messageId: single.messageId!, inputId: tracked.inputId,
      requestRevision: tracked.requestRevision, draftRevision: 0, questionId: "single", action: "select", value: "a",
    };
    store.applyEvent(singleEvent, now() + 2);
    tracked = store.getRequest(tracked.inputId, tracked.requestRevision)!;
    sendGeneration(store.ensureGeneration(
      tracked.inputId, tracked.requestRevision, tracked.draftRevision,
      renderInputBatch({ request: tracked.request, answers: tracked.answers }), now() + 3,
    ));
    tracked = store.getRequest(tracked.inputId, tracked.requestRevision)!;
    const multi = store.messagesForRequest(tracked.inputId, tracked.requestRevision)
      .filter((message) => message.generation === tracked.currentGeneration).find((message) => message.questionId === "multi")!;
    const multiEvent: InputEvent = {
      eventId: "restart-multi", updateId: 2, messageId: multi.messageId!, inputId: tracked.inputId,
      requestRevision: tracked.requestRevision, draftRevision: tracked.draftRevision, questionId: "multi",
      action: "select", value: "x",
    };
    store.applyEvent(multiEvent, now() + 4);
    tracked = store.getRequest(tracked.inputId, tracked.requestRevision)!;
    sendGeneration(store.ensureGeneration(
      tracked.inputId, tracked.requestRevision, tracked.draftRevision,
      renderInputBatch({ request: tracked.request, answers: tracked.answers }), now() + 5,
    ));
    assert.ok(store.prepareSubmission(tracked.inputId, tracked.requestRevision, tracked.draftRevision, now() + 6));
    store.close();
    store = makeInputStore(directory);
    const recovered = store.getRequest(tracked.inputId, tracked.requestRevision)!;
    assert.equal(recovered.submissionState, "unknown");
    assert.equal(recovered.lifecycle, "active");
    assert.equal(recovered.renderedDraftRevision, -1);

    const coordinator = makeInputCoordinator({ store, telegram, native, now });
    await coordinator.runOnce();
    const afterRestart = store.getRequest(tracked.inputId, tracked.requestRevision)!;
    const current = store.messagesForRequest(tracked.inputId, tracked.requestRevision)
      .filter((message) => message.generation === afterRestart.currentGeneration);
    assert.equal(afterRestart.submissionState, "unknown");
    assert.equal(afterRestart.lifecycle, "active");
    assert.equal(native.responseCalls.length, 0);
    assert.equal(current.length, 1);
    assert.equal(current[0]?.buttons.length, 0);
    assert.match(current[0]?.text ?? "", /may have received this submission/u);
  } finally {
    try { store.close(); } catch { /* the prior store may have been closed before reopening */ }
    await rm(directory, { recursive: true, force: true });
  }
});

test("failed uncertainty-card delivery leaves the previous question cards and draft intact", async () => {
  await withHarness(async ({ native, telegram, runOnce, store }) => {
    await runOnce();
    const submit = await submitAllRequired({ native, telegram, runOnce });
    const previousGeneration = store.getRequest(submit.inputId, submit.requestRevision)!.currentGeneration;
    native.responseResults = [{ kind: "unknown", reason: "timeout" }];
    telegram.sendBehavior = () => ({ kind: "rejected", reason: "forbidden" });
    telegram.inbox = [submitCallback(submit, "uncertain-card-failure", 3)];
    await runOnce();
    const tracked = store.getRequest(submit.inputId, submit.requestRevision)!;
    assert.equal(tracked.submissionState, "unknown");
    assert.equal(tracked.lifecycle, "active");
    assert.ok(tracked.answers.single);
    assert.ok(tracked.answers.multi);
    const previousCards = store.messagesForRequest(submit.inputId, submit.requestRevision)
      .filter((message) => message.generation === previousGeneration);
    assert.ok(previousCards.length > 0);
    assert.ok(previousCards.every((message) => message.messageId === telegram.sends[0]?.messageId));
  });
});

test("settled retired requests do not query their bridge snapshot on every poll", async () => {
  await withHarness(async ({ native, telegram, runOnce }) => {
    await runOnce();
    const submit = await submitAllRequired({ native, telegram, runOnce });
    telegram.inbox = [submitCallback(submit, "settled-submit", 3)];
    await runOnce();
    native.requests.set("router-thread", [{ ...makeRequest(), terminal: true, terminalState: "resolved" }]);
    await runOnce();
    const readsAfterTerminal = telegram.inputRequestReads;
    await runOnce();
    assert.equal(telegram.inputRequestReads, readsAfterTerminal);
    assert.equal(telegram.deletes.length, telegram.sends.length);
  });
});

test("a native revision replacement retires old Telegram messages and renders the new definition", async () => {
  await withHarness(async ({ native, telegram, runOnce, store }) => {
    await runOnce();
    const oldMessages = telegram.sends.length;
    native.requests.set("router-thread", [makeRequest("revision-2")]);
    await runOnce();
    const oldId = makeInputId("environment-1", "router-thread", "request-1");
    const old = store.getRequest(oldId, "revision-1")!;
    const current = store.getRequest(oldId, "revision-2")!;
    assert.equal(old.lifecycle, "retired");
    assert.equal(current.draftRevision, 0);
    assert.equal(telegram.sends.length, oldMessages + 1);
    assert.ok(telegram.deletes.length >= oldMessages);
    assert.equal(telegram.sends.filter((message) => message.requestRevision === "revision-2").length, 1);
  });
});

test("submit remains pending and reports degraded health when its second exact native reread fails", async () => {
  await withHarness(async ({ native, telegram, runOnce, status, store }) => {
    await runOnce();
    const submit = await submitAllRequired({ native, telegram, runOnce });
    const originalRead = native.readRequest;
    let reads = 0;
    native.readRequest = async (...args) => {
      reads += 1;
      if (reads === 2) throw new Error("unavailable");
      return originalRead(...args);
    };
    telegram.inbox = [submitCallback(submit, "retry-submit", 3)];
    await runOnce();
    assert.equal(native.responseCalls.length, 0);
    assert.equal(telegram.inbox.length, 1);
    assert.equal(status().lastErrorPhase, "native_submit_read");
    native.readRequest = originalRead;
    await runOnce();
    assert.equal(native.responseCalls.length, 1);
    assert.equal(telegram.inbox.length, 0);
    const tracked = store.getRequest(submit.inputId, submit.requestRevision)!;
    assert.equal(tracked.submissionState, "accepted");
  });
});

test("exact reads receive the persisted native T3 anchor from the tracked request", async () => {
  await withHarness(async ({ native, telegram, runOnce }) => {
    const anchoredRequest: NativeInputRequest = {
      ...makeRequest(),
      nativeT3Anchor: {
        environmentId: "environment-1",
        itemId: "question-item-1",
        owner: {
          threadId: "router-thread",
          runId: "run-1",
          nodeId: "node-1",
          providerInstanceId: "codex",
          providerThreadId: "provider-thread-1",
          providerTurnId: "provider-turn-1",
        },
        rawRequest: { id: "request-1", nodeId: "node-1", providerTurnId: "provider-turn-1", kind: "user_input", status: "pending" },
        rawTurnItem: {
          id: "question-item-1",
          threadId: "router-thread",
          runId: "run-1",
          nodeId: "node-1",
          type: "user_input_request",
          requestId: "request-1",
          questions: [],
        },
      },
    };
    native.requests.set("router-thread", [anchoredRequest]);
    await runOnce();
    await submitAllRequired({ native, telegram, runOnce });
    assert.ok(native.readPrevious.some((previous) => previous?.nativeT3Anchor?.itemId === "question-item-1"));
  });
});

test("refresh and cleanup never issue an unconditional delete after the safe window", async () => {
  await withHarness(async ({ telegram, now, runOnce, store }) => {
    await runOnce();
    const oldSent = [...telegram.sends];
    const tracked = store.listRequests()[0]!;
    store.invalidateRequest(tracked.inputId, tracked.requestRevision, now());
    store.beginRetirement(tracked.inputId, tracked.requestRevision, "input-retire-old", now());
    store.recordRetirement(tracked.inputId, tracked.requestRevision, "sent", now());
    const later = now() + 48 * 60 * 60 * 1_000;
    const stale = store.dueCleanupMessages(later);
    assert.equal(stale.length, 0);
    assert.equal(telegram.deletes.length, 0);
    assert.equal(oldSent.length, 1);
  });
});

test("a same-card refresh preserves the saved draft", async () => {
  await withHarness(async ({ telegram, advance, runOnce, store }) => {
    await runOnce();
    const single = currentQuestionMessage(telegram, "single");
    telegram.inbox = [callback(single, { eventId: "save-before-refresh", value: "b" })];
    await runOnce();
    const tracked = store.getRequest(single.inputId, single.requestRevision)!;
    assert.equal(tracked.draftRevision, 1);
    assert.equal(tracked.answers.single?.value, "b");
    advance(24 * 60 * 60 * 1_000 + 1);
    await runOnce();
    const refreshed = store.getRequest(single.inputId, single.requestRevision)!;
    assert.equal(refreshed.draftRevision, 1);
    assert.equal(refreshed.answers.single?.value, "b");
    assert.equal(refreshed.currentGeneration, 3);
    assert.equal(telegram.sends.length, 1);
    assert.ok(telegram.edits.length >= 2);
    assert.equal(telegram.deletes.length, 0);
  });
});

for (const reason of ["telegram_rejected", "telegram_not_sent"] as const) test(`${reason} sends and deletes retry with their original keys`, async () => {
  await withHarness(async ({ native, telegram, advance, runOnce, store }) => {
    let rejectSend = true;
    telegram.sendBehavior = (message) => {
      if (rejectSend && message.message.questionId === "single") {
        rejectSend = false;
        return { kind: "rejected", reason, ...(reason === "telegram_rejected" ? { telegramCode: 429 } : {}), retryAfterMs: 30_000 };
      }
      return { kind: "sent", messageId: message.messageId };
    };
    await runOnce();
    const rejectedSend = telegram.sends[0]!;
    assert.equal(rejectedSend.result.kind, "rejected");
    assert.equal(store.messagesForRequest(rejectedSend.inputId, rejectedSend.requestRevision)
      .find((message) => message.deliveryKey === rejectedSend.deliveryKey)?.error, reason);
    advance(29_999);
    await runOnce();
    assert.equal(telegram.sends.filter((message) => message.deliveryKey === rejectedSend.deliveryKey).length, 1);
    advance(1);
    await runOnce();
    assert.equal(telegram.sends.filter((message) => message.deliveryKey === rejectedSend.deliveryKey).length, 2);

    let rejectDelete = true;
    telegram.deleteBehavior = (_messageId, _deliveryKey) => {
      if (rejectDelete) {
        rejectDelete = false;
        return { kind: "rejected", reason, ...(reason === "telegram_rejected" ? { telegramCode: 403 } : {}) };
      }
      return { kind: "done" };
    };
    native.requests.set("router-thread", [{ ...makeRequest(), terminal: true, terminalState: "resolved" }]);
    await runOnce();
    const rejectedDelete = telegram.deletes[0]!;
    assert.ok(rejectedDelete);
    assert.equal(telegram.deletes.filter((message) => message.deliveryKey === rejectedDelete.deliveryKey).length, 1);
    advance(4_999);
    await runOnce();
    assert.equal(telegram.deletes.filter((message) => message.deliveryKey === rejectedDelete.deliveryKey).length, 1);
    advance(1);
    await runOnce();
    assert.equal(telegram.deletes.filter((message) => message.deliveryKey === rejectedDelete.deliveryKey).length, 2);
    assert.equal(store.isTombstoned(rejectedSend.inputId, rejectedSend.requestRevision), true);
  });
});

test("aged same-draft refresh keeps a rejected fragment on its original delivery key", async () => {
  await withHarness(async ({ telegram, advance, runOnce, store }) => {
    let rejectFirstSend = true;
    telegram.sendBehavior = (message) => {
      if (rejectFirstSend && message.message.questionId === "single") {
        rejectFirstSend = false;
        return { kind: "rejected", reason: "telegram_rejected", telegramCode: 403 };
      }
      return { kind: "sent", messageId: message.messageId };
    };
    await runOnce();
    const rejected = telegram.sends[0]!;
    assert.equal(rejected.result.kind, "rejected");
    advance(24 * 60 * 60 * 1_000 + 1);
    await runOnce();
    const tracked = store.getRequest(rejected.inputId, rejected.requestRevision)!;
    const retried = store.messagesForRequest(rejected.inputId, rejected.requestRevision)
      .find((message) => message.generation === tracked.currentGeneration && message.questionId === "single")!;
    assert.equal(retried.deliveryKey, rejected.deliveryKey);
    assert.equal(retried.state, "sent");
    assert.equal(telegram.sends.filter((message) => message.deliveryKey === rejected.deliveryKey).length, 2);
  });
});

test("retirement lost acknowledgement is reconciled from the local request snapshot", async () => {
  await withHarness(async ({ telegram, runOnce, store }) => {
    await runOnce();
    const tracked = store.listRequests()[0]!;
    store.invalidateRequest(tracked.inputId, tracked.requestRevision, 100_100);
    telegram.loseRetirementAcknowledgment = true;
    await runOnce();
    const retired = store.getRequest(tracked.inputId, tracked.requestRevision)!;
    assert.equal(retired.retirementState, "sent");
    assert.equal(retired.lifecycle, "retired");
    assert.equal(telegram.retirements.length, 1);
    assert.ok(telegram.inputRequestReads > 0);
    assert.equal(telegram.deliveryStatusReads.includes(telegram.retirements[0]!.deliveryKey), false);
  });
});

test("an error envelope after local retirement reconciles through get_input_request, not the send ledger", async () => {
  const directory = await mkdtemp(join(tmpdir(), "t3-input-retirement-envelope-"));
  const native = new FakeNative();
  let bridgeActive = true;
  const toolCalls: string[] = [];
  const telegram = makeInputTelegramClient("http://mcpx:9000/mcp/lazy", {
    makeSession: () => ({
      connect: async () => undefined,
      callTool: async (name) => {
        toolCalls.push(name);
        if (name.endsWith("retire_input_request")) {
          bridgeActive = false;
          return { isError: true, structuredContent: { ok: true, result: true } };
        }
        if (name.endsWith("get_input_request")) {
          return { isError: false, structuredContent: { ok: true, active: bridgeActive, messages: [], pending_delivery_keys: [] } };
        }
        if (name.endsWith("read_input_inbox")) {
          return { isError: false, structuredContent: { ok: true, events: [] } };
        }
        throw new Error("unexpected Telegram input tool");
      },
      close: async () => undefined,
    }),
  });
  const store = makeInputStore(directory);
  const tracked = store.upsertRequest("environment-1", makeRequest(), 200_000);
  const key = "input-retirement-envelope-key";
  try {
    const lostAcknowledgement = await telegram.retireInputRequest(tracked.inputId, tracked.requestRevision, key);
    assert.deepEqual(lostAcknowledgement, { kind: "unknown", reason: "mcp_error" });
    store.beginRetirement(tracked.inputId, tracked.requestRevision, key, 200_001);
    store.recordRetirement(tracked.inputId, tracked.requestRevision, "unknown", 200_002);
    const coordinator = makeInputCoordinator({ store, telegram, native, now: () => 200_003 });
    await coordinator.runOnce();
    assert.equal(store.getRequest(tracked.inputId, tracked.requestRevision)?.retirementState, "sent");
    assert.equal(toolCalls.filter((name) => name.endsWith("retire_input_request")).length, 1);
    assert.ok(toolCalls.some((name) => name.endsWith("get_input_request")));
    assert.equal(toolCalls.some((name) => name.endsWith("get_delivery_status")), false);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("submit from a complete older draft is rejected after a later answer revision", async () => {
  await withHarness(async ({ native, telegram, runOnce, store }) => {
    await runOnce();
    const oldSubmit = await submitAllRequired({ native, telegram, runOnce });
    const currentSingle = currentQuestionMessage(telegram, "single");
    telegram.inbox = [callback(currentSingle, { eventId: "revise-complete-draft", updateId: 3, value: "b" })];
    await runOnce();
    assert.equal(store.getRequest(oldSubmit.inputId, oldSubmit.requestRevision)?.draftRevision, 3);
    telegram.inbox = [submitCallback(oldSubmit, "stale-complete-submit", 4)];
    await runOnce();
    assert.equal(native.responseCalls.length, 0);
    assert.equal(store.getRequest(oldSubmit.inputId, oldSubmit.requestRevision)?.submissionState, "none");
  });
});


test("saved exclusion changes retire active input notices without restarting", async () => {
  let policy = { excludedThreadIds: [] as string[], interactiveThreadId: null };
  await withHarness(async ({ native, telegram, runOnce, store }) => {
    native.threads[0] = { id: "router-thread", active: true, kind: "main" };
    telegram.notificationRequest = { inputId: makeInputId("environment-1", "router-thread", "request-1"), requestRevision: "revision-1", draftRevision: 0 };
    await runOnce();
    const tracked = store.listRequests()[0]!;
    assert.equal(telegram.sends.length, 1);
    policy = { ...policy, excludedThreadIds: [tracked.threadId] };
    await runOnce();
    assert.notEqual(store.getRequest(tracked.inputId, tracked.requestRevision)?.lifecycle, "active");
    assert.equal(telegram.sends.length, 1);
  }, { routerOnlyInput: true, readThreadPolicy: () => policy });
});

test("unconfirmed obsolete deletion expires after 24 hours without replay", async () => {
  await withHarness(async ({ telegram, now, advance, runOnce, store, status }) => {
    await runOnce();
    const tracked = store.listRequests()[0]!;
    store.invalidateRequest(tracked.inputId, tracked.requestRevision, now());
    telegram.deleteBehavior = () => ({ kind: "unknown", reason: "invalid_response" });
    await runOnce();
    const unknown = store.dueCleanupMessages(now()).find(m => m.cleanupState === "unknown")!;
    assert.ok(unknown);
    assert.equal(store.expireUnknownDeletion(unknown.deliveryKey, now()), false);
    const count = telegram.deletes.length;
    advance(23 * 60 * 60 * 1000);
    await runOnce();
    assert.equal(store.dueCleanupMessages(now()).some(m => m.deliveryKey === unknown.deliveryKey), true);
    advance(60 * 60 * 1000 + 1);
    await runOnce();
    assert.equal(telegram.deletes.length, count);
    const expired = store.messagesForRequest(unknown.inputId, unknown.requestRevision).find(m => m.deliveryKey === unknown.deliveryKey);
    assert.equal(expired?.cleanupState, "expired");
    assert.equal(expired?.cleanupError, "deletion_unconfirmed_expired");
    assert.equal(status().uncertain, 0);
  });
});
