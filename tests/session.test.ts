import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { SessionManager } from "../src/claude/session";
import { Repository } from "../src/db/repository";

const databases: Database[] = [];

function createSessionManager(maxHistoryItems = 40): SessionManager {
  const database = new Database(":memory:", { strict: true });
  databases.push(database);
  const repository = new Repository(database);
  return new SessionManager(repository, {
    defaultWorkingDir: "/Users/gorkolas/www",
    defaultModel: "sonnet",
    maxHistoryItems,
  });
}

afterEach(() => {
  while (databases.length > 0) {
    databases.pop()?.close();
  }
});

describe("SessionManager", () => {
  test("creates channel state with configured defaults", () => {
    const manager = createSessionManager();
    const state = manager.getState("channel-1", "guild-1");

    expect(state.channel.channelId).toBe("channel-1");
    expect(state.channel.guildId).toBe("guild-1");
    expect(state.channel.workingDir).toBe("/Users/gorkolas/www");
    expect(state.channel.model).toBe("sonnet");
    expect(state.channel.sessionId).toBeNull();
    expect(state.history).toEqual([]);
  });

  test("keeps a bounded message history per channel", () => {
    const manager = createSessionManager(2);

    manager.appendTurn("channel-1", { role: "user", content: "first" });
    manager.appendTurn("channel-1", { role: "assistant", content: "second" });
    manager.appendTurn("channel-1", { role: "user", content: "third" });

    expect(manager.getHistory("channel-1").map((turn) => turn.content)).toEqual([
      "second",
      "third",
    ]);
  });

  test("switchProject with fresh resets session id and history", () => {
    const manager = createSessionManager();

    manager.getState("channel-1", "guild-1");
    manager.setSessionId("channel-1", "session-123");
    manager.appendTurn("channel-1", { role: "user", content: "hello" });

    const state = manager.switchProject("channel-1", "guild-1", "/tmp/other", { fresh: true });

    expect(state.channel.workingDir).toBe("/tmp/other");
    expect(state.channel.sessionId).toBeNull();
    expect(state.history).toEqual([]);
  });

  test("switchProject with keep resets session on directory change but keeps history", () => {
    const manager = createSessionManager();

    manager.getState("channel-1", "guild-1");
    manager.setSessionId("channel-1", "session-123");
    manager.appendTurn("channel-1", { role: "user", content: "hello" });

    const state = manager.switchProject("channel-1", "guild-1", "/tmp/other", { fresh: false });

    expect(state.channel.workingDir).toBe("/tmp/other");
    expect(state.channel.sessionId).toBeNull();
    expect(state.history.map((turn) => turn.content)).toEqual(["hello"]);
  });

  test("switchProject with keep preserves session when directory is unchanged", () => {
    const manager = createSessionManager();

    manager.getState("channel-1", "guild-1");
    manager.setSessionId("channel-1", "session-123");
    manager.appendTurn("channel-1", { role: "assistant", content: "existing" });

    const state = manager.switchProject("channel-1", "guild-1", "/Users/gorkolas/www", {
      fresh: false,
    });

    expect(state.channel.workingDir).toBe("/Users/gorkolas/www");
    expect(state.channel.sessionId).toBe("session-123");
    expect(state.history.map((turn) => turn.content)).toEqual(["existing"]);
  });

  test("resetSession clears only session and history", () => {
    const manager = createSessionManager();

    manager.getState("channel-1", "guild-1");
    manager.setSessionId("channel-1", "session-123");
    manager.setModel("channel-1", "opus");
    manager.appendTurn("channel-1", { role: "assistant", content: "result" });

    manager.resetSession("channel-1");
    const state = manager.getState("channel-1", "guild-1");

    expect(state.channel.sessionId).toBeNull();
    expect(state.channel.model).toBe("opus");
    expect(state.history).toEqual([]);
  });

  test("cloneChannelContext copies model, working dir, and history to target channel", () => {
    const manager = createSessionManager();
    manager.getState("source", "guild-1");
    manager.setModel("source", "opus");
    manager.setWorkingDir("source", "/tmp/source-project");
    manager.setSessionId("source", "session-123");
    manager.appendTurn("source", { role: "assistant", content: "from-source" });

    const cloned = manager.cloneChannelContext("source", "target", "guild-1");
    expect(cloned.channel.workingDir).toBe("/tmp/source-project");
    expect(cloned.channel.model).toBe("opus");
    expect(cloned.channel.sessionId).toBeNull();
    expect(cloned.history.map((turn) => turn.content)).toEqual(["from-source"]);
  });

  test("fresh project switch clears history", () => {
    const manager = createSessionManager();
    manager.getState("channel-1", "guild-1");
    manager.appendTurn("channel-1", { role: "assistant", content: "old" });

    const state = manager.switchProject("channel-1", "guild-1", "/tmp/new-project", {
      fresh: true,
    });

    expect(state.channel.workingDir).toBe("/tmp/new-project");
    expect(state.history).toEqual([]);
  });
});
