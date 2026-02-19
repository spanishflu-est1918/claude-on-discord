import type { ChatInputCommandInteraction } from "discord.js";
import type { ClaudePermissionMode } from "../../types";

export type MentionPolicy = {
  requireMention: boolean;
  mode: string;
};

export type PermissionPolicy = {
  mode: string;
  permissionMode: ClaudePermissionMode;
};

export type SessionSlashCommandInput = {
  interaction: ChatInputCommandInteraction;
  channelId: string;
  defaultRequireMention: boolean;
  defaultPermissionMode: ClaudePermissionMode;
  getChannelCostTotal: (channelId: string) => number;
  getChannelTurnCount: (channelId: string) => number;
  setChannelSystemPrompt: (channelId: string, text: string) => void;
  getChannelSystemPrompt: (channelId: string) => string | null;
  clearChannelSystemPrompt: (channelId: string) => void;
  setChannelMentionsMode: (channelId: string, mode: string) => void;
  clearChannelMentionsMode: (channelId: string) => void;
  resetSessionId: (channelId: string) => void;
  getActiveSessionId: (channelId: string) => string | null;
  setSessionPermissionMode: (channelId: string, mode: ClaudePermissionMode | "default") => void;
  clearSessionPermissionMode: (channelId: string) => void;
  resolveMentionRequirementForChannel: (channelId: string) => MentionPolicy;
  resolvePermissionModeForSession: (channelId: string) => PermissionPolicy;
  chunkDiscordText: (text: string) => string[];
};
