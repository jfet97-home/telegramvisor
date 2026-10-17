import { chmodSync, existsSync, mkdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Context, Effect, Layer } from "effect";
import { deliveryKey, timestampMs, utf16Length } from "./domain.js";
import type {
  Job,
  JobState,
  ProjectInfo,
  RecapContext,
  SourceItem,
  TelegramvisorActivity,
  ThreadInfo,
} from "./types.js";
import { createHash } from "node:crypto";
import type { CompletionGap, CompletionGapReason } from "./completion-gap.js";
import type { CompletionRecoveryOperation } from "./completion-recovery.js";

const maxDatabasePages = 16_384;
const maxHints = 20_000;
const maxLiveJobs = 10_000;
const maxIdentities = 250_000;
const maxKnownThreads = 50_000;
const maxStoredShellChars = 512_000;
const maxStoredContextChars = 60_000;
const maxStoredErrorChars = 1_024;
const defaultReconcileBackoffMs = 60_000;
const contextRetentionMs = 7 * 24 * 60 * 60 * 1_000;
const sentRetentionMs = 30 * 24 * 60 * 60 * 1_000;

export class StoreError extends Error {
  readonly _tag: string = "StoreError";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
  }
}

export class EnvironmentMismatchError extends StoreError {
  override readonly _tag = "environment_mismatch";

  constructor() {
    super("store is already bound to a different T3 environment");
  }
}

export interface ThreadHint {
  threadId: string;
  revision: number;
  shell: ThreadInfo | null;
}

export interface StoreStats {
  completionCoverageGaps?: number;
  projects: number;
  threads: number;
  dirtyHints: number;
  deferredHints: number;
  waitingHints: number;
  identities: number;
  jobs: Record<JobState, number>;
  databaseBytes: number;
}

export type SafeDueState = Extract<JobState, "pending" | "ready" | "unknown">;
export type HintDeferKind = "failure" | "settling";

export interface StoreShape {
  recordCompletionGap?(threadId: string, reason: CompletionGapReason, runId: string | null, now: number): Effect.Effect<CompletionGap, StoreError>;
  completionGaps?(): Effect.Effect<CompletionGap[], StoreError>;
  completionGap?(id: string): Effect.Effect<CompletionGap | null, StoreError>;
  reserveCompletionRecovery?(operation: CompletionRecoveryOperation): Effect.Effect<{operation: CompletionRecoveryOperation; created: boolean}, StoreError>;
  finishCompletionRecovery?(gapId: string, commandId: string, outcome: Pick<CompletionRecoveryOperation, "state" | "sequence" | "updatedAt">): Effect.Effect<void, StoreError>;
  catalog(): Effect.Effect<{ projects: Array<{ project: ProjectInfo; available: boolean }>; threads: ThreadInfo[] }, StoreError>;
  history(): Effect.Effect<TelegramvisorActivity[], StoreError>;
  activate(environmentId: string, now: number): Effect.Effect<number, StoreError>;
  configureTelegram(environmentId: string, enabled: boolean, now: number): Effect.Effect<number, StoreError>;
  ingest(source: SourceItem): Effect.Effect<void, StoreError>;
  cursor(stream: SourceItem["stream"]): Effect.Effect<number, StoreError>;
  dueHints(now?: number, limit?: number): Effect.Effect<ThreadHint[], StoreError>;
  doneHint(threadId: string, revision: number): Effect.Effect<boolean, StoreError>;
  deferHint(
    threadId: string,
    revision: number,
    now: number,
    delayMs?: number,
    kind?: HintDeferKind,
  ): Effect.Effect<boolean, StoreError>;
  thread(threadId: string): Effect.Effect<ThreadInfo | null, StoreError>;
  project(threadId: string): Effect.Effect<ProjectInfo | null, StoreError>;
  hasIdentity(environmentId: string, threadId: string, runId: string): Effect.Effect<boolean, StoreError>;
  enqueue(
    environmentId: string,
    threadId: string,
    runId: string,
    context: RecapContext,
    now: number,
  ): Effect.Effect<string | null, StoreError>;
  enqueueReply(environmentId: string, threadId: string, runId: string, parts: string[], now: number): Effect.Effect<string | null, StoreError>;
  dueJobs(now: number, states?: ReadonlyArray<SafeDueState>, limit?: number): Effect.Effect<Job[], StoreError>;
  getJob(id: string): Effect.Effect<Job | null, StoreError>;
  setReady(id: string, text: string, now: number): Effect.Effect<boolean, StoreError>;
  skipRecap(id: string): Effect.Effect<boolean, StoreError>;
  claimSend(id: string, now: number): Effect.Effect<boolean, StoreError>;
  markSent(id: string, messageId: number, now: number): Effect.Effect<boolean, StoreError>;
  markUnknown(id: string, error: string, now: number): Effect.Effect<boolean, StoreError>;
  rejectSend(id: string, error: string, now: number, delayMs?: number): Effect.Effect<boolean, StoreError>;
  retry(id: string, error: string, now: number, delayMs?: number): Effect.Effect<boolean, StoreError>;
  recoverSending(now: number): Effect.Effect<number, StoreError>;
  prune(now: number, expireContexts?: boolean): Effect.Effect<{ contexts: number; sentMetadata: number }, StoreError>;
  stats(): Effect.Effect<StoreStats, StoreError>;
}

export class Store extends Context.Service<Store, StoreShape>()("Store") {}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const readString = (value: unknown, label: string): string => {
  if (typeof value !== "string" || value.length === 0) throw new StoreError(`${label} must be a non-empty string`);
  return value;
};

const readNow = (value: number): number => {
  const result = timestampMs(value);
  if (result === null) throw new StoreError("timestamp must be a finite millisecond value");
  return result;
};

const serialize = (value: unknown, limit: number, label: string): string => {
  const json = JSON.stringify(value);
  if (typeof json !== "string" || json.length > limit) throw new StoreError(`${label} exceeds its storage bound`);
  return json;
};

const normalizeFailure = (cause: unknown): StoreError =>
  cause instanceof StoreError ? cause : new StoreError("durable store operation failed", { cause });

const runStoreOperation = <A>(operation: () => A): Effect.Effect<A, StoreError> =>
  Effect.tryPromise({
    try: () => Promise.resolve().then(operation),
    catch: normalizeFailure,
  });

const rowNumber = (row: Record<string, unknown> | undefined, key: string, fallback = 0): number => {
  const value = row?.[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "bigint") return Number(value);
  return fallback;
};

const rowString = (row: Record<string, unknown> | undefined, key: string): string | null => {
  const value = row?.[key];
  return typeof value === "string" ? value : null;
};

const readThread = (value: unknown): ThreadInfo => {
  if (!isRecord(value) || typeof value.id !== "string" || value.id.length === 0 || typeof value.title !== "string") {
    throw new StoreError("thread shell is missing its id or title");
  }
  if (!isRecord(value.lineage)) throw new StoreError("thread shell is missing lineage metadata");
  return value as unknown as ThreadInfo;
};

const readProject = (value: unknown): ProjectInfo => {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.title !== "string" ||
    typeof value.workspaceRoot !== "string"
  ) throw new StoreError("project shell is missing required metadata");
  return value as unknown as ProjectInfo;
};

const whitelistThreadShell = (thread: ThreadInfo): ThreadInfo => {
  if (thread.id.length > 512) throw new StoreError("thread id exceeds the T3 contract limit");
  const lineage: Record<string, unknown> = isRecord(thread.lineage) ? thread.lineage : {};
  const safe: Record<string, unknown> = {
    id: thread.id,
    title: thread.title,
    projectId: typeof thread.projectId === "string" ? thread.projectId : null,
    lineage: {
      parentThreadId: typeof lineage.parentThreadId === "string" ? lineage.parentThreadId : null,
      relationshipToParent: typeof lineage.relationshipToParent === "string" ? lineage.relationshipToParent : null,
      ...(typeof lineage.rootThreadId === "string" ? { rootThreadId: lineage.rootThreadId } : {}),
    },
  };
  if (thread.creationSource === "provider" || thread.creationSource === "mcp") safe.creationSource = thread.creationSource;
  for (const field of ["activeRunId", "activityRunStatus", "activeProviderThreadId", "latestRunId", "status"]) {
    const value = thread[field];
    if (typeof value === "string" || value === null) safe[field] = value;
  }
  for (const field of [
    "activityRunStartedAt",
    "latestRunRequestedAt",
    "latestRunStartedAt",
    "latestRunCompletedAt",
    "createdAt",
    "updatedAt",
    "archivedAt",
    "deletedAt",
  ]) {
    const value = thread[field];
    if (value === null || typeof value === "string" && timestampMs(value) !== null) safe[field] = value;
  }
  if (Object.hasOwn(thread, "pendingRuntimeRequest")) {
    const request = thread.pendingRuntimeRequest;
    if (request === null) {
      safe.pendingRuntimeRequest = null;
    } else if (isRecord(request)) {
      const safeRequest: Record<string, unknown> = {};
      for (const field of ["id", "kind", "createdAt"]) {
        const value = request[field];
        if (
          typeof value === "string" &&
          (field !== "createdAt" || timestampMs(value) !== null)
        ) safeRequest[field] = value;
      }
      safe.pendingRuntimeRequest = safeRequest;
    } else {
      safe.pendingRuntimeRequest = request ? {} : null;
    }
  }
  if (Array.isArray(thread.pendingBackgroundTasks)) {
    safe.pendingBackgroundTasks = thread.pendingBackgroundTasks.map((task) => {
      if (!isRecord(task)) return { kind: "unknown" };
      return {
        kind: typeof task.kind === "string" ? task.kind : "unknown",
        ...(typeof task.status === "string" ? { status: task.status } : {}),
      };
    });
  } else if (Object.hasOwn(thread, "pendingBackgroundTasks")) {
    safe.pendingBackgroundTasks = [{ kind: "unknown" }];
  }
  return safe as unknown as ThreadInfo;
};

const getRow = (db: DatabaseSync, query: string, ...params: Array<string | number | null>): Record<string, unknown> | undefined =>
  db.prepare(query).get(...params) as Record<string, unknown> | undefined;

const count = (db: DatabaseSync, query: string, ...params: Array<string | number | null>): number =>
  rowNumber(getRow(db, query, ...params), "count");

const secureFiles = (databasePath: string): void => {
  for (const path of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]) {
    if (existsSync(path)) chmodSync(path, 0o600);
  }
};

const schema = `
  CREATE TABLE IF NOT EXISTS completion_gaps (
    id TEXT PRIMARY KEY, thread_id TEXT NOT NULL UNIQUE, run_id TEXT,
    reason TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    recovery TEXT
  );
  CREATE TABLE IF NOT EXISTS recap_audit (
    id TEXT PRIMARY KEY,thread_id TEXT NOT NULL,run_id TEXT NOT NULL,state TEXT NOT NULL,created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS activations (
    environment_id TEXT PRIMARY KEY,
    activated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS environment_binding (
    id INTEGER PRIMARY KEY CHECK(id=1),
    environment_id TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS telegram_configuration (
    environment_id TEXT PRIMARY KEY,
    enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
    notifications_after INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS cursors (
    stream TEXT PRIMARY KEY CHECK(stream IN ('active', 'archive')),
    sequence INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    document TEXT NOT NULL,
    deleted INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS threads (
    id TEXT PRIMARY KEY,
    project_id TEXT,
    document TEXT NOT NULL,
    location TEXT NOT NULL CHECK(location IN ('active', 'archive', 'removed')),
    revision INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS thread_revisions (
    thread_id TEXT PRIMARY KEY,
    revision INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS hints (
    thread_id TEXT PRIMARY KEY,
    revision INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    next_attempt_at INTEGER NOT NULL DEFAULT 0,
    defer_kind TEXT NOT NULL DEFAULT 'failure' CHECK(defer_kind IN ('failure', 'settling'))
  );
  CREATE TABLE IF NOT EXISTS identities (
    delivery_key TEXT PRIMARY KEY,
    environment_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE(environment_id, thread_id, run_id)
  );
  CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    environment_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    delivery_key TEXT NOT NULL UNIQUE,
    state TEXT NOT NULL CHECK(state IN ('pending', 'ready', 'sending', 'sent', 'unknown')),
    context TEXT,
    text TEXT,
    message_id INTEGER,
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    error TEXT
  );
  CREATE INDEX IF NOT EXISTS jobs_run_order ON jobs(environment_id, thread_id, run_id, created_at);
  CREATE INDEX IF NOT EXISTS jobs_due ON jobs(state, next_attempt_at, created_at);
  CREATE INDEX IF NOT EXISTS jobs_prune ON jobs(state, updated_at);
  CREATE INDEX IF NOT EXISTS threads_project ON threads(project_id);
`;

class SqliteStore implements StoreShape {
  private readonly db: DatabaseSync;
  private readonly databasePath: string;

  constructor(dataDirectory: string) {
    const directory = resolve(dataDirectory);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
    this.databasePath = join(directory, "telegramvisor.sqlite3");
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
      this.ensureHintColumns();
      this.db.exec("CREATE INDEX IF NOT EXISTS hints_due ON hints(next_attempt_at, updated_at, thread_id)");
      this.scrubStoredThreadShells();
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

  private readCompletionGap(row: Record<string, unknown>): CompletionGap {
    return {id: String(row.id), threadId: String(row.thread_id), runId: rowString(row, "run_id"),
      reason: String(row.reason) as CompletionGapReason, createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
      recovery: row.recovery === null ? null : JSON.parse(String(row.recovery)) as CompletionRecoveryOperation};
  }

  recordCompletionGap = (threadId: string, reason: CompletionGapReason, runId: string | null, now: number) => runStoreOperation(() => {
    const thread = readString(threadId, "thread id");
    const at = readNow(now);
    if (thread.length > 512 || (reason !== "older_history_not_read" && reason !== "incomplete_turn") ||
      (runId !== null && (typeof runId !== "string" || runId.length > 2048))) throw new StoreError("invalid completion coverage gap");
    const id = `completion-gap:${createHash("sha256").update(thread).digest("hex")}`;
    return this.transaction(() => {
      const previous = getRow(this.db, "SELECT * FROM completion_gaps WHERE id=?", id);
      if (!previous && count(this.db, "SELECT COUNT(*) AS count FROM completion_gaps") >= maxKnownThreads)
        throw new StoreError("completion coverage gap capacity reached");
      this.db.prepare(`INSERT INTO completion_gaps VALUES(?,?,?,?,?,?,NULL)
        ON CONFLICT(id) DO UPDATE SET updated_at=excluded.updated_at,
          reason=CASE WHEN reason='incomplete_turn' THEN reason ELSE excluded.reason END,
          run_id=CASE WHEN excluded.reason='incomplete_turn' THEN excluded.run_id ELSE run_id END
      `).run(id, thread, runId, reason, at, at);
      return this.readCompletionGap(getRow(this.db, "SELECT * FROM completion_gaps WHERE id=?", id)!);
    });
  });

  completionGaps = () => runStoreOperation(() => this.db.prepare(
    "SELECT * FROM completion_gaps ORDER BY updated_at DESC,id LIMIT 100",
  ).all().map(row => this.readCompletionGap(row)));

  completionGap = (id: string) => runStoreOperation(() => {
    const row = getRow(this.db, "SELECT * FROM completion_gaps WHERE id=?", readString(id, "gap id"));
    return row ? this.readCompletionGap(row) : null;
  });

  reserveCompletionRecovery = (operation: CompletionRecoveryOperation) => runStoreOperation(() => this.transaction(() => {
    const row = getRow(this.db, "SELECT * FROM completion_gaps WHERE id=?", readString(operation.gapId, "gap id"));
    if (!row || row.thread_id !== operation.threadId) throw new StoreError("completion coverage gap changed");
    const current = this.readCompletionGap(row);
    if (current.recovery) return {operation: current.recovery, created: false};
    if (operation.state !== "dispatching" || operation.text.length > 8000 || operation.commandId.length > 512 || operation.messageId.length > 512)
      throw new StoreError("invalid completion recovery operation");
    this.db.prepare("UPDATE completion_gaps SET recovery=? WHERE id=? AND recovery IS NULL")
      .run(serialize(operation, 16_000, "completion recovery"), operation.gapId);
    return {operation, created: true};
  }));

  finishCompletionRecovery = (gapId: string, commandId: string, outcome: Pick<CompletionRecoveryOperation, "state" | "sequence" | "updatedAt">) => runStoreOperation(() => this.transaction(() => {
    const row = getRow(this.db, "SELECT * FROM completion_gaps WHERE id=?", readString(gapId, "gap id"));
    const operation = row ? this.readCompletionGap(row).recovery : null;
    if (!operation || operation.commandId !== commandId) throw new StoreError("completion recovery operation changed");
    if (!["dispatching", "accepted", "reconciled", "uncertain", "rejected"].includes(outcome.state)) throw new StoreError("invalid completion recovery outcome");
    if ((operation.state === "accepted" || operation.state === "reconciled") &&
      outcome.state !== "accepted" && outcome.state !== "reconciled") return;
    if (operation.state === "rejected" && (outcome.state === "uncertain" || outcome.state === "dispatching")) return;
    this.db.prepare("UPDATE completion_gaps SET recovery=? WHERE id=?")
      .run(serialize({...operation, ...outcome}, 16_000, "completion recovery"), gapId);
  }));

  catalog = () => runStoreOperation(() => ({
    projects: this.db.prepare("SELECT document,deleted FROM projects ORDER BY id").all().map(row => ({
      project: readProject(JSON.parse(String(row.document)) as unknown), available: row.deleted === 0,
    })),
    threads: this.db.prepare("SELECT document FROM threads WHERE location='active' ORDER BY id").all().map(row => readThread(JSON.parse(String(row.document)) as unknown)),
  }));

  history = () => runStoreOperation((): TelegramvisorActivity[] => {
    const jobs = this.db.prepare("SELECT id,thread_id,run_id,state,delivery_key,message_id,created_at,text FROM jobs ORDER BY created_at DESC LIMIT 150").all();
    const skipped = this.db.prepare("SELECT * FROM recap_audit ORDER BY created_at DESC LIMIT 150").all();
    return [...jobs.map(row => ({ id: String(row.id), kind: String(row.delivery_key).includes("-answer-") ? "exact_answer" : "recap",
      threadId: String(row.thread_id), runId: String(row.run_id), ruleId: null,
      state: String(row.state), reason: String(row.state) === "sent" ? "telegram_receipt" : "delivery_pending",
      detail: JSON.stringify({ deliveryKey: row.delivery_key, messageId: row.message_id, message: row.text }), createdAt: Number(row.created_at),
    })), ...skipped.map(row => ({ id: String(row.id), kind: "recap", threadId: String(row.thread_id), runId: String(row.run_id),ruleId: null,
      state: "skipped", reason: "model_did_not_qualify_turn", detail: null, createdAt: Number(row.created_at),
    }))].sort((a,b)=>b.createdAt-a.createdAt).slice(0,200);
  });

  activate = (environmentId: string, now: number): Effect.Effect<number, StoreError> => runStoreOperation(() => {
    const environment = readString(environmentId, "environment id");
    const activatedAt = readNow(now);
    return this.transaction(() => {
      const binding = getRow(this.db, "SELECT environment_id FROM environment_binding WHERE id=1");
      if (binding !== undefined && rowString(binding, "environment_id") !== environment) {
        throw new EnvironmentMismatchError();
      }
      if (binding === undefined) {
        const priorBindings = this.db.prepare("SELECT DISTINCT environment_id FROM activations")
          .all() as Array<Record<string, unknown>>;
        if (priorBindings.some((row) => rowString(row, "environment_id") !== environment)) {
          throw new EnvironmentMismatchError();
        }
        if (priorBindings.length === 0 && count(this.db, `
          SELECT
            (SELECT COUNT(*) FROM cursors) +
            (SELECT COUNT(*) FROM projects) +
            (SELECT COUNT(*) FROM threads) +
            (SELECT COUNT(*) FROM jobs) AS count
        `) > 0) throw new EnvironmentMismatchError();
        this.db.prepare("INSERT INTO environment_binding(id, environment_id) VALUES (1, ?)").run(environment);
      }
      this.db.prepare("INSERT OR IGNORE INTO activations(environment_id, activated_at) VALUES (?, ?)")
        .run(environment, activatedAt);
      const row = getRow(this.db, "SELECT activated_at FROM activations WHERE environment_id=?", environment);
      return rowNumber(row, "activated_at");
    });
  });

  configureTelegram = (environmentId: string, enabled: boolean, now: number): Effect.Effect<number, StoreError> => runStoreOperation(() => {
    const environment = readString(environmentId, "environment id");
    const at = readNow(now);
    return this.transaction(() => {
      const activation = getRow(this.db, "SELECT activated_at FROM activations WHERE environment_id=?", environment);
      if (!activation) throw new StoreError("activate the environment before configuring Telegram");
      const previous = getRow(this.db, "SELECT enabled,notifications_after FROM telegram_configuration WHERE environment_id=?", environment);
      const notificationsAfter = enabled
        ? previous === undefined ? rowNumber(activation, "activated_at")
          : rowNumber(previous, "enabled") === 1 ? rowNumber(previous, "notifications_after") : at
        : at;
      this.db.prepare(`INSERT INTO telegram_configuration VALUES(?,?,?)
        ON CONFLICT(environment_id) DO UPDATE SET enabled=excluded.enabled,notifications_after=excluded.notifications_after`)
        .run(environment, enabled ? 1 : 0, notificationsAfter);
      return notificationsAfter;
    });
  });

  ingest = (source: SourceItem): Effect.Effect<void, StoreError> => runStoreOperation(() => {
    if (source.stream !== "active" && source.stream !== "archive") throw new StoreError("unknown source stream");
    if (!isRecord(source.item)) throw new StoreError("source item must be an object");
    const kind = source.item.kind;
    const sequence = this.itemSequence(source.item);
    const eventTime = Date.now();

    this.transaction(() => {
      const currentCursor = rowNumber(getRow(this.db, "SELECT sequence FROM cursors WHERE stream=?", source.stream), "sequence");
      const stale = sequence !== null && sequence <= currentCursor;
      let advanceCursor = true;
      if (kind === "snapshot") {
        advanceCursor = this.ingestSnapshot(source.stream, source.item, sequence, eventTime);
      } else if (stale) {
        return;
      } else if (kind === "thread.updated") {
        const shell = readThread(source.item.thread);
        this.storeThread(shell, this.threadLocation(source.stream, source.item, shell), eventTime);
      } else if (kind === "thread.removed") {
        this.removeThread(readString(source.item.threadId, "thread id"), eventTime);
      } else if (kind === "project.updated") {
        this.storeProject(readProject(source.item.project));
      } else if (kind === "project.removed") {
        const id = readString(source.item.projectId, "project id");
        this.db.prepare("UPDATE projects SET deleted=1 WHERE id=?").run(id);
      } else if (kind === "synchronized" && sequence === null) {
        return;
      } else if (sequence !== null) {
        throw new StoreError(`unsupported sequenced shell item: ${String(kind)}`);
      }
      if (sequence !== null && advanceCursor) {
        this.db.prepare(`
          INSERT INTO cursors(stream, sequence) VALUES (?, ?)
          ON CONFLICT(stream) DO UPDATE SET sequence=MAX(cursors.sequence, excluded.sequence)
        `).run(source.stream, sequence);
      }
    });
  });

  cursor = (stream: SourceItem["stream"]): Effect.Effect<number, StoreError> => runStoreOperation(() => {
    const row = getRow(this.db, "SELECT sequence FROM cursors WHERE stream=?", stream);
    return rowNumber(row, "sequence");
  });

  dueHints = (now = Date.now(), limit = 100): Effect.Effect<ThreadHint[], StoreError> => runStoreOperation(() => {
    const at = readNow(now);
    const boundedLimit = this.readLimit(limit, 1_000);
    const rows = this.db.prepare(`
      SELECT h.thread_id, h.revision, t.document
      FROM hints h LEFT JOIN threads t ON t.id=h.thread_id
      WHERE h.next_attempt_at<=?
      ORDER BY h.next_attempt_at, h.updated_at, h.thread_id LIMIT ?
    `).all(at, boundedLimit) as Array<Record<string, unknown>>;
    return rows.map((row) => {
      const document = rowString(row, "document");
      return {
        threadId: String(row.thread_id),
        revision: rowNumber(row, "revision"),
        shell: document === null ? null : readThread(JSON.parse(document) as unknown),
      };
    });
  });

  doneHint = (threadId: string, revision: number): Effect.Effect<boolean, StoreError> => runStoreOperation(() => {
    const id = readString(threadId, "thread id");
    if (!Number.isSafeInteger(revision) || revision < 1) throw new StoreError("hint revision must be a positive integer");
    return this.transaction(() => Number(this.db.prepare("DELETE FROM hints WHERE thread_id=? AND revision=?").run(id, revision).changes) > 0);
  });

  deferHint = (
    threadId: string,
    revision: number,
    now: number,
    delayMs = defaultReconcileBackoffMs,
    kind: HintDeferKind = "failure",
  ): Effect.Effect<boolean, StoreError> => runStoreOperation(() => {
    const id = readString(threadId, "thread id");
    const at = readNow(now);
    if (!Number.isSafeInteger(revision) || revision < 1) throw new StoreError("hint revision must be a positive integer");
    const delay = this.readDelay(delayMs);
    if (kind !== "failure" && kind !== "settling") throw new StoreError("hint defer kind must be failure or settling");
    return this.transaction(() => Number(this.db.prepare(`
      UPDATE hints SET next_attempt_at=?, updated_at=?, defer_kind=? WHERE thread_id=? AND revision=?
    `).run(at + delay, at, kind, id, revision).changes) > 0);
  });

  thread = (threadId: string): Effect.Effect<ThreadInfo | null, StoreError> => runStoreOperation(() => {
    const row = getRow(this.db, "SELECT document FROM threads WHERE id=?", readString(threadId, "thread id"));
    const document = rowString(row, "document");
    return document === null ? null : readThread(JSON.parse(document) as unknown);
  });

  project = (threadId: string): Effect.Effect<ProjectInfo | null, StoreError> => runStoreOperation(() => {
    const row = getRow(this.db, `
      SELECT p.document FROM threads t
      LEFT JOIN projects p ON p.id=t.project_id
      WHERE t.id=?
    `, readString(threadId, "thread id"));
    const document = rowString(row, "document");
    return document === null ? null : readProject(JSON.parse(document) as unknown);
  });

  hasIdentity = (environmentId: string, threadId: string, runId: string): Effect.Effect<boolean, StoreError> => runStoreOperation(() => {
    const environment = readString(environmentId, "environment id");
    const thread = readString(threadId, "thread id");
    const run = readString(runId, "run id");
    return getRow(this.db, `
      SELECT 1 AS found FROM identities
      WHERE environment_id=? AND thread_id=? AND run_id=?
    `, environment, thread, run) !== undefined;
  });

  enqueue = (
    environmentId: string,
    threadId: string,
    runId: string,
    context: RecapContext,
    now: number,
  ): Effect.Effect<string | null, StoreError> => runStoreOperation(() => {
    const environment = readString(environmentId, "environment id");
    const thread = readString(threadId, "thread id");
    const run = readString(runId, "run id");
    const at = readNow(now);
    const contextJson = serialize(context, maxStoredContextChars, "recap context");
    const id = deliveryKey(environment, thread, run);
    return this.transaction(() => {
      if (count(this.db, "SELECT COUNT(*) AS count FROM identities") >= maxIdentities) {
        throw new StoreError("delivery identity capacity reached; refusing to discard deduplication history");
      }
      const inserted = this.db.prepare(`
        INSERT OR IGNORE INTO identities(delivery_key, environment_id, thread_id, run_id, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(id, environment, thread, run, at);
      if (Number(inserted.changes) === 0) return null;
      if (count(this.db, "SELECT COUNT(*) AS count FROM jobs WHERE state!='sent'") >= maxLiveJobs) {
        throw new StoreError("notification queue capacity reached; refusing new work");
      }
      this.db.prepare(`
        INSERT INTO jobs(
          id, environment_id, thread_id, run_id, delivery_key, state, context,
          next_attempt_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)
      `).run(id, environment, thread, run, id, contextJson, at, at, at);
      return id;
    });
  });

  enqueueReply = (environmentId: string, threadId: string, runId: string, parts: string[], now: number): Effect.Effect<string | null, StoreError> => runStoreOperation(() => {
    const environment = readString(environmentId, "environment id");
    const thread = readString(threadId, "thread id");
    const run = readString(runId, "run id");
    const at = readNow(now);
    if (!Array.isArray(parts) || parts.length === 0 || parts.length > 400 ||
      parts.some((text) => typeof text !== "string" || !text.trim() || text.length > 4_000)) {
      throw new StoreError("reply parts exceed message or storage bounds");
    }
    const id = deliveryKey(environment, thread, run);
    return this.transaction(() => {
      if (getRow(this.db, "SELECT 1 AS found FROM identities WHERE delivery_key=?", id)) return null;
      if (count(this.db, "SELECT COUNT(*) AS count FROM identities") >= maxIdentities ||
        count(this.db, "SELECT COUNT(*) AS count FROM jobs WHERE state!='sent'") + parts.length > maxLiveJobs) {
        throw new StoreError("reply queue capacity reached; refusing to discard delivery history");
      }
      this.db.prepare("INSERT INTO identities(delivery_key,environment_id,thread_id,run_id,created_at) VALUES(?,?,?,?,?)")
        .run(id, environment, thread, run, at);
      for (const [index, text] of parts.entries()) {
        const partId = `${id}-answer-${index + 1}`;
        this.db.prepare(`INSERT INTO jobs(id,environment_id,thread_id,run_id,delivery_key,state,text,next_attempt_at,created_at,updated_at)
          VALUES(?,?,?,?,?,'ready',?,?,?,?)`).run(partId, environment, thread, run, partId, text, at, at + index, at);
      }
      return id;
    });
  });

  dueJobs = (
    now: number,
    states: ReadonlyArray<SafeDueState> = ["pending", "ready"],
    limit = 20,
  ): Effect.Effect<Job[], StoreError> => runStoreOperation(() => {
    const at = readNow(now);
    if (states.length === 0 || states.some((state) => !["pending", "ready", "unknown"].includes(state))) {
      throw new StoreError("due job states must be pending, ready, or explicitly unknown");
    }
    const boundedLimit = this.readLimit(limit, 100);
    const placeholders = states.map(() => "?").join(",");
    const rows = this.db.prepare(`
      SELECT * FROM jobs WHERE state IN (${placeholders}) AND next_attempt_at<=?
        AND NOT EXISTS (SELECT 1 FROM jobs predecessor
          WHERE predecessor.environment_id=jobs.environment_id AND predecessor.thread_id=jobs.thread_id
            AND predecessor.run_id=jobs.run_id AND predecessor.created_at<jobs.created_at AND predecessor.state!='sent')
      ORDER BY next_attempt_at, created_at LIMIT ?
    `).all(...states, at, boundedLimit) as Array<Record<string, unknown>>;
    return rows.map((row) => this.readJob(row));
  });

  getJob = (id: string): Effect.Effect<Job | null, StoreError> => runStoreOperation(() => {
    const row = getRow(this.db, "SELECT * FROM jobs WHERE id=?", readString(id, "job id"));
    return row === undefined ? null : this.readJob(row);
  });

  setReady = (id: string, text: string, now: number): Effect.Effect<boolean, StoreError> => runStoreOperation(() => {
    const jobId = readString(id, "job id");
    const at = readNow(now);
    if (typeof text !== "string" || text.trim() === "" || utf16Length(text) > 4_000) {
      throw new StoreError("message is outside the 4000 UTF-16 unit limit");
    }
    return this.transaction(() => Number(this.db.prepare(`
      UPDATE jobs SET state='ready', text=?, context=NULL, next_attempt_at=?, updated_at=?, error=NULL
      WHERE id=? AND state='pending' AND context IS NOT NULL AND text IS NULL
    `).run(text, at, at, jobId).changes) > 0);
  });

  skipRecap = (id: string): Effect.Effect<boolean, StoreError> => runStoreOperation(() => {
    const jobId = readString(id, "job id");
    // the permanent identity survives deletion, preventing replay after restart
    return this.transaction(() => {
      const job = getRow(this.db, "SELECT * FROM jobs WHERE id=? AND state='pending' AND text IS NULL",jobId);
      if (!job) return false;
      this.db.prepare("INSERT OR IGNORE INTO recap_audit VALUES(?,?,?,'skipped',?)").run(jobId,String(job.thread_id),String(job.run_id),Date.now());
      return Number(this.db.prepare("DELETE FROM jobs WHERE id=? AND state='pending' AND text IS NULL").run(jobId).changes) > 0;
    });
  });

  claimSend = (id: string, now: number): Effect.Effect<boolean, StoreError> => runStoreOperation(() => {
    const jobId = readString(id, "job id");
    const at = readNow(now);
    return this.transaction(() => Number(this.db.prepare(`
      UPDATE jobs SET state='sending', attempts=attempts+1, updated_at=?
      WHERE id=? AND state='ready' AND next_attempt_at<=? AND text IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM jobs predecessor
          WHERE predecessor.environment_id=jobs.environment_id AND predecessor.thread_id=jobs.thread_id
            AND predecessor.run_id=jobs.run_id AND predecessor.created_at<jobs.created_at AND predecessor.state!='sent')
    `).run(at, jobId, at).changes) > 0);
  });

  markSent = (id: string, messageId: number, now: number): Effect.Effect<boolean, StoreError> => runStoreOperation(() => {
    const jobId = readString(id, "job id");
    const at = readNow(now);
    if (!Number.isSafeInteger(messageId) || messageId <= 0) throw new StoreError("message id must be a positive integer");
    return this.transaction(() => Number(this.db.prepare(`
      UPDATE jobs SET state='sent', message_id=?, context=NULL, updated_at=?, error=NULL
      WHERE id=? AND state IN ('sending', 'unknown')
    `).run(messageId, at, jobId).changes) > 0);
  });

  markUnknown = (id: string, error: string, now: number): Effect.Effect<boolean, StoreError> => runStoreOperation(() => {
    const jobId = readString(id, "job id");
    const at = readNow(now);
    return this.transaction(() => Number(this.db.prepare(`
      UPDATE jobs SET state='unknown', next_attempt_at=?, updated_at=?, error=?
      WHERE id=? AND state IN ('sending', 'unknown')
    `).run(at + defaultReconcileBackoffMs, at, this.errorText(error), jobId).changes) > 0);
  });

  rejectSend = (
    id: string,
    error: string,
    now: number,
    delayMs = defaultReconcileBackoffMs,
  ): Effect.Effect<boolean, StoreError> => runStoreOperation(() => {
    const jobId = readString(id, "job id");
    const at = readNow(now);
    const delay = this.readDelay(delayMs);
    return this.transaction(() => Number(this.db.prepare(`
      UPDATE jobs SET state='ready', next_attempt_at=?, updated_at=?, error=?
      WHERE id=? AND state='sending' AND text IS NOT NULL
    `).run(at + delay, at, this.errorText(error), jobId).changes) > 0);
  });

  retry = (
    id: string,
    error: string,
    now: number,
    delayMs = defaultReconcileBackoffMs,
  ): Effect.Effect<boolean, StoreError> => runStoreOperation(() => {
    const jobId = readString(id, "job id");
    const at = readNow(now);
    const delay = this.readDelay(delayMs);
    return this.transaction(() => Number(this.db.prepare(`
      UPDATE jobs SET next_attempt_at=?, updated_at=?, error=?, attempts=attempts+1
      WHERE id=? AND state IN ('pending', 'ready')
    `).run(at + delay, at, this.errorText(error), jobId).changes) > 0);
  });

  recoverSending = (now: number): Effect.Effect<number, StoreError> => runStoreOperation(() => {
    const at = readNow(now);
    return this.transaction(() => Number(this.db.prepare(`
      UPDATE jobs SET state='unknown', next_attempt_at=?, updated_at=?,
        error='process stopped during delivery; reconcile using the original delivery key'
      WHERE state='sending'
    `).run(at + defaultReconcileBackoffMs, at).changes));
  });

  prune = (now: number, expireContexts = true): Effect.Effect<{ contexts: number; sentMetadata: number }, StoreError> => runStoreOperation(() => {
    const at = readNow(now);
    return this.transaction(() => {
      const contexts = expireContexts ? Number(this.db.prepare(`
        UPDATE jobs SET context=NULL, error='recap context expired after seven days'
        WHERE context IS NOT NULL AND MAX(created_at, COALESCE(
          (SELECT notifications_after FROM telegram_configuration WHERE environment_id=jobs.environment_id),
          created_at
        ))<?
      `).run(at - contextRetentionMs).changes) : 0;
      const sentMetadata = Number(this.db.prepare(`
        DELETE FROM jobs WHERE state='sent' AND updated_at<?
      `).run(at - sentRetentionMs).changes);
      this.db.prepare("DELETE FROM recap_audit WHERE created_at<?").run(at - sentRetentionMs);
      return { contexts, sentMetadata };
    });
  });

  stats = (): Effect.Effect<StoreStats, StoreError> => runStoreOperation(() => {
    const jobs: Record<JobState, number> = {
      pending: 0,
      ready: 0,
      sending: 0,
      sent: 0,
      unknown: 0,
    };
    const rows = this.db.prepare("SELECT state, COUNT(*) AS count FROM jobs GROUP BY state")
      .all() as Array<Record<string, unknown>>;
    for (const row of rows) {
      const state = row.state;
      if (typeof state === "string" && state in jobs) jobs[state as JobState] = rowNumber(row, "count");
    }
    const databaseBytes = [this.databasePath, `${this.databasePath}-wal`, `${this.databasePath}-shm`]
      .filter(existsSync)
      .reduce((total, path) => total + statSync(path).size, 0);
    return {
      completionCoverageGaps: count(this.db, "SELECT COUNT(*) AS count FROM completion_gaps"),
      projects: count(this.db, "SELECT COUNT(*) AS count FROM projects"),
      threads: count(this.db, "SELECT COUNT(*) AS count FROM threads"),
      dirtyHints: count(this.db, "SELECT COUNT(*) AS count FROM hints"),
      deferredHints: count(this.db, "SELECT COUNT(*) AS count FROM hints WHERE next_attempt_at>0 AND defer_kind='failure'"),
      waitingHints: count(this.db, "SELECT COUNT(*) AS count FROM hints WHERE next_attempt_at>0 AND defer_kind='settling'"),
      identities: count(this.db, "SELECT COUNT(*) AS count FROM identities"),
      jobs,
      databaseBytes,
    };
  });

  private transaction<A>(operation: () => A): A {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      secureFiles(this.databasePath);
      this.db.exec("COMMIT");
      return result;
    } catch (cause) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // preserve the original failure if SQLite already closed the transaction
      }
      throw cause;
    }
  }

  private readLimit(value: number, maximum: number): number {
    if (!Number.isSafeInteger(value) || value < 1) throw new StoreError("limit must be a positive integer");
    return Math.min(value, maximum);
  }

  private readDelay(value: number): number {
    if (!Number.isFinite(value)) throw new StoreError("retry delay must be finite");
    return Math.max(1, Math.min(Math.trunc(value), 24 * 60 * 60 * 1_000));
  }

  private errorText(value: string): string {
    const text = typeof value === "string" ? value : "delivery failed";
    return Array.from(text).slice(0, maxStoredErrorChars).join("");
  }

  private itemSequence(item: Record<string, unknown>): number | null {
    const snapshot = isRecord(item.snapshot) ? item.snapshot : null;
    const raw = item.sequence ?? snapshot?.snapshotSequence;
    if (raw === undefined || raw === null) return null;
    if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < 0) {
      throw new StoreError("shell item sequence must be a non-negative integer");
    }
    return raw;
  }

  private ensureHintColumns(): void {
    const columns = this.db.prepare("PRAGMA table_info(hints)").all() as Array<Record<string, unknown>>;
    if (!columns.some((column) => column.name === "next_attempt_at")) {
      this.db.exec("ALTER TABLE hints ADD COLUMN next_attempt_at INTEGER NOT NULL DEFAULT 0");
    }
    if (!columns.some((column) => column.name === "defer_kind")) {
      this.db.exec("ALTER TABLE hints ADD COLUMN defer_kind TEXT NOT NULL DEFAULT 'failure' CHECK(defer_kind IN ('failure', 'settling'))");
    }
  }

  private scrubStoredThreadShells(): void {
    const rows = this.db.prepare("SELECT id, document FROM threads").all() as Array<Record<string, unknown>>;
    if (rows.length === 0) return;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const update = this.db.prepare("UPDATE threads SET document=? WHERE id=?");
      for (const row of rows) {
        const id = rowString(row, "id");
        const document = rowString(row, "document");
        if (id === null || document === null) throw new StoreError("stored thread metadata is malformed");
        const sanitized = whitelistThreadShell(readThread(JSON.parse(document) as unknown));
        update.run(serialize(sanitized, maxStoredShellChars, "thread shell"), id);
      }
      secureFiles(this.databasePath);
      this.db.exec("COMMIT");
    } catch (cause) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // preserve the original failure if SQLite already closed the transaction
      }
      throw cause;
    }
  }

  private ingestSnapshot(
    stream: SourceItem["stream"],
    item: Record<string, unknown>,
    sequence: number | null,
    now: number,
  ): boolean {
    if (!isRecord(item.snapshot)) throw new StoreError("snapshot item is missing its snapshot payload");
    const snapshot = item.snapshot;
    const currentCursor = rowNumber(getRow(this.db, "SELECT sequence FROM cursors WHERE stream=?", stream), "sequence");
    const hasEnrichmentMarker = item.resolvedRepositoryIdentityRoots !== undefined;
    if (hasEnrichmentMarker && !Array.isArray(item.resolvedRepositoryIdentityRoots)) {
      throw new StoreError("snapshot enrichment roots must be an array");
    }
    if (sequence !== null && sequence < currentCursor && !hasEnrichmentMarker) return false;
    const projects = snapshot.projects;
    const threads = snapshot.threads;
    const archivedThreads = snapshot.archivedThreads;
    if (
      !Array.isArray(projects) ||
      !Array.isArray(threads) ||
      stream === "active" && !Array.isArray(archivedThreads)
    ) {
      throw new StoreError("snapshot is missing project or thread arrays");
    }
    const roots = hasEnrichmentMarker ? item.resolvedRepositoryIdentityRoots as unknown[] : null;
    if (roots !== null && roots.some((root) => typeof root !== "string")) {
      throw new StoreError("snapshot enrichment roots must contain only strings");
    }
    const enrichmentRoots = roots as string[] | null;
    const selectedProjects = enrichmentRoots === null
      ? projects
      : projects.filter((value) => isRecord(value) && enrichmentRoots.includes(String(value.workspaceRoot)));
    for (const value of selectedProjects) this.storeProject(readProject(value));

    if (enrichmentRoots !== null) return false;

    const incoming = stream === "active"
      ? threads
      : Array.isArray(archivedThreads) && archivedThreads.length > 0 ? archivedThreads : threads;
    this.reconcileThreads(stream, incoming, now);
    for (const value of incoming) {
      const shell = readThread(value);
      this.storeThread(shell, stream === "active" ? "active" : "archive", now);
    }
    return true;
  }

  private reconcileThreads(stream: SourceItem["stream"], incoming: unknown[], now: number): void {
    const incomingIds = new Set(incoming.map((value) => readThread(value).id));
    const location = stream === "active" ? "active" : "archive";
    const rows = this.db.prepare("SELECT id FROM threads WHERE location=?")
      .all(location) as Array<Record<string, unknown>>;
    for (const row of rows) {
      const id = String(row.id);
      if (!incomingIds.has(id)) this.removeThread(id, now);
    }
  }

  private storeProject(project: ProjectInfo): void {
    const document = serialize(project, maxStoredShellChars, "project shell");
    this.db.prepare(`
      INSERT INTO projects(id, document, deleted) VALUES (?, ?, 0)
      ON CONFLICT(id) DO UPDATE SET document=excluded.document, deleted=0
    `).run(project.id, document);
  }

  private storeThread(thread: ThreadInfo, location: "active" | "archive" | "removed", now: number): void {
    const safeThread = whitelistThreadShell(thread);
    const document = serialize(safeThread, maxStoredShellChars, "thread shell");
    const known = count(this.db, "SELECT COUNT(*) AS count FROM threads");
    const existing = getRow(this.db, "SELECT revision FROM threads WHERE id=?", safeThread.id);
    if (existing === undefined && known >= maxKnownThreads) throw new StoreError("known thread capacity reached; refusing to lose archive lookup metadata");
    const revision = this.nextRevision(safeThread.id);
    this.db.prepare(`
      INSERT INTO threads(id, project_id, document, location, revision) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        project_id=excluded.project_id,
        document=excluded.document,
        location=excluded.location,
        revision=excluded.revision
    `).run(safeThread.id, safeThread.projectId, document, location, revision);
    this.upsertHint(safeThread.id, revision, now);
  }

  private removeThread(threadId: string, now: number): void {
    const id = readString(threadId, "thread id");
    const revision = this.nextRevision(id);
    this.db.prepare("UPDATE threads SET location='removed', revision=? WHERE id=?").run(revision, id);
    this.upsertHint(id, revision, now);
  }

  private nextRevision(threadId: string): number {
    const row = getRow(this.db, `
      INSERT INTO thread_revisions(thread_id, revision) VALUES (?, 1)
      ON CONFLICT(thread_id) DO UPDATE SET revision=thread_revisions.revision+1
      RETURNING revision
    `, threadId);
    return rowNumber(row, "revision", 1);
  }

  private upsertHint(threadId: string, revision: number, now: number): void {
    const exists = getRow(this.db, "SELECT revision FROM hints WHERE thread_id=?", threadId) !== undefined;
    if (!exists && count(this.db, "SELECT COUNT(*) AS count FROM hints") >= maxHints) {
      throw new StoreError("dirty thread hint capacity reached; cursor was not advanced");
    }
    this.db.prepare(`
      INSERT INTO hints(thread_id, revision, updated_at, next_attempt_at, defer_kind) VALUES (?, ?, ?, 0, 'failure')
      ON CONFLICT(thread_id) DO UPDATE SET
        revision=excluded.revision,
        updated_at=excluded.updated_at,
        next_attempt_at=0,
        defer_kind='failure'
    `).run(threadId, revision, now);
  }

  private threadLocation(
    stream: SourceItem["stream"],
    item: Record<string, unknown>,
    shell: ThreadInfo,
  ): "active" | "archive" {
    if (stream === "archive" || item.location === "archive" || shell.archivedAt) return "archive";
    return "active";
  }

  private readJob(row: Record<string, unknown>): Job {
    const state = rowString(row, "state");
    if (state !== "pending" && state !== "ready" && state !== "sending" && state !== "sent" && state !== "unknown") {
      throw new StoreError("job row contains an invalid state");
    }
    const contextJson = rowString(row, "context");
    const messageIdValue = row.message_id;
    return {
      id: String(row.id),
      environmentId: String(row.environment_id),
      threadId: String(row.thread_id),
      runId: String(row.run_id),
      deliveryKey: String(row.delivery_key),
      state,
      context: contextJson === null ? null : JSON.parse(contextJson) as RecapContext,
      text: rowString(row, "text"),
      messageId: typeof messageIdValue === "number" ? messageIdValue : null,
      attempts: rowNumber(row, "attempts"),
      nextAttemptAt: rowNumber(row, "next_attempt_at"),
      createdAt: rowNumber(row, "created_at"),
      updatedAt: rowNumber(row, "updated_at"),
      error: rowString(row, "error"),
    };
  }
}

const acquireStore = (dataDirectory: string): Effect.Effect<SqliteStore, StoreError> =>
  Effect.tryPromise({
    try: () => Promise.resolve().then(() => new SqliteStore(dataDirectory)),
    catch: normalizeFailure,
  });

export const makeStore = (dataDirectory: string): Layer.Layer<Store, StoreError> =>
  Layer.effect(
    Store,
    Effect.acquireRelease(acquireStore(dataDirectory), (store) => Effect.sync(() => store.close())),
  );
