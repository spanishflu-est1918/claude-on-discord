import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Client } from "discord.js";
import { startApp } from "../src/app";
import type { AppConfig } from "../src/config";
import { openDatabase } from "../src/db/schema";

describe("startApp mode slash command", () => {
  test("supports set/show/clear permission mode per session", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "app-permission-"));
    const dbPath = path.join(root, "state.sqlite");
    let capturedSlashHandler: ((interaction: unknown) => Promise<void>) | undefined;
    let capturedUserMessageHandler: ((message: unknown) => Promise<void>) | undefined;
    let openedDb: { close: () => void } | undefined;
    let nextSessionIndex = 1;

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
          capturedUserMessageHandler = options.onUserMessage as (message: unknown) => Promise<void>;
          return {
            destroy: () => {},
            channels: { fetch: async () => null },
          } as unknown as Client;
        },
        createRunner: () =>
          ({
            run: async () => ({
              text: "OK",
              messages: [],
              sessionId: `session-${nextSessionIndex++}`,
            }),
          }) as never,
        installSignalHandlers: false,
      });

      if (
        typeof capturedSlashHandler !== "function" ||
        typeof capturedUserMessageHandler !== "function"
      ) {
        throw new Error("handlers were not captured");
      }

      const replies: Array<{ content?: string; flags?: number }> = [];
      const makeInteraction = (subcommand: "set" | "show" | "clear") => ({
        commandName: "mode",
        channelId: "channel-1",
        guildId: "guild-1",
        options: {
          getSubcommand: () => subcommand,
          getString: (name: string) => {
            if (subcommand === "set" && name === "mode") {
              return "plan";
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

      const makeUserMessage = (content: string) => ({
        content,
        guildId: "guild-1",
        author: { id: "user-1" },
        attachments: { size: 0 },
        reactions: { cache: new Map() },
        client: { user: { id: "bot-1" } },
        react: async () => {},
        channel: {
          id: "channel-1",
          isThread: () => false,
          parentId: null,
          send: async () => ({
            edit: async () => {},
          }),
        },
        reply: async () => ({
          edit: async () => {},
        }),
      });

      await capturedSlashHandler(makeInteraction("set"));
      expect(replies[0]?.content).toContain("No active session");

      await capturedUserMessageHandler(makeUserMessage("hello"));
      await capturedSlashHandler(makeInteraction("set"));
      await capturedSlashHandler(makeInteraction("show"));
      await capturedSlashHandler({
        commandName: "new",
        channelId: "channel-1",
        guildId: "guild-1",
        reply: async (payload: string | { content?: string; flags?: number }) => {
          if (typeof payload === "string") {
            replies.push({ content: payload });
            return;
          }
          replies.push(payload);
        },
      });
      await capturedUserMessageHandler(makeUserMessage("hello again"));
      await capturedSlashHandler(makeInteraction("show"));
      await capturedSlashHandler(makeInteraction("clear"));

      expect(replies[1]?.content).toContain("session `session-1` set to `plan`");
      expect(replies[2]?.content).toContain("Permission mode: `plan`");
      expect(replies[2]?.content).toContain("Effective mode: `plan`");
      expect(replies[3]?.content).toContain("Session reset");
      expect(replies[4]?.content).toContain("Permission mode: `default`");
      expect(replies[4]?.content).toContain("Effective mode: `bypassPermissions`");
      expect(replies[5]?.content).toContain("override cleared for `session-2`");
    } finally {
      openedDb?.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
