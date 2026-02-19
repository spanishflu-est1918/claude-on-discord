import type { ClaudePermissionMode } from "../../types";

export const PERMISSION_MODES = [
  "default",
  "plan",
  "acceptEdits",
  "bypassPermissions",
  "delegate",
  "dontAsk",
] as const;

type PermissionModeValue = (typeof PERMISSION_MODES)[number];
export type PermissionModeAction =
  | { type: "set"; mode: string }
  | { type: "show" }
  | { type: "clear" };

export type PermissionModeActionResult =
  | { ok: false; message: string }
  | { ok: true; message: string; shouldReplyEphemeral: boolean };

export function runPermissionModeAction(input: {
  channelId: string;
  action: PermissionModeAction;
  defaultPermissionMode: ClaudePermissionMode;
  getActiveSessionId: (channelId: string) => string | null;
  setSessionPermissionMode: (channelId: string, mode: ClaudePermissionMode | "default") => void;
  clearSessionPermissionMode: (channelId: string) => void;
  resolvePermissionModeForSession: (channelId: string) => {
    mode: string;
    permissionMode: ClaudePermissionMode;
  };
}): PermissionModeActionResult {
  if (input.action.type === "set") {
    const sessionId = input.getActiveSessionId(input.channelId);
    if (!sessionId) {
      return {
        ok: false,
        message: "No active session in this channel. Send a message first, then run `/mode set`.",
      };
    }
    const modeRaw = input.action.mode.trim();
    if (!PERMISSION_MODES.includes(modeRaw as PermissionModeValue)) {
      return {
        ok: false,
        message:
          "Invalid mode. Use one of: `default`, `plan`, `acceptEdits`, `bypassPermissions`, `delegate`, `dontAsk`.",
      };
    }
    input.setSessionPermissionMode(input.channelId, modeRaw as ClaudePermissionMode | "default");
    const effective = input.resolvePermissionModeForSession(input.channelId);
    return {
      ok: true,
      message:
        `Permission mode for session \`${sessionId}\` set to \`${modeRaw}\` ` +
        `(effective: \`${effective.permissionMode}\`).`,
      shouldReplyEphemeral: false,
    };
  }

  if (input.action.type === "show") {
    const effective = input.resolvePermissionModeForSession(input.channelId);
    return {
      ok: true,
      message:
        `Permission mode: \`${effective.mode}\`\n` +
        `Effective mode: \`${effective.permissionMode}\`\n` +
        `Global default: \`${input.defaultPermissionMode}\``,
      shouldReplyEphemeral: true,
    };
  }

  const sessionId = input.getActiveSessionId(input.channelId);
  if (!sessionId) {
    return {
      ok: false,
      message: "No active session in this channel. Nothing to clear.",
    };
  }
  input.clearSessionPermissionMode(input.channelId);
  const effective = input.resolvePermissionModeForSession(input.channelId);
  return {
    ok: true,
    message:
      `Session permission mode override cleared for \`${sessionId}\` ` +
      `(effective: \`${effective.permissionMode}\`).`,
    shouldReplyEphemeral: false,
  };
}
