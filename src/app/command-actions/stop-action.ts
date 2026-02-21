export function runStopAction(input: {
  channelId: string;
  isActive: (channelId: string) => boolean;
  abort: (channelId: string) => boolean;
  abortPending?: (channelId: string) => boolean;
}): { message: string } {
  const wasActive = input.isActive(input.channelId);
  const aborted = input.abort(input.channelId);
  const abortedPending = input.abortPending?.(input.channelId) ?? false;
  return {
    message:
      wasActive || aborted
        ? "🛑 Abort signal sent. The active run will stop."
        : abortedPending
          ? "🛑 Abort signal sent. Pending run cancelled for this channel."
          : "No active run to stop in this channel.",
  };
}
