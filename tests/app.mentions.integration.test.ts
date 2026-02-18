import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Client } from "discord.js";
import { startApp } from "../src/app";
import type { AppConfig } from "../src/config";
import { openDatabase } from "../src/db/schema";

describe("startApp mentions slash command", () => {
  test("supports set/show/clear mention policy per channel", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "app-mentions-"));
    const dbPath = path.join(root, "state.sqlite");
    let capturedSlashHandler: ((interaction: unknown) => Promise<void>) | undefined;
    let openedDb: { close: () => void } | undefined;

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

      const replies: Array<{ content?: string; flags?: number }> = [];
      const makeInteraction = (subcommand: "set" | "show" | "clear") => ({
        commandName: "mentions",
        channelId: "channel-1",
        guildId: "guild-1",
        options: {
          getSubcommand: () => subcommand,
          getString: (name: string) => {
            if (subcommand === "set" && name === "mode") {
              return "required";
            }
            return null;
          },
        },
        reply: async (payload: string | { content?: string; flags?: number }) => {
          if (typeof payload === "string") {
            replies.push({ content: payload });
            return;
          }
          replies.push(payload);
        },
      });

      await capturedSlashHandler(makeInteraction("set"));
      await capturedSlashHandler(makeInteraction("show"));
      await capturedSlashHandler(makeInteraction("clear"));
      await capturedSlashHandler(makeInteraction("show"));

      expect(replies[0]?.content).toContain("set to `required`");
      expect(replies[1]?.content).toContain("Mentions mode: `required`");
      expect(replies[2]?.content).toContain("override cleared");
      expect(replies[3]?.content).toContain("Mentions mode: `default`");
    } finally {
      openedDb?.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
