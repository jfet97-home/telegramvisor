import assert from "node:assert/strict";
import {mkdtemp, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {Effect} from "effect";
import test from "node:test";
import {startDashboard} from "../src/dashboard.js";
import {createStatus} from "../src/coordinator.js";
import {forgeDashboardToken} from "../src/service-auth.js";
import {makeStore, Store} from "../src/store.js";
import {ThreadPolicyStore} from "../src/thread-policy.js";
import type {T3ClientShape} from "../src/t3.js";
import type {TelegramvisorConfig} from "../src/types.js";

test("dashboard authenticates independently, fences writes and filters fresh native ownership", async () => {
  const directory = await mkdtemp(join(tmpdir(), "telegramvisor-dashboard-"));
  const policy = new ThreadPolicyStore(directory, {excludedThreadIds: [], interactiveThreadId: null});
  try {
    await Effect.runPromise(Effect.scoped(Effect.provide(Store.use(store => Effect.promise(async () => {
      const config: TelegramvisorConfig = {
        dataDirectory: directory, t3Url: "http://127.0.0.1:1", t3TokenFile: "unused", t3InputTokenFile: "unused",
        t3OperateTokenFile: "", mcpxUrl: "http://127.0.0.1:1", cxCommand: "unused", cxHome: directory,
        cxSeedFile: "unused", excludedThreadIds: [], threadPolicy: policy, healthPort: 0, uiPort: 0,
        telegramEnabled: false, inputEnabled: false, modelTimeoutMs: 1000,
      };
      const shell = (id: string, rootThreadId = id, relationshipToParent: string | null = null) => ({
        id, title: id, projectId: null, lineage: {parentThreadId: relationshipToParent ? rootThreadId : null, relationshipToParent, rootThreadId},
      });
      const t3 = {threadShells: () => Effect.succeed([
        shell("ordinary"), shell("supervisor-root:new"), shell("owned-descendant", "supervisor-root:new", "fork"),
        shell("child", "ordinary", "subagent"),
      ])} as unknown as T3ClientShape;
      const dashboard = await startDashboard(config, {store, t3, status: createStatus(config)});
      try {
        const address = dashboard.server.address();
        assert.ok(address && typeof address === "object");
        const origin = `http://127.0.0.1:${address.port}`;
        const get = (path: string, session?: string) => fetch(origin + path, {headers: session ? {"x-telegramvisor-session": session} : {}});
        assert.equal((await get("/api/snapshot")).status, 401);
        const grant = await forgeDashboardToken(directory);
        const login = await fetch(origin + "/auth/login", {method: "POST", headers: {origin, "content-type": "application/json"}, body: JSON.stringify({token: grant.token})});
        assert.equal(login.status, 200);
        const {session} = await login.json() as {session: string};
        assert.equal((await get("/api/snapshot", session)).status, 200);
        const snapshot = await (await get("/api/snapshot", session)).json() as {threads: Array<{id: string}>};
        assert.deepEqual(snapshot.threads.map(thread => thread.id), ["ordinary"]);
        const legacyHeader = await fetch(origin + "/api/snapshot", {headers: {"x-supervisor-session": session}});
        assert.equal(legacyHeader.status, 401);
        const {csrf} = await (await get("/api/csrf", session)).json() as {csrf: string};
        const write = (headers: Record<string, string>, body: unknown = policy.get()) => fetch(origin + "/api/chat-policy", {
          method: "POST", headers: {"x-telegramvisor-session": session, "content-type": "application/json", ...headers}, body: JSON.stringify(body),
        });
        assert.equal((await write({origin})).status, 403);
        assert.equal((await write({origin: "http://foreign.test", "x-csrf-token": csrf})).status, 403);
        const original = policy.get();
        assert.equal((await write({origin, "x-csrf-token": csrf}, {...original, excludedThreadIds: ["ordinary"]})).status, 200);
        assert.equal((await write({origin, "x-csrf-token": csrf}, original)).status, 409);
        assert.deepEqual(policy.get().excludedThreadIds, ["ordinary"]);
        const logout = await fetch(origin + "/auth/logout", {method: "POST", headers: {origin, "content-type": "application/json", "x-telegramvisor-session": session}, body: "{}"});
        assert.equal(logout.status, 200);
        assert.equal((await get("/api/snapshot", session)).status, 401);
        assert.equal((await get("/mcp/workflows")).status, 404);
      } finally {await dashboard.close();}
    })), makeStore(directory))));
  } finally {policy.close();await rm(directory, {recursive: true, force: true});}
});
