import { type ChatInputCommandInteraction, MessageFlags } from "discord.js";
import type { StopController } from "../../claude/stop";
import { runStopAction } from "../command-actions/stop-action";

export async function handleStopCommand(input: {
  interaction: ChatInputCommandInteraction;
  channelId: string;
  stopController: StopController;
  abortPendingRun: (channelId: string) => boolean;
}): Promise<void> {
  const result = runStopAction({
    channelId: input.channelId,
    isActive: (channelId) => input.stopController.isActive(channelId),
    abort: (channelId) => input.stopController.abort(channelId),
    abortPending: (channelId) => input.abortPendingRun(channelId),
  });
  await input.interaction.reply({
    content: result.message,
    flags: MessageFlags.Ephemeral,
  });
}
