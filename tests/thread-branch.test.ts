import { describe, expect, test } from "bun:test";
import {
  buildThreadBranchAwarenessPrompt,
  buildThreadBranchStatusLines,
  parseThreadBranchMeta,
} from "../src/discord/thread-branch";

describe("thread branch metadata helpers", () => {
  test("parseThreadBranchMeta parses valid metadata", () => {
    const parsed = parseThreadBranchMeta(
      JSON.stringify({
        channelId: "c1",
        guildId: "g1",
        rootChannelId: "root",
        parentChannelId: "p1",
        name: "feature-a",
        createdAt: 10,
      }),
    );

    expect(parsed?.channelId).toBe("c1");
    expect(parsed?.rootChannelId).toBe("root");
  });

  test("parseThreadBranchMeta returns null for invalid data", () => {
    expect(parseThreadBranchMeta('{"channelId":1}')).toBeNull();
    expect(
      parseThreadBranchMeta(
        JSON.stringify({
          channelId: "c1",
          guildId: "g1",
          rootChannelId: "root",
          parentChannelId: "p1",
          name: "feature-a",
          createdAt: 10,
          worktreeMode: "bad-mode",
        }),
      ),
    ).toBeNull();
    expect(parseThreadBranchMeta("not-json")).toBeNull();
    expect(parseThreadBranchMeta(null)).toBeNull();
  });

  test("parseThreadBranchMeta accepts lifecycle and cleanup fields", () => {
    const parsed = parseThreadBranchMeta(
      JSON.stringify({
        channelId: "c1",
        guildId: "g1",
        rootChannelId: "root",
        parentChannelId: "p1",
        name: "feature-a",
        createdAt: 10,
        lifecycleState: "archived",
        cleanupState: "pending",
        archivedAt: 20,
      }),
    );
    expect(parsed?.lifecycleState).toBe("archived");
    expect(parsed?.cleanupState).toBe("pending");
    expect(parsed?.archivedAt).toBe(20);
  });

  test("parseThreadBranchMeta accepts fork source session id", () => {
    const parsed = parseThreadBranchMeta(
      JSON.stringify({
        channelId: "c1",
        guildId: "g1",
        rootChannelId: "root",
        parentChannelId: "p1",
        forkSourceSessionId: "session-parent-1",
        name: "feature-a",
        createdAt: 10,
      }),
    );
    expect(parsed?.forkSourceSessionId).toBe("session-parent-1");
  });

  test("buildThreadBranchAwarenessPrompt includes related thread lineage for a thread channel", () => {
    const entries = [
      {
        channelId: "thread-a",
        value: JSON.stringify({
          channelId: "thread-a",
          guildId: "g1",
          rootChannelId: "root",
          parentChannelId: "root",
          name: "a",
          createdAt: 1,
        }),
      },
      {
        channelId: "thread-b",
        value: JSON.stringify({
          channelId: "thread-b",
          guildId: "g1",
          rootChannelId: "root",
          parentChannelId: "thread-a",
          name: "b",
          createdAt: 2,
        }),
      },
    ];

    const prompt = buildThreadBranchAwarenessPrompt({
      currentChannelId: "thread-b",
      entries,
    });

    expect(prompt).toContain("Current channel id: thread-b");
    expect(prompt).toContain("Root channel id: root");
    expect(prompt).toContain("channel=thread-a");
    expect(prompt).toContain("channel=thread-b");
  });

  test("buildThreadBranchAwarenessPrompt includes child threads for root channel", () => {
    const entries = [
      {
        channelId: "thread-a",
        value: JSON.stringify({
          channelId: "thread-a",
          guildId: "g1",
          rootChannelId: "root",
          parentChannelId: "root",
          name: "a",
          createdAt: 1,
        }),
      },
    ];

    const prompt = buildThreadBranchAwarenessPrompt({
      currentChannelId: "root",
      entries,
    });

    expect(prompt).toContain("Current channel is a root with child thread branches");
    expect(prompt).toContain("channel=thread-a");
  });

  test("buildThreadBranchStatusLines returns branch metadata for current thread", () => {
    const entries = [
      {
        channelId: "thread-b",
        value: JSON.stringify({
          channelId: "thread-b",
          guildId: "g1",
          rootChannelId: "root",
          parentChannelId: "thread-a",
          name: "b",
          createdAt: 2,
        }),
      },
    ];

    const lines = buildThreadBranchStatusLines({
      currentChannelId: "thread-b",
      entries,
    });

    expect(lines[0]).toContain("Thread branch:");
    expect(lines[1]).toContain("Thread root:");
    expect(lines[2]).toContain("Thread parent:");
    expect(lines.some((line) => line.includes("Thread lifecycle: `active`"))).toBeTrue();
    expect(lines.some((line) => line.includes("Thread worktree: inherited"))).toBeTrue();
  });

  test("buildThreadBranchStatusLines surfaces pending thread worktree choice", () => {
    const entries = [
      {
        channelId: "thread-c",
        value: JSON.stringify({
          channelId: "thread-c",
          guildId: "g1",
          rootChannelId: "root",
          parentChannelId: "root",
          name: "c",
          createdAt: 3,
          worktreeMode: "prompt",
        }),
      },
    ];

    const lines = buildThreadBranchStatusLines({
      currentChannelId: "thread-c",
      entries,
    });

    expect(lines.some((line) => line.includes("pending choice"))).toBeTrue();
  });

  test("buildThreadBranchStatusLines returns root summary when current channel is root", () => {
    const entries = [
      {
        channelId: "thread-a",
        value: JSON.stringify({
          channelId: "thread-a",
          guildId: "g1",
          rootChannelId: "root",
          parentChannelId: "root",
          name: "a",
          createdAt: 1,
        }),
      },
      {
        channelId: "thread-b",
        value: JSON.stringify({
          channelId: "thread-b",
          guildId: "g1",
          rootChannelId: "root",
          parentChannelId: "thread-a",
          name: "b",
          createdAt: 2,
        }),
      },
    ];

    const lines = buildThreadBranchStatusLines({
      currentChannelId: "root",
      entries,
    });

    expect(lines[0]).toContain("Thread role: root");
    expect(lines[1]).toContain("Thread branches: `2`");
  });
});
