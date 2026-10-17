import { createHash } from "node:crypto";
import type {
  MessageInfo,
  ProjectInfo,
  Projection,
  RecapContext,
  RunInfo,
  ThreadInfo,
} from "./types.js";
import { timestampMs } from "./timestamp.js";
export { timestampMs } from "./timestamp.js";

const activeRunStates = new Set(["preparing", "queued", "starting", "running", "waiting"]);
const activeTaskStates = new Set(["pending", "running", "waiting"]);
const maxContextChars = 60_000;
const truncationMarker = "\n[content truncated]\n";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export type FreshRuntimeRequestStatus = "pending" | "resolved" | "expired" | "cancelled" | "unknown";

export const freshRuntimeRequestStatus = (
  projection: Projection,
  identity: {requestId?: string | null; nodeId?: string | null},
): FreshRuntimeRequestStatus => {
  if (!Array.isArray(projection.runtimeRequests) || !identity.requestId || !identity.nodeId) return "unknown";
  const node = nodeIndex(projection).get(identity.nodeId);
  if (!node || node.threadId !== projection.thread.id) return "unknown";
  const matches = projection.runtimeRequests.filter((value) => {
    if (!isRecord(value)) return false;
    const requestId = typeof value.id === "string" ? value.id : typeof value.requestId === "string" ? value.requestId : null;
    return requestId === identity.requestId && value.nodeId === identity.nodeId;
  });
  if (matches.length !== 1) return "unknown";
  const status = matches[0]?.status;
  return status === "pending" || status === "resolved" || status === "expired" || status === "cancelled"
    ? status
    : "unknown";
};

const runtimeRequestIdentity = (value: unknown): {requestId?: string; nodeId?: string} => {
  if (!isRecord(value)) return {};
  const requestId = typeof value.id === "string" ? value.id : typeof value.requestId === "string" ? value.requestId : undefined;
  const nodeId = typeof value.nodeId === "string" ? value.nodeId : undefined;
  return {...(requestId === undefined ? {} : {requestId}), ...(nodeId === undefined ? {} : {nodeId})};
};

const runtimeRequestMayBePending = (projection: Projection, value: unknown): boolean => {
  if (!isRecord(value)) return true;
  const status = freshRuntimeRequestStatus(projection, runtimeRequestIdentity(value));
  return status === "pending" || status === "unknown" && value.status === "pending";
};

const hasBlockingBackgroundTask = (value: unknown): boolean => {
  if (!Array.isArray(value)) return false;
  return value.some((task) => !isRecord(task) || task.kind !== "command");
};

const hasPullRequestWatch = (thread: ThreadInfo): boolean =>
  Array.isArray(thread.pullRequests) && thread.pullRequests.some((value) =>
    isRecord(value) && value.watch !== undefined && value.watch !== null && value.source !== "stack-dismissed"
  );

const nodeIndex = (projection: Projection): Map<string, Record<string, unknown>> => {
  const result = new Map<string, Record<string, unknown>>();
  if (!Array.isArray(projection.nodes)) return result;
  for (const value of projection.nodes) {
    if (isRecord(value) && typeof value.id === "string") result.set(value.id, value);
  }
  return result;
};

const isMainRootNode = (
  projection: Projection,
  run: RunInfo,
  nodeId: string,
  nodes: Map<string, Record<string, unknown>>,
  completedAssistant: boolean,
): boolean => {
  const rootId = run.rootNodeId;
  const providerThreadId = run.providerThreadId;
  if (typeof rootId !== "string" || typeof providerThreadId !== "string" || typeof nodeId !== "string") return false;
  const root = nodes.get(rootId);
  const candidate = nodes.get(nodeId);
  if (
    !root ||
    root.kind !== "root_turn" ||
    root.id !== rootId ||
    root.threadId !== projection.thread.id ||
    root.runId !== run.id ||
    root.rootNodeId !== rootId ||
    root.providerThreadId !== providerThreadId ||
    (completedAssistant && root.status !== "completed") ||
    !candidate ||
    (completedAssistant && candidate.kind !== "assistant_message") ||
    candidate.id !== nodeId ||
    candidate.threadId !== projection.thread.id ||
    candidate.runId !== run.id ||
    candidate.rootNodeId !== rootId ||
    candidate.providerThreadId !== providerThreadId ||
    (completedAssistant && candidate.status !== "completed")
  ) return false;

  let current = candidate;
  const visited = new Set<string>();
  while (current.id !== rootId) {
    if (typeof current.id !== "string" || visited.has(current.id) || current.kind === "subagent") return false;
    visited.add(current.id);
    const parentId = current.parentNodeId;
    if (typeof parentId !== "string") return false;
    const parent = nodes.get(parentId);
    if (
      !parent ||
      parent.kind === "subagent" ||
      parent.threadId !== projection.thread.id ||
      parent.runId !== run.id ||
      parent.rootNodeId !== rootId ||
      parent.providerThreadId !== providerThreadId
    ) return false;
    current = parent;
  }
  return true;
};

const isMainRootAssistantMessage = (projection: Projection, run: RunInfo, message: MessageInfo, nodes: Map<string, Record<string, unknown>>): boolean =>
  typeof message.nodeId === "string" && isMainRootNode(projection,run,message.nodeId,nodes,true);

export const mainRunNodeReader = (projection: Projection, run: RunInfo) => {
  const nodes=nodeIndex(projection);
  return (nodeId:string): Record<string,unknown>|undefined =>
    isMainRootNode(projection,run,nodeId,nodes,false) ? nodes.get(nodeId) : undefined;
};

/** Matches a native primary user message to its retained root_turn node, including after restart. */
export const nativeUserMessageVisible = (projection: Projection, run: RunInfo, message: MessageInfo): boolean => {
  if (run.threadId !== projection.thread.id || message.threadId !== projection.thread.id || message.runId !== run.id ||
    typeof message.nodeId !== "string" || message.role !== "user" || message.streaming !== false || run.status === "rolled_back") return false;
  const root = Array.isArray(projection.nodes) ? projection.nodes.find(node => isRecord(node) && node.id === message.nodeId) : undefined;
  return isRecord(root) && root.kind === "root_turn" && root.id === root.rootNodeId && root.threadId === projection.thread.id &&
    root.runId === run.id && (root.parentNodeId === null || root.parentNodeId === undefined) && root.status !== "rolled_back";
};

const hasFinalMessage = (
  projection: Projection,
  run: RunInfo,
  nodes: Map<string, Record<string, unknown>>,
): boolean => projection.messages.some((message) =>
  message.runId === run.id &&
  message.threadId === projection.thread.id &&
  message.role === "assistant" &&
  message.streaming !== true &&
  typeof message.text === "string" &&
  message.text.trim() !== "" &&
  isMainRootAssistantMessage(projection, run, message, nodes)
);

const runIsBusy = (projection: Projection, run: RunInfo, shell?: Record<string, unknown>): boolean => {
  const nodes = nodeIndex(projection);
  const latestRun = projection.runs.reduce<RunInfo | undefined>(
    (latest, candidate) => latest === undefined || candidate.ordinal > latest.ordinal ? candidate : latest,
    undefined,
  );
  const isLatest = latestRun?.id === run.id;
  const belongsToRun = (value: unknown): boolean => {
    if (!isRecord(value)) return isLatest;
    for (const key of ["parentRunId", "sourceRunId", "runId"]) {
      if (typeof value[key] === "string") return value[key] === run.id;
    }
    for (const key of ["ownerNodeId", "parentNodeId", "nodeId", "rootNodeId"]) {
      if (typeof value[key] !== "string") continue;
      const owner = nodes.get(value[key]);
      if (typeof owner?.runId === "string") return owner.runId === run.id;
    }
    // unscoped current thread state must not hold historical completions
    return isLatest;
  };
  const thread = projection.thread;
  const summary = shell ?? thread;
  const requestHint = summary.pendingRuntimeRequest;
  const requestHintStatus = requestHint === undefined || requestHint === null
    ? null
    : freshRuntimeRequestStatus(projection, runtimeRequestIdentity(requestHint));
  if (
    summary.activeRunId === run.id ||
    (isLatest && (
      (Boolean(summary.activeRunId) && !projection.runs.some((candidate) => candidate.id === summary.activeRunId)) ||
      (typeof summary.activityRunStatus === "string" && activeRunStates.has(summary.activityRunStatus)) ||
      (typeof summary.status === "string" && activeRunStates.has(summary.status)) ||
      hasBlockingBackgroundTask(summary.pendingBackgroundTasks)
    )) ||
    (requestHintStatus === "unknown" && belongsToRun(requestHint))
  ) return true;

  if (Array.isArray(projection.runtimeRequests) && projection.runtimeRequests.some((request) =>
    runtimeRequestMayBePending(projection, request) && belongsToRun(request)
  )) return true;

  if (Array.isArray(projection.turnItems) && projection.turnItems.some((item) =>
    isRecord(item) && (item.type === "dynamic_tool" || item.type === "subagent") &&
    activeTaskStates.has(String(item.status)) && belongsToRun(item) &&
    !(item.type === "dynamic_tool" && isRecord(item.input) && item.input.persistent === true)
  )) return true;

  if (Array.isArray(projection.subagents) && projection.subagents.some((task) => {
    if (!belongsToRun(task)) return false;
    if (!isRecord(task)) return true;
    const delivery = isRecord(task.completionDelivery) ? task.completionDelivery : {};
    return activeTaskStates.has(String(task.status)) || delivery.state === "pending" || delivery.state === "claimed";
  })) return true;

  // provider goals, rosters and watches describe ongoing thread work, not prior turns
  if (!isLatest) return false;
  if (hasPullRequestWatch(thread)) return true;
  const providerThreadId = typeof thread.activeProviderThreadId === "string"
    ? thread.activeProviderThreadId
    : typeof run.providerThreadId === "string" ? run.providerThreadId : null;
  if (providerThreadId !== null && Array.isArray(projection.providerThreads)) {
    for (const providerThread of projection.providerThreads) {
      if (!isRecord(providerThread) || providerThread.id !== providerThreadId) continue;
      if (hasBlockingBackgroundTask(providerThread.pendingBackgroundTasks)) return true;
      if (isRecord(providerThread.goal) && providerThread.goal.status === "active") return true;
    }
  }
  return false;
};

/** Reuses completion's ongoing-work signals for an entire native conversation. */
export const projectionHasOngoingWork = (projection: Projection, shell?: ThreadInfo): boolean => {
  if (projection.runs.some(run => activeRunStates.has(run.status))) return true;
  if (Array.isArray(projection.runtimeRequests) && projection.runtimeRequests.some(request => runtimeRequestMayBePending(projection, request))) return true;
  const latest = projection.runs.reduce<RunInfo | undefined>((old, run) => !old || run.ordinal > old.ordinal ? run : old, undefined);
  if (latest && runIsBusy(projection, latest, shell)) return true;
  if (hasPullRequestWatch(projection.thread) || hasBlockingBackgroundTask((shell ?? projection.thread).pendingBackgroundTasks)) return true;
  if (Array.isArray(projection.providerThreads) && projection.providerThreads.some(provider => isRecord(provider) &&
    (hasBlockingBackgroundTask(provider.pendingBackgroundTasks) || isRecord(provider.goal) && provider.goal.status === "active"))) return true;
  return (projection.subagents ?? []).some(task => {
    const delivery = isRecord(task.completionDelivery) ? task.completionDelivery : {};
    return activeTaskStates.has(String(task.status)) || delivery.state === "pending" || delivery.state === "claimed";
  });
};

const latestRootAnswer = (
  projection: Projection,
  run: RunInfo,
  nodes: Map<string, Record<string, unknown>>,
): MessageInfo | null => {
  const answers = projection.messages.filter((message) =>
    message.runId === run.id &&
    message.threadId === projection.thread.id &&
    message.role === "assistant" &&
    message.streaming !== true &&
    typeof message.text === "string" &&
    message.text.trim() !== "" &&
    isMainRootAssistantMessage(projection, run, message, nodes)
  );
  answers.sort((left, right) => {
    const leftTime = timestampMs(left.updatedAt) ?? timestampMs(left.createdAt) ?? -Infinity;
    const rightTime = timestampMs(right.updatedAt) ?? timestampMs(right.createdAt) ?? -Infinity;
    return leftTime - rightTime;
  });
  return answers.at(-1) ?? null;
};

export const isMainThread = (thread: ThreadInfo): boolean =>
  typeof thread.id === "string" &&
  thread.id.length > 0 &&
  !thread.deletedAt &&
  thread.lineage?.relationshipToParent !== "subagent";

export const eligibleRuns = (
  projection: Projection,
  activatedAt: number | string,
  shell?: Record<string, unknown>,
): RunInfo[] => {
  if (!isMainThread(projection.thread)) return [];
  const activation = timestampMs(activatedAt);
  if (activation === null) return [];
  const nodes = nodeIndex(projection);

  return projection.runs
    .filter((run) => {
      if (run.threadId !== projection.thread.id || run.status !== "completed" || runIsBusy(projection, run, shell)) return false;
      const completedAt = timestampMs(run.completedAt);
      return completedAt !== null && completedAt > activation && hasFinalMessage(projection, run, nodes);
    })
    .sort((left, right) => {
      const ordinalOrder = left.ordinal - right.ordinal;
      if (ordinalOrder !== 0) return ordinalOrder;
      return (timestampMs(left.completedAt) ?? 0) - (timestampMs(right.completedAt) ?? 0);
    });
};

const takePrefix = (text: string, maxUnits: number): string => {
  let units = 0;
  let result = "";
  for (const character of text) {
    if (units + character.length > maxUnits) break;
    result += character;
    units += character.length;
  }
  return result;
};

const takeSuffix = (text: string, maxUnits: number): string => {
  let units = 0;
  let result = "";
  for (const character of Array.from(text).reverse()) {
    if (units + character.length > maxUnits) break;
    result = character + result;
    units += character.length;
  }
  return result;
};

export const boundedText = (text: string, maxUnits: number): string => {
  if (text.length <= maxUnits) return text;
  if (maxUnits <= truncationMarker.length + 1) return takePrefix(text, maxUnits);
  const contentUnits = maxUnits - truncationMarker.length;
  const headUnits = Math.floor(contentUnits / 3);
  return takePrefix(text, headUnits) + truncationMarker + takeSuffix(text, contentUnits - headUnits);
};

const compactThread = (thread: ThreadInfo): ThreadInfo => ({
  id: thread.id,
  title: boundedText(typeof thread.title === "string" ? thread.title : "Untitled", 512),
  projectId: typeof thread.projectId === "string" ? boundedText(thread.projectId, 256) : null,
  lineage: {
    parentThreadId: typeof thread.lineage?.parentThreadId === "string"
      ? boundedText(thread.lineage.parentThreadId, 256)
      : null,
    relationshipToParent: typeof thread.lineage?.relationshipToParent === "string"
      ? boundedText(thread.lineage.relationshipToParent, 128)
      : null,
    ...(typeof thread.lineage?.rootThreadId === "string"
      ? { rootThreadId: boundedText(thread.lineage.rootThreadId, 256) }
      : {}),
  },
});

const compactProject = (project: ProjectInfo | null): ProjectInfo | null => project === null
  ? null
  : {
      id: boundedText(project.id, 256),
      title: boundedText(typeof project.title === "string" ? project.title : "Untitled", 512),
      workspaceRoot: boundedText(typeof project.workspaceRoot === "string" ? project.workspaceRoot : "", 2_048),
    };

const currentTurnMessages = (
  projection: Projection,
  targetRun: RunInfo,
  targetFinal: MessageInfo,
): Array<{ role: string; text: string }> => {
  const targetCompletedAt = timestampMs(targetRun.completedAt);
  if (targetCompletedAt === null) return [];
  const nodes = nodeIndex(projection);
  const messages = projection.messages.flatMap((message, index) => {
    if (
      message === targetFinal ||
      (message.runId !== targetRun.id && message.id !== targetRun.userMessageId) ||
      message.threadId !== projection.thread.id ||
      (message.role !== "user" && message.role !== "assistant") ||
      message.streaming === true ||
      typeof message.text !== "string" ||
      message.text.trim() === ""
    ) return [];

    const createdAt = timestampMs(message.createdAt);
    if (createdAt === null || createdAt > targetCompletedAt) return [];
    if (message.role === "assistant" &&
      !isMainRootAssistantMessage(projection, targetRun, message, nodes)) return [];
    return [{
      index,
      createdAt,
      value: { role: message.id.startsWith("supervisor-notice:") ? "supervisor_guidance" : message.role, text: message.text },
    }];
  });
  return messages
    .sort((left, right) => left.createdAt - right.createdAt || left.index - right.index)
    .map(({ value }) => value);
};

export const buildContext = (
  projection: Projection,
  runId: string,
  project: ProjectInfo | null,
  maxChars = maxContextChars,
): RecapContext => {
  if (!Number.isInteger(maxChars) || maxChars < 512) throw new RangeError("context bound must be at least 512 characters");
  const bound = Math.min(maxContextChars, maxChars);
  if (typeof projection.thread.id !== "string" || projection.thread.id.length === 0 || projection.thread.id.length > 512) {
    throw new Error("thread id is invalid");
  }
  const targetRun = projection.runs.find((run) =>
    run.id === runId && run.threadId === projection.thread.id && run.status === "completed"
  );
  if (!targetRun) throw new Error("target run is not completed");
  const final = latestRootAnswer(projection, targetRun, nodeIndex(projection));
  if (!final) throw new Error("completed target has no final root assistant answer");

  const earlier = currentTurnMessages(projection, targetRun, final);
  const request = earlier.find((message) => message.role === "user");
  const context: RecapContext = {
    finalAnswer: "",
    messages: [],
    thread: compactThread(projection.thread),
    project: compactProject(project),
  };
  const encode = (): string => JSON.stringify(context);
  const metadataSize = encode().length;
  if (metadataSize + 64 > bound) throw new RangeError("thread metadata exceeds context bound");
  const requestBudget = Math.floor((bound - metadataSize - 64) / 3);
  if (request) {
    let text = boundedText(request.text, Math.min(12_000, requestBudget));
    context.messages = [{ role: request.role, text }];
    while (encode().length > metadataSize + requestBudget + 64 && text.length > 0) {
      text = boundedText(text, Math.floor(text.length * 0.75));
      context.messages = [{ role: request.role, text }];
    }
  }
  context.finalAnswer = final.text;
  if (encode().length > bound) {
    const metadataSize = encode().length - context.finalAnswer.length;
    const finalBudget = Math.max(0, bound - metadataSize - 32);
    context.finalAnswer = boundedText(context.finalAnswer, finalBudget);
  }
  while (encode().length > bound && context.finalAnswer.length > 64) {
    context.finalAnswer = boundedText(context.finalAnswer, Math.max(64, Math.floor(context.finalAnswer.length * 0.75)));
  }
  if (encode().length > bound) throw new RangeError("thread metadata exceeds context bound");

  const retained = context.messages.map((message) => ({ index: earlier.indexOf(request!), ...message }));
  const prioritized = [...earlier].reverse().filter((message) => message !== request);
  for (const message of prioritized) {
    const available = bound - encode().length - 160;
    if (available < 64) break;
    const text = boundedText(message.text, Math.min(12_000, available));
    retained.push({ index: earlier.indexOf(message), role: message.role, text });
    context.messages = [...retained].sort((left, right) => left.index - right.index).map(({ role, text }) => ({ role, text }));
    if (encode().length > bound) {
      retained.pop();
      context.messages = [...retained].sort((left, right) => left.index - right.index).map(({ role, text }) => ({ role, text }));
      break;
    }
  }
  return context;
};

const safeName = (value: unknown): string => {
  if (typeof value !== "string") return "Untitled";
  const sanitized = value.replace(/[\p{C}]/gu, " ").replace(/\s+/gu, " ").trim();
  if (sanitized === "") return "Untitled";
  return boundedText(sanitized, 180);
};

export const utf16Length = (text: string): number => text.length;

const formatHeader = (thread: ThreadInfo, project: ProjectInfo | null): string => {
  const threadId = thread.id;
  if (
    typeof threadId !== "string" ||
    threadId.length === 0 ||
    threadId.length > 512 ||
    /[\s\p{C}]/u.test(threadId)
  ) throw new Error("thread id is invalid");

  const header = [`Chat: ${safeName(thread.title)}`];
  const projectTitle = project === null ? "" : safeName(project.title);
  const workspaceRoot = typeof project?.workspaceRoot === "string" ? `${project.workspaceRoot}/` : "";
  const scratchProject = workspaceRoot.includes("/.t3/scratch/");
  if (projectTitle !== "" && projectTitle.toLowerCase() !== "no project" && !scratchProject) {
    header.push(`Project: ${projectTitle}`);
  }
  header.push(`Thread: ${threadId}`);
  return `${header.join("\n")}\n\n`;
};

export const telegramRouteUpdateId = (projection: Projection, run: RunInfo): number | null => {
  const request = projection.messages.find((message) =>
    message.id === run.userMessageId && message.role === "user" &&
    message.threadId === projection.thread.id && message.nodeId === run.rootNodeId &&
    (message.runId === run.id || message.runId === null)
  );
  if (!request || run.rootNodeId === null) return null;
  const match = /^message:mcp:[a-f0-9-]+:thread-send:telegram-route-(0|[1-9][0-9]*)$/u.exec(request.id);
  const updateId = match ? Number(match[1]) : NaN;
  return Number.isSafeInteger(updateId) ? updateId : null;
};

export const formatReplyParts = (
  projection: Projection, run: RunInfo, project: ProjectInfo | null,
): string[] => {
  const final = latestRootAnswer(projection, run, nodeIndex(projection));
  if (!final || !final.text.trim() || final.text.length > 1_000_000) throw new Error("reply answer is missing or outside its storage bound");
  const prefix = formatHeader(compactThread(projection.thread), compactProject(project));
  const budget = 4_000 - prefix.length;
  const parts: string[] = [];
  let part = "";
  for (const character of final.text) {
    if (/^[\uD800-\uDFFF]$/u.test(character)) throw new Error("reply contains invalid Unicode");
    if (part.length + character.length > budget) {
      parts.push(prefix + part);
      part = "";
    }
    part += character;
  }
  if (part) parts.push(prefix + part);
  return parts;
};

export const formatMessage = (
  thread: ThreadInfo,
  project: ProjectInfo | null,
  recap: string,
): string => {
  const words = recap.trim().split(/\s+/u).filter(Boolean).slice(0, 30);
  if (words.length === 0) throw new Error("recap is empty");
  const prefix = formatHeader(thread, project);
  const budget = 4_000 - utf16Length(prefix);
  const selected: string[] = [];
  for (const word of words) {
    const candidate = [...selected, word].join(" ");
    if (utf16Length(candidate) > budget) break;
    selected.push(word);
  }
  if (selected.length === 0) throw new Error("recap contains no word that fits the message limit");
  return `${prefix}${selected.join(" ")}`;
};

export const deliveryKey = (environmentId: string, threadId: string, runId: string): string => {
  const identity = JSON.stringify([environmentId, threadId, runId]);
  return `t3-completion-${createHash("sha256").update(identity).digest("hex")}`;
};
