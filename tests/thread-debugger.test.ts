import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createThreadDebuggerFromEnv } from "../src/app/thread-debugger";

describe("thread debugger", () => {
  test("is disabled by default", () => {
    const debuggerInstance = createThreadDebuggerFromEnv({});
    expect(debuggerInstance.isEnabled()).toBeFalse();
  });

  test("writes trace lines to file when enabled", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "thread-debugger-"));
    const logPath = path.join(root, "thread-debug.log");

    try {
      const debuggerInstance = createThreadDebuggerFromEnv({
        THREAD_DEBUG_TRACE: "1",
        THREAD_DEBUG_TRACE_FILE: logPath,
      });
      const runId = debuggerInstance.nextRunId("channel-123");
      debuggerInstance.log({
        event: "run.start",
        channelId: "channel-123",
        runId,
        detail: { queued: false },
      });

      const content = await readFile(logPath, "utf8");
      const line = content
        .split("\n")
        .map((item) => item.trim())
        .find((item) => item.length > 0);
      if (!line) {
        throw new Error("expected debug log line");
      }
      const parsed = JSON.parse(line) as {
        event?: string;
        channelId?: string;
        runId?: string;
        detail?: { queued?: boolean };
      };
      expect(parsed.event).toBe("run.start");
      expect(parsed.channelId).toBe("channel-123");
      expect(parsed.runId).toBe(runId);
      expect(parsed.detail?.queued).toBeFalse();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
