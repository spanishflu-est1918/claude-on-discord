import { type ChatInputCommandInteraction } from "discord.js";
import type { SessionManager } from "../../claude/session";
import type { Repository } from "../../db/repository";
import type { ClaudePermissionMode } from "../../types";
import { buildThreadBranchStatusLines } from "../../discord/thread-branch";
import type { ChannelMentionsMode } from "../../db/repository";

export async function handleStatusCommand(input: {
  interaction: ChatInputCommandInteraction;
  channelId: string;
  guildId: string;
  sessions: SessionManager;
  repository: Repository;
  resolveMentionRequirementForChannel: (channelId: string) => {
    requireMention: boolean;
    mode: ChannelMentionsMode;
  };
  resolvePermissionModeForSession: (channelId: string) => {
    permissionMode: ClaudePermissionMode;
    mode: ClaudePermissionMode | "default";
  };
}): Promise<void> {
  const state = input.sessions.getState(input.channelId, input.guildId);
  const totalCost = input.repository.getChannelCostTotal(input.channelId);
  const turns = state.history.length;
  const channelSystemPrompt = input.repository.getChannelSystemPrompt(input.channelId);
  const mentionPolicy = input.resolveMentionRequirementForChannel(input.channelId);
  const permissionPolicy = input.resolvePermissionModeForSession(input.channelId);
  const threadStatusLines = buildThreadBranchStatusLines({
    currentChannelId: input.channelId,
    entries: input.repository.listThreadBranchMetaEntries(),
  });

  const lines = [
    `**${state.channel.workingDir}**`,
    `model: \`${state.channel.model}\` · turns: \`${turns}\` · cost: \`$${totalCost.toFixed(4)}\``,
    `mode: \`${permissionPolicy.permissionMode}\` · mentions: \`${mentionPolicy.requireMention ? "required" : "off"}\``,
    channelSystemPrompt ? `system prompt: set (\`${channelSystemPrompt.length}\` chars)` : null,
    state.channel.sessionId ? `session: \`${state.channel.sessionId}\`` : null,
    ...threadStatusLines,
  ].filter((line): line is string => line !== null);

  await input.interaction.reply(lines.join("\n"));
}
