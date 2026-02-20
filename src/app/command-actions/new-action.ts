export function runNewSessionAction(input: {
  channelId: string;
  clearSessionPermissionMode: (channelId: string) => void;
  resetSession: (channelId: string) => void;
}): { message: string } {
  input.clearSessionPermissionMode(input.channelId);
  input.resetSession(input.channelId);
  return { message: "Session reset for this channel." };
}
