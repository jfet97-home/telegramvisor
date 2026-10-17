import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { Effect } from "effect";
import {
  McpSession,
  TelegramClientDependencies,
  makeTelegramClient,
} from "../src/telegram.js";

interface ToolCall {
  readonly url: string;
  name: string;
  args: Record<string, unknown>;
  connected: boolean;
  closed: boolean;
}

interface Behavior {
  readonly result?: unknown;
  readonly callTool?: () => Promise<unknown>;
  readonly connect?: () => Promise<void>;
}

const mcpxUrl = "http://mcpx:9000/mcp/lazy";

const createDependencies = (
  behaviors: readonly Behavior[],
  calls: ToolCall[],
  timeoutMs?: number,
): TelegramClientDependencies => {
  let nextBehavior = 0;
  return {
    timeoutMs,
    makeSession: (url): McpSession => {
      const behavior = behaviors[nextBehavior] ?? {};
      nextBehavior += 1;
      const call: ToolCall = { url: url.href, name: "", args: {}, connected: false, closed: false };
      calls.push(call);
      return {
        connect: async () => {
          call.connected = true;
          await behavior.connect?.();
        },
        callTool: async (name, args) => {
          call.name = name;
          call.args = args;
          return behavior.callTool ? behavior.callTool() : behavior.result;
        },
        close: async () => { call.closed = true; },
      };
    },
  };
};

const success = (result: Record<string, unknown>) => ({
  isError: false,
  structuredContent: { ok: true, ...result },
});

const textSuccess = (result: Record<string, unknown>) => ({
  isError: false,
  content: [{ type: "text", text: JSON.stringify({ ok: true, ...result }) }],
});

test("the real SDK routes upstream calls through the lazy MCPX wrapper", async () => {
  const wireCalls: Array<Record<string, unknown>> = [];
  const server = createServer(async (request, response) => {
    if (request.method !== "POST") { response.writeHead(405).end(); return; }
    let raw = "";
    for await (const chunk of request) raw += String(chunk);
    const envelope = JSON.parse(raw) as { id?: string | number; method: string; params?: Record<string, unknown> };
    if (envelope.id === undefined) { response.writeHead(202).end(); return; }
    let result: Record<string, unknown>;
    if (envelope.method === "initialize") {
      result = { protocolVersion: envelope.params?.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "test-lazy-gateway", version: "1" } };
    } else {
      wireCalls.push(envelope.params ?? {});
      result = success({ result: { id: 12345, is_bot: true, first_name: "T3", username: "t3_bot" } });
    }
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ jsonrpc: "2.0", id: envelope.id, result }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No test address");
    const client = makeTelegramClient(`http://127.0.0.1:${address.port}/mcp/lazy`);
    const info = await Effect.runPromise(client.getBotInfo());
    assert.equal(info.id, 12345);
    assert.deepEqual(wireCalls, [{ name: "mcpx_call_tool", arguments: { name: "raspfet-telegram-t3__get_bot_info", arguments: {} } }]);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("reads and validates bot identity through the prefixed MCPX tool", async () => {
  const calls: ToolCall[] = [];
  const client = makeTelegramClient(mcpxUrl, createDependencies([
    { result: success({ result: { id: 12345, is_bot: true, first_name: "T3", username: "t3_bot" } }) },
  ], calls));

  const identity = await Effect.runPromise(client.getBotInfo());
  assert.deepEqual(identity, { id: 12345, isBot: true, firstName: "T3", username: "t3_bot" });
  assert.equal(calls[0]?.url, mcpxUrl);
  assert.equal(calls[0]?.name, "raspfet-telegram-t3__get_bot_info");
  assert.deepEqual(calls[0]?.args, {});
  assert.equal(calls[0]?.connected, true);
  assert.equal(calls[0]?.closed, true);
});

test("accepts a successful send only when outer MCP and inner bridge both succeed", async () => {
  const calls: ToolCall[] = [];
  const text = "Final recap 📦";
  const client = makeTelegramClient(mcpxUrl, createDependencies([
    { result: textSuccess({ result: { message_id: 42 } }) },
    { result: { isError: true, structuredContent: { ok: true, result: { message_id: 43 } } } },
    { result: { isError: true, structuredContent: { ok: false, error: "journal_completion_failed", delivery_may_have_completed: true } } },
  ], calls));

  assert.deepEqual(await Effect.runPromise(client.sendMessage("job-1-reply-1", text)), { kind: "sent", messageId: 42 });
  assert.equal(calls[0]?.name, "raspfet-telegram-t3__send_message");
  assert.deepEqual(calls[0]?.args, { text, delivery_key: "job-1-reply-1" });
  assert.deepEqual(await Effect.runPromise(client.sendMessage("job-1-reply-2", text)), { kind: "unknown", reason: "mcp_error" });
  assert.deepEqual(await Effect.runPromise(client.sendMessage("job-1-reply-3", text)), { kind: "unknown", reason: "journal_completion_failed" });
  assert.ok(calls.every((call) => call.closed));
});

test("reports only a proven Telegram rejection as rejected", async () => {
  const calls: ToolCall[] = [];
  const client = makeTelegramClient(mcpxUrl, createDependencies([
    { result: { isError: true, structuredContent: { ok: false, error: "telegram_rejected", telegram_code: 429 } } },
    { result: { isError: true, structuredContent: { ok: false, error: "telegram_delivery_unknown", delivery_may_have_completed: true } } },
  ], calls));

  assert.deepEqual(await Effect.runPromise(client.sendMessage("stable-key-1", "hello")), {
    kind: "rejected",
    reason: "telegram_rejected",
    telegramCode: 429,
  });
  assert.deepEqual(await Effect.runPromise(client.sendMessage("stable-key-2", "hello")), {
    kind: "unknown",
    reason: "mcp_error",
  });
});

test("maps all ledger states and keeps not_found distinct from a safe replay", async () => {
  const calls: ToolCall[] = [];
  const client = makeTelegramClient(mcpxUrl, createDependencies([
    { result: success({ delivery_key: "same", state: "sent", delivery: { ok: true, result: { message_id: 51 } } }) },
    { result: success({ delivery_key: "same", state: "sending" }) },
    { result: success({ delivery_key: "same", state: "unknown" }) },
    { result: success({ delivery_key: "same", state: "not_found" }) },
    { result: { isError: true, structuredContent: { ok: false, error: "operation_failed" } } },
  ], calls));

  assert.deepEqual(await Effect.runPromise(client.getDeliveryStatus("same")), { state: "sent", messageId: 51 });
  assert.deepEqual(await Effect.runPromise(client.getDeliveryStatus("same")), { state: "sending" });
  assert.deepEqual(await Effect.runPromise(client.getDeliveryStatus("same")), { state: "unknown", reason: "delivery_unknown" });
  assert.deepEqual(await Effect.runPromise(client.getDeliveryStatus("same")), { state: "not_found" });
  assert.deepEqual(await Effect.runPromise(client.getDeliveryStatus("same")), { state: "unknown", reason: "mcp_error" });
  assert.ok(calls.every((call) => call.name === "raspfet-telegram-t3__get_delivery_status"));
  assert.ok(calls.every((call) => call.args.delivery_key === "same"));
});

test("preserves response-size and UTF-16 request limits without calling MCPX", async () => {
  const calls: ToolCall[] = [];
  const client = makeTelegramClient(mcpxUrl, createDependencies([
    { result: { isError: false, structuredContent: { ok: true, state: "sent", padding: "x".repeat(40_000) } } },
  ], calls));

  assert.deepEqual(await Effect.runPromise(client.getDeliveryStatus("key")), { state: "unknown", reason: "invalid_response" });
  assert.deepEqual(await Effect.runPromise(client.sendMessage("key", "😀".repeat(2049))), { kind: "unknown", reason: "invalid_request" });
  assert.deepEqual(await Effect.runPromise(client.sendMessage("invalid/key", "hello")), { kind: "unknown", reason: "invalid_request" });
  assert.equal(calls.length, 1);
});

test("closes the scoped MCP session and reports timeout as uncertain delivery", async () => {
  const calls: ToolCall[] = [];
  const hold = new Promise<unknown>(() => undefined);
  const client = makeTelegramClient(mcpxUrl, createDependencies([{ callTool: () => hold }], calls, 10));
  const keepAlive = setTimeout(() => undefined, 100);

  assert.deepEqual(await Effect.runPromise(client.sendMessage("timeout-key", "hello")), { kind: "unknown", reason: "timeout" });
  clearTimeout(keepAlive);
  assert.equal(calls[0]?.closed, true);
});

test("closes the MCP session on effect cancellation", async () => {
  const calls: ToolCall[] = [];
  let started: (() => void) | undefined;
  const startedPromise = new Promise<void>((resolve) => { started = resolve; });
  const hold = new Promise<unknown>(() => undefined);
  const client = makeTelegramClient(mcpxUrl, createDependencies([{
    callTool: () => {
      started?.();
      return hold;
    },
  }], calls));
  const controller = new AbortController();
  const pending = Effect.runPromise(client.sendMessage("cancel-key", "hello"), { signal: controller.signal });

  await startedPromise;
  controller.abort();
  await assert.rejects(pending);
  assert.equal(calls[0]?.closed, true);
});

test("rejects MCP URLs with embedded credentials", () => {
  assert.throws(() => makeTelegramClient("http://user:secret@mcpx:9000/mcp/lazy"));
});

test("pre-send connection proof permits retry without treating uncertainty as rejection", async () => {
  const proof = {
    ok: false, error: "telegram_not_sent", delivery_state: "rejected",
    confirmed_not_delivered: true, delivery_may_have_completed: false,
    failure_stage: "connect", failure_kind: "dns_failure", transport_attempts: 3,
  };
  const bodies = [
    proof,
    { ...proof, confirmed_not_delivered: undefined },
    { ...proof, delivery_may_have_completed: true },
    { ...proof, failure_stage: "request_or_response" },
    { ...proof, error: "journal_completion_failed" },
  ];
  const calls: ToolCall[] = [];
  const client = makeTelegramClient(mcpxUrl, createDependencies(bodies.map((body) => ({
    result: { isError: true, structuredContent: body },
  })), calls));
  assert.deepEqual(await Effect.runPromise(client.sendMessage("stable-connect-key", "original")), {
    kind: "rejected", reason: "telegram_not_sent", telegramCode: null,
  });
  for (let index = 1; index < bodies.length; index++) {
    assert.equal((await Effect.runPromise(client.sendMessage("stable-connect-key", "original"))).kind, "unknown");
  }
  assert.ok(calls.every((call) => JSON.stringify(call.args).includes("stable-connect-key")));
});
