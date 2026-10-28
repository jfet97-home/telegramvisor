export type JsonRecord = Record<string, unknown>;

export interface ThreadInfo {
  id: string;
  title: string;
  projectId: string | null;
  lineage: { parentThreadId: string | null; relationshipToParent: string | null; rootThreadId?: string };
  latestRunCompletedAt?: string | null;
  activeRunId?: string | null;
  activityRunStatus?: string | null;
  pendingRuntimeRequest?: unknown;
  pendingBackgroundTasks?: Array<{ kind?: string; [key: string]: unknown }>;
  deletedAt?: string | null;
  [key: string]: unknown;
}

export interface ProjectInfo {
  id: string;
  title: string;
  workspaceRoot: string;
  [key: string]: unknown;
}

export interface RunInfo {
  id: string;
  ordinal: number;
  status: string;
  requestedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  rootNodeId: string | null;
  userMessageId?: string | null;
  [key: string]: unknown;
}

export interface MessageInfo {
  id: string;
  runId: string | null;
  nodeId: string | null;
  role: string;
  text: string;
  streaming: boolean;
  createdAt: string;
  updatedAt: string;
  [key: string]: unknown;
}

export interface ProviderThreadInfo {
  id?: unknown;
  providerInstanceId?: unknown;
  providerSessionId?: unknown;
  appThreadId?: unknown;
  [key: string]: unknown;
}

export interface Projection {
  thread: ThreadInfo;
  runs: RunInfo[];
  messages: MessageInfo[];
  providerThreads?: ProviderThreadInfo[];
  subagents?: JsonRecord[];
  turnItems?: JsonRecord[];
  [key: string]: unknown;
}

export interface RecapContext {
  finalAnswer: string;
  messages: Array<{role: string; text: string}>;
  thread: ThreadInfo;
  project: ProjectInfo | null;
}

export interface TelegramvisorActivity {
  id: string;
  kind: string;
  threadId: string | null;
  runId: string | null;
  ruleId: null;
  state: string;
  reason: string;
  detail: string | null;
  createdAt: number;
}

export type JobState = "pending" | "ready" | "sending" | "sent" | "unknown";

export interface Job {
  id: string;
  environmentId: string;
  threadId: string;
  runId: string;
  deliveryKey: string;
  state: JobState;
  context: RecapContext | null;
  text: string | null;
  messageId: number | null;
  attempts: number;
  nextAttemptAt: number;
  createdAt: number;
  updatedAt: number;
  error: string | null;
}

export interface SourceItem {
  stream: "active" | "archive";
  item: JsonRecord;
}

export interface TelegramvisorConfig {
  dataDirectory: string;
  t3Url: string;
  t3TokenFile: string;
  t3InputTokenFile: string;
  t3OperateTokenFile: string;
  mcpxUrl: string;
  cxCommand: string;
  cxHome: string;
  cxSeedFile: string;
  excludedThreadIds: string[];
  threadPolicy?: import("./thread-policy.js").ThreadPolicyStore;
  recapSettings?: import("./recap-settings.js").RecapSettingsStore;
  healthPort: number;
  modelTimeoutMs: number;
  telegramEnabled?: boolean;
  inputEnabled?: boolean;
  inputPollMs?: number;
  uiPort: number;
  uiHost?: string;
  uiAssetsDirectory?: string;
  managedThreadIdsFile?: string;
}
