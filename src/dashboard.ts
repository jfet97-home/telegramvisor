import {createServer, type IncomingMessage, type ServerResponse} from "node:http";
import {randomBytes, timingSafeEqual} from "node:crypto";
import {readFile} from "node:fs/promises";
import {existsSync} from "node:fs";
import {DatabaseSync} from "node:sqlite";
import {extname, join, resolve, sep} from "node:path";
import {Effect} from "effect";
import {createServiceAuth} from "./service-auth.js";
import {currentRecapSettings} from "./recap-settings.js";
import {CompletionRecovery} from "./completion-recovery.js";
import {makeNativeRpc} from "./native-rpc.js";
import {isManagedThread} from "./managed-threads.js";
import {readiness, type TelegramvisorStatus} from "./coordinator.js";
import type {StoreShape} from "./store.js";
import type {T3ClientShape} from "./t3.js";
import type {TelegramvisorActivity, TelegramvisorConfig} from "./types.js";

class BodyLimitError extends Error {}
const readBody = async (request: IncomingMessage, limit = 2048): Promise<unknown> => {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request.iterator({destroyOnReturn: false})) {
    const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    bytes += part.length;
    if (bytes > limit) {request.resume();throw new BodyLimitError();}
    chunks.push(part);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
};
const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const equal = (left: string, right: string) => {
  const a = Buffer.from(left);const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
};

/** Reads retained input history without changing delivery or submission state. */
export const readInputHistory = (directory: string): TelegramvisorActivity[] => {
  const items: TelegramvisorActivity[] = [];
  const base = (id: string, kind: string, threadId: string | null, state: string, reason: string, detail: unknown, at: number): TelegramvisorActivity => ({
    id, kind, threadId, runId: null, ruleId: null, state, reason, detail: JSON.stringify(detail), createdAt: at,
  });
  const inputPath = join(directory, "telegram-input.sqlite3");
  if (existsSync(inputPath)) {
    const db = new DatabaseSync(inputPath, {readOnly: true});
    try {
      const rows = db.prepare(`SELECT r.thread_id,r.native_request_id,r.submission_state,r.lifecycle,r.updated_at,
        m.delivery_key,m.state,m.cleanup_state,m.cleanup_error,m.message_id FROM input_requests r LEFT JOIN input_messages m
        ON m.input_id=r.input_id AND m.request_revision=r.request_revision ORDER BY r.updated_at DESC LIMIT 100`).all();
      for (const row of rows) items.push(base(`input:${String(row.delivery_key ?? row.native_request_id)}`, "native_question", String(row.thread_id),
        row.cleanup_state === "unknown" ? "cleanup_uncertain" : row.cleanup_state === "expired" ? "cleanup_expired" : String(row.submission_state),
        String(row.lifecycle), {requestId: row.native_request_id, submission: row.submission_state, cardDelivery: row.state,
          cleanup: row.cleanup_state, cleanupError: row.cleanup_error, messageId: row.message_id}, Number(row.updated_at)));
      if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='input_cleanup_history'").get()) {
        for (const row of db.prepare("SELECT * FROM input_cleanup_history ORDER BY recorded_at DESC LIMIT 100").all()) {
          items.push(base(`cleanup:${String(row.delivery_key)}`, "native_question_cleanup", row.thread_id === null ? null : String(row.thread_id),
            row.reason === "send_unconfirmed_expired" ? "delivery_uncertain_expired" : "cleanup_expired", String(row.reason),
            {deliveryKey: row.delivery_key, cleanupKey: row.cleanup_key, messageId: row.message_id, confirmed: false}, Number(row.recorded_at)));
        }
      }
    } finally {db.close();}
  }
  const repliesPath = join(directory, "telegram-input-replies.sqlite3");
  if (existsSync(repliesPath)) {
    const db = new DatabaseSync(repliesPath, {readOnly: true});
    try {
      for (const row of db.prepare("SELECT message_id,input_id,revision,delivery_key,state,created_at,ready FROM replies ORDER BY created_at DESC LIMIT 100").all()) {
        items.push(base(`reply:${String(row.message_id)}`, "native_reply_cleanup", null, String(row.state),
          row.ready === 1 ? "cleanup_authorized" : "unsubmitted_text_retained",
          {inputId: row.input_id, revision: row.revision, messageId: row.message_id, deliveryKey: row.delivery_key}, Number(row.created_at)));
      }
    } finally {db.close();}
  }
  return items;
};

export interface DashboardDependencies {store: StoreShape; t3: T3ClientShape; status: TelegramvisorStatus}

export const startDashboard = async (config: TelegramvisorConfig, {store, t3, status}: DashboardDependencies) => {
  const auth = await createServiceAuth(config.dataDirectory);
  const csrf = randomBytes(32).toString("base64url");
  const assets = resolve(config.uiAssetsDirectory ?? "ui-dist");
  const controllers = new Set<AbortController>();
  let recovery: CompletionRecovery | undefined;
  if (config.t3OperateTokenFile && existsSync(config.t3OperateTokenFile) && t3.boundedCompletionProjection &&
    store.completionGap && store.reserveCompletionRecovery && store.finishCompletionRecovery) {
    const token = (await readFile(config.t3OperateTokenFile, "utf8")).trim();
    if (token) recovery = new CompletionRecovery({
      readProjection: async (id, signal) => (await Effect.runPromise(t3.boundedCompletionProjection!(id), {signal})).projection,
      nativeRpc: makeNativeRpc(config.t3Url, token),
      operations: {
        findByGapId: async id => (await Effect.runPromise(store.completionGap!(id)))?.recovery ?? null,
        reserveOnce: operation => Effect.runPromise(store.reserveCompletionRecovery!(operation)),
        finish: (id, command, outcome) => Effect.runPromise(store.finishCompletionRecovery!(id, command, outcome)),
      },
      isGapActionable: async (id, threadId) => (await Effect.runPromise(store.completionGap!(id)))?.threadId === threadId,
      isThreadAllowed: async id => {
        if (!config.telegramEnabled) return false;
        if (!t3.threadShells) return false;
        const thread = (await Effect.runPromise(t3.threadShells())).find(thread => thread.id === id);
        return thread !== undefined && !isManagedThread(config, thread);
      },
    });
  }
  const server = createServer((request, response) => {
    const controller = new AbortController();controllers.add(controller);
    const abort = () => {if (!response.writableEnded) controller.abort();};
    response.once("close", abort);
    void handle(request, response, controller.signal).catch(error => {
      if (!response.headersSent) response.writeHead(error instanceof BodyLimitError ? 413 : 500, {"Content-Type": "application/json", "Cache-Control": "no-store"});
      response.end(JSON.stringify({message: error instanceof BodyLimitError ? "Request is too large." : "The operation could not be confirmed. Refresh before trying again."}));
    }).finally(() => {controllers.delete(controller);response.off("close", abort);});
  });
  server.headersTimeout = 10_000;server.requestTimeout = 25_000;
  server.maxRequestsPerSocket = 100;
  const handle = async (request: IncomingMessage, response: ServerResponse, signal: AbortSignal): Promise<void> => {
    const address = server.address();const port = typeof address === "object" && address ? address.port : config.uiPort;
    const origin = `http://127.0.0.1:${port}`;
    const url = new URL(request.url ?? "/", origin);
    const headers: Record<string, string> = {"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY",
      "Referrer-Policy": "no-referrer", "Cross-Origin-Resource-Policy": "same-origin", Vary: "Sec-Fetch-Dest, Sec-Fetch-Mode, Sec-Fetch-Site, Sec-Fetch-User"};
    const send = (code: number, value: unknown) => {response.writeHead(code, {...headers, "Content-Type": "application/json"});response.end(JSON.stringify(value));};
    const navigate = request.method === "GET" && ["/", "/index.html"].includes(url.pathname) && request.headers["sec-fetch-mode"] === "navigate" &&
      request.headers["sec-fetch-dest"] === "document" && request.headers["sec-fetch-user"] === "?1";
    if (request.headers.host !== `127.0.0.1:${port}` || request.headers.origin && request.headers.origin !== origin ||
      request.headers["sec-fetch-site"] === "cross-site" && !navigate) {send(403, {message: "Open Telegramvisor through its loopback address."});return;}
    const raw = request.headers["x-telegramvisor-session"];const session = typeof raw === "string" ? raw : undefined;
    const json = request.headers["content-type"]?.split(";", 1)[0]?.trim() === "application/json";
    if (url.pathname.startsWith("/auth/")) {
      if (url.pathname === "/auth/status" && request.method === "GET") {send(200, {authenticated: auth.authenticated(session)});return;}
      if (request.method !== "POST" || !["/auth/login", "/auth/logout"].includes(url.pathname)) {send(404, {message: "Not found."});return;}
      if (request.headers.origin !== origin || !json) {send(403, {message: "Use the Telegramvisor sign-in page."});return;}
      if (url.pathname === "/auth/logout") {auth.logout(session);send(200, {authenticated: false});return;}
      let payload: unknown;try {payload = await readBody(request);} catch (error) {if (error instanceof BodyLimitError) throw error;send(400, {message: "Invalid sign-in request."});return;}
      const next = auth.login(record(payload) && typeof payload.token === "string" ? payload.token : "");
      if (!next) {send(401, {message: "The access token is invalid or expired."});return;}
      auth.logout(session);send(200, {authenticated: true, session: next});return;
    }
    if (url.pathname.startsWith("/api/")) {
      if (!auth.authenticated(session)) {send(401, {message: "Sign in to Telegramvisor."});return;}
      if (request.method !== "GET" && (request.headers.origin !== origin || typeof request.headers["x-csrf-token"] !== "string" || !equal(request.headers["x-csrf-token"], csrf))) {
        send(403, {message: "Refresh the dashboard before making changes."});return;
      }
      if (request.method !== "GET" && !json) {send(415, {message: "Use JSON for changes."});return;}
      if (url.pathname === "/api/csrf" && request.method === "GET") {send(200, {csrf});return;}
      if (url.pathname === "/api/snapshot" && request.method === "GET") {
        const catalog = await Effect.runPromise(store.catalog(), {signal});
        const shells = t3.threadShells ? await Effect.runPromise(t3.threadShells(), {signal}) : catalog.threads;
        const history = [...await Effect.runPromise(store.history(), {signal}), ...readInputHistory(config.dataDirectory)].sort((a,b) => b.createdAt-a.createdAt).slice(0, 200);
        send(200, {status: {...status, readiness: readiness(status, config)}, enabled: config.telegramEnabled, inputEnabled: config.inputEnabled,
          threads: shells.filter(thread => thread.lineage?.relationshipToParent !== "subagent" && !isManagedThread(config, thread)),
          recapSettings: currentRecapSettings(config), history});return;
      }
      if (url.pathname === "/api/recap-settings" && request.method === "POST") {
        if (!config.recapSettings) {send(409, {message: "Recap settings are unavailable."});return;}
        let payload: unknown;try {payload = await readBody(request);} catch (error) {if (error instanceof BodyLimitError) throw error;send(400, {message: "Choose valid recap settings."});return;}
        if (!record(payload) || typeof payload.enabled !== "boolean" || typeof payload.generation !== "number" ||
          !Number.isSafeInteger(payload.generation) || payload.generation < 1) {send(400, {message: "Choose valid recap settings."});return;}
        try {send(200, config.recapSettings.save({generation: payload.generation, enabled: payload.enabled}));}
        catch {send(409, {message: "Recap settings changed. Refresh before trying again."});}return;
      }
      if (url.pathname === "/api/completion-gaps" && request.method === "GET") {
        const gaps = store.completionGaps ? await Effect.runPromise(store.completionGaps(), {signal}) : [];
        const visible = await Promise.all(gaps.map(async gap => ({...gap, title: (await Effect.runPromise(store.thread(gap.threadId), {signal}))?.title ?? gap.threadId})));
        send(200, {gaps: visible, recoveryAvailable: Boolean(recovery)});return;
      }
      if (url.pathname === "/api/completion-recovery" && request.method === "POST") {
        if (!recovery) {send(409, {message: "Recovery is unavailable on this installation."});return;}
        let payload: unknown;try {payload = await readBody(request);} catch (error) {if (error instanceof BodyLimitError) throw error;send(400, {message: "Invalid recovery request."});return;}
        if (!record(payload) || typeof payload.gapId !== "string" || typeof payload.threadId !== "string") {send(400, {message: "Choose a recorded history gap."});return;}
        send(200, await recovery.request({gapId: payload.gapId, threadId: payload.threadId}, AbortSignal.any([signal, AbortSignal.timeout(20_000)])));return;
      }
      send(404, {message: "Not found."});return;
    }
    if (request.method !== "GET") {send(405, {message: "Method not allowed."});return;}
    let path: string;try {path = resolve(assets, url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname).slice(1));} catch {send(400, {message: "Invalid path."});return;}
    if (!path.startsWith(assets + sep)) {send(404, {message: "Not found."});return;}
    const type: Record<string, string> = {".html": "text/html; charset=utf-8", ".js": "application/javascript", ".css": "text/css", ".svg": "image/svg+xml"};
    const contentType = type[extname(path)];if (!contentType) {send(404, {message: "Not found."});return;}
    let bytes: Buffer;try {bytes = await readFile(path);} catch {send(404, {message: "Not found."});return;}
    const nonce = randomBytes(20).toString("base64url");
    headers["Content-Security-Policy"] = `default-src 'none'; script-src 'nonce-${nonce}' 'strict-dynamic'; style-src 'self'; connect-src 'self'; img-src 'self' data:; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`;
    if (extname(path) === ".html") bytes = Buffer.from(bytes.toString("utf8").replace(/<script\b/gu, `<script nonce="${nonce}"`));
    response.writeHead(200, {...headers, "Content-Type": contentType});response.end(bytes);
  };
  try {await new Promise<void>((resolve, reject) => {server.once("error", reject);server.listen(config.uiPort ?? 9038, config.uiHost ?? "127.0.0.1", () => {server.off("error", reject);resolve();});});}
  catch (error) {auth.close();throw error;}
  return {server, close: async () => {
    for (const controller of controllers) controller.abort();
    await new Promise<void>((resolve, reject) => {server.close(error => error ? reject(error) : resolve());server.closeIdleConnections();});
    auth.close();
  }};
};
