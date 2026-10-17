import { createHash } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { InputEvent } from "./input-domain.js";

export interface InputReplyDeletion {
  readonly messageId: number;
  readonly inputId: string;
  readonly revision: string;
  readonly key: string;
  readonly state: "pending" | "unknown";
  readonly createdAt: number;
  readonly ready: boolean;
}

export class InputReplyCleanup {
  private readonly db: DatabaseSync;

  constructor(directory: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
    const path = join(directory, "telegram-input-replies.sqlite3");
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=DELETE; PRAGMA max_page_count=16384;
      CREATE TABLE IF NOT EXISTS replies (
        message_id INTEGER PRIMARY KEY, input_id TEXT NOT NULL, revision TEXT NOT NULL,
        delivery_key TEXT NOT NULL UNIQUE, state TEXT NOT NULL DEFAULT 'pending'
          CHECK(state IN ('pending','unknown','deleted','expired','retained')),
        created_at INTEGER NOT NULL, retry_at INTEGER NOT NULL DEFAULT 0,
        attempts INTEGER NOT NULL DEFAULT 0, ready INTEGER NOT NULL DEFAULT 0
      );`);
    chmodSync(path, 0o600);
  }

  close(): void { this.db.close(); }

  track(event: InputEvent, now: number): void {
    if (!["answer", "stale"].includes(event.action) || !event.contributionId ||
      !/^[1-9][0-9]{0,15}$/u.test(event.contributionId)) return;
    const messageId = Number(event.contributionId);
    if (!Number.isSafeInteger(messageId) || messageId <= event.messageId) return;
    const existing = this.db.prepare("SELECT input_id,revision FROM replies WHERE message_id=?").get(messageId);
    if (existing) {
      if (existing.input_id !== event.inputId || existing.revision !== event.requestRevision) {
        throw new Error("questionnaire reply ownership conflict");
      }
      return;
    }
    const count = this.db.prepare("SELECT count(*) AS count FROM replies").get()!;
    if (Number(count.count) >= 100_000) throw new Error("questionnaire reply cleanup capacity reached");
    const key = `input-reply-delete-${createHash("sha256")
      .update(JSON.stringify([event.inputId, event.requestRevision, messageId])).digest("hex").slice(0, 40)}`;
    this.db.prepare("INSERT INTO replies(message_id,input_id,revision,delivery_key,created_at) VALUES(?,?,?,?,?)")
      .run(messageId, event.inputId, event.requestRevision, key, now);
  }

  due(now: number): InputReplyDeletion[] {
    return this.db.prepare("SELECT * FROM replies WHERE state IN ('pending','unknown') AND retry_at<=? ORDER BY created_at LIMIT 500")
      .all(now).map((row) => ({
        messageId: Number(row.message_id), inputId: String(row.input_id), revision: String(row.revision),
        key: String(row.delivery_key), state: row.state as InputReplyDeletion["state"], createdAt: Number(row.created_at),
        ready: row.ready === 1,
      }));
  }

  begin(key: string): boolean {
    return Number(this.db.prepare("UPDATE replies SET state='unknown',attempts=attempts+1 WHERE delivery_key=? AND state='pending' AND ready=1").run(key).changes) === 1;
  }

  complete(key: string): void {
    this.db.prepare("UPDATE replies SET state='deleted' WHERE delivery_key=?").run(key);
  }

  defer(key: string, now: number): void {
    this.db.prepare("UPDATE replies SET retry_at=? WHERE delivery_key=? AND state='pending'").run(now + 5_000, key);
  }

  expedite(inputId: string, revision: string): void {
    this.db.prepare("UPDATE replies SET retry_at=0,ready=1 WHERE input_id=? AND revision=? AND state='pending'").run(inputId, revision);
  }

  retain(key: string): void {
    this.db.prepare("UPDATE replies SET state='retained' WHERE delivery_key=? AND state='pending' AND ready=0").run(key);
  }

  expire(key: string): void {
    this.db.prepare("UPDATE replies SET state='expired' WHERE delivery_key=? AND state='pending'").run(key);
  }

  unavailable(key: string): void {
    this.db.prepare("UPDATE replies SET state='expired' WHERE delivery_key=? AND state='unknown'").run(key);
  }

  rejected(key: string, now: number, retryAfterMs = 0): void {
    const row = this.db.prepare("SELECT attempts FROM replies WHERE delivery_key=?").get(key);
    const delay = Math.max(Math.min(5_000 * 2 ** Math.min(Number(row?.attempts ?? 1), 10), 3_600_000),
      Math.min(Math.max(retryAfterMs, 0), 86_400_000));
    this.db.prepare("UPDATE replies SET state='pending',retry_at=? WHERE delivery_key=? AND state='unknown'").run(now + delay, key);
  }

  stats(): { pending: number; unknown: number; expired: number } {
    const result = { pending: 0, unknown: 0, expired: 0 };
    for (const row of this.db.prepare("SELECT state,count(*) AS count FROM replies GROUP BY state").all()) {
      if (row.state === "pending" || row.state === "unknown" || row.state === "expired") result[row.state] = Number(row.count);
    }
    return result;
  }
}
