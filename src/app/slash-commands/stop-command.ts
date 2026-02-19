import { MessageFlags, type ChatInputCommandInteraction } from "discord.js";
import type { StopController } from "../../claude/stop";

export async function handleStopCommand(input: {
  interaction: ChatInputCommandInteraction;
  channelId: string;
  stopController: StopController;
}): Promise<void> {
  const wasActive = input.stopController.isActive(input.channelId);

  input.stopController.abort(input.channelId);

  await input.interaction.reply({
    content: wasActive
      ? "🛑 Abort signal sent. The active run will stop."
      : "No active run to stop in this channel.",
    flags: MessageFlags.Ephemeral,
  });
}
