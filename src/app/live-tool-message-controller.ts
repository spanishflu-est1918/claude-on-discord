import type { DiscordDispatchQueue } from "../discord/dispatcher";
import { canEditSentMessage, type EditableSentMessage } from "./thread-lifecycle";
import {
  buildSingleLiveToolMessage,
  type LiveToolRenderPayload,
  type LiveToolTrace,
} from "./live-tools";

const TOOL_RENDER_POLL_INTERVAL_MS = 1000;

type ToolSendTarget = {
  send: (payload: unknown) => Promise<unknown>;
};

export function createLiveToolMessageController(input: {
  channelId: string;
  runToolTrace: LiveToolTrace;
  discordDispatch: DiscordDispatchQueue;
  toolSendTarget: ToolSendTarget | null;
  getToolExpanded: (toolId: string) => boolean;
}) {
  const { channelId, runToolTrace, discordDispatch, toolSendTarget, getToolExpanded } = input;
  const toolMessagesById = new Map<string, EditableSentMessage>();
  const pendingToolMessageContent = new Map<string, LiveToolRenderPayload>();
  const toolMessageEditInFlight = new Set<string>();
  let pollTimer: ReturnType<typeof setInterval> | null = null;

  const queueToolMessageRender = (toolId: string) => {
    const entry = runToolTrace.byId.get(toolId);
    if (!entry || !toolSendTarget) {
      return;
    }
    pendingToolMessageContent.set(
      toolId,
      buildSingleLiveToolMessage(entry, {
        channelId,
        expanded: getToolExpanded(toolId),
      }),
    );
    if (toolMessageEditInFlight.has(toolId)) {
      return;
    }
    toolMessageEditInFlight.add(toolId);
    void (async () => {
      while (pendingToolMessageContent.has(toolId)) {
        const nextContent = pendingToolMessageContent.get(toolId);
        pendingToolMessageContent.delete(toolId);
        if (!nextContent) {
          continue;
        }
        try {
          const existing = toolMessagesById.get(toolId);
          if (existing) {
            await discordDispatch.enqueue(`tool:${channelId}:${toolId}`, async () => {
              await existing.edit(nextContent);
            });
          } else {
            const sent = await discordDispatch.enqueue(
              `tool:${channelId}:${toolId}`,
              async () => await toolSendTarget.send(nextContent),
            );
            if (canEditSentMessage(sent)) {
              toolMessagesById.set(toolId, sent);
            }
          }
        } catch {
          // Ignore tool message send/edit failures to keep primary run stable.
        }
      }
      toolMessageEditInFlight.delete(toolId);
    })();
  };

  return {
    queueToolMessageRender,
    startPolling() {
      if (pollTimer) {
        return;
      }
      pollTimer = setInterval(() => {
        for (const toolId of runToolTrace.order) {
          const entry = runToolTrace.byId.get(toolId);
          if (!entry) {
            continue;
          }
          if (entry.status === "running" || entry.status === "queued") {
            queueToolMessageRender(toolId);
          }
        }
      }, TOOL_RENDER_POLL_INTERVAL_MS);
    },
    stopPolling() {
      if (!pollTimer) {
        return;
      }
      clearInterval(pollTimer);
      pollTimer = null;
    },
  };
}
