import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ButtonInteraction } from "discord.js";
import { Repository } from "../src/db/repository";
import { openDatabase } from "../src/db/schema";
import { handleMergeCleanupButton } from "../src/app/custom-buttons/merge-cleanup-button";
import { parseThreadBranchMeta } from "../src/discord/thread-branch";

async function runCommand(command: string[], cwd: string): Promise<{ exitCode: number; output: string }> {
  const process = Bun.spawn({
    cmd: command,
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  const output = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n");
  return { exitCode, output };
}

async function runCommandStrict(command: string[], cwd: string): Promise<string> {
  const result = await runCommand(command, cwd);
  if (result.exitCode !== 0) {
    throw new Error(`Command failed (${command.join(" ")}):\n${result.output}`);
  }
  return result.output;
}

describe("merge cleanup button handler", () => {
  test("keep action keeps thread active and does not archive", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "merge-cleanup-keep-"));
    const dbPath = path.join(root, "state.sqlite");
    const database = openDatabase(dbPath);
    const repository = new Repository(database);
    let archived = false;
    let updatedContent = "";

    try {
      repository.setThreadBranchMeta(
        "thread-keep",
        JSON.stringify({
          channelId: "thread-keep",
          guildId: "guild-1",
          rootChannelId: "parent-1",
          parentChannelId: "parent-1",
          name: "thread-keep",
          createdAt: Date.now(),
          worktreePath: "/tmp/nonexistent-worktree",
          worktreeMode: "worktree",
          lifecycleState: "active",
          cleanupState: "none",
        }),
      );

      const interaction = {
        channel: {
          setArchived: async (_value: boolean) => {
            archived = true;
          },
        },
        reply: async () => undefined,
        update: async (payload: { content?: string; components?: unknown[] }) => {
          updatedContent = payload.content ?? "";
        },
      } as unknown as ButtonInteraction;

      const handled = await handleMergeCleanupButton({
        interaction,
        parsed: { action: "keep", channelId: "thread-keep" },
        repository,
        runCommand,
        detectBranchName: async () => null,
      });

      expect(handled).toBeTrue();
      expect(archived).toBeFalse();
      expect(updatedContent).toContain("Keeping worktree");
    } finally {
      database.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("remove action removes worktree/branch, emits hook, and archives thread", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "merge-cleanup-remove-"));
    const mainRepoDir = path.join(root, "main-repo");
    const worktreeDir = path.join(root, "fork-worktree");
    const dbPath = path.join(root, "state.sqlite");
    const hookLogPath = path.join(mainRepoDir, ".hook-log");
    const database = openDatabase(dbPath);
    const repository = new Repository(database);
    let archived = false;
    let updatedContent = "";

    try {
      await mkdir(mainRepoDir, { recursive: true });
      await writeFile(path.join(mainRepoDir, "file.txt"), "base content\n", "utf-8");
      await runCommandStrict(["git", "init"], mainRepoDir);
      await runCommandStrict(["git", "config", "user.email", "test@test.com"], mainRepoDir);
      await runCommandStrict(["git", "config", "user.name", "Test"], mainRepoDir);
      await runCommandStrict(["git", "add", "file.txt"], mainRepoDir);
      await runCommandStrict(["git", "commit", "-m", "initial"], mainRepoDir);
      await runCommandStrict(["git", "worktree", "add", worktreeDir, "-b", "fork-branch"], mainRepoDir);

      const hooksDir = path.join(mainRepoDir, ".claude-hooks");
      await mkdir(hooksDir, { recursive: true });
      await writeFile(
        path.join(hooksDir, "worktree_removed"),
        `#!/bin/sh
echo "$COD_THREAD_ID|$COD_BRANCH_NAME|$COD_WORKTREE_PATH" >> "$COD_PROJECT_PATH/.hook-log"
`,
        "utf-8",
      );

      repository.upsertChannel({
        channelId: "parent-1",
        guildId: "guild-1",
        workingDir: mainRepoDir,
        sessionId: "parent-session",
      });
      repository.setThreadBranchMeta(
        "thread-remove",
        JSON.stringify({
          channelId: "thread-remove",
          guildId: "guild-1",
          rootChannelId: "parent-1",
          parentChannelId: "parent-1",
          name: "thread-remove",
          createdAt: Date.now(),
          worktreePath: worktreeDir,
          worktreeMode: "worktree",
          lifecycleState: "active",
          cleanupState: "none",
        }),
      );

      const interaction = {
        channel: {
          setArchived: async (_value: boolean) => {
            archived = true;
          },
        },
        reply: async () => undefined,
        update: async (payload: { content?: string; components?: unknown[] }) => {
          updatedContent = payload.content ?? "";
        },
      } as unknown as ButtonInteraction;

      const handled = await handleMergeCleanupButton({
        interaction,
        parsed: { action: "remove", channelId: "thread-remove" },
        repository,
        runCommand,
        detectBranchName: async (workingDir) => {
          const result = await runCommand(["git", "rev-parse", "--abbrev-ref", "HEAD"], workingDir);
          return result.exitCode === 0 ? result.output.trim() : null;
        },
      });

      expect(handled).toBeTrue();
      expect(archived).toBeTrue();
      expect(updatedContent).toContain("Worktree removed");
      expect(updatedContent).toContain("Thread archived");

      const worktreeExists = await Bun.file(worktreeDir).exists();
      expect(worktreeExists).toBeFalse();

      const branchList = await runCommandStrict(["git", "branch", "--list", "fork-branch"], mainRepoDir);
      expect(branchList.trim()).toBe("");

      const hookLog = await readFile(hookLogPath, "utf-8");
      expect(hookLog).toContain("thread-remove|fork-branch|");
      expect(hookLog).toContain(worktreeDir);

      const updatedMeta = parseThreadBranchMeta(repository.getThreadBranchMeta("thread-remove"));
      expect(updatedMeta).toBeTruthy();
      expect(updatedMeta?.lifecycleState).toBe("archived");
      expect(updatedMeta?.cleanupState).toBe("removed");
      expect(updatedMeta?.worktreePath).toBeUndefined();
    } finally {
      database.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
