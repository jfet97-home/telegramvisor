import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Effect, Fiber, Layer } from "effect";
import { createStatus, runTelegramvisor } from "../src/coordinator.js";
import { deliveryKey } from "../src/domain.js";
import { Recapper, type RecapperApi } from "../src/recap.js";
import { RecapSettingsStore } from "../src/recap-settings.js";
import { makeStore, Store, type StoreShape } from "../src/store.js";
import { T3Client, type T3ClientShape } from "../src/t3.js";
import { TelegramClient, type TelegramClientApi } from "../src/telegram.js";
import type { RecapContext, TelegramvisorConfig } from "../src/types.js";

const context: RecapContext = {
  finalAnswer: "Implemented the requested feature and verified the result.", messages: [], project: null,
  thread: {id: "chat", title: "Feature", projectId: null, lineage: {parentThreadId: null, relationshipToParent: null}},
};

const withCoordinator = async (run: (store: StoreShape, settings: RecapSettingsStore,
  start: (recapper: RecapperApi, telegram: TelegramClientApi) => Promise<void>) => Promise<void>) => {
  const directory = await mkdtemp(join(tmpdir(), "recap-toggle-"));
  const settings = new RecapSettingsStore(directory);
  try {
    await Effect.runPromise(Effect.scoped(Store.use(store => Effect.promise(async () => {
      await Effect.runPromise(store.activate("environment", 1));
      await run(store, settings, async (recapper, telegram) => {
        const config: TelegramvisorConfig = {
          dataDirectory: directory, t3Url: "unused", t3TokenFile: "unused", t3InputTokenFile: "unused", t3OperateTokenFile: "unused",
          mcpxUrl: "unused", cxCommand: "unused", cxHome: directory, cxSeedFile: "unused", excludedThreadIds: [],
          recapSettings: settings, healthPort: 0, uiPort: 0, modelTimeoutMs: 1000, telegramEnabled: true, inputEnabled: false,
        };
        const t3 = {descriptor: () => Effect.succeed({environmentId: "environment", orchestrationProtocolVersion: 2, serverVersion: "test"}),
          watch: () => Effect.never} as unknown as T3ClientShape;
        const services = Layer.mergeAll(Layer.succeed(Store, store), Layer.succeed(T3Client, t3),
          Layer.succeed(Recapper, recapper), Layer.succeed(TelegramClient, telegram));
        const fiber = Effect.runFork(Effect.scoped(runTelegramvisor(config, createStatus(config)).pipe(Effect.provide(services))));
        try {
          const deadline = Date.now() + 5000;
          while ((await Effect.runPromise(store.dueJobs(Date.now(), ["pending", "ready", "unknown"]))).length > 0) {
            if (Date.now() > deadline) throw new Error("delivery queue did not settle");
            await new Promise(resolve => setTimeout(resolve, 10));
          }
        } finally {await Effect.runPromise(Fiber.interrupt(fiber));}
      });
    })).pipe(Effect.provide(makeStore(directory)))));
  } finally {settings.close();await rm(directory, {recursive: true, force: true});}
};

test("default-off suppresses pending and prepared recaps, preserves identities, reconciles uncertainty and sends exact replies", async () => {
  await withCoordinator(async (store, _settings, start) => {
    await Effect.runPromise(Effect.gen(function* () {
      yield* store.enqueue("environment", "chat", "pending", context, 1);
      const prepared = (yield* store.enqueue("environment", "chat", "prepared", context, 2))!;
      yield* store.setReady(prepared, "Prepared recap", 2);
      const uncertain = (yield* store.enqueue("environment", "chat", "uncertain", context, 3))!;
      yield* store.setReady(uncertain, "Uncertain recap", 3);
      yield* store.claimSend(uncertain, 3);
      yield* store.markUnknown(uncertain, "lost_receipt", 3);
      yield* store.enqueueReply("environment", "chat", "reply", ["The exact full answer"], 4);
    }));
    const sent: string[] = [];
    const reconciled: string[] = [];
    await start({recap: () => Effect.die(new Error("disabled recapper was invoked"))}, {
      getBotInfo: () => Effect.succeed({id: 1, isBot: true, firstName: "test", username: null}),
      getDeliveryStatus: key => {reconciled.push(key);return Effect.succeed({state: "sent", messageId: 20});},
      sendMessage: (_key, text) => {sent.push(text);return Effect.succeed({kind: "sent", messageId: 21});},
    });
    assert.deepEqual(sent, ["The exact full answer"]);
    assert.deepEqual(reconciled, [deliveryKey("environment", "chat", "uncertain")]);
    for (const run of ["pending", "prepared"]) {
      assert.equal(await Effect.runPromise(store.getJob(deliveryKey("environment", "chat", run))), null);
      assert.equal(await Effect.runPromise(store.hasIdentity("environment", "chat", run)), true);
    }
    assert.equal((await Effect.runPromise(store.getJob(deliveryKey("environment", "chat", "uncertain"))))?.state, "sent");
  });
});

for (const phase of ["model", "send"] as const) {
  test(`disabling recaps during the ${phase} step prevents a send`, async () => {
    await withCoordinator(async (store, settings, start) => {
      settings.save({generation: 1, enabled: true});
      await Effect.runPromise(store.enqueue("environment", "chat", "run", context, Date.now()));
      let prepared = false;
      let sends = 0;
      const disable = () => settings.save({generation: settings.get().generation, enabled: false});
      await start({recap: () => Effect.sync(() => {
        prepared = true;
        if (phase === "model") disable();
        return "The requested feature is ready.";
      })}, {
        getBotInfo: () => Effect.sync(() => {
          if (phase === "send" && prepared && settings.get().enabled) disable();
          return {id: 1, isBot: true, firstName: "test", username: null};
        }),
        getDeliveryStatus: () => Effect.succeed({state: "not_found"}),
        sendMessage: () => {sends += 1;return Effect.succeed({kind: "sent", messageId: 1});},
      });
      assert.equal(prepared, true);
      assert.equal(sends, 0);
      assert.equal(settings.get().enabled, false);
    });
  });
}

test("enabling sends new recaps while discarding an older queued recap", async () => {
  await withCoordinator(async (store, settings, start) => {
    await Effect.runPromise(store.enqueue("environment", "chat", "old", context, 1));
    settings.save({generation: 1, enabled: true});
    await Effect.runPromise(store.enqueue("environment", "chat", "new", context, Date.now()));
    const sent: string[] = [];
    let modelCalls = 0;
    await start({recap: () => {modelCalls += 1;return Effect.succeed("The new feature is ready.");}}, {
      getBotInfo: () => Effect.succeed({id: 1, isBot: true, firstName: "test", username: null}),
      getDeliveryStatus: () => Effect.succeed({state: "not_found"}),
      sendMessage: key => {sent.push(key);return Effect.succeed({kind: "sent", messageId: 1});},
    });
    assert.equal(modelCalls, 1);
    assert.deepEqual(sent, [deliveryKey("environment", "chat", "new")]);
    assert.equal(await Effect.runPromise(store.getJob(deliveryKey("environment", "chat", "old"))), null);
  });
});
