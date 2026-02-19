export function runCostAction(input: {
  channelId: string;
  getChannelCostTotal: (channelId: string) => number;
  getChannelTurnCount: (channelId: string) => number;
}): { message: string } {
  const totalCost = input.getChannelCostTotal(input.channelId);
  const totalTurns = input.getChannelTurnCount(input.channelId);
  return {
    message: `Channel spend: \`$${totalCost.toFixed(4)}\` across \`${totalTurns}\` turns.`,
  };
}
