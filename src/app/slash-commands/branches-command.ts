import { existsSync } from "node:fs";
import { type ChatInputCommandInteraction } from "discord.js";
import type { SessionManager } from "../../claude/session";
import type { Repository } from "../../db/repository";
import { parseThreadBranchMeta } from "../../discord/thread-branch";

export async function handleBranchesCommand(input: {
  interaction: ChatInputCommandInteraction;
  channelId: string;
  guildId: string;
  sessions: SessionManager;
  repository: Repository;
  detectBranchName: (workingDir: string) => Promise<string | null>;
  runCommand: (command: string[], cwd: string) => Promise<{ exitCode: number; output: string }>;
  parseAheadBehind: (output: string) => { ahead: number; behind: number } | null;
  chunkDiscordText: (text: string) => string[];
}): Promise<void> {
  const state = input.sessions.getState(input.channelId, input.guildId);
  const metas = input.repository
    .listThreadBranchMetaEntries()
    .map((entry) => parseThreadBranchMeta(entry.value))
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null);

  const currentMeta = metas.find((meta) => meta.channelId === input.channelId);
  const rootChannelId = currentMeta?.rootChannelId ?? input.channelId;
  const rootChannel = input.repository.getChannel(rootChannelId);
  const rootWorkingDir = rootChannel?.workingDir ?? state.channel.workingDir;
  const baseBranch = (await input.detectBranchName(rootWorkingDir)) ?? "main";

  const activeBranches = metas
    .filter(
      (meta) =>
        meta.rootChannelId === rootChannelId &&
        (meta.lifecycleState === "active" || typeof meta.lifecycleState === "undefined"),
    )
    .sort((a, b) => a.createdAt - b.createdAt);

  if (activeBranches.length === 0) {
    await input.interaction.reply(`No active thread branches tracked for root \`${rootChannelId}\`.`);
    return;
  }

  const lines = [`**Branches** (base: \`${baseBranch}\`):`];

  for (const meta of activeBranches) {
    let branchPart = "inherited";
    let divergencePart = "";
    let worktreePart = "inherited";
    if (meta.worktreePath && existsSync(meta.worktreePath)) {
      worktreePart = meta.worktreePath;
      const branchName = await input.detectBranchName(meta.worktreePath);
      if (branchName) {
        branchPart = `\`${branchName}\``;
      }
      const revList = await input.runCommand(
        ["git", "rev-list", "--left-right", "--count", `${baseBranch}...HEAD`],
        meta.worktreePath,
      );
      if (revList.exitCode === 0) {
        const counts = input.parseAheadBehind(revList.output);
        if (counts) {
          divergencePart = ` ↑${counts.ahead} ↓${counts.behind}`;
        }
      }
    } else if (meta.worktreeMode === "prompt") {
      worktreePart = "pending";
    }

    lines.push(`- **${meta.name}** ${branchPart}${divergencePart} @ \`${worktreePart}\``);
  }

  const chunks = input.chunkDiscordText(lines.join("\n"));
  await input.interaction.reply(chunks[0] ?? "No active thread branches.");
  for (let i = 1; i < chunks.length; i++) {
    const chunk = chunks[i];
    if (chunk) {
      await input.interaction.followUp(chunk);
    }
  }
}
