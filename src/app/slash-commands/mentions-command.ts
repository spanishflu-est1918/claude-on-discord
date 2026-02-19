import { MessageFlags } from "discord.js";
import type { SessionSlashCommandInput } from "./context";

export async function handleMentionsCommand(input: SessionSlashCommandInput): Promise<void> {
  const action = input.interaction.options.getSubcommand(true);

  if (action === "set") {
    const modeRaw = input.interaction.options.getString("mode", true).trim().toLowerCase();
    if (modeRaw !== "default" && modeRaw !== "required" && modeRaw !== "off") {
      await input.interaction.reply({
        content: "Invalid mode. Use one of: `default`, `required`, `off`.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    input.setChannelMentionsMode(input.channelId, modeRaw);
    const effective = input.resolveMentionRequirementForChannel(input.channelId);
    await input.interaction.reply(
      `Mentions mode for this channel set to \`${modeRaw}\` (effective: \`${effective.requireMention ? "required" : "off"}\`).`,
    );
    return;
  }

  if (action === "show") {
    const effective = input.resolveMentionRequirementForChannel(input.channelId);
    const globalDefault = input.defaultRequireMention ? "required" : "off";
    await input.interaction.reply({
      content:
        `Mentions mode: \`${effective.mode}\`\n` +
        `Effective policy: \`${effective.requireMention ? "required" : "off"}\`\n` +
        `Global default: \`${globalDefault}\``,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  input.clearChannelMentionsMode(input.channelId);
  const effective = input.resolveMentionRequirementForChannel(input.channelId);
  await input.interaction.reply(
    `Mentions mode override cleared (effective: \`${effective.requireMention ? "required" : "off"}\`).`,
  );
}
