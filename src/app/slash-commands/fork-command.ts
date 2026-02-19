import { MessageFlags, type ChatInputCommandInteraction } from "discord.js";
import type { SessionManager } from "../../claude/session";
import type { Repository } from "../../db/repository";
import { runForkAction } from "../command-actions/fork-action";

type RunCommand = (
  command: string[],
  cwd: string,
) => Promise<{ exitCode: number; output: string }>;

export async function handleForkCommand(input: {
  interaction: ChatInputCommandInteraction;
  channelId: string;
  guildId: string;
  sessions: SessionManager;
  repository: Repository;
  autoThreadWorktree: boolean;
  worktreeBootstrap: boolean;
  worktreeBootstrapCommand?: string;
  runCommand: RunCommand;
}): Promise<void> {
  const result = await runForkAction({
    channel: input.interaction.channel,
    channelId: input.channelId,
    guildId: input.guildId,
    requestedTitle: input.interaction.options.getString("title"),
    sessions: input.sessions,
    repository: input.repository,
    autoThreadWorktree: input.autoThreadWorktree,
    worktreeBootstrap: input.worktreeBootstrap,
    worktreeBootstrapCommand: input.worktreeBootstrapCommand,
    runCommand: input.runCommand,
    fetchParentChannel: (channelId: string) =>
      input.interaction.client.channels.fetch(channelId),
  });

  if (!result.ok) {
    await input.interaction.reply({
      content: result.message,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await input.interaction.reply(`Forked into thread <#${result.threadId}> (\`${result.title}\`).`);
  if (result.bootstrapWarning) {
    console.warn(`Fork thread bootstrap failed for ${result.threadId}: ${result.bootstrapWarning}`);
  }
}
