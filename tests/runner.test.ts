import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ClaudeRunner, type QueryFactoryInput } from "../src/claude/runner";
import type { ClaudeQuery, ClaudeSDKMessage } from "../src/types";

type MessageLike = Record<string, unknown>;

function createMockQuery(messages: MessageLike[]): ClaudeQuery {
  async function* iterator() {
    for (const message of messages) {
      yield message as ClaudeSDKMessage;
    }
  }

  const gen = iterator();
  const query = Object.assign(gen, {
    interrupt: async () => {},
    abort: async () => {},
    setModel: async (_model?: string) => {},
    stopTask: async (_taskId: string) => {},
    close: () => {},
  });

  return query as unknown as ClaudeQuery;
}

function createFailingQuery(error: Error): ClaudeQuery {
  const query = {
    [Symbol.asyncIterator]() {
      return {
        next: async () => Promise.reject(error),
      };
    },
    interrupt: async () => {},
    abort: async () => {},
    setModel: async (_model?: string) => {},
    stopTask: async (_taskId: string) => {},
    close: () => {},
  };

  return query as unknown as ClaudeQuery;
}

describe("ClaudeRunner", () => {
  test("aggregates stream text deltas and result metadata", async () => {
    const runner = new ClaudeRunner(() =>
      createMockQuery([
        {
          type: "stream_event",
          session_id: "session-1",
          event: { type: "content_block_delta", delta: { type: "text_delta", text: "Hel" } },
        },
        {
          type: "stream_event",
          session_id: "session-1",
          event: { type: "content_block_delta", delta: { type: "text_delta", text: "lo" } },
        },
        {
          type: "result",
          subtype: "success",
          session_id: "session-1",
          duration_ms: 321,
          total_cost_usd: 0.04,
          num_turns: 2,
          result: "Hello",
          is_error: false,
          duration_api_ms: 100,
          stop_reason: "end_turn",
          usage: {},
          modelUsage: {},
          permission_denials: [],
          uuid: "u1",
        },
      ]),
    );

    const result = await runner.run({
      channelId: "channel-1",
      prompt: "Say hello",
      cwd: "/tmp",
    });

    expect(result.text).toBe("Hello");
    expect(result.sessionId).toBe("session-1");
    expect(result.costUsd).toBe(0.04);
    expect(result.durationMs).toBe(321);
    expect(result.turnCount).toBe(2);
    expect(result.messages).toHaveLength(3);
  });

  test("falls back to result text when no stream text was emitted", async () => {
    const runner = new ClaudeRunner(() =>
      createMockQuery([
        {
          type: "result",
          subtype: "success",
          session_id: "session-2",
          duration_ms: 100,
          total_cost_usd: 0.01,
          num_turns: 1,
          result: "Done",
          is_error: false,
          duration_api_ms: 30,
          stop_reason: "end_turn",
          usage: {},
          modelUsage: {},
          permission_denials: [],
          uuid: "u2",
        },
      ]),
    );

    const result = await runner.run({
      channelId: "channel-1",
      prompt: "Done?",
      cwd: "/tmp",
    });

    expect(result.text).toBe("Done");
    expect(result.sessionId).toBe("session-2");
  });

  test("passes resume/model/cwd options to query factory", async () => {
    let capturedInput: QueryFactoryInput | undefined;
    const runner = new ClaudeRunner((input) => {
      capturedInput = input;
      return createMockQuery([
        {
          type: "result",
          subtype: "success",
          session_id: "session-3",
          duration_ms: 1,
          total_cost_usd: 0,
          num_turns: 1,
          result: "ok",
          is_error: false,
          duration_api_ms: 1,
          stop_reason: "end_turn",
          usage: {},
          modelUsage: {},
          permission_denials: [],
          uuid: "u3",
        },
      ]);
    });

    await runner.run({
      channelId: "channel-1",
      prompt: "Ping",
      cwd: "/repo",
      sessionId: "session-3",
      model: "opus",
      systemPrompt: "Respond in terse style.",
      permissionMode: "plan",
    });

    expect(capturedInput).toBeDefined();
    expect(capturedInput?.options.cwd).toBe("/repo");
    expect(capturedInput?.options.resume).toBe("session-3");
    expect(capturedInput?.options.model).toBe("opus");
    expect(capturedInput?.options.permissionMode).toBe("plan");
    expect(capturedInput?.options.includePartialMessages).toBe(true);
    expect(capturedInput?.options.thinking).toEqual({ type: "adaptive" });
    expect(capturedInput?.options.systemPrompt).toContain("you CAN return files/images");
    expect(capturedInput?.options.systemPrompt).toContain("ATTACH:");
    expect(capturedInput?.options.systemPrompt).toContain("Respond in terse style.");
  });

  test("calls onQueryStart, onTextDelta, and onThinkingDelta callbacks", async () => {
    const textDeltas: string[] = [];
    const thinkingDeltas: string[] = [];
    let queryStarted = false;
    const query = createMockQuery([
      {
        type: "stream_event",
        session_id: "session-4",
        event: { type: "content_block_delta", delta: { type: "text_delta", text: "A" } },
      },
      {
        type: "stream_event",
        session_id: "session-4",
        event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "Plan" } },
      },
      {
        type: "stream_event",
        session_id: "session-4",
        event: { type: "content_block_delta", delta: { type: "text_delta", text: "B" } },
      },
      {
        type: "result",
        subtype: "success",
        session_id: "session-4",
        duration_ms: 1,
        total_cost_usd: 0,
        num_turns: 1,
        result: "AB",
        is_error: false,
        duration_api_ms: 1,
        stop_reason: "end_turn",
        usage: {},
        modelUsage: {},
        permission_denials: [],
        uuid: "u4",
      },
    ]);

    const runner = new ClaudeRunner(() => query);
    const result = await runner.run({
      channelId: "channel-1",
      prompt: "AB",
      cwd: "/tmp",
      onQueryStart: () => {
        queryStarted = true;
      },
      onTextDelta: (text) => {
        textDeltas.push(text);
      },
      onThinkingDelta: (thinking) => {
        thinkingDeltas.push(thinking);
      },
    });

    expect(queryStarted).toBe(true);
    expect(textDeltas).toEqual(["A", "B"]);
    expect(thinkingDeltas).toEqual(["Plan"]);
    expect(result.text).toBe("AB");
  });

  test("falls back to assistant thinking blocks when no thinking deltas are streamed", async () => {
    const thinkingDeltas: string[] = [];
    const runner = new ClaudeRunner(() =>
      createMockQuery([
        {
          type: "assistant",
          session_id: "session-think-fallback",
          parent_tool_use_id: null,
          uuid: "assist-1",
          message: {
            id: "msg-1",
            type: "message",
            role: "assistant",
            model: "test-model",
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: 0 },
            content: [{ type: "thinking", thinking: "Fallback think block." }],
          },
        },
        {
          type: "result",
          subtype: "success",
          session_id: "session-think-fallback",
          duration_ms: 1,
          total_cost_usd: 0,
          num_turns: 1,
          result: "ok",
          is_error: false,
          duration_api_ms: 1,
          stop_reason: "end_turn",
          usage: {},
          modelUsage: {},
          permission_denials: [],
          uuid: "res-1",
        },
      ]),
    );

    await runner.run({
      channelId: "channel-1",
      prompt: "Think",
      cwd: "/tmp",
      onThinkingDelta: (thinking) => {
        thinkingDeltas.push(thinking);
      },
    });

    expect(thinkingDeltas).toEqual(["Fallback think block."]);
  });

  test("keeps one streaming worker per channel and serializes concurrent turns", async () => {
    let queryFactoryCalls = 0;
    let concurrentTurns = 0;
    let maxConcurrentTurns = 0;

    const runner = new ClaudeRunner((input) => {
      queryFactoryCalls += 1;
      if (typeof input.prompt === "string") {
        throw new Error("Expected streaming prompt input.");
      }

      async function* iterator() {
        for await (const userMessage of input.prompt) {
          const promptText =
            typeof userMessage === "string"
              ? userMessage
              : typeof userMessage.message.content === "string"
                ? userMessage.message.content
                : "";
          concurrentTurns += 1;
          maxConcurrentTurns = Math.max(maxConcurrentTurns, concurrentTurns);
          await Bun.sleep(20);
          yield {
            type: "stream_event",
            session_id: "session-stream",
            event: {
              type: "content_block_delta",
              delta: { type: "text_delta", text: promptText.toUpperCase() },
            },
          } as ClaudeSDKMessage;
          yield {
            type: "result",
            subtype: "success",
            session_id: "session-stream",
            duration_ms: 20,
            total_cost_usd: 0.001,
            num_turns: 1,
            result: promptText.toUpperCase(),
            is_error: false,
            duration_api_ms: 10,
            stop_reason: "end_turn",
            usage: {},
            modelUsage: {},
            permission_denials: [],
            uuid: `${promptText}-uuid`,
          } as ClaudeSDKMessage;
          concurrentTurns -= 1;
        }
      }

      const gen = iterator();
      return Object.assign(gen, {
        interrupt: async () => {},
        setModel: async (_model?: string) => {},
        stopTask: async (_taskId: string) => {},
        close: () => {},
      }) as unknown as ClaudeQuery;
    });

    try {
      const [first, second] = await Promise.all([
        runner.run({
          channelId: "channel-1",
          prompt: "first",
          cwd: "/tmp",
        }),
        runner.run({
          channelId: "channel-1",
          prompt: "second",
          cwd: "/tmp",
        }),
      ]);

      expect(queryFactoryCalls).toBe(1);
      expect(maxConcurrentTurns).toBe(1);
      expect(first.text).toBe("FIRST");
      expect(second.text).toBe("SECOND");
    } finally {
      runner.closeAll();
    }
  });

  test("retries without MCP servers when claude process exits with code 1", async () => {
    const workingDir = await mkdtemp(path.join(tmpdir(), "runner-mcp-retry-"));
    await mkdir(path.join(workingDir, ".claude"), { recursive: true });
    await writeFile(
      path.join(workingDir, ".claude", "mcp.json"),
      JSON.stringify({
        mcpServers: {
          test: {
            command: "echo",
            args: ["hello"],
          },
        },
      }),
      "utf-8",
    );

    try {
      const calls: QueryFactoryInput[] = [];
      const runner = new ClaudeRunner((input) => {
        calls.push(input);
        if (calls.length === 1) {
          return createFailingQuery(new Error("Claude Code process exited with code 1"));
        }
        return createMockQuery([
          {
            type: "result",
            subtype: "success",
            session_id: "session-retry",
            duration_ms: 100,
            total_cost_usd: 0.01,
            num_turns: 1,
            result: "Recovered",
            is_error: false,
            duration_api_ms: 30,
            stop_reason: "end_turn",
            usage: {},
            modelUsage: {},
            permission_denials: [],
            uuid: "retry-1",
          },
        ]);
      });

      const result = await runner.run({
        channelId: "channel-1",
        prompt: "Ping",
        cwd: workingDir,
      });

      expect(result.text).toBe("Recovered");
      expect(calls).toHaveLength(2);
      expect(calls[0]?.options.mcpServers).toBeDefined();
      expect(calls[1]?.options.mcpServers).toBeUndefined();
    } finally {
      await rm(workingDir, { recursive: true, force: true });
    }
  });

  test("does not retry for non-retryable failures", async () => {
    const workingDir = await mkdtemp(path.join(tmpdir(), "runner-mcp-no-retry-"));
    await mkdir(path.join(workingDir, ".claude"), { recursive: true });
    await writeFile(
      path.join(workingDir, ".claude", "mcp.json"),
      JSON.stringify({
        mcpServers: {
          test: {
            command: "echo",
            args: ["hello"],
          },
        },
      }),
      "utf-8",
    );

    try {
      let callCount = 0;
      const runner = new ClaudeRunner(() => {
        callCount += 1;
        return createFailingQuery(new Error("Claude Code process exited with code 2"));
      });

      await expect(
        runner.run({
          channelId: "channel-1",
          prompt: "Ping",
          cwd: workingDir,
        }),
      ).rejects.toThrow("code 2");
      expect(callCount).toBe(1);
    } finally {
      await rm(workingDir, { recursive: true, force: true });
    }
  });

  test("retries without session resume when process exits with code 1", async () => {
    const calls: QueryFactoryInput[] = [];
    const runner = new ClaudeRunner((input) => {
      calls.push(input);
      if (calls.length === 1) {
        return createFailingQuery(new Error("Claude Code process exited with code 1"));
      }
      return createMockQuery([
        {
          type: "result",
          subtype: "success",
          session_id: "session-fresh",
          duration_ms: 100,
          total_cost_usd: 0.01,
          num_turns: 1,
          result: "Recovered fresh",
          is_error: false,
          duration_api_ms: 30,
          stop_reason: "end_turn",
          usage: {},
          modelUsage: {},
          permission_denials: [],
          uuid: "retry-fresh-1",
        },
      ]);
    });

    const result = await runner.run({
      channelId: "channel-1",
      prompt: "Ping",
      cwd: "/tmp",
      sessionId: "session-stale",
    });

    expect(result.text).toBe("Recovered fresh");
    expect(calls).toHaveLength(2);
    expect(calls[0]?.options.resume).toBe("session-stale");
    expect(calls[1]?.options.resume).toBeUndefined();
  });

  test("retries without MCP and session resume when both recovery steps are needed", async () => {
    const workingDir = await mkdtemp(path.join(tmpdir(), "runner-mcp-session-retry-"));
    await mkdir(path.join(workingDir, ".claude"), { recursive: true });
    await writeFile(
      path.join(workingDir, ".claude", "mcp.json"),
      JSON.stringify({
        mcpServers: {
          test: {
            command: "echo",
            args: ["hello"],
          },
        },
      }),
      "utf-8",
    );

    try {
      const calls: QueryFactoryInput[] = [];
      const runner = new ClaudeRunner((input) => {
        calls.push(input);
        if (calls.length <= 2) {
          return createFailingQuery(new Error("Claude Code process exited with code 1"));
        }
        return createMockQuery([
          {
            type: "result",
            subtype: "success",
            session_id: "session-final",
            duration_ms: 100,
            total_cost_usd: 0.01,
            num_turns: 1,
            result: "Recovered after both fallbacks",
            is_error: false,
            duration_api_ms: 30,
            stop_reason: "end_turn",
            usage: {},
            modelUsage: {},
            permission_denials: [],
            uuid: "retry-both-1",
          },
        ]);
      });

      const result = await runner.run({
        channelId: "channel-1",
        prompt: "Ping",
        cwd: workingDir,
        sessionId: "session-stale",
      });

      expect(result.text).toBe("Recovered after both fallbacks");
      expect(calls).toHaveLength(3);
      expect(calls[0]?.options.mcpServers).toBeDefined();
      expect(calls[0]?.options.resume).toBe("session-stale");
      expect(calls[1]?.options.mcpServers).toBeUndefined();
      expect(calls[1]?.options.resume).toBe("session-stale");
      expect(calls[2]?.options.mcpServers).toBeDefined();
      expect(calls[2]?.options.resume).toBeUndefined();
    } finally {
      await rm(workingDir, { recursive: true, force: true });
    }
  });

  test("falls back to safe mode settings after process exit retries", async () => {
    const workingDir = await mkdtemp(path.join(tmpdir(), "runner-safe-settings-"));
    await mkdir(path.join(workingDir, ".claude"), { recursive: true });
    await writeFile(
      path.join(workingDir, ".claude", "mcp.json"),
      JSON.stringify({
        mcpServers: {
          test: {
            command: "echo",
            args: ["hello"],
          },
        },
      }),
      "utf-8",
    );

    try {
      const calls: QueryFactoryInput[] = [];
      const runner = new ClaudeRunner((input) => {
        calls.push(input);
        if (calls.length <= 4) {
          return createFailingQuery(new Error("Claude Code process exited with code 1"));
        }
        return createMockQuery([
          {
            type: "result",
            subtype: "success",
            session_id: "session-safe",
            duration_ms: 100,
            total_cost_usd: 0.01,
            num_turns: 1,
            result: "Recovered with safe mode",
            is_error: false,
            duration_api_ms: 30,
            stop_reason: "end_turn",
            usage: {},
            modelUsage: {},
            permission_denials: [],
            uuid: "retry-safe-1",
          },
        ]);
      });

      const result = await runner.run({
        channelId: "channel-1",
        prompt: "Ping",
        cwd: workingDir,
        sessionId: "session-stale",
      });

      expect(result.text).toBe("Recovered with safe mode");
      expect(calls).toHaveLength(5);
      expect(calls[4]?.options.settingSources).toEqual(["user"]);
      expect(calls[4]?.options.mcpServers).toBeUndefined();
      expect(calls[4]?.options.resume).toBeUndefined();
    } finally {
      await rm(workingDir, { recursive: true, force: true });
    }
  });
});
