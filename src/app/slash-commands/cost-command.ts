import type { SessionSlashCommandInput } from "./context";

export async function handleCostCommand(input: SessionSlashCommandInput): Promise<void> {
  const totalCost = input.getChannelCostTotal(input.channelId);
  const totalTurns = input.getChannelTurnCount(input.channelId);
  await input.interaction.reply(
    `Channel spend: \`$${totalCost.toFixed(4)}\` across \`${totalTurns}\` turns.`,
  );
}
