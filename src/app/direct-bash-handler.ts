import { chunkDiscordText } from "../discord/chunker";

export async function handleDirectBashMessage(input: {
  directBash: string;
  workingDir: string;
  runBashCommand: (command: string, cwd: string) => Promise<{ exitCode: number; output: string }>;
  queueChannelMessage: (payload: string) => Promise<unknown>;
  queueChannelSend: (payload: string) => Promise<unknown | null>;
}): Promise<boolean> {
  if (input.directBash.trim().length === 0) {
    await input.queueChannelMessage(
      "Direct shell mode expects a command after `!` (example: `!git status`).",
    );
    return true;
  }

  const result = await input.runBashCommand(input.directBash, input.workingDir);
  const outputText = result.output || "(no output)";
  const payload =
    `\`\`\`bash\n$ ${input.directBash}\n${outputText}\n` + `[exit ${result.exitCode}]\n\`\`\``;
  const chunks = chunkDiscordText(payload);
  const firstChunk = chunks[0] ?? "(no output)";
  await input.queueChannelMessage(firstChunk);
  for (let i = 1; i < chunks.length; i++) {
    const chunk = chunks[i];
    if (chunk) {
      await input.queueChannelSend(chunk);
    }
  }
  return true;
}
