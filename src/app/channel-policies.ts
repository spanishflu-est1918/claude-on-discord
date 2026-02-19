import type { ClaudePermissionMode } from "../types";
import type { ChannelMentionsMode, Repository } from "../db/repository";

export type MentionPolicy = {
  requireMention: boolean;
  mode: ChannelMentionsMode;
};

export type PermissionPolicy = {
  permissionMode: ClaudePermissionMode;
  mode: ClaudePermissionMode | "default";
};

export function createMentionPolicyResolver(input: {
  repository: Repository;
  defaultRequireMention: boolean;
}): (channelId: string) => MentionPolicy {
  return (channelId: string) => {
    const mode = input.repository.getChannelMentionsMode(channelId) ?? "default";
    if (mode === "required") {
      return { requireMention: true, mode };
    }
    if (mode === "off") {
      return { requireMention: false, mode };
    }
    return { requireMention: input.defaultRequireMention, mode };
  };
}

function resolvePermissionMode(input: {
  sessionPermissionMode?: ClaudePermissionMode;
  defaultPermissionMode: ClaudePermissionMode;
}): PermissionPolicy {
  const mode = input.sessionPermissionMode ?? "default";
  if (mode === "default") {
    return { permissionMode: input.defaultPermissionMode, mode };
  }
  return { permissionMode: mode, mode };
}

export function createSessionPermissionModeStore(defaultPermissionMode: ClaudePermissionMode): {
  resolve: (sessionId?: string | null) => PermissionPolicy;
  set: (sessionId: string, mode: ClaudePermissionMode | "default") => void;
  clear: (sessionId: string) => void;
} {
  const sessionPermissionModeById = new Map<string, ClaudePermissionMode>();

  return {
    resolve: (sessionId?: string | null) =>
      resolvePermissionMode({
        sessionPermissionMode: sessionId ? sessionPermissionModeById.get(sessionId) : undefined,
        defaultPermissionMode,
      }),
    set: (sessionId: string, mode: ClaudePermissionMode | "default") => {
      if (mode === "default") {
        sessionPermissionModeById.delete(sessionId);
        return;
      }
      sessionPermissionModeById.set(sessionId, mode);
    },
    clear: (sessionId: string) => {
      sessionPermissionModeById.delete(sessionId);
    },
  };
}
