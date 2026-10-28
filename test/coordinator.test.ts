import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Effect, Fiber, Layer } from "effect";
import { createStatus, runTelegramvisor } from "../src/coordinator.js";
import { Recapper, type RecapperApi } from "../src/recap.js";
import { Store, type StoreShape, type ThreadHint } from "../src/store.js";
import { T3Client, type T3ClientShape } from "../src/t3.js";
import { TelegramClient, type TelegramClientApi } from "../src/telegram.js";
import type { TelegramvisorConfig, ThreadInfo } from "../src/types.js";

test("completion scan refreshes legacy lineage and defers inventory failures per hint", async () => {
  const directory = await mkdtemp(join(tmpdir(), "telegramvisor-coordinator-"));
  const inventoryPath = join(directory, "managed-thread-ids.json");
  const validInventory = JSON.stringify({ version: 1, threadIds: ["legacy-root"] });
  await writeFile(inventoryPath, validInventory, { mode: 0o600 });

  const shell = (id: string, rootThreadId?: string): ThreadInfo => ({
    id,
    title: id,
    projectId: null,
    lineage: {
      parentThreadId: null,
      relationshipToParent: null,
      ...(rootThreadId === undefined ? {} : { rootThreadId }),
    },
  });
  const hints: ThreadHint[] = [
    { threadId: "legacy-child", revision: 1, shell: shell("legacy-child") },
    { threadId: "inventory-error", revision: 1, shell: shell("inventory-error", "ordinary-root") },
    { threadId: "ordinary-chat", revision: 1, shell: shell("ordinary-chat", "ordinary-chat") },
  ];
  const freshThreads = new Map([
    ["legacy-child", shell("legacy-child", "legacy-root")],
    ["ordinary-chat", shell("ordinary-chat", "ordinary-chat")],
  ]);
  const completedHints: string[] = [];
  const deferredHints: Array<{ threadId: string; delayMs: number | undefined }> = [];
  const projectionReads: string[] = [];
  let deliveredBatch = false;
  let signalComplete!: () => void;
  const complete = new Promise<void>((resolve) => { signalComplete = resolve; });

  const store = {
    recoverSending: () => Effect.succeed(0),
    activate: () => Effect.succeed(1),
    configureTelegram: () => Effect.succeed(1),
    stats: () => Effect.succeed({
      projects: 0, threads: hints.length, dirtyHints: hints.length, deferredHints: 0, waitingHints: 0,
      identities: 0, jobs: { pending: 0, ready: 0, sending: 0, sent: 0, unknown: 0 }, databaseBytes: 0,
    }),
    prune: () => Effect.succeed({ contexts: 0, sentMetadata: 0 }),
    cursor: () => Effect.succeed(0),
    ingest: () => Effect.void,
    watch: () => Effect.never,
    dueHints: () => {
      if (deliveredBatch) return Effect.succeed([]);
      deliveredBatch = true;
      return Effect.succeed(hints);
    },
    dueJobs: () => Effect.succeed([]),
    doneHint: (threadId: string) => {
      completedHints.push(threadId);
      if (threadId === "legacy-child") writeFileSync(inventoryPath, "{invalid");
      if (threadId === "ordinary-chat" && deferredHints.length === 1) signalComplete();
      return Effect.succeed(true);
    },
    deferHint: (threadId: string, _revision: number, _now: number, delayMs?: number) => {
      deferredHints.push({ threadId, delayMs });
      writeFileSync(inventoryPath, validInventory);
      return Effect.succeed(true);
    },
    project: () => Effect.succeed(null),
  } as unknown as StoreShape;

  const t3 = {
    descriptor: () => Effect.succeed({ environmentId: "test-environment", orchestrationProtocolVersion: 2 as const, serverVersion: "test" }),
    watch: () => Effect.never,
    projection: (threadId: string) => {
      projectionReads.push(threadId);
      const thread = freshThreads.get(threadId);
      if (!thread) return Effect.die(new Error(`unexpected projection read: ${threadId}`));
      return Effect.succeed({
        snapshotSequence: 1,
        projection: { thread, runs: [], messages: [] },
      });
    },
  } as unknown as T3ClientShape;
  const telegram: TelegramClientApi = {
    getBotInfo: () => Effect.succeed({ id: 1, isBot: true, firstName: "test", username: null }),
    getDeliveryStatus: () => Effect.succeed({ state: "not_found" }),
    sendMessage: () => Effect.succeed({ kind: "sent", messageId: 1 }),
  };
  const recapper: RecapperApi = { recap: () => Effect.succeed(null) };
  const services = Layer.mergeAll(
    Layer.succeed(Store, store),
    Layer.succeed(T3Client, t3),
    Layer.succeed(TelegramClient, telegram),
    Layer.succeed(Recapper, recapper),
  );
  const config: TelegramvisorConfig = {
    dataDirectory: directory,
    t3Url: "http://127.0.0.1:1",
    t3TokenFile: "unused",
    t3InputTokenFile: "unused",
    t3OperateTokenFile: "unused",
    mcpxUrl: "http://127.0.0.1:1",
    cxCommand: "unused",
    cxHome: directory,
    cxSeedFile: "unused",
    healthPort: 0,
    modelTimeoutMs: 1_000,
    telegramEnabled: true,
    inputEnabled: false,
    uiPort: 0,
    managedThreadIdsFile: inventoryPath,
  };
  const fiber = Effect.runFork(Effect.scoped(runTelegramvisor(config, createStatus(config)).pipe(Effect.provide(services))));
  let timeout: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      complete,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error("completion hints were not processed")), 5_000);
      }),
    ]);
    assert.deepEqual(completedHints, ["legacy-child", "ordinary-chat"]);
    assert.deepEqual(deferredHints, [{ threadId: "inventory-error", delayMs: 60_000 }]);
    assert.deepEqual(projectionReads, ["legacy-child", "ordinary-chat"]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    await Effect.runPromise(Fiber.interrupt(fiber));
    await rm(directory, { recursive: true, force: true });
  }
});
