import type { ChannelRecord, SessionTurn } from "../types";

export type ChannelRow = {
  channel_id: string;
  guild_id: string;
  working_dir: string;
  session_id: string | null;
  model: string;
  created_at: number;
  updated_at: number;
};

export type SettingRow = {
  key: string;
  value: string;
  updated_at: number;
};

export type SessionTurnRow = {
  id: number;
  channel_id: string;
  role: SessionTurn["role"];
  content: string;
  timestamp_ms: number;
};

const CHANNEL_SYSTEM_PROMPT_PREFIX = "channel_system_prompt:";
const CHANNEL_THREAD_BRANCH_PREFIX = "channel_thread_branch:";
const CHANNEL_MENTIONS_MODE_PREFIX = "channel_mentions_mode:";
const CHANNEL_PERMISSION_MODE_PREFIX = "channel_permission_mode:";
const CHANNEL_MERGE_CONTEXT_PREFIX = "channel_merge_context:";
export const GLOBAL_SYSTEM_PROMPT_KEY = "global:system_prompt";

export function channelSystemPromptKey(channelId: string): string {
  return `${CHANNEL_SYSTEM_PROMPT_PREFIX}${channelId}`;
}

export function channelThreadBranchKey(channelId: string): string {
  return `${CHANNEL_THREAD_BRANCH_PREFIX}${channelId}`;
}

export function channelMentionsModeKey(channelId: string): string {
  return `${CHANNEL_MENTIONS_MODE_PREFIX}${channelId}`;
}

export function channelPermissionModeKey(channelId: string): string {
  return `${CHANNEL_PERMISSION_MODE_PREFIX}${channelId}`;
}

export function channelMergeContextKey(channelId: string): string {
  return `${CHANNEL_MERGE_CONTEXT_PREFIX}${channelId}`;
}

export function threadBranchKeyPattern(): string {
  return `${CHANNEL_THREAD_BRANCH_PREFIX}%`;
}

export function threadBranchChannelIdFromKey(key: string): string | null {
  if (!key.startsWith(CHANNEL_THREAD_BRANCH_PREFIX)) {
    return null;
  }
  const channelId = key.slice(CHANNEL_THREAD_BRANCH_PREFIX.length);
  return channelId || null;
}

export function mapChannelRow(row: ChannelRow): ChannelRecord {
  return {
    channelId: row.channel_id,
    guildId: row.guild_id,
    workingDir: row.working_dir,
    sessionId: row.session_id,
    model: row.model,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function mapSessionTurnRow(row: SessionTurnRow): SessionTurn {
  return {
    role: row.role,
    content: row.content,
    timestamp: row.timestamp_ms,
  };
}
