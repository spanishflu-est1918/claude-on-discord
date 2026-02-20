import { type ChatInputCommandInteraction } from "discord.js";
import type { SessionManager } from "../../claude/session";
import { runCompactAction } from "../command-actions/compact-action";

export async function handleCompactCommand(input: {
  interaction: ChatInputCommandInteraction;
  channelId: string;
  guildId: string;
  sessions: SessionManager;
  compactHistory: (
    history: Array<{ role: "user" | "assistant"; content: string }>,
    maxLines?: number,
  ) => string;
  clearSessionPermissionMode: (channelId: string) => void;
}): Promise<void> {
  const result = runCompactAction({
    channelId: input.channelId,
    guildId: input.guildId,
    getState: (channelId, guildId) => input.sessions.getState(channelId, guildId),
    compactHistory: input.compactHistory,
    clearSessionPermissionMode: input.clearSessionPermissionMode,
    resetSession: (channelId) => input.sessions.resetSession(channelId),
    appendTurn: (channelId, turn) => input.sessions.appendTurn(channelId, turn),
  });
  await input.interaction.reply(result.message);
}
