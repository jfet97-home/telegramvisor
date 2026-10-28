import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  INPUT_MAX_ANSWERS_JSON_BYTES,
  INPUT_MAX_REQUEST_JSON_BYTES,
  InputDomainError,
  inputDefinitionHash,
  isInputBatchComplete,
  isInputNotification,
  makeInputId,
  nativeInputAnswers,
  type InputPresentation,
  reduceInputEvent,
} from "./input-domain.js";
import { normalizeInputPresentation, parseInputNavigation } from "./input-ui.js";
import type {
  InputAnswerRecord,
  InputAnswerTombstones,
  InputAnswers,
  InputEvent,
  NativeInputRequest,
  RenderedInputMessage,
} from "./input-domain.js";

const maxDatabasePages = 16_384;
const maxRequests = 20_000;
const maxMessages = 100_000;
const maxCardIdentities = maxMessages;
const maxEvents = 250_000;
const eventRetentionMs = 30 * 24 * 60 * 60 * 1_000;
const retryBaseMs = 5_000;
const retryBackoffMaxMs = 60 * 60 * 1_000;
const retryAfterMaxMs = 24 * 60 * 60 * 1_000;
const maxInputButtonsJsonBytes = INPUT_MAX_REQUEST_JSON_BYTES + 32 * 1024;
export const INPUT_CLEANUP_UNCERTAINTY_TTL_MS = 24 * 60 * 60 * 1_000;
export const INPUT_DELETE_MAX_AGE_MS = 47 * 60 * 60 * 1_000;

interface InputAnswerWithSource extends InputAnswerRecord {
  readonly sourceMessageId?: number;
}

interface InputCardIdentity {
  readonly deliveryKey: string;
  readonly generation: number;
  readonly draftRevision: number;
  readonly presentationRevision: number;
  readonly questionId: string | null;
  readonly messageId: number | null;
}

export interface InputStoreCapacity {
  readonly activeRequestPayloads: number;
  readonly maxRequestPayloads: number;
  readonly requestTombstones: number;
  readonly messages: number;
  readonly maxMessages: number;
  readonly cardIdentities: number;
  readonly maxCardIdentities: number;
  readonly events: number;
  readonly maxEvents: number;
  readonly databasePages: number;
  readonly databaseFreePages: number;
  readonly maxDatabasePages: number;
}

export type InputLifecycle = "active" | "retiring" | "retired";
export type InputRetirementState = "none" | "intent" | "sent" | "unknown";
export type InputMessageState = "prepared" | "sending" | "sent" | "unknown" | "rejected" | "abandoned";
export type InputCleanupState = "none" | "waiting" | "pending" | "deleting" | "unknown" | "deleted" | "expired";

export interface TrackedInputRequest {
  readonly inputId: string;
  readonly environmentId: string;
  readonly threadId: string;
  readonly requestId: string;
  readonly requestRevision: string;
  readonly definitionHash: string;
  readonly request: NativeInputRequest;
  readonly draftRevision: number;
  readonly answers: InputAnswers;
  readonly answerTombstones: InputAnswerTombstones;
  readonly submissionState: "none" | "intent" | "accepted" | "rejected" | "unknown";
  readonly submissionDraftRevision: number | null;
  readonly submissionAnswers: Readonly<Record<string, string | readonly string[] | null>> | null;
  readonly lifecycle: InputLifecycle;
  readonly nativeTerminal: boolean;
  readonly retirementState: InputRetirementState;
  readonly retirementKey: string | null;
  readonly currentGeneration: number;
  readonly renderedDraftRevision: number;
  readonly presentationRevision: number;
  readonly renderedPresentationRevision: number;
  readonly presentation: InputPresentation;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly lastSeenAt: number;
}

export interface InputMessageRecord {
  readonly inputId: string;
  readonly requestRevision: string;
  readonly generation: number;
  readonly draftRevision: number;
  readonly presentationRevision: number;
  readonly focusId: string | null;
  readonly isEdit: boolean;
  readonly ordinal: number;
  readonly questionId: string | null;
  readonly fragment: number;
  readonly deliveryKey: string;
  readonly text: string;
  readonly buttons: RenderedInputMessage["buttons"];
  readonly state: InputMessageState;
  readonly messageId: number | null;
  readonly createdAt: number;
  readonly sentAt: number | null;
  readonly deleteWindowAt: number;
  readonly error: string | null;
  readonly cleanupState: InputCleanupState;
  readonly cleanupKey: string | null;
  readonly cleanupError: string | null;
  readonly sendAttempts: number;
  readonly sendRetryAt: number;
  readonly deleteAttempts: number;
  readonly deleteRetryAt: number;
}

export interface InputSubmissionIntent {
  readonly inputId: string;
  readonly environmentId: string;
  readonly threadId: string;
  readonly requestId: string;
  readonly requestRevision: string;
  readonly definitionHash: string;
  readonly draftRevision: number;
  readonly answers: Readonly<Record<string, string | readonly string[] | null>>;
}

export type InputEventResult =
  | { readonly kind: "duplicate" | "ignored" | "unchanged"; readonly reason?: string; readonly draftRevision: number }
  | { readonly kind: "changed"; readonly draftRevision: number }
  | { readonly kind: "presented"; readonly draftRevision: number; readonly presentationRevision: number }
  | { readonly kind: "submit"; readonly draftRevision: number };

export interface InputStoreApi {
  close(): void;
  bindEnvironment(environmentId: string): void;
  upsertRequest(environmentId: string, request: NativeInputRequest, now: number): TrackedInputRequest;
  isTombstoned(inputId: string, requestRevision: string): boolean;
  getRequest(inputId: string, requestRevision: string): TrackedInputRequest | null;
  listRequests(): TrackedInputRequest[];
  invalidateRequest(inputId: string, requestRevision: string, now: number): boolean;
  setRequestTerminal(inputId: string, requestRevision: string, now: number): boolean;
  beginRetirement(inputId: string, requestRevision: string, deliveryKey: string, now: number): boolean;
  recordRetirement(inputId: string, requestRevision: string, state: Exclude<InputRetirementState, "none" | "intent">, now: number): boolean;
  requestsNeedingRetirement(limit?: number): TrackedInputRequest[];
  ensureGeneration(
    inputId: string,
    requestRevision: string,
    draftRevision: number,
    messages: readonly RenderedInputMessage[],
    now: number,
    force?: boolean,
  ): InputMessageRecord[] | null;
  ensurePresentation(
    inputId: string,
    requestRevision: string,
    draftRevision: number,
    presentationRevision: number,
    presentation: InputPresentation,
    message: RenderedInputMessage,
    now: number,
    force?: boolean,
  ): InputMessageRecord | null;
  messagesForRequest(inputId: string, requestRevision: string): InputMessageRecord[];
  dueMessages(now: number, limit?: number): InputMessageRecord[];
  beginMessageSend(deliveryKey: string, now: number): boolean;
  abandonPreparedMessage(deliveryKey: string, now: number): boolean;
  recordMessageSent(deliveryKey: string, messageId: number, now: number, sentAt?: number | null, deleteWindowAt?: number | null): boolean;
  recordMessagePresented(deliveryKey: string, messageId: number, now: number, sentAt?: number | null, deleteWindowAt?: number | null): boolean;
  recordMessageUnknown(deliveryKey: string, error: string, now: number): boolean;
  recordMessageRejected(deliveryKey: string, error: string, now: number, retryAfterMs?: number): boolean;
  applyEvent(event: InputEvent, now: number, allowInteractive?: boolean): InputEventResult;
  prepareSubmission(inputId: string, requestRevision: string, draftRevision: number, now: number): InputSubmissionIntent | null;
  recordSubmission(inputId: string, requestRevision: string, state: "accepted" | "rejected" | "unknown", now: number): boolean;
  dueCleanupMessages(now: number, limit?: number): InputMessageRecord[];
  beginMessageDeletion(deliveryKey: string, now: number): boolean;
  recordMessageDeleted(deliveryKey: string, now: number): boolean;
  expireUnknownDeletion(deliveryKey: string, now: number): boolean;
  recordMessageDeleteUnknown(deliveryKey: string, error: string, now: number): boolean;
  recordMessageDeleteRejected(deliveryKey: string, error: string, now: number, retryAfterMs?: number): boolean;
  completeEvent(eventId: string): void;
  acknowledgeEvents(eventIds: readonly string[], now: number): void;
  compactTerminalPayloads(now: number): { requests: number; messages: number; events: number };
  recoverInterrupted(now: number): void;
  stats(): { requests: number; messages: number; pendingCleanup: number; uncertain: number; retiredUnconfirmedSends: number; capacity: InputStoreCapacity };
}

export class InputStoreError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "InputStoreError";
  }
}

const schema = `
  CREATE TABLE IF NOT EXISTS input_cleanup_history (
    delivery_key TEXT PRIMARY KEY, cleanup_key TEXT, message_id INTEGER, thread_id TEXT,
    state TEXT NOT NULL, reason TEXT NOT NULL, message_created_at INTEGER NOT NULL, recorded_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS input_environment (
    id INTEGER PRIMARY KEY CHECK(id=1),
    environment_id TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS input_requests (
    input_id TEXT NOT NULL,
    environment_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    native_request_id TEXT NOT NULL,
    request_revision TEXT NOT NULL,
    definition_hash TEXT NOT NULL,
    request_json TEXT NOT NULL,
    draft_revision INTEGER NOT NULL DEFAULT 0,
    answers_json TEXT NOT NULL DEFAULT '{}',
    answer_tombstones_json TEXT NOT NULL DEFAULT '{}',
    answer_order_version INTEGER NOT NULL DEFAULT 0,
    submission_state TEXT NOT NULL DEFAULT 'none' CHECK(submission_state IN ('none','intent','accepted','rejected','unknown')),
    submission_draft_revision INTEGER,
    submission_answers_json TEXT,
    lifecycle TEXT NOT NULL DEFAULT 'active' CHECK(lifecycle IN ('active','retiring','retired')),
    native_terminal INTEGER NOT NULL DEFAULT 0,
    retirement_state TEXT NOT NULL DEFAULT 'none' CHECK(retirement_state IN ('none','intent','sent','unknown')),
    retirement_key TEXT,
    compacted INTEGER NOT NULL DEFAULT 0 CHECK(compacted IN (0,1)),
    current_generation INTEGER NOT NULL DEFAULT 0,
    rendered_draft_revision INTEGER NOT NULL DEFAULT -1,
    presentation_revision INTEGER NOT NULL DEFAULT 0,
    rendered_presentation_revision INTEGER NOT NULL DEFAULT -1,
    presentation_json TEXT NOT NULL DEFAULT '{"kind":"question","questionIndex":0,"page":0,"focusQuestionId":null,"focusId":null}',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    PRIMARY KEY(input_id, request_revision),
    UNIQUE(environment_id, thread_id, native_request_id, request_revision)
  );
  CREATE INDEX IF NOT EXISTS input_requests_lifecycle ON input_requests(lifecycle, updated_at);
  CREATE TABLE IF NOT EXISTS input_messages (
    delivery_key TEXT PRIMARY KEY,
    input_id TEXT NOT NULL,
    request_revision TEXT NOT NULL,
    generation INTEGER NOT NULL,
    draft_revision INTEGER NOT NULL,
    presentation_revision INTEGER NOT NULL DEFAULT 0,
    focus_id TEXT,
    is_edit INTEGER NOT NULL DEFAULT 0 CHECK(is_edit IN (0,1)),
    ordinal INTEGER NOT NULL,
    question_id TEXT,
    fragment INTEGER NOT NULL,
    text TEXT NOT NULL,
    buttons_json TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('prepared','sending','sent','unknown','rejected','abandoned')),
    message_id INTEGER,
    created_at INTEGER NOT NULL,
    sent_at INTEGER,
    delete_window_at INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    cleanup_state TEXT NOT NULL DEFAULT 'none' CHECK(cleanup_state IN ('none','waiting','pending','deleting','unknown','deleted','expired')),
    cleanup_key TEXT UNIQUE,
    cleanup_error TEXT,
    send_attempts INTEGER NOT NULL DEFAULT 0,
    send_retry_at INTEGER NOT NULL DEFAULT 0,
    delete_attempts INTEGER NOT NULL DEFAULT 0,
    delete_retry_at INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY(input_id, request_revision) REFERENCES input_requests(input_id, request_revision)
  );
  CREATE INDEX IF NOT EXISTS input_messages_due ON input_messages(state, created_at);
  CREATE INDEX IF NOT EXISTS input_messages_cleanup ON input_messages(cleanup_state, created_at);
  CREATE TABLE IF NOT EXISTS input_card_identities (
    input_id TEXT NOT NULL,
    request_revision TEXT NOT NULL,
    delivery_key TEXT NOT NULL,
    generation INTEGER NOT NULL,
    draft_revision INTEGER NOT NULL,
    presentation_revision INTEGER NOT NULL DEFAULT 0,
    question_id TEXT,
    message_id INTEGER,
    PRIMARY KEY(input_id, request_revision, delivery_key),
    FOREIGN KEY(input_id, request_revision) REFERENCES input_requests(input_id, request_revision)
  );
  CREATE INDEX IF NOT EXISTS input_card_identity_message
    ON input_card_identities(input_id, request_revision, message_id, presentation_revision);
  CREATE INDEX IF NOT EXISTS input_card_identity_lookup
    ON input_card_identities(input_id, request_revision, message_id);
  CREATE TABLE IF NOT EXISTS input_events (
    event_id TEXT PRIMARY KEY,
    input_id TEXT NOT NULL,
    request_revision TEXT NOT NULL,
    draft_revision INTEGER NOT NULL,
    update_id INTEGER NOT NULL,
    update_epoch INTEGER NOT NULL DEFAULT 0,
    message_id INTEGER NOT NULL,
    question_id TEXT,
    action TEXT NOT NULL,
    payload_hash TEXT NOT NULL DEFAULT '',
    processed INTEGER NOT NULL DEFAULT 1,
    received_at INTEGER NOT NULL,
    acknowledged_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS input_events_retention ON input_events(acknowledged_at, received_at);
  CREATE TABLE IF NOT EXISTS input_text_focuses (
    focus_id TEXT PRIMARY KEY,
    input_id TEXT NOT NULL,
    request_revision TEXT NOT NULL,
    message_id INTEGER NOT NULL,
    question_id TEXT NOT NULL,
    draft_revision INTEGER NOT NULL,
    presentation_revision INTEGER NOT NULL,
    delivery_key TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    FOREIGN KEY(input_id, request_revision) REFERENCES input_requests(input_id, request_revision)
  );
  CREATE INDEX IF NOT EXISTS input_text_focus_lookup
    ON input_text_focuses(input_id, request_revision, message_id, created_at);
  CREATE TABLE IF NOT EXISTS input_request_tombstones (
    input_id TEXT NOT NULL,
    request_revision TEXT NOT NULL,
    definition_hash TEXT NOT NULL,
    terminal_at INTEGER NOT NULL,
    PRIMARY KEY(input_id, request_revision)
  );
`;

const readRowString = (row: Record<string, unknown>, key: string): string => {
  const value = row[key];
  if (typeof value !== "string") throw new InputStoreError("input store row is invalid");
  return value;
};

const readOptionalString = (row: Record<string, unknown>, key: string): string | null => {
  const value = row[key];
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw new InputStoreError("input store row is invalid");
  return value;
};

const readRowNumber = (row: Record<string, unknown>, key: string): number => {
  const value = row[key];
  if (typeof value === "bigint") return Number(value);
  if (typeof value !== "number" || !Number.isFinite(value)) throw new InputStoreError("input store row is invalid");
  return value;
};

const readOptionalNumber = (row: Record<string, unknown>, key: string): number | null => {
  const value = row[key];
  if (value === null || value === undefined) return null;
  if (typeof value === "bigint") return Number(value);
  if (typeof value !== "number" || !Number.isFinite(value)) throw new InputStoreError("input store row is invalid");
  return value;
};

const readJson = <A>(json: string): A => {
  try {
    return JSON.parse(json) as A;
  } catch (cause) {
    throw new InputStoreError("input store contains invalid JSON", { cause });
  }
};

const secureFiles = (databasePath: string): void => {
  for (const path of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]) {
    if (existsSync(path)) chmodSync(path, 0o600);
  }
};

const boundedJson = (value: unknown, maxBytes: number, label: string): string => {
  let json: string;
  try {
    json = JSON.stringify(value);
  } catch (cause) {
    throw new InputStoreError(`${label} cannot be serialized`, { cause });
  }
  if (typeof json !== "string" || Buffer.byteLength(json, "utf8") > maxBytes) {
    throw new InputStoreError(`${label} exceeds its storage bound`);
  }
  return json;
};

const withContributionSources = (
  answers: InputAnswers,
  previous: InputAnswers,
  event: InputEvent,
): InputAnswers => {
  let updated: Record<string, InputAnswerWithSource> | null = null;
  for (const [questionId, rawAnswer] of Object.entries(answers)) {
    const answer = rawAnswer as InputAnswerWithSource;
    const previousAnswer = previous[questionId] as InputAnswerWithSource | undefined;
    const sourceMessageId = event.action === "answer" && event.questionId === questionId &&
      answer.contributionId === event.contributionId
      ? event.messageId
      : answer.contributionId !== null && previousAnswer?.contributionId === answer.contributionId
        ? previousAnswer.sourceMessageId
        : undefined;
    if (answer.sourceMessageId === sourceMessageId) continue;
    updated ??= { ...answers } as Record<string, InputAnswerWithSource>;
    if (sourceMessageId === undefined) {
      const { sourceMessageId: ignoredSourceMessageId, ...withoutSource } = answer;
      void ignoredSourceMessageId;
      updated[questionId] = withoutSource;
    } else updated[questionId] = { ...answer, sourceMessageId };
  }
  return (updated ?? answers) as InputAnswers;
};

const compactLegacyOptionOrdering = (request: NativeInputRequest, answers: InputAnswers): InputAnswers => {
  let updated: Record<string, InputAnswerRecord> | null = null;
  for (const [questionId, answer] of Object.entries(answers)) {
    if (answer.kind !== "multi_choice" || answer.optionOrderVersion === 1) continue;
    const question = request.questions.find((item) => item.id === questionId && item.kind === "multi_choice");
    if (!question || (!answer.optionDraftRevisions && !answer.optionUpdateIds && !answer.optionUpdateEpochs)) continue;
    const compact = (values: Readonly<Record<string, number>>): Readonly<Record<string, number>> => {
      const result: Record<string, number> = {};
      for (const [choiceValue, value] of Object.entries(values)) {
        const index = question.choices.findIndex((choice) => choice.value === choiceValue);
        if (index >= 0 && Number.isSafeInteger(value)) result[`c${index}`] = value;
      }
      return result;
    };
    updated ??= { ...answers };
    updated[questionId] = {
      ...answer,
      optionOrderVersion: 1,
      ...(answer.optionDraftRevisions === undefined ? {} : { optionDraftRevisions: compact(answer.optionDraftRevisions) }),
      ...(answer.optionUpdateIds === undefined ? {} : { optionUpdateIds: compact(answer.optionUpdateIds) }),
      ...(answer.optionUpdateEpochs === undefined ? {} : { optionUpdateEpochs: compact(answer.optionUpdateEpochs) }),
    };
  }
  return updated ?? answers;
};

const stableKey = (...parts: string[]): string => {
  const digest = createHash("sha256").update(parts.join("\u0000")).digest("hex").slice(0, 40);
  return `input-${digest}`;
};

const safeErrorCodes = new Set([
  "interrupted_send",
  "interrupted_delete",
  "stale_prepared_message",
  "render_unavailable",
  "timeout",
  "transport_error",
  "connection_failed",
  "invalid_request",
  "invalid_response",
  "mcp_error",
  "mutation_uncertain",
  "delivery_unknown",
  "telegram_rejected",
  "telegram_not_sent",
  "stale_presentation",
  "text_focus_not_registered",
]);

const normalizeError = (value: string): string => safeErrorCodes.has(value) ? value : "operation_failed";

export class InputStore implements InputStoreApi {
  private readonly db: DatabaseSync;
  private readonly databasePath: string;

  constructor(dataDirectory: string) {
    const directory = resolve(dataDirectory);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
    this.databasePath = join(directory, "telegram-input.sqlite3");
    this.db = new DatabaseSync(this.databasePath);
    try {
      chmodSync(this.databasePath, 0o600);
      this.db.exec("PRAGMA journal_mode=WAL");
      this.db.exec("PRAGMA synchronous=FULL");
      this.db.exec("PRAGMA foreign_keys=ON");
      this.db.exec("PRAGMA busy_timeout=5000");
      this.db.exec("PRAGMA wal_autocheckpoint=256");
      this.db.exec("PRAGMA secure_delete=ON");
      this.db.exec(`PRAGMA max_page_count=${maxDatabasePages}`);
      this.db.exec(schema);
      this.ensureColumn("input_requests", "compacted", "INTEGER NOT NULL DEFAULT 0");
      this.ensureColumn("input_requests", "presentation_revision", "INTEGER NOT NULL DEFAULT 0");
      this.ensureColumn("input_requests", "rendered_presentation_revision", "INTEGER NOT NULL DEFAULT -1");
      this.ensureColumn("input_requests", "presentation_json", "TEXT NOT NULL DEFAULT '{\"kind\":\"question\",\"questionIndex\":0,\"page\":0,\"focusQuestionId\":null,\"focusId\":null}'");
      this.ensureColumn("input_requests", "answer_tombstones_json", "TEXT NOT NULL DEFAULT '{}'");
      this.ensureColumn("input_messages", "send_attempts", "INTEGER NOT NULL DEFAULT 0");
      this.ensureColumn("input_messages", "send_retry_at", "INTEGER NOT NULL DEFAULT 0");
      this.ensureColumn("input_messages", "delete_attempts", "INTEGER NOT NULL DEFAULT 0");
      this.ensureColumn("input_messages", "delete_retry_at", "INTEGER NOT NULL DEFAULT 0");
      this.ensureColumn("input_messages", "delete_window_at", "INTEGER NOT NULL DEFAULT 0");
      this.ensureColumn("input_messages", "presentation_revision", "INTEGER NOT NULL DEFAULT 0");
      this.ensureColumn("input_messages", "focus_id", "TEXT");
      this.ensureColumn("input_messages", "is_edit", "INTEGER NOT NULL DEFAULT 0");
      this.ensureColumn("input_card_identities", "presentation_revision", "INTEGER NOT NULL DEFAULT 0");
      this.ensureColumn("input_events", "update_epoch", "INTEGER NOT NULL DEFAULT 0");
      this.ensureColumn("input_events", "payload_hash", "TEXT NOT NULL DEFAULT ''");
      this.ensureColumn("input_requests", "answer_order_version", "INTEGER NOT NULL DEFAULT 0");
      this.db.exec("DROP INDEX IF EXISTS input_card_identity_message");
      this.db.exec(`CREATE INDEX input_card_identity_message
        ON input_card_identities(input_id, request_revision, message_id, presentation_revision)`);
      this.migrateDurableInputIdentityAndAnswerOrder();
      this.recoverInterrupted(Date.now());
      secureFiles(this.databasePath);
    } catch (cause) {
      this.db.close();
      throw cause;
    }
  }

  close = (): void => {
    secureFiles(this.databasePath);
    this.db.close();
  };

  private migrateDurableInputIdentityAndAnswerOrder(): void {
    this.transaction(() => {
      this.db.prepare(`INSERT OR IGNORE INTO input_card_identities(
        input_id,request_revision,delivery_key,generation,draft_revision,presentation_revision,question_id,message_id
      ) SELECT input_id,request_revision,delivery_key,generation,draft_revision,presentation_revision,question_id,message_id
        FROM input_messages`).run();
      const rows = this.db.prepare(`SELECT input_id,request_revision,request_json,answers_json FROM input_requests
        WHERE answer_order_version=0`).all() as Array<Record<string, unknown>>;
      const update = this.db.prepare(`UPDATE input_requests SET answers_json=?,answer_order_version=1
        WHERE input_id=? AND request_revision=? AND answer_order_version=0`);
      for (const row of rows) {
        const request = readJson<NativeInputRequest>(readRowString(row, "request_json"));
        const answers = readJson<InputAnswers>(readRowString(row, "answers_json"));
        const compacted = compactLegacyOptionOrdering(request, answers);
        update.run(boundedJson(compacted, INPUT_MAX_ANSWERS_JSON_BYTES, "input answers"),
          readRowString(row, "input_id"), readRowString(row, "request_revision"));
      }
    });
  }

  bindEnvironment = (environmentId: string): void => this.operation(() => {
    if (typeof environmentId !== "string" || environmentId.length === 0 || environmentId.length > 512) {
      throw new InputStoreError("T3 environment id is invalid");
    }
    this.transaction(() => {
      const row = this.db.prepare("SELECT environment_id FROM input_environment WHERE id=1").get() as Record<string, unknown> | undefined;
      if (row && row.environment_id !== environmentId) throw new InputStoreError("input store is bound to a different T3 environment");
      if (!row) this.db.prepare("INSERT INTO input_environment(id,environment_id) VALUES(1,?)").run(environmentId);
    });
  });

  upsertRequest = (environmentId: string, request: NativeInputRequest, now: number): TrackedInputRequest => this.operation(() => {
    this.validateNow(now);
    if (request.terminal) throw new InputStoreError("terminal input requests cannot be activated");
    const inputId = makeInputId(environmentId, request.threadId, request.requestId);
    const definitionHash = inputDefinitionHash(request);
    const result = this.transaction(() => {
      if (this.hasTombstone(inputId, request.revisionHash)) {
        return { mismatch: false as const, retired: true as const, request: null };
      }
      const existing = this.findRequest(inputId, request.revisionHash);
      if (existing && existing.definitionHash !== definitionHash) {
        this.db.prepare(`UPDATE input_requests SET lifecycle='retiring', native_terminal=1,
          updated_at=?, last_seen_at=? WHERE input_id=? AND request_revision=?`).run(now, now, inputId, request.revisionHash);
        this.scheduleCurrentMessagesForCleanup(inputId, request.revisionHash, now);
        return { mismatch: true as const, retired: false as const, request: null };
      }
      if (!existing) {
        this.compactTerminalPayloadsInTransaction(now);
        let count = this.count("SELECT COUNT(*) AS count FROM input_requests WHERE compacted=0");
        if (count >= maxRequests || this.databaseNearCapacity()) {
          this.compactCleanedMessagePayloadsInTransaction();
          count = this.count("SELECT COUNT(*) AS count FROM input_requests WHERE compacted=0");
        }
        if (count >= maxRequests) throw new InputStoreError("input request storage is full");
        this.db.prepare(`INSERT INTO input_requests(
          input_id, environment_id, thread_id, native_request_id, request_revision, definition_hash,
          request_json, answer_order_version, created_at, updated_at, last_seen_at
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(
          inputId, environmentId, request.threadId, request.requestId, request.revisionHash, definitionHash,
          boundedJson(request, 300 * 1024, "input request"), 1, now, now, now,
        );
      } else if (existing.lifecycle === "active") {
        this.db.prepare(`UPDATE input_requests SET request_json=?, updated_at=?, last_seen_at=?
          WHERE input_id=? AND request_revision=?`).run(
          boundedJson(request, 300 * 1024, "input request"), now, now, inputId, request.revisionHash,
        );
      }
      return { mismatch: false as const, retired: false as const, request: this.readRequest(inputId, request.revisionHash)! };
    });
    if (result.retired) throw new InputStoreError("native input request revision is permanently retired");
    if (result.mismatch || result.request === null) throw new InputStoreError("native request definition changed without a new revision");
    return result.request;
  });

  isTombstoned = (inputId: string, requestRevision: string): boolean => this.operation(() =>
    this.hasTombstone(inputId, requestRevision));

  getRequest = (inputId: string, requestRevision: string): TrackedInputRequest | null => this.operation(() =>
    this.readRequest(inputId, requestRevision));

  listRequests = (): TrackedInputRequest[] => this.operation(() => {
    const rows = this.db.prepare("SELECT * FROM input_requests WHERE compacted=0 ORDER BY updated_at, input_id")
      .all() as Array<Record<string, unknown>>;
    return rows.map((row) => this.toTrackedRequest(row));
  });

  invalidateRequest = (inputId: string, requestRevision: string, now: number): boolean => this.operation(() => {
    this.validateNow(now);
    return this.transaction(() => {
      const result = this.db.prepare(`UPDATE input_requests SET lifecycle=CASE WHEN lifecycle='active'
        THEN 'retiring' ELSE lifecycle END, updated_at=? WHERE input_id=? AND request_revision=?`).run(
        now, inputId, requestRevision,
      );
      if (Number(result.changes) > 0) this.scheduleCurrentMessagesForCleanup(inputId, requestRevision, now);
      return Number(result.changes) > 0;
    });
  });

  setRequestTerminal = (inputId: string, requestRevision: string, now: number): boolean => this.operation(() => {
    this.validateNow(now);
    return this.transaction(() => {
      const result = this.db.prepare(`UPDATE input_requests SET native_terminal=1,
        lifecycle=CASE WHEN lifecycle='active' THEN 'retiring' ELSE lifecycle END,
        updated_at=? WHERE input_id=? AND request_revision=?`).run(now, inputId, requestRevision);
      if (Number(result.changes) > 0) this.scheduleCurrentMessagesForCleanup(inputId, requestRevision, now);
      return Number(result.changes) > 0;
    });
  });

  beginRetirement = (inputId: string, requestRevision: string, deliveryKey: string, now: number): boolean => this.operation(() => {
    this.validateNow(now);
    this.validateKey(deliveryKey);
    return this.transaction(() => {
      const request = this.readRequest(inputId, requestRevision);
      if (!request || request.lifecycle === "retired" || request.retirementState !== "none") return false;
      const result = this.db.prepare(`UPDATE input_requests SET lifecycle='retiring', retirement_state='intent',
        retirement_key=?, updated_at=? WHERE input_id=? AND request_revision=? AND retirement_state='none'`).run(
        deliveryKey, now, inputId, requestRevision,
      );
      if (Number(result.changes) > 0) this.scheduleCurrentMessagesForCleanup(inputId, requestRevision, now);
      return Number(result.changes) > 0;
    });
  });

  recordRetirement = (
    inputId: string,
    requestRevision: string,
    state: "sent" | "unknown",
    now: number,
  ): boolean => this.operation(() => {
    this.validateNow(now);
    return this.transaction(() => {
      const result = this.db.prepare(`UPDATE input_requests SET retirement_state=?,
        lifecycle=CASE WHEN ?='sent' THEN 'retired' ELSE 'retiring' END, updated_at=?
        WHERE input_id=? AND request_revision=? AND retirement_state IN ('intent','unknown')`).run(
        state, state, now, inputId, requestRevision,
      );
      if (Number(result.changes) > 0 && state === "sent") {
        this.scheduleCurrentMessagesForCleanup(inputId, requestRevision, now);
        this.compactTerminalPayloadsInTransaction(now);
      }
      return Number(result.changes) > 0;
    });
  });

  requestsNeedingRetirement = (limit = 100): TrackedInputRequest[] => this.operation(() => {
    const boundedLimit = this.readLimit(limit, 1_000);
    const rows = this.db.prepare(`SELECT * FROM input_requests WHERE lifecycle='retiring'
      AND retirement_state IN ('none','intent','unknown') ORDER BY updated_at LIMIT ?`).all(boundedLimit) as Array<Record<string, unknown>>;
    return rows.map((row) => this.toTrackedRequest(row));
  });

  ensureGeneration = (
    inputId: string,
    requestRevision: string,
    draftRevision: number,
    messages: readonly RenderedInputMessage[],
    now: number,
    force = false,
  ): InputMessageRecord[] | null => this.operation(() => {
    this.validateNow(now);
    this.readLimit(messages.length, 1_000);
    return this.transaction(() => {
      const request = this.readRequest(inputId, requestRevision);
      if (!request || request.lifecycle !== "active" || request.submissionState === "intent" ||
        request.submissionState === "accepted" ||
        request.draftRevision !== draftRevision) return null;
      if (!force && request.renderedDraftRevision === draftRevision && request.currentGeneration > 0) {
        return this.messagesForRequest(inputId, requestRevision).filter((message) => message.generation === request.currentGeneration);
      }
      if (messages.length === 0) return null;
      const generation = request.currentGeneration + 1;
      const currentRows = request.currentGeneration > 0
        ? this.messagesForRequest(inputId, requestRevision).filter((message) => message.generation === request.currentGeneration)
        : [];
      const sameDraftRefresh = force && request.renderedDraftRevision === draftRevision && currentRows.length > 0;
      const carriedOrdinals = new Set<number>();
      if (sameDraftRefresh) {
        for (const row of currentRows) {
          if (row.draftRevision === draftRevision && row.cleanupState === "none" &&
            ["prepared", "sending", "unknown", "rejected"].includes(row.state)) {
            carriedOrdinals.add(row.ordinal);
          }
        }
      }
      const newMessageCount = messages.filter((_message, ordinal) => !carriedOrdinals.has(ordinal)).length;
      let currentCount = this.count("SELECT COUNT(*) AS count FROM input_messages");
      let identityCount = this.count("SELECT COUNT(*) AS count FROM input_card_identities");
      if (currentCount + newMessageCount > maxMessages || identityCount + newMessageCount > maxCardIdentities || this.databaseNearCapacity()) {
        this.compactTerminalPayloadsInTransaction(now);
        this.compactCleanedMessagePayloadsInTransaction();
        currentCount = this.count("SELECT COUNT(*) AS count FROM input_messages");
        identityCount = this.count("SELECT COUNT(*) AS count FROM input_card_identities");
      }
      if (currentCount + newMessageCount > maxMessages) throw new InputStoreError("input message storage is full");
      if (identityCount + newMessageCount > maxCardIdentities) throw new InputStoreError("input card identity storage is full");
      for (const row of currentRows) {
        if (carriedOrdinals.has(row.ordinal)) {
          this.db.prepare("UPDATE input_messages SET generation=?,presentation_revision=? WHERE delivery_key=?")
            .run(generation, request.presentationRevision, row.deliveryKey);
          this.db.prepare("UPDATE input_card_identities SET generation=?,draft_revision=?,presentation_revision=? WHERE delivery_key=?")
            .run(generation, draftRevision, request.presentationRevision, row.deliveryKey);
        }
      }
      this.db.prepare(`UPDATE input_messages SET state='abandoned',
        cleanup_state=CASE WHEN cleanup_state='none' THEN 'deleted' ELSE cleanup_state END
        WHERE input_id=? AND request_revision=? AND generation<? AND state='prepared'`).run(inputId, requestRevision, generation);
      this.db.prepare(`UPDATE input_requests SET current_generation=?, rendered_draft_revision=?,
        rendered_presentation_revision=?, updated_at=?
        WHERE input_id=? AND request_revision=?`).run(
        generation, draftRevision, request.presentationRevision, now, inputId, requestRevision,
      );
      const insert = this.db.prepare(`INSERT INTO input_messages(
        delivery_key,input_id,request_revision,generation,draft_revision,presentation_revision,ordinal,question_id,fragment,
        focus_id,text,buttons_json,state,created_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,'prepared',?)`);
      const reserveIdentity = this.db.prepare(`INSERT INTO input_card_identities(
        input_id,request_revision,delivery_key,generation,draft_revision,presentation_revision,question_id
      ) VALUES(?,?,?,?,?,?,?)`);
      messages.forEach((message, ordinal) => {
        if (carriedOrdinals.has(ordinal)) return;
        const deliveryKey = stableKey(inputId, requestRevision, String(generation), String(draftRevision), String(ordinal));
        insert.run(
          deliveryKey, inputId, requestRevision, generation, draftRevision, request.presentationRevision, ordinal,
          message.questionId, message.fragment, message.focusId ?? null, message.text,
          boundedJson(message.buttons, maxInputButtonsJsonBytes, "input buttons"), now,
        );
        reserveIdentity.run(inputId, requestRevision, deliveryKey, generation, draftRevision,
          request.presentationRevision, message.questionId);
      });
      return this.messagesForRequest(inputId, requestRevision).filter((message) => message.generation === generation);
    });
  });

  ensurePresentation = (
    inputId: string,
    requestRevision: string,
    draftRevision: number,
    presentationRevision: number,
    presentation: InputPresentation,
    message: RenderedInputMessage,
    now: number,
    force = false,
  ): InputMessageRecord | null => this.operation(() => {
    this.validateNow(now);
    return this.transaction(() => {
      const request = this.readRequest(inputId, requestRevision);
      if (!request || request.lifecycle !== "active" || request.nativeTerminal ||
        request.submissionState === "intent" || request.submissionState === "accepted" ||
        request.draftRevision !== draftRevision ||
        request.presentationRevision !== presentationRevision) return null;
      const currentRows = request.currentGeneration > 0
        ? this.messagesForRequest(inputId, requestRevision).filter((item) => item.generation === request.currentGeneration)
        : [];
      const existingCurrent = currentRows.find((item) => item.state === "prepared" || item.state === "rejected");
      if (!force && request.renderedDraftRevision === draftRevision &&
        request.renderedPresentationRevision === presentationRevision && existingCurrent) return existingCurrent;
      if (!force && request.renderedDraftRevision === draftRevision &&
        request.renderedPresentationRevision === presentationRevision && currentRows.length > 0) {
        return currentRows.find((item) => item.state === "sent") ?? currentRows[0] ?? null;
      }
      const allRows = this.messagesForRequest(inputId, requestRevision);
      if (allRows.some((item) => item.state === "unknown" || item.state === "sending")) return null;
      if (force && request.renderedDraftRevision === draftRevision &&
        request.renderedPresentationRevision === presentationRevision) {
        if (request.presentationRevision >= Number.MAX_SAFE_INTEGER) throw new InputStoreError("input presentation revision is exhausted");
        presentationRevision += 1;
      }
      if (presentationRevision === 0) presentationRevision = 1;
      const normalized = normalizeInputPresentation(request.request, request.answers, presentation);
      if ((message.focusId ?? null) !== (normalized.focusId ?? null)) {
        throw new InputStoreError("rendered text focus does not match the stored presentation");
      }
      let previousCard: InputMessageRecord | null = null;
      for (const item of [...allRows].sort((left, right) => right.generation - left.generation || left.ordinal - right.ordinal)) {
        if (item.state === "sent" && item.messageId !== null && item.cleanupState === "none" && !isInputNotification(item)) {
          previousCard = item;
          break;
        }
      }
      if (previousCard === null && allRows.some((item) => !isInputNotification(item) && item.messageId !== null &&
        item.cleanupState !== "deleted" && item.cleanupState !== "expired")) return null;
      const generation = request.currentGeneration + 1;
      const deliveryKey = stableKey(
        "input-card", inputId, requestRevision, String(generation), String(presentationRevision), String(draftRevision),
      );
      if (this.count("SELECT COUNT(*) AS count FROM input_messages") >= maxMessages ||
        this.count("SELECT COUNT(*) AS count FROM input_card_identities") >= maxCardIdentities || this.databaseNearCapacity()) {
        this.compactTerminalPayloadsInTransaction(now);
        this.compactCleanedMessagePayloadsInTransaction();
      }
      if (this.count("SELECT COUNT(*) AS count FROM input_messages") >= maxMessages) throw new InputStoreError("input message storage is full");
      if (this.count("SELECT COUNT(*) AS count FROM input_card_identities") >= maxCardIdentities) {
        throw new InputStoreError("input card identity storage is full");
      }
      this.db.prepare(`UPDATE input_messages SET state='abandoned',
        cleanup_state=CASE WHEN message_id IS NULL AND cleanup_state='none' THEN 'deleted' ELSE cleanup_state END
        WHERE input_id=? AND request_revision=? AND state IN ('prepared','rejected')`).run(inputId, requestRevision);
      this.db.prepare(`INSERT INTO input_messages(
        delivery_key,input_id,request_revision,generation,draft_revision,presentation_revision,is_edit,
        ordinal,question_id,fragment,focus_id,text,buttons_json,state,message_id,created_at,sent_at,delete_window_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,'prepared',?,?,?,?)`).run(
        deliveryKey, inputId, requestRevision, generation, draftRevision, presentationRevision,
        previousCard === null ? 0 : 1, 0, message.questionId, message.fragment, message.focusId ?? null, message.text,
        boundedJson(message.buttons, maxInputButtonsJsonBytes, "input buttons"),
        previousCard?.messageId ?? null, now, previousCard?.sentAt ?? null,
        previousCard === null ? 0 : previousCard.deleteWindowAt,
      );
      this.db.prepare(`INSERT INTO input_card_identities(
        input_id,request_revision,delivery_key,generation,draft_revision,presentation_revision,question_id,message_id
      ) VALUES(?,?,?,?,?,?,?,?)`).run(
        inputId, requestRevision, deliveryKey, generation, draftRevision, presentationRevision,
        message.questionId, previousCard?.messageId ?? null,
      );
      this.db.prepare(`UPDATE input_requests SET current_generation=?, rendered_draft_revision=?,
        presentation_revision=?, rendered_presentation_revision=?, presentation_json=?, updated_at=?
        WHERE input_id=? AND request_revision=?`).run(
        generation, draftRevision, presentationRevision, presentationRevision,
        boundedJson(normalized, 4_096, "input presentation"), now, inputId, requestRevision,
      );
      return this.messageRow(deliveryKey);
    });
  });

  messagesForRequest = (inputId: string, requestRevision: string): InputMessageRecord[] => this.operation(() => {
    const rows = this.db.prepare(`SELECT * FROM input_messages WHERE input_id=? AND request_revision=?
      ORDER BY generation, ordinal`).all(inputId, requestRevision) as Array<Record<string, unknown>>;
    return rows.map((row) => this.toInputMessage(row));
  });

  dueMessages = (now: number, limit = 100): InputMessageRecord[] => this.operation(() => {
    this.validateNow(now);
      const boundedLimit = this.readLimit(limit, 1_000);
      const rows = this.db.prepare(`SELECT m.* FROM input_messages m
      JOIN input_requests r ON r.input_id=m.input_id AND r.request_revision=m.request_revision
      WHERE (m.state='prepared' OR (m.state='rejected' AND m.send_retry_at<=?)) AND r.lifecycle='active'
      ORDER BY m.created_at,m.input_id,m.request_revision,m.generation,m.ordinal LIMIT ?`).all(now, boundedLimit) as Array<Record<string, unknown>>;
    return rows.map((row) => this.toInputMessage(row));
  });

  beginMessageSend = (deliveryKey: string, now: number): boolean => this.operation(() => {
    this.validateNow(now);
    return this.transaction(() => {
      const row = this.messageRow(deliveryKey);
      if (!row || (row.state !== "prepared" && row.state !== "rejected") || row.sendRetryAt > now) return false;
      const request = this.readRequest(row.inputId, row.requestRevision);
      if (!request || request.lifecycle !== "active" || row.generation !== request.currentGeneration ||
        row.draftRevision !== request.draftRevision || row.presentationRevision !== request.presentationRevision) {
        this.db.prepare(`UPDATE input_messages SET state='abandoned', cleanup_state=CASE WHEN cleanup_state='none'
          THEN 'deleted' ELSE cleanup_state END WHERE delivery_key=? AND state IN ('prepared','rejected')`).run(deliveryKey);
        return false;
      }
      const result = this.db.prepare(`UPDATE input_messages SET state='sending'
        WHERE delivery_key=? AND state IN ('prepared','rejected') AND send_retry_at<=?`).run(deliveryKey, now);
      return Number(result.changes) > 0;
    });
  });

  abandonPreparedMessage = (deliveryKey: string, now: number): boolean => this.operation(() => {
    this.validateNow(now);
    return this.transaction(() => {
      const row = this.messageRow(deliveryKey);
      if (!row || row.state !== "prepared") return false;
      this.db.prepare("UPDATE input_messages SET state='abandoned', error='stale_prepared_message' WHERE delivery_key=?").run(deliveryKey);
      this.db.prepare(`UPDATE input_requests SET rendered_draft_revision=-1, updated_at=?
        WHERE input_id=? AND request_revision=? AND current_generation=?`).run(
        now, row.inputId, row.requestRevision, row.generation,
      );
      return true;
    });
  });

  recordMessageSent = (
    deliveryKey: string,
    messageId: number,
    now: number,
    sentAt: number | null = now,
    deleteWindowAt: number | null = sentAt,
  ): boolean => this.operation(() => {
    this.validateNow(now);
    if (!Number.isSafeInteger(messageId) || messageId <= 0) throw new InputStoreError("Telegram message id is invalid");
    return this.transaction(() => {
      const row = this.messageRow(deliveryKey);
      if (!row || ["sent", "abandoned"].includes(row.state)) return false;
      const request = this.readRequest(row.inputId, row.requestRevision);
      const obsolete = !request || request.lifecycle !== "active" || row.generation !== request.currentGeneration;
      const effectiveSentAt = sentAt ?? row.createdAt;
      const effectiveDeleteWindowAt = deleteWindowAt ?? row.createdAt;
      const cleanupState = obsolete ? this.cleanupStateForDate(effectiveDeleteWindowAt, now) : row.cleanupState;
      const cleanupKey = obsolete ? stableKey("delete", row.inputId, row.requestRevision, String(messageId)) : row.cleanupKey;
      this.db.prepare(`UPDATE input_messages SET state='sent', message_id=?, sent_at=?, delete_window_at=?,
        cleanup_state=?, cleanup_key=?, error=NULL WHERE delivery_key=?`).run(
        messageId, effectiveSentAt, effectiveDeleteWindowAt, cleanupState, cleanupKey, deliveryKey,
      );
      const identity = this.db.prepare(`SELECT message_id FROM input_card_identities
        WHERE input_id=? AND request_revision=? AND delivery_key=?`).get(
        row.inputId, row.requestRevision, deliveryKey,
      ) as Record<string, unknown> | undefined;
      if (!identity) throw new InputStoreError("sent input card has no reserved identity");
      if (identity.message_id !== null && identity.message_id !== undefined && identity.message_id !== messageId) {
        throw new InputStoreError("sent input card identity changed");
      }
      this.db.prepare(`UPDATE input_card_identities SET message_id=?
        WHERE input_id=? AND request_revision=? AND delivery_key=?`).run(
        messageId, row.inputId, row.requestRevision, deliveryKey,
      );
      if (request && !obsolete) {
        this.scheduleOlderMessagesForFragment(
          row.inputId, row.requestRevision, row.generation, row.questionId, row.fragment, now,
        );
        const unfinishedRow = this.db.prepare(`SELECT COUNT(*) AS count FROM input_messages
          WHERE input_id=? AND request_revision=? AND generation=? AND state!='sent'`)
          .get(row.inputId, row.requestRevision, request.currentGeneration) as Record<string, unknown>;
        const unfinished = readRowNumber(unfinishedRow, "count");
        if (unfinished === 0) this.schedulePreviousGenerationsForCleanup(
          row.inputId,
          row.requestRevision,
          request.currentGeneration,
          now,
        );
      }
      return true;
    });
  });

  recordMessagePresented = (
    deliveryKey: string,
    messageId: number,
    now: number,
    sentAt: number | null = now,
    deleteWindowAt: number | null = sentAt,
  ): boolean => this.operation(() => {
    this.validateNow(now);
    if (!Number.isSafeInteger(messageId) || messageId <= 0) throw new InputStoreError("Telegram message id is invalid");
    return this.transaction(() => {
      const row = this.messageRow(deliveryKey);
      if (!row || ["sent", "abandoned"].includes(row.state)) return false;
      if (row.isEdit && row.messageId !== messageId) throw new InputStoreError("edited input card identity changed");
      const request = this.readRequest(row.inputId, row.requestRevision);
      const obsolete = !request || request.lifecycle !== "active" || row.generation !== request.currentGeneration ||
        row.presentationRevision !== request.presentationRevision;
      const priorCard = row.isEdit
        ? this.messagesForRequest(row.inputId, row.requestRevision).find((item) => item.messageId === messageId && item.sentAt !== null)
        : null;
      const currentCard = request && request.currentGeneration !== row.generation
        ? this.messagesForRequest(row.inputId, row.requestRevision).find((item) => item.generation === request.currentGeneration)
        : null;
      const sameActiveCard = request?.lifecycle === "active" &&
        (request.currentGeneration === row.generation && row.messageId === messageId || currentCard?.messageId === messageId);
      const effectiveSentAt = sentAt ?? (row.isEdit ? now : priorCard?.sentAt ?? row.createdAt);
      const effectiveDeleteWindowAt = deleteWindowAt ?? priorCard?.deleteWindowAt ?? row.createdAt;
      const cleanupState = obsolete
        ? sameActiveCard ? "deleted" : this.cleanupStateForDate(effectiveDeleteWindowAt, now)
        : "none";
      const cleanupKey = obsolete && !sameActiveCard
        ? stableKey("delete", row.inputId, row.requestRevision, String(messageId))
        : null;
      this.db.prepare(`UPDATE input_messages SET state='sent', message_id=?, sent_at=?, delete_window_at=?,
        cleanup_state=?, cleanup_key=?, error=NULL WHERE delivery_key=?`).run(
        messageId, effectiveSentAt, effectiveDeleteWindowAt, cleanupState, cleanupKey, deliveryKey,
      );
      const identity = this.db.prepare(`SELECT message_id FROM input_card_identities
        WHERE input_id=? AND request_revision=? AND delivery_key=?`).get(
        row.inputId, row.requestRevision, deliveryKey,
      ) as Record<string, unknown> | undefined;
      if (!identity || identity.message_id !== null && identity.message_id !== undefined && identity.message_id !== messageId) {
        throw new InputStoreError("sent input card has no matching reserved identity");
      }
      this.db.prepare(`UPDATE input_card_identities SET message_id=?
        WHERE input_id=? AND request_revision=? AND delivery_key=?`).run(
        messageId, row.inputId, row.requestRevision, deliveryKey,
      );
      if (!obsolete) {
        const previousRows = this.db.prepare(`SELECT * FROM input_messages WHERE input_id=? AND request_revision=?
          AND delivery_key!=? AND message_id IS NOT NULL`).all(row.inputId, row.requestRevision, deliveryKey) as Array<Record<string, unknown>>;
        const seenMessageIds = new Set<number>();
        for (const previousRow of previousRows) {
          const previous = this.toInputMessage(previousRow);
          if (previous.messageId === null) continue;
          if (previous.messageId === messageId) {
            this.db.prepare(`UPDATE input_messages SET cleanup_state='deleted', cleanup_key=NULL
              WHERE delivery_key=? AND cleanup_state IN ('none','waiting','pending')`).run(previous.deliveryKey);
            continue;
          }
          if (seenMessageIds.has(previous.messageId)) {
            this.db.prepare(`UPDATE input_messages SET cleanup_state='deleted', cleanup_key=NULL
              WHERE delivery_key=? AND cleanup_state IN ('none','waiting','pending')`).run(previous.deliveryKey);
            continue;
          }
          seenMessageIds.add(previous.messageId);
          if (previous.cleanupState === "none") this.scheduleCleanupForMessage(previous, now);
        }
      }
      return true;
    });
  });

  recordMessageUnknown = (deliveryKey: string, error: string, now: number): boolean => this.operation(() => {
    this.validateNow(now);
    return this.transaction(() => {
      const result = this.db.prepare(`UPDATE input_messages SET state='unknown', error=?
        WHERE delivery_key=? AND state IN ('sending','unknown')`).run(normalizeError(error), deliveryKey);
      return Number(result.changes) > 0;
    });
  });

  recordMessageRejected = (deliveryKey: string, error: string, now: number, retryAfterMs = 0): boolean => this.operation(() => {
    this.validateNow(now);
    return this.transaction(() => {
      const row = this.messageRow(deliveryKey);
      if (!row || !["sending", "prepared"].includes(row.state)) return false;
      const attempts = row.sendAttempts + 1;
      const retryAt = now + this.retryDelay(attempts, retryAfterMs);
      const result = this.db.prepare(`UPDATE input_messages SET state='rejected', error=?,
        send_attempts=?, send_retry_at=? WHERE delivery_key=? AND state IN ('sending','prepared')`).run(
        normalizeError(error), attempts, retryAt, deliveryKey,
      );
      return Number(result.changes) > 0;
    });
  });

  applyEvent = (event: InputEvent, now: number, allowInteractive = true): InputEventResult => this.operation(() => {
    this.validateNow(now);
    const updateEpoch = event.updateEpoch ?? 0;
    if (event.eventId.length === 0 || event.eventId.length > 256 || !Number.isSafeInteger(event.messageId) || event.messageId <= 0 ||
      !Number.isSafeInteger(event.updateId) || event.updateId < 0 ||
      (event.updateEpoch !== undefined && (!Number.isSafeInteger(event.updateEpoch) || event.updateEpoch < 0)) ||
      (event.presentationRevision !== undefined && (!Number.isSafeInteger(event.presentationRevision) || event.presentationRevision < 0)) ||
      (event.focusPresentationRevision !== undefined && (!Number.isSafeInteger(event.focusPresentationRevision) || event.focusPresentationRevision < 0)) ||
      (event.deliveryKey !== undefined && (typeof event.deliveryKey !== "string" || event.deliveryKey.length === 0 || event.deliveryKey.length > 128)) ||
      (event.focusId !== undefined && (typeof event.focusId !== "string" || event.focusId.length === 0 || event.focusId.length > 128))) {
      throw new InputStoreError("input event is malformed");
    }
    const payloadHash = createHash("sha256").update(JSON.stringify({
      eventId: event.eventId,
      updateId: event.updateId,
      updateEpoch,
      messageId: event.messageId,
      inputId: event.inputId,
      requestRevision: event.requestRevision,
      draftRevision: event.draftRevision,
      questionId: event.questionId,
      action: event.action,
      value: event.value,
      text: event.text,
      contributionId: event.contributionId,
      edited: event.edited,
      deliveryKey: event.deliveryKey,
      presentationRevision: event.presentationRevision,
      focusId: event.focusId,
      focusPresentationRevision: event.focusPresentationRevision,
    })).digest("hex");
    return this.transaction(() => {
      this.compactTerminalPayloadsInTransaction(now);
      if (this.count("SELECT COUNT(*) AS count FROM input_events") >= maxEvents) {
        this.db.prepare(`DELETE FROM input_events WHERE event_id IN (
          SELECT event_id FROM input_events WHERE acknowledged_at IS NOT NULL ORDER BY acknowledged_at LIMIT 1000
        )`).run();
      }
      if (this.count("SELECT COUNT(*) AS count FROM input_events") >= maxEvents) throw new InputStoreError("input event storage is full");
      const insert = this.db.prepare(`INSERT OR IGNORE INTO input_events(
        event_id,input_id,request_revision,draft_revision,update_id,update_epoch,message_id,question_id,action,payload_hash,processed,received_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        event.eventId, event.inputId, event.requestRevision, event.draftRevision, event.updateId, updateEpoch,
        event.messageId, event.questionId, event.action, payloadHash, event.action === "submit" ? 0 : 1, now,
      );
      const request = this.readRequest(event.inputId, event.requestRevision);
      const currentRevision = request?.draftRevision ?? -1;
      if (Number(insert.changes) === 0) {
        const prior = this.db.prepare("SELECT * FROM input_events WHERE event_id=?").get(event.eventId) as Record<string, unknown> | undefined;
        const sameCore = prior !== undefined && prior.input_id === event.inputId && prior.request_revision === event.requestRevision &&
          prior.draft_revision === event.draftRevision && prior.update_id === event.updateId && prior.update_epoch === updateEpoch &&
          prior.message_id === event.messageId && prior.question_id === event.questionId && prior.action === event.action;
        const storedHash = prior && typeof prior.payload_hash === "string" ? prior.payload_hash : "";
        if (!sameCore || storedHash.length > 0 && storedHash !== payloadHash) {
          return { kind: "ignored", reason: "event_id_conflict", draftRevision: currentRevision };
        }
        if (prior?.action === "submit" && prior.processed === 0) {
          const message = event.deliveryKey ? this.messageRow(event.deliveryKey) : this.messageRowById(event.inputId, event.requestRevision, event.messageId);
          const identity = event.deliveryKey ? this.cardIdentityByDeliveryKey(event.inputId, event.requestRevision, event.deliveryKey)
            : this.cardIdentityByMessageId(event.inputId, event.requestRevision, event.messageId);
          if (allowInteractive && request && (this.isExactCurrentView(request, identity, message, event) ||
            this.isExactLegacySubmit(request, identity, message, event)) &&
            (request.presentation.kind === "review" || this.isExactLegacySubmit(request, identity, message, event)) &&
            request.draftRevision === event.draftRevision &&
            request.submissionState !== "intent" && request.submissionState !== "accepted" && request.submissionState !== "unknown" &&
            !request.nativeTerminal && isInputBatchComplete(request.request.questions, request.answers)) {
            return { kind: "submit", draftRevision: request.draftRevision };
          }
          this.db.prepare("UPDATE input_events SET processed=1 WHERE event_id=?").run(event.eventId);
          return { kind: "ignored", reason: "request_not_editable", draftRevision: currentRevision };
        }
        return { kind: "duplicate", draftRevision: currentRevision };
      }
      if (!request || request.lifecycle !== "active" || request.nativeTerminal ||
        request.submissionState === "intent" || request.submissionState === "accepted" || request.submissionState === "unknown") {
        this.db.prepare("UPDATE input_events SET processed=1 WHERE event_id=?").run(event.eventId);
        return { kind: "ignored", reason: "request_not_editable", draftRevision: currentRevision };
      }

      let message = event.deliveryKey ? this.messageRow(event.deliveryKey) : this.messageRowById(event.inputId, event.requestRevision, event.messageId);
      let identity = event.deliveryKey ? this.cardIdentityByDeliveryKey(event.inputId, event.requestRevision, event.deliveryKey)
        : this.cardIdentityByMessageId(event.inputId, event.requestRevision, event.messageId);
      const screenRevision = event.presentationRevision ?? identity?.presentationRevision ?? 0;
      const registeredView = identity !== null && identity !== undefined &&
        identity.generation <= request.currentGeneration && identity.presentationRevision === screenRevision &&
        (identity.messageId === null || identity.messageId === event.messageId) &&
        (!event.deliveryKey || identity.deliveryKey === event.deliveryKey) &&
        (message === null || !message.isEdit || message.messageId === event.messageId);
      if (!registeredView) {
        this.db.prepare("UPDATE input_events SET processed=1 WHERE event_id=?").run(event.eventId);
        return { kind: "ignored", reason: "message_not_registered", draftRevision: currentRevision };
      }
      if (!identity) throw new InputStoreError("registered input view could not be read");
      if (identity.messageId === null) {
        this.db.prepare(`UPDATE input_card_identities SET message_id=? WHERE input_id=? AND request_revision=? AND delivery_key=?
          AND message_id IS NULL`).run(event.messageId, event.inputId, event.requestRevision, identity.deliveryKey);
      }
      if (message?.messageId === null) {
        this.db.prepare(`UPDATE input_messages SET message_id=?,state='sent',sent_at=COALESCE(sent_at,?),
          delete_window_at=CASE WHEN delete_window_at=0 THEN ? ELSE delete_window_at END
          WHERE delivery_key=? AND state IN ('prepared','sending','unknown','rejected')`).run(
          event.messageId, now, now, message.deliveryKey,
        );
      }
      if (event.deliveryKey && message !== null) {
        const refreshedMessage = this.messageRow(event.deliveryKey);
        const refreshedIdentity = this.cardIdentityByDeliveryKey(event.inputId, event.requestRevision, event.deliveryKey);
        if (!refreshedIdentity) throw new InputStoreError("registered input view disappeared");
        message = refreshedMessage;
        identity = refreshedIdentity;
      }
      const observedCurrentView = message !== null && identity.generation === request.currentGeneration &&
        identity.presentationRevision === request.presentationRevision && screenRevision === request.presentationRevision &&
        identity.messageId === event.messageId && message.deliveryKey === identity.deliveryKey &&
        (!event.deliveryKey || event.deliveryKey === identity.deliveryKey);
      if (observedCurrentView && message !== null && message.state !== "sent") {
        this.db.prepare(`UPDATE input_messages SET state='sent',message_id=?,sent_at=COALESCE(sent_at,?),
          delete_window_at=CASE WHEN delete_window_at=0 THEN ? ELSE delete_window_at END,error=NULL
          WHERE delivery_key=? AND state IN ('prepared','sending','unknown','rejected')`).run(
          event.messageId, now, now, message.deliveryKey,
        );
      }
      const currentQuestionId = request.presentation.kind === "question"
        ? request.request.questions[request.presentation.questionIndex]?.id ?? null
        : null;
      const currentView = (this.isExactCurrentView(request, identity, message, event) ||
        this.isExactLegacySubmit(request, identity, message, event)) && screenRevision === request.presentationRevision;
      const eventDone = (reason: string): InputEventResult => {
        if (allowInteractive && (event.action === "answer" || event.action === "stale") && event.contributionId) {
          if (request.presentationRevision >= Number.MAX_SAFE_INTEGER) throw new InputStoreError("input revision is exhausted");
          this.db.prepare(`UPDATE input_requests SET presentation_json=?,presentation_revision=?,rendered_presentation_revision=-1
            WHERE input_id=? AND request_revision=?`).run(
            boundedJson({ ...request.presentation, replyNotice: event.text?.startsWith("This native input does not accept images")
              ? "text_required" : "not_saved" }, 4_096, "input presentation"),
            request.presentationRevision + 1, event.inputId, event.requestRevision,
          );
        }
        this.db.prepare("UPDATE input_events SET processed=1 WHERE event_id=?").run(event.eventId);
        return { kind: "ignored", reason, draftRevision: currentRevision };
      };

      if (!allowInteractive) return eventDone("notification_only");

      if (["answer", "select", "deselect", "skip"].includes(event.action) && event.questionId !== null) {
        const tombstone = request.answerTombstones[event.questionId];
        if (tombstone) {
          const updateEpoch = event.updateEpoch ?? 0;
          const isAfterClear = updateEpoch > tombstone.updateEpoch ||
            updateEpoch === tombstone.updateEpoch && event.updateId > tombstone.updateId;
          const editsClearedContribution = event.action === "answer" && event.edited === true &&
            event.contributionId !== undefined && event.contributionId === tombstone.contributionId;
          if (!isAfterClear || event.draftRevision < tombstone.draftRevision ||
            screenRevision < tombstone.presentationRevision || editsClearedContribution) {
            return eventDone("stale_after_clear");
          }
        }
      }

      if (event.action === "stale") return eventDone("stale");
      if (["navigate", "review", "edit_text", "clear", "submit"].includes(event.action)) {
        const legacySubmit = this.isExactLegacySubmit(request, identity, message, event);
        if (!currentView || (event.questionId !== currentQuestionId && !legacySubmit) ||
          event.draftRevision !== request.draftRevision) {
          return eventDone("stale_presentation");
        }
      }
      if (event.action === "navigate" || event.action === "review") {
        const target = parseInputNavigation(
          request.request,
          request.answers,
          event.action === "review" ? event.value ?? "review:0" : event.value ?? "",
        );
        if (!target) return eventDone("invalid_navigation");
        if (request.presentationRevision >= Number.MAX_SAFE_INTEGER) throw new InputStoreError("input presentation revision is exhausted");
        const nextPresentation = {
          ...target,
          focusQuestionId: target.kind === "question" && request.request.questions[target.questionIndex]?.id === request.presentation.focusQuestionId
            ? request.presentation.focusQuestionId : null,
          focusId: target.kind === "question" && request.request.questions[target.questionIndex]?.id === request.presentation.focusQuestionId
            ? request.presentation.focusId ?? null : null,
        };
        const nextRevision = request.presentationRevision + 1;
        this.db.prepare(`UPDATE input_requests SET presentation_json=?, presentation_revision=?,
          rendered_presentation_revision=-1, updated_at=? WHERE input_id=? AND request_revision=?`).run(
          boundedJson(nextPresentation, 4_096, "input presentation"), nextRevision, now, event.inputId, event.requestRevision,
        );
        this.db.prepare("UPDATE input_events SET processed=1 WHERE event_id=?").run(event.eventId);
        return { kind: "presented", draftRevision: currentRevision, presentationRevision: nextRevision };
      }
      if (event.action === "edit_text") {
        const question = request.request.questions.find((item) => item.id === event.questionId);
        if (!question || !(question.kind === "free_text" || question.allowCustomAnswer) || !event.focusId) {
          return eventDone("text_focus_invalid");
        }
        const priorFocus = this.db.prepare("SELECT * FROM input_text_focuses WHERE focus_id=?")
          .get(event.focusId) as Record<string, unknown> | undefined;
        if (priorFocus && (priorFocus.input_id !== event.inputId || priorFocus.request_revision !== event.requestRevision ||
          priorFocus.message_id !== event.messageId || priorFocus.question_id !== question.id ||
          priorFocus.draft_revision !== event.draftRevision || priorFocus.presentation_revision !== screenRevision ||
          priorFocus.delivery_key !== identity.deliveryKey)) {
          return eventDone("text_focus_id_conflict");
        }
        if (request.presentationRevision >= Number.MAX_SAFE_INTEGER) throw new InputStoreError("input presentation revision is exhausted");
        this.db.prepare(`INSERT OR IGNORE INTO input_text_focuses(
          focus_id,input_id,request_revision,message_id,question_id,draft_revision,presentation_revision,delivery_key,created_at
        ) VALUES(?,?,?,?,?,?,?,?,?)`).run(
          event.focusId, event.inputId, event.requestRevision, event.messageId, question.id,
          event.draftRevision, screenRevision, identity.deliveryKey, now,
        );
        const nextPresentation: InputPresentation = {
          ...request.presentation,
          focusQuestionId: question.id,
          focusId: event.focusId,
        };
        const nextRevision = request.presentationRevision + 1;
        this.db.prepare(`UPDATE input_requests SET presentation_json=?, presentation_revision=?,
          rendered_presentation_revision=-1, updated_at=? WHERE input_id=? AND request_revision=?`).run(
          boundedJson(nextPresentation, 4_096, "input presentation"), nextRevision, now, event.inputId, event.requestRevision,
        );
        this.db.prepare("UPDATE input_events SET processed=1 WHERE event_id=?").run(event.eventId);
        return { kind: "presented", draftRevision: currentRevision, presentationRevision: nextRevision };
      }
      if (event.action === "submit") {
        if ((request.presentation.kind !== "review" && !this.isExactLegacySubmit(request, identity, message, event)) || event.questionId !== null ||
          !isInputBatchComplete(request.request.questions, request.answers)) return eventDone("incomplete_or_malformed_submit");
        return { kind: "submit", draftRevision: currentRevision };
      }
      if (event.action === "clear") {
        if (event.questionId === null) return eventDone("missing_question");
        const answers = { ...request.answers };
        const clearedAnswer = answers[event.questionId] as InputAnswerWithSource | undefined;
        if (!clearedAnswer) return eventDone("answer_already_clear");
        delete answers[event.questionId];
        if (request.draftRevision >= Number.MAX_SAFE_INTEGER || request.presentationRevision >= Number.MAX_SAFE_INTEGER) {
          throw new InputStoreError("input revision is exhausted");
        }
        const nextDraftRevision = request.draftRevision + 1;
        const nextPresentationRevision = request.presentationRevision + 1;
        const answerTombstones = {
          ...request.answerTombstones,
          [event.questionId]: {
            updateId: event.updateId,
            updateEpoch,
            draftRevision: nextDraftRevision,
            presentationRevision: nextPresentationRevision,
            ...(clearedAnswer.contributionId === null ? {} : { contributionId: clearedAnswer.contributionId }),
          },
        };
        const presentation = normalizeInputPresentation(request.request, answers,
          request.presentation.focusQuestionId === event.questionId
            ? { ...request.presentation, focusQuestionId: null, focusId: null }
            : request.presentation);
        this.db.prepare(`UPDATE input_requests SET answers_json=?,answer_tombstones_json=?,draft_revision=?,submission_state='none',
          submission_draft_revision=NULL,submission_answers_json=NULL,rendered_draft_revision=-1,
          presentation_json=?,presentation_revision=?,rendered_presentation_revision=-1,updated_at=?
          WHERE input_id=? AND request_revision=?`).run(
          boundedJson(answers, INPUT_MAX_ANSWERS_JSON_BYTES, "input answers"),
          boundedJson(answerTombstones, INPUT_MAX_ANSWERS_JSON_BYTES, "input answer tombstones"), nextDraftRevision,
          boundedJson(presentation, 4_096, "input presentation"), nextPresentationRevision, now, event.inputId, event.requestRevision,
        );
        this.db.prepare("UPDATE input_events SET processed=1 WHERE event_id=?").run(event.eventId);
        return { kind: "changed", draftRevision: nextDraftRevision };
      }

      const currentAnswer = event.questionId === null
        ? undefined
        : request.answers[event.questionId] as InputAnswerWithSource | undefined;
      if (event.action === "answer") {
        if (identity.questionId === null && event.edited !== true) return eventDone("review_reply");
        if (event.focusId) {
          const focus = this.db.prepare(`SELECT * FROM input_text_focuses WHERE focus_id=? AND input_id=? AND request_revision=?`)
            .get(event.focusId, event.inputId, event.requestRevision) as Record<string, unknown> | undefined;
          if (!focus || focus.message_id !== event.messageId || focus.question_id !== event.questionId ||
            focus.draft_revision !== event.draftRevision || focus.presentation_revision !== event.focusPresentationRevision) {
            return eventDone("text_focus_mismatch");
          }
        } else if (event.edited === true && currentAnswer && currentAnswer.contributionId === event.contributionId &&
          currentAnswer.sourceMessageId === event.messageId) {
          // the bridge contribution ledger preserves the owning question for legacy text replies
        } else if (identity.questionId === null || identity.questionId !== event.questionId ||
          identity.draftRevision !== event.draftRevision || message?.focusId) {
          return eventDone("text_question_mismatch");
        }
        if (currentAnswer && currentAnswer.contributionId === event.contributionId && currentAnswer.sourceMessageId !== undefined &&
          currentAnswer.sourceMessageId !== event.messageId) return eventDone("contribution_source_mismatch");
      } else if (event.action === "select" || event.action === "deselect" || event.action === "skip") {
        if (identity.questionId !== event.questionId || identity.draftRevision !== event.draftRevision) return eventDone("message_question_mismatch");
      } else if (event.action !== "answer") {
        return eventDone("unsupported_action");
      }
      const reduction = reduceInputEvent({
        inputId: event.inputId,
        request: request.request,
        draftRevision: request.draftRevision,
        answers: request.answers,
        event,
      });
      if (reduction.kind === "ignored") return eventDone(reduction.reason);
      if (reduction.kind === "submit") return { kind: "submit", draftRevision: currentRevision };
      if (reduction.kind === "unchanged") {
        const answers = withContributionSources(reduction.answers, request.answers, event);
        if (answers !== request.answers) {
          this.db.prepare(`UPDATE input_requests SET answers_json=?, answer_order_version=1, updated_at=?
            WHERE input_id=? AND request_revision=?`).run(
            boundedJson(answers, INPUT_MAX_ANSWERS_JSON_BYTES, "input answers"), now, event.inputId, event.requestRevision,
          );
        }
        this.db.prepare("UPDATE input_events SET processed=1 WHERE event_id=?").run(event.eventId);
        return { kind: "unchanged", draftRevision: currentRevision };
      }
      if (request.draftRevision >= Number.MAX_SAFE_INTEGER || request.presentationRevision >= Number.MAX_SAFE_INTEGER) {
        throw new InputStoreError("input revision is exhausted");
      }
      const answers = withContributionSources(reduction.answers, request.answers, event);
      const nextPresentation = normalizeInputPresentation(request.request, answers, {
        kind: request.presentation.kind, questionIndex: request.presentation.questionIndex,
        page: request.presentation.page, focusQuestionId: request.presentation.focusQuestionId,
        focusId: request.presentation.focusId ?? null,
      });
      this.db.prepare(`UPDATE input_requests SET answers_json=?, answer_order_version=1, draft_revision=?, submission_state='none',
        submission_draft_revision=NULL, submission_answers_json=NULL, rendered_draft_revision=-1,
        presentation_json=?,presentation_revision=?,rendered_presentation_revision=-1,updated_at=?
        WHERE input_id=? AND request_revision=?`).run(
        boundedJson(answers, INPUT_MAX_ANSWERS_JSON_BYTES, "input answers"), reduction.draftRevision,
        boundedJson(nextPresentation, 4_096, "input presentation"), request.presentationRevision + 1, now,
        event.inputId, event.requestRevision,
      );
      this.db.prepare("UPDATE input_events SET processed=1 WHERE event_id=?").run(event.eventId);
      return { kind: "changed", draftRevision: reduction.draftRevision };
    });
  });

  prepareSubmission = (
    inputId: string,
    requestRevision: string,
    draftRevision: number,
    now: number,
  ): InputSubmissionIntent | null => this.operation(() => {
    this.validateNow(now);
    return this.transaction(() => {
      const request = this.readRequest(inputId, requestRevision);
      if (!request || request.lifecycle !== "active" || request.nativeTerminal || request.draftRevision !== draftRevision ||
        request.submissionState === "intent" || request.submissionState === "accepted" || request.submissionState === "unknown" ||
        (request.submissionState === "rejected" && request.submissionDraftRevision === draftRevision) ||
        !isInputBatchComplete(request.request.questions, request.answers)) return null;
      const answers = nativeInputAnswers(request.request.questions, request.answers);
      this.db.prepare(`UPDATE input_requests SET submission_state='intent', submission_draft_revision=?,
        submission_answers_json=?, updated_at=? WHERE input_id=? AND request_revision=?`).run(
        draftRevision, boundedJson(answers, INPUT_MAX_ANSWERS_JSON_BYTES, "submission answers"), now, inputId, requestRevision,
      );
      return {
        inputId,
        environmentId: request.environmentId,
        threadId: request.threadId,
        requestId: request.requestId,
        requestRevision,
        definitionHash: request.definitionHash,
        draftRevision,
        answers,
      };
    });
  });

  recordSubmission = (
    inputId: string,
    requestRevision: string,
    state: "accepted" | "rejected" | "unknown",
    now: number,
  ): boolean => this.operation(() => {
    this.validateNow(now);
    return this.transaction(() => {
      const result = this.db.prepare(`UPDATE input_requests SET submission_state=?, lifecycle=?,
        rendered_draft_revision=CASE WHEN ? IN ('rejected','unknown') THEN -1 ELSE rendered_draft_revision END,
        presentation_revision=CASE WHEN ? IN ('rejected','unknown') THEN presentation_revision+1 ELSE presentation_revision END,
        rendered_presentation_revision=CASE WHEN ? IN ('rejected','unknown') THEN -1 ELSE rendered_presentation_revision END,
        updated_at=?
        WHERE input_id=? AND request_revision=? AND submission_state='intent'`).run(
        state, state === "accepted" ? "retiring" : "active", state, state, state, now, inputId, requestRevision,
      );
      if (Number(result.changes) > 0 && state === "accepted") {
        this.scheduleCurrentMessagesForCleanup(inputId, requestRevision, now);
      }
      return Number(result.changes) > 0;
    });
  });

  dueCleanupMessages = (now: number, limit = 100): InputMessageRecord[] => this.operation(() => {
    this.validateNow(now);
    const boundedLimit = this.readLimit(limit, 1_000);
    return this.transaction(() => {
      const uncertaintyCutoff = now - INPUT_CLEANUP_UNCERTAINTY_TTL_MS;
      this.db.prepare(`INSERT OR IGNORE INTO input_cleanup_history
        SELECT m.delivery_key,m.cleanup_key,m.message_id,r.thread_id,'expired','send_unconfirmed_expired',m.created_at,?
        FROM input_messages m JOIN input_requests r ON r.input_id=m.input_id AND r.request_revision=m.request_revision
        WHERE m.state='unknown' AND m.message_id IS NULL AND m.cleanup_state='waiting'
          AND r.native_terminal=1 AND r.lifecycle='retired' AND r.retirement_state='sent'
          AND m.created_at<=?`).run(now, uncertaintyCutoff);
      this.db.prepare(`UPDATE input_messages SET cleanup_state='expired',cleanup_error='send_unconfirmed_expired'
        WHERE state='unknown' AND message_id IS NULL AND cleanup_state='waiting' AND created_at<=?
          AND EXISTS (
            SELECT 1 FROM input_requests r WHERE r.input_id=input_messages.input_id
              AND r.request_revision=input_messages.request_revision AND r.native_terminal=1
              AND r.lifecycle='retired' AND r.retirement_state='sent'
          )`).run(uncertaintyCutoff);
      this.db.prepare("DELETE FROM input_cleanup_history WHERE recorded_at<? OR delivery_key IN (SELECT delivery_key FROM input_cleanup_history ORDER BY recorded_at DESC,delivery_key LIMIT -1 OFFSET 1000)").run(now - 30 * 24 * 60 * 60 * 1000);
      this.db.prepare(`UPDATE input_messages SET cleanup_state='expired'
        WHERE cleanup_state IN ('pending','waiting') AND message_id IS NOT NULL
          AND COALESCE(NULLIF(delete_window_at,0),created_at)<=?`).run(now - INPUT_DELETE_MAX_AGE_MS);
      this.compactTerminalPayloadsInTransaction(now);
      const rows = this.db.prepare(`SELECT * FROM input_messages WHERE cleanup_state='unknown' OR
        (cleanup_state='pending' AND delete_retry_at<=?) ORDER BY created_at,delivery_key LIMIT ?`).all(now, boundedLimit) as Array<Record<string, unknown>>;
      return rows.map((row) => this.toInputMessage(row));
    });
  });

  beginMessageDeletion = (deliveryKey: string, now: number): boolean => this.operation(() => {
    this.validateNow(now);
    return this.transaction(() => {
      const row = this.messageRow(deliveryKey);
      if (!row || row.messageId === null || row.cleanupKey === null || row.cleanupState !== "pending" || row.deleteRetryAt > now) return false;
      if (now - (row.deleteWindowAt || row.createdAt) >= INPUT_DELETE_MAX_AGE_MS) {
        this.db.prepare("UPDATE input_messages SET cleanup_state='expired' WHERE delivery_key=?").run(deliveryKey);
        return false;
      }
      const result = this.db.prepare(`UPDATE input_messages SET cleanup_state='deleting'
        WHERE delivery_key=? AND cleanup_state IN ('pending','unknown')`).run(deliveryKey);
      return Number(result.changes) > 0;
    });
  });

  recordMessageDeleted = (deliveryKey: string, now: number): boolean => this.operation(() => this.transaction(() => {
    this.validateNow(now);
    const result = this.db.prepare(`UPDATE input_messages SET cleanup_state='deleted', cleanup_error=NULL
      WHERE delivery_key=? AND cleanup_state IN ('deleting','unknown')`).run(deliveryKey);
    if (Number(result.changes) > 0) {
      this.compactTerminalPayloadsInTransaction(now);
      this.compactCleanedMessagePayloadsInTransaction();
    }
    return Number(result.changes) > 0;
  }));

  expireUnknownDeletion = (deliveryKey: string, now: number): boolean => this.operation(() => this.transaction(() => {
    this.validateNow(now);
    this.db.prepare(`INSERT OR IGNORE INTO input_cleanup_history
      SELECT m.delivery_key,m.cleanup_key,m.message_id,r.thread_id,'expired','deletion_unconfirmed_expired',m.created_at,?
      FROM input_messages m LEFT JOIN input_requests r ON m.input_id=r.input_id AND m.request_revision=r.request_revision
      WHERE m.delivery_key=? AND m.cleanup_state='unknown'
      AND COALESCE(NULLIF(m.delete_window_at,0),m.created_at)<=?`).run(now, deliveryKey, now - INPUT_CLEANUP_UNCERTAINTY_TTL_MS);
    const result = this.db.prepare(`UPDATE input_messages SET cleanup_state='expired',
      cleanup_error='deletion_unconfirmed_expired' WHERE delivery_key=? AND cleanup_state='unknown'
      AND COALESCE(NULLIF(delete_window_at,0),created_at)<=?`).run(deliveryKey, now - INPUT_CLEANUP_UNCERTAINTY_TTL_MS);
    this.db.prepare("DELETE FROM input_cleanup_history WHERE recorded_at<? OR delivery_key IN (SELECT delivery_key FROM input_cleanup_history ORDER BY recorded_at DESC,delivery_key LIMIT -1 OFFSET 1000)").run(now - 30 * 24 * 60 * 60 * 1000);
    return Number(result.changes) > 0;
  }));

  recordMessageDeleteUnknown = (deliveryKey: string, error: string, now: number): boolean => this.operation(() => {
    this.validateNow(now);
    const result = this.db.prepare(`UPDATE input_messages SET cleanup_state='unknown', cleanup_error=?
      WHERE delivery_key=? AND cleanup_state IN ('deleting','unknown')`).run(normalizeError(error), deliveryKey);
    return Number(result.changes) > 0;
  });

  recordMessageDeleteRejected = (deliveryKey: string, error: string, now: number, retryAfterMs = 0): boolean => this.operation(() => {
    this.validateNow(now);
    return this.transaction(() => {
      const row = this.messageRow(deliveryKey);
      if (!row || row.cleanupState !== "deleting") return false;
      if (row.messageId === null || now - (row.deleteWindowAt || row.createdAt) >= INPUT_DELETE_MAX_AGE_MS) {
        this.db.prepare(`UPDATE input_messages SET cleanup_state='expired', cleanup_error=? WHERE delivery_key=?`).run(
          normalizeError(error), deliveryKey,
        );
        this.compactTerminalPayloadsInTransaction(now);
        return true;
      }
      const attempts = row.deleteAttempts + 1;
      const retryAt = now + this.retryDelay(attempts, retryAfterMs);
      const result = this.db.prepare(`UPDATE input_messages SET cleanup_state='pending', cleanup_error=?,
        delete_attempts=?, delete_retry_at=? WHERE delivery_key=? AND cleanup_state='deleting'`).run(
        normalizeError(error), attempts, retryAt, deliveryKey,
      );
      return Number(result.changes) > 0;
    });
  });

  completeEvent = (eventId: string): void => this.operation(() => {
    this.db.prepare("UPDATE input_events SET processed=1 WHERE event_id=?").run(eventId);
  });

  acknowledgeEvents = (eventIds: readonly string[], now: number): void => this.operation(() => {
    this.validateNow(now);
    if (eventIds.length === 0 || eventIds.length > 100) return;
    this.transaction(() => {
      const statement = this.db.prepare("UPDATE input_events SET acknowledged_at=? WHERE event_id=?");
      for (const id of eventIds) statement.run(now, id);
      this.db.prepare(`DELETE FROM input_events WHERE acknowledged_at IS NOT NULL AND acknowledged_at<?`).run(now - eventRetentionMs);
      this.compactTerminalPayloadsInTransaction(now);
    });
  });

  compactTerminalPayloads = (now: number): { requests: number; messages: number; events: number } => this.operation(() => {
    this.validateNow(now);
    return this.transaction(() => this.compactTerminalPayloadsInTransaction(now));
  });

  recoverInterrupted = (now: number): void => this.operation(() => {
    this.validateNow(now);
    this.transaction(() => {
      this.db.prepare("UPDATE input_messages SET state='unknown', error='interrupted_send' WHERE state='sending'").run();
      this.db.prepare("UPDATE input_messages SET cleanup_state='unknown', cleanup_error='interrupted_delete' WHERE cleanup_state='deleting'").run();
      this.db.prepare(`UPDATE input_requests SET submission_state='unknown', lifecycle='active',
        rendered_draft_revision=-1, updated_at=?
        WHERE submission_state='intent' AND lifecycle='active'`).run(now);
      this.db.prepare(`UPDATE input_requests SET retirement_state='unknown', lifecycle='retiring', updated_at=?
        WHERE retirement_state='intent'`).run(now);
    });
  });

  stats = (): { requests: number; messages: number; pendingCleanup: number; uncertain: number; retiredUnconfirmedSends: number; capacity: InputStoreCapacity } => this.operation(() => {
    const capacity: InputStoreCapacity = {
      activeRequestPayloads: this.count("SELECT COUNT(*) AS count FROM input_requests WHERE compacted=0"),
      maxRequestPayloads: maxRequests,
      requestTombstones: this.count("SELECT COUNT(*) AS count FROM input_request_tombstones"),
      messages: this.count("SELECT COUNT(*) AS count FROM input_messages"),
      maxMessages,
      cardIdentities: this.count("SELECT COUNT(*) AS count FROM input_card_identities"),
      maxCardIdentities,
      events: this.count("SELECT COUNT(*) AS count FROM input_events"),
      maxEvents,
      databasePages: this.pragmaNumber("page_count"),
      databaseFreePages: this.pragmaNumber("freelist_count"),
      maxDatabasePages,
    };
    return {
      requests: capacity.activeRequestPayloads + capacity.requestTombstones,
      messages: capacity.messages,
      pendingCleanup: this.count("SELECT COUNT(*) AS count FROM input_messages WHERE cleanup_state IN ('waiting','pending','deleting','unknown')"),
      uncertain: this.count(`SELECT (SELECT COUNT(*) FROM input_messages m WHERE m.state='unknown'
          AND NOT (m.cleanup_state='expired' AND m.cleanup_error IS 'send_unconfirmed_expired')) +
        (SELECT COUNT(*) FROM input_messages WHERE cleanup_state='unknown') +
        (SELECT COUNT(*) FROM input_requests WHERE submission_state='unknown' OR retirement_state='unknown') AS count`),
      // retain terminal send uncertainty for reconciliation without blocking new questions.
      retiredUnconfirmedSends: this.count(`SELECT COUNT(*) AS count FROM input_messages m JOIN input_requests r
        ON r.input_id=m.input_id AND r.request_revision=m.request_revision
        WHERE m.state='unknown' AND m.message_id IS NULL AND m.is_edit=0 AND m.cleanup_state='waiting'
          AND r.native_terminal=1 AND r.lifecycle='retired' AND r.retirement_state='sent'`),
      capacity,
    };
  });

  private operation<A>(run: () => A): A {
    try {
      const value = run();
      secureFiles(this.databasePath);
      return value;
    } catch (cause) {
      if (cause instanceof InputStoreError || cause instanceof InputDomainError) throw cause;
      throw new InputStoreError("durable input store operation failed", { cause });
    }
  }

  private transaction<A>(run: () => A): A {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const value = run();
      this.db.exec("COMMIT");
      return value;
    } catch (cause) {
      try { this.db.exec("ROLLBACK"); } catch { /* rollback may fail if SQLite already aborted */ }
      throw cause;
    }
  }

  private ensureColumn(table: string, column: string, definition: string): void {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<Record<string, unknown>>;
    if (columns.some((row) => row.name === column)) return;
    this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }

  private pragmaNumber(name: "page_count" | "freelist_count"): number {
    const row = this.db.prepare(`PRAGMA ${name}`).get() as Record<string, unknown> | undefined;
    const value = row?.[name];
    if (typeof value === "bigint") return Number(value);
    if (typeof value !== "number") throw new InputStoreError("input store capacity is unavailable");
    return value;
  }

  private databaseNearCapacity(): boolean {
    return this.pragmaNumber("page_count") - this.pragmaNumber("freelist_count") >= maxDatabasePages - 2_048;
  }

  private retryDelay(attempt: number, retryAfterMs: number): number {
    const exponent = Math.min(Math.max(attempt - 1, 0), 20);
    const backoff = Math.min(retryBaseMs * 2 ** exponent, retryBackoffMaxMs);
    const serverDelay = Number.isFinite(retryAfterMs) && retryAfterMs > 0
      ? Math.min(retryAfterMs, retryAfterMaxMs)
      : 0;
    return Math.max(backoff, serverDelay);
  }

  private hasTombstone(inputId: string, requestRevision: string): boolean {
    return this.db.prepare(`SELECT 1 FROM input_request_tombstones WHERE input_id=? AND request_revision=?`)
      .get(inputId, requestRevision) !== undefined;
  }

  private compactTerminalPayloadsInTransaction(now: number): { requests: number; messages: number; events: number } {
    const rows = this.db.prepare(`SELECT r.input_id,r.request_revision,r.definition_hash FROM input_requests r
      WHERE r.native_terminal=1 AND r.lifecycle='retired' AND r.retirement_state='sent'
        AND r.submission_state NOT IN ('intent','unknown')
        AND NOT EXISTS (
          SELECT 1 FROM input_messages m WHERE m.input_id=r.input_id AND m.request_revision=r.request_revision
            AND (m.state NOT IN ('sent','rejected','abandoned') OR m.cleanup_state NOT IN ('deleted','expired'))
        )
        AND NOT EXISTS (
          SELECT 1 FROM input_events e WHERE e.input_id=r.input_id AND e.request_revision=r.request_revision
            AND e.acknowledged_at IS NULL
        )`).all() as Array<Record<string, unknown>>;
    let compactedRequests = 0;
    let compactedMessages = 0;
    let compactedEvents = 0;
    const insertTombstone = this.db.prepare(`INSERT OR IGNORE INTO input_request_tombstones(
      input_id,request_revision,definition_hash,terminal_at
    ) VALUES(?,?,?,?)`);
    for (const row of rows) {
      const inputId = readRowString(row, "input_id");
      const requestRevision = readRowString(row, "request_revision");
      insertTombstone.run(inputId, requestRevision, readRowString(row, "definition_hash"), now);
      this.db.prepare("DELETE FROM input_card_identities WHERE input_id=? AND request_revision=?")
        .run(inputId, requestRevision);
      this.db.prepare("DELETE FROM input_text_focuses WHERE input_id=? AND request_revision=?")
        .run(inputId, requestRevision);
      compactedMessages += Number(this.db.prepare("DELETE FROM input_messages WHERE input_id=? AND request_revision=?")
        .run(inputId, requestRevision).changes);
      compactedEvents += Number(this.db.prepare("DELETE FROM input_events WHERE input_id=? AND request_revision=?")
        .run(inputId, requestRevision).changes);
      compactedRequests += Number(this.db.prepare(`DELETE FROM input_requests WHERE input_id=? AND request_revision=?
        AND native_terminal=1 AND lifecycle='retired' AND retirement_state='sent'`).run(inputId, requestRevision).changes);
    }
    return { requests: compactedRequests, messages: compactedMessages, events: compactedEvents };
  }

  private compactCleanedMessagePayloadsInTransaction(): number {
    this.db.prepare(`DELETE FROM input_card_identities WHERE message_id IS NULL AND delivery_key IN (
      SELECT delivery_key FROM input_messages WHERE state IN ('rejected','abandoned') AND cleanup_state IN ('deleted','expired')
    )`).run();
    const result = this.db.prepare(`DELETE FROM input_messages WHERE state IN ('sent','rejected','abandoned')
      AND cleanup_state IN ('deleted','expired')
      AND NOT EXISTS (
        SELECT 1 FROM input_events e WHERE e.input_id=input_messages.input_id
          AND e.request_revision=input_messages.request_revision AND e.message_id=input_messages.message_id
          AND e.acknowledged_at IS NULL
      )`).run();
    return Number(result.changes);
  }

  private findRequest(inputId: string, requestRevision: string): TrackedInputRequest | null {
    return this.readRequest(inputId, requestRevision);
  }

  private readRequest(inputId: string, requestRevision: string): TrackedInputRequest | null {
    const row = this.db.prepare(`SELECT * FROM input_requests WHERE input_id=? AND request_revision=? AND compacted=0`)
      .get(inputId, requestRevision) as Record<string, unknown> | undefined;
    return row ? this.toTrackedRequest(row) : null;
  }

  private toTrackedRequest(row: Record<string, unknown>): TrackedInputRequest {
    const request = readJson<NativeInputRequest>(readRowString(row, "request_json"));
    const submissionState = readRowString(row, "submission_state");
    const lifecycle = readRowString(row, "lifecycle");
    const retirementState = readRowString(row, "retirement_state");
    if (!["none", "intent", "accepted", "rejected", "unknown"].includes(submissionState) ||
      !["active", "retiring", "retired"].includes(lifecycle) ||
      !["none", "intent", "sent", "unknown"].includes(retirementState)) throw new InputStoreError("input request row has an invalid state");
    const answersJson = readRowString(row, "answers_json");
    const answers = readJson<InputAnswers>(answersJson);
    const answerTombstones = readJson<InputAnswerTombstones>(readRowString(row, "answer_tombstones_json"));
    const presentation = normalizeInputPresentation(
      request,
      answers,
      readJson<InputPresentation>(readRowString(row, "presentation_json")),
    );
    const submissionAnswersJson = readOptionalString(row, "submission_answers_json");
    return {
      inputId: readRowString(row, "input_id"),
      environmentId: readRowString(row, "environment_id"),
      threadId: readRowString(row, "thread_id"),
      requestId: readRowString(row, "native_request_id"),
      requestRevision: readRowString(row, "request_revision"),
      definitionHash: readRowString(row, "definition_hash"),
      request,
      draftRevision: readRowNumber(row, "draft_revision"),
      answers,
      answerTombstones,
      submissionState: submissionState as TrackedInputRequest["submissionState"],
      submissionDraftRevision: readOptionalNumber(row, "submission_draft_revision"),
      submissionAnswers: submissionAnswersJson === null ? null : readJson(submissionAnswersJson),
      lifecycle: lifecycle as InputLifecycle,
      nativeTerminal: readRowNumber(row, "native_terminal") === 1,
      retirementState: retirementState as InputRetirementState,
      retirementKey: readOptionalString(row, "retirement_key"),
      currentGeneration: readRowNumber(row, "current_generation"),
      renderedDraftRevision: readRowNumber(row, "rendered_draft_revision"),
      presentationRevision: readRowNumber(row, "presentation_revision"),
      renderedPresentationRevision: readRowNumber(row, "rendered_presentation_revision"),
      presentation,
      createdAt: readRowNumber(row, "created_at"),
      updatedAt: readRowNumber(row, "updated_at"),
      lastSeenAt: readRowNumber(row, "last_seen_at"),
    };
  }

  private messageRow(deliveryKey: string): InputMessageRecord | null {
    const row = this.db.prepare("SELECT * FROM input_messages WHERE delivery_key=?").get(deliveryKey) as Record<string, unknown> | undefined;
    return row ? this.toInputMessage(row) : null;
  }

  private messageRowById(inputId: string, requestRevision: string, messageId: number): InputMessageRecord | null {
    const row = this.db.prepare(`SELECT * FROM input_messages WHERE input_id=? AND request_revision=? AND message_id=?
      ORDER BY generation DESC LIMIT 1`).get(inputId, requestRevision, messageId) as Record<string, unknown> | undefined;
    return row ? this.toInputMessage(row) : null;
  }

  private cardIdentityByDeliveryKey(
    inputId: string,
    requestRevision: string,
    deliveryKey: string,
  ): InputCardIdentity | null {
    const row = this.db.prepare(`SELECT delivery_key,generation,draft_revision,presentation_revision,question_id,message_id
      FROM input_card_identities WHERE input_id=? AND request_revision=? AND delivery_key=?`).get(
      inputId, requestRevision, deliveryKey,
    ) as Record<string, unknown> | undefined;
    return row ? {
      deliveryKey: readRowString(row, "delivery_key"),
      generation: readRowNumber(row, "generation"),
      draftRevision: readRowNumber(row, "draft_revision"),
      presentationRevision: readRowNumber(row, "presentation_revision"),
      questionId: readOptionalString(row, "question_id"),
      messageId: readOptionalNumber(row, "message_id"),
    } : null;
  }

  private cardIdentityByMessageId(
    inputId: string,
    requestRevision: string,
    messageId: number,
  ): InputCardIdentity | null {
    const row = this.db.prepare(`SELECT delivery_key,generation,draft_revision,presentation_revision,question_id,message_id FROM input_card_identities
      WHERE input_id=? AND request_revision=? AND message_id=? ORDER BY generation DESC,presentation_revision DESC LIMIT 1`)
      .get(inputId, requestRevision, messageId) as Record<string, unknown> | undefined;
    return row ? {
      deliveryKey: readRowString(row, "delivery_key"),
      generation: readRowNumber(row, "generation"),
      draftRevision: readRowNumber(row, "draft_revision"),
      presentationRevision: readRowNumber(row, "presentation_revision"),
      questionId: readOptionalString(row, "question_id"),
      messageId: readOptionalNumber(row, "message_id"),
    } : null;
  }

  private isExactCurrentView(
    request: TrackedInputRequest,
    identity: InputCardIdentity | null,
    message: InputMessageRecord | null,
    event: InputEvent,
  ): boolean {
    const questionId = request.presentation.kind === "question"
      ? request.request.questions[request.presentation.questionIndex]?.id ?? null
      : null;
    const presentationRevision = event.presentationRevision ?? identity?.presentationRevision ?? 0;
    return identity !== null && identity !== undefined && message !== null &&
      identity.generation === request.currentGeneration &&
      identity.presentationRevision === request.presentationRevision && presentationRevision === request.presentationRevision &&
      identity.messageId === event.messageId && identity.questionId === questionId && event.questionId === questionId &&
      message.deliveryKey === identity.deliveryKey && message.generation === request.currentGeneration &&
      message.presentationRevision === request.presentationRevision && message.messageId === event.messageId &&
      (!event.deliveryKey || event.deliveryKey === identity.deliveryKey) &&
      message.cleanupState !== "deleted" && message.cleanupState !== "expired";
  }

  private isExactLegacySubmit(
    request: TrackedInputRequest,
    identity: InputCardIdentity | null,
    message: InputMessageRecord | null,
    event: InputEvent,
  ): boolean {
    return event.action === "submit" && event.presentationRevision === undefined && event.deliveryKey === undefined &&
      event.questionId === null && event.draftRevision === request.draftRevision && identity !== null && message !== null &&
      identity.generation === request.currentGeneration && identity.presentationRevision === request.presentationRevision &&
      identity.questionId === null && identity.messageId === event.messageId && message.state === "sent" &&
      message.generation === request.currentGeneration && message.draftRevision === request.draftRevision &&
      message.questionId === null && message.messageId === event.messageId;
  }

  private toInputMessage(row: Record<string, unknown>): InputMessageRecord {
    const state = readRowString(row, "state");
    const cleanupState = readRowString(row, "cleanup_state");
    if (!["prepared", "sending", "sent", "unknown", "rejected", "abandoned"].includes(state) ||
      !["none", "waiting", "pending", "deleting", "unknown", "deleted", "expired"].includes(cleanupState)) {
      throw new InputStoreError("input message row has an invalid state");
    }
    const messageId = readOptionalNumber(row, "message_id");
    return {
      inputId: readRowString(row, "input_id"),
      requestRevision: readRowString(row, "request_revision"),
      generation: readRowNumber(row, "generation"),
      draftRevision: readRowNumber(row, "draft_revision"),
      presentationRevision: readRowNumber(row, "presentation_revision"),
      focusId: readOptionalString(row, "focus_id"),
      isEdit: readRowNumber(row, "is_edit") === 1,
      ordinal: readRowNumber(row, "ordinal"),
      questionId: readOptionalString(row, "question_id"),
      fragment: readRowNumber(row, "fragment"),
      deliveryKey: readRowString(row, "delivery_key"),
      text: readRowString(row, "text"),
      buttons: readJson<RenderedInputMessage["buttons"]>(readRowString(row, "buttons_json")),
      state: state as InputMessageState,
      messageId,
      createdAt: readRowNumber(row, "created_at"),
      sentAt: readOptionalNumber(row, "sent_at"),
      deleteWindowAt: readRowNumber(row, "delete_window_at"),
      error: readOptionalString(row, "error"),
      cleanupState: cleanupState as InputCleanupState,
      cleanupKey: readOptionalString(row, "cleanup_key"),
      cleanupError: readOptionalString(row, "cleanup_error"),
      sendAttempts: readRowNumber(row, "send_attempts"),
      sendRetryAt: readRowNumber(row, "send_retry_at"),
      deleteAttempts: readRowNumber(row, "delete_attempts"),
      deleteRetryAt: readRowNumber(row, "delete_retry_at"),
    };
  }

  private scheduleCurrentMessagesForCleanup(inputId: string, requestRevision: string, now: number): void {
    const request = this.readRequest(inputId, requestRevision);
    if (!request) return;
    const rows = this.db.prepare(`SELECT * FROM input_messages WHERE input_id=? AND request_revision=?
      AND cleanup_state='none'`).all(inputId, requestRevision) as Array<Record<string, unknown>>;
    for (const row of rows) this.scheduleCleanupForMessage(this.toInputMessage(row), now);
  }

  private schedulePreviousGenerationsForCleanup(
    inputId: string,
    requestRevision: string,
    generation: number,
    now: number,
  ): void {
    const rows = this.db.prepare(`SELECT * FROM input_messages WHERE input_id=? AND request_revision=?
      AND generation<? AND cleanup_state='none'`).all(inputId, requestRevision, generation) as Array<Record<string, unknown>>;
    for (const row of rows) this.scheduleCleanupForMessage(this.toInputMessage(row), now);
  }

  private scheduleOlderMessagesForFragment(
    inputId: string,
    requestRevision: string,
    generation: number,
    questionId: string | null,
    fragment: number,
    now: number,
  ): void {
    const rows = this.db.prepare(`SELECT * FROM input_messages WHERE input_id=? AND request_revision=?
      AND generation<? AND question_id IS ? AND fragment=? AND cleanup_state='none'`)
      .all(inputId, requestRevision, generation, questionId, fragment) as Array<Record<string, unknown>>;
    for (const row of rows) this.scheduleCleanupForMessage(this.toInputMessage(row), now);
  }

  private scheduleCleanupForMessage(message: InputMessageRecord, now: number): void {
    if (message.cleanupState !== "none" || message.state === "abandoned") return;
    if (message.state === "rejected") {
      this.db.prepare("UPDATE input_messages SET cleanup_state='deleted' WHERE delivery_key=?").run(message.deliveryKey);
      return;
    }
    if (message.state === "prepared") {
      this.db.prepare(`UPDATE input_messages SET state='abandoned', cleanup_state='deleted'
        WHERE delivery_key=?`).run(message.deliveryKey);
      return;
    }
    if (message.messageId === null) {
      this.db.prepare(`UPDATE input_messages SET cleanup_state='waiting'
        WHERE delivery_key=? AND cleanup_state='none'`).run(message.deliveryKey);
      return;
    }
    const cleanupState = this.cleanupStateForDate(message.deleteWindowAt || message.createdAt, now);
    const cleanupKey = stableKey("delete", message.inputId, message.requestRevision, String(message.messageId));
    this.db.prepare(`UPDATE input_messages SET cleanup_state=?, cleanup_key=?
      WHERE delivery_key=? AND cleanup_state='none'`).run(cleanupState, cleanupKey, message.deliveryKey);
  }

  private cleanupStateForDate = (sentAt: number, now: number): InputCleanupState =>
    now - sentAt >= INPUT_DELETE_MAX_AGE_MS ? "expired" : "pending";

  private count(query: string): number {
    const row = this.db.prepare(query).get() as Record<string, unknown> | undefined;
    const value = row?.count;
    if (typeof value === "bigint") return Number(value);
    if (typeof value !== "number") throw new InputStoreError("input store count is invalid");
    return value;
  }

  private readLimit(value: number, max: number): number {
    if (!Number.isSafeInteger(value) || value < 0 || value > max) throw new InputStoreError("input store limit is invalid");
    return value;
  }

  private validateNow(now: number): void {
    if (!Number.isFinite(now) || now < 0) throw new InputStoreError("input store timestamp is invalid");
  }

  private validateKey(key: string): void {
    if (typeof key !== "string" || key.length === 0 || key.length > 128 || /[^a-zA-Z0-9_-]/u.test(key)) {
      throw new InputStoreError("input delivery key is invalid");
    }
  }
}

export const makeInputStore = (dataDirectory: string): InputStore => new InputStore(dataDirectory);

export const inputStoreHelpers = {
  submissionIsComplete(request: NativeInputRequest, answers: InputAnswers): boolean {
    return isInputBatchComplete(request.questions, answers);
  },
};
