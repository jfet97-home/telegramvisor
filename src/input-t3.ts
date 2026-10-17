import { createHash, randomUUID } from "node:crypto";
import WebSocket from "ws";
import type { NativeInputRequest } from "./input-domain.js";
import type { JsonRecord } from "./types.js";

const ORCHESTRATION_PROTOCOL = 2;
const DEFAULT_HTTP_TIMEOUT_MS = 20_000;
const DEFAULT_WEBSOCKET_HANDSHAKE_TIMEOUT_MS = 10_000;
const DEFAULT_RESPONSE_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_HTTP_RESPONSE_BYTES = 32 * 1024 * 1024;
const DEFAULT_MAX_HISTORY_PAGE_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_WEBSOCKET_FRAME_BYTES = 32 * 1024 * 1024;
const MAX_INPUT_HISTORY_PAGES = 8;
const RPC_REQUEST_ID = "1";

export type InputT3RequestStatus = "pending" | "resolved" | "expired" | "cancelled";

export type InputT3ResponseCapability =
  | { type: "live"; providerSessionId: string }
  | { type: "message" }
  | { type: "not_resumable"; reason: string };

export interface InputT3QuestionOption extends JsonRecord {
  label: string;
  description: string;
  value?: string;
}

export interface InputT3Question extends JsonRecord {
  id: string;
  header: string;
  question: string;
  options: InputT3QuestionOption[];
  multiSelect: boolean;
  allowCustomAnswer: boolean;
  required: boolean;
  native: JsonRecord;
}

export interface InputT3Thread extends JsonRecord {
  id: string;
  title: string;
  projectId: string;
  lineage: JsonRecord & {
    parentThreadId: string | null;
    relationshipToParent: string | null;
    rootThreadId: string;
  };
  pendingRuntimeRequest: { id: string; kind: string; createdAt: string } | null;
}

export interface InputT3EnvironmentDescriptor extends JsonRecord {
  environmentId: string;
  orchestrationProtocolVersion: 2;
  serverVersion: string;
}

export interface InputT3Request extends JsonRecord {
  environmentId: string;
  threadId: string;
  requestId: string;
  nodeId: string;
  providerTurnId: string | null;
  nativeRequestRef: JsonRecord | null;
  status: InputT3RequestStatus;
  responseCapability: InputT3ResponseCapability;
  terminal: boolean;
  canRespond: boolean;
  createdAt: string;
  resolvedAt: string | null;
  decision?: string;
  answers?: JsonRecord;
  questions: InputT3Question[];
  responseMode?: "message";
  owner: {
    threadId: string;
    runId: string | null;
    nodeId: string;
    providerInstanceId: string | null;
    providerThreadId: string | null;
    providerTurnId: string | null;
  };
  revisionHash: string;
  native: {
    request: JsonRecord;
    turnItem: JsonRecord;
  };
}

export type InputT3RespondResult =
  | { outcome: "accepted"; commandId: string; sequence: number }
  | { outcome: "rejected"; commandId: string; reason: string; httpStatus?: number }
  | { outcome: "unknown"; commandId: string; reason: string };

export interface InputT3ClientOptions {
  baseUrl: string;
  readToken: string;
  responseToken: string;
  httpTimeoutMs?: number;
  webSocketHandshakeTimeoutMs?: number;
  responseTimeoutMs?: number;
  maxHttpResponseBytes?: number;
  maxWebSocketFrameBytes?: number;
}

export interface InputT3Client {
  descriptor(): Promise<InputT3EnvironmentDescriptor>;
  listThreads(): Promise<InputT3Thread[]>;
  readRequest(threadId: string, requestId: string, previous?: NativeInputRequest): Promise<InputT3Request | undefined>;
  listRequests(threadId: string): Promise<InputT3Request[]>;
  respond(threadId: string, requestId: string, answers: Record<string, unknown>): Promise<InputT3RespondResult>;
}

export class InputT3Error extends Error {
  readonly httpStatus?: number;

  constructor(message: string, httpStatus?: number) {
    super(message);
    this.name = "InputT3Error";
    if (httpStatus !== undefined) this.httpStatus = httpStatus;
  }
}

export class InputT3ResponseTooLargeError extends InputT3Error {
  constructor(operation: string, httpStatus?: number) {
    super(`T3 ${operation} response exceeded the supported size`, httpStatus);
    this.name = "InputT3ResponseTooLargeError";
  }
}

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

const isSequence = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

const isRequestStatus = (value: unknown): value is InputT3RequestStatus =>
  value === "pending" || value === "resolved" || value === "expired" || value === "cancelled";

const requiredString = (record: JsonRecord, key: string, operation: string): string => {
  const value = record[key];
  if (!isNonEmptyString(value)) throw new InputT3Error(`T3 ${operation} returned an invalid ${key}`);
  return value;
};

const nullableString = (record: JsonRecord, key: string, operation: string): string | null => {
  const value = record[key];
  if (value === null) return null;
  if (!isNonEmptyString(value)) throw new InputT3Error(`T3 ${operation} returned an invalid ${key}`);
  return value;
};

const optionalBoolean = (record: JsonRecord, key: string, fallback: boolean, operation: string): boolean => {
  const value = record[key];
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new InputT3Error(`T3 ${operation} returned an invalid ${key}`);
  return value;
};

const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as JsonRecord;
  const entries = Object.keys(record).sort().flatMap((key) => {
    const current = record[key];
    return current === undefined ? [] : [`${JSON.stringify(key)}:${canonicalJson(current)}`];
  });
  return `{${entries.join(",")}}`;
};

const flattenEnvelopes = (input: unknown): JsonRecord[] | undefined => {
  const result: JsonRecord[] = [];
  const pending: unknown[] = [input];
  let visited = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    visited += 1;
    if (visited > 1024) return undefined;
    if (Array.isArray(current)) {
      for (let index = current.length - 1; index >= 0; index -= 1) pending.push(current[index]);
      continue;
    }
    if (!isRecord(current)) return undefined;
    result.push(current);
  }
  return result.length === 0 ? undefined : result;
};

const rawDataToText = (data: WebSocket.RawData): string => {
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  return data.toString("utf8");
};

const readJsonBody = async (
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
  operation: string
): Promise<unknown> => {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null && Number(contentLength) > maxBytes) {
    void response.body?.cancel().catch(() => undefined);
    throw new InputT3ResponseTooLargeError(operation);
  }
  if (response.body === null) throw new InputT3Error(`T3 ${operation} response was empty`);

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      if (signal.aborted) throw new InputT3Error(`T3 ${operation} request was interrupted`);
      const result = await reader.read();
      if (result.done) break;
      totalBytes += result.value.byteLength;
      if (totalBytes > maxBytes) {
        void reader.cancel().catch(() => undefined);
        throw new InputT3ResponseTooLargeError(operation);
      }
      chunks.push(result.value);
    }
  } catch (error) {
    if (error instanceof InputT3Error) throw error;
    throw new InputT3Error(`T3 ${operation} response could not be read`);
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch {
    throw new InputT3Error(`T3 ${operation} response was not valid JSON`);
  }
};

const parseDescriptor = (value: unknown): InputT3EnvironmentDescriptor => {
  if (!isRecord(value) ||
    !isNonEmptyString(value.environmentId) ||
    value.orchestrationProtocolVersion !== ORCHESTRATION_PROTOCOL ||
    !isNonEmptyString(value.serverVersion)) {
    throw new InputT3Error("T3 environment descriptor has an unsupported protocol or shape");
  }
  return value as InputT3EnvironmentDescriptor;
};

const parseShellSnapshot = (value: unknown): JsonRecord => {
  if (!isRecord(value) ||
    value.schemaVersion !== ORCHESTRATION_PROTOCOL ||
    !isSequence(value.snapshotSequence) ||
    !Array.isArray(value.projects) ||
    !Array.isArray(value.threads)) {
    throw new InputT3Error("T3 shell snapshot has an unsupported schema or shape");
  }
  return value;
};

interface ThreadSnapshot {
  snapshotSequence: number;
  projection: JsonRecord;
}

interface BoundedThreadSnapshot extends ThreadSnapshot {
  historyCursor: string | null;
  hasMoreHistory: boolean;
}

interface ThreadHistoryPage {
  snapshotSequence: number;
  items: JsonRecord[];
  nextCursor: string | null;
  hasMoreHistory: boolean;
}

const parseThreadSnapshot = (value: unknown, threadId: string): ThreadSnapshot => {
  if (!isRecord(value) ||
    !isSequence(value.snapshotSequence) ||
    (value.schemaVersion !== undefined && value.schemaVersion !== ORCHESTRATION_PROTOCOL) ||
    !isRecord(value.projection)) {
    throw new InputT3Error("T3 thread snapshot has an unsupported schema or shape");
  }
  const projection = value.projection;
  if (!isRecord(projection.thread) || projection.thread.id !== threadId ||
    !Array.isArray(projection.runtimeRequests) ||
    !Array.isArray(projection.turnItems) ||
    !Array.isArray(projection.nodes) ||
    !Array.isArray(projection.runs)) {
    throw new InputT3Error("T3 thread projection has an unsupported schema or shape");
  }
  return { snapshotSequence: value.snapshotSequence, projection };
};

const parseBoundedThreadSnapshot = (value: unknown, threadId: string): BoundedThreadSnapshot => {
  if (!isRecord(value) || !isSequence(value.snapshotSequence) ||
    !(value.historyCursor === null || isNonEmptyString(value.historyCursor)) ||
    typeof value.hasMoreHistory !== "boolean") {
    throw new InputT3Error("T3 bounded thread snapshot has an unsupported schema or shape");
  }
  return { ...parseThreadSnapshot(value, threadId), historyCursor: value.historyCursor, hasMoreHistory: value.hasMoreHistory };
};

const parseShellThread = (value: unknown): InputT3Thread => {
  if (!isRecord(value) ||
    !isNonEmptyString(value.id) ||
    !isNonEmptyString(value.title) ||
    !isNonEmptyString(value.projectId) ||
    !isRecord(value.lineage) ||
    !(value.lineage.parentThreadId === null || isNonEmptyString(value.lineage.parentThreadId)) ||
    !(value.lineage.relationshipToParent === null || isNonEmptyString(value.lineage.relationshipToParent)) ||
    !isNonEmptyString(value.lineage.rootThreadId) ||
    !(value.pendingRuntimeRequest === null || isRecord(value.pendingRuntimeRequest) &&
      isNonEmptyString(value.pendingRuntimeRequest.id) && isNonEmptyString(value.pendingRuntimeRequest.kind) &&
      isNonEmptyString(value.pendingRuntimeRequest.createdAt))) {
    throw new InputT3Error("T3 shell snapshot contains an invalid thread");
  }
  return value as InputT3Thread;
};

const parseThreadHistoryPage = (value: unknown): ThreadHistoryPage => {
  if (!isRecord(value) || !isSequence(value.snapshotSequence) || !Array.isArray(value.items) ||
    !(value.nextCursor === null || isNonEmptyString(value.nextCursor)) || typeof value.hasMoreHistory !== "boolean") {
    throw new InputT3Error("T3 thread history page has an unsupported schema or shape");
  }
  const items = value.items.map((entry) => {
    if (!isRecord(entry) || !isRecord(entry.item)) throw new InputT3Error("T3 thread history page contains an invalid item");
    return entry.item;
  });
  return {
    snapshotSequence: value.snapshotSequence,
    items,
    nextCursor: value.nextCursor,
    hasMoreHistory: value.hasMoreHistory,
  };
};

const parseCapability = (value: unknown): InputT3ResponseCapability => {
  if (!isRecord(value)) throw new InputT3Error("T3 user-input request has an invalid response capability");
  switch (value.type) {
    case "live":
      return { type: "live", providerSessionId: requiredString(value, "providerSessionId", "user-input request") };
    case "message":
      return { type: "message" };
    case "not_resumable":
      if (typeof value.reason !== "string") throw new InputT3Error("T3 user-input request has an invalid response capability");
      return { type: "not_resumable", reason: value.reason };
    default:
      throw new InputT3Error("T3 user-input request has an unsupported response capability");
  }
};

const parseQuestion = (value: unknown): InputT3Question => {
  if (!isRecord(value) || !Array.isArray(value.options)) {
    throw new InputT3Error("T3 user-input request has an invalid question definition");
  }
  const options = value.options.map((option) => {
    if (!isRecord(option) || !isNonEmptyString(option.label) || typeof option.description !== "string" ||
      (option.value !== undefined && typeof option.value !== "string")) {
      throw new InputT3Error("T3 user-input request has an invalid option definition");
    }
    return { ...option, label: option.label, description: option.description } as InputT3QuestionOption;
  });
  return {
    ...value,
    id: requiredString(value, "id", "user-input question"),
    header: requiredString(value, "header", "user-input question"),
    question: requiredString(value, "question", "user-input question"),
    options,
    multiSelect: optionalBoolean(value, "multiSelect", false, "user-input question"),
    allowCustomAnswer: optionalBoolean(value, "allowCustomAnswer", true, "user-input question"),
    required: optionalBoolean(value, "required", true, "user-input question"),
    native: { ...value }
  };
};

const getQuestionTurnItem = (projection: JsonRecord, requestId: string): JsonRecord => {
  const items = projection.turnItems as unknown[];
  const matches = items.filter((item): item is JsonRecord =>
    isRecord(item) && item.type === "user_input_request" && item.requestId === requestId);
  if (matches.length !== 1 || !Array.isArray(matches[0]?.questions) || matches[0].questions.length === 0) {
    throw new InputT3Error("T3 user-input request definition is unavailable");
  }
  return matches[0]!;
};

const findQuestionTurnItem = (projection: JsonRecord, requestId: string): JsonRecord | undefined => {
  const items = projection.turnItems as unknown[];
  const matches = items.filter((item): item is JsonRecord =>
    isRecord(item) && item.type === "user_input_request" && item.requestId === requestId);
  if (matches.length > 1) throw new InputT3Error("T3 user-input request has ambiguous question items");
  return matches[0];
};

const requestRevisionHash = (
  environmentId: string,
  threadId: string,
  request: JsonRecord,
  turnItem: JsonRecord,
  owner: InputT3Request["owner"]
): string => createHash("sha256")
  .update(canonicalJson({ environmentId, threadId, request, turnItem, owner }))
  .digest("hex");

const mapRequest = (
  environmentId: string,
  projection: JsonRecord,
  requestValue: unknown
): InputT3Request | undefined => {
  if (!isRecord(requestValue)) throw new InputT3Error("T3 thread projection contains an invalid runtime request");
  if (requestValue.kind !== "user_input") return undefined;

  const requestId = requiredString(requestValue, "id", "runtime request");
  const thread = projection.thread as JsonRecord;
  const threadId = requiredString(thread, "id", "thread projection");
  const nodeId = requiredString(requestValue, "nodeId", "runtime request");
  if (!isRequestStatus(requestValue.status)) throw new InputT3Error("T3 user-input request has an unsupported status");
  const responseCapability = parseCapability(requestValue.responseCapability);
  const item = getQuestionTurnItem(projection, requestId);
  if (item.threadId !== threadId || item.nodeId !== nodeId) {
    throw new InputT3Error("T3 user-input request has inconsistent native ownership");
  }
  const nodes = projection.nodes as unknown[];
  const node = nodes.find((candidate): candidate is JsonRecord => isRecord(candidate) && candidate.id === nodeId);
  if (node === undefined || node.kind !== "user_input_request") {
    throw new InputT3Error("T3 user-input request owner node is unavailable");
  }
  const runId = node.runId === null ? null : requiredString(node, "runId", "request owner node");
  if (item.runId !== undefined && item.runId !== null && item.runId !== runId) {
    throw new InputT3Error("T3 user-input request question item has inconsistent run ownership");
  }
  const runs = projection.runs as unknown[];
  const run = runId === null
    ? undefined
    : runs.find((candidate): candidate is JsonRecord => isRecord(candidate) && candidate.id === runId);
  if (requestValue.status === "pending" && (runId === null || run === undefined)) {
    throw new InputT3Error("T3 pending user-input request owner run is unavailable");
  }
  const providerInstanceId = run === undefined || run.providerInstanceId === null
    ? null
    : requiredString(run, "providerInstanceId", "request owner run");
  const providerThreadId = node.providerThreadId === null || node.providerThreadId === undefined
    ? null
    : requiredString(node, "providerThreadId", "request owner node");
  const providerTurnId = requestValue.providerTurnId === null
    ? null
    : requiredString(requestValue, "providerTurnId", "runtime request");
  const nativeRequestRef = requestValue.nativeRequestRef === null
    ? null
    : isRecord(requestValue.nativeRequestRef)
      ? { ...requestValue.nativeRequestRef }
      : (() => { throw new InputT3Error("T3 user-input request has an invalid native request reference"); })();
  const questions = (item.questions as unknown[]).map(parseQuestion);
  const nativeResponseMode = item.responseMode;
  if (nativeResponseMode !== undefined && nativeResponseMode !== "message") {
    throw new InputT3Error("T3 user-input request has an unsupported response mode");
  }
  const resolvedAt = nullableString(requestValue, "resolvedAt", "runtime request");
  const createdAt = requiredString(requestValue, "createdAt", "runtime request");
  const owner = {
    threadId,
    runId,
    nodeId,
    providerInstanceId,
    providerThreadId,
    providerTurnId
  };
  const rawRequest = { ...requestValue };
  const rawItem = { ...item };
  const revisionHash = requestRevisionHash(environmentId, threadId, rawRequest, rawItem, owner);
  const responseMode = nativeResponseMode === "message" || responseCapability.type === "message"
    ? "message"
    : undefined;

  return {
    environmentId,
    threadId,
    requestId,
    nodeId,
    providerTurnId,
    nativeRequestRef,
    status: requestValue.status,
    responseCapability,
    terminal: requestValue.status !== "pending",
    canRespond: requestValue.status === "pending" && responseCapability.type !== "not_resumable",
    createdAt,
    resolvedAt,
    ...(typeof requestValue.decision === "string" ? { decision: requestValue.decision } : {}),
    ...(isRecord(requestValue.answers) ? { answers: { ...requestValue.answers } } : {}),
    questions,
    ...(responseMode === undefined ? {} : { responseMode }),
    owner,
    revisionHash,
    native: { request: rawRequest, turnItem: rawItem }
  };
};

const safeHttpFailure = (operation: string, status: number): InputT3Error => status === 413
  ? new InputT3ResponseTooLargeError(operation, status)
  : new InputT3Error(`T3 ${operation} returned HTTP ${status}`, status);

const responseResult = (
  commandId: string,
  outcome: InputT3RespondResult["outcome"],
  reason?: string,
  sequence?: number,
  httpStatus?: number
): InputT3RespondResult => {
  if (outcome === "accepted" && sequence !== undefined) return { outcome, commandId, sequence };
  if (outcome === "rejected") {
    return { outcome, commandId, reason: reason ?? "T3 rejected the response command", ...(httpStatus === undefined ? {} : { httpStatus }) };
  }
  return { outcome: "unknown", commandId, reason: reason ?? "T3 did not confirm whether the response command was accepted" };
};

export const makeInputT3Client = (options: InputT3ClientOptions): InputT3Client => {
  const baseUrl = new URL(options.baseUrl);
  if (baseUrl.protocol !== "http:" && baseUrl.protocol !== "https:") {
    throw new InputT3Error("T3 base URL must use HTTP or HTTPS");
  }
  if (!isNonEmptyString(options.readToken) || !isNonEmptyString(options.responseToken)) {
    throw new InputT3Error("T3 read and response tokens must be non-empty");
  }
  const httpTimeoutMs = options.httpTimeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS;
  const webSocketHandshakeTimeoutMs = options.webSocketHandshakeTimeoutMs ?? DEFAULT_WEBSOCKET_HANDSHAKE_TIMEOUT_MS;
  const responseTimeoutMs = options.responseTimeoutMs ?? DEFAULT_RESPONSE_TIMEOUT_MS;
  const maxHttpResponseBytes = options.maxHttpResponseBytes ?? DEFAULT_MAX_HTTP_RESPONSE_BYTES;
  const maxWebSocketFrameBytes = options.maxWebSocketFrameBytes ?? DEFAULT_MAX_WEBSOCKET_FRAME_BYTES;
  for (const [name, value] of [
    ["HTTP timeout", httpTimeoutMs],
    ["WebSocket handshake timeout", webSocketHandshakeTimeoutMs],
    ["response timeout", responseTimeoutMs],
    ["HTTP response byte limit", maxHttpResponseBytes],
    ["WebSocket frame byte limit", maxWebSocketFrameBytes]
  ] as const) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new InputT3Error(`T3 ${name} must be a positive safe integer`);
  }

  baseUrl.username = "";
  baseUrl.password = "";
  baseUrl.search = "";
  baseUrl.hash = "";

  const getJson = async (
    path: string,
    operation: string,
    protocolHeader: boolean,
    maxBytes = maxHttpResponseBytes,
  ): Promise<unknown> => {
    const controller = new AbortController();
    let didTimeout = false;
    const timeoutId = setTimeout(() => {
      didTimeout = true;
      controller.abort();
    }, httpTimeoutMs);
    try {
      const headers: Record<string, string> = {
        Accept: "application/json",
        Authorization: `Bearer ${options.readToken}`
      };
      if (protocolHeader) headers["x-t3-orchestration-protocol"] = String(ORCHESTRATION_PROTOCOL);
      const response = await fetch(new URL(path, baseUrl), { headers, signal: controller.signal });
      if (!response.ok) {
        void response.body?.cancel().catch(() => undefined);
        throw safeHttpFailure(operation, response.status);
      }
      return await readJsonBody(response, maxBytes, controller.signal, operation);
    } catch (error) {
      if (error instanceof InputT3Error) throw error;
      throw new InputT3Error(didTimeout ? `T3 ${operation} request timed out` : `T3 ${operation} request failed`);
    } finally {
      clearTimeout(timeoutId);
    }
  };

  const getDescriptor = async (): Promise<InputT3EnvironmentDescriptor> =>
    parseDescriptor(await getJson("/.well-known/t3/environment", "environment descriptor", false));

  const getThreadProjection = async (threadId: string): Promise<{ environmentId: string; snapshotSequence: number; projection: JsonRecord }> => {
    if (!isNonEmptyString(threadId)) throw new InputT3Error("T3 thread id must not be empty");
    const [descriptor, value] = await Promise.all([
      getDescriptor(),
      getJson(`/api/orchestration/threads/${encodeURIComponent(threadId)}`, "thread snapshot", true)
    ]);
    return { environmentId: descriptor.environmentId, ...parseThreadSnapshot(value, threadId) };
  };

  const getThreadSnapshotWindow = async (threadId: string): Promise<BoundedThreadSnapshot> =>
    parseBoundedThreadSnapshot(
      await getJson(
        `/api/orchestration/threads/${encodeURIComponent(threadId)}/bounded`,
        "bounded thread snapshot",
        true,
      ),
      threadId,
    );

  const getShellSnapshot = async (): Promise<{ snapshotSequence: number; threads: InputT3Thread[] }> => {
    const snapshot = parseShellSnapshot(await getJson("/api/orchestration/shell", "shell snapshot", true));
    return {
      snapshotSequence: snapshot.snapshotSequence as number,
      threads: (snapshot.threads as unknown[]).map(parseShellThread),
    };
  };

  const getThreadHistoryPage = async (threadId: string, cursor: string): Promise<ThreadHistoryPage> => {
    const query = new URLSearchParams({ cursor });
    return parseThreadHistoryPage(await getJson(
      `/api/orchestration/threads/${encodeURIComponent(threadId)}/history?${query.toString()}`,
      "thread history page",
      true,
      Math.min(maxHttpResponseBytes, DEFAULT_MAX_HISTORY_PAGE_BYTES),
    ));
  };

  const mapRequests = (environmentId: string, projection: JsonRecord): InputT3Request[] => {
    const requests = projection.runtimeRequests as unknown[];
    return requests.flatMap((request) => {
      const mapped = mapRequest(environmentId, projection, request);
      return mapped === undefined ? [] : [mapped];
    });
  };

  const getTurnItem = (threadId: string, itemId: string): Promise<JsonRecord | null> => {
    if (!isNonEmptyString(threadId) || !isNonEmptyString(itemId)) {
      return Promise.reject(new InputT3Error("T3 exact turn item identity is invalid"));
    }
    const serialized = JSON.stringify({
      _tag: "Request",
      id: RPC_REQUEST_ID,
      tag: "orchestration.getTurnItem",
      payload: { threadId, itemId },
      headers: [],
    });
    const socketUrl = new URL("/ws?orchestrationProtocol=2", baseUrl);
    socketUrl.protocol = baseUrl.protocol === "https:" ? "wss:" : "ws:";

    return new Promise((resolve, reject) => {
      let socket: WebSocket;
      try {
        socket = new WebSocket(socketUrl, {
          headers: { Authorization: `Bearer ${options.readToken}` },
          maxPayload: maxWebSocketFrameBytes,
          handshakeTimeout: webSocketHandshakeTimeoutMs,
        });
      } catch {
        reject(new InputT3Error("T3 exact turn item read failed before sending"));
        return;
      }

      let settled = false;
      let sent = false;
      let responseTimer: ReturnType<typeof setTimeout> | undefined;
      const finish = (error?: Error, item?: JsonRecord | null) => {
        if (settled) return;
        settled = true;
        if (responseTimer !== undefined) clearTimeout(responseTimer);
        if (error) reject(error);
        else resolve(item ?? null);
        if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
          try {
            socket.terminate();
          } catch {
            return;
          }
        }
      };
      const onOpen = () => {
        if (settled || sent) return;
        sent = true;
        responseTimer = setTimeout(() => finish(new InputT3Error("T3 exact turn item read timed out")), responseTimeoutMs);
        try {
          socket.send(serialized, (error) => {
            if (error) finish(new InputT3Error("T3 exact turn item read could not be sent"));
          });
        } catch {
          finish(new InputT3Error("T3 exact turn item read could not be sent"));
        }
      };
      const onMessage = (data: WebSocket.RawData, isBinary: boolean) => {
        if (settled || !sent) return;
        if (isBinary) {
          finish(new InputT3Error("T3 exact turn item read returned a binary frame"));
          return;
        }
        let envelopes: JsonRecord[] | undefined;
        try {
          envelopes = flattenEnvelopes(JSON.parse(rawDataToText(data)) as unknown);
        } catch {
          finish(new InputT3Error("T3 exact turn item read returned invalid JSON"));
          return;
        }
        if (envelopes === undefined) {
          finish(new InputT3Error("T3 exact turn item read returned an invalid RPC frame"));
          return;
        }
        for (const envelope of envelopes) {
          if (envelope._tag === "Ping") {
            try {
              socket.send(JSON.stringify({ _tag: "Pong" }), (error) => {
                if (error) finish(new InputT3Error("T3 exact turn item read failed while responding to ping"));
              });
            } catch {
              finish(new InputT3Error("T3 exact turn item read failed while responding to ping"));
            }
            continue;
          }
          if (envelope._tag === "Pong") continue;
          if (envelope.requestId !== RPC_REQUEST_ID) continue;
          if (envelope._tag === "Defect") {
            finish(new InputT3Error("T3 exact turn item read failed"));
            return;
          }
          if (envelope._tag !== "Exit" || !isRecord(envelope.exit)) continue;
          const exit = envelope.exit;
          if (exit._tag !== "Success" || !isRecord(exit.value) ||
            !(exit.value.item === null || isRecord(exit.value.item))) {
            finish(new InputT3Error("T3 exact turn item read was rejected or malformed"));
            return;
          }
          finish(undefined, exit.value.item as JsonRecord | null);
          return;
        }
      };
      const onError = () => finish(new InputT3Error(sent
        ? "T3 exact turn item read failed after sending"
        : "T3 exact turn item read failed before sending"));
      const onClose = () => finish(new InputT3Error(sent
        ? "T3 exact turn item read closed before a response"
        : "T3 exact turn item read closed before sending"));
      const onUnexpectedResponse = (_request: unknown, response: { statusCode?: number }) =>
        finish(new InputT3Error(`T3 exact turn item websocket returned HTTP ${response.statusCode ?? "error"}`, response.statusCode));

      socket.on("open", onOpen);
      socket.on("message", onMessage);
      socket.on("error", onError);
      socket.on("close", onClose);
      socket.on("unexpected-response", onUnexpectedResponse);
    });
  };

  const fallbackContext = async (threadId: string): Promise<{
    environmentId: string;
    shellThread: InputT3Thread;
    snapshot: BoundedThreadSnapshot;
  }> => {
    const descriptor = await getDescriptor();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const snapshot = await getThreadSnapshotWindow(threadId);
      const shell = await getShellSnapshot();
      const shellThread = shell.threads.find((thread) => thread.id === threadId);
      if (shellThread === undefined) throw new InputT3Error("T3 shell snapshot no longer contains the request thread");
      try {
        assertLatestPendingRequestIsPresent(shellThread, snapshot.projection);
        return { environmentId: descriptor.environmentId, shellThread, snapshot };
      } catch (error) {
        if (attempt === 1) throw error;
      }
    }
    throw new InputT3Error("T3 request changed while the bounded input snapshot was read");
  };

  const findRuntimeRequest = (projection: JsonRecord, requestId: string): JsonRecord | undefined => {
    const matches = (projection.runtimeRequests as unknown[]).filter((request): request is JsonRecord =>
      isRecord(request) && request.id === requestId);
    if (matches.length > 1) throw new InputT3Error("T3 projection contains duplicate runtime request ids");
    return matches[0];
  };

  const assertLatestPendingRequestIsPresent = (shellThread: InputT3Thread, projection: JsonRecord): void => {
    const summary = shellThread.pendingRuntimeRequest;
    const pending = (projection.runtimeRequests as unknown[]).filter((request): request is JsonRecord =>
      isRecord(request) && request.status === "pending");
    if (summary === null) {
      if (pending.length > 0) throw new InputT3Error("T3 shell omitted its latest pending request");
      return;
    }
    const request = findRuntimeRequest(projection, summary.id);
    const hasNewerRequest = pending.some((candidate) =>
      isNonEmptyString(candidate.createdAt) && candidate.createdAt > summary.createdAt);
    if (request === undefined || request.kind !== summary.kind || request.status !== "pending" || hasNewerRequest) {
      throw new InputT3Error("T3 bounded input projection omitted its latest pending request");
    }
  };

  const readFreshBoundedContext = async (threadId: string): Promise<{
    shellThread: InputT3Thread;
    snapshot: BoundedThreadSnapshot;
  }> => {
    const snapshot = await getThreadSnapshotWindow(threadId);
    const shell = await getShellSnapshot();
    const shellThread = shell.threads.find((thread) => thread.id === threadId);
    if (shellThread === undefined) throw new InputT3Error("T3 shell snapshot no longer contains the request thread");
    assertLatestPendingRequestIsPresent(shellThread, snapshot.projection);
    return { shellThread, snapshot };
  };

  const questionItemIdentity = (item: JsonRecord): JsonRecord => ({
    id: item.id,
    threadId: item.threadId,
    runId: item.runId,
    nodeId: item.nodeId,
    type: item.type,
    requestId: item.requestId,
    questions: item.questions,
    ...(item.responseMode === undefined ? {} : { responseMode: item.responseMode }),
  });

  const validateQuestionItem = (
    item: JsonRecord,
    threadId: string,
    requestId: string,
    itemId: string,
    owner?: InputT3Request["owner"],
  ): JsonRecord => {
    if (item.id !== itemId || item.threadId !== threadId || item.type !== "user_input_request" ||
      item.requestId !== requestId || !Array.isArray(item.questions) || item.questions.length === 0) {
      throw new InputT3Error("T3 exact question item does not match the requested native identity");
    }
    if (owner !== undefined &&
      (item.nodeId !== null && item.nodeId !== undefined && item.nodeId !== owner.nodeId ||
        item.runId !== null && item.runId !== undefined && item.runId !== owner.runId)) {
      throw new InputT3Error("T3 exact question item ownership changed");
    }
    return item;
  };

  const findHistoryQuestionItem = async (
    threadId: string,
    requestId: string,
    snapshot: BoundedThreadSnapshot,
  ): Promise<JsonRecord | undefined> => {
    let cursor = snapshot.historyCursor;
    for (let pageIndex = 0; pageIndex < MAX_INPUT_HISTORY_PAGES && cursor !== null; pageIndex += 1) {
      const page = await getThreadHistoryPage(threadId, cursor);
      const matches = page.items.filter((item) => item.type === "user_input_request" && item.requestId === requestId);
      if (matches.length > 1) throw new InputT3Error("T3 thread history contains duplicate native question items");
      if (matches[0] !== undefined) return matches[0];
      cursor = page.hasMoreHistory ? page.nextCursor : null;
      if (page.hasMoreHistory && cursor === null) {
        throw new InputT3Error("T3 thread history omitted its next cursor");
      }
    }
    return undefined;
  };

  const loadExactQuestionItem = async (
    threadId: string,
    requestId: string,
    snapshot: BoundedThreadSnapshot,
    anchor?: NativeInputRequest["nativeT3Anchor"],
  ): Promise<JsonRecord> => {
    const windowItem = findQuestionTurnItem(snapshot.projection, requestId);
    const historyItem = windowItem === undefined
      ? await findHistoryQuestionItem(threadId, requestId, snapshot)
      : undefined;
    const hint = windowItem ?? historyItem;
    const itemId = hint === undefined
      ? anchor?.itemId
      : requiredString(hint, "id", "question turn item");
    if (itemId === undefined) throw new InputT3Error("T3 question item is outside the bounded history read limit");
    if (anchor !== undefined && anchor.itemId !== itemId) {
      throw new InputT3Error("T3 question item identity no longer matches its saved native anchor");
    }
    const exact = await getTurnItem(threadId, itemId);
    if (exact === null) throw new InputT3Error("T3 exact question item is no longer available");
    validateQuestionItem(exact, threadId, requestId, itemId);
    if (hint !== undefined && canonicalJson(questionItemIdentity(hint)) !== canonicalJson(questionItemIdentity(exact))) {
      throw new InputT3Error("T3 exact question item changed during bounded history read");
    }
    return exact;
  };

  const mapBoundedRequest = async (
    environmentId: string,
    threadId: string,
    snapshot: BoundedThreadSnapshot,
    requestValue: JsonRecord,
    previous?: NativeInputRequest,
  ): Promise<InputT3Request | undefined> => {
    if (requestValue.kind !== "user_input") return undefined;
    const requestId = requiredString(requestValue, "id", "runtime request");
    const anchor = previous?.nativeT3Anchor;
    const exactItem = await loadExactQuestionItem(threadId, requestId, snapshot, anchor);
    const projection = {
      ...snapshot.projection,
      turnItems: [
        ...(snapshot.projection.turnItems as unknown[]).filter((item) =>
          !isRecord(item) || item.id !== exactItem.id),
        exactItem,
      ],
    };
    const current = mapRequest(environmentId, projection, requestValue);
    if (current === undefined) return undefined;
    if (requestValue.status === "resolved" && previous !== undefined && anchor !== undefined) {
      const savedAnchor = validateSavedAnchor(previous, environmentId, threadId, requestId);
      validateCurrentRequestAgainstAnchor(requestValue, current, savedAnchor);
      return resolvedRequestFromAnchor(previous, environmentId, threadId, requestId, exactItem);
    }
    return current;
  };

  const validateSavedAnchor = (
    previous: NativeInputRequest,
    environmentId: string,
    threadId: string,
    requestId: string,
  ): NonNullable<NativeInputRequest["nativeT3Anchor"]> => {
    const anchor = previous.nativeT3Anchor;
    if (anchor === undefined || previous.threadId !== threadId || previous.requestId !== requestId ||
      anchor.environmentId !== environmentId || anchor.owner.threadId !== threadId ||
      anchor.rawRequest.id !== requestId || anchor.rawRequest.kind !== "user_input" ||
      anchor.rawRequest.nodeId !== anchor.owner.nodeId || anchor.rawTurnItem.id !== anchor.itemId ||
      anchor.rawTurnItem.threadId !== threadId || anchor.rawTurnItem.nodeId !== anchor.owner.nodeId ||
      (anchor.rawTurnItem.runId !== undefined && anchor.rawTurnItem.runId !== anchor.owner.runId) ||
      anchor.rawRequest.providerTurnId !== anchor.owner.providerTurnId ||
      anchor.rawTurnItem.requestId !== requestId || anchor.rawTurnItem.type !== "user_input_request" ||
      requestRevisionHash(environmentId, threadId, anchor.rawRequest as JsonRecord,
        anchor.rawTurnItem as JsonRecord, anchor.owner) !== previous.revisionHash) {
      throw new InputT3Error("Saved T3 question anchor does not match the tracked native revision");
    }
    return anchor;
  };

  const validateCurrentRequestAgainstAnchor = (
    request: JsonRecord,
    mapped: InputT3Request,
    anchor: NonNullable<NativeInputRequest["nativeT3Anchor"]>,
  ): void => {
    const savedRequest = anchor.rawRequest as JsonRecord;
    const identity = (value: JsonRecord) => ({
      id: value.id,
      kind: value.kind,
      nodeId: value.nodeId,
      providerTurnId: value.providerTurnId,
      nativeRequestRef: value.nativeRequestRef,
      responseCapability: value.responseCapability,
      createdAt: value.createdAt,
    });
    if (canonicalJson(identity(request)) !== canonicalJson(identity(savedRequest)) ||
      canonicalJson(mapped.owner) !== canonicalJson(anchor.owner) ||
      canonicalJson(questionItemIdentity(mapped.native.turnItem as JsonRecord)) !==
        canonicalJson(questionItemIdentity(anchor.rawTurnItem as JsonRecord))) {
      throw new InputT3Error("T3 current request no longer matches its saved native owner and revision");
    }
  };

  const resolvedRequestFromAnchor = (
    previous: NativeInputRequest,
    environmentId: string,
    threadId: string,
    requestId: string,
    item: JsonRecord,
  ): InputT3Request => {
    const anchor = validateSavedAnchor(previous, environmentId, threadId, requestId);
    validateQuestionItem(item, threadId, requestId, anchor.itemId, anchor.owner);
    if (item.status !== "completed" || canonicalJson(questionItemIdentity(item)) !==
      canonicalJson(questionItemIdentity(anchor.rawTurnItem as JsonRecord))) {
      throw new InputT3Error("T3 tracked question has no matching answered terminal item");
    }
    const responseCapability = parseCapability(anchor.rawRequest.responseCapability);
    const resolvedAt = typeof item.completedAt === "string"
      ? item.completedAt
      : requiredString(item, "updatedAt", "completed question item");
    const questions = (anchor.rawTurnItem.questions as unknown[]).map(parseQuestion);
    const rawRequest = { ...anchor.rawRequest } as JsonRecord;
    const rawTurnItem = { ...anchor.rawTurnItem } as JsonRecord;
    const nativeRequestRef = anchor.rawRequest.nativeRequestRef === null
      ? null
      : isRecord(anchor.rawRequest.nativeRequestRef)
        ? { ...anchor.rawRequest.nativeRequestRef }
        : (() => { throw new InputT3Error("Saved T3 question anchor has an invalid request reference"); })();
    const nativeResponseMode = anchor.rawTurnItem.responseMode;
    if (nativeResponseMode !== undefined && nativeResponseMode !== "message") {
      throw new InputT3Error("Saved T3 question anchor has an unsupported response mode");
    }
    return {
      environmentId,
      threadId,
      requestId,
      nodeId: anchor.owner.nodeId,
      providerTurnId: anchor.owner.providerTurnId,
      nativeRequestRef,
      status: "resolved",
      responseCapability,
      terminal: true,
      canRespond: false,
      createdAt: requiredString(anchor.rawRequest, "createdAt", "saved runtime request"),
      resolvedAt,
      ...(typeof anchor.rawRequest.decision === "string" ? { decision: anchor.rawRequest.decision } : {}),
      ...(isRecord(anchor.rawRequest.answers) ? { answers: { ...anchor.rawRequest.answers } } : {}),
      questions,
      ...(nativeResponseMode === "message" || responseCapability.type === "message" ? { responseMode: "message" as const } : {}),
      owner: { ...anchor.owner },
      revisionHash: previous.revisionHash,
      native: { request: rawRequest, turnItem: rawTurnItem },
    };
  };

  const reconcileMissingRequest = async (
    threadId: string,
    requestId: string,
    previous: NativeInputRequest | undefined,
    environmentId: string,
    bounded: BoundedThreadSnapshot,
  ): Promise<InputT3Request | undefined> => {
    let anchor = previous?.nativeT3Anchor;
    if (previous === undefined || anchor === undefined) {
      const historyItem = await findHistoryQuestionItem(threadId, requestId, bounded);
      if (historyItem === undefined) {
        throw new InputT3Error("Tracked T3 request is outside the bounded reconciliation history");
      }
      const itemId = requiredString(historyItem, "id", "historical question item");
      const exactItem = await getTurnItem(threadId, itemId);
      if (exactItem === null) throw new InputT3Error("Historical T3 question item is no longer available");
      validateQuestionItem(exactItem, threadId, requestId, itemId);
      await readFreshBoundedContext(threadId);
      throw new InputT3Error("Tracked T3 request has no saved owner and revision anchor");
    }
    anchor = validateSavedAnchor(previous, environmentId, threadId, requestId);
    const exactItem = await getTurnItem(threadId, anchor.itemId);
    if (exactItem === null) throw new InputT3Error("Saved T3 question item is no longer available");
    const resolved = resolvedRequestFromAnchor(previous, environmentId, threadId, requestId, exactItem);
    const { snapshot: currentSnapshot } = await readFreshBoundedContext(threadId);
    const currentRequest = findRuntimeRequest(currentSnapshot.projection, requestId);
    if (currentRequest !== undefined) {
      if (currentRequest.status === "pending") {
        throw new InputT3Error("T3 pending request disappeared during bounded reconciliation");
      }
      const projected = { ...currentSnapshot.projection, turnItems: [exactItem] };
      const mapped = mapRequest(environmentId, projected, currentRequest);
      if (mapped === undefined) throw new InputT3Error("T3 tracked request changed kind during bounded reconciliation");
      validateCurrentRequestAgainstAnchor(currentRequest, mapped, anchor);
      return currentRequest.status === "resolved" ? resolved : mapped;
    }
    return resolved;
  };

  const listRequestsFromBoundedSnapshot = async (threadId: string): Promise<InputT3Request[]> => {
    const { environmentId, shellThread, snapshot } = await fallbackContext(threadId);
    assertLatestPendingRequestIsPresent(shellThread, snapshot.projection);
    const rawRequests = snapshot.projection.runtimeRequests as unknown[];
    if (rawRequests.length > 500) throw new InputT3Error("T3 bounded input request count exceeds its limit");
    const mapped: InputT3Request[] = [];
    const reconciled: JsonRecord[] = [];
    for (const value of rawRequests) {
      if (!isRecord(value)) throw new InputT3Error("T3 bounded projection contains an invalid runtime request");
      if (value.kind !== "user_input") continue;
      const requestId = requiredString(value, "id", "runtime request");
      if (value.status !== "pending" && !findQuestionTurnItem(snapshot.projection, requestId)) continue;
      const request = await mapBoundedRequest(environmentId, threadId, snapshot, value);
      if (request !== undefined) mapped.push(request);
      reconciled.push(value);
    }
    const { snapshot: current } = await readFreshBoundedContext(threadId);
    const currentPending = (current.projection.runtimeRequests as unknown[])
      .filter((request): request is JsonRecord => isRecord(request) && request.status === "pending")
      .sort((left, right) => String(left.id).localeCompare(String(right.id)));
    const initialPending = rawRequests
      .filter((request): request is JsonRecord => isRecord(request) && request.status === "pending")
      .sort((left, right) => String(left.id).localeCompare(String(right.id)));
    if (canonicalJson(currentPending) !== canonicalJson(initialPending)) {
      throw new InputT3Error("T3 pending request set changed during bounded discovery");
    }
    for (const request of reconciled) {
      const currentRequest = findRuntimeRequest(current.projection, requiredString(request, "id", "runtime request"));
      if (currentRequest === undefined || canonicalJson(currentRequest) !== canonicalJson(request)) {
        throw new InputT3Error("T3 native requests changed during bounded discovery");
      }
      const mappedRequest = mapped.find((mappedValue) => mappedValue.requestId === request.id);
      if (mappedRequest !== undefined) {
        const currentMapped = mapRequest(environmentId, {
          ...current.projection,
          turnItems: [mappedRequest.native.turnItem],
        }, currentRequest);
        if (currentMapped === undefined || currentMapped.revisionHash !== mappedRequest.revisionHash) {
          throw new InputT3Error("T3 request owner changed during bounded discovery");
        }
      }
    }
    if ((await getDescriptor()).environmentId !== environmentId) throw new InputT3Error("Input environment changed");
    return mapped;
  };

  const readRequestFromBoundedSnapshot = async (
    threadId: string,
    requestId: string,
    previous?: NativeInputRequest,
  ): Promise<InputT3Request | undefined> => {
    const { environmentId, shellThread, snapshot } = await fallbackContext(threadId);
    assertLatestPendingRequestIsPresent(shellThread, snapshot.projection);
    const requestValue = findRuntimeRequest(snapshot.projection, requestId);
    if (requestValue === undefined) {
      const reconciled = await reconcileMissingRequest(threadId, requestId, previous, environmentId, snapshot);
      if ((await getDescriptor()).environmentId !== environmentId) throw new InputT3Error("Input environment changed");
      return reconciled;
    }
    if (requestValue.kind !== "user_input") return undefined;
    const request = await mapBoundedRequest(environmentId, threadId, snapshot, requestValue, previous);
    const { snapshot: currentSnapshot } = await readFreshBoundedContext(threadId);
    const currentRequest = findRuntimeRequest(currentSnapshot.projection, requestId);
    if (currentRequest === undefined || canonicalJson(currentRequest) !== canonicalJson(requestValue)) {
      throw new InputT3Error("T3 native request changed during bounded question read");
    }
    if (request !== undefined) {
      const currentMapped = mapRequest(environmentId, {
        ...currentSnapshot.projection,
        turnItems: [request.native.turnItem],
      }, currentRequest);
      if (currentMapped === undefined) throw new InputT3Error("T3 native request changed kind during bounded question read");
      if (request.status === "resolved" && previous?.nativeT3Anchor !== undefined) {
        validateCurrentRequestAgainstAnchor(
          currentRequest,
          currentMapped,
          validateSavedAnchor(previous, environmentId, threadId, requestId),
        );
      } else if (currentMapped.revisionHash !== request.revisionHash) {
        throw new InputT3Error("T3 native request owner or question changed during bounded question read");
      }
    }
    if ((await getDescriptor()).environmentId !== environmentId) throw new InputT3Error("Input environment changed");
    return request;
  };

  const respond = (
    threadId: string,
    requestId: string,
    answers: Record<string, unknown>
  ): Promise<InputT3RespondResult> => {
    const commandId = randomUUID();
    if (!isNonEmptyString(threadId) || !isNonEmptyString(requestId) || !isRecord(answers)) {
      return Promise.resolve(responseResult(commandId, "rejected", "T3 response command input is invalid"));
    }
    let serialized: string;
    try {
      serialized = JSON.stringify({
        _tag: "Request",
        id: RPC_REQUEST_ID,
        tag: "orchestration.dispatchCommand",
        payload: {
          type: "runtime-request.respond",
          commandId,
          threadId,
          requestId,
          answers
        },
        headers: []
      });
    } catch {
      return Promise.resolve(responseResult(commandId, "rejected", "T3 response command input is not JSON serializable"));
    }

    const socketUrl = new URL("/ws?orchestrationProtocol=2", baseUrl);
    socketUrl.protocol = baseUrl.protocol === "https:" ? "wss:" : "ws:";

    return new Promise((resolve) => {
      let socket: WebSocket;
      try {
        socket = new WebSocket(socketUrl, {
          headers: { Authorization: `Bearer ${options.responseToken}` },
          maxPayload: maxWebSocketFrameBytes,
          handshakeTimeout: webSocketHandshakeTimeoutMs
        });
      } catch {
        resolve(responseResult(commandId, "rejected", "T3 websocket connection failed before the response command was sent"));
        return;
      }

      let settled = false;
      let sent = false;
      let responseTimer: ReturnType<typeof setTimeout> | undefined;
      const finish = (result: InputT3RespondResult) => {
        if (settled) return;
        settled = true;
        if (responseTimer !== undefined) clearTimeout(responseTimer);
        resolve(result);
        if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
          try {
            socket.terminate();
          } catch {
            return;
          }
        }
      };
      const finishUnknown = () => finish(responseResult(commandId, "unknown"));
      const onOpen = () => {
        if (settled || sent) return;
        sent = true;
        responseTimer = setTimeout(finishUnknown, responseTimeoutMs);
        try {
          socket.send(serialized, (error) => {
            if (error) finishUnknown();
          });
        } catch {
          finishUnknown();
        }
      };
      const onMessage = (data: WebSocket.RawData, isBinary: boolean) => {
        if (settled || !sent) return;
        if (isBinary) {
          finishUnknown();
          return;
        }
        let envelopes: JsonRecord[] | undefined;
        try {
          envelopes = flattenEnvelopes(JSON.parse(rawDataToText(data)) as unknown);
        } catch {
          finishUnknown();
          return;
        }
        if (envelopes === undefined) {
          finishUnknown();
          return;
        }
        for (const envelope of envelopes) {
          if (envelope._tag === "Ping") {
            try {
              socket.send(JSON.stringify({ _tag: "Pong" }), (error) => {
                if (error) finishUnknown();
              });
            } catch {
              finishUnknown();
            }
            continue;
          }
          if (envelope._tag === "Pong") continue;
          if (envelope.requestId !== RPC_REQUEST_ID) continue;
          if (envelope._tag === "Defect") {
            finishUnknown();
            return;
          }
          if (envelope._tag !== "Exit" || !isRecord(envelope.exit)) continue;
          const exit = envelope.exit;
          if (exit._tag === "Failure") {
            finish(responseResult(commandId, "rejected", "T3 rejected the response command"));
            return;
          }
          if (exit._tag !== "Success" || !isRecord(exit.value) || !isSequence(exit.value.sequence)) {
            finishUnknown();
            return;
          }
          finish(responseResult(commandId, "accepted", undefined, exit.value.sequence));
          return;
        }
      };
      const onError = () => {
        if (sent) finishUnknown();
        else finish(responseResult(commandId, "rejected", "T3 websocket connection failed before the response command was sent"));
      };
      const onClose = () => {
        if (sent) finishUnknown();
        else finish(responseResult(commandId, "rejected", "T3 websocket connection closed before the response command was sent"));
      };
      const onUnexpectedResponse = (_request: unknown, response: { statusCode?: number }) => {
        finish(responseResult(
          commandId,
          "rejected",
          "T3 websocket rejected the response connection",
          undefined,
          response.statusCode
        ));
      };

      socket.on("open", onOpen);
      socket.on("message", onMessage);
      socket.on("error", onError);
      socket.on("close", onClose);
      socket.on("unexpected-response", onUnexpectedResponse);
    });
  };

  const readRequest = async (
    threadId: string,
    requestId: string,
    previous?: NativeInputRequest,
  ): Promise<InputT3Request | undefined> => {
    if (!isNonEmptyString(requestId)) throw new InputT3Error("T3 request id must not be empty");
    try {
      const { environmentId, projection } = await getThreadProjection(threadId);
      const requestValue = findRuntimeRequest(projection, requestId);
      if (requestValue === undefined) {
        if (previous === undefined) return undefined;
        const context = await fallbackContext(threadId);
        if (context.environmentId !== environmentId) throw new InputT3Error("Input environment changed");
        return reconcileMissingRequest(threadId, requestId, previous, environmentId, context.snapshot);
      }
      if (requestValue.kind !== "user_input") return undefined;
      const mapped = mapRequest(environmentId, projection, requestValue);
      if (mapped === undefined || requestValue.status !== "resolved" || previous?.nativeT3Anchor === undefined) {
        return mapped;
      }
      const anchor = validateSavedAnchor(previous, environmentId, threadId, requestId);
      validateCurrentRequestAgainstAnchor(requestValue, mapped, anchor);
      return resolvedRequestFromAnchor(previous, environmentId, threadId, requestId, mapped.native.turnItem);
    } catch (error) {
      if (!(error instanceof InputT3ResponseTooLargeError)) throw error;
      return readRequestFromBoundedSnapshot(threadId, requestId, previous);
    }
  };

  const listRequests = async (threadId: string): Promise<InputT3Request[]> => {
    try {
      const { environmentId, projection } = await getThreadProjection(threadId);
      return mapRequests(environmentId, projection);
    } catch (error) {
      if (!(error instanceof InputT3ResponseTooLargeError)) throw error;
      return listRequestsFromBoundedSnapshot(threadId);
    }
  };

  return {
    descriptor: getDescriptor,
    listThreads: async () => (await getShellSnapshot()).threads,
    readRequest,
    listRequests,
    respond
  };
};
