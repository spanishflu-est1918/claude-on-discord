export const MENTION_MODES = ["default", "required", "off"] as const;
export type MentionMode = (typeof MENTION_MODES)[number];
export type MentionsAction = { type: "set"; mode: string } | { type: "show" } | { type: "clear" };

export type MentionsActionResult =
  | { ok: false; message: string }
  | {
      ok: true;
      message: string;
      effectiveRequireMention: boolean;
      effectiveMode: string;
      globalDefault: "required" | "off";
      shouldReplyEphemeral: boolean;
    };

export function runMentionsAction(input: {
  channelId: string;
  action: MentionsAction;
  defaultRequireMention: boolean;
  setChannelMentionsMode: (channelId: string, mode: MentionMode) => void;
  clearChannelMentionsMode: (channelId: string) => void;
  resolveMentionRequirementForChannel: (channelId: string) => {
    requireMention: boolean;
    mode: string;
  };
}): MentionsActionResult {
  const globalDefault = input.defaultRequireMention ? "required" : "off";

  if (input.action.type === "set") {
    const modeRaw = input.action.mode.trim().toLowerCase();
    if (!MENTION_MODES.includes(modeRaw as MentionMode)) {
      return {
        ok: false,
        message: "Invalid mode. Use one of: `default`, `required`, `off`.",
      };
    }
    input.setChannelMentionsMode(input.channelId, modeRaw as MentionMode);
    const effective = input.resolveMentionRequirementForChannel(input.channelId);
    return {
      ok: true,
      message:
        `Mentions mode for this channel set to \`${modeRaw}\` ` +
        `(effective: \`${effective.requireMention ? "required" : "off"}\`).`,
      effectiveRequireMention: effective.requireMention,
      effectiveMode: effective.mode,
      globalDefault,
      shouldReplyEphemeral: false,
    };
  }

  if (input.action.type === "show") {
    const effective = input.resolveMentionRequirementForChannel(input.channelId);
    return {
      ok: true,
      message:
        `Mentions mode: \`${effective.mode}\`\n` +
        `Effective policy: \`${effective.requireMention ? "required" : "off"}\`\n` +
        `Global default: \`${globalDefault}\``,
      effectiveRequireMention: effective.requireMention,
      effectiveMode: effective.mode,
      globalDefault,
      shouldReplyEphemeral: true,
    };
  }

  input.clearChannelMentionsMode(input.channelId);
  const effective = input.resolveMentionRequirementForChannel(input.channelId);
  return {
    ok: true,
    message: `Mentions mode override cleared (effective: \`${effective.requireMention ? "required" : "off"}\`).`,
    effectiveRequireMention: effective.requireMention,
    effectiveMode: effective.mode,
    globalDefault,
    shouldReplyEphemeral: false,
  };
}
