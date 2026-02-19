import { type ChatInputCommandInteraction } from "discord.js";
import type { SessionManager } from "../../claude/session";

export async function handleNewCommand(input: {
  interaction: ChatInputCommandInteraction;
  channelId: string;
  sessions: SessionManager;
  clearSessionPermissionMode: (channelId: string) => void;
}): Promise<void> {
  input.clearSessionPermissionMode(input.channelId);
  input.sessions.resetSession(input.channelId);
  await input.interaction.reply("Session reset for this channel.");
}
