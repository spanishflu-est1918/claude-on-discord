import { MessageFlags } from "discord.js";
import type { SessionSlashCommandInput } from "./context";

export async function handleSystemPromptCommand(input: SessionSlashCommandInput): Promise<void> {
  const action = input.interaction.options.getSubcommand(true);

  if (action === "set") {
    const text = input.interaction.options.getString("text", true).trim();
    if (!text) {
      await input.interaction.reply({
        content: "System prompt cannot be empty.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    input.setChannelSystemPrompt(input.channelId, text);
    input.resetSessionId(input.channelId);
    input.clearSessionPermissionMode(input.channelId);
    await input.interaction.reply(
      `Channel system prompt set (\`${text.length}\` chars). Session restarted for this channel.`,
    );
    return;
  }

  if (action === "show") {
    const text = input.getChannelSystemPrompt(input.channelId);
    if (!text) {
      await input.interaction.reply({
        content: "No channel system prompt is set.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const content = `Channel system prompt (\`${text.length}\` chars):\n\`\`\`\n${text}\n\`\`\``;
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
    return;
  }

  input.clearChannelSystemPrompt(input.channelId);
  input.resetSessionId(input.channelId);
  input.clearSessionPermissionMode(input.channelId);
  await input.interaction.reply("Channel system prompt cleared. Session restarted for this channel.");
}
