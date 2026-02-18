import { describe, expect, test } from "bun:test";
import { StopController } from "../src/claude/stop";
import type { ClaudeQuery } from "../src/types";

interface QueryState {
  interrupted: boolean;
  modelSet?: string;
  stoppedTaskId?: string;
  throwOnInterrupt?: boolean;
}

function createMockQuery(state: QueryState): ClaudeQuery {
  const iterator = {
    interrupt: async () => {
      if (state.throwOnInterrupt) {
        throw new Error("interrupt failed");
      }
      state.interrupted = true;
    },
    setModel: async (model?: string) => {
      state.modelSet = model;
    },
    stopTask: async (taskId: string) => {
      state.stoppedTaskId = taskId;
    },
    next: async () => ({ done: true, value: undefined }),
    return: async () => ({ done: true, value: undefined }),
    throw: async (error?: unknown) => {
      throw error;
    },
    [Symbol.asyncIterator]() {
      return this;
    },
  };

  return iterator as unknown as ClaudeQuery;
}

describe("StopController", () => {
  test("register stores active run", () => {
    const controller = new StopController();
    const state: QueryState = { interrupted: false };
    const query = createMockQuery(state);
    const abortController = new AbortController();

    controller.register("channel-1", { query, abortController });
    expect(controller.isActive("channel-1")).toBe(true);
    expect(controller.get("channel-1")?.query).toBe(query);
  });

  test("interrupt delegates to query interrupt", async () => {
    const controller = new StopController();
    const state: QueryState = { interrupted: false };
    controller.register("channel-1", {
      query: createMockQuery(state),
      abortController: new AbortController(),
    });

    const success = await controller.interrupt("channel-1");
    expect(success).toBe(true);
    expect(state.interrupted).toBe(true);
    expect(controller.wasInterrupted("channel-1")).toBe(true);
  });

  test("interrupt returns false when query throws", async () => {
    const controller = new StopController();
    const state: QueryState = { interrupted: false, throwOnInterrupt: true };
    controller.register("channel-1", {
      query: createMockQuery(state),
      abortController: new AbortController(),
    });

    const success = await controller.interrupt("channel-1");
    expect(success).toBe(false);
  });

  test("abort signals controller and clears active run", () => {
    const controller = new StopController();
    const abortController = new AbortController();
    controller.register("channel-1", {
      query: createMockQuery({ interrupted: false }),
      abortController,
    });

    const aborted = controller.abort("channel-1");
    expect(aborted).toBe(true);
    expect(abortController.signal.aborted).toBe(true);
    expect(controller.isActive("channel-1")).toBe(false);
    expect(controller.wasInterrupted("channel-1")).toBe(false);
  });

  test("abortAll aborts all active runs and returns channel ids", () => {
    const controller = new StopController();
    const a = new AbortController();
    const b = new AbortController();

    controller.register("channel-1", {
      query: createMockQuery({ interrupted: false }),
      abortController: a,
    });
    controller.register("channel-2", {
      query: createMockQuery({ interrupted: false }),
      abortController: b,
    });

    const ids = controller.abortAll().sort();
    expect(ids).toEqual(["channel-1", "channel-2"]);
    expect(a.signal.aborted).toBe(true);
    expect(b.signal.aborted).toBe(true);
    expect(controller.isActive("channel-1")).toBe(false);
    expect(controller.isActive("channel-2")).toBe(false);
  });

  test("setModel and stopTask pass through to query", async () => {
    const controller = new StopController();
    const state: QueryState = { interrupted: false };
    controller.register("channel-1", {
      query: createMockQuery(state),
      abortController: new AbortController(),
    });

    const modelChanged = await controller.setModel("channel-1", "opus");
    const taskStopped = await controller.stopTask("channel-1", "task-1");

    expect(modelChanged).toBe(true);
    expect(taskStopped).toBe(true);
    expect(state.modelSet).toBe("opus");
    expect(state.stoppedTaskId).toBe("task-1");
  });
});
