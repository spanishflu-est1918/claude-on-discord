import { MessageFlags } from "discord.js";
import { runMentionsAction } from "../command-actions/mentions-action";
import type { SessionSlashCommandInput } from "./context";

export async function handleMentionsCommand(input: SessionSlashCommandInput): Promise<void> {
  const action = input.interaction.options.getSubcommand(true);
  const result = runMentionsAction({
    channelId: input.channelId,
    action:
      action === "set"
        ? { type: "set", mode: input.interaction.options.getString("mode", true) }
        : action === "show"
          ? { type: "show" }
          : { type: "clear" },
    defaultRequireMention: input.defaultRequireMention,
    setChannelMentionsMode: input.setChannelMentionsMode,
    clearChannelMentionsMode: input.clearChannelMentionsMode,
    resolveMentionRequirementForChannel: input.resolveMentionRequirementForChannel,
  });

  if (!result.ok) {
    await input.interaction.reply({
      content: result.message,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (result.shouldReplyEphemeral) {
    await input.interaction.reply({
      content: result.message,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await input.interaction.reply(result.message);
}
