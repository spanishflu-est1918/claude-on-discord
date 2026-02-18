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
    expect(state.branch.id).toBe("main");
    expect(state.branch.name).toBe("main");
    expect(state.branches.map((branch) => branch.id)).toEqual(["main"]);
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

  test("forkBranch creates a new active branch with copied history", () => {
    const manager = createSessionManager();
    manager.getState("channel-1", "guild-1");
    manager.appendTurn("channel-1", { role: "user", content: "original prompt" });

    const created = manager.forkBranch("channel-1", "guild-1", "experiment");
    const state = manager.getState("channel-1", "guild-1");

    expect(created.name).toBe("experiment");
    expect(created.parentBranchId).toBe("main");
    expect(state.branch.id).toBe(created.id);
    expect(state.history.map((turn) => turn.content)).toEqual(["original prompt"]);
    expect(state.branches.length).toBe(2);
  });

  test("switchBranch isolates history by branch", () => {
    const manager = createSessionManager();
    manager.getState("channel-1", "guild-1");
    manager.appendTurn("channel-1", { role: "assistant", content: "from-main" });
    const created = manager.forkBranch("channel-1", "guild-1", "feature-a");
    manager.appendTurn("channel-1", { role: "assistant", content: "from-feature" });

    const switchedMain = manager.switchBranch("channel-1", "guild-1", "main");
    const mainState = manager.getState("channel-1", "guild-1");

    expect(switchedMain?.id).toBe("main");
    expect(mainState.history.map((turn) => turn.content)).toEqual(["from-main"]);

    const switchedFeature = manager.switchBranch("channel-1", "guild-1", created.id);
    const featureState = manager.getState("channel-1", "guild-1");
    expect(switchedFeature?.id).toBe(created.id);
    expect(featureState.history.map((turn) => turn.content)).toEqual(["from-main", "from-feature"]);
  });

  test("fresh project switch resets branches back to main", () => {
    const manager = createSessionManager();
    manager.getState("channel-1", "guild-1");
    manager.forkBranch("channel-1", "guild-1", "feature-x");

    const state = manager.switchProject("channel-1", "guild-1", "/tmp/new-project", {
      fresh: true,
    });

    expect(state.channel.workingDir).toBe("/tmp/new-project");
    expect(state.branch.id).toBe("main");
    expect(state.branches.map((branch) => branch.id)).toEqual(["main"]);
    expect(state.history).toEqual([]);
  });
});
