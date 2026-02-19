import { type ChatInputCommandInteraction } from "discord.js";
import type { SessionManager } from "../../claude/session";

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
  const state = input.sessions.getState(input.channelId, input.guildId);
  const summary = input.compactHistory(state.history);
  input.clearSessionPermissionMode(input.channelId);
  input.sessions.resetSession(input.channelId);
  input.sessions.appendTurn(input.channelId, {
    role: "assistant",
    content: `Context summary:\n${summary}`,
  });
  await input.interaction.reply("Context compacted and session reset.");
}
