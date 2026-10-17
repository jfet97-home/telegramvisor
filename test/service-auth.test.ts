import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { Worker } from "node:worker_threads";
import { createServiceAuth, forgeDashboardToken, type ServiceAuth } from "../src/service-auth.js";

const withTemporaryDirectory = async <A>(run: (directory: string) => Promise<A>): Promise<A> => {
  const directory = await mkdtemp(join(tmpdir(), "t3-service-auth-test-"));
  try {
    return await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

const accessPath = (directory: string): string => join(directory, "access");
const databasePath = (directory: string): string => join(accessPath(directory), "login.sqlite3");
const isToken = (value: string): boolean => /^[A-Za-z0-9_-]{43}$/u.test(value);

const pendingGrants = (directory: string): Array<Record<string, unknown>> => {
  const database = new DatabaseSync(databasePath(directory));
  try {
    return database.prepare("SELECT token_hash, issued_at, expires_at FROM dashboard_login_grants ORDER BY issued_at").all();
  } finally {
    database.close();
  }
};

const sessionRows = (directory: string): Array<Record<string, unknown>> => {
  const database = new DatabaseSync(databasePath(directory));
  try {
    return database.prepare("SELECT rowid, token_hash, issued_at, expires_at FROM dashboard_login_sessions ORDER BY rowid").all();
  } finally {
    database.close();
  }
};

const authDatabaseTables = (directory: string): Array<Record<string, unknown>> => {
  const database = new DatabaseSync(databasePath(directory));
  try {
    return database.prepare("SELECT type, name FROM sqlite_master WHERE name NOT GLOB 'sqlite_*' ORDER BY type, name").all();
  } finally {
    database.close();
  }
};

const runAuthChild = async (
  directory: string,
  action: "login" | "authenticated",
  token: string,
): Promise<string> => {
  const moduleUrl = new URL("../src/service-auth.ts", import.meta.url).href;
  const loader = fileURLToPath(new URL("../node_modules/tsx/dist/loader.mjs", import.meta.url));
  const source = `
    let input = "";
    for await (const chunk of process.stdin) input += chunk;
    const payload = JSON.parse(input);
    const { createServiceAuth } = await import(${JSON.stringify(moduleUrl)});
    const auth = await createServiceAuth(payload.directory);
    const result = payload.action === "login" ? auth.login(payload.token) : auth.authenticated(payload.token);
    process.stdout.write(result === null ? "rejected" : String(result), () => process.exit(0));
  `;
  const child = spawn(process.execPath, [
    "--disable-warning=ExperimentalWarning",
    "--import",
    loader,
    "--input-type=module",
    "-e",
    source,
  ], {cwd: tmpdir(), stdio: ["pipe", "pipe", "pipe"]});
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
  child.stdin.end(JSON.stringify({directory, action, token}));
  const [code] = await once(child, "close") as [number | null, NodeJS.Signals | null];
  if (code !== 0) throw new Error(`service auth child failed: ${stderr}`);
  return stdout;
};

const makeConsumerWorker = (directory: string, token: string, barrier: SharedArrayBuffer) => {
  const source = `
    const { parentPort, workerData } = require("node:worker_threads");
    (async () => {
      let auth;
      try {
        const { createServiceAuth } = await import(workerData.moduleUrl);
        auth = await createServiceAuth(workerData.directory);
        parentPort.postMessage({ kind: "ready" });
        Atomics.wait(new Int32Array(workerData.barrier), 0, 0);
        const session = auth.login(workerData.token);
        auth.close();
        parentPort.postMessage({ kind: "result", accepted: session !== null });
      } catch {
        try { auth?.close(); } catch {}
        parentPort.postMessage({ kind: "failure" });
      }
    })();
  `;
  const worker = new Worker(source, {
    eval: true,
    execArgv: ["--import", "tsx"],
    workerData: {
      moduleUrl: new URL("../src/service-auth.ts", import.meta.url).href,
      directory,
      token,
      barrier,
    },
  });
  let resolveReady!: () => void;
  let rejectReady!: (error: Error) => void;
  let resolveResult!: (accepted: boolean) => void;
  let rejectResult!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const result = new Promise<boolean>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  const exited = new Promise<void>(resolve => worker.once("exit", () => resolve()));
  worker.on("message", (message: {kind: string; accepted?: boolean}) => {
    if (message.kind === "ready") resolveReady();
    else if (message.kind === "result") resolveResult(message.accepted === true);
    else {
      const error = new Error("service auth consumer worker failed");
      rejectReady(error);
      rejectResult(error);
    }
  });
  worker.on("error", error => {
    rejectReady(error);
    rejectResult(error);
  });
  worker.on("exit", code => {
    if (code !== 0) {
      const error = new Error("service auth consumer worker exited unexpectedly");
      rejectReady(error);
      rejectResult(error);
    }
  });
  return {worker, ready, result, exited};
};

test("service auth stores only hashed one-time dashboard grants and sessions", async () => {
  await withTemporaryDirectory(async (directory) => {
    const now = 12_345;
    const auth = await createServiceAuth(directory, {now: () => now});
    try {
      const access = accessPath(directory);
      assert.equal((await lstat(access)).mode & 0o777, 0o700);
      assert.equal((await lstat(databasePath(directory))).mode & 0o777, 0o600);
      assert.deepEqual((await readdir(access)).sort(), ["login.sqlite3"]);
      assert.deepEqual(authDatabaseTables(directory).map(object => [object.type, object.name]), [
        ["table", "dashboard_login_grants"],
        ["table", "dashboard_login_sessions"],
      ]);
      await assert.rejects(lstat(join(access, "dashboard-token")), {code: "ENOENT"});

      const grant = await forgeDashboardToken(directory, {now: () => now});
      assert.equal(isToken(grant.token), true);
      assert.equal(grant.expiresAt, now + 5 * 60 * 1_000);
      const stored = pendingGrants(directory);
      assert.equal(stored.length, 1);
      assert.equal(stored[0]?.token_hash === createHash("sha256").update(grant.token).digest("hex"), true);
      assert.equal(stored[0]?.token_hash === grant.token, false);
      assert.equal(stored[0]?.issued_at, now);
      assert.equal(stored[0]?.expires_at, grant.expiresAt);

      const session = auth.login(grant.token);
      assert.equal(typeof session, "string");
      if (session === null) throw new Error("valid dashboard grant was rejected");
      assert.equal(auth.authenticated(session), true);
      assert.equal(auth.login(grant.token) === null, true);
      assert.equal(auth.login(Buffer.alloc(32, 7).toString("base64url")) === null, true);
      assert.equal(auth.login("x".repeat(100_000)) === null, true);
      assert.equal(auth.authenticated(grant.token), false);
      assert.equal(pendingGrants(directory).length, 0);
      const storedSession = sessionRows(directory)[0];
      assert.equal(storedSession?.token_hash === createHash("sha256").update(session).digest("hex"), true);
      assert.equal(storedSession?.token_hash === session, false);
      assert.equal(storedSession?.issued_at, now);
      assert.equal(storedSession?.expires_at, now + 8 * 60 * 60 * 1_000);
      auth.close();
      assert.equal(auth.authenticated(session), false);
    } finally {
      auth.close();
      auth.close();
    }
  });
});

test("grants and sessions persist across reopen without renewing their original deadlines", async () => {
  await withTemporaryDirectory(async (directory) => {
    let currentTime = 1_000;
    let auth: ServiceAuth | undefined = await createServiceAuth(directory, {now: () => currentTime});
    try {
      const retained = await forgeDashboardToken(directory, {now: () => currentTime});
      auth.close();
      auth = await createServiceAuth(directory, {now: () => currentTime});
      const session = auth.login(retained.token);
      assert.equal(typeof session, "string");
      if (session === null) throw new Error("unused grant did not survive restart");
      assert.equal(auth.authenticated(session), true);

      auth.close();
      auth = await createServiceAuth(directory, {now: () => currentTime});
      assert.equal(auth.login(retained.token) === null, true);
      assert.equal(auth.authenticated(session), true);

      currentTime = 1_000 - 60_001;
      assert.equal(auth.authenticated(session), false);
      currentTime = 1_000 - 60_000;
      assert.equal(auth.authenticated(session), true);
      currentTime = 1_000 + 8 * 60 * 60 * 1_000 - 1;
      assert.equal(auth.authenticated(session), true);
      currentTime += 1;
      assert.equal(auth.authenticated(session), false);

      const expired = await forgeDashboardToken(directory, {now: () => currentTime});
      currentTime = expired.expiresAt;
      assert.equal(auth.login(expired.token) === null, true);
      const fresh = await forgeDashboardToken(directory, {now: () => currentTime});
      assert.equal(fresh.expiresAt, currentTime + 5 * 60 * 1_000);
      assert.equal(pendingGrants(directory).length, 1);
      assert.equal(auth.login(fresh.token) !== null, true);
    } finally {
      auth.close();
    }
  });
});

test("a committed session survives an abrupt child-process exit and a grant cannot replay", async () => {
  await withTemporaryDirectory(async (directory) => {
    const auth = await createServiceAuth(directory);
    const grant = await forgeDashboardToken(directory);
    auth.close();

    const session = await runAuthChild(directory, "login", grant.token);
    assert.equal(isToken(session), true);
    assert.equal(await runAuthChild(directory, "authenticated", session), "true");
    assert.equal(await runAuthChild(directory, "login", grant.token), "rejected");
  });
});

test("SQLite recovers a hot session journal after SIGKILL without losing committed sessions", async () => {
  await withTemporaryDirectory(async (directory) => {
    let currentTime = 3_000;
    const auth = await createServiceAuth(directory, {now: () => currentTime});
    const grant = await forgeDashboardToken(directory, {now: () => currentTime});
    const session = auth.login(grant.token);
    assert.ok(session);
    auth.close();

    const databasePathForChild = databasePath(directory);
    const uncommittedHash = createHash("sha256").update("crash-recovery-fixture").digest("hex");
    const source = `
      import { DatabaseSync } from "node:sqlite";
      let input = "";
      for await (const chunk of process.stdin) input += chunk;
      const payload = JSON.parse(input);
      const database = new DatabaseSync(payload.path);
      database.exec("PRAGMA synchronous=FULL; BEGIN IMMEDIATE;");
      database.prepare("INSERT INTO dashboard_login_sessions(token_hash,issued_at,expires_at) VALUES(?,?,?)").run(
        payload.hash,
        payload.issuedAt,
        payload.issuedAt + 8 * 60 * 60 * 1_000,
      );
      process.stdout.write("ready\\n");
      setInterval(() => {}, 1_000);
    `;
    const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "--input-type=module", "-e", source], {
      cwd: tmpdir(),
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let resolveReady!: () => void;
    const ready = new Promise<void>(resolve => { resolveReady = resolve; });
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
      if (stdout.includes("ready\n")) resolveReady();
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    child.stdin.end(JSON.stringify({path: databasePathForChild, hash: uncommittedHash, issuedAt: currentTime}));
    const closed = once(child, "close");
    try {
      const started = await Promise.race([
        ready.then(() => "ready"),
        closed.then(() => "closed"),
      ]);
      assert.equal(started, "ready", `crash probe failed before writing: ${stderr}`);
      assert.equal((await lstat(databasePathForChild + "-journal")).isFile(), true);
      assert.equal(child.kill("SIGKILL"), true);
      const [exitCode, signal] = await closed as [number | null, NodeJS.Signals | null];
      assert.equal(exitCode, null);
      assert.equal(signal, "SIGKILL");

      currentTime += 1;
      const reopened = await createServiceAuth(directory, {now: () => currentTime});
      try {
        assert.equal(reopened.authenticated(session), true);
        assert.equal(sessionRows(directory).length, 1);
        assert.equal(sessionRows(directory).some(row => row.token_hash === uncommittedHash), false);
      } finally {
        reopened.close();
      }
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
  });
});

test("grant and session tables share one database", async () => {
  await withTemporaryDirectory(async (directory) => {
    const auth = await createServiceAuth(directory);
    try {
      const firstGrant = await forgeDashboardToken(directory);
      const firstSession = auth.login(firstGrant.token);
      assert.ok(firstSession);
      const firstRows = sessionRows(directory);
      assert.deepEqual(authDatabaseTables(directory).map(object => [object.type, object.name]), [
        ["table", "dashboard_login_grants"],
        ["table", "dashboard_login_sessions"],
      ]);

      const secondGrant = await forgeDashboardToken(directory);
      assert.deepEqual(sessionRows(directory), firstRows, "grant forging leaves session deadlines unchanged");
      assert.equal(auth.authenticated(firstSession), true);
      const secondSession = auth.login(secondGrant.token);
      assert.ok(secondSession);
      assert.equal(auth.authenticated(firstSession), true);
      assert.equal(auth.authenticated(secondSession), true);
      assert.equal(pendingGrants(directory).length, 0);
      auth.logout(firstSession);
      assert.equal(auth.authenticated(firstSession), false);
      assert.equal(auth.authenticated(secondSession), true);
      assert.deepEqual(sessionRows(directory).map(row => row.token_hash), [
        createHash("sha256").update(secondSession).digest("hex"),
      ]);
    } finally {
      auth.close();
    }
  });
});

test("failed login rolls back grant consumption, expiry pruning and session eviction", async () => {
  await withTemporaryDirectory(async (directory) => {
    const sessionTtl = 8 * 60 * 60 * 1_000;
    const currentTime = 50_000_000;
    const auth = await createServiceAuth(directory, {now: () => currentTime});
    const expiredHash = createHash("sha256").update("expired-session-fixture").digest("hex");
    const oldestLiveHash = createHash("sha256").update("live-session-0").digest("hex");
    const database = new DatabaseSync(databasePath(directory));
    try {
      const insertSession = database.prepare(
        "INSERT INTO dashboard_login_sessions(token_hash,issued_at,expires_at) VALUES(?,?,?)",
      );
      insertSession.run(expiredHash, currentTime - sessionTtl - 1_000, currentTime - 1_000);
      for (let index = 0; index < 31; index += 1) {
        const hash = createHash("sha256").update("live-session-" + index).digest("hex");
        const issuedAt = currentTime - sessionTtl + 1_000 + index;
        insertSession.run(hash, issuedAt, issuedAt + sessionTtl);
      }
    } finally {
      database.close();
    }

    try {
      const pruneGrant = await forgeDashboardToken(directory, {now: () => currentTime});
      const beforePruneFailure = sessionRows(directory);
      const insertFailure = new DatabaseSync(databasePath(directory));
      insertFailure.exec(
        "CREATE TRIGGER reject_session_insert BEFORE INSERT ON dashboard_login_sessions " +
        "BEGIN SELECT RAISE(ABORT, 'fixture'); END",
      );
      insertFailure.close();
      assert.equal(auth.login(pruneGrant.token), null);
      assert.deepEqual(sessionRows(directory), beforePruneFailure);
      assert.equal(pendingGrants(directory)[0]?.token_hash, createHash("sha256").update(pruneGrant.token).digest("hex"));

      const allowPrune = new DatabaseSync(databasePath(directory));
      allowPrune.exec("DROP TRIGGER reject_session_insert");
      allowPrune.close();
      const firstSession = auth.login(pruneGrant.token);
      assert.ok(firstSession);
      assert.equal(sessionRows(directory).length, 32);
      assert.equal(sessionRows(directory).some(row => row.token_hash === expiredHash), false);

      const evictionGrant = await forgeDashboardToken(directory, {now: () => currentTime});
      const beforeEvictionFailure = sessionRows(directory);
      const rejectEviction = new DatabaseSync(databasePath(directory));
      rejectEviction.exec(
        "CREATE TRIGGER reject_session_insert BEFORE INSERT ON dashboard_login_sessions " +
        "BEGIN SELECT RAISE(ABORT, 'fixture'); END",
      );
      rejectEviction.close();
      assert.equal(auth.login(evictionGrant.token), null);
      assert.deepEqual(sessionRows(directory), beforeEvictionFailure);
      assert.equal(pendingGrants(directory)[0]?.token_hash, createHash("sha256").update(evictionGrant.token).digest("hex"));

      const allowEviction = new DatabaseSync(databasePath(directory));
      allowEviction.exec("DROP TRIGGER reject_session_insert");
      allowEviction.close();
      const secondSession = auth.login(evictionGrant.token);
      assert.ok(secondSession);
      assert.equal(auth.authenticated(firstSession), true);
      assert.equal(auth.authenticated(secondSession), true);
      assert.equal(sessionRows(directory).length, 32);
      assert.equal(sessionRows(directory).some(row => row.token_hash === expiredHash), false);
      assert.equal(sessionRows(directory).some(row => row.token_hash === oldestLiveHash), false);
      assert.equal(pendingGrants(directory).length, 0);
    } finally {
      auth.close();
    }
  });
});

test("logout revokes across open instances and durable sessions keep a global stable cap", async () => {
  await withTemporaryDirectory(async (directory) => {
    let currentTime = 2_000;
    const auth = await createServiceAuth(directory, {now: () => currentTime});
    const concurrent = await createServiceAuth(directory, {now: () => currentTime});
    try {
      const expiresGrant = await forgeDashboardToken(directory, {now: () => currentTime});
      const revokedGrant = await forgeDashboardToken(directory, {now: () => currentTime});
      const expires = auth.login(expiresGrant.token);
      const revoked = auth.login(revokedGrant.token);
      assert.equal(typeof expires, "string");
      assert.equal(typeof revoked, "string");
      if (expires === null || revoked === null) throw new Error("valid dashboard grant was rejected");

      currentTime += 8 * 60 * 60 * 1_000 - 1;
      assert.equal(auth.authenticated(expires), true);
      currentTime += 1;
      assert.equal(auth.authenticated(expires), false);
      assert.equal(concurrent.authenticated(revoked), false);
      concurrent.logout(revoked);
      assert.equal(auth.authenticated(revoked), false);
      auth.logout(undefined);

      currentTime += 1;
      const sessions: string[] = [];
      for (let index = 0; index < 32; index += 1) {
        const grant = await forgeDashboardToken(directory, {now: () => currentTime});
        const session = (index % 2 === 0 ? auth : concurrent).login(grant.token);
        if (session === null) throw new Error("valid dashboard grant was rejected");
        sessions.push(session);
      }
      concurrent.logout(sessions[16]);
      concurrent.logout(sessions[31]);
      for (let index = 0; index < 3; index += 1) {
        const grant = await forgeDashboardToken(directory, {now: () => currentTime});
        const session = (index % 2 === 0 ? concurrent : auth).login(grant.token);
        if (session === null) throw new Error("valid dashboard grant was rejected");
        sessions.push(session);
      }
      assert.equal(auth.authenticated(sessions[0]), false);
      assert.equal(auth.authenticated(sessions[1]), true);
      assert.equal(auth.authenticated(sessions[16]), false);
      assert.equal(auth.authenticated(sessions[31]), false);
      assert.equal(auth.authenticated(sessions[32]), true);
      assert.equal(auth.authenticated(sessions[33]), true);
      assert.equal(auth.authenticated(sessions[34]), true);
      assert.equal(sessionRows(directory).length, 32);
    } finally {
      auth.close();
      concurrent.close();
    }
  });
});

test("logout by another service instance remains revoked after reopen", async () => {
  await withTemporaryDirectory(async (directory) => {
    const first = await createServiceAuth(directory);
    const second = await createServiceAuth(directory);
    const grant = await forgeDashboardToken(directory);
    const session = first.login(grant.token);
    assert.ok(session);
    try {
      assert.equal(second.authenticated(session), true);
      second.logout(session);
      assert.equal(first.authenticated(session), false);
    } finally {
      first.close();
      second.close();
    }
    const reopened = await createServiceAuth(directory);
    try {
      assert.equal(reopened.authenticated(session), false);
    } finally {
      reopened.close();
    }
  });
});

test("pending dashboard grants are isolated between service state directories", async () => {
  await withTemporaryDirectory(async (firstDirectory) => {
    await withTemporaryDirectory(async (secondDirectory) => {
      const first = await createServiceAuth(firstDirectory);
      const second = await createServiceAuth(secondDirectory);
      try {
        const firstGrant = await forgeDashboardToken(firstDirectory);
        const secondGrant = await forgeDashboardToken(secondDirectory);
        assert.equal(second.login(firstGrant.token) === null, true);
        assert.equal(first.login(secondGrant.token) === null, true);
        const firstSession = first.login(firstGrant.token);
        const secondSession = second.login(secondGrant.token);
        assert.equal(firstSession !== null, true);
        assert.equal(secondSession !== null, true);
        assert.equal(first.authenticated(secondSession ?? undefined), false);
        assert.equal(second.authenticated(firstSession ?? undefined), false);
      } finally {
        first.close();
        second.close();
      }
    });
  });
});

test("grant issuance prunes expired rows and fails closed at the pending-grant limit", async () => {
  await withTemporaryDirectory(async (directory) => {
    let currentTime = 10_000;
    const auth = await createServiceAuth(directory, {now: () => currentTime});
    try {
      const expired = await forgeDashboardToken(directory, {now: () => currentTime});
      currentTime = expired.expiresAt;
      const firstLive = await forgeDashboardToken(directory, {now: () => currentTime});
      assert.equal(pendingGrants(directory).length, 1);
      assert.equal(auth.login(expired.token) === null, true);

      const grants = [firstLive];
      for (let index = 1; index < 32; index += 1) {
        grants.push(await forgeDashboardToken(directory, {now: () => currentTime}));
      }
      assert.equal(pendingGrants(directory).length, 32);
      await assert.rejects(forgeDashboardToken(directory, {now: () => currentTime}), /capacity reached/u);
      assert.equal(pendingGrants(directory).length, 32);
      assert.equal(auth.login(grants[0]!.token) !== null, true);
      assert.equal(pendingGrants(directory).length, 31);
      assert.equal(auth.login(grants[1]!.token) !== null, true);
      assert.equal((await forgeDashboardToken(directory, {now: () => currentTime})).expiresAt, currentTime + 5 * 60 * 1_000);
    } finally {
      auth.close();
    }
  });
});

test("concurrent service initialization preserves one two-table login database", async () => {
  await withTemporaryDirectory(async (directory) => {
    const [first, second] = await Promise.all([
      createServiceAuth(directory),
      createServiceAuth(directory),
    ]);
    try {
      await assert.rejects(lstat(join(accessPath(directory), "dashboard-token")), {code: "ENOENT"});
      assert.deepEqual((await readdir(accessPath(directory))).sort(), ["login.sqlite3"]);
    } finally {
      first.close();
      second.close();
    }
  });
});

test("grant forging requires an initialized database and does not bootstrap missing state", async () => {
  await withTemporaryDirectory(async (directory) => {
    await assert.rejects(forgeDashboardToken(directory));
    await assert.rejects(lstat(accessPath(directory)), {code: "ENOENT"});

    await mkdir(accessPath(directory), {mode: 0o700});
    await assert.rejects(forgeDashboardToken(directory));
    assert.deepEqual(await readdir(accessPath(directory)), []);
  });
});

test("valid existing auth files are tightened to private modes", async () => {
  await withTemporaryDirectory(async (directory) => {
    const first = await createServiceAuth(directory);
    first.close();
    await chmod(databasePath(directory), 0o644);
    const second = await createServiceAuth(directory);
    try {
      assert.equal((await lstat(accessPath(directory))).mode & 0o777, 0o700);
      assert.equal((await lstat(databasePath(directory))).mode & 0o777, 0o600);
    } finally {
      second.close();
    }
  });
});

test("malformed, oversized, symlink and non-regular auth databases fail closed", async (t) => {
  await t.test("corrupt database remains untouched", async () => {
    await withTemporaryDirectory(async (directory) => {
      await mkdir(accessPath(directory), {mode: 0o700});
      const corrupt = Buffer.from("not a sqlite database");
      await writeFile(databasePath(directory), corrupt, {mode: 0o600});
      await assert.rejects(createServiceAuth(directory));
      assert.ok((await readFile(databasePath(directory))).equals(corrupt));
    });
  });

  await t.test("oversized database", async () => {
    await withTemporaryDirectory(async (directory) => {
      await mkdir(accessPath(directory), {mode: 0o700});
      const oversized = Buffer.alloc(1_048_577, 0x41);
      await writeFile(databasePath(directory), oversized, {mode: 0o600});
      await assert.rejects(createServiceAuth(directory));
      assert.equal((await lstat(databasePath(directory))).size, oversized.length);
    });
  });

  await t.test("symlink", async () => {
    await withTemporaryDirectory(async (directory) => {
      const targetDirectory = join(directory, "target");
      await mkdir(targetDirectory);
      const targetAuth = await createServiceAuth(targetDirectory);
      targetAuth.close();
      const linkDirectory = join(directory, "linked");
      await mkdir(accessPath(linkDirectory), {recursive: true, mode: 0o700});
      await symlink(databasePath(targetDirectory), databasePath(linkDirectory));
      await assert.rejects(createServiceAuth(linkDirectory));
      assert.equal((await lstat(databasePath(linkDirectory))).isSymbolicLink(), true);
    });
  });

  await t.test("directory in place of database file", async () => {
    await withTemporaryDirectory(async (directory) => {
      await mkdir(databasePath(directory), {recursive: true, mode: 0o700});
      await assert.rejects(createServiceAuth(directory));
      assert.equal((await lstat(databasePath(directory))).isDirectory(), true);
    });
  });
});

test("unexpected session table schemas and row caps fail closed", async (t) => {
  await t.test("missing current table is not added to an existing database", async () => {
    await withTemporaryDirectory(async (directory) => {
      const auth = await createServiceAuth(directory);
      auth.close();
      const database = new DatabaseSync(databasePath(directory));
      database.exec("DROP TABLE dashboard_login_sessions");
      database.close();
      const before = await readFile(databasePath(directory));
      assert.deepEqual(authDatabaseTables(directory).map(object => object.name), ["dashboard_login_grants"]);
      await assert.rejects(createServiceAuth(directory));
      await assert.rejects(forgeDashboardToken(directory));
      assert.ok((await readFile(databasePath(directory))).equals(before));
    });
  });

  await t.test("unexpected schema remains untouched", async () => {
    await withTemporaryDirectory(async (directory) => {
      const auth = await createServiceAuth(directory);
      auth.close();
      const database = new DatabaseSync(databasePath(directory));
      database.exec("ALTER TABLE dashboard_login_sessions ADD COLUMN unexpected TEXT");
      database.close();
      const before = await readFile(databasePath(directory));
      await assert.rejects(createServiceAuth(directory));
      assert.ok((await readFile(databasePath(directory))).equals(before));
    });
  });

  await t.test("more than 32 persisted sessions fail closed", async () => {
    await withTemporaryDirectory(async (directory) => {
      const auth = await createServiceAuth(directory);
      auth.close();
      const database = new DatabaseSync(databasePath(directory));
      const insert = database.prepare("INSERT INTO dashboard_login_sessions(token_hash,issued_at,expires_at) VALUES(?,?,?)");
      for (let index = 0; index < 33; index += 1) {
        const hash = createHash("sha256").update(`fixture-${index}`).digest("hex");
        insert.run(hash, 1_000 + index, 1_000 + index + 8 * 60 * 60 * 1_000);
      }
      database.close();
      await assert.rejects(createServiceAuth(directory));
      assert.equal(sessionRows(directory).length, 33);
    });
  });

  await t.test("SQLite rejects sessions without the exact eight-hour lifetime", async () => {
    await withTemporaryDirectory(async (directory) => {
      const auth = await createServiceAuth(directory);
      auth.close();
      const database = new DatabaseSync(databasePath(directory));
      const hash = createHash("sha256").update("short-lived-session").digest("hex");
      assert.throws(() => database.prepare(
        "INSERT INTO dashboard_login_sessions(token_hash,issued_at,expires_at) VALUES(?,?,?)",
      ).run(hash, 1_000, 1_000 + 8 * 60 * 60 * 1_000 - 1));
      database.close();
      assert.equal(sessionRows(directory).length, 0);
    });
  });

});

test("two concurrent service instances can consume one grant only once", async () => {
  await withTemporaryDirectory(async (directory) => {
    const owner = await createServiceAuth(directory);
    const grant = await forgeDashboardToken(directory);
    owner.close();

    const barrier = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
    const consumers = [
      makeConsumerWorker(directory, grant.token, barrier),
      makeConsumerWorker(directory, grant.token, barrier),
    ];
    let released = false;
    try {
      await Promise.all(consumers.map(consumer => consumer.ready));
      Atomics.store(new Int32Array(barrier), 0, 1);
      Atomics.notify(new Int32Array(barrier), 0, 2);
      released = true;
      const results = await Promise.all(consumers.map(consumer => consumer.result));
      assert.equal(results.filter(Boolean).length, 1);
      await Promise.all(consumers.map(consumer => consumer.exited));
    } finally {
      if (!released) {
        Atomics.store(new Int32Array(barrier), 0, 1);
        Atomics.notify(new Int32Array(barrier), 0, 2);
      }
      await Promise.all(consumers.map(consumer => consumer.worker.terminate()));
    }
  });
});
