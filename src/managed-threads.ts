import constants from "node:constants";
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import type { TelegramvisorConfig, ThreadInfo } from "./types.js";

const managedRootPrefix = "supervisor-root:";
const maxInventoryBytes = 8 * 1024 * 1024;
const maxManagedThreadIds = 50_000;
const maxThreadIdLength = 512;

export interface ManagedThreadIdentity {
  readonly id: string;
  readonly lineage?: {
    readonly parentThreadId?: unknown;
    readonly rootThreadId?: unknown;
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const validThreadId = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= maxThreadIdLength &&
  !/[\s\u0000-\u001f\u007f]/u.test(value);

export const isManagedThreadIdentity = (
  thread: ManagedThreadIdentity,
  managedThreadIds: ReadonlySet<string>,
): boolean => {
  if (thread.id.startsWith(managedRootPrefix) || managedThreadIds.has(thread.id)) return true;
  const lineage = thread.lineage;
  const rootThreadId = lineage?.rootThreadId;
  if (typeof rootThreadId === "string" &&
    (rootThreadId.startsWith(managedRootPrefix) || managedThreadIds.has(rootThreadId))) return true;
  const parentThreadId = lineage?.parentThreadId;
  if (typeof parentThreadId === "string" &&
    (parentThreadId.startsWith(managedRootPrefix) || managedThreadIds.has(parentThreadId))) return true;
  if (managedThreadIds.size > 0 && typeof rootThreadId !== "string") {
    throw new Error("managed_thread_ancestry_unavailable");
  }
  return false;
};

const parseInventory = (text: string): ReadonlySet<string> => {
  const document: unknown = JSON.parse(text);
  if (!isRecord(document) || Object.keys(document).length !== 2 || document.version !== 1 ||
    !Array.isArray(document.threadIds) || document.threadIds.length > maxManagedThreadIds ||
    !document.threadIds.every(validThreadId) || new Set(document.threadIds).size !== document.threadIds.length) {
    throw new Error("managed_thread_inventory_invalid");
  }
  return new Set(document.threadIds);
};

const decodeInventory = (buffer: Uint8Array): ReadonlySet<string> => {
  try {
    return parseInventory(new TextDecoder("utf-8", { fatal: true }).decode(buffer));
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("managed_thread_inventory_")) throw error;
    throw new Error("managed_thread_inventory_invalid");
  }
};

export const loadManagedThreadIdsSync = (path?: string): ReadonlySet<string> => {
  if (path === undefined) return new Set();
  let descriptor: number;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    throw new Error("managed_thread_inventory_unavailable");
  }
  try {
    const metadata = fstatSync(descriptor);
    if (!metadata.isFile() || metadata.size > maxInventoryBytes) {
      throw new Error("managed_thread_inventory_invalid");
    }
    const buffer = Buffer.alloc(Math.min(metadata.size + 1, maxInventoryBytes + 1));
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const result = readSync(descriptor, buffer, bytesRead, buffer.length - bytesRead, bytesRead);
      if (result === 0) break;
      bytesRead += result;
    }
    if (bytesRead > metadata.size || bytesRead > maxInventoryBytes) throw new Error("managed_thread_inventory_invalid");
    return decodeInventory(buffer.subarray(0, bytesRead));
  } finally {
    closeSync(descriptor);
  }
};

export const isManagedThread = (
  config: TelegramvisorConfig,
  thread: ThreadInfo,
): boolean => isManagedThreadIdentity(thread, loadManagedThreadIdsSync(config.managedThreadIdsFile));
