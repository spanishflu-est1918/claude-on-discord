import type {
  AccountInfo as SDKAccountInfo,
  McpServerConfig as SDKMcpServerConfig,
  McpServerStatus as SDKMcpServerStatus,
  SDKMessage,
  ModelInfo as SDKModelInfo,
  PermissionMode as SDKPermissionMode,
  Query as SDKQuery,
  RewindFilesResult as SDKRewindFilesResult,
  SlashCommand as SDKSlashCommand,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";

export type ClaudeModel = string;
export type ClaudePermissionMode = SDKPermissionMode | "delegate";
export type ClaudeQuery = SDKQuery;
export type ClaudeSDKMessage = SDKMessage;
export type ClaudeSDKUserMessage = SDKUserMessage;
export type ClaudeModelInfo = SDKModelInfo;
export type ClaudeAccountInfo = SDKAccountInfo;
export type ClaudeMcpServerStatus = SDKMcpServerStatus;
export type ClaudeRewindFilesResult = SDKRewindFilesResult;
export type ClaudeMcpServerConfig = SDKMcpServerConfig;
export type ClaudeSlashCommand = SDKSlashCommand;

export interface ChannelRecord {
  channelId: string;
  guildId: string;
  workingDir: string;
  sessionId: string | null;
  model: ClaudeModel;
  createdAt: number;
  updatedAt: number;
}

export interface SessionCostRecord {
  id: number;
  sessionId: string;
  channelId: string;
  costUsd: number;
  durationMs: number;
  model: ClaudeModel;
  turnCount: number;
  createdAt: number;
}

export interface SessionCostInsert {
  sessionId: string;
  channelId: string;
  costUsd: number;
  durationMs: number;
  model: ClaudeModel;
  turnCount: number;
}

export interface SessionTurn {
  role: "user" | "assistant";
  content: string;
  timestamp: number;
}

export interface SettingRecord {
  key: string;
  value: string;
  updatedAt: number;
}

export interface ThreadBranchMeta {
  channelId: string;
  guildId: string;
  rootChannelId: string;
  parentChannelId: string | null;
  forkSourceSessionId?: string;
  name: string;
  createdAt: number;
  worktreePath?: string;
  worktreeMode?: "prompt" | "inherited" | "worktree";
  lifecycleState?: "active" | "archived" | "deleted";
  cleanupState?: "none" | "pending" | "kept" | "removed";
  archivedAt?: number;
  deletedAt?: number;
}

export interface RingBufferSnapshot<T> {
  maxSize: number;
  items: T[];
}
