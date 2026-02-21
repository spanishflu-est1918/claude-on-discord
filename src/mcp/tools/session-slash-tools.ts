import { slashActionCatalog } from "../../app/command-actions/slash-action-catalog";
import type { ChannelMentionsMode } from "../../db/repository";
import type { ClaudePermissionMode } from "../../types";
import type { McpToolDefinition } from "./types";

type SessionToolDeps = {
  defaultRequireMention: boolean;
  defaultPermissionMode: ClaudePermissionMode;
  getChannelCostTotal: (channelId: string) => number;
  getChannelTurnCount: (channelId: string) => number;
  setChannelSystemPrompt: (channelId: string, text: string) => void;
  getChannelSystemPrompt: (channelId: string) => string | null;
  clearChannelSystemPrompt: (channelId: string) => void;
  setChannelMentionsMode: (channelId: string, mode: ChannelMentionsMode) => void;
  clearChannelMentionsMode: (channelId: string) => void;
  resetSessionId: (channelId: string) => void;
  getActiveSessionId: (channelId: string) => string | null;
  setSessionPermissionMode: (channelId: string, mode: ClaudePermissionMode | "default") => void;
  clearSessionPermissionMode: (channelId: string) => void;
  resolveMentionRequirementForChannel: (channelId: string) => {
    requireMention: boolean;
    mode: string;
  };
  resolvePermissionModeForSession: (channelId: string) => {
    mode: string;
    permissionMode: ClaudePermissionMode;
  };
  getState: (
    channelId: string,
    guildId: string,
  ) => {
    channel: { workingDir: string };
    history: Array<{ role: "user" | "assistant"; content: string }>;
  };
  compactHistory: (
    history: Array<{ role: "user" | "assistant"; content: string }>,
    maxLines?: number,
  ) => string;
  appendTurn: (channelId: string, turn: { role: "assistant" | "user"; content: string }) => void;
  setSessionModel: (channelId: string, model: string) => void;
  stopControllerSetModel: (channelId: string, model: string) => Promise<void>;
  stopControllerIsActive: (channelId: string) => boolean;
  stopControllerAbort: (channelId: string) => boolean;
  runBashCommand: (command: string, cwd: string) => Promise<{ exitCode: number; output: string }>;
};

export type SessionSlashToolOutput = {
  ok: boolean;
  message: string;
  action:
    | "cost"
    | "mentions"
    | "mode"
    | "systemprompt"
    | "new"
    | "compact"
    | "model"
    | "stop"
    | "bash";
};

export function createSessionSlashMcpTools(
  deps: SessionToolDeps,
): Array<McpToolDefinition<Record<string, unknown>, SessionSlashToolOutput>> {
  return [
    {
      name: "discord_cost",
      description: "Return spend + turn count for a Discord channel session.",
      inputSchema: {
        type: "object",
        properties: {
          channelId: { type: "string" },
        },
        required: ["channelId"],
      },
      execute: (input) => {
        const channelId = String(input.channelId ?? "");
        const result = slashActionCatalog.cost({
          channelId,
          getChannelCostTotal: deps.getChannelCostTotal,
          getChannelTurnCount: deps.getChannelTurnCount,
        });
        return {
          ok: true,
          action: "cost",
          message: result.message,
        };
      },
    },
    {
      name: "discord_new",
      description: "Reset session context for a channel using the same action path as /new.",
      inputSchema: {
        type: "object",
        properties: {
          channelId: { type: "string" },
        },
        required: ["channelId"],
      },
      execute: (input) => {
        const channelId = String(input.channelId ?? "");
        const result = slashActionCatalog.newSession({
          channelId,
          clearSessionPermissionMode: deps.clearSessionPermissionMode,
          resetSession: deps.resetSessionId,
        });
        return {
          ok: true,
          action: "new",
          message: result.message,
        };
      },
    },
    {
      name: "discord_compact",
      description:
        "Compact channel context and reset session using the same action path as /compact.",
      inputSchema: {
        type: "object",
        properties: {
          channelId: { type: "string" },
          guildId: { type: "string" },
        },
        required: ["channelId", "guildId"],
      },
      execute: (input) => {
        const channelId = String(input.channelId ?? "");
        const guildId = String(input.guildId ?? "");
        const result = slashActionCatalog.compact({
          channelId,
          guildId,
          getState: deps.getState,
          compactHistory: deps.compactHistory,
          clearSessionPermissionMode: deps.clearSessionPermissionMode,
          resetSession: deps.resetSessionId,
          appendTurn: deps.appendTurn,
        });
        return {
          ok: true,
          action: "compact",
          message: result.message,
        };
      },
    },
    {
      name: "discord_model",
      description: "Set channel model using the same action path as /model.",
      inputSchema: {
        type: "object",
        properties: {
          channelId: { type: "string" },
          model: { type: "string" },
        },
        required: ["channelId", "model"],
      },
      execute: async (input) => {
        const channelId = String(input.channelId ?? "");
        const model = String(input.model ?? "");
        const result = await slashActionCatalog.model({
          channelId,
          model,
          setSessionModel: deps.setSessionModel,
          stopControllerSetModel: deps.stopControllerSetModel,
        });
        return {
          ok: true,
          action: "model",
          message: result.message,
        };
      },
    },
    {
      name: "discord_stop",
      description: "Abort an active channel run using the same action path as /stop.",
      inputSchema: {
        type: "object",
        properties: {
          channelId: { type: "string" },
        },
        required: ["channelId"],
      },
      execute: (input) => {
        const channelId = String(input.channelId ?? "");
        const result = slashActionCatalog.stop({
          channelId,
          isActive: deps.stopControllerIsActive,
          abort: deps.stopControllerAbort,
        });
        return {
          ok: true,
          action: "stop",
          message: result.message,
        };
      },
    },
    {
      name: "discord_bash",
      description:
        "Run a shell command in the channel working directory via the shared /bash action.",
      inputSchema: {
        type: "object",
        properties: {
          channelId: { type: "string" },
          guildId: { type: "string" },
          command: { type: "string" },
        },
        required: ["channelId", "guildId", "command"],
      },
      execute: async (input) => {
        const channelId = String(input.channelId ?? "");
        const guildId = String(input.guildId ?? "");
        const command = String(input.command ?? "");
        const state = deps.getState(channelId, guildId);
        const result = await slashActionCatalog.bash({
          command,
          workingDir: state.channel.workingDir,
          runBashCommand: deps.runBashCommand,
        });
        return {
          ok: true,
          action: "bash",
          message: `exit=${result.exitCode}\n${result.payload}`,
        };
      },
    },
    {
      name: "discord_systemprompt",
      description:
        "Set/show/clear channel system prompt using the same action path as /systemprompt.",
      inputSchema: {
        type: "object",
        properties: {
          channelId: { type: "string" },
          action: { enum: ["set", "show", "clear"] },
          text: { type: "string" },
        },
        required: ["channelId", "action"],
      },
      execute: (input) => {
        const channelId = String(input.channelId ?? "");
        const actionRaw = String(input.action ?? "show");
        const result = slashActionCatalog.systemprompt({
          channelId,
          action:
            actionRaw === "set"
              ? { type: "set", text: String(input.text ?? "") }
              : actionRaw === "show"
                ? { type: "show" }
                : { type: "clear" },
          setChannelSystemPrompt: deps.setChannelSystemPrompt,
          getChannelSystemPrompt: deps.getChannelSystemPrompt,
          clearChannelSystemPrompt: deps.clearChannelSystemPrompt,
        });

        if (result.ok && result.resetSession) {
          deps.resetSessionId(channelId);
        }
        if (result.ok && result.clearSessionPermissionOverride) {
          deps.clearSessionPermissionMode(channelId);
        }

        return {
          ok: result.ok,
          action: "systemprompt",
          message:
            result.ok && result.showPrompt
              ? `Channel system prompt (\`${result.showPrompt.text.length}\` chars).`
              : result.message,
        };
      },
    },
    {
      name: "discord_mentions",
      description: "Set/show/clear mention policy using the same action path as /mentions.",
      inputSchema: {
        type: "object",
        properties: {
          channelId: { type: "string" },
          action: { enum: ["set", "show", "clear"] },
          mode: { enum: ["default", "required", "off"] },
        },
        required: ["channelId", "action"],
      },
      execute: (input) => {
        const channelId = String(input.channelId ?? "");
        const actionRaw = String(input.action ?? "show");
        const result = slashActionCatalog.mentions({
          channelId,
          action:
            actionRaw === "set"
              ? { type: "set", mode: String(input.mode ?? "") }
              : actionRaw === "show"
                ? { type: "show" }
                : { type: "clear" },
          defaultRequireMention: deps.defaultRequireMention,
          setChannelMentionsMode: deps.setChannelMentionsMode,
          clearChannelMentionsMode: deps.clearChannelMentionsMode,
          resolveMentionRequirementForChannel: deps.resolveMentionRequirementForChannel,
        });
        return {
          ok: result.ok,
          action: "mentions",
          message: result.message,
        };
      },
    },
    {
      name: "discord_mode",
      description: "Set/show/clear session permission mode using the same action path as /mode.",
      inputSchema: {
        type: "object",
        properties: {
          channelId: { type: "string" },
          action: { enum: ["set", "show", "clear"] },
          mode: {
            enum: ["default", "plan", "acceptEdits", "bypassPermissions", "delegate", "dontAsk"],
          },
        },
        required: ["channelId", "action"],
      },
      execute: (input) => {
        const channelId = String(input.channelId ?? "");
        const actionRaw = String(input.action ?? "show");
        const result = slashActionCatalog.mode({
          channelId,
          action:
            actionRaw === "set"
              ? { type: "set", mode: String(input.mode ?? "") }
              : actionRaw === "show"
                ? { type: "show" }
                : { type: "clear" },
          defaultPermissionMode: deps.defaultPermissionMode,
          getActiveSessionId: deps.getActiveSessionId,
          setSessionPermissionMode: deps.setSessionPermissionMode,
          clearSessionPermissionMode: deps.clearSessionPermissionMode,
          resolvePermissionModeForSession: deps.resolvePermissionModeForSession,
        });
        return {
          ok: result.ok,
          action: "mode",
          message: result.message,
        };
      },
    },
  ];
}
