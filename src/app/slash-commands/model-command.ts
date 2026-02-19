import { type ChatInputCommandInteraction } from "discord.js";
import type { SessionManager } from "../../claude/session";
import type { StopController } from "../../claude/stop";

export async function handleModelCommand(input: {
  interaction: ChatInputCommandInteraction;
  channelId: string;
  sessions: SessionManager;
  stopController: StopController;
}): Promise<void> {
  const model = input.interaction.options.getString("name", true);
  input.sessions.setModel(input.channelId, model);
  await input.stopController.setModel(input.channelId, model);
  await input.interaction.reply(`Model set to \`${model}\`.`);
}
