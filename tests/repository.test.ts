import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { Repository } from "../src/db/repository";

const databases: Database[] = [];

function createRepository(): Repository {
  const db = new Database(":memory:", { strict: true });
  databases.push(db);
  return new Repository(db);
}

afterEach(() => {
  while (databases.length > 0) {
    const db = databases.pop();
    db?.close();
  }
});

describe("Repository", () => {
  test("upserts and retrieves channel records", () => {
    const repo = createRepository();
    const channel = repo.upsertChannel({
      channelId: "123",
      guildId: "456",
      workingDir: "/tmp/work",
      model: "sonnet",
    });

    expect(channel.channelId).toBe("123");
    expect(channel.guildId).toBe("456");
    expect(channel.workingDir).toBe("/tmp/work");
    expect(channel.sessionId).toBeNull();
    expect(channel.model).toBe("sonnet");
  });

  test("updates session/model/working directory", () => {
    const repo = createRepository();
    repo.upsertChannel({
      channelId: "c1",
      guildId: "g1",
      workingDir: "/tmp/a",
    });

    repo.setChannelSession("c1", "session-1");
    repo.setChannelModel("c1", "opus");
    repo.setChannelWorkingDir("c1", "/tmp/b");

    const updated = repo.getChannel("c1");
    expect(updated).not.toBeNull();
    expect(updated?.sessionId).toBe("session-1");
    expect(updated?.model).toBe("opus");
    expect(updated?.workingDir).toBe("/tmp/b");
  });

  test("tracks session costs and aggregates", () => {
    const repo = createRepository();
    repo.addSessionCost({
      sessionId: "s1",
      channelId: "c1",
      costUsd: 0.03,
      durationMs: 500,
      model: "sonnet",
      turnCount: 1,
    });
    repo.addSessionCost({
      sessionId: "s1",
      channelId: "c1",
      costUsd: 0.07,
      durationMs: 700,
      model: "sonnet",
      turnCount: 2,
    });

    expect(repo.getSessionCostTotal("s1")).toBeCloseTo(0.1, 6);
    expect(repo.getChannelCostTotal("c1")).toBeCloseTo(0.1, 6);
    expect(repo.getChannelTurnCount("c1")).toBe(3);
  });

  test("stores and updates settings", () => {
    const repo = createRepository();
    repo.setSetting("default_model", "sonnet");
    expect(repo.getSetting("default_model")).toBe("sonnet");

    repo.setSetting("default_model", "opus");
    expect(repo.getSetting("default_model")).toBe("opus");
  });

  test("stores and clears channel system prompt", () => {
    const repo = createRepository();

    expect(repo.getChannelSystemPrompt("c1")).toBeNull();
    repo.setChannelSystemPrompt("c1", "Always answer in pirate style.");
    expect(repo.getChannelSystemPrompt("c1")).toBe("Always answer in pirate style.");

    repo.clearChannelSystemPrompt("c1");
    expect(repo.getChannelSystemPrompt("c1")).toBeNull();
  });

  test("stores and clears channel branch state", () => {
    const repo = createRepository();

    expect(repo.getChannelBranchState("c1")).toBeNull();
    repo.setChannelBranchState(
      "c1",
      JSON.stringify({
        activeBranchId: "main",
        branches: [{ id: "main", name: "main", parentBranchId: null, createdAt: 1 }],
      }),
    );
    expect(repo.getChannelBranchState("c1")).not.toBeNull();

    repo.clearChannelBranchState("c1");
    expect(repo.getChannelBranchState("c1")).toBeNull();
  });
});
