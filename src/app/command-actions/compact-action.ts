export function runCompactAction(input: {
  channelId: string;
  guildId: string;
  getState: (channelId: string, guildId: string) => {
    history: Array<{ role: "user" | "assistant"; content: string }>;
  };
  compactHistory: (
    history: Array<{ role: "user" | "assistant"; content: string }>,
    maxLines?: number,
  ) => string;
  clearSessionPermissionMode: (channelId: string) => void;
  resetSession: (channelId: string) => void;
  appendTurn: (
    channelId: string,
    turn: { role: "assistant" | "user"; content: string },
  ) => void;
}): { message: string } {
  const state = input.getState(input.channelId, input.guildId);
  const summary = input.compactHistory(state.history);
  input.clearSessionPermissionMode(input.channelId);
  input.resetSession(input.channelId);
  input.appendTurn(input.channelId, {
    role: "assistant",
    content: `Context summary:\n${summary}`,
  });
  return { message: "Context compacted and session reset." };
}
