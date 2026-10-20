import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { RecapSettingsStore } from "../src/recap-settings.js";
import { ThreadPolicyStore } from "../src/thread-policy.js";

test("recaps default off on existing installations and persist independently of chat drafts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "recap-settings-"));
  const chats = new ThreadPolicyStore(directory, {excludedThreadIds: ["excluded"], interactiveThreadId: "interactive"});
  let recaps = new RecapSettingsStore(directory);
  try {
    const draft = chats.get();
    assert.deepEqual(recaps.get(), {generation: 1, enabled: false, enabledAt: 0});
    const enabled = recaps.save({generation: 1, enabled: true});
    assert.ok(enabled.enabledAt > 0);
    chats.save({...draft, excludedThreadIds: ["other"]});
    assert.deepEqual(recaps.get(), enabled);
    recaps.close();recaps = new RecapSettingsStore(directory);
    assert.deepEqual(recaps.get(), enabled);
    assert.throws(() => recaps.save({generation: 1, enabled: false}), /changed/u);
    assert.equal(recaps.save({generation: enabled.generation, enabled: true}).enabledAt, enabled.enabledAt);
    const disabled = recaps.save({generation: recaps.get().generation, enabled: false});
    recaps.close();recaps = new RecapSettingsStore(directory);
    assert.deepEqual(recaps.get(), disabled);
    assert.equal(recaps.get().enabled, false);
    const reenabled = recaps.save({generation: disabled.generation, enabled: true});
    assert.ok(reenabled.enabledAt >= enabled.enabledAt);
    assert.deepEqual(chats.get().excludedThreadIds, ["other"]);
    assert.equal(chats.get().interactiveThreadId, "interactive");
  } finally {recaps.close();chats.close();await rm(directory, {recursive: true, force: true});}
});
