import { existsSync } from "node:fs";
import path from "node:path";
import { MessageFlags, type ButtonInteraction } from "discord.js";
import type { Repository } from "../../db/repository";
import { runHook } from "../../discord/hook-runner";
import { parseThreadBranchMeta } from "../../discord/thread-branch";
import { resolveThreadParentWorkingDir, saveThreadBranchMeta } from "../thread-lifecycle";

export async function handleMergeCleanupButton(input: {
  interaction: ButtonInteraction;
  parsed: { action: "remove" | "keep"; channelId: string };
  repository: Repository;
  runCommand: (command: string[], cwd: string) => Promise<{ exitCode: number; output: string }>;
  detectBranchName: (workingDir: string) => Promise<string | null>;
}): Promise<boolean> {
  const channelId = input.parsed.channelId;
  const meta = parseThreadBranchMeta(input.repository.getThreadBranchMeta(channelId));

  if (!meta) {
    await input.interaction.reply({
      content: "Merge cleanup request expired.",
      flags: MessageFlags.Ephemeral,
    });
    return true;
  }

  if (input.parsed.action === "keep") {
    await input.interaction.update({
      content: `⚙️ Keeping worktree for \`${meta.name}\`. Thread stays active.`,
      components: [],
    });
    return true;
  }

  // "remove" — clean up worktree + branch + archive thread
  const worktreePath = meta.worktreePath;
  if (!worktreePath || !existsSync(worktreePath)) {
    // Already gone — just archive and update metadata
    const { worktreePath: _removed, ...rest } = meta;
    saveThreadBranchMeta(input.repository, {
      ...rest,
      lifecycleState: "archived",
      archivedAt: Date.now(),
      cleanupState: "removed",
    });
    await archiveChannel(input.interaction);
    await input.interaction.update({
      content: "Worktree already removed. Thread archived.",
      components: [],
    });
    return true;
  }

  const fallbackWorkingDir = path.dirname(worktreePath);
  const parentWorkingDir = resolveThreadParentWorkingDir(
    input.repository,
    meta,
    fallbackWorkingDir,
  );

  // Grab branch name before we remove the worktree
  const forkBranch = await input.detectBranchName(worktreePath);

  const removeResult = await input.runCommand(
    ["git", "worktree", "remove", worktreePath, "--force"],
    parentWorkingDir,
  );
  if (removeResult.exitCode !== 0) {
    await input.interaction.update({
      content:
        `❌ Failed to remove worktree \`${worktreePath}\`.\n` +
        `\`\`\`\n${removeResult.output || "(no output)"}\n\`\`\``,
      components: [],
    });
    return true;
  }

  await input.runCommand(["git", "worktree", "prune"], parentWorkingDir);

  let branchNote = "";
  if (forkBranch) {
    const branchResult = await input.runCommand(
      ["git", "branch", "-d", forkBranch],
      parentWorkingDir,
    );
    branchNote =
      branchResult.exitCode === 0 ? ` Branch \`${forkBranch}\` deleted.` : "";
  }

  const { worktreePath: _removed, ...rest } = meta;
  saveThreadBranchMeta(input.repository, {
    ...rest,
    lifecycleState: "archived",
    archivedAt: Date.now(),
    cleanupState: "removed",
  });
  try {
    await runHook({
      hookName: "worktree_removed",
      workingDir: parentWorkingDir,
      env: {
        COD_THREAD_ID: channelId,
        COD_THREAD_SLUG: meta.name,
        COD_WORKTREE_PATH: worktreePath,
        ...(forkBranch ? { COD_BRANCH_NAME: forkBranch } : {}),
      },
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.warn(`worktree_removed hook failed for ${channelId}: ${detail}`);
  }

  await archiveChannel(input.interaction);
  await input.interaction.update({
    content: `🗑️ Worktree removed.${branchNote} Thread archived.`,
    components: [],
  });
  return true;
}

async function archiveChannel(interaction: ButtonInteraction): Promise<void> {
  const ch = interaction.channel;
  if (ch && typeof (ch as { setArchived?: unknown }).setArchived === "function") {
    await (ch as { setArchived: (v: boolean) => Promise<unknown> }).setArchived(true).catch(
      () => undefined,
    );
  }
}
