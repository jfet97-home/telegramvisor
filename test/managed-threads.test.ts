import assert from "node:assert/strict";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { isManagedThread, isManagedThreadIdentity, loadManagedThreadIdsSync } from "../src/managed-threads.js";
import type { TelegramvisorConfig, ThreadInfo } from "../src/types.js";

const config = (path: string): TelegramvisorConfig => ({
  dataDirectory: "/tmp/telegramvisor",
  t3Url: "http://127.0.0.1:3773",
  t3TokenFile: "/run/secrets/t3-read-token",
  t3InputTokenFile: "/run/secrets/t3-input-token",
  t3OperateTokenFile: "/run/secrets/t3-operate-token",
  mcpxUrl: "http://127.0.0.1:9000/mcp/lazy",
  cxCommand: "cx",
  cxHome: "/tmp/telegramvisor/runtime-auth",
  cxSeedFile: "/run/secrets/codex-auth.json",
  excludedThreadIds: [],
  healthPort: 9037,
  modelTimeoutMs: 360_000,
  uiPort: 9038,
  managedThreadIdsFile: path,
});

test("managed-root prefix and native root ancestry exclude descendants", () => {
  const empty = new Set<string>();
  assert.equal(isManagedThreadIdentity({ id: "supervisor-root:abc" }, empty), true);
  assert.equal(isManagedThreadIdentity({
    id: "child-thread",
    lineage: { parentThreadId: "parent-thread", rootThreadId: "supervisor-root:abc" },
  }, empty), true);
  assert.equal(isManagedThreadIdentity({ id: "ordinary-thread" }, empty), false);
});

test("legacy managed roots match the exact native root and parent lineage", () => {
  const managed = new Set(["legacy-root", "legacy-helper"]);
  assert.equal(isManagedThreadIdentity({ id: "legacy-root" }, managed), true);
  assert.equal(isManagedThreadIdentity({
    id: "child-thread",
    lineage: { parentThreadId: "ordinary-parent", rootThreadId: "legacy-root" },
  }, managed), true);
  assert.equal(isManagedThreadIdentity({
    id: "child-of-helper",
    lineage: { parentThreadId: "legacy-helper", rootThreadId: "unrelated-root" },
  }, managed), true);
  assert.throws(() => isManagedThreadIdentity({
    id: "unknown-lineage",
    lineage: { parentThreadId: null },
  }, managed), /managed_thread_ancestry_unavailable/u);
});

test("configured inventory is reread and validates the versioned native ID list", async () => {
  const directory = await mkdtemp(join(tmpdir(), "telegramvisor-managed-"));
  const path = join(directory, "managed-thread-ids.json");
  try {
    await writeFile(path, JSON.stringify({ version: 1, threadIds: ["legacy-root"] }));
    assert.deepEqual([...loadManagedThreadIdsSync(path)], ["legacy-root"]);
    const child: ThreadInfo = {
      id: "child-thread",
      title: "Child thread",
      projectId: null,
      lineage: { parentThreadId: "parent-thread", relationshipToParent: "fork", rootThreadId: "legacy-root" },
    };
    assert.equal(isManagedThread(config(path), child), true);
    await writeFile(path, JSON.stringify({ version: 1, threadIds: ["legacy-helper"] }));
    assert.deepEqual([...loadManagedThreadIdsSync(path)], ["legacy-helper"]);
    await writeFile(path, JSON.stringify({ version: 1, threadIds: ["same", "same"] }));
    assert.throws(() => loadManagedThreadIdsSync(path), /managed_thread_inventory_invalid/u);
    await writeFile(path, JSON.stringify({ version: 2, threadIds: [] }));
    assert.throws(() => loadManagedThreadIdsSync(path), /managed_thread_inventory_invalid/u);
    assert.throws(() => isManagedThread(config(path), child), /managed_thread_inventory_invalid/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("configured missing or symlinked inventories fail closed; an unset path is empty", async () => {
  const directory = await mkdtemp(join(tmpdir(), "telegramvisor-managed-"));
  const target = join(directory, "target.json");
  const link = join(directory, "managed-thread-ids.json");
  try {
    assert.deepEqual([...loadManagedThreadIdsSync()], []);
    assert.throws(() => loadManagedThreadIdsSync(link), /managed_thread_inventory_unavailable/u);
    await writeFile(target, JSON.stringify({ version: 1, threadIds: [] }));
    await symlink(target, link);
    assert.throws(() => loadManagedThreadIdsSync(link), /managed_thread_inventory_unavailable/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
