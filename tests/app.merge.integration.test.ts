import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Client } from "discord.js";
import { startApp } from "../src/app";
import type { AppConfig } from "../src/config";
import { openDatabase } from "../src/db/schema";

async function runCommand(cmd: string[], cwd: string): Promise<string> {
  const process = Bun.spawn({
    cmd,
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
  if (exitCode !== 0) {
    throw new Error(`Command failed (${cmd.join(" ")}):\n${output}`);
  }
  return output;
}

function createConfig(root: string, dbPath: string): AppConfig {
  return {
    discordToken: "unused-token",
    discordClientId: "unused-client",
    discordGuildId: "unused-guild",
    defaultWorkingDir: root,
    databasePath: dbPath,
    defaultModel: "sonnet",
    autoThreadWorktree: false,
    requireMentionInMultiUserChannels: false,
    worktreeBootstrap: true,
    claudePermissionMode: "bypassPermissions",
  };
}

describe("startApp merge slash command", () => {
  test("fork merge stores concise parent context and archives the fork", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "app-merge-fork-"));
    const dbPath = path.join(root, "state.sqlite");
    let capturedSlashHandler: ((interaction: unknown) => Promise<void>) | undefined;
    let openedDb:
      | {
          close: () => void;
          query: <T>(sql: string) => {
            get: (params: Record<string, string>) => T | null;
            run: (params: Record<string, string>) => unknown;
          };
        }
      | undefined;
    let archived = false;
    let mergeReply = "";
    const parentMessages: string[] = [];

    try {
      await startApp(createConfig(root, dbPath), {
        openDatabase: (databasePath) => {
          const db = openDatabase(databasePath);
          openedDb = db as unknown as {
            close: () => void;
            query: <T>(sql: string) => {
              get: (params: Record<string, string>) => T | null;
              run: (params: Record<string, string>) => unknown;
            };
          };
          return db;
        },
        registerSlashCommands: async () => {},
        startDiscordClient: async (options) => {
          capturedSlashHandler = options.onSlashCommand as (interaction: unknown) => Promise<void>;
          return {
            destroy: () => {},
            channels: { fetch: async () => null },
          } as unknown as Client;
        },
        createRunner: () =>
          ({
            run: async () => ({
              text: `- Decision: keep architecture stable.\n${"Very long detail. ".repeat(240)}`,
              messages: [],
            }),
          }) as never,
        installSignalHandlers: false,
      });

      if (typeof capturedSlashHandler !== "function") {
        throw new Error("slash handler was not captured");
      }

      openedDb
        ?.query(
          `
            INSERT INTO channels (channel_id, guild_id, working_dir, session_id, model)
            VALUES ($channel_id, $guild_id, $working_dir, $session_id, $model);
          `,
        )
        .run({
          channel_id: "thread-1",
          guild_id: "guild-1",
          working_dir: root,
          session_id: "fork-session-1",
          model: "sonnet",
        });

      openedDb?.query("INSERT INTO settings (key, value) VALUES ($key, $value);").run({
        key: "channel_thread_branch:thread-1",
        value: JSON.stringify({
          channelId: "thread-1",
          guildId: "guild-1",
          rootChannelId: "parent-1",
          parentChannelId: "parent-1",
          name: "thread-1",
          createdAt: Date.now(),
          lifecycleState: "active",
          cleanupState: "none",
        }),
      });

      const parentChannel = {
        send: async (payload: unknown) => {
          if (typeof payload === "string") {
            parentMessages.push(payload);
          }
        },
      };

      await capturedSlashHandler({
        commandName: "merge",
        channelId: "thread-1",
        guildId: "guild-1",
        channel: {
          isThread: () => true,
          parentId: "parent-1",
          name: "thread-1",
          setArchived: async () => {
            archived = true;
          },
        },
        client: {
          channels: {
            fetch: async () => parentChannel,
          },
        },
        options: {
          getString: (name: string) => (name === "focus" ? "decisions made" : null),
        },
        deferReply: async () => {},
        editReply: async (payload: string) => {
          mergeReply = payload;
        },
        followUp: async () => {},
        reply: async () => {},
      });

      const mergeContextRaw =
        openedDb
          ?.query<{ value: string | null }>("SELECT value FROM settings WHERE key = $key;")
          .get({ key: "channel_merge_context:parent-1" })?.value ?? null;
      const mergeContext = mergeContextRaw
        ? (JSON.parse(mergeContextRaw) as { summary: string })
        : null;

      expect(archived).toBeTrue();
      expect(mergeReply).toContain("Merged into <#parent-1>");
      expect(mergeContext?.summary.length ?? 0).toBeLessThanOrEqual(1000);
      expect(parentMessages.length).toBeGreaterThan(0);
      expect(parentMessages.join("\n").length).toBeLessThan(2000);
    } finally {
      openedDb?.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("fork merge with worktree: auto-commits dirty state, merges all 4 phases, cleans up", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "app-merge-wt-happy-"));
    const mainRepoDir = path.join(root, "main-repo");
    const worktreeDir = path.join(root, "fork-worktree");
    const dbPath = path.join(root, "state.sqlite");
    let capturedSlashHandler: ((interaction: unknown) => Promise<void>) | undefined;
    let openedDb:
      | {
          close: () => void;
          query: <T>(sql: string) => {
            get: (params: Record<string, string>) => T | null;
            run: (params: Record<string, string>) => unknown;
          };
        }
      | undefined;
    let mergeReply = "";
    let archived = false;
    const runnerCallPrompts: string[] = [];
    const parentMessages: string[] = [];

    try {
      // Set up main git repo
      await mkdir(mainRepoDir, { recursive: true });
      await writeFile(path.join(mainRepoDir, "file.txt"), "base content\n");
      await runCommand(["git", "init"], mainRepoDir);
      await runCommand(["git", "config", "user.email", "test@test.com"], mainRepoDir);
      await runCommand(["git", "config", "user.name", "Test"], mainRepoDir);
      await runCommand(["git", "add", "file.txt"], mainRepoDir);
      await runCommand(["git", "commit", "-m", "initial"], mainRepoDir);

      // Create worktree on a fork branch
      await runCommand(["git", "worktree", "add", worktreeDir, "-b", "fork-branch"], mainRepoDir);

      // Make the worktree dirty (uncommitted new file)
      await writeFile(path.join(worktreeDir, "new-feature.ts"), "export const x = 1;\n");

      await startApp(createConfig(mainRepoDir, dbPath), {
        openDatabase: (databasePath) => {
          const db = openDatabase(databasePath);
          openedDb = db as unknown as typeof openedDb;
          return db;
        },
        registerSlashCommands: async () => {},
        startDiscordClient: async (options) => {
          capturedSlashHandler = options.onSlashCommand as (interaction: unknown) => Promise<void>;
          return {
            destroy: () => {},
            channels: { fetch: async () => null },
          } as unknown as Client;
        },
        createRunner: () =>
          ({
            run: async ({ prompt }: { prompt: string }) => {
              runnerCallPrompts.push(prompt);
              // First call: auto-commit message. Second call: handoff summary.
              return { text: "feat: add new feature implementation", messages: [] };
            },
          }) as never,
        installSignalHandlers: false,
      });

      if (typeof capturedSlashHandler !== "function") {
        throw new Error("slash handler was not captured");
      }

      // Insert parent channel state (main repo)
      openedDb
        ?.query(
          `INSERT INTO channels (channel_id, guild_id, working_dir, session_id, model)
           VALUES ($channel_id, $guild_id, $working_dir, $session_id, $model);`,
        )
        .run({
          channel_id: "parent-wt",
          guild_id: "guild-1",
          working_dir: mainRepoDir,
          session_id: "parent-session",
          model: "sonnet",
        });

      // Insert fork channel state (worktree)
      openedDb
        ?.query(
          `INSERT INTO channels (channel_id, guild_id, working_dir, session_id, model)
           VALUES ($channel_id, $guild_id, $working_dir, $session_id, $model);`,
        )
        .run({
          channel_id: "fork-wt",
          guild_id: "guild-1",
          working_dir: worktreeDir,
          session_id: "fork-session-wt",
          model: "sonnet",
        });

      // Insert fork thread branch meta with worktreePath
      openedDb?.query("INSERT INTO settings (key, value) VALUES ($key, $value);").run({
        key: "channel_thread_branch:fork-wt",
        value: JSON.stringify({
          channelId: "fork-wt",
          guildId: "guild-1",
          rootChannelId: "parent-wt",
          parentChannelId: "parent-wt",
          name: "fork-wt",
          createdAt: Date.now(),
          lifecycleState: "active",
          cleanupState: "none",
          worktreePath: worktreeDir,
        }),
      });

      const parentChannel = {
        send: async (payload: unknown) => {
          if (typeof payload === "string") parentMessages.push(payload);
        },
      };

      let followUpPayload: unknown;
      await capturedSlashHandler({
        commandName: "merge",
        channelId: "fork-wt",
        guildId: "guild-1",
        channel: {
          isThread: () => true,
          parentId: "parent-wt",
          name: "fork-wt",
          setArchived: async () => {
            archived = true;
          },
        },
        client: {
          channels: { fetch: async () => parentChannel },
        },
        options: {
          getString: (name: string) => (name === "focus" ? null : null),
        },
        deferReply: async () => {},
        editReply: async (payload: string) => {
          mergeReply = payload;
        },
        followUp: async (payload: unknown) => {
          followUpPayload = payload;
        },
        reply: async () => {},
      });

      // Runner was called at least twice: auto-commit message + handoff summary
      expect(runnerCallPrompts.length).toBeGreaterThanOrEqual(2);

      // fork-branch should be merged into main — auto-committed changes appear in main log
      const mainLog = await runCommand(["git", "log", "--oneline"], mainRepoDir).catch(() => "");
      expect(mainLog).toContain("feat: add new feature");

      // Worktree dir still exists — cleanup is button-driven, not automatic
      expect(existsSync(worktreeDir)).toBeTrue();

      // Thread NOT archived yet — user hasn't clicked "Remove"
      expect(archived).toBeFalse();

      // Success reply has merge info
      expect(mergeReply).toContain("Merged into <#parent-wt>");
      expect(mergeReply).toContain("fork-branch");

      // followUp sent with cleanup buttons
      expect(followUpPayload).toBeTruthy();
      expect((followUpPayload as { content?: string }).content).toContain("worktree");
    } finally {
      openedDb?.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("fork merge with worktree aborts and reports conflicting files when main conflicts", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "app-merge-wt-conflict-"));
    const mainRepoDir = path.join(root, "main-repo");
    const worktreeDir = path.join(root, "fork-worktree");
    const dbPath = path.join(root, "state.sqlite");
    let capturedSlashHandler: ((interaction: unknown) => Promise<void>) | undefined;
    let openedDb: { close: () => void } | undefined;
    let mergeReply = "";

    try {
      // Set up main repo with a shared file
      await mkdir(mainRepoDir, { recursive: true });
      await writeFile(path.join(mainRepoDir, "shared.txt"), "original\n");
      await runCommand(["git", "init"], mainRepoDir);
      await runCommand(["git", "config", "user.email", "test@test.com"], mainRepoDir);
      await runCommand(["git", "config", "user.name", "Test"], mainRepoDir);
      await runCommand(["git", "add", "shared.txt"], mainRepoDir);
      await runCommand(["git", "commit", "-m", "initial"], mainRepoDir);

      // Create fork worktree
      await runCommand(["git", "worktree", "add", worktreeDir, "-b", "fork-branch"], mainRepoDir);

      // Fork edits shared.txt
      await writeFile(path.join(worktreeDir, "shared.txt"), "fork-side\n");
      await runCommand(["git", "add", "shared.txt"], worktreeDir);
      await runCommand(["git", "commit", "-m", "fork change"], worktreeDir);

      // Main also edits shared.txt (diverges from fork point)
      await writeFile(path.join(mainRepoDir, "shared.txt"), "main-side\n");
      await runCommand(["git", "add", "shared.txt"], mainRepoDir);
      await runCommand(["git", "commit", "-m", "main change"], mainRepoDir);

      await startApp(createConfig(mainRepoDir, dbPath), {
        openDatabase: (databasePath) => {
          const db = openDatabase(databasePath);
          openedDb = db;
          return db;
        },
        registerSlashCommands: async () => {},
        startDiscordClient: async (options) => {
          capturedSlashHandler = options.onSlashCommand as (interaction: unknown) => Promise<void>;
          return {
            destroy: () => {},
            channels: { fetch: async () => null },
          } as unknown as Client;
        },
        createRunner: () =>
          ({
            run: async () => ({ text: "auto-commit message", messages: [] }),
          }) as never,
        installSignalHandlers: false,
      });

      if (typeof capturedSlashHandler !== "function") {
        throw new Error("slash handler was not captured");
      }

      const db = openedDb as unknown as {
        query: <T>(sql: string) => {
          get: (params: Record<string, string>) => T | null;
          run: (params: Record<string, string>) => unknown;
        };
      };

      db.query(
        `INSERT INTO channels (channel_id, guild_id, working_dir, session_id, model)
         VALUES ($channel_id, $guild_id, $working_dir, $session_id, $model);`,
      ).run({
        channel_id: "parent-conf",
        guild_id: "guild-1",
        working_dir: mainRepoDir,
        session_id: "parent-session",
        model: "sonnet",
      });

      db.query(
        `INSERT INTO channels (channel_id, guild_id, working_dir, session_id, model)
         VALUES ($channel_id, $guild_id, $working_dir, $session_id, $model);`,
      ).run({
        channel_id: "fork-conf",
        guild_id: "guild-1",
        working_dir: worktreeDir,
        session_id: "fork-session-conf",
        model: "sonnet",
      });

      db.query("INSERT INTO settings (key, value) VALUES ($key, $value);").run({
        key: "channel_thread_branch:fork-conf",
        value: JSON.stringify({
          channelId: "fork-conf",
          guildId: "guild-1",
          rootChannelId: "parent-conf",
          parentChannelId: "parent-conf",
          name: "fork-conf",
          createdAt: Date.now(),
          lifecycleState: "active",
          cleanupState: "none",
          worktreePath: worktreeDir,
        }),
      });

      await capturedSlashHandler({
        commandName: "merge",
        channelId: "fork-conf",
        guildId: "guild-1",
        channel: {
          isThread: () => true,
          parentId: "parent-conf",
          name: "fork-conf",
          setArchived: async () => {},
        },
        client: { channels: { fetch: async () => null } },
        options: { getString: () => null },
        deferReply: async () => {},
        editReply: async (payload: string) => {
          mergeReply = payload;
        },
        followUp: async () => {},
        reply: async () => {},
      });

      // Should report conflict with the file name
      expect(mergeReply).toContain("Conflict");
      expect(mergeReply).toContain("shared.txt");
      expect(mergeReply).toContain("/merge");

      // Worktree should still exist (merge aborted, not cleaned up)
      expect(existsSync(worktreeDir)).toBeTrue();

      // Main repo should NOT be in MERGING state
      const mergeHead = existsSync(path.join(mainRepoDir, ".git", "MERGE_HEAD"));
      expect(mergeHead).toBeFalse();

      // Worktree should NOT be in MERGING state (aborted)
      const worktreeMergeHead = existsSync(
        path.join(mainRepoDir, ".git", "worktrees", "fork-worktree", "MERGE_HEAD"),
      );
      expect(worktreeMergeHead).toBeFalse();
    } finally {
      openedDb?.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("parent merge reports concise git summary instead of raw output block", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "app-merge-parent-"));
    const dbPath = path.join(root, "state.sqlite");
    let capturedSlashHandler: ((interaction: unknown) => Promise<void>) | undefined;
    let openedDb: { close: () => void } | undefined;
    let mergeReply = "";

    try {
      await writeFile(path.join(root, "file.txt"), "base\n", "utf-8");
      await runCommand(["git", "init"], root);
      await runCommand(["git", "config", "user.email", "codex@example.com"], root);
      await runCommand(["git", "config", "user.name", "Codex"], root);
      await runCommand(["git", "add", "file.txt"], root);
      await runCommand(["git", "commit", "-m", "base"], root);
      await runCommand(["git", "checkout", "-b", "feature"], root);
      await writeFile(path.join(root, "file.txt"), "base\nfeature\n", "utf-8");
      await runCommand(["git", "add", "file.txt"], root);
      await runCommand(["git", "commit", "-m", "feature"], root);
      await runCommand(["git", "checkout", "-"], root);

      await startApp(createConfig(root, dbPath), {
        openDatabase: (databasePath) => {
          const db = openDatabase(databasePath);
          openedDb = db;
          return db;
        },
        registerSlashCommands: async () => {},
        startDiscordClient: async (options) => {
          capturedSlashHandler = options.onSlashCommand as (interaction: unknown) => Promise<void>;
          return {
            destroy: () => {},
            channels: { fetch: async () => null },
          } as unknown as Client;
        },
        installSignalHandlers: false,
      });

      if (typeof capturedSlashHandler !== "function") {
        throw new Error("slash handler was not captured");
      }

      await capturedSlashHandler({
        commandName: "merge",
        channelId: "parent-1",
        guildId: "guild-1",
        options: {
          getString: (name: string) => (name === "branch" ? "feature" : null),
        },
        deferReply: async () => {},
        editReply: async (payload: string) => {
          mergeReply = payload;
        },
        followUp: async () => {},
        reply: async () => {},
      });

      expect(mergeReply).toContain("Merged `feature`");
      expect(mergeReply).not.toContain("```");
      expect(mergeReply.length).toBeLessThan(500);
    } finally {
      openedDb?.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("parent merge runs pre_merge and post_merge hooks", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "app-merge-hooks-"));
    const dbPath = path.join(root, "state.sqlite");
    const hooksDir = path.join(root, ".claude-hooks");
    const hookLogPath = path.join(root, ".hook-log");
    let capturedSlashHandler: ((interaction: unknown) => Promise<void>) | undefined;
    let openedDb: { close: () => void } | undefined;
    let mergeReply = "";

    try {
      await writeFile(path.join(root, "file.txt"), "base\n", "utf-8");
      await runCommand(["git", "init"], root);
      await runCommand(["git", "config", "user.email", "codex@example.com"], root);
      await runCommand(["git", "config", "user.name", "Codex"], root);
      await runCommand(["git", "add", "file.txt"], root);
      await runCommand(["git", "commit", "-m", "base"], root);
      await runCommand(["git", "checkout", "-b", "feature"], root);
      await writeFile(path.join(root, "file.txt"), "base\nfeature\n", "utf-8");
      await runCommand(["git", "add", "file.txt"], root);
      await runCommand(["git", "commit", "-m", "feature"], root);
      await runCommand(["git", "checkout", "-"], root);

      await mkdir(hooksDir, { recursive: true });
      await writeFile(
        path.join(hooksDir, "pre_merge"),
        `#!/bin/sh
echo "pre:$COD_BRANCH_NAME" >> "$COD_PROJECT_PATH/.hook-log"
`,
        "utf-8",
      );
      await writeFile(
        path.join(hooksDir, "post_merge"),
        `#!/bin/sh
echo "post:$COD_BRANCH_NAME" >> "$COD_PROJECT_PATH/.hook-log"
`,
        "utf-8",
      );

      await startApp(createConfig(root, dbPath), {
        openDatabase: (databasePath) => {
          const db = openDatabase(databasePath);
          openedDb = db;
          return db;
        },
        registerSlashCommands: async () => {},
        startDiscordClient: async (options) => {
          capturedSlashHandler = options.onSlashCommand as (interaction: unknown) => Promise<void>;
          return {
            destroy: () => {},
            channels: { fetch: async () => null },
          } as unknown as Client;
        },
        installSignalHandlers: false,
      });

      if (typeof capturedSlashHandler !== "function") {
        throw new Error("slash handler was not captured");
      }

      await capturedSlashHandler({
        commandName: "merge",
        channelId: "parent-hooks",
        guildId: "guild-1",
        options: {
          getString: (name: string) => (name === "branch" ? "feature" : null),
        },
        deferReply: async () => {},
        editReply: async (payload: string) => {
          mergeReply = payload;
        },
        followUp: async () => {},
        reply: async () => {},
      });

      const hookLog = await readFile(hookLogPath, "utf-8");
      expect(mergeReply).toContain("Merged `feature`");
      expect(hookLog).toContain("pre:feature");
      expect(hookLog).toContain("post:feature");
    } finally {
      openedDb?.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("parent merge still succeeds when post_merge hook exits non-zero", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "app-merge-post-hook-fail-"));
    const dbPath = path.join(root, "state.sqlite");
    const hooksDir = path.join(root, ".claude-hooks");
    let capturedSlashHandler: ((interaction: unknown) => Promise<void>) | undefined;
    let openedDb: { close: () => void } | undefined;
    let mergeReply = "";

    try {
      await writeFile(path.join(root, "file.txt"), "base\n", "utf-8");
      await runCommand(["git", "init"], root);
      await runCommand(["git", "config", "user.email", "codex@example.com"], root);
      await runCommand(["git", "config", "user.name", "Codex"], root);
      await runCommand(["git", "add", "file.txt"], root);
      await runCommand(["git", "commit", "-m", "base"], root);
      await runCommand(["git", "checkout", "-b", "feature"], root);
      await writeFile(path.join(root, "file.txt"), "base\nfeature\n", "utf-8");
      await runCommand(["git", "add", "file.txt"], root);
      await runCommand(["git", "commit", "-m", "feature"], root);
      await runCommand(["git", "checkout", "-"], root);

      await mkdir(hooksDir, { recursive: true });
      await writeFile(path.join(hooksDir, "pre_merge"), "#!/bin/sh\nexit 0\n", "utf-8");
      await writeFile(path.join(hooksDir, "post_merge"), "#!/bin/sh\nexit 9\n", "utf-8");

      await startApp(createConfig(root, dbPath), {
        openDatabase: (databasePath) => {
          const db = openDatabase(databasePath);
          openedDb = db;
          return db;
        },
        registerSlashCommands: async () => {},
        startDiscordClient: async (options) => {
          capturedSlashHandler = options.onSlashCommand as (interaction: unknown) => Promise<void>;
          return {
            destroy: () => {},
            channels: { fetch: async () => null },
          } as unknown as Client;
        },
        installSignalHandlers: false,
      });

      if (typeof capturedSlashHandler !== "function") {
        throw new Error("slash handler was not captured");
      }

      await capturedSlashHandler({
        commandName: "merge",
        channelId: "parent-post-hook-fail",
        guildId: "guild-1",
        options: {
          getString: (name: string) => (name === "branch" ? "feature" : null),
        },
        deferReply: async () => {},
        editReply: async (payload: string) => {
          mergeReply = payload;
        },
        followUp: async () => {},
        reply: async () => {},
      });

      const mergedFile = await readFile(path.join(root, "file.txt"), "utf-8");
      expect(mergeReply).toContain("Merged `feature`");
      expect(mergeReply).toContain("post_merge");
      expect(mergedFile).toContain("feature");
    } finally {
      openedDb?.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("worktree merge falls back to default auto-commit message when generator is empty", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "app-merge-autocommit-fallback-"));
    const mainRepoDir = path.join(root, "main-repo");
    const worktreeDir = path.join(root, "fork-worktree");
    const dbPath = path.join(root, "state.sqlite");
    let capturedSlashHandler: ((interaction: unknown) => Promise<void>) | undefined;
    let openedDb:
      | {
          close: () => void;
          query: <T>(sql: string) => {
            get: (params: Record<string, string>) => T | null;
            run: (params: Record<string, string>) => unknown;
          };
        }
      | undefined;
    let mergeReply = "";
    let runnerCalls = 0;

    try {
      await mkdir(mainRepoDir, { recursive: true });
      await writeFile(path.join(mainRepoDir, "file.txt"), "base content\n");
      await runCommand(["git", "init"], mainRepoDir);
      await runCommand(["git", "config", "user.email", "test@test.com"], mainRepoDir);
      await runCommand(["git", "config", "user.name", "Test"], mainRepoDir);
      await runCommand(["git", "add", "file.txt"], mainRepoDir);
      await runCommand(["git", "commit", "-m", "initial"], mainRepoDir);
      await runCommand(["git", "worktree", "add", worktreeDir, "-b", "fork-branch"], mainRepoDir);
      await writeFile(path.join(worktreeDir, "new-feature.ts"), "export const y = 2;\n");

      await startApp(createConfig(mainRepoDir, dbPath), {
        openDatabase: (databasePath) => {
          const db = openDatabase(databasePath);
          openedDb = db as unknown as typeof openedDb;
          return db;
        },
        registerSlashCommands: async () => {},
        startDiscordClient: async (options) => {
          capturedSlashHandler = options.onSlashCommand as (interaction: unknown) => Promise<void>;
          return {
            destroy: () => {},
            channels: { fetch: async () => null },
          } as unknown as Client;
        },
        createRunner: () =>
          ({
            run: async () => {
              runnerCalls += 1;
              if (runnerCalls === 1) {
                return { text: "   \n", messages: [] };
              }
              return { text: "- done", messages: [] };
            },
          }) as never,
        installSignalHandlers: false,
      });

      if (typeof capturedSlashHandler !== "function") {
        throw new Error("slash handler was not captured");
      }

      openedDb
        ?.query(
          `INSERT INTO channels (channel_id, guild_id, working_dir, session_id, model)
           VALUES ($channel_id, $guild_id, $working_dir, $session_id, $model);`,
        )
        .run({
          channel_id: "parent-autocommit-fallback",
          guild_id: "guild-1",
          working_dir: mainRepoDir,
          session_id: "parent-session",
          model: "sonnet",
        });

      openedDb
        ?.query(
          `INSERT INTO channels (channel_id, guild_id, working_dir, session_id, model)
           VALUES ($channel_id, $guild_id, $working_dir, $session_id, $model);`,
        )
        .run({
          channel_id: "fork-autocommit-fallback",
          guild_id: "guild-1",
          working_dir: worktreeDir,
          session_id: "fork-session",
          model: "sonnet",
        });

      openedDb?.query("INSERT INTO settings (key, value) VALUES ($key, $value);").run({
        key: "channel_thread_branch:fork-autocommit-fallback",
        value: JSON.stringify({
          channelId: "fork-autocommit-fallback",
          guildId: "guild-1",
          rootChannelId: "parent-autocommit-fallback",
          parentChannelId: "parent-autocommit-fallback",
          name: "fork-autocommit-fallback",
          createdAt: Date.now(),
          lifecycleState: "active",
          cleanupState: "none",
          worktreePath: worktreeDir,
        }),
      });

      await capturedSlashHandler({
        commandName: "merge",
        channelId: "fork-autocommit-fallback",
        guildId: "guild-1",
        channel: {
          isThread: () => true,
          parentId: "parent-autocommit-fallback",
          name: "fork-autocommit-fallback",
          setArchived: async () => {},
        },
        client: { channels: { fetch: async () => null } },
        options: { getString: () => null },
        deferReply: async () => {},
        editReply: async (payload: string) => {
          mergeReply = payload;
        },
        followUp: async () => {},
        reply: async () => {},
      });

      const log = await runCommand(["git", "log", "--oneline", "--all"], mainRepoDir);
      expect(mergeReply).toContain("Merged into <#parent-autocommit-fallback>");
      expect(log).toContain("chore: auto-commit before merge");
    } finally {
      openedDb?.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
