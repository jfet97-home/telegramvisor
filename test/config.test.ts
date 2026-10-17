import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "../src/config.js";

const configVariables = [
  "DATA_DIRECTORY",
  "T3_URL",
  "T3_TOKEN_FILE",
  "T3_INPUT_TOKEN_FILE",
  "T3_OPERATE_TOKEN_FILE",
  "MCPX_URL",
  "TELEGRAM_ENABLED",
  "INPUT_ENABLED",
  "UI_PORT",
  "HEALTH_PORT",
  "MANAGED_THREAD_IDS_FILE",
] as const;

test("configuration keeps standalone ports, native credentials and master Telegram gating", () => {
  const prior = new Map(configVariables.map((key) => [key, process.env[key]]));
  try {
    for (const key of configVariables) delete process.env[key];
    process.env.DATA_DIRECTORY = "/tmp/telegramvisor-config-test";
    process.env.TELEGRAM_ENABLED = "true";
    process.env.INPUT_ENABLED = "true";
    process.env.MANAGED_THREAD_IDS_FILE = " /tmp/telegramvisor-config-test/managed-thread-ids.json ";

    const enabled = loadConfig();
    assert.equal(enabled.healthPort, 9037);
    assert.equal(enabled.uiPort, 9038);
    assert.equal(enabled.telegramEnabled, true);
    assert.equal(enabled.inputEnabled, true);
    assert.equal(enabled.t3InputTokenFile, "/run/secrets/t3-input-token");
    assert.equal(enabled.t3OperateTokenFile, "/run/secrets/t3-operate-token");
    assert.equal(enabled.managedThreadIdsFile, "/tmp/telegramvisor-config-test/managed-thread-ids.json");

    process.env.TELEGRAM_ENABLED = "false";
    const disabled = loadConfig();
    assert.equal(disabled.telegramEnabled, false);
    assert.equal(disabled.inputEnabled, false);
  } finally {
    for (const [key, value] of prior) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
