import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { link, lstat, mkdir, open, unlink, type FileHandle } from "node:fs/promises";
import { join } from "node:path";

const TOKEN_BYTES = 32;
const TOKEN_LENGTH = 43;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const ACCESS_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const GRANT_TTL_MS = 5 * 60 * 1_000;
const SESSION_TTL_MS = 8 * 60 * 60 * 1_000;
const CLOCK_ROLLBACK_TOLERANCE_MS = 60_000;
const MAX_PENDING_GRANTS = 32;
const MAX_SESSIONS = 32;
const MAX_DATABASE_BYTES = 1_048_576;
const DATABASE_PAGE_LIMIT = 256;
const GRANT_TABLE = "dashboard_login_grants";
const SESSION_TABLE = "dashboard_login_sessions";
const DATABASE_NAME = "login.sqlite3";

const GRANT_TABLE_SCHEMA =
  "CREATE TABLE dashboard_login_grants (\n" +
  "        token_hash TEXT PRIMARY KEY NOT NULL CHECK(length(token_hash)=64),\n" +
  "        issued_at INTEGER NOT NULL,\n" +
  "        expires_at INTEGER NOT NULL CHECK(expires_at > issued_at)\n" +
  "      ) STRICT";
const SESSION_TABLE_SCHEMA =
  "CREATE TABLE dashboard_login_sessions (\n" +
  "        token_hash TEXT PRIMARY KEY NOT NULL CHECK(length(token_hash)=64),\n" +
  "        issued_at INTEGER NOT NULL,\n" +
  "        expires_at INTEGER NOT NULL CHECK(expires_at - issued_at = " + SESSION_TTL_MS + ")\n" +
  "      ) STRICT";

export interface ServiceAuthOptions {
  now?: () => number;
}

export interface ServiceAuth {
  login(token: string): string | null;
  authenticated(session: string | undefined): boolean;
  logout(session: string | undefined): void;
  close(): void;
}

const isCanonicalToken = (value: unknown): value is string => {
  if (typeof value !== "string" || value.length !== TOKEN_LENGTH || !TOKEN_PATTERN.test(value)) return false;
  const decoded = Buffer.from(value, "base64url");
  return decoded.length === TOKEN_BYTES && decoded.toString("base64url") === value;
};

const randomToken = (): string => randomBytes(TOKEN_BYTES).toString("base64url");

const tokenHash = (token: string): string => createHash("sha256").update(token, "utf8").digest("hex");

const fileIdentityMatches = (
  left: { dev: number; ino: number },
  right: { dev: number; ino: number },
): boolean => left.dev === right.dev && left.ino === right.ino;

const authError = (name: string): Error => new Error(`invalid service auth ${name}`);

const openAccessDirectory = async (dataDirectory: string, create: boolean): Promise<FileHandle> => {
  const path = join(dataDirectory, "access");
  if (create) await mkdir(path, { recursive: true, mode: ACCESS_DIRECTORY_MODE });
  let namedStat;
  try {
    namedStat = await lstat(path);
  } catch {
    throw authError("access directory");
  }
  if (!namedStat.isDirectory()) throw authError("access directory");

  let handle: FileHandle;
  try {
    handle = await open(
      path,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch {
    throw authError("access directory");
  }
  try {
    const openedStat = await handle.stat();
    const currentStat = await lstat(path);
    if (
      !openedStat.isDirectory() ||
      !currentStat.isDirectory() ||
      !fileIdentityMatches(openedStat, namedStat) ||
      !fileIdentityMatches(openedStat, currentStat)
    ) throw authError("access directory");
    await handle.chmod(ACCESS_DIRECTORY_MODE);
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
};

const unlinkIfSameFile = async (
  path: string,
  expected: { dev: number; ino: number } | undefined,
): Promise<void> => {
  if (expected === undefined) return;
  try {
    const current = await lstat(path);
    if (current.isFile() && fileIdentityMatches(current, expected)) await unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
};

const newDatabaseConnection = (path: string): DatabaseSync => new DatabaseSync(path);

const configureDatabase = (database: DatabaseSync): void => {
  database.exec(`PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL; PRAGMA max_page_count=${DATABASE_PAGE_LIMIT};`);
};

const normalizeSchemaSql = (sql: string): string => sql.replace(/\s+/gu, "").replace(/;$/u, "").toLowerCase();

const validateTableSchema = (database: DatabaseSync, tableName: string, schema: string): void => {
  const table = database.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(tableName) as Record<string, unknown> | undefined;
  if (typeof table?.sql !== "string" || normalizeSchemaSql(table.sql) !== normalizeSchemaSql(schema)) {
    throw authError(tableName + " table");
  }

  const columns = database.prepare("PRAGMA table_info(" + tableName + ")").all() as Array<Record<string, unknown>>;
  const expected = [
    {name: "token_hash", type: "TEXT", notnull: 1, pk: 1},
    {name: "issued_at", type: "INTEGER", notnull: 1, pk: 0},
    {name: "expires_at", type: "INTEGER", notnull: 1, pk: 0},
  ];
  if (columns.length !== expected.length || columns.some((column, index) => {
    const wanted = expected[index];
    return wanted === undefined || column.name !== wanted.name || column.type !== wanted.type ||
      column.notnull !== wanted.notnull || column.pk !== wanted.pk;
  })) throw authError(tableName + " table");
};

const validateRows = (database: DatabaseSync, tableName: string, maxRows: number, fixedTtl?: number): void => {
  const countRow = database.prepare("SELECT COUNT(*) AS count FROM " + tableName).get() as Record<string, unknown> | undefined;
  const count = countRow?.count;
  if (typeof count !== "number" || !Number.isSafeInteger(count) || count > maxRows) {
    throw authError(tableName + " rows");
  }
  const rows = database.prepare("SELECT token_hash, issued_at, expires_at FROM " + tableName).all() as Array<Record<string, unknown>>;
  if (rows.some(row =>
    typeof row.token_hash !== "string" || !HASH_PATTERN.test(row.token_hash) ||
    typeof row.issued_at !== "number" || !Number.isSafeInteger(row.issued_at) ||
    typeof row.expires_at !== "number" || !Number.isSafeInteger(row.expires_at) ||
    row.expires_at <= row.issued_at ||
    (fixedTtl !== undefined && row.expires_at - row.issued_at !== fixedTtl)
  )) throw authError(tableName + " rows");
};

const validateDatabase = (database: DatabaseSync): void => {
  const integrity = database.prepare("PRAGMA quick_check").get() as Record<string, unknown> | undefined;
  if (integrity?.quick_check !== "ok") throw authError("database");
  const journal = database.prepare("PRAGMA journal_mode").get() as Record<string, unknown> | undefined;
  if (typeof journal?.journal_mode !== "string" || journal.journal_mode.toLowerCase() !== "delete") {
    throw authError("database");
  }

  const objects = database.prepare(
    "SELECT type, name FROM sqlite_master WHERE name NOT GLOB 'sqlite_*' ORDER BY type, name",
  ).all() as Array<Record<string, unknown>>;
  if (
    objects.length !== 2 ||
    objects[0]?.type !== "table" || objects[0]?.name !== GRANT_TABLE ||
    objects[1]?.type !== "table" || objects[1]?.name !== SESSION_TABLE
  ) throw authError("database");
  validateTableSchema(database, GRANT_TABLE, GRANT_TABLE_SCHEMA);
  validateTableSchema(database, SESSION_TABLE, SESSION_TABLE_SCHEMA);
  validateRows(database, GRANT_TABLE, MAX_PENDING_GRANTS);
  validateRows(database, SESSION_TABLE, MAX_SESSIONS, SESSION_TTL_MS);
};

const closeDatabaseQuietly = (database: DatabaseSync | undefined): void => {
  try { database?.close(); } catch { /* already closed */ }
};

const openPrivateDatabase = async (path: string): Promise<DatabaseSync> => {
  let namedStat;
  try {
    namedStat = await lstat(path);
  } catch {
    throw authError("database");
  }
  if (!namedStat.isFile() || namedStat.size === 0 || namedStat.size > MAX_DATABASE_BYTES) {
    throw authError("database");
  }

  let handle: FileHandle;
  try {
    handle = await open(path, constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    throw authError("database");
  }
  let identity: {dev: number; ino: number};
  try {
    const openedStat = await handle.stat();
    const currentStat = await lstat(path);
    if (
      !openedStat.isFile() ||
      openedStat.size === 0 ||
      openedStat.size > MAX_DATABASE_BYTES ||
      !currentStat.isFile() ||
      !fileIdentityMatches(openedStat, namedStat) ||
      !fileIdentityMatches(openedStat, currentStat)
    ) throw authError("database");
    await handle.chmod(PRIVATE_FILE_MODE);
    identity = {dev: openedStat.dev, ino: openedStat.ino};
  } catch (error) {
    await handle.close();
    throw error;
  }
  await handle.close();

  let database: DatabaseSync | undefined;
  try {
    database = newDatabaseConnection(path);
    const currentStat = await lstat(path);
    if (!currentStat.isFile() || !fileIdentityMatches(currentStat, identity)) throw authError("database");
    configureDatabase(database);
    validateDatabase(database);
    return database;
  } catch {
    closeDatabaseQuietly(database);
    throw authError("database");
  }
};

const initializeDatabaseFile = async (
  directory: string,
  directoryHandle: FileHandle,
): Promise<DatabaseSync> => {
  const path = join(directory, DATABASE_NAME);
  const temporaryPath = join(directory, "." + DATABASE_NAME + "." + randomBytes(16).toString("hex") + ".tmp");
  let temporaryHandle: FileHandle | undefined;
  let identity: {dev: number; ino: number} | undefined;
  let database: DatabaseSync | undefined;
  try {
    temporaryHandle = await open(
      temporaryPath,
      constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      PRIVATE_FILE_MODE,
    );
    const initialStat = await temporaryHandle.stat();
    if (!initialStat.isFile()) throw authError("database");
    identity = {dev: initialStat.dev, ino: initialStat.ino};
    await temporaryHandle.chmod(PRIVATE_FILE_MODE);
    await temporaryHandle.close();
    temporaryHandle = undefined;

    database = newDatabaseConnection(temporaryPath);
    database.exec("PRAGMA journal_mode=DELETE;");
    configureDatabase(database);
    database.exec(GRANT_TABLE_SCHEMA + "; " + SESSION_TABLE_SCHEMA + ";");
    validateDatabase(database);
    database.close();
    database = undefined;

    temporaryHandle = await open(temporaryPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const completedStat = await temporaryHandle.stat();
    if (!completedStat.isFile() || completedStat.size === 0 || completedStat.size > MAX_DATABASE_BYTES) {
      throw authError("database");
    }
    identity = {dev: completedStat.dev, ino: completedStat.ino};
    const namedTemporaryStat = await lstat(temporaryPath);
    if (!namedTemporaryStat.isFile() || !fileIdentityMatches(namedTemporaryStat, identity)) {
      throw authError("database");
    }
    await temporaryHandle.chmod(PRIVATE_FILE_MODE);
    await temporaryHandle.sync();
    await temporaryHandle.close();
    temporaryHandle = undefined;

    try {
      await link(temporaryPath, path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      await unlinkIfSameFile(temporaryPath, identity);
      identity = undefined;
      return await openPrivateDatabase(path);
    }
    const finalStat = await lstat(path);
    if (!finalStat.isFile() || !fileIdentityMatches(finalStat, identity)) throw authError("database");
    await directoryHandle.sync();
    return await openPrivateDatabase(path);
  } finally {
    closeDatabaseQuietly(database);
    if (temporaryHandle !== undefined) await temporaryHandle.close();
    await unlinkIfSameFile(temporaryPath, identity);
  }
};

const loadOrCreateDatabase = async (
  directory: string,
  directoryHandle: FileHandle,
): Promise<DatabaseSync> => {
  const path = join(directory, DATABASE_NAME);
  try {
    const stat = await lstat(path);
    if (!stat.isFile()) throw authError("database");
    return await openPrivateDatabase(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return initializeDatabaseFile(directory, directoryHandle);
};

const readNow = (now: () => number): number => {
  const value = now();
  if (!Number.isSafeInteger(value)) throw new Error("service auth clock must return a safe integer");
  return value;
};

const sessionHash = (session: string): string => tokenHash(session);

export const createServiceAuth = async (
  dataDirectory: string,
  options: ServiceAuthOptions = {},
): Promise<ServiceAuth> => {
  const accessDirectory = join(dataDirectory, "access");
  const directoryHandle = await openAccessDirectory(dataDirectory, true);
  let database: DatabaseSync | undefined;
  try {
    database = await loadOrCreateDatabase(accessDirectory, directoryHandle);
  } catch (error) {
    closeDatabaseQuietly(database);
    throw error;
  } finally {
    await directoryHandle.close();
  }
  if (database === undefined) throw authError("database");

  const now = options.now ?? Date.now;
  let closed = false;
  const consumeGrant = database.prepare(
    `DELETE FROM ${GRANT_TABLE} WHERE token_hash=? AND expires_at>? RETURNING token_hash`,
  );
  const sessionExists = database.prepare(`SELECT 1 FROM ${SESSION_TABLE} WHERE token_hash=?`);
  const sessionCount = database.prepare(`SELECT COUNT(*) AS count FROM ${SESSION_TABLE}`);
  const pruneExpiredSessions = database.prepare(`DELETE FROM ${SESSION_TABLE} WHERE expires_at<=?`);
  const evictOldestSession = database.prepare(
    `DELETE FROM ${SESSION_TABLE} WHERE rowid=(SELECT rowid FROM ${SESSION_TABLE} ORDER BY issued_at ASC, rowid ASC LIMIT 1)`,
  );
  const insertSession = database.prepare(
    `INSERT INTO ${SESSION_TABLE}(token_hash,issued_at,expires_at) VALUES(?,?,?)`,
  );
  const findLiveSession = database.prepare(
    `SELECT 1 FROM ${SESSION_TABLE} WHERE token_hash=? AND issued_at<=? AND expires_at>?`,
  );
  const revokeSession = database.prepare(`DELETE FROM ${SESSION_TABLE} WHERE token_hash=?`);

  return {
    login(token) {
      if (closed) return null;
      let currentTime: number;
      try { currentTime = readNow(now); } catch { return null; }
      if (!isCanonicalToken(token)) return null;
      const expiresAt = currentTime + SESSION_TTL_MS;
      if (!Number.isSafeInteger(expiresAt)) return null;

      try {
        database.exec("BEGIN IMMEDIATE");
        const consumed = consumeGrant.get(tokenHash(token), currentTime);
        if (consumed === undefined) {
          database.exec("ROLLBACK");
          return null;
        }
        pruneExpiredSessions.run(currentTime);
        const countRow = sessionCount.get() as Record<string, unknown> | undefined;
        const count = countRow?.count;
        if (typeof count !== "number" || !Number.isSafeInteger(count) || count > MAX_SESSIONS) {
          throw authError("dashboard session rows");
        }
        if (count === MAX_SESSIONS) evictOldestSession.run();

        let session = randomToken();
        let hash = sessionHash(session);
        while (sessionExists.get(hash) !== undefined) {
          session = randomToken();
          hash = sessionHash(session);
        }
        insertSession.run(hash, currentTime, expiresAt);
        database.exec("COMMIT");
        return session;
      } catch {
        try { database.exec("ROLLBACK"); } catch { /* transaction already closed */ }
        return null;
      }
    },
    authenticated(session) {
      if (closed) return false;
      try {
        const currentTime = readNow(now);
        if (!isCanonicalToken(session)) return false;
        const latestIssuedAt = currentTime + CLOCK_ROLLBACK_TOLERANCE_MS;
        if (!Number.isSafeInteger(latestIssuedAt)) return false;
        return findLiveSession.get(sessionHash(session), latestIssuedAt, currentTime) !== undefined;
      } catch {
        return false;
      }
    },
    logout(session) {
      if (closed || !isCanonicalToken(session)) return;
      revokeSession.run(sessionHash(session));
    },
    close() {
      if (closed) return;
      try {
        database.close();
      } finally {
        closed = true;
      }
    },
  };
};

export const forgeDashboardToken = async (
  dataDirectory: string,
  options: ServiceAuthOptions = {},
): Promise<{token: string; expiresAt: number}> => {
  const directoryHandle = await openAccessDirectory(dataDirectory, false);
  let database: DatabaseSync | undefined;
  try {
    database = await openPrivateDatabase(join(dataDirectory, "access", DATABASE_NAME));
    const now = readNow(options.now ?? Date.now);
    const expiresAt = now + GRANT_TTL_MS;
    if (!Number.isSafeInteger(expiresAt)) throw new Error("service auth grant expiry is invalid");
    const token = randomToken();
    const hash = tokenHash(token);

    database.exec("BEGIN IMMEDIATE");
    try {
      database.prepare("DELETE FROM " + GRANT_TABLE + " WHERE expires_at<=?").run(now);
      const countRow = database.prepare("SELECT COUNT(*) AS count FROM " + GRANT_TABLE).get() as Record<string, unknown> | undefined;
      const count = countRow?.count;
      if (typeof count !== "number" || !Number.isSafeInteger(count)) throw authError("login database");
      if (count >= MAX_PENDING_GRANTS) throw new Error("dashboard login grant capacity reached");
      database.prepare("INSERT INTO " + GRANT_TABLE + "(token_hash,issued_at,expires_at) VALUES(?,?,?)").run(hash, now, expiresAt);
      database.exec("COMMIT");
    } catch (error) {
      try { database.exec("ROLLBACK"); } catch { /* transaction already closed */ }
      throw error;
    }
    return {token, expiresAt};
  } catch (error) {
    if (error instanceof Error && error.message === "dashboard login grant capacity reached") throw error;
    throw authError("login grant state");
  } finally {
    closeDatabaseQuietly(database);
    await directoryHandle.close();
  }
};
