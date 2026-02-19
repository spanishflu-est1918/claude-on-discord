import { existsSync } from "node:fs";
import path from "node:path";
import { MessageFlags, type ButtonInteraction } from "discord.js";
import type { Repository } from "../../db/repository";
import { buildThreadCleanupButtons } from "../../discord/buttons";
import { parseThreadBranchMeta } from "../../discord/thread-branch";
import {
  resolveThreadParentWorkingDir,
  saveThreadBranchMeta,
} from "../thread-lifecycle";

export async function handleThreadCleanupButton(input: {
  interaction: ButtonInteraction;
  parsed: { action: "remove" | "keep"; channelId: string };
  repository: Repository;
  runCommand: (command: string[], cwd: string) => Promise<{ exitCode: number; output: string }>;
}): Promise<boolean> {
  const channelId = input.parsed.channelId;
  const meta = parseThreadBranchMeta(input.repository.getThreadBranchMeta(channelId));
  if (!meta) {
    await input.interaction.reply({
      content: "Thread cleanup request expired.",
      flags: MessageFlags.Ephemeral,
    });
    return true;
  }

  const worktreePath = meta.worktreePath;
  if (!worktreePath) {
    saveThreadBranchMeta(input.repository, {
      ...meta,
      cleanupState: "removed",
    });
    await input.interaction.update({
      content: `No dedicated worktree remains for thread \`${meta.name}\`.`,
      components: [],
    });
    return true;
  }

  if (input.parsed.action === "keep") {
    saveThreadBranchMeta(input.repository, {
      ...meta,
      cleanupState: "kept",
    });
    await input.interaction.update({
      content: `Keeping worktree \`${worktreePath}\` for thread \`${meta.name}\`.`,
      components: [],
    });
    return true;
  }

  if (!existsSync(worktreePath)) {
    const { worktreePath: _removedPath, ...rest } = meta;
    saveThreadBranchMeta(input.repository, {
      ...rest,
      worktreeMode: "inherited",
      cleanupState: "removed",
    });
    await input.interaction.update({
      content: `Worktree already removed: \`${worktreePath}\`.`,
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
  const removeResult = await input.runCommand(
    ["git", "worktree", "remove", worktreePath],
    parentWorkingDir,
  );
  if (removeResult.exitCode !== 0) {
    await input.interaction.update({
      content:
        `Failed to remove worktree \`${worktreePath}\`.\n` +
        `\`\`\`bash\n${removeResult.output || "(no output)"}\n\`\`\``,
      components: buildThreadCleanupButtons(channelId),
    });
    return true;
  }

  const pruneResult = await input.runCommand(["git", "worktree", "prune"], parentWorkingDir);
  const { worktreePath: _removedPath, ...rest } = meta;
  saveThreadBranchMeta(input.repository, {
    ...rest,
    worktreeMode: "inherited",
    cleanupState: "removed",
  });

  const pruneSummary =
    pruneResult.exitCode === 0
      ? "git worktree prune complete."
      : `git worktree prune exit=${pruneResult.exitCode}: ${pruneResult.output || "(no output)"}`;
  await input.interaction.update({
    content: `Removed thread worktree \`${worktreePath}\`.\n${pruneSummary}`,
    components: [],
  });
  return true;
}
