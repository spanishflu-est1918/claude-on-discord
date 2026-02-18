import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Client } from "discord.js";
import { startApp } from "../src/app";
import type { AppConfig } from "../src/config";
import { openDatabase } from "../src/db/schema";

type MockMessage = {
  content: string;
  guildId: string;
  author: { id: string };
  attachments: { size: number };
  reactions: { cache: Map<string, unknown> };
  client: { user: { id: string } };
  react: (emoji: string) => Promise<void>;
  channel: {
    id: string;
    isThread: () => boolean;
    parentId: string | null;
    send: (payload: unknown) => Promise<void>;
  };
  replyCalls: unknown[];
  statusEdits: unknown[];
  reply: (payload: unknown) => Promise<{ edit: (payload: unknown) => Promise<void> }>;
};

function createMockMessage(input: {
  content: string;
  channelId: string;
  guildId: string;
  authorId?: string;
}): MockMessage {
  const replyCalls: unknown[] = [];
  const statusEdits: unknown[] = [];
  return {
    content: input.content,
    guildId: input.guildId,
    author: { id: input.authorId ?? "user-1" },
    attachments: { size: 0 },
    reactions: { cache: new Map() },
    client: { user: { id: "bot-1" } },
    react: async () => {},
    channel: {
      id: input.channelId,
      isThread: () => false,
      parentId: null,
      send: async () => {},
    },
    replyCalls,
    statusEdits,
    reply: async (payload: unknown) => {
      replyCalls.push(payload);
      return {
        edit: async (editPayload: unknown) => {
          statusEdits.push(editPayload);
        },
      };
    },
  };
}

describe("startApp message queue behavior", () => {
  test("serializes concurrent channel messages and queues follow-ups", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "app-queue-"));
    const dbPath = path.join(root, "state.sqlite");
    let capturedUserMessageHandler: ((message: unknown) => Promise<void>) | undefined;
    let openedDb: { close: () => void } | undefined;
    let concurrentRuns = 0;
    let maxConcurrentRuns = 0;
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
              concurrentRuns += 1;
              maxConcurrentRuns = Math.max(maxConcurrentRuns, concurrentRuns);
              await Bun.sleep(40);
              concurrentRuns -= 1;
              return {
                text: `done ${runnerCalls}`,
                messages: [],
              };
            },
          }) as never,
        installSignalHandlers: false,
      });

      if (typeof capturedUserMessageHandler !== "function") {
        throw new Error("user message handler was not captured");
      }

      const first = createMockMessage({
        content: "first",
        channelId: "channel-1",
        guildId: "guild-1",
      });
      const second = createMockMessage({
        content: "second",
        channelId: "channel-1",
        guildId: "guild-1",
      });

      const firstRun = capturedUserMessageHandler(first);
      await Bun.sleep(5);
      const secondRun = capturedUserMessageHandler(second);
      await Promise.all([firstRun, secondRun]);

      expect(runnerCalls).toBe(2);
      expect(maxConcurrentRuns).toBe(1);
      expect(
        second.replyCalls.some(
          (call) =>
            typeof call === "object" &&
            call !== null &&
            "content" in call &&
            typeof call.content === "string" &&
            call.content.includes("Run in progress for this channel. Queued your message.") &&
            "components" in call &&
            Array.isArray(call.components),
        ),
      ).toBeTrue();
    } finally {
      openedDb?.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
