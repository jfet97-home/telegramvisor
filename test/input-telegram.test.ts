import assert from "node:assert/strict";
import test from "node:test";
import { InputTelegramError, makeInputTelegramClient } from "../src/input-telegram.js";
import type { McpSession } from "../src/telegram.js";

interface ToolCall {
  readonly name: string;
  readonly args: Record<string, unknown>;
  readonly connected: boolean;
  readonly closed: boolean;
}

interface Behavior {
  readonly result?: unknown;
  readonly callTool?: () => Promise<unknown>;
  readonly connect?: () => Promise<void>;
}

const mcpxUrl = "http://mcpx:9000/mcp/lazy";

const makeClient = (behaviors: readonly Behavior[], calls: ToolCall[], timeoutMs?: number) => {
  let index = 0;
  return makeInputTelegramClient(mcpxUrl, {
    timeoutMs,
    makeSession: (): McpSession => {
      const behavior = behaviors[index++] ?? {};
      const call: { name: string; args: Record<string, unknown>; connected: boolean; closed: boolean } = {
        name: "", args: {}, connected: false, closed: false,
      };
      calls.push(call);
      return {
        connect: async () => { call.connected = true; await behavior.connect?.(); },
        callTool: async (name, args) => {
          call.name = name;
          call.args = args;
          return behavior.callTool ? behavior.callTool() : behavior.result;
        },
        close: async () => { call.closed = true; },
      };
    },
  });
};

const success = (body: Record<string, unknown>) => ({
  isError: false,
  structuredContent: { ok: true, ...body },
});

test("native text replies receive a stable receipt and uncertain reactions do not block answers", async () => {
  const event = {
    event_id: "telegram:123", update_id: 123, update_epoch: 1, message_id: 42,
    input_id: "input-opaque", request_revision: "revision", draft_revision: 0,
    question_id: "q", action: "answer", text: "my answer", contribution_id: "207",
    delivery_key: "view-key", presentation_revision: 2, focus_id: "focus-id",
    focus_presentation_revision: 1,
  };
  const calls: ToolCall[] = [];
  const key = "telegram-123-received-1"; // gitleaks:allow
  const client = makeClient([
    { result: success({ events: [event] }) },
    { result: success({ delivery_key: key, state: "not_found" }) },
    { result: success({ result: true }) },
    { result: success({ events: [event] }) },
    { result: success({ delivery_key: key, state: "unknown" }) },
  ], calls);
  assert.equal((await client.readInputInbox(10)).length, 1);
  assert.deepEqual(calls[2]?.args, { message_id: 207, emoji: "👍", delivery_key: key });
  assert.equal((await client.readInputInbox(10)).length, 1);
  assert.equal(calls.filter((call) => call.name.endsWith("set_message_reaction")).length, 1);
});

test("routes input mutations through MCPX wrapper with exact bridge arguments", async () => {
  const calls: ToolCall[] = [];
  const client = makeClient([
    { result: success({ result: { message_id: 42 } }) },
    { result: success({ result: true }) },
    { result: success({ result: true }) },
  ], calls);
  const message = {
    questionId: "q1",
    fragment: 0,
    focusId: "must-not-be-sent-on-initial-message",
    text: "Choose one — 📦",
    buttons: [[{ label: "Select 1", action: "select" as const, value: "choice-a" }]],
    presentationRevision: 3,
  };
  assert.deepEqual(await client.sendInputMessage("input-opaque", "revision-hash", 3, message, "input-send-key"), {
    kind: "sent", messageId: 42,
  });
  assert.deepEqual(await client.retireInputRequest("input-opaque", "revision-hash", "retire-key"), { kind: "done" });
  assert.deepEqual(await client.deleteMessage(42, "delete-key"), { kind: "done" });
  assert.deepEqual(calls.map((call) => call.name), [
    "raspfet-telegram-t3__send_input_message",
    "raspfet-telegram-t3__retire_input_request",
    "raspfet-telegram-t3__delete_message",
  ]);
  assert.equal(calls[0]?.name, "raspfet-telegram-t3__send_input_message");
  assert.deepEqual(calls[0]?.args, {
    input_id: "input-opaque",
    request_revision: "revision-hash",
    draft_revision: 3,
    presentation_revision: 3,
    question_id: "q1",
    text: "Choose one — 📦",
    buttons: [[{ label: "Select 1", action: "select", value: "choice-a" }]],
    delivery_key: "input-send-key",
  });
  assert.ok(calls.every((call) => call.connected && call.closed));
});

test("edits the registered physical card through the separate presentation tool", async () => {
  const calls: ToolCall[] = [];
  const client = makeClient([{ result: success({ result: { message_id: 42 } }) }], calls);
  const message = {
    questionId: "q2",
    fragment: 0,
    presentationRevision: 8,
    focusId: "focus-q1-exact",
    text: "Question 2 of 3",
    buttons: [[{ label: "Next →", action: "navigate" as const, value: "question:2:0" }]],
  };
  assert.deepEqual(await client.editInputMessage(
    "input-opaque", "revision-hash", 3, 42, message, "input-edit-key-8",
  ), { kind: "sent", messageId: 42 });
  assert.deepEqual(calls[0]?.args, {
    input_id: "input-opaque",
    request_revision: "revision-hash",
    draft_revision: 3,
    presentation_revision: 8,
    focus_id: "focus-q1-exact",
    question_id: "q2",
    text: "Question 2 of 3",
    buttons: [[{ label: "Next →", action: "navigate", value: "question:2:0" }]],
    delivery_key: "input-edit-key-8",
    message_id: 42,
  });
  assert.equal(calls[0]?.name, "raspfet-telegram-t3__edit_input_message");
});

test("an unregistered text focus is a definitive pre-send rejection", async () => {
  const calls: ToolCall[] = [];
  const client = makeClient([
    {
    result: {
      isError: true,
      structuredContent: {
        ok: false,
        error: "text_focus_not_registered",
        delivery_state: "rejected",
        confirmed_not_delivered: true,
        delivery_may_have_completed: false,
      },
    },
    },
    { result: {
      isError: true,
      structuredContent: {
        ok: false,
        error: "text_focus_not_registered",
        delivery_state: "unknown",
        delivery_may_have_completed: true,
      },
    } },
    { result: {
      isError: true,
      structuredContent: { ok: false, error: "text_focus_not_registered" },
    } },
  ], calls);
  const message = {
    questionId: "q2",
    fragment: 0,
    presentationRevision: 3,
    focusId: "focus-q1-exact",
    text: "Q2 card while Q1 remains focused",
    buttons: [[{ label: "Write / Edit Text", action: "edit_text" as const }]],
  };
  const result = await client.editInputMessage("input", "revision", 0, 42, message, "focus-rejected-edit");
  const uncertain = await client.editInputMessage("input", "revision", 0, 42, message, "focus-uncertain-edit");
  const incomplete = await client.editInputMessage("input", "revision", 0, 42, message, "focus-incomplete-edit");
  assert.deepEqual(result, { kind: "rejected", reason: "text_focus_not_registered" });
  assert.deepEqual(uncertain, { kind: "unknown", reason: "mcp_error" });
  assert.deepEqual(incomplete, { kind: "unknown", reason: "mcp_error" });
  assert.equal(calls[0]?.args.focus_id, "focus-q1-exact");
});

test("coalesced presentation revisions preserve pre-send rejection certainty", async () => {
  const calls: ToolCall[] = [];
  const client = makeClient([
    { result: {
      isError: true,
      structuredContent: { ok: false, error: "stale_presentation" },
    } },
    { result: {
      isError: true,
      structuredContent: { ok: false, error: "stale_presentation", delivery_may_have_completed: false },
    } },
    { result: {
      isError: true,
      structuredContent: { ok: false, error: "stale_presentation", delivery_may_have_completed: true },
    } },
    { result: {
      isError: true,
      structuredContent: { ok: false, error: "delivery_in_progress_or_unknown" },
    } },
  ], calls);
  const message = {
    questionId: "multi",
    fragment: 0,
    presentationRevision: 3,
    text: "Choose all",
    buttons: [[{ label: "Select B", action: "select" as const, value: "b" }]],
  };

  assert.deepEqual(await client.editInputMessage("input", "revision", 2, 42, message, "coalesced-edit"), {
    kind: "rejected", reason: "stale_presentation",
  });
  assert.deepEqual(await client.editInputMessage("input", "revision", 2, 42, message, "pre-send-edit"), {
    kind: "rejected", reason: "stale_presentation",
  });
  assert.deepEqual(await client.editInputMessage("input", "revision", 2, 42, message, "uncertain-edit"), {
    kind: "unknown", reason: "mcp_error",
  });
  assert.deepEqual(await client.editInputMessage("input", "revision", 2, 42, message, "ledger-unknown-edit"), {
    kind: "unknown", reason: "mcp_error",
  });
  assert.equal(calls[0]?.args.presentation_revision, 3);
  assert.ok(calls.every((call) => call.name.endsWith("edit_input_message")));
});

test("parses authenticated owner inbox events and rejects malformed or oversized batches", async () => {
  const event = {
    event_id: "event-1",
    update_id: 19,
    update_epoch: 3,
    message_id: 42,
    input_id: "input-opaque",
    request_revision: "revision-hash",
    draft_revision: 4,
    question_id: "q1",
    action: "answer",
    text: "Plain owner text",
    contribution_id: "contribution-1",
    edited: false,
    delivery_key: "view-key-4",
    presentation_revision: 4,
    focus_id: "focus-id-1",
    focus_presentation_revision: 2,
  };
  const calls: ToolCall[] = [];
  const client = makeClient([
    { result: success({ events: [event] }) },
    { result: success({ events: [{ ...event, action: "submit", message_id: 1.5 }] }) },
  ], calls);
  assert.deepEqual(await client.readInputInbox(10), [{
    eventId: "event-1",
    updateId: 19,
    updateEpoch: 3,
    messageId: 42,
    inputId: "input-opaque",
    requestRevision: "revision-hash",
    draftRevision: 4,
    questionId: "q1",
    action: "answer",
    text: "Plain owner text",
    contributionId: "contribution-1",
    edited: false,
    deliveryKey: "view-key-4",
    presentationRevision: 4,
    focusId: "focus-id-1",
    focusPresentationRevision: 2,
  }]);
  await assert.rejects(client.readInputInbox(10), (error: unknown) => error instanceof InputTelegramError && error.code === "invalid_response");
  assert.equal(calls[0]?.name, "raspfet-telegram-t3__read_input_inbox");
  assert.deepEqual(calls[0]?.args, { limit: 10 });
});

test("unsupported-media instructions stay attached to stale events", async () => {
  const instruction = "This native input does not accept images or media. Reply with text or answer in T3.";
  const calls: ToolCall[] = [];
  const client = makeClient([{
    result: success({ events: [{
      event_id: "event-media",
      update_id: 20,
      update_epoch: 0,
      message_id: 42,
      input_id: "input-opaque",
      request_revision: "revision-hash",
      draft_revision: 0,
      question_id: "q1",
      action: "stale",
      text: instruction,
      contribution_id: "201",
    }] }),
  }], calls);

  const [event] = await client.readInputInbox(10);
  assert.equal(event?.action, "stale");
  assert.equal(event?.text, instruction);
});

test("acknowledgement and input request snapshot are bounded and typed", async () => {
  const calls: ToolCall[] = [];
  const client = makeClient([
    { result: success({ result: true }) },
    { result: success({ active: false, messages: [{ message_id: 42, delivery_key: "send-key", state: "recovered" }], pending_delivery_keys: ["pending-key"] }) },
    { result: success({ delivery_key: "delete-key", state: "sent", delivery: { ok: true, result: true } }) },
  ], calls);
  assert.deepEqual(await client.acknowledgeInputEvents(["event-1"], "ack-key"), { kind: "done" });
  assert.deepEqual(await client.getInputRequest("input-opaque", "revision-hash"), {
    active: false,
    messages: [{ messageId: 42, deliveryKey: "send-key", state: "recovered" }],
    pendingDeliveryKeys: ["pending-key"],
  });
  assert.deepEqual(await client.getDeliveryStatus("delete-key"), { state: "sent", messageId: null, mutationConfirmed: true });
  assert.equal(calls[0]?.name, "raspfet-telegram-t3__ack_input_events");
  assert.deepEqual(calls[0]?.args, { event_ids: ["event-1"], delivery_key: "ack-key" });
});

test("MCP errors, ambiguous mutation failures, and timeouts remain uncertain", async () => {
  const calls: ToolCall[] = [];
  const wait = new Promise<unknown>(() => undefined);
  const client = makeClient([
    { result: { isError: true, structuredContent: { ok: true, result: { message_id: 43 } } } },
    { result: { isError: true, structuredContent: { ok: false, error: "journal_completion_failed", delivery_may_have_completed: true } } },
    { callTool: () => wait },
  ], calls, 10);
  const message = { questionId: null, fragment: 0, text: "Submit?", buttons: [[{ label: "Submit", action: "submit" as const }]] };
  assert.deepEqual(await client.sendInputMessage("input", "rev", 1, message, "send-key"), { kind: "unknown", reason: "mcp_error" });
  assert.deepEqual(await client.retireInputRequest("input", "rev", "retire-key"), { kind: "unknown", reason: "mcp_error" });
  const keepAlive = setTimeout(() => undefined, 100);
  assert.deepEqual(await client.deleteMessage(43, "delete-timeout"), { kind: "unknown", reason: "timeout" });
  clearTimeout(keepAlive);
  assert.ok(calls.every((call) => call.closed));
});

test("known Telegram rejections preserve retry metadata through MCP error envelopes", async () => {
  const calls: ToolCall[] = [];
  const client = makeClient([
    { result: {
      isError: true,
      structuredContent: { ok: false, error: "telegram_rejected", telegram_error_code: 429, retry_after_seconds: 12 },
    } },
    { result: {
      isError: true,
      structuredContent: { ok: false, error: "telegram_rejected", telegram_code: 429, retry_after: 5 },
    } },
    { result: {
      isError: true,
      structuredContent: { ok: false, error: "telegram_rejected", telegram_code: 403 },
    } },
    { result: {
      isError: true,
      structuredContent: { ok: false, error: "telegram_rejected", telegram_error_code: 500 },
    } },
    { result: {
      isError: true,
      structuredContent: {
        ok: false,
        error: "journal_completion_failed",
        telegram_error_code: 429,
        retry_after_seconds: 12,
        delivery_may_have_completed: true,
      },
    } },
    { result: {
      isError: true,
      structuredContent: { ok: false, error: "telegram_rejected", telegram_error_code: 600, retry_after_seconds: -1 },
    } },
  ], calls);
  const message = { questionId: null, fragment: 0, text: "Submit?", buttons: [] };
  assert.deepEqual(await client.sendInputMessage("input", "rev", 1, message, "send-429"), {
    kind: "rejected", reason: "telegram_rejected", telegramCode: 429, retryAfterMs: 12_000,
  });
  assert.deepEqual(await client.sendInputMessage("input", "rev", 1, message, "send-legacy-429"), {
    kind: "rejected", reason: "telegram_rejected", telegramCode: 429, retryAfterMs: 5_000,
  });
  assert.deepEqual(await client.deleteMessage(42, "delete-403"), {
    kind: "rejected", reason: "telegram_rejected", telegramCode: 403,
  });
  assert.deepEqual(await client.deleteMessage(43, "delete-500"), { kind: "unknown", reason: "mcp_error" });
  assert.deepEqual(await client.deleteMessage(44, "delete-journal-failure"), { kind: "unknown", reason: "mcp_error" });
  assert.deepEqual(await client.deleteMessage(45, "delete-invalid-metadata"), {
    kind: "rejected", reason: "telegram_rejected",
  });
});

test("delivery lookup distinguishes sent, pending, unknown, and not-found without implying safe replay", async () => {
  const calls: ToolCall[] = [];
  const client = makeClient([
    { result: success({ delivery_key: "key-1", state: "sent", delivery: { result: { message_id: 99 } } }) },
    { result: success({ delivery_key: "key-1", state: "sending" }) },
    { result: success({ delivery_key: "key-1", state: "unknown" }) },
    { result: success({ delivery_key: "key-1", state: "not_found" }) },
  ], calls);
  assert.deepEqual(await client.getDeliveryStatus("key-1"), { state: "sent", messageId: 99 });
  assert.deepEqual(await client.getDeliveryStatus("key-1"), { state: "sending" });
  assert.deepEqual(await client.getDeliveryStatus("key-1"), { state: "unknown", reason: "delivery_unknown" });
  assert.deepEqual(await client.getDeliveryStatus("key-1"), { state: "not_found" });
});

test("input message bounds and credential-bearing MCP URLs fail before network calls", async () => {
  const calls: ToolCall[] = [];
  const client = makeClient([], calls);
  const tooLong = { questionId: null, fragment: 0, text: "x".repeat(4_001), buttons: [] };
  assert.deepEqual(await client.sendInputMessage("input", "rev", 1, tooLong, "key"), { kind: "rejected", reason: "invalid_request" });
  assert.throws(() => makeInputTelegramClient("http://user:secret@mcpx:9000/mcp/lazy"), InputTelegramError);
  assert.equal(calls.length, 0);
});

test("native sends and edits accept only complete pre-send non-delivery proof", async () => {
  const proof = {
    ok: false, error: "telegram_not_sent", delivery_state: "rejected",
    confirmed_not_delivered: true, delivery_may_have_completed: false,
    failure_stage: "connect", failure_kind: "connection_refused", transport_attempts: 3,
  };
  const bodies = [proof, proof, { ...proof, confirmed_not_delivered: false },
    { ...proof, delivery_may_have_completed: true }, { ...proof, failure_stage: "response" }];
  const calls: ToolCall[] = [];
  const client = makeClient(bodies.map((body) => ({ result: { isError: true, structuredContent: body } })), calls);
  const message = { questionId: null, fragment: 0, text: "Question", buttons: [] };
  assert.deepEqual(await client.sendInputMessage("input", "revision", 0, message, "original-send"), {
    kind: "rejected", reason: "telegram_not_sent",
  });
  assert.deepEqual(await client.editInputMessage("input", "revision", 0, 42, message, "original-edit"), {
    kind: "rejected", reason: "telegram_not_sent",
  });
  for (let index = 2; index < bodies.length; index++) {
    assert.equal((await client.sendInputMessage("input", "revision", 0, message, "original-send")).kind, "unknown");
  }
});
