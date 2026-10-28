import { Effect } from "effect";
import { chmod, copyFile, mkdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { TelegramvisorConfig } from "./types.js";

export const loadDataDirectory = (): string => process.env.DATA_DIRECTORY ??
  join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "telegramvisor");

export const loadConfig = (): TelegramvisorConfig => {
  const dataDirectory = loadDataDirectory();
  const managedThreadIdsFile = process.env.MANAGED_THREAD_IDS_FILE?.trim();
  return {
    dataDirectory,
    t3Url: process.env.T3_URL ?? "http://127.0.0.1:3773",
    t3TokenFile: process.env.T3_TOKEN_FILE ?? "/run/secrets/t3-read-token",
    t3InputTokenFile: process.env.T3_INPUT_TOKEN_FILE ?? "/run/secrets/t3-input-token",
    t3OperateTokenFile: process.env.T3_OPERATE_TOKEN_FILE ?? "/run/secrets/t3-operate-token",
    mcpxUrl: process.env.MCPX_URL ?? "http://mcpx:9000/mcp/lazy",
    cxCommand: process.env.CX_COMMAND ?? "cx",
    cxHome: process.env.CX_HOME ?? join(dataDirectory, "runtime-auth"),
    cxSeedFile: process.env.CX_SEED_FILE ?? "/run/secrets/codex-auth.json",
    healthPort: Number(process.env.HEALTH_PORT ?? "9037"),
    modelTimeoutMs: Number(process.env.MODEL_TIMEOUT_MS ?? "360000"),
    telegramEnabled: process.env.TELEGRAM_ENABLED === "true",
    inputEnabled: process.env.TELEGRAM_ENABLED === "true" && process.env.INPUT_ENABLED === "true",
    inputPollMs: Number(process.env.INPUT_POLL_MS ?? "1000"),
    uiPort: Number(process.env.UI_PORT ?? "9038"),
    uiHost: process.env.UI_HOST ?? "127.0.0.1",
    uiAssetsDirectory: process.env.UI_ASSETS_DIRECTORY ?? fileURLToPath(new URL("../ui-dist", import.meta.url)),
    ...(managedThreadIdsFile ? { managedThreadIdsFile } : {}),
  };
};

export const initializeRuntimeAuth = (config: TelegramvisorConfig) => Effect.tryPromise(async () => {
  process.umask(0o077);
  await mkdir(config.cxHome, { recursive: true, mode: 0o700 });
  await chmod(config.cxHome, 0o700);
  const destination = join(config.cxHome, "auth.json");
  try {
    await stat(destination);
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
    await copyFile(config.cxSeedFile, destination);
  }
  await chmod(destination, 0o600);
});
