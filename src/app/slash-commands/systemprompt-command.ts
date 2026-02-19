import { MessageFlags } from "discord.js";
import { runSystemPromptAction } from "../command-actions/systemprompt-action";
import type { SessionSlashCommandInput } from "./context";

export async function handleSystemPromptCommand(input: SessionSlashCommandInput): Promise<void> {
  const action = input.interaction.options.getSubcommand(true);
  const result = runSystemPromptAction({
    channelId: input.channelId,
    action:
      action === "set"
        ? { type: "set", text: input.interaction.options.getString("text", true) }
        : action === "show"
          ? { type: "show" }
          : { type: "clear" },
    setChannelSystemPrompt: input.setChannelSystemPrompt,
    getChannelSystemPrompt: input.getChannelSystemPrompt,
    clearChannelSystemPrompt: input.clearChannelSystemPrompt,
  });

  if (!result.ok) {
    await input.interaction.reply({
      content: result.message,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (result.resetSession) {
    input.resetSessionId(input.channelId);
  }
  if (result.clearSessionPermissionOverride) {
    input.clearSessionPermissionMode(input.channelId);
  }

  if (!result.showPrompt) {
    await input.interaction.reply(result.message);
    return;
  }

  const content = `Channel system prompt (\`${result.showPrompt.text.length}\` chars):\n\`\`\`\n${result.showPrompt.text}\n\`\`\``;
  const chunks = input.chunkDiscordText(content);
  await input.interaction.reply({
    content: chunks[0] ?? "No channel system prompt is set.",
    flags: MessageFlags.Ephemeral,
  });
  for (let index = 1; index < chunks.length; index += 1) {
    const chunk = chunks[index];
    if (chunk) {
      await input.interaction.followUp({
        content: chunk,
        flags: MessageFlags.Ephemeral,
      });
    }
  }
}
