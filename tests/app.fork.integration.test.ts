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
});
