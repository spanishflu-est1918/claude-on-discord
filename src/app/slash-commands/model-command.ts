import { type ChatInputCommandInteraction } from "discord.js";
import type { SessionManager } from "../../claude/session";
import type { StopController } from "../../claude/stop";
import { runModelAction } from "../command-actions/model-action";

export async function handleModelCommand(input: {
  interaction: ChatInputCommandInteraction;
  channelId: string;
  sessions: SessionManager;
  stopController: StopController;
}): Promise<void> {
  const model = input.interaction.options.getString("name", true);
  const result = await runModelAction({
    channelId: input.channelId,
    model,
    setSessionModel: (channelId, model) => input.sessions.setModel(channelId, model),
    stopControllerSetModel: async (channelId, model) =>
      await input.stopController.setModel(channelId, model),
  });
  await input.interaction.reply(result.message);
}
