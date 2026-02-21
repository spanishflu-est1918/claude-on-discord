import { describe, expect, test } from "bun:test";
import { DiscordDispatchQueue } from "../src/discord/dispatcher";

describe("DiscordDispatchQueue", () => {
  test("serializes tasks within the same lane", async () => {
    const dispatcher = new DiscordDispatchQueue();
    const order: string[] = [];
    let concurrent = 0;
    let maxConcurrent = 0;

    const run = (name: string, ms: number) =>
      dispatcher.enqueue("lane-1", async () => {
        order.push(`start:${name}`);
        concurrent += 1;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await Bun.sleep(ms);
        concurrent -= 1;
        order.push(`end:${name}`);
        return name;
      });

    const [first, second, third] = await Promise.all([run("a", 20), run("b", 1), run("c", 1)]);

    expect([first, second, third]).toEqual(["a", "b", "c"]);
    expect(order).toEqual(["start:a", "end:a", "start:b", "end:b", "start:c", "end:c"]);
    expect(maxConcurrent).toBe(1);
  });

  test("allows parallel execution across different lanes", async () => {
    const dispatcher = new DiscordDispatchQueue();
    let concurrent = 0;
    let maxConcurrent = 0;

    const run = (laneId: string) =>
      dispatcher.enqueue(laneId, async () => {
        concurrent += 1;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await Bun.sleep(20);
        concurrent -= 1;
        return laneId;
      });

    await Promise.all([run("lane-1"), run("lane-2")]);
    expect(maxConcurrent).toBeGreaterThan(1);
  });

  test("retries on discord rate limit responses", async () => {
    const events: Array<{ laneId: string; retryAfterMs: number; attempt: number }> = [];
    const dispatcher = new DiscordDispatchQueue({
      maxAttempts: 4,
      baseBackoffMs: 1,
      maxBackoffMs: 5,
      onRateLimit: (event) => {
        events.push(event);
      },
    });

    let attempts = 0;
    const result = await dispatcher.enqueue("lane-rl", async () => {
      attempts += 1;
      if (attempts < 3) {
        throw {
          status: 429,
          rawError: { retry_after: 0.001 },
        };
      }
      return "ok";
    });

    expect(result).toBe("ok");
    expect(attempts).toBe(3);
    expect(events).toHaveLength(2);
    expect(events.every((event) => event.laneId === "lane-rl")).toBeTrue();
  });

  test("does not retry non-retryable errors", async () => {
    const dispatcher = new DiscordDispatchQueue({
      maxAttempts: 5,
      baseBackoffMs: 1,
      maxBackoffMs: 5,
    });

    let attempts = 0;
    await expect(
      dispatcher.enqueue("lane-error", async () => {
        attempts += 1;
        throw new Error("bad request");
      }),
    ).rejects.toThrow("bad request");

    expect(attempts).toBe(1);
  });

  test("emits task lifecycle events", async () => {
    const events: string[] = [];
    const dispatcher = new DiscordDispatchQueue({
      maxAttempts: 3,
      baseBackoffMs: 1,
      maxBackoffMs: 5,
      onEvent: (event) => {
        events.push(event.type);
      },
    });

    await dispatcher.enqueue("lane-events", async () => "ok");
    await expect(
      dispatcher.enqueue("lane-events", async () => {
        throw new Error("fail");
      }),
    ).rejects.toThrow("fail");

    expect(events).toEqual(["task_start", "task_success", "task_start", "task_error"]);
  });
});
