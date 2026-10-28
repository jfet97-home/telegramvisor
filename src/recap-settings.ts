import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Schema } from "effect";
import type { TelegramvisorConfig } from "./types.js";

const RecapSettings = Schema.Struct({generation: Schema.Number, enabled: Schema.Boolean, enabledAt: Schema.Number});
export type RecapSettingsValue = typeof RecapSettings.Type;

/** Persists the global recap opt-in and enablement cutoff. */
export class RecapSettingsStore {
  private readonly db: DatabaseSync;
  constructor(directory: string) {
    mkdirSync(directory, {recursive: true, mode: 0o700});
    const path = join(directory, "thread-settings.sqlite3");
    this.db = new DatabaseSync(path);
    chmodSync(path, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS recap_settings(id INTEGER PRIMARY KEY CHECK(id=1), document TEXT NOT NULL);
      INSERT OR IGNORE INTO recap_settings VALUES(1,'{"generation":1,"enabled":false,"enabledAt":0}')`);
  }
  close(): void {this.db.close();}
  get(): RecapSettingsValue {
    return Schema.decodeUnknownSync(RecapSettings)(JSON.parse(String(this.db.prepare("SELECT document FROM recap_settings WHERE id=1").get()?.document)) as unknown);
  }
  save(input: {generation: number; enabled: boolean}): RecapSettingsValue {
    if (!Number.isSafeInteger(input.generation) || input.generation < 1 || typeof input.enabled !== "boolean")
      throw new Error("Choose valid recap settings.");
    const previous = this.get();
    const next = {generation: input.generation + 1, enabled: input.enabled,
      enabledAt: input.enabled && !previous.enabled ? Date.now() : previous.enabledAt};
    const updated = this.db.prepare("UPDATE recap_settings SET document=? WHERE id=1 AND json_extract(document,'$.generation')=?")
      .run(JSON.stringify(next), input.generation);
    if (!updated.changes) throw new Error("Recap settings changed. Refresh before trying again.");
    return next;
  }
}

export const currentRecapSettings = (config: TelegramvisorConfig): RecapSettingsValue =>
  config.recapSettings?.get() ?? {generation: 0, enabled: false, enabledAt: 0};
