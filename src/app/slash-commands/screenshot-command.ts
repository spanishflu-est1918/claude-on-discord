import { type ChatInputCommandInteraction } from "discord.js";
import { clipOutput } from "../diff-worktree";
import { cleanupFiles } from "../file-artifacts";
import type { SessionManager } from "../../claude/session";

export async function handleScreenshotCommand(input: {
  interaction: ChatInputCommandInteraction;
  channelId: string;
  guildId: string;
  sessions: SessionManager;
  captureScreenshotWithAgentBrowser: (value: {
    channelId: string;
    workingDir: string;
    url: string;
    fullPage: boolean;
  }) => Promise<{ screenshotPath?: string; output: string; exitCode: number }>;
}): Promise<void> {
  const state = input.sessions.getState(input.channelId, input.guildId);
  const url = input.interaction.options.getString("url")?.trim() || "http://localhost:3000";
  const fullPage = input.interaction.options.getBoolean("full") ?? false;
  await input.interaction.deferReply();

  const result = await input.captureScreenshotWithAgentBrowser({
    channelId: input.channelId,
    workingDir: state.channel.workingDir,
    url,
    fullPage,
  });

  if (!result.screenshotPath) {
    const diagnostics = result.output.trim() || "(no output)";
    await input.interaction.editReply(
      `screenshot failed (exit=${result.exitCode}).\n` +
        "Make sure `agent-browser` is installed and the target URL is reachable.\n" +
        `\`\`\`bash\n${clipOutput(diagnostics, 1800)}\n\`\`\``,
    );
    return;
  }

  try {
    await input.interaction.editReply({
      content: `Screenshot captured from \`${url}\`${fullPage ? " (full page)" : ""}.`,
      files: [{ attachment: result.screenshotPath }],
    });
  } finally {
    await cleanupFiles([result.screenshotPath]);
  }
}
