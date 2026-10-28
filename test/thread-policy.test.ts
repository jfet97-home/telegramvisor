import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { ThreadPolicyStore } from "../src/thread-policy.js";

test("existing chat settings retain exclusions and generation without a selected questionnaire thread", async () => {
  const directory = await mkdtemp(join(tmpdir(), "telegramvisor-thread-policy-"));
  let store = new ThreadPolicyStore(directory, { excludedThreadIds: [] });
  try {
    const db = new DatabaseSync(join(directory, "thread-settings.sqlite3"));
    try {
      db.prepare("UPDATE settings SET document=? WHERE id=1").run(JSON.stringify({
        generation: 7, excludedThreadIds: ["excluded-main", "another"], interactiveThreadId: "excluded-main",
      }));
    } finally { db.close(); }
    const saved = store.get();
    assert.deepEqual(saved, { generation: 7, excludedThreadIds: ["excluded-main", "another"] });
    store.close();
    store = new ThreadPolicyStore(directory, { excludedThreadIds: ["different-seed"] });
    assert.deepEqual(store.get(), saved);
    const next = store.save({ ...saved, excludedThreadIds: ["excluded-main"] });
    assert.deepEqual(next, { generation: 8, excludedThreadIds: ["excluded-main"] });
    assert.throws(() => store.save(saved), /changed in another tab/u);
  } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
});
