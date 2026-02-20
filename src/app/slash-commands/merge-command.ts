import { existsSync } from "node:fs";
import { MessageFlags, type ChatInputCommandInteraction } from "discord.js";
import type { ClaudeRunner } from "../../claude/runner";
import type { SessionManager } from "../../claude/session";
import type { Repository } from "../../db/repository";
import { buildMergeCleanupButtons } from "../../discord/buttons";
import { runHook } from "../../discord/hook-runner";
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

function resolveAutoCommitMessage(raw: string): string {
  const firstNonEmptyLine = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  return firstNonEmptyLine ?? "chore: auto-commit before merge";
}

function formatHookFailureMessage(value: { hookName: string; detail: string }): string {
  return `❌ Merge aborted: failed to run \`${value.hookName}\` hook (${value.detail}).`;
}

async function runPreMergeHook(input: {
  workingDir: string;
  channelId: string;
  branchName: string;
}): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    const preMerge = await runHook({
      hookName: "pre_merge",
      workingDir: input.workingDir,
      env: {
        COD_THREAD_ID: input.channelId,
        COD_BRANCH_NAME: input.branchName,
      },
    });
    if (preMerge.ran && preMerge.exitCode !== 0) {
      const detail = preMerge.output ? `\n\`\`\`\n${preMerge.output}\n\`\`\`` : "";
      return {
        ok: false,
        message: `❌ Merge aborted: \`pre_merge\` hook exited ${preMerge.exitCode}.${detail}`,
      };
    }
    return { ok: true };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false, message: formatHookFailureMessage({ hookName: "pre_merge", detail }) };
  }
}

async function runPostMergeHook(input: {
  workingDir: string;
  channelId: string;
  branchName: string;
}): Promise<string | null> {
  try {
    const postMerge = await runHook({
      hookName: "post_merge",
      workingDir: input.workingDir,
      env: {
        COD_THREAD_ID: input.channelId,
        COD_BRANCH_NAME: input.branchName,
      },
    });
    if (postMerge.ran && postMerge.exitCode !== 0) {
      return `⚠️ \`post_merge\` hook exited ${postMerge.exitCode}.`;
    }
    return null;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return `⚠️ \`post_merge\` hook failed: ${detail}`;
  }
}

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
  buildMergeSummaryPrompt: (focus?: string | null) => string;
  normalizeMergeSummary: (summary: string, maxChars: number) => string;
  summarizeGitMergeOutput: (output: string) => string;
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
      const forkWorkingDir = mergeState.channel.workingDir;
      const parentState = input.sessions.getState(mergeMeta.parentChannelId, input.guildId);
      let parentWorkingDir = parentState.channel.workingDir || forkWorkingDir;
      const hasWorktree =
        Boolean(mergeMeta.worktreePath) ||
        mergeMeta.worktreeMode === "worktree" ||
        parentWorkingDir !== forkWorkingDir;

      let baseBranch = "main";
      let forkBranch: string | null = null;
      let postMergeWarning: string | null = null;

      if (hasWorktree) {
        baseBranch = (await input.detectBranchName(parentWorkingDir)) ?? "main";
        forkBranch = await input.detectBranchName(forkWorkingDir);

        // Phase 1: Auto-commit — commit any dirty state with an AI-generated message
        const statusResult = await input.runCommand(["git", "status", "--porcelain"], forkWorkingDir);
        if (statusResult.exitCode === 0 && statusResult.output.trim()) {
          await input.interaction.editReply("⏳ Auto-committing uncommitted changes...");
          const commitMsgResult = await input.runner.run({
            channelId: input.channelId,
            prompt: "Generate a short git commit message (imperative mood, under 72 chars, no period at end) summarizing the uncommitted changes in this worktree. Output only the commit message line, nothing else.",
            cwd: forkWorkingDir,
            sessionId: forkSessionId,
            model: mergeState.channel.model,
            maxTurns: 1,
          });
          const commitMsg = resolveAutoCommitMessage(commitMsgResult.text);
          const addResult = await input.runCommand(["git", "add", "-A"], forkWorkingDir);
          if (addResult.exitCode !== 0) {
            await input.interaction.editReply(
              `❌ Failed to stage changes before merge.\n\`\`\`\n${addResult.output || "(no output)"}\n\`\`\``,
            );
            return;
          }
          const commitResult = await input.runCommand(
            ["git", "commit", "-m", commitMsg],
            forkWorkingDir,
          );
          if (commitResult.exitCode !== 0) {
            await input.interaction.editReply(
              `❌ Failed to auto-commit changes before merge.\n\`\`\`\n${commitResult.output || "(no output)"}\n\`\`\``,
            );
            return;
          }
        }

        // Phase 2: Merge main → worktree (resolve conflicts here, not on main)
        await input.interaction.editReply(
          `⏳ Merging \`${baseBranch}\` → worktree to check for conflicts...`,
        );
        const mainIntoFork = await input.runCommand(
          ["git", "merge", baseBranch, "--no-edit"],
          forkWorkingDir,
        );
        if (mainIntoFork.exitCode !== 0) {
          const conflictResult = await input.runCommand(
            ["git", "diff", "--name-only", "--diff-filter=U"],
            forkWorkingDir,
          );
          await input.runCommand(["git", "merge", "--abort"], forkWorkingDir);
          const conflictFiles = conflictResult.output.trim() || "unknown files";
          await input.interaction.editReply(
            [
              `⚠️ Conflict when merging \`${baseBranch}\` into your worktree.`,
              `Resolve these files and run \`/merge\` again:`,
              "```",
              conflictFiles,
              "```",
            ].join("\n"),
          );
          return;
        }

        // Phase 3: Merge worktree → main
        if (!forkBranch) {
          await input.interaction.editReply("❌ Could not detect fork branch name.");
          return;
        }
        const preMerge = await runPreMergeHook({
          workingDir: parentWorkingDir,
          channelId: input.channelId,
          branchName: forkBranch,
        });
        if (!preMerge.ok) {
          await input.interaction.editReply(preMerge.message);
          return;
        }
        await input.interaction.editReply(
          `⏳ Merging \`${forkBranch}\` → \`${baseBranch}\`...`,
        );
        const forkIntoMain = await input.runCommand(
          ["git", "merge", forkBranch, "--no-edit"],
          parentWorkingDir,
        );
        if (forkIntoMain.exitCode !== 0) {
          const summary = input.summarizeGitMergeOutput(forkIntoMain.output);
          await input.interaction.editReply(
            `❌ Failed to merge into \`${baseBranch}\`:\n${summary}`,
          );
          return;
        }
        postMergeWarning = await runPostMergeHook({
          workingDir: parentWorkingDir,
          channelId: input.channelId,
          branchName: forkBranch,
        });
      }

      // Generate semantic handoff summary
      await input.interaction.editReply("⏳ Generating handoff summary...");
      const summaryResult = await input.runner.run({
        channelId: input.channelId,
        prompt: input.buildMergeSummaryPrompt(input.interaction.options.getString("focus")),
        cwd: forkWorkingDir,
        sessionId: forkSessionId,
        model: mergeState.channel.model,
        maxTurns: 1,
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

      if (!hasWorktree) {
        // No worktree — semantic merge only, archive immediately
        const forkChannel = input.interaction.channel;
        if (
          forkChannel &&
          typeof (forkChannel as { setArchived?: unknown }).setArchived === "function"
        ) {
          await (forkChannel as { setArchived: (v: boolean) => Promise<unknown> }).setArchived(
            true,
          );
        }
        input.saveThreadBranchMeta(input.repository, {
          ...mergeMeta,
          lifecycleState: "archived",
          archivedAt: Date.now(),
          cleanupState: "none",
        });
        await input.interaction.editReply(
          [
            `✅ Merged into <#${mergeMeta.parentChannelId}>. Fork thread archived.`,
            ...(postMergeWarning ? [postMergeWarning] : []),
          ].join("\n"),
        );
      } else {
        // Worktree merge — prompt user to clean up or keep going
        const gitNote = forkBranch ? ` \`${forkBranch}\` → \`${baseBranch}\`.` : "";
        await input.interaction.editReply(
          [
            `✅ Merged into <#${mergeMeta.parentChannelId}>.${gitNote}`,
            ...(postMergeWarning ? [postMergeWarning] : []),
          ].join("\n"),
        );
        await input.interaction.followUp({
          content: "Remove the worktree and branch, or keep going?",
          components: buildMergeCleanupButtons(input.channelId),
        });
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      await input.interaction.editReply(`❌ Merge failed: ${detail}`);
    }
    return;
  }

  // Parent channel path: optionally git-merge a branch, or list active thread worktrees
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
    const preMerge = await runPreMergeHook({
      workingDir: rootWorkingDir,
      channelId: input.channelId,
      branchName: targetBranch,
    });
    if (!preMerge.ok) {
      await input.interaction.editReply(preMerge.message);
      return;
    }
    const result = await input.runCommand(
      ["git", "merge", targetBranch, "--no-edit"],
      rootWorkingDir,
    );
    const mergeSummary = input.summarizeGitMergeOutput(result.output);
    if (result.exitCode === 0) {
      const postMergeWarning = await runPostMergeHook({
        workingDir: rootWorkingDir,
        channelId: input.channelId,
        branchName: targetBranch,
      });
      await input.interaction.editReply(
        [`✅ Merged \`${targetBranch}\` into \`${baseBranch}\`.`, mergeSummary, postMergeWarning]
          .filter(Boolean)
          .join("\n"),
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
