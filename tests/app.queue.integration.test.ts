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

  test("keeps queued message when Send Now cannot steer immediately", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "app-queue-steer-"));
    const dbPath = path.join(root, "state.sqlite");
    let capturedUserMessageHandler: ((message: unknown) => Promise<void>) | undefined;
    let capturedButtonHandler: ((interaction: unknown) => Promise<void>) | undefined;
    let openedDb: { close: () => void } | undefined;
    let runnerCalls = 0;
    let releaseFirstRun: (() => void) | undefined;
    const firstRunGate = new Promise<void>((resolve) => {
      releaseFirstRun = resolve;
    });
    let queueNoticePayload: unknown = null;
    const queueNoticeEdits: unknown[] = [];

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
          capturedButtonHandler = options.onButtonInteraction as (
            interaction: unknown,
          ) => Promise<void>;
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
                await firstRunGate;
              }
              return {
                text: `done ${runnerCalls}`,
                messages: [],
              };
            },
            steer: () => false,
          }) as never,
        installSignalHandlers: false,
      });

      if (typeof capturedUserMessageHandler !== "function") {
        throw new Error("user message handler was not captured");
      }
      if (typeof capturedButtonHandler !== "function") {
        throw new Error("button handler was not captured");
      }

      const firstMessage = createMockMessage({
        content: "first",
        channelId: "channel-1",
        guildId: "guild-1",
      });

      let secondReplyCalls = 0;
      const secondMessage = {
        content: "second",
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
          send: async () => {},
        },
        reply: async (payload: unknown) => {
          secondReplyCalls += 1;
          if (secondReplyCalls === 1) {
            queueNoticePayload = payload;
            return {
              id: "notice-1",
              edit: async (next: unknown) => {
                queueNoticeEdits.push(next);
              },
              delete: async () => {},
            };
          }
          return {
            id: "status-2",
            edit: async () => {},
          };
        },
      };

      const firstRun = capturedUserMessageHandler(firstMessage);
      await Bun.sleep(5);
      const secondRun = capturedUserMessageHandler(secondMessage);
      await Bun.sleep(10);

      const payloadWithComponents = queueNoticePayload as {
        components?: Array<{ toJSON?: () => unknown } | unknown>;
      };
      const rowRaw = payloadWithComponents.components?.[0];
      const row =
        rowRaw && typeof rowRaw === "object" && "toJSON" in rowRaw
          ? (rowRaw as { toJSON: () => unknown }).toJSON()
          : rowRaw;
      const steerCustomId = (row as { components?: Array<{ custom_id?: string }> })?.components?.[0]
        ?.custom_id;
      if (!steerCustomId) {
        throw new Error("steer custom id not found on queue notice");
      }

      await capturedButtonHandler({
        customId: steerCustomId,
        channelId: "channel-1",
        user: { id: "user-1" },
        message: {
          id: "notice-1",
          edit: async (payload: unknown) => {
            queueNoticeEdits.push(payload);
          },
          delete: async () => {},
        },
        deferUpdate: async () => {},
        reply: async () => {},
      });

      releaseFirstRun?.();
      await Promise.all([firstRun, secondRun]);

      expect(runnerCalls).toBe(2);
      expect(
        queueNoticeEdits.some(
          (payload) =>
            typeof payload === "object" &&
            payload !== null &&
            "content" in payload &&
            typeof payload.content === "string" &&
            payload.content.includes("Keeping this message queued."),
        ),
      ).toBeTrue();
    } finally {
      openedDb?.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("continues processing when thread status rename hangs", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "app-queue-thread-status-timeout-"));
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
              return {
                text: "done",
                messages: [],
              };
            },
          }) as never,
        installSignalHandlers: false,
      });

      if (typeof capturedUserMessageHandler !== "function") {
        throw new Error("user message handler was not captured");
      }

      const message = {
        content: "hello",
        guildId: "guild-1",
        author: { id: "user-1" },
        attachments: { size: 0, values: () => [] },
        reactions: { cache: new Map() },
        client: { user: { id: "bot-1" } },
        react: async () => {},
        channel: {
          id: "thread-1",
          isThread: () => true,
          parentId: "parent-1",
          name: "test-thread",
          edit: async () =>
            await new Promise<void>(() => {
              // Simulate Discord edit API hanging indefinitely.
            }),
          send: async () => {},
        },
        reply: async () => ({
          edit: async () => {},
        }),
      };

      await Promise.race([
        capturedUserMessageHandler(message),
        Bun.sleep(5_000).then(() => {
          throw new Error("run timed out while status rename was hanging");
        }),
      ]);
      expect(runnerCalls).toBe(1);
    } finally {
      openedDb?.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("stop cancels a stuck pre-run and allows continuing the channel", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "app-queue-stop-stuck-"));
    const dbPath = path.join(root, "state.sqlite");
    let capturedUserMessageHandler: ((message: unknown) => Promise<void>) | undefined;
    let capturedSlashHandler: ((interaction: unknown) => Promise<void>) | undefined;
    let openedDb: { close: () => void } | undefined;
    let runnerCalls = 0;
    const stopReplies: Array<{ content?: string }> = [];

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
              return {
                text: "done",
                messages: [],
              };
            },
          }) as never,
        installSignalHandlers: false,
      });

      if (typeof capturedUserMessageHandler !== "function") {
        throw new Error("user message handler was not captured");
      }
      if (typeof capturedSlashHandler !== "function") {
        throw new Error("slash handler was not captured");
      }

      const stuckMessage = {
        content: "first",
        guildId: "guild-1",
        author: { id: "user-1" },
        attachments: { size: 0, values: () => [] },
        reactions: { cache: new Map() },
        client: { user: { id: "bot-1" } },
        react: async () =>
          await new Promise<void>(() => {
            // never resolves: simulates a Discord API hang before runner starts
          }),
        channel: {
          id: "channel-1",
          isThread: () => false,
          parentId: null,
          send: async () => {},
        },
        reply: async () => ({
          edit: async () => {},
        }),
      };

      const firstRun = capturedUserMessageHandler(stuckMessage);
      await Bun.sleep(30);

      await capturedSlashHandler({
        commandName: "stop",
        channelId: "channel-1",
        guildId: "guild-1",
        channel: {
          id: "channel-1",
          isThread: () => false,
          parentId: null,
          send: async () => {},
        },
        reply: async (payload: { content?: string }) => {
          stopReplies.push(payload);
        },
      });

      const secondMessage = createMockMessage({
        content: "second",
        channelId: "channel-1",
        guildId: "guild-1",
      });
      await capturedUserMessageHandler(secondMessage);
      await firstRun;

      expect(runnerCalls).toBe(1);
      expect(
        stopReplies.some((item) => (item.content ?? "").includes("Pending run cancelled")),
      ).toBeTrue();
    } finally {
      openedDb?.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("abort unlocks channel even when streaming status edits are stuck", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "app-queue-stop-active-"));
    const dbPath = path.join(root, "state.sqlite");
    let capturedUserMessageHandler: ((message: unknown) => Promise<void>) | undefined;
    let capturedSlashHandler: ((interaction: unknown) => Promise<void>) | undefined;
    let openedDb: { close: () => void } | undefined;
    let runnerCalls = 0;
    let firstRunAbortSignal: AbortSignal | undefined;

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
          capturedSlashHandler = options.onSlashCommand as (interaction: unknown) => Promise<void>;
          return {
            destroy: () => {},
            channels: { fetch: async () => null },
          } as unknown as Client;
        },
        createRunner: () =>
          ({
            run: async (request: {
              abortController?: AbortController;
              onQueryStart?: (query: {
                interrupt: () => Promise<void>;
                abort: () => Promise<void>;
                setModel: (_model?: string) => Promise<void>;
                stopTask: (_taskId: string) => Promise<void>;
                close: () => void;
              }) => void;
              onThinkingDelta?: (thinking: string) => void;
            }) => {
              runnerCalls += 1;
              request.onQueryStart?.({
                interrupt: async () => {},
                abort: async () => {},
                setModel: async (_model?: string) => {},
                stopTask: async (_taskId: string) => {},
                close: () => {},
              });

              if (runnerCalls === 1) {
                request.onThinkingDelta?.("thinking");
                firstRunAbortSignal = request.abortController?.signal;
                await new Promise<void>((resolve) => {
                  const signal = request.abortController?.signal;
                  if (!signal) {
                    return;
                  }
                  if (signal.aborted) {
                    resolve();
                    return;
                  }
                  signal.addEventListener("abort", () => resolve(), { once: true });
                });
                throw new Error("Operation aborted.");
              }

              return {
                text: "done",
                messages: [],
              };
            },
          }) as never,
        installSignalHandlers: false,
      });

      if (typeof capturedUserMessageHandler !== "function") {
        throw new Error("user message handler was not captured");
      }
      if (typeof capturedSlashHandler !== "function") {
        throw new Error("slash handler was not captured");
      }

      const firstMessage = {
        content: "first",
        guildId: "guild-1",
        author: { id: "user-1" },
        attachments: { size: 0, values: () => [] },
        reactions: { cache: new Map() },
        client: { user: { id: "bot-1" } },
        react: async () => {},
        channel: {
          id: "channel-1",
          isThread: () => false,
          parentId: null,
          send: async () => {},
        },
        reply: async () => ({
          edit: async () =>
            await new Promise<void>(() => {
              // Never resolves to simulate stuck status edit queue.
            }),
        }),
      };

      const firstRun = capturedUserMessageHandler(firstMessage);
      await Bun.sleep(40);
      expect(firstRunAbortSignal?.aborted).toBeFalse();

      await capturedSlashHandler({
        commandName: "stop",
        channelId: "channel-1",
        guildId: "guild-1",
        channel: {
          id: "channel-1",
          isThread: () => false,
          parentId: null,
          send: async () => {},
        },
        reply: async () => {},
      });

      const secondMessage = createMockMessage({
        content: "second",
        channelId: "channel-1",
        guildId: "guild-1",
      });

      const secondRun = capturedUserMessageHandler(secondMessage);
      await Promise.race([
        secondRun,
        Bun.sleep(1500).then(() => {
          throw new Error("second run did not start after abort");
        }),
      ]);
      await firstRun;
      expect(runnerCalls).toBe(2);
    } finally {
      openedDb?.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
