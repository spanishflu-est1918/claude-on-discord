import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Client } from "discord.js";
import { startApp } from "../src/app";
import type { AppConfig } from "../src/config";
import { openDatabase } from "../src/db/schema";
import type { ThreadLifecycleEvent } from "../src/discord/client";

describe("startApp thread lifecycle abort behavior", () => {
  test("aborts active run when thread is deleted", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "app-thread-lifecycle-"));
    const dbPath = path.join(root, "state.sqlite");
    let capturedUserMessageHandler: ((message: unknown) => Promise<void>) | undefined;
    let capturedThreadLifecycle: ((event: ThreadLifecycleEvent) => Promise<void>) | undefined;
    let openedDb: { close: () => void } | undefined;
    let abortedByLifecycle = false;

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
          capturedThreadLifecycle = options.onThreadLifecycle;
          return {
            destroy: () => {},
            channels: { fetch: async () => null },
          } as unknown as Client;
        },
        createRunner: () =>
          ({
            run: async (request: {
              onQueryStart?: (query: {
                interrupt: () => Promise<void>;
                abort: () => Promise<void>;
                setModel: (_model?: string) => Promise<void>;
                stopTask: (_taskId: string) => Promise<void>;
                close: () => void;
              }) => void;
              abortController?: AbortController;
            }) => {
              request.onQueryStart?.({
                interrupt: async () => {},
                abort: async () => {},
                setModel: async (_model?: string) => {},
                stopTask: async (_taskId: string) => {},
                close: () => {},
              });

              await new Promise<void>((resolve) => {
                const signal = request.abortController?.signal;
                if (!signal) {
                  setTimeout(resolve, 120);
                  return;
                }
                if (signal.aborted) {
                  abortedByLifecycle = true;
                  resolve();
                  return;
                }
                const timeout = setTimeout(resolve, 120);
                signal.addEventListener(
                  "abort",
                  () => {
                    abortedByLifecycle = true;
                    clearTimeout(timeout);
                    resolve();
                  },
                  { once: true },
                );
              });

              return {
                text: abortedByLifecycle ? "Interrupted." : "Done",
                messages: [],
              };
            },
          }) as never,
        installSignalHandlers: false,
      });

      if (typeof capturedUserMessageHandler !== "function") {
        throw new Error("user message handler was not captured");
      }
      if (typeof capturedThreadLifecycle !== "function") {
        throw new Error("thread lifecycle handler was not captured");
      }

      const runPromise = capturedUserMessageHandler({
        content: "do work",
        guildId: "guild-1",
        author: { id: "user-1" },
        attachments: { size: 0 },
        reactions: { cache: new Map() },
        client: { user: { id: "bot-1" } },
        react: async () => {},
        channel: {
          id: "thread-1",
          isThread: () => false,
          parentId: null,
          send: async () => {},
        },
        reply: async () => ({
          edit: async () => {},
        }),
      });

      await Bun.sleep(20);
      await capturedThreadLifecycle({
        type: "deleted",
        threadId: "thread-1",
        parentId: "parent-1",
        threadName: "thread-1",
        thread: {
          id: "thread-1",
          parentId: "parent-1",
          name: "thread-1",
        } as unknown as ThreadLifecycleEvent["thread"],
      });

      await runPromise;
      expect(abortedByLifecycle).toBeTrue();
    } finally {
      openedDb?.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
