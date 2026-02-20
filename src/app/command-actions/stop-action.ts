export function runStopAction(input: {
  channelId: string;
  isActive: (channelId: string) => boolean;
  abort: (channelId: string) => void;
}): { message: string } {
  const wasActive = input.isActive(input.channelId);
  input.abort(input.channelId);
  return {
    message: wasActive
      ? "🛑 Abort signal sent. The active run will stop."
      : "No active run to stop in this channel.",
  };
}
