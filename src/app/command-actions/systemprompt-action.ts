export type SystemPromptAction =
  | { type: "set"; text: string }
  | { type: "show" }
  | { type: "clear" };

export type SystemPromptActionResult =
  | { ok: false; message: string }
  | {
      ok: true;
      message: string;
      showPrompt?: { text: string };
      resetSession?: boolean;
      clearSessionPermissionOverride?: boolean;
    };

export function runSystemPromptAction(input: {
  channelId: string;
  action: SystemPromptAction;
  setChannelSystemPrompt: (channelId: string, text: string) => void;
  getChannelSystemPrompt: (channelId: string) => string | null;
  clearChannelSystemPrompt: (channelId: string) => void;
}): SystemPromptActionResult {
  if (input.action.type === "set") {
    const text = input.action.text.trim();
    if (!text) {
      return {
        ok: false,
        message: "System prompt cannot be empty.",
      };
    }
    input.setChannelSystemPrompt(input.channelId, text);
    return {
      ok: true,
      message: `Channel system prompt set (\`${text.length}\` chars). Session restarted for this channel.`,
      resetSession: true,
      clearSessionPermissionOverride: true,
    };
  }

  if (input.action.type === "show") {
    const text = input.getChannelSystemPrompt(input.channelId);
    if (!text) {
      return {
        ok: false,
        message: "No channel system prompt is set.",
      };
    }
    return {
      ok: true,
      message: "Channel system prompt loaded.",
      showPrompt: { text },
    };
  }

  input.clearChannelSystemPrompt(input.channelId);
  return {
    ok: true,
    message: "Channel system prompt cleared. Session restarted for this channel.",
    resetSession: true,
    clearSessionPermissionOverride: true,
  };
}
