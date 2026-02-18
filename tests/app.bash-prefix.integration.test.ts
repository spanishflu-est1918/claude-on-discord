import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Client } from "discord.js";
import { startApp } from "../src/app";
import type { AppConfig } from "../src/config";
import { openDatabase } from "../src/db/schema";

describe("startApp direct bash prefix", () => {
  test("routes !command to shell without invoking Claude runner", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "app-bash-prefix-"));
    const dbPath = path.join(root, "state.sqlite");
    let capturedUserMessageHandler: ((message: unknown) => Promise<void>) | undefined;
    let openedDb: { close: () => void } | undefined;
    let runnerCalls = 0;

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
          capturedUserMessageHandler = options.onUserMessage as (message: unknown) => Promise<void>;
          return {
            destroy: () => {},
            channels: { fetch: async () => null },
          } as unknown as Client;
        },
        createRunner: () =>
          ({
            run: async () => {
              runnerCalls += 1;
              throw new Error("runner should not be used for !command");
            },
          }) as never,
        installSignalHandlers: false,
      });

      if (typeof capturedUserMessageHandler !== "function") {
        throw new Error("user message handler was not captured");
      }

      const replies: string[] = [];
      const sends: string[] = [];
      await capturedUserMessageHandler({
        content: "!printf 'ok'",
        guildId: "guild-1",
        channel: {
          id: "channel-1",
          send: async (content: string) => {
            sends.push(content);
          },
        },
        reply: async (content: string) => {
          replies.push(content);
        },
      });

      expect(runnerCalls).toBe(0);
      expect(replies).toHaveLength(1);
      expect(replies[0]).toContain("$ printf 'ok'");
      expect(replies[0]).toContain("ok");
      expect(replies[0]).toContain("[exit 0]");
      expect(sends).toHaveLength(0);
    } finally {
      openedDb?.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
