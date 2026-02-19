import { runCostAction } from "../command-actions/cost-action";
import type { SessionSlashCommandInput } from "./context";

export async function handleCostCommand(input: SessionSlashCommandInput): Promise<void> {
  const result = runCostAction({
    channelId: input.channelId,
    getChannelCostTotal: input.getChannelCostTotal,
    getChannelTurnCount: input.getChannelTurnCount,
  });
  await input.interaction.reply(result.message);
}
