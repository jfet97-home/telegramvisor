import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { isConfirmedNotSent, type McpSession } from "./telegram.js";
import type { InputEvent, RenderedInputMessage } from "./input-domain.js";

const TOOL_PREFIX = "raspfet-telegram-t3__";
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_EVENTS = 100;
const MAX_REQUEST_MESSAGES = 2_000;
const NON_EXECUTION_ERRORS = new Set([
  "invalid_request",
  "invalid_input",
  "unsupported_action",
  "stale_request",
  "stale_draft",
  "input_not_active",
  "not_owner",
  "unauthorized",
  "callback_invalid",
  "message_not_registered",
  "stale_presentation",
  "text_focus_not_registered",
  "telegram_rejected",
]);

export type InputMutationResult =
  | { readonly kind: "done" }
  | { readonly kind: "rejected"; readonly reason: string; readonly telegramCode?: number; readonly retryAfterMs?: number }
  | { readonly kind: "unknown"; readonly reason: string };

export type InputSendResult =
  | { readonly kind: "sent"; readonly messageId: number }
  | { readonly kind: "rejected"; readonly reason: string; readonly telegramCode?: number; readonly retryAfterMs?: number }
  | { readonly kind: "unknown"; readonly reason: string };

export type InputDeliveryStatus =
  | { readonly state: "sent"; readonly messageId: number | null; readonly mutationConfirmed?: boolean }
  | { readonly state: "sending" }
  | { readonly state: "unknown"; readonly reason: string }
  | { readonly state: "not_found" };

export interface InputRequestSnapshot {
  readonly active: boolean;
  readonly messages: readonly {
    readonly messageId: number;
    readonly deliveryKey: string;
    readonly state?: "prepared" | "sending" | "unknown" | "recovered" | "sent" | "retired";
  }[];
  readonly pendingDeliveryKeys: readonly string[];
}

export interface InputTelegramApi {
  readonly sendInputNotification: (message: RenderedInputMessage, deliveryKey: string, messageId?: number) => Promise<InputSendResult>;
  readonly sendInputMessage: (inputId: string, requestRevision: string, draftRevision: number, message: RenderedInputMessage, deliveryKey: string) => Promise<InputSendResult>;
  readonly editInputMessage: (inputId: string, requestRevision: string, draftRevision: number, messageId: number, message: RenderedInputMessage, deliveryKey: string) => Promise<InputSendResult>;
  readonly readInputInbox: (limit: number) => Promise<readonly InputEvent[]>;
  readonly acknowledgeInputEvents: (eventIds: readonly string[], deliveryKey: string) => Promise<InputMutationResult>;
  readonly getInputRequest: (inputId: string, requestRevision: string) => Promise<InputRequestSnapshot>;
  readonly retireInputRequest: (inputId: string, requestRevision: string, deliveryKey: string) => Promise<InputMutationResult>;
  readonly deleteMessage: (messageId: number, deliveryKey: string) => Promise<InputMutationResult>;
  readonly getDeliveryStatus: (deliveryKey: string) => Promise<InputDeliveryStatus>;
}

export interface InputTelegramClientDependencies {
  readonly makeSession?: (url: URL) => McpSession;
  readonly timeoutMs?: number | undefined;
  readonly onReceiptFailure?: (deliveryKey: string) => void;
}

export class InputTelegramError extends Error {
  constructor(readonly code: "invalid_url" | "connection_failed" | "invalid_response" | "timeout") {
    super("The Telegram input operation could not be completed.");
    this.name = "InputTelegramError";
  }
}

interface ToolBody {
  readonly isError: boolean;
  readonly value: Record<string, unknown> | null;
  readonly invalid: boolean;
}

class SessionFailure extends Error {
  constructor(readonly reason: "timeout" | "transport_error") {
    super("The MCP request did not complete.");
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const nonEmptyString = (value: unknown, maxLength = 2_048): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= maxLength;

const positiveInteger = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;

const nonNegativeInteger = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;

const telegramCodesFrom = (body: Record<string, unknown>): number[] =>
  [body.telegram_error_code, body.telegram_code].filter(
    (value): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 100 && value <= 599,
  );

const telegramCodeFrom = (body: Record<string, unknown>): number | undefined => telegramCodesFrom(body)[0];

const retryAfterSecondsFrom = (body: Record<string, unknown>): number | undefined => {
  for (const value of [body.retry_after_seconds, body.retry_after]) {
    if (typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 86_400) {
      return value;
    }
  }
  return undefined;
};

const parseUrl = (value: string): URL => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new InputTelegramError("invalid_url");
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) {
    throw new InputTelegramError("invalid_url");
  }
  return url;
};

const makeSdkSession = (url: URL): McpSession => {
  const transport = new StreamableHTTPClientTransport(url);
  const client = new Client({ name: "telegramvisor-input", version: "0.1.0" });
  return {
    connect: () => client.connect(transport as unknown as Parameters<typeof client.connect>[0]),
    callTool: (name, args) => client.callTool({
      name: "mcpx_call_tool",
      arguments: { name, arguments: args },
    }),
    close: () => client.close(),
  };
};

const callTool = (
  url: URL,
  sessionFactory: (url: URL) => McpSession,
  name: string,
  args: Record<string, unknown>,
  timeoutMs: number,
): Promise<unknown> => new Promise((resolve, reject) => {
  let session: McpSession;
  try {
    session = sessionFactory(url);
  } catch {
    reject(new SessionFailure("transport_error"));
    return;
  }

  let settled = false;
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    if (!closing) {
      try { closing = Promise.resolve(session.close()).catch(() => undefined); }
      catch { closing = Promise.resolve(); }
    }
    return closing;
  };
  const finish = (result: { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly error: SessionFailure }): void => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    void close().then(() => result.ok ? resolve(result.value) : reject(result.error));
  };
  const timer = setTimeout(() => finish({ ok: false, error: new SessionFailure("timeout") }), timeoutMs);
  timer.unref();
  void (async () => {
    await session.connect();
    if (settled) return;
    const result = await session.callTool(`${TOOL_PREFIX}${name}`, args);
    finish({ ok: true, value: result });
  })().catch(() => finish({ ok: false, error: new SessionFailure("transport_error") }));
});

const parseBody = (value: unknown): ToolBody => {
  if (!isRecord(value)) return { isError: true, value: null, invalid: true };
  const isError = value.isError === true;
  if (isRecord(value.structuredContent)) {
    try {
      if (Buffer.byteLength(JSON.stringify(value.structuredContent), "utf8") <= MAX_RESPONSE_BYTES) {
        return { isError, value: value.structuredContent, invalid: false };
      }
    } catch { /* invalid MCP content is treated as an uncertain result */ }
    return { isError: true, value: null, invalid: true };
  }
  if (!Array.isArray(value.content)) return { isError, value: null, invalid: true };
  for (const content of value.content) {
    if (!isRecord(content) || content.type !== "text" || typeof content.text !== "string") continue;
    if (Buffer.byteLength(content.text, "utf8") > MAX_RESPONSE_BYTES) return { isError: true, value: null, invalid: true };
    try {
      const parsed: unknown = JSON.parse(content.text);
      if (isRecord(parsed)) return { isError, value: parsed, invalid: false };
    } catch { return { isError: true, value: null, invalid: true }; }
  }
  return { isError, value: null, invalid: true };
};

const mutationResult = (value: unknown, expectedResult?: unknown): InputMutationResult => {
  const envelope = parseBody(value);
  const body = envelope.value;
  if (envelope.invalid || !body) return { kind: "unknown", reason: "invalid_response" };
  if (body.ok === true && !envelope.isError && (expectedResult === undefined || body.result === expectedResult)) {
    return { kind: "done" };
  }
  if (body.ok === false && isKnownNonExecution(body)) {
    return { kind: "rejected", ...rejectionDetails(body) };
  }
  return { kind: "unknown", reason: envelope.isError ? "mcp_error" : "mutation_uncertain" };
};

const isKnownNonExecution = (body: Record<string, unknown>): boolean => {
  if (body.delivery_may_have_completed === true || body.error === "journal_completion_failed") return false;
  if (isConfirmedNotSent(body)) return true;
  if (body.error === "text_focus_not_registered") {
    return body.delivery_state === "rejected" && body.confirmed_not_delivered === true &&
      body.delivery_may_have_completed === false;
  }
  if (telegramCodesFrom(body).some((code) => code >= 500)) return false;
  return body.error === "telegram_rejected" || typeof body.error === "string" && NON_EXECUTION_ERRORS.has(body.error);
};

const rejectionDetails = (body: Record<string, unknown>): {
  readonly reason: string;
  readonly telegramCode?: number;
  readonly retryAfterMs?: number;
} => {
  const telegramCode = telegramCodeFrom(body);
  const retryAfterSeconds = telegramCode === 429 ? retryAfterSecondsFrom(body) : undefined;
  return {
    reason: telegramCode === 400 && (body.deletion_reason === "message_not_found" || body.deletion_reason === "message_cannot_be_deleted")
      ? body.deletion_reason : typeof body.error === "string" ? body.error.slice(0, 128) : "telegram_rejected",
    ...(telegramCode === undefined ? {} : { telegramCode }),
    ...(retryAfterSeconds === undefined ? {} : { retryAfterMs: Math.ceil(retryAfterSeconds * 1_000) }),
  };
};

const parseAction = (value: unknown): InputEvent["action"] | null =>
  value === "answer" || value === "select" || value === "deselect" || value === "skip" || value === "submit" ||
    value === "navigate" || value === "edit_text" || value === "review" || value === "clear" || value === "stale"
    ? value
    : null;

const parseEvent = (value: unknown): InputEvent => {
  if (!isRecord(value) || !nonEmptyString(value.event_id, 256) || !nonNegativeInteger(value.update_id) ||
    !nonNegativeInteger(value.update_epoch) ||
    !positiveInteger(value.message_id) || !nonEmptyString(value.input_id, 128) ||
    !nonEmptyString(value.request_revision, 256) || !nonNegativeInteger(value.draft_revision) ||
    !(value.question_id === null || nonEmptyString(value.question_id, 256))) {
    throw new InputTelegramError("invalid_response");
  }
  const action = parseAction(value.action);
  const presentationRevision = value.presentation_revision;
  const focusPresentationRevision = value.focus_presentation_revision;
  if (!action || (value.value !== undefined && !nonEmptyString(value.value, 4_000)) ||
    (value.text !== undefined && (typeof value.text !== "string" || value.text.length > 4_096)) ||
    (value.contribution_id !== undefined && !nonEmptyString(value.contribution_id, 256)) ||
    (value.edited !== undefined && typeof value.edited !== "boolean") ||
    (value.delivery_key !== undefined && !nonEmptyString(value.delivery_key, 128)) ||
    (presentationRevision !== undefined && !nonNegativeInteger(presentationRevision)) ||
    (value.focus_id !== undefined && !nonEmptyString(value.focus_id, 128)) ||
    (focusPresentationRevision !== undefined && !nonNegativeInteger(focusPresentationRevision))) {
    throw new InputTelegramError("invalid_response");
  }
  return {
    eventId: value.event_id,
    updateId: value.update_id,
    updateEpoch: value.update_epoch,
    messageId: value.message_id,
    inputId: value.input_id,
    requestRevision: value.request_revision,
    draftRevision: value.draft_revision,
    questionId: value.question_id,
    action,
    ...(typeof value.value === "string" ? { value: value.value } : {}),
    ...(typeof value.text === "string" ? { text: value.text } : {}),
    ...(typeof value.contribution_id === "string" ? { contributionId: value.contribution_id } : {}),
    ...(typeof value.edited === "boolean" ? { edited: value.edited } : {}),
    ...(typeof value.delivery_key === "string" ? { deliveryKey: value.delivery_key } : {}),
    ...(typeof presentationRevision === "number" ? { presentationRevision } : {}),
    ...(typeof value.focus_id === "string" ? { focusId: value.focus_id } : {}),
    ...(typeof focusPresentationRevision === "number" ? { focusPresentationRevision } : {}),
  };
};

const messageIdFrom = (value: unknown): number | null =>
  isRecord(value) && positiveInteger(value.message_id) ? value.message_id : null;

const deliveryState = (value: unknown, expectedKey: string): InputDeliveryStatus => {
  const envelope = parseBody(value);
  const body = envelope.value;
  if (envelope.invalid || envelope.isError || !body || body.ok !== true || body.delivery_key !== expectedKey) {
    return { state: "unknown", reason: "invalid_response" };
  }
  if (body.state === "sent") {
    const delivery = isRecord(body.delivery) ? body.delivery : null;
    const result = delivery && isRecord(delivery.result) ? delivery.result : isRecord(body.result) ? body.result : null;
    return { state: "sent", messageId: messageIdFrom(result),
      ...(delivery?.ok === true && delivery.result === true ? { mutationConfirmed: true } : {}),
    };
  }
  if (body.state === "sending") return { state: "sending" };
  if (body.state === "unknown") return { state: "unknown", reason: "delivery_unknown" };
  if (body.state === "not_found") return { state: "not_found" };
  return { state: "unknown", reason: "invalid_response" };
};

const messageArgs = (
  inputId: string,
  requestRevision: string,
  draftRevision: number,
  message: RenderedInputMessage,
  deliveryKey: string,
  includeFocusId = false,
): Record<string, unknown> => ({
  input_id: inputId,
  request_revision: requestRevision,
  draft_revision: draftRevision,
  presentation_revision: message.presentationRevision ?? 0,
  ...(includeFocusId && typeof message.focusId === "string" ? { focus_id: message.focusId } : {}),
  question_id: message.questionId,
  text: message.text,
  buttons: message.buttons.map((row) => row.map((button) => ({
    label: button.label,
    action: button.action,
    ...(button.value === undefined ? {} : { value: button.value }),
  }))),
  delivery_key: deliveryKey,
});

const validateMessage = (message: RenderedInputMessage): boolean =>
  typeof message.text === "string" && message.text.length > 0 && message.text.length <= 4_000 &&
  (message.focusId === undefined || message.focusId === null || nonEmptyString(message.focusId, 128)) &&
  message.buttons.length <= 100 && message.buttons.every((row) => row.length > 0 && row.length <= 8 && row.every((button) =>
    typeof button.label === "string" && button.label.length > 0 && button.label.length <= 64 &&
    ["select", "deselect", "skip", "submit", "navigate", "edit_text", "review", "clear"].includes(button.action) &&
    (button.value === undefined || typeof button.value === "string" && button.value.length <= 2_048) &&
    ((button.action === "select" || button.action === "deselect" || button.action === "navigate" || button.action === "review")
      ? typeof button.value === "string"
      : button.value === undefined)));

const parseInputRequest = (value: unknown): InputRequestSnapshot => {
  const envelope = parseBody(value);
  const body = envelope.value;
  if (envelope.invalid || envelope.isError || !body || body.ok !== true || typeof body.active !== "boolean" ||
    !Array.isArray(body.messages) || body.messages.length > MAX_REQUEST_MESSAGES ||
    !Array.isArray(body.pending_delivery_keys) || body.pending_delivery_keys.length > MAX_REQUEST_MESSAGES) {
    throw new InputTelegramError("invalid_response");
  }
  const messages = body.messages.map((message) => {
    if (!isRecord(message) || !positiveInteger(message.message_id) || !nonEmptyString(message.delivery_key, 128)) {
      throw new InputTelegramError("invalid_response");
    }
    const state = message.state;
    if (state !== undefined && state !== "prepared" && state !== "sending" && state !== "unknown" &&
      state !== "recovered" && state !== "sent" && state !== "retired") throw new InputTelegramError("invalid_response");
    return {
      messageId: message.message_id,
      deliveryKey: message.delivery_key,
      ...(state === undefined ? {} : { state: state as NonNullable<InputRequestSnapshot["messages"][number]["state"]> }),
    };
  });
  const pendingDeliveryKeys = body.pending_delivery_keys.map((key) => {
    if (!nonEmptyString(key, 128)) throw new InputTelegramError("invalid_response");
    return key;
  });
  return { active: body.active, messages, pendingDeliveryKeys };
};

export const makeInputTelegramClient = (
  mcpxUrl: string,
  dependencies: InputTelegramClientDependencies = {},
): InputTelegramApi => {
  const url = parseUrl(mcpxUrl);
  const sessionFactory = dependencies.makeSession ?? makeSdkSession;
  const timeoutMs = dependencies.timeoutMs ?? REQUEST_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 120_000) {
    throw new InputTelegramError("invalid_url");
  }
  const call = (name: string, args: Record<string, unknown>): Promise<unknown> =>
    callTool(url, sessionFactory, name, args, timeoutMs);
  const mutationCall = async (name: string, args: Record<string, unknown>, expectedResult?: unknown): Promise<InputMutationResult> => {
    try { return mutationResult(await call(name, args), expectedResult); }
    catch (cause) {
      return { kind: "unknown", reason: cause instanceof SessionFailure ? cause.reason : "transport_error" };
    }
  };

  return {
    sendInputNotification: async (message, deliveryKey, messageId) => {
      if (!nonEmptyString(deliveryKey, 128) || !validateMessage(message) || message.buttons.length > 0 ||
        messageId !== undefined && !positiveInteger(messageId)) return { kind: "rejected", reason: "invalid_request" };
      try {
        const envelope = parseBody(await call(messageId === undefined ? "send_message" : "edit_message_text", {
          text: message.text, delivery_key: deliveryKey, ...(messageId === undefined ? {} : { message_id: messageId }),
        }));
        const body = envelope.value;
        if (envelope.invalid || !body) return { kind: "unknown", reason: "invalid_response" };
        if (body.ok === true && !envelope.isError) {
          const delivered = messageIdFrom(body.result);
          return delivered !== null && (messageId === undefined || delivered === messageId)
            ? { kind: "sent", messageId: delivered } : { kind: "unknown", reason: "invalid_response" };
        }
        return body.ok === false && isKnownNonExecution(body)
          ? { kind: "rejected", ...rejectionDetails(body) } : { kind: "unknown", reason: "mutation_uncertain" };
      } catch { return { kind: "unknown", reason: "transport_error" }; }
    },
    sendInputMessage: async (inputId, requestRevision, draftRevision, message, deliveryKey) => {
      if (!nonEmptyString(inputId, 128) || !nonEmptyString(requestRevision, 256) || !nonNegativeInteger(draftRevision) ||
        !nonEmptyString(deliveryKey, 128) || !validateMessage(message)) return { kind: "rejected", reason: "invalid_request" };
      try {
        const envelope = parseBody(await call("send_input_message", messageArgs(inputId, requestRevision, draftRevision, message, deliveryKey)));
        if (envelope.invalid || !envelope.value) return { kind: "unknown", reason: "invalid_response" };
        const body = envelope.value;
        if (body.ok === true && !envelope.isError) {
          const messageId = isRecord(body.result) ? messageIdFrom(body.result) : null;
          return messageId === null ? { kind: "unknown", reason: "invalid_response" } : { kind: "sent", messageId };
        }
        if (body.ok === false && isKnownNonExecution(body)) {
          return { kind: "rejected", ...rejectionDetails(body) };
        }
        return { kind: "unknown", reason: envelope.isError ? "mcp_error" : "mutation_uncertain" };
      } catch (cause) {
        return { kind: "unknown", reason: cause instanceof SessionFailure ? cause.reason : "transport_error" };
      }
    },
    editInputMessage: async (inputId, requestRevision, draftRevision, messageId, message, deliveryKey) => {
      if (!nonEmptyString(inputId, 128) || !nonEmptyString(requestRevision, 256) || !nonNegativeInteger(draftRevision) ||
        !positiveInteger(messageId) || !nonEmptyString(deliveryKey, 128) || !validateMessage(message)) {
        return { kind: "rejected", reason: "invalid_request" };
      }
      const args = {
        ...messageArgs(inputId, requestRevision, draftRevision, message, deliveryKey, true),
        message_id: messageId,
      };
      try {
        const envelope = parseBody(await call("edit_input_message", args));
        if (envelope.invalid || !envelope.value) return { kind: "unknown", reason: "invalid_response" };
        const body = envelope.value;
        if (body.ok === true && !envelope.isError) {
          const editedMessageId = isRecord(body.result) ? messageIdFrom(body.result) : null;
          return editedMessageId === messageId
            ? { kind: "sent", messageId }
            : { kind: "unknown", reason: "invalid_response" };
        }
        if (body.ok === false && isKnownNonExecution(body)) return { kind: "rejected", ...rejectionDetails(body) };
        return { kind: "unknown", reason: envelope.isError ? "mcp_error" : "mutation_uncertain" };
      } catch (cause) {
        return { kind: "unknown", reason: cause instanceof SessionFailure ? cause.reason : "transport_error" };
      }
    },
    readInputInbox: async (limit) => {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_EVENTS) throw new InputTelegramError("invalid_response");
      let result: unknown;
      try { result = await call("read_input_inbox", { limit }); }
      catch (cause) { throw new InputTelegramError(cause instanceof SessionFailure && cause.reason === "timeout" ? "timeout" : "connection_failed"); }
      const envelope = parseBody(result);
      if (envelope.invalid || envelope.isError || !envelope.value || envelope.value.ok !== true ||
        !Array.isArray(envelope.value.events) || envelope.value.events.length > limit) throw new InputTelegramError("invalid_response");
      const events = envelope.value.events.map(parseEvent);
      for (const event of events) {
        if (!event.contributionId || !/^[1-9][0-9]*$/u.test(event.contributionId) || event.edited === true) continue;
        const messageId = Number(event.contributionId);
        if (!positiveInteger(messageId)) continue;
        const key = `telegram-${event.updateId}-received-1`;
        try {
          const prior = parseBody(await call("get_delivery_status", { delivery_key: key }));
          const body = prior.value;
          if (prior.invalid || prior.isError || !body || body.ok !== true || body.delivery_key !== key) {
            dependencies.onReceiptFailure?.(key);
            continue;
          }
          if (body.state === "sent" && isRecord(body.delivery) && body.delivery.ok === true && body.delivery.result === true) continue;
          if (body.state !== "not_found") { dependencies.onReceiptFailure?.(key); continue; }
          const received = await mutationCall("set_message_reaction", { message_id: messageId, emoji: "👍", delivery_key: key }, true);
          if (received.kind !== "done") {
            await call("get_delivery_status", { delivery_key: key });
            dependencies.onReceiptFailure?.(key);
          }
        } catch { dependencies.onReceiptFailure?.(key); }
      }
      return events;
    },
    acknowledgeInputEvents: (eventIds, deliveryKey) => {
      if (eventIds.length === 0 || eventIds.length > MAX_EVENTS || !eventIds.every((id) => nonEmptyString(id, 256))) {
        return Promise.resolve({ kind: "rejected", reason: "invalid_request" });
      }
      if (!nonEmptyString(deliveryKey, 128)) return Promise.resolve({ kind: "rejected", reason: "invalid_request" });
      return mutationCall("ack_input_events", { event_ids: eventIds, delivery_key: deliveryKey }, true);
    },
    getInputRequest: async (inputId, requestRevision) => {
      if (!nonEmptyString(inputId, 128) || !nonEmptyString(requestRevision, 256)) throw new InputTelegramError("invalid_response");
      let result: unknown;
      try { result = await call("get_input_request", { input_id: inputId, request_revision: requestRevision }); }
      catch (cause) { throw new InputTelegramError(cause instanceof SessionFailure && cause.reason === "timeout" ? "timeout" : "connection_failed"); }
      return parseInputRequest(result);
    },
    retireInputRequest: (inputId, requestRevision, deliveryKey) => {
      if (!nonEmptyString(inputId, 128) || !nonEmptyString(requestRevision, 256) || !nonEmptyString(deliveryKey, 128)) {
        return Promise.resolve({ kind: "rejected", reason: "invalid_request" });
      }
      return mutationCall("retire_input_request", {
        input_id: inputId,
        request_revision: requestRevision,
        delivery_key: deliveryKey,
      }, true);
    },
    deleteMessage: (messageId, deliveryKey) => {
      if (!positiveInteger(messageId) || !nonEmptyString(deliveryKey, 128)) {
        return Promise.resolve({ kind: "rejected", reason: "invalid_request" });
      }
      return mutationCall("delete_message", { message_id: messageId, delivery_key: deliveryKey }, true);
    },
    getDeliveryStatus: async (deliveryKey) => {
      if (!nonEmptyString(deliveryKey, 128)) return { state: "unknown", reason: "invalid_request" };
      try { return deliveryState(await call("get_delivery_status", { delivery_key: deliveryKey }), deliveryKey); }
      catch (cause) {
        return { state: "unknown", reason: cause instanceof SessionFailure ? cause.reason : "transport_error" };
      }
    },
  };
};

export const inputTelegramInternals = {
  parseEvent,
  parseInputRequest,
  validateMessage,
};
