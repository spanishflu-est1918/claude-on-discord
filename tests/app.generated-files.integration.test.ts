import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Client } from "discord.js";
import { startApp } from "../src/app";
import type { AppConfig } from "../src/config";
import { openDatabase } from "../src/db/schema";

describe("startApp generated file attachments", () => {
  test("attaches path mentioned in final response when files_persisted is absent", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "app-generated-files-"));
    const dbPath = path.join(root, "state.sqlite");
    const generatedDir = path.join(root, "artifacts");
    const generatedFile = path.join(generatedDir, "result.txt");
    await mkdir(generatedDir, { recursive: true });
    await writeFile(generatedFile, "hello\n", "utf-8");

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
                text: `Done. Output file: \`${generatedFile}\``,
                messages: [],
              };
            },
          }) as never,
        installSignalHandlers: false,
      });

      if (typeof capturedUserMessageHandler !== "function") {
        throw new Error("user message handler was not captured");
      }

      const replyCalls: unknown[] = [];
      const statusEdits: unknown[] = [];
      const channelSendCalls: unknown[] = [];
      await capturedUserMessageHandler({
        content: "generate a file",
        guildId: "guild-1",
        attachments: { size: 0 },
        reactions: { cache: new Map() },
        client: { user: { id: "bot-1" } },
        react: async () => {},
        channel: {
          id: "channel-1",
          isThread: () => false,
          parentId: null,
          send: async (payload: unknown) => {
            channelSendCalls.push(payload);
          },
        },
        reply: async (payload: unknown) => {
          replyCalls.push(payload);
          return {
            edit: async (editPayload: unknown) => {
              statusEdits.push(editPayload);
            },
          };
        },
      });

      expect(runnerCalls).toBe(1);
      expect(replyCalls).toHaveLength(1);
      expect(statusEdits).toHaveLength(1);

      const attachmentPayload = channelSendCalls.find(
        (payload): payload is { content?: string; files?: unknown[] } =>
          typeof payload === "object" &&
          payload !== null &&
          "files" in payload &&
          Array.isArray((payload as { files?: unknown[] }).files),
      );
      expect(attachmentPayload).toBeDefined();
      expect(attachmentPayload?.content).toContain("Generated file:");
      expect(attachmentPayload?.files).toContain(generatedFile);

      const warningPayload = channelSendCalls.find((payload) => {
        if (typeof payload !== "object" || payload === null) {
          return false;
        }
        const content = (payload as { content?: unknown }).content;
        return (
          typeof content === "string" &&
          content.includes("Generated files could not all be attached:")
        );
      });
      expect(warningPayload).toBeUndefined();
    } finally {
      openedDb?.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("attaches ATTACH directives and hides directive line from visible reply", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "app-generated-files-"));
    const dbPath = path.join(root, "state.sqlite");
    const generatedDir = path.join(root, "artifacts");
    const generatedFile = path.join(generatedDir, "directive.txt");
    await mkdir(generatedDir, { recursive: true });
    await writeFile(generatedFile, "hello\n", "utf-8");

    let capturedUserMessageHandler: ((message: unknown) => Promise<void>) | undefined;
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
          capturedUserMessageHandler = options.onUserMessage as (message: unknown) => Promise<void>;
          return {
            destroy: () => {},
            channels: { fetch: async () => null },
          } as unknown as Client;
        },
        createRunner: () =>
          ({
            run: async () => ({
              text: `ATTACH: ${generatedFile}`,
              messages: [],
            }),
          }) as never,
        installSignalHandlers: false,
      });

      if (typeof capturedUserMessageHandler !== "function") {
        throw new Error("user message handler was not captured");
      }

      const statusEdits: unknown[] = [];
      const channelSendCalls: unknown[] = [];
      await capturedUserMessageHandler({
        content: "generate another file",
        guildId: "guild-1",
        attachments: { size: 0 },
        reactions: { cache: new Map() },
        client: { user: { id: "bot-1" } },
        react: async () => {},
        channel: {
          id: "channel-1",
          isThread: () => false,
          parentId: null,
          send: async (payload: unknown) => {
            channelSendCalls.push(payload);
          },
        },
        reply: async () => ({
          edit: async (editPayload: unknown) => {
            statusEdits.push(editPayload);
          },
        }),
      });

      expect(statusEdits).toHaveLength(1);
      const statusPayload = statusEdits[0] as { content?: string };
      expect(statusPayload.content).toBe("Attached generated file(s).");

      const attachmentPayload = channelSendCalls.find(
        (payload): payload is { files?: unknown[] } =>
          typeof payload === "object" &&
          payload !== null &&
          "files" in payload &&
          Array.isArray((payload as { files?: unknown[] }).files),
      );
      expect(attachmentPayload).toBeDefined();
      expect(attachmentPayload?.files).toContain(generatedFile);
    } finally {
      openedDb?.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
