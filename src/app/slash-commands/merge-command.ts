import { existsSync } from "node:fs";
import { MessageFlags, type ChatInputCommandInteraction } from "discord.js";
import type { ClaudeRunner } from "../../claude/runner";
import type { SessionManager } from "../../claude/session";
import type { Repository } from "../../db/repository";
import { parseThreadBranchMeta } from "../../discord/thread-branch";
import type { saveThreadBranchMeta } from "../thread-lifecycle";

type RunCommand = (
  command: string[],
  cwd: string,
) => Promise<{ exitCode: number; output: string }>;

type AheadBehind = {
  ahead: number;
  behind: number;
};

export async function handleMergeCommand(input: {
  interaction: ChatInputCommandInteraction;
  channelId: string;
  guildId: string;
  sessions: SessionManager;
  repository: Repository;
  runner: ClaudeRunner;
  chunkDiscordText: (text: string) => string[];
  runCommand: RunCommand;
  detectBranchName: (workingDir: string) => Promise<string | null>;
  parseAheadBehind: (output: string) => AheadBehind | null;
  summarizeGitMergeOutput: (output: string) => string;
  buildMergeSummaryPrompt: (focus?: string | null) => string;
  normalizeMergeSummary: (summary: string, maxChars: number) => string;
  buildMergeReportLines: (value: {
    fromChannelId: string;
    fromChannelName: string;
    summary: string;
  }) => string;
  canSendMessage: (channel: unknown) => boolean;
  saveThreadBranchMeta: typeof saveThreadBranchMeta;
}): Promise<void> {
  const mergeMeta = parseThreadBranchMeta(input.repository.getThreadBranchMeta(input.channelId));

  if (mergeMeta?.parentChannelId) {
    const mergeState = input.sessions.getState(input.channelId, input.guildId);
    const forkSessionId = mergeState.channel.sessionId;

    if (!forkSessionId) {
      await input.interaction.reply({
        content: "No active session in this fork yet — send at least one message first before merging.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await input.interaction.deferReply();

    try {
      const summaryResult = await input.runner.run({
        channelId: input.channelId,
        prompt: input.buildMergeSummaryPrompt(input.interaction.options.getString("focus")),
        cwd: mergeState.channel.workingDir,
        sessionId: forkSessionId,
        model: mergeState.channel.model,
      });

      const summaryForContext = input.normalizeMergeSummary(summaryResult.text, 1000);
      const summaryForReport = input.normalizeMergeSummary(summaryForContext, 700);

      input.repository.setMergeContext(mergeMeta.parentChannelId, {
        fromChannelId: input.channelId,
        fromChannelName: mergeMeta.name,
        summary: summaryForContext,
        mergedAt: Date.now(),
      });

      const mergeReport = input.buildMergeReportLines({
        fromChannelId: input.channelId,
        fromChannelName: mergeMeta.name,
        summary: summaryForReport,
      });
      const parentChannel = await input.interaction.client.channels
        .fetch(mergeMeta.parentChannelId)
        .catch(() => null);
      if (parentChannel && input.canSendMessage(parentChannel)) {
        const reportChunks = input.chunkDiscordText(mergeReport);
        for (const chunk of reportChunks) {
          if (chunk) {
            await (parentChannel as { send: (content: string) => Promise<unknown> }).send(chunk);
          }
        }
      }

      const forkChannel = input.interaction.channel;
      if (
        forkChannel &&
        typeof (forkChannel as { setArchived?: unknown }).setArchived === "function"
      ) {
        await (forkChannel as { setArchived: (v: boolean) => Promise<unknown> }).setArchived(true);
      }

      input.saveThreadBranchMeta(input.repository, {
        ...mergeMeta,
        lifecycleState: "archived",
        archivedAt: Date.now(),
      });

      await input.interaction.editReply(
        `✅ Merged into <#${mergeMeta.parentChannelId}>. Fork thread archived.`,
      );
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      await input.interaction.editReply(`❌ Merge failed: ${detail}`);
    }
    return;
  }

  const mergeState = input.sessions.getState(input.channelId, input.guildId);
  const targetBranch = input.interaction.options.getString("branch");
  await input.interaction.deferReply();

  const allMetas = input.repository
    .listThreadBranchMetaEntries()
    .map((entry) => parseThreadBranchMeta(entry.value))
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null);

  const rootWorkingDir = mergeState.channel.workingDir;
  const baseBranch = (await input.detectBranchName(rootWorkingDir)) ?? "main";

  if (targetBranch) {
    const result = await input.runCommand(["git", "merge", targetBranch, "--no-edit"], rootWorkingDir);
    const mergeSummary = input.summarizeGitMergeOutput(result.output);
    if (result.exitCode === 0) {
      await input.interaction.editReply(
        `✅ Merged \`${targetBranch}\` into \`${baseBranch}\`.\n${mergeSummary}`,
      );
      return;
    }
    await input.interaction.editReply(
      `❌ Merge failed for \`${targetBranch}\` into \`${baseBranch}\`.\n${mergeSummary}`,
    );
    return;
  }

  const activeForMerge = allMetas
    .filter(
      (meta) =>
        meta.rootChannelId === input.channelId &&
        meta.worktreePath &&
        existsSync(meta.worktreePath) &&
        (meta.lifecycleState === "active" || typeof meta.lifecycleState === "undefined"),
    )
    .sort((a, b) => a.createdAt - b.createdAt);

  if (activeForMerge.length === 0) {
    await input.interaction.editReply(
      "No thread worktrees found. Use `/fork` + `/worktree thread` to create one.",
    );
    return;
  }

  const mergeLines = [`**Worktrees** (base: \`${baseBranch}\`):`];
  for (const meta of activeForMerge) {
    const branchName = meta.worktreePath
      ? ((await input.detectBranchName(meta.worktreePath)) ?? "unknown")
      : "inherited";
    let divergencePart = "";
    if (meta.worktreePath) {
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
    }
    mergeLines.push(`- **${meta.name}** \`${branchName}\`${divergencePart}`);
  }
  mergeLines.push("\nTo git merge: `/merge branch:<branch-name>`");

  const mergeChunks = input.chunkDiscordText(mergeLines.join("\n"));
  await input.interaction.editReply(mergeChunks[0] ?? "No worktrees.");
  for (let i = 1; i < mergeChunks.length; i += 1) {
    const chunk = mergeChunks[i];
    if (chunk) {
      await input.interaction.followUp(chunk);
    }
  }
}
