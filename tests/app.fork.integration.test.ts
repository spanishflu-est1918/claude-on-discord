import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Client } from "discord.js";
import { startApp } from "../src/app";
import type { AppConfig } from "../src/config";
import { openDatabase } from "../src/db/schema";

describe("startApp fork slash command", () => {
  test("creates a thread with optional title and default fallback", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "app-fork-"));
    const dbPath = path.join(root, "state.sqlite");
    let capturedSlashHandler: ((interaction: unknown) => Promise<void>) | undefined;
    let openedDb: { close: () => void } | undefined;

    const threadCreateCalls: Array<{ name: string; reason?: string }> = [];
    const replies: Array<{ content?: string; flags?: number }> = [];

    try {
      const config: AppConfig = {
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

      await startApp(config, {
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

      const makeInteraction = (title: string | null, channelName: string) => ({
        commandName: "fork",
        channelId: "channel-1",
        guildId: "guild-1",
        channel: {
          name: channelName,
          isThread: () => false,
          threads: {
            create: async (options: { name: string; reason?: string }) => {
              threadCreateCalls.push(options);
              return { id: `thread-${threadCreateCalls.length}` };
            },
          },
        },
        options: {
          getString: (name: string) => (name === "title" ? title : null),
        },
        reply: async (payload: string | { content?: string; flags?: number }) => {
          if (typeof payload === "string") {
            replies.push({ content: payload });
            return;
          }
          replies.push(payload);
        },
      });

      await capturedSlashHandler(makeInteraction("  PR Review Lane  ", "backend"));
      await capturedSlashHandler(makeInteraction(null, "backend"));

      expect(threadCreateCalls).toEqual([
        { name: "PR Review Lane", reason: "Fork created via /fork" },
        { name: "backend-fork", reason: "Fork created via /fork" },
      ]);
      expect(replies[0]?.content).toContain("Forked into thread <#thread-1>");
      expect(replies[0]?.content).toContain("`PR Review Lane`");
      expect(replies[1]?.content).toContain("Forked into thread <#thread-2>");
      expect(replies[1]?.content).toContain("`backend-fork`");
    } finally {
      openedDb?.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("stores parent session as fork source without eager bootstrap run", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "app-fork-session-"));
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
    let runCalls = 0;

    try {
      const config: AppConfig = {
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

      await startApp(config, {
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
            run: async () => {
              runCalls += 1;
              return {
                text: "ok",
                sessionId: "thread-session-1",
                messages: [],
              };
            },
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
          channel_id: "channel-1",
          guild_id: "guild-1",
          working_dir: root,
          session_id: "parent-session-1",
          model: "sonnet",
        });

      const replies: Array<{ content?: string; flags?: number }> = [];
      await capturedSlashHandler({
        commandName: "fork",
        channelId: "channel-1",
        guildId: "guild-1",
        channel: {
          name: "backend",
          isThread: () => false,
          threads: {
            create: async (options: { name: string; reason?: string }) => ({
              id: "thread-1",
              parentId: "channel-1",
              name: options.name,
              isThread: () => true,
              send: async () => {},
            }),
          },
        },
        options: {
          getString: (name: string) => (name === "title" ? "session-lane" : null),
        },
        reply: async (payload: string | { content?: string; flags?: number }) => {
          if (typeof payload === "string") {
            replies.push({ content: payload });
            return;
          }
          replies.push(payload);
        },
      });

      const waitUntil = Date.now() + 1000;
      let row: {
        session_id: string | null;
      } | null = null;
      let threadMetaRaw: string | null = null;
      while (Date.now() < waitUntil) {
        row =
          openedDb
            ?.query<{ session_id: string | null }>(
              "SELECT session_id FROM channels WHERE channel_id = $channel_id;",
            )
            .get({ channel_id: "thread-1" }) ?? null;
        threadMetaRaw =
          openedDb
            ?.query<{ value: string | null }>(
              "SELECT value FROM settings WHERE key = $key;",
            )
            .get({ key: "channel_thread_branch:thread-1" })?.value ?? null;
        if (row && threadMetaRaw) {
          break;
        }
        await Bun.sleep(10);
      }
      const threadMeta = threadMetaRaw ? (JSON.parse(threadMetaRaw) as Record<string, unknown>) : null;
      expect(runCalls).toBe(0);
      expect(row?.session_id).toBeNull();
      expect(threadMeta?.forkSourceSessionId).toBe("parent-session-1");
      expect(replies[0]?.content).toContain("Forked into thread <#thread-1>");
    } finally {
      openedDb?.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
