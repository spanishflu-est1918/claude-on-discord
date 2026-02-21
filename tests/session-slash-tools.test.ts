import { describe, expect, test } from "bun:test";
import { createSessionSlashMcpTools } from "../src/mcp/tools/session-slash-tools";

function buildDeps() {
  const store = {
    systemPromptByChannel: new Map<string, string>(),
    mentionsModeByChannel: new Map<string, "default" | "required" | "off">(),
    permissionModeByChannel: new Map<
      string,
      "default" | "plan" | "acceptEdits" | "bypassPermissions" | "delegate" | "dontAsk"
    >(),
    activeSessionByChannel: new Map<string, string | null>(),
    modelByChannel: new Map<string, string>(),
    stopAbortCalls: [] as string[],
    resetCalls: [] as string[],
    clearPermissionCalls: [] as string[],
  };

  const deps = {
    defaultRequireMention: true,
    defaultPermissionMode: "bypassPermissions" as const,
    getChannelCostTotal: () => 1.2345,
    getChannelTurnCount: () => 9,
    setChannelSystemPrompt: (channelId: string, text: string) => {
      store.systemPromptByChannel.set(channelId, text);
    },
    getChannelSystemPrompt: (channelId: string) =>
      store.systemPromptByChannel.get(channelId) ?? null,
    clearChannelSystemPrompt: (channelId: string) => {
      store.systemPromptByChannel.delete(channelId);
    },
    setChannelMentionsMode: (channelId: string, mode: "default" | "required" | "off") => {
      store.mentionsModeByChannel.set(channelId, mode);
    },
    clearChannelMentionsMode: (channelId: string) => {
      store.mentionsModeByChannel.delete(channelId);
    },
    resetSessionId: (channelId: string) => {
      store.activeSessionByChannel.set(channelId, null);
      store.resetCalls.push(channelId);
    },
    getActiveSessionId: (channelId: string) =>
      store.activeSessionByChannel.get(channelId) ?? "session-1",
    setSessionPermissionMode: (
      channelId: string,
      mode: "default" | "plan" | "acceptEdits" | "bypassPermissions" | "delegate" | "dontAsk",
    ) => {
      store.permissionModeByChannel.set(channelId, mode);
    },
    clearSessionPermissionMode: (channelId: string) => {
      store.permissionModeByChannel.delete(channelId);
      store.clearPermissionCalls.push(channelId);
    },
    resolveMentionRequirementForChannel: (channelId: string) => {
      const mode = store.mentionsModeByChannel.get(channelId) ?? "default";
      const requireMention = mode === "default" ? true : mode === "required";
      return { mode, requireMention };
    },
    resolvePermissionModeForSession: (channelId: string) => {
      const mode = store.permissionModeByChannel.get(channelId) ?? "default";
      return {
        mode,
        permissionMode: mode === "default" ? "bypassPermissions" : mode,
      };
    },
    runBashCommand: async (_command: string, _cwd: string) => ({
      exitCode: 0,
      output: "ok",
    }),
    getState: () => ({
      channel: { workingDir: "/tmp/work" },
      history: [
        { role: "user" as const, content: "hello" },
        { role: "assistant" as const, content: "world" },
      ],
    }),
    compactHistory: () => "summary",
    appendTurn: () => undefined,
    setSessionModel: (channelId: string, model: string) => {
      store.modelByChannel.set(channelId, model);
    },
    stopControllerSetModel: async () => undefined,
    stopControllerIsActive: () => false,
    stopControllerAbort: (channelId: string) => {
      store.stopAbortCalls.push(channelId);
      return true;
    },
  };

  return { deps, store };
}

describe("session slash MCP tools", () => {
  test("builds expected tool set", () => {
    const { deps } = buildDeps();
    const tools = createSessionSlashMcpTools(deps);
    expect(tools.map((tool) => tool.name)).toEqual([
      "discord_cost",
      "discord_new",
      "discord_compact",
      "discord_model",
      "discord_stop",
      "discord_bash",
      "discord_systemprompt",
      "discord_mentions",
      "discord_mode",
    ]);
  });

  test("systemprompt set reuses action and resets session mode", () => {
    const { deps, store } = buildDeps();
    const tools = createSessionSlashMcpTools(deps);
    const tool = tools.find((item) => item.name === "discord_systemprompt");
    expect(tool).toBeDefined();
    const output = tool?.execute({
      channelId: "c1",
      action: "set",
      text: "Be concise.",
    });

    expect(output).toMatchObject({ ok: true, action: "systemprompt" });
    expect(store.systemPromptByChannel.get("c1")).toBe("Be concise.");
    expect(store.resetCalls).toEqual(["c1"]);
    expect(store.clearPermissionCalls).toEqual(["c1"]);
  });

  test("mentions set validates mode through shared action", () => {
    const { deps } = buildDeps();
    const tools = createSessionSlashMcpTools(deps);
    const tool = tools.find((item) => item.name === "discord_mentions");
    expect(tool).toBeDefined();
    const output = tool?.execute({
      channelId: "c2",
      action: "set",
      mode: "invalid",
    });

    expect(output).toMatchObject({
      ok: false,
      action: "mentions",
    });
  });
});
