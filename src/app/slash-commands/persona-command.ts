import { MessageFlags } from "discord.js";
import { runSystemPromptAction } from "../command-actions/systemprompt-action";
import type { SessionSlashCommandInput } from "./context";

export async function handlePersonaCommand(input: SessionSlashCommandInput): Promise<void> {
  const action = input.interaction.options.getSubcommand(true);
  const result = runSystemPromptAction({
    channelId: input.channelId,
    action:
      action === "set"
        ? { type: "set", text: input.interaction.options.getString("text", true) }
        : action === "show"
          ? { type: "show" }
          : { type: "clear" },
    // Global: no channelId scoping — get/set/clear operate on the single global key
    setChannelSystemPrompt: (_channelId, text) => input.setGlobalSystemPrompt(text),
    getChannelSystemPrompt: (_channelId) => input.getGlobalSystemPrompt(),
    clearChannelSystemPrompt: (_channelId) => input.clearGlobalSystemPrompt(),
  });

  if (!result.ok) {
    await input.interaction.reply({
      content: result.message,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // Persona changes don't need to reset a specific channel session —
  // the global prompt is picked up on the next run in any channel.
  if (!result.showPrompt) {
    await input.interaction.reply(result.message);
    return;
  }

  const content = `Global persona prompt (\`${result.showPrompt.text.length}\` chars):\n\`\`\`\n${result.showPrompt.text}\n\`\`\``;
  const chunks = input.chunkDiscordText(content);
  await input.interaction.reply({
    content: chunks[0] ?? "No global persona prompt is set.",
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
