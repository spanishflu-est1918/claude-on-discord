import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
});
