import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { InputEvent } from "../src/input-domain.js";
import { InputReplyCleanup } from "../src/input-reply-cleanup.js";

const reply: InputEvent = {
  eventId: "event", updateId: 1, messageId: 100, inputId: "input", requestRevision: "revision",
  draftRevision: 0, questionId: "q1", action: "answer", contributionId: "101", text: "text",
};

test("reply deletion identity survives restart and uncertain outcomes cannot be retried", async () => {
  const directory = await mkdtemp(join(tmpdir(), "input-replies-"));
  let cleanup = new InputReplyCleanup(directory);
  try {
    cleanup.track(reply, 1_000);
    cleanup.track({ ...reply, eventId: "edited", edited: true }, 2_000);
    const row = cleanup.due(2_000)[0]!;
    assert.equal(cleanup.due(2_000).length, 1);
    assert.equal((await stat(join(directory, "telegram-input-replies.sqlite3"))).mode & 0o777, 0o600);
    cleanup.expedite(reply.inputId, reply.requestRevision);
    assert.equal(cleanup.begin(row.key), true);
    cleanup.close();
    cleanup = new InputReplyCleanup(directory);
    assert.equal(cleanup.due(3_000)[0]?.key, row.key);
    assert.equal(cleanup.due(3_000)[0]?.state, "unknown");
    assert.equal(cleanup.begin(row.key), false);
    cleanup.rejected(row.key, 3_000, 20_000);
    assert.equal(cleanup.due(10_000).length, 0);
    assert.equal(cleanup.due(25_000)[0]?.key, row.key);
    assert.equal(cleanup.begin(row.key), true);
    cleanup.complete(row.key);
    cleanup.track(reply, 30_000);
    assert.deepEqual(cleanup.stats(), { pending: 0, unknown: 0, expired: 0 });
    assert.equal(cleanup.due(40_000).length, 0);
  } finally { cleanup.close(); await rm(directory, { recursive: true, force: true }); }
});

test("cleanup excludes callbacks and invalid owner-message identities and detects conflicts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "input-replies-guard-"));
  const cleanup = new InputReplyCleanup(directory);
  try {
    cleanup.track({ ...reply, action: "navigate" }, 1_000);
    cleanup.track({ ...reply, contributionId: "100" }, 1_000);
    cleanup.track({ ...reply, contributionId: "9007199254740999" }, 1_000);
    cleanup.track({ ...reply, contributionId: "another-message" }, 1_000);
    assert.equal(cleanup.due(1_000).length, 0);
    cleanup.track(reply, 1_000);
    assert.throws(() => cleanup.track({ ...reply, inputId: "foreign" }, 1_000), /ownership conflict/u);
    cleanup.expire(cleanup.due(1_000)[0]!.key);
    assert.equal(cleanup.stats().expired, 1);
  } finally { cleanup.close(); await rm(directory, { recursive: true, force: true }); }
});
