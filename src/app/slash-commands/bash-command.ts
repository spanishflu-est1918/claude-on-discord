import { type ChatInputCommandInteraction } from "discord.js";
import type { SessionManager } from "../../claude/session";

export async function handleBashCommand(input: {
  interaction: ChatInputCommandInteraction;
  channelId: string;
  guildId: string;
  sessions: SessionManager;
  runBashCommand: (command: string, cwd: string) => Promise<{ exitCode: number; output: string }>;
  chunkDiscordText: (text: string) => string[];
}): Promise<void> {
  const command = input.interaction.options.getString("command", true);
  const state = input.sessions.getState(input.channelId, input.guildId);
  await input.interaction.deferReply();

  const result = await input.runBashCommand(command, state.channel.workingDir);
  const outputText = result.output || "(no output)";
  const payload = `\`\`\`bash\n$ ${command}\n${outputText}\n[exit ${result.exitCode}]\n\`\`\``;
  const chunks = input.chunkDiscordText(payload);
  const firstChunk = chunks[0] ?? "(no output)";
  await input.interaction.editReply(firstChunk);

  for (let i = 1; i < chunks.length; i++) {
    const chunk = chunks[i];
    if (chunk) {
      await input.interaction.followUp(chunk);
    }
  }
}
