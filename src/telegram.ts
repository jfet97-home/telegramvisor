import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Context, Effect, Layer } from "effect";

const BOT_INFO_TOOL = "raspfet-telegram-t3__get_bot_info";
const SEND_MESSAGE_TOOL = "raspfet-telegram-t3__send_message";
const DELIVERY_STATUS_TOOL = "raspfet-telegram-t3__get_delivery_status";
const MAX_MCP_RESPONSE_BYTES = 32 * 1024;
const REQUEST_TIMEOUT_MS = 15_000;

export type TelegramErrorCode = "invalid_url" | "invalid_request" | "connection_failed" | "invalid_response" | "timeout";

export class TelegramError extends Error {
  readonly _tag = "TelegramError";

  constructor(readonly code: TelegramErrorCode) {
    super("The Telegram operation could not be completed.");
    this.name = "TelegramError";
  }
}

export interface BotInfo {
  readonly id: number;
  readonly isBot: true;
  readonly firstName: string;
  readonly username: string | null;
}

export type SendResult =
  | { readonly kind: "sent"; readonly messageId: number }
  | { readonly kind: "rejected"; readonly reason: "telegram_rejected" | "telegram_not_sent"; readonly telegramCode: number | null }
  | { readonly kind: "unknown"; readonly reason: string };

export type DeliveryStatus =
  | { readonly state: "sent"; readonly messageId: number | null }
  | { readonly state: "sending" }
  | { readonly state: "unknown"; readonly reason: string }
  | { readonly state: "not_found" };

export interface TelegramClientApi {
  readonly getBotInfo: () => Effect.Effect<BotInfo, TelegramError>;
  readonly getDeliveryStatus: (deliveryKey: string) => Effect.Effect<DeliveryStatus>;
  readonly sendMessage: (deliveryKey: string, text: string) => Effect.Effect<SendResult>;
}

export class TelegramClient extends Context.Service<TelegramClient, TelegramClientApi>()("TelegramClient") {}

export interface McpSession {
  readonly connect: () => Promise<void>;
  readonly callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  readonly close: () => Promise<void>;
}

export interface TelegramClientDependencies {
  readonly makeSession?: (url: URL) => McpSession;
  readonly timeoutMs?: number | undefined;
}

interface ToolEnvelope {
  readonly isError: boolean;
  readonly value: Record<string, unknown> | undefined;
  readonly failure: "invalid_response" | null;
}

class SessionFailure extends Error {
  constructor(readonly reason: "timeout" | "transport_error") {
    super("The MCP request did not complete.");
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const utf8Bytes = (value: string): number => Buffer.byteLength(value, "utf8");

const parseToolEnvelope = (value: unknown): ToolEnvelope => {
  if (!isRecord(value)) return { isError: true, value: undefined, failure: "invalid_response" };
  const isError = value.isError === true;
  if (isRecord(value.structuredContent)) {
    try {
      const size = Buffer.byteLength(JSON.stringify(value.structuredContent), "utf8");
      if (size <= MAX_MCP_RESPONSE_BYTES) return { isError, value: value.structuredContent, failure: null };
    } catch {
      return { isError: true, value: undefined, failure: "invalid_response" };
    }
    return { isError: true, value: undefined, failure: "invalid_response" };
  }
  if (!Array.isArray(value.content)) return { isError, value: undefined, failure: "invalid_response" };
  for (const item of value.content) {
    if (!isRecord(item) || item.type !== "text" || typeof item.text !== "string") continue;
    if (utf8Bytes(item.text) > MAX_MCP_RESPONSE_BYTES) return { isError: true, value: undefined, failure: "invalid_response" };
    try {
      const parsed: unknown = JSON.parse(item.text);
      if (isRecord(parsed)) return { isError, value: parsed, failure: null };
    } catch {
      return { isError: true, value: undefined, failure: "invalid_response" };
    }
  }
  return { isError, value: undefined, failure: "invalid_response" };
};

const parseMcpUrl = (value: string): URL => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TelegramError("invalid_url");
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) {
    throw new TelegramError("invalid_url");
  }
  return url;
};

const makeSdkSession = (url: URL): McpSession => {
  const transport = new StreamableHTTPClientTransport(url);
  const client = new Client({ name: "telegramvisor", version: "0.1.0" });
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
  signal: AbortSignal,
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
  const timers: { timeout: NodeJS.Timeout | undefined } = { timeout: undefined };
  const close = (): Promise<void> => {
    if (!closing) {
      try {
        closing = Promise.resolve(session.close()).catch(() => undefined);
      } catch {
        closing = Promise.resolve();
      }
    }
    return closing;
  };
  const finish = (result: { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly error: SessionFailure }): void => {
    if (settled) return;
    settled = true;
    if (timers.timeout) clearTimeout(timers.timeout);
    signal.removeEventListener("abort", onAbort);
    void close().then(() => {
      if (result.ok) resolve(result.value);
      else reject(result.error);
    });
  };
  const onAbort = (): void => finish({ ok: false, error: new SessionFailure("transport_error") });

  if (signal.aborted) {
    onAbort();
    return;
  }
  signal.addEventListener("abort", onAbort, { once: true });
  timers.timeout = setTimeout(() => finish({ ok: false, error: new SessionFailure("timeout") }), timeoutMs);
  timers.timeout.unref();

  void (async () => {
    await session.connect();
    if (settled || signal.aborted) return;
    const result = await session.callTool(name, args);
    finish({ ok: true, value: result });
  })().catch(() => finish({ ok: false, error: new SessionFailure("transport_error") }));
});

const connectionError = (cause: unknown): TelegramError => {
  if (cause instanceof TelegramError) return cause;
  if (cause instanceof SessionFailure && cause.reason === "timeout") return new TelegramError("timeout");
  return new TelegramError("connection_failed");
};

const safeEffect = <A>(operation: (signal: AbortSignal) => Promise<A>) => Effect.tryPromise({
  try: operation,
  catch: connectionError,
});

const parseBotInfo = (result: unknown): BotInfo => {
  const envelope = parseToolEnvelope(result);
  const body = envelope.value;
  if (envelope.isError || !body || body.ok !== true || !isRecord(body.result)) {
    throw new TelegramError("invalid_response");
  }
  const raw = body.result;
  if (!Number.isSafeInteger(raw.id) || Number(raw.id) <= 0 || raw.is_bot !== true || typeof raw.first_name !== "string") {
    throw new TelegramError("invalid_response");
  }
  return {
    id: Number(raw.id),
    isBot: true,
    firstName: raw.first_name,
    username: typeof raw.username === "string" ? raw.username : null,
  };
};

const messageIdFrom = (value: unknown): number | null =>
  isRecord(value) && Number.isSafeInteger(value.message_id) && Number(value.message_id) > 0
    ? Number(value.message_id)
    : null;

export const isConfirmedNotSent = (body: Record<string, unknown>): boolean =>
  body.ok === false && body.error === "telegram_not_sent" && body.delivery_state === "rejected" &&
  body.confirmed_not_delivered === true && body.delivery_may_have_completed === false &&
  body.failure_stage === "connect";

const parseSendResult = (result: unknown): SendResult => {
  const envelope = parseToolEnvelope(result);
  const body = envelope.value;
  if (!body) return { kind: "unknown", reason: envelope.failure ?? "invalid_response" };
  if (isConfirmedNotSent(body)) {
    return { kind: "rejected", reason: "telegram_not_sent", telegramCode: null };
  }
  if (body.ok === false && body.error === "telegram_rejected") {
    const telegramCode = Number.isSafeInteger(body.telegram_code) ? Number(body.telegram_code) : null;
    return { kind: "rejected", reason: "telegram_rejected", telegramCode };
  }
  if (envelope.isError) {
    return {
      kind: "unknown",
      reason: typeof body.error === "string" && body.error === "journal_completion_failed"
        ? "journal_completion_failed"
        : "mcp_error",
    };
  }
  if (body.ok !== true) {
    return {
      kind: "unknown",
      reason: body.error === "journal_completion_failed" ? "journal_completion_failed" : "mcp_error",
    };
  }
  const messageId = isRecord(body.result) ? messageIdFrom(body.result) : null;
  return messageId === null ? { kind: "unknown", reason: "missing_message_id" } : { kind: "sent", messageId };
};

const parseDeliveryStatus = (result: unknown): DeliveryStatus => {
  const envelope = parseToolEnvelope(result);
  const body = envelope.value;
  if (envelope.isError || !body || body.ok !== true) {
    const reason = body?.error === "journal_completion_failed"
      ? "journal_completion_failed"
      : envelope.failure ?? "mcp_error";
    return { state: "unknown", reason };
  }
  if (body.state === "sending") return { state: "sending" };
  if (body.state === "not_found") return { state: "not_found" };
  if (body.state === "unknown") return { state: "unknown", reason: "delivery_unknown" };
  if (body.state === "sent") {
    const delivery = isRecord(body.delivery) ? body.delivery : undefined;
    const message = delivery && isRecord(delivery.result) ? delivery.result : undefined;
    return { state: "sent", messageId: messageIdFrom(message) };
  }
  return { state: "unknown", reason: "invalid_response" };
};

const validDeliveryKey = (value: string): boolean => /^[A-Za-z0-9_.:-]{1,128}$/u.test(value);
const isValidText = (value: string): boolean => {
  if (value.trim().length === 0 || value.length > 4096) return false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
};

export const makeTelegramClient = (
  mcpxUrl: string,
  dependencies: TelegramClientDependencies = {},
): TelegramClientApi => {
  const url = parseMcpUrl(mcpxUrl);
  const sessionFactory = dependencies.makeSession ?? makeSdkSession;
  const timeoutMs = Math.max(1, Math.min(dependencies.timeoutMs ?? REQUEST_TIMEOUT_MS, REQUEST_TIMEOUT_MS));

  return {
    getBotInfo: () => safeEffect(async (signal) =>
      parseBotInfo(await callTool(url, sessionFactory, BOT_INFO_TOOL, {}, signal, timeoutMs))),
    getDeliveryStatus: (deliveryKey) => {
      if (!validDeliveryKey(deliveryKey)) {
        return Effect.succeed<DeliveryStatus>({ state: "unknown", reason: "invalid_request" });
      }
      return Effect.tryPromise({
        try: (signal) => callTool(url, sessionFactory, DELIVERY_STATUS_TOOL, { delivery_key: deliveryKey }, signal, timeoutMs),
        catch: connectionError,
      }).pipe(
        Effect.map(parseDeliveryStatus),
        Effect.catch((error) => Effect.succeed<DeliveryStatus>({
          state: "unknown",
          reason: error.code === "timeout" ? "timeout" : "transport_error",
        })),
      );
    },
    sendMessage: (deliveryKey, text) => {
      if (!validDeliveryKey(deliveryKey) || !isValidText(text)) {
        return Effect.succeed<SendResult>({ kind: "unknown", reason: "invalid_request" });
      }
      return Effect.tryPromise({
        try: (signal) => callTool(url, sessionFactory, SEND_MESSAGE_TOOL, { text, delivery_key: deliveryKey }, signal, timeoutMs),
        catch: connectionError,
      }).pipe(
        Effect.map(parseSendResult),
        Effect.catch((error) => Effect.succeed<SendResult>({
          kind: "unknown",
          reason: error.code === "timeout" ? "timeout" : "transport_error",
        })),
      );
    },
  };
};

export const telegramClientLayer = (mcpxUrl: string, dependencies: TelegramClientDependencies = {}) =>
  Layer.succeed(TelegramClient, makeTelegramClient(mcpxUrl, dependencies));
