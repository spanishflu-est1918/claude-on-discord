import type { QueueNoticeInfo } from "./button-interactions";
import type { DiffContext } from "./diff-worktree";
import type { LiveToolTrace } from "./live-tools";

export function createAppRuntimeState(): {
  pendingProjectSwitches: Map<string, { channelId: string; guildId: string; workingDir: string }>;
  pendingDiffViews: Map<string, DiffContext>;
  pendingMessageRunsByChannel: Map<string, Promise<void>>;
  pendingRunAbortControllersByChannel: Map<string, AbortController>;
  queuedNoticesByMessageId: Map<string, QueueNoticeInfo>;
  liveToolTracesByChannel: Map<string, LiveToolTrace>;
  liveToolExpandStateByChannel: Map<string, Map<string, boolean>>;
  suspendedChannels: Set<string>;
  getToolExpanded: (channelId: string, toolId: string) => boolean;
  setToolExpanded: (channelId: string, toolId: string, expanded: boolean) => void;
  rememberDiffView: (requestId: string, context: DiffContext) => void;
  clearTransientState: () => void;
} {
  const pendingProjectSwitches = new Map<
    string,
    { channelId: string; guildId: string; workingDir: string }
  >();
  const pendingDiffViews = new Map<string, DiffContext>();
  const pendingMessageRunsByChannel = new Map<string, Promise<void>>();
  const pendingRunAbortControllersByChannel = new Map<string, AbortController>();
  const queuedNoticesByMessageId = new Map<string, QueueNoticeInfo>();
  const liveToolTracesByChannel = new Map<string, LiveToolTrace>();
  const liveToolExpandStateByChannel = new Map<string, Map<string, boolean>>();
  const suspendedChannels = new Set<string>();

  const getToolExpanded = (channelId: string, toolId: string): boolean => {
    const channelState = liveToolExpandStateByChannel.get(channelId);
    if (!channelState) {
      return false;
    }
    return channelState.get(toolId) ?? false;
  };

  const setToolExpanded = (channelId: string, toolId: string, expanded: boolean): void => {
    const channelState = liveToolExpandStateByChannel.get(channelId) ?? new Map<string, boolean>();
    channelState.set(toolId, expanded);
    liveToolExpandStateByChannel.set(channelId, channelState);
  };

  const rememberDiffView = (requestId: string, context: DiffContext): void => {
    pendingDiffViews.set(requestId, context);
    while (pendingDiffViews.size > 250) {
      const oldest = pendingDiffViews.keys().next().value;
      if (!oldest) {
        break;
      }
      pendingDiffViews.delete(oldest);
    }
  };

  const clearTransientState = (): void => {
    pendingProjectSwitches.clear();
    pendingDiffViews.clear();
    pendingRunAbortControllersByChannel.clear();
    liveToolTracesByChannel.clear();
    liveToolExpandStateByChannel.clear();
  };

  return {
    pendingProjectSwitches,
    pendingDiffViews,
    pendingMessageRunsByChannel,
    pendingRunAbortControllersByChannel,
    queuedNoticesByMessageId,
    liveToolTracesByChannel,
    liveToolExpandStateByChannel,
    suspendedChannels,
    getToolExpanded,
    setToolExpanded,
    rememberDiffView,
    clearTransientState,
  };
}
