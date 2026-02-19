import type { Repository } from "../db/repository";
import type { ClaudePermissionMode } from "../types";
import type { PermissionPolicy } from "./channel-policies";

type SessionPermissionModeStore = {
  resolve: (sessionId?: string | null) => PermissionPolicy;
  set: (sessionId: string, mode: ClaudePermissionMode | "default") => void;
  clear: (sessionId: string) => void;
};

export function createSessionPermissionBindings(input: {
  repository: Pick<Repository, "getChannel">;
  store: SessionPermissionModeStore;
}): {
  getActiveSessionId: (channelId: string) => string | null;
  resolvePermissionModeForSession: (channelId: string) => PermissionPolicy;
  setSessionPermissionMode: (channelId: string, mode: ClaudePermissionMode | "default") => void;
  clearSessionPermissionMode: (channelId: string) => void;
} {
  const getActiveSessionId = (channelId: string): string | null =>
    input.repository.getChannel(channelId)?.sessionId ?? null;

  const resolvePermissionModeForSession = (channelId: string): PermissionPolicy =>
    input.store.resolve(getActiveSessionId(channelId));

  const setSessionPermissionMode = (
    channelId: string,
    mode: ClaudePermissionMode | "default",
  ): void => {
    const sessionId = getActiveSessionId(channelId);
    if (!sessionId) {
      return;
    }
    input.store.set(sessionId, mode);
  };

  const clearSessionPermissionMode = (channelId: string): void => {
    const sessionId = getActiveSessionId(channelId);
    if (!sessionId) {
      return;
    }
    input.store.clear(sessionId);
  };

  return {
    getActiveSessionId,
    resolvePermissionModeForSession,
    setSessionPermissionMode,
    clearSessionPermissionMode,
  };
}
