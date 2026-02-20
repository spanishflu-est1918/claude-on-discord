import { describe, expect, test } from "bun:test";
import { StopController } from "../src/claude/stop";
import type { ClaudeQuery } from "../src/types";

interface QueryState {
  interrupted: boolean;
  modelSet?: string;
  stoppedTaskId?: string;
  closed?: boolean;
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
    close: () => {
      state.closed = true;
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

  test("clear with expected run does not clear a newer replacement run", () => {
    const controller = new StopController();
    const first = controller.register("channel-1", {
      query: createMockQuery({ interrupted: false }),
      abortController: new AbortController(),
    });
    const secondState: QueryState = { interrupted: false };
    const secondQuery = createMockQuery(secondState);
    const second = controller.register("channel-1", {
      query: secondQuery,
      abortController: new AbortController(),
    });

    controller.clear("channel-1", first);

    expect(controller.isActive("channel-1")).toBe(true);
    expect(controller.get("channel-1")).toBe(second);
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
    const state: QueryState = { interrupted: false };
    const abortController = new AbortController();
    controller.register("channel-1", {
      query: createMockQuery(state),
      abortController,
    });

    const aborted = controller.abort("channel-1");
    expect(aborted).toBe(true);
    expect(state.closed).toBe(true);
    expect(abortController.signal.aborted).toBe(true);
    expect(controller.isActive("channel-1")).toBe(false);
    expect(controller.wasInterrupted("channel-1")).toBe(false);
  });

  test("abortAll aborts all active runs and returns channel ids", () => {
    const controller = new StopController();
    const a = new AbortController();
    const b = new AbortController();
    const stateA: QueryState = { interrupted: false };
    const stateB: QueryState = { interrupted: false };

    controller.register("channel-1", {
      query: createMockQuery(stateA),
      abortController: a,
    });
    controller.register("channel-2", {
      query: createMockQuery(stateB),
      abortController: b,
    });

    const ids = controller.abortAll().sort();
    expect(ids).toEqual(["channel-1", "channel-2"]);
    expect(stateA.closed).toBe(true);
    expect(stateB.closed).toBe(true);
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

  test("abortOlderThan reaps stale runs only", () => {
    const controller = new StopController();
    const staleAbort = new AbortController();
    const freshAbort = new AbortController();
    const staleState: QueryState = { interrupted: false };
    const freshState: QueryState = { interrupted: false };

    controller.register("stale", {
      query: createMockQuery(staleState),
      abortController: staleAbort,
      startedAt: 10,
    });
    controller.register("fresh", {
      query: createMockQuery(freshState),
      abortController: freshAbort,
      startedAt: 900,
    });

    const reaped = controller.abortOlderThan(100, 1000);
    expect(reaped).toEqual(["stale"]);
    expect(staleState.closed).toBe(true);
    expect(staleAbort.signal.aborted).toBe(true);
    expect(controller.isActive("stale")).toBe(false);
    expect(freshState.closed).not.toBe(true);
    expect(freshAbort.signal.aborted).toBe(false);
    expect(controller.isActive("fresh")).toBe(true);
  });
});
