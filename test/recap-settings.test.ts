import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { RecapSettingsStore } from "../src/recap-settings.js";
import { DatabaseSync } from "node:sqlite";

test("recaps default off and persist while retired chat settings remain inert", async () => {
  const directory = await mkdtemp(join(tmpdir(), "recap-settings-"));
  let recaps = new RecapSettingsStore(directory);
  try {
    const retiredDocument = JSON.stringify({generation: 7, excludedThreadIds: ["ordinary"], interactiveThreadId: "retired-main"});
    const db = new DatabaseSync(join(directory, "thread-settings.sqlite3"));
    try {
      db.exec("CREATE TABLE settings(id INTEGER PRIMARY KEY, document TEXT NOT NULL)");
      db.prepare("INSERT INTO settings VALUES(1,?)").run(retiredDocument);
    } finally {db.close();}
    assert.deepEqual(recaps.get(), {generation: 1, enabled: false, enabledAt: 0});
    const enabled = recaps.save({generation: 1, enabled: true});
    assert.ok(enabled.enabledAt > 0);
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
    const preserved = new DatabaseSync(join(directory, "thread-settings.sqlite3"), {readOnly: true});
    try {assert.equal(preserved.prepare("SELECT document FROM settings WHERE id=1").get()?.document, retiredDocument);}
    finally {preserved.close();}
  } finally {recaps.close();await rm(directory, {recursive: true, force: true});}
});
