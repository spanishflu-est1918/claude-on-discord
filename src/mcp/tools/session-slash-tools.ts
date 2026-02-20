import type { ChannelMentionsMode } from "../../db/repository";
import type { ClaudePermissionMode } from "../../types";
import { slashActionCatalog } from "../../app/command-actions/slash-action-catalog";
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
};

export type SessionSlashToolOutput = {
  ok: boolean;
  message: string;
  action: "cost" | "mentions" | "mode" | "systemprompt";
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
