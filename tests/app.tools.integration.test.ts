import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { type Client, MessageFlags } from "discord.js";
import { startApp } from "../src/app";
import type { AppConfig } from "../src/config";
import { openDatabase } from "../src/db/schema";
import type { ClaudeSDKMessage } from "../src/types";

type RunnerCallbacks = {
  onTextDelta?: (text: string) => void;
  onThinkingDelta?: (thinking: string) => void;
  onMessage?: (message: ClaudeSDKMessage) => void;
};

type EditableMessageRecord = {
  initial: unknown;
  edits: unknown[];
};

function readContent(payload: unknown): string {
  if (typeof payload === "string") {
    return payload;
  }
  if (
    payload &&
    typeof payload === "object" &&
    "content" in payload &&
    typeof (payload as { content?: unknown }).content === "string"
  ) {
    return (payload as { content: string }).content;
  }
  return "";
}

function readTextDisplayContent(payload: unknown): string {
  if (!payload || typeof payload !== "object") {
    return "";
  }
  if (
    !("components" in payload) ||
    !Array.isArray((payload as { components?: unknown[] }).components)
  ) {
    return "";
  }
  const parts: string[] = [];

  // Recursively collect TextDisplay (type 10) content, handling nested Containers (type 17)
  function collectText(component: unknown): void {
    let comp = component;
    if (comp && typeof comp === "object" && "toJSON" in comp) {
      if (typeof (comp as { toJSON?: unknown }).toJSON === "function") {
        comp = (comp as { toJSON: () => unknown }).toJSON();
      }
    }
    if (!comp || typeof comp !== "object") return;
    const c = comp as Record<string, unknown>;
    if (c.type === 10 && typeof c.content === "string") {
      parts.push(c.content);
    }
    if (Array.isArray(c.components)) {
      for (const nested of c.components) {
        collectText(nested);
      }
    }
  }

  for (const componentValue of (payload as { components: unknown[] }).components) {
    collectText(componentValue);
  }
  return parts.join("\n");
}

function readFlags(payload: unknown): number | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }
  if (!("flags" in payload)) {
    return null;
  }
  const flags = (payload as { flags?: unknown }).flags;
  if (typeof flags === "number") {
    return flags;
  }
  return null;
}

function createConfig(root: string, dbPath: string): AppConfig {
  return {
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
}

describe("startApp tool stream integration", () => {
  test("streams tool message updates from tool_use events", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "app-tools-"));
    const dbPath = path.join(root, "state.sqlite");
    let capturedUserMessageHandler: ((message: unknown) => Promise<void>) | undefined;
    let openedDb: { close: () => void } | undefined;
    const toolMessages: EditableMessageRecord[] = [];
    const statusEdits: unknown[] = [];

    try {
      await startApp(createConfig(root, dbPath), {
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
            run: async (request: RunnerCallbacks) => {
              request.onThinkingDelta?.("Planning...");
              request.onMessage?.({
                type: "stream_event",
                session_id: "s1",
                parent_tool_use_id: null,
                uuid: "u1",
                event: {
                  type: "content_block_start",
                  index: 0,
                  content_block: {
                    type: "tool_use",
                    id: "tool-1",
                    name: "Bash",
                    input: { command: "ls -la" },
                  },
                },
              } as ClaudeSDKMessage);
              request.onMessage?.({
                type: "stream_event",
                session_id: "s1",
                parent_tool_use_id: null,
                uuid: "u2",
                event: {
                  type: "content_block_delta",
                  index: 0,
                  delta: { type: "input_json_delta", partial_json: ', "cwd": "."}' },
                },
              } as ClaudeSDKMessage);
              request.onMessage?.({
                type: "tool_progress",
                session_id: "s1",
                uuid: "u3",
                tool_use_id: "tool-1",
                tool_name: "Bash",
                parent_tool_use_id: null,
                elapsed_time_seconds: 0.6,
              } as ClaudeSDKMessage);
              await Bun.sleep(15);
              request.onMessage?.({
                type: "tool_use_summary",
                session_id: "s1",
                uuid: "u4",
                summary: "Listed files in the current directory.",
                preceding_tool_use_ids: ["tool-1"],
              } as ClaudeSDKMessage);
              request.onTextDelta?.("Done.");
              return { text: "Done.", messages: [] };
            },
          }) as never,
        installSignalHandlers: false,
      });

      if (typeof capturedUserMessageHandler !== "function") {
        throw new Error("user message handler was not captured");
      }

      await capturedUserMessageHandler({
        content: "list files",
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
          send: async (payload: unknown) => {
            const record: EditableMessageRecord = { initial: payload, edits: [] };
            toolMessages.push(record);
            return {
              edit: async (next: unknown) => {
                record.edits.push(next);
              },
            };
          },
        },
        reply: async () => ({
          edit: async (payload: unknown) => {
            statusEdits.push(payload);
          },
        }),
      });

      await Bun.sleep(40);

      const contents = toolMessages.flatMap((record) => [
        readContent(record.initial),
        ...record.edits.map((edit) => readContent(edit)),
      ]);
      expect(contents.every((content) => content.trim() === "")).toBeTrue();

      const textDisplays = toolMessages.flatMap((record) => [
        readTextDisplayContent(record.initial),
        ...record.edits.map((edit) => readTextDisplayContent(edit)),
      ]);
      // Status icon + tool name (compact header format: "⏳ **Bash** · 0.6s")
      expect(textDisplays.some((text) => text.includes("⏳") && text.includes("Bash"))).toBeTrue();
      // Human-readable Bash display line: `$ ls -la`
      expect(textDisplays.some((text) => text.includes("ls -la"))).toBeTrue();
      // Done state (compact header format: "✅ **Bash** · …")
      expect(textDisplays.some((text) => text.includes("✅") && text.includes("Bash"))).toBeTrue();
      expect(
        textDisplays.some((text) => text.includes("Listed files in the current directory.")),
      ).toBeTrue();
      const flags = toolMessages.flatMap((record) => [
        readFlags(record.initial),
        ...record.edits.map((edit) => readFlags(edit)),
      ]);
      expect(
        flags.some((value) => value !== null && (value & MessageFlags.IsComponentsV2) !== 0),
      ).toBeTrue();
      expect(statusEdits.length).toBeGreaterThan(0);
    } finally {
      openedDb?.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("captures server_tool_use blocks with tool names and input details", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "app-tools-server-tool-use-"));
    const dbPath = path.join(root, "state.sqlite");
    let capturedUserMessageHandler: ((message: unknown) => Promise<void>) | undefined;
    let openedDb: { close: () => void } | undefined;
    const toolMessages: EditableMessageRecord[] = [];

    try {
      await startApp(createConfig(root, dbPath), {
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
            run: async (request: RunnerCallbacks) => {
              request.onMessage?.({
                type: "stream_event",
                session_id: "s2",
                parent_tool_use_id: null,
                uuid: "u5",
                event: {
                  type: "content_block_start",
                  content_block: {
                    type: "server_tool_use",
                    id: "tool-2",
                    name: "WebFetch",
                  },
                },
              } as ClaudeSDKMessage);
              request.onMessage?.({
                type: "stream_event",
                session_id: "s2",
                parent_tool_use_id: null,
                uuid: "u6",
                event: {
                  type: "content_block_delta",
                  index: 0,
                  delta: {
                    type: "input_json_delta",
                    partial_json: '{"url":"https://example.com","method":"GET"}',
                  },
                },
              } as ClaudeSDKMessage);
              request.onMessage?.({
                type: "tool_progress",
                session_id: "s2",
                uuid: "u7",
                tool_use_id: "tool-2",
                tool_name: "WebFetch",
                parent_tool_use_id: null,
                elapsed_time_seconds: 0.2,
              } as ClaudeSDKMessage);
              return { text: "Fetched.", messages: [] };
            },
          }) as never,
        installSignalHandlers: false,
      });

      if (typeof capturedUserMessageHandler !== "function") {
        throw new Error("user message handler was not captured");
      }

      await capturedUserMessageHandler({
        content: "fetch this url",
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
          send: async (payload: unknown) => {
            const record: EditableMessageRecord = { initial: payload, edits: [] };
            toolMessages.push(record);
            return {
              edit: async (next: unknown) => {
                record.edits.push(next);
              },
            };
          },
        },
        reply: async () => ({
          edit: async () => {},
        }),
      });

      await Bun.sleep(40);

      const contents = toolMessages.flatMap((record) => [
        readContent(record.initial),
        ...record.edits.map((edit) => readContent(edit)),
      ]);
      expect(contents.every((content) => content.trim() === "")).toBeTrue();

      const textDisplays = toolMessages.flatMap((record) => [
        readTextDisplayContent(record.initial),
        ...record.edits.map((edit) => readTextDisplayContent(edit)),
      ]);
      expect(textDisplays.some((text) => text.includes("WebFetch"))).toBeTrue();
      expect(textDisplays.some((text) => text.includes("https://example.com"))).toBeTrue();
      // Human-readable WebFetch display line: "🔗 https://example.com"
      expect(textDisplays.some((text) => text.includes("🔗 https://example.com"))).toBeTrue();
    } finally {
      openedDb?.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("shows task lifecycle timeline for Task tool notifications", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "app-tools-task-timeline-"));
    const dbPath = path.join(root, "state.sqlite");
    let capturedUserMessageHandler: ((message: unknown) => Promise<void>) | undefined;
    let openedDb: { close: () => void } | undefined;
    const toolMessages: EditableMessageRecord[] = [];

    try {
      await startApp(createConfig(root, dbPath), {
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
            run: async (request: RunnerCallbacks) => {
              request.onMessage?.({
                type: "stream_event",
                session_id: "s3",
                parent_tool_use_id: null,
                uuid: "u8",
                event: {
                  type: "content_block_start",
                  content_block: {
                    type: "tool_use",
                    id: "tool-3",
                    name: "Task",
                    input: {
                      subagent_type: "Explore",
                      prompt: "Inspect src for TODOs and architecture hotspots.",
                    },
                  },
                },
              } as ClaudeSDKMessage);
              request.onMessage?.({
                type: "system",
                subtype: "task_started",
                task_id: "task-1",
                tool_use_id: "tool-3",
                description: "Inspect src for TODOs",
                task_type: "Task",
                uuid: "u9",
                session_id: "s3",
              } as ClaudeSDKMessage);
              request.onMessage?.({
                type: "system",
                subtype: "task_notification",
                task_id: "task-1",
                status: "completed",
                output_file: "/tmp/task-1.txt",
                summary: "Identified two TODO hotspots.",
                uuid: "u10",
                session_id: "s3",
              } as ClaudeSDKMessage);
              return { text: "Task done.", messages: [] };
            },
          }) as never,
        installSignalHandlers: false,
      });

      if (typeof capturedUserMessageHandler !== "function") {
        throw new Error("user message handler was not captured");
      }

      await capturedUserMessageHandler({
        content: "run task tool",
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
          send: async (payload: unknown) => {
            const record: EditableMessageRecord = { initial: payload, edits: [] };
            toolMessages.push(record);
            return {
              edit: async (next: unknown) => {
                record.edits.push(next);
              },
            };
          },
        },
        reply: async () => ({
          edit: async () => {},
        }),
      });

      await Bun.sleep(40);

      const textDisplays = toolMessages.flatMap((record) => [
        readTextDisplayContent(record.initial),
        ...record.edits.map((edit) => readTextDisplayContent(edit)),
      ]);
      expect(textDisplays.some((text) => text.includes("Task"))).toBeTrue();
      // Human-readable Task display line: "🤖 Explore: Inspect src for TODOs..."
      expect(textDisplays.some((text) => text.includes("🤖 Explore:"))).toBeTrue();
      // Timeline is tracked internally but no longer rendered in the card UI (removed in f0207b4)
    } finally {
      openedDb?.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
