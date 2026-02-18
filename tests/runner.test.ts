import { describe, expect, test } from "bun:test";
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
  });

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
      return createMockQuery([]);
    });

    await runner.run({
      prompt: "Ping",
      cwd: "/repo",
      sessionId: "session-3",
      model: "opus",
      permissionMode: "plan",
    });

    expect(capturedInput).toBeDefined();
    expect(capturedInput?.options.cwd).toBe("/repo");
    expect(capturedInput?.options.resume).toBe("session-3");
    expect(capturedInput?.options.model).toBe("opus");
    expect(capturedInput?.options.permissionMode).toBe("plan");
  });

  test("calls onQueryStart and onTextDelta callbacks", async () => {
    const textDeltas: string[] = [];
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
        event: { type: "content_block_delta", delta: { type: "text_delta", text: "B" } },
      },
    ]);

    const runner = new ClaudeRunner(() => query);
    const result = await runner.run({
      prompt: "AB",
      cwd: "/tmp",
      onQueryStart: () => {
        queryStarted = true;
      },
      onTextDelta: (text) => {
        textDeltas.push(text);
      },
    });

    expect(queryStarted).toBe(true);
    expect(textDeltas).toEqual(["A", "B"]);
    expect(result.text).toBe("AB");
  });
});
