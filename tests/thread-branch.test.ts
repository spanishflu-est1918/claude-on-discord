import { describe, expect, test } from "bun:test";
import {
  buildThreadBranchAwarenessPrompt,
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
    expect(parseThreadBranchMeta("not-json")).toBeNull();
    expect(parseThreadBranchMeta(null)).toBeNull();
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
});
