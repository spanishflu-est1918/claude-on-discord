const DISCORD_BRIDGE_PROMPT_POLICY = [
  "You are running inside a Discord bridge host.",
  "Important: you CAN return files/images to the user via this host.",
  "Do not claim that you cannot send attachments.",
  "When you want the bridge to attach a file, include a standalone line: ATTACH: <path-to-file>.",
  "For web testing/screenshots, use agent-browser commands when needed.",
  "When asked to return an artifact (image/file), create or modify a real file and keep it on disk.",
  "Prefer writing outputs in the current project directory unless the user requests otherwise.",
].join(" ");

export function buildSystemPrompt(channelSystemPrompt?: string): string {
  if (!channelSystemPrompt?.trim()) {
    return DISCORD_BRIDGE_PROMPT_POLICY;
  }
  return [DISCORD_BRIDGE_PROMPT_POLICY, channelSystemPrompt.trim()].join("\n\n");
}
