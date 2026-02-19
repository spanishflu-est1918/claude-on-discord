import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Client } from "discord.js";
import { startApp } from "../src/app";
import type { AppConfig } from "../src/config";
import { openDatabase } from "../src/db/schema";

describe("startApp kill slash command", () => {
  test("archives thread and clamps renamed thread title to Discord limit", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "app-kill-"));
    const dbPath = path.join(root, "state.sqlite");
    let capturedSlashHandler: ((interaction: unknown) => Promise<void>) | undefined;
    let openedDb: { close: () => void } | undefined;
    let editedThreadName = "";
    let archived = false;
    let replyText = "";

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

      await capturedSlashHandler({
        commandName: "kill",
        channelId: "thread-1",
        guildId: "guild-1",
        channel: {
          isThread: () => true,
          name: "a".repeat(100),
          archived: false,
          edit: async (input: { name: string; archived: boolean }) => {
            editedThreadName = input.name;
            archived = input.archived;
          },
        },
        deferReply: async () => {},
        editReply: async (payload: string) => {
          replyText = payload;
        },
        reply: async () => {},
      });

      expect(archived).toBeTrue();
      expect(editedThreadName.startsWith("🔴")).toBeTrue();
      expect(editedThreadName.length).toBeLessThanOrEqual(100);
      expect(replyText).toContain("Killed and archived");
    } finally {
      openedDb?.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
