import { type ChatInputCommandInteraction } from "discord.js";
import type { SessionManager } from "../../claude/session";
import { runNewSessionAction } from "../command-actions/new-action";

export async function handleNewCommand(input: {
  interaction: ChatInputCommandInteraction;
  channelId: string;
  sessions: SessionManager;
  clearSessionPermissionMode: (channelId: string) => void;
}): Promise<void> {
  const result = runNewSessionAction({
    channelId: input.channelId,
    clearSessionPermissionMode: input.clearSessionPermissionMode,
    resetSession: (channelId) => input.sessions.resetSession(channelId),
  });
  await input.interaction.reply(result.message);
}
