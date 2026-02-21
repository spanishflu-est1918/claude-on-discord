import type { MessageEditOptions } from "discord.js";
import { buildStopButtons } from "../discord/buttons";
import type { DiscordDispatchQueue } from "../discord/dispatcher";
import { THINKING_SPINNER_FRAMES, toStreamingPreview } from "./live-tools";

const STREAM_PREVIEW_DEBOUNCE_MS = 300;
const STREAM_SPINNER_INTERVAL_MS = 900;

type StatusEdit = { content: string; includeButtons: boolean };

type EditableStatusMessage = {
  edit: (payload: MessageEditOptions) => Promise<unknown>;
};

export function createStreamingStatusController(input: {
  channelId: string;
  status: EditableStatusMessage;
  discordDispatch: DiscordDispatchQueue;
}) {
  const { channelId, status, discordDispatch } = input;
  let streamedText = "";
  let streamedThinking = "";
  let closed = false;
  let streamFlushTimer: ReturnType<typeof setTimeout> | null = null;
  let spinnerTimer: ReturnType<typeof setInterval> | null = null;
  let spinnerFrameIndex = 0;
  let statusEditQueue: Promise<void> = Promise.resolve();
  let statusEditInFlight = false;
  let pendingStatusEdit: StatusEdit | null = null;
  let closePromise: Promise<void> | null = null;

  const queueStatusEdit = (content: string, includeButtons: boolean): Promise<void> => {
    pendingStatusEdit = { content, includeButtons };
    if (statusEditInFlight) {
      return statusEditQueue;
    }

    statusEditInFlight = true;
    statusEditQueue = (async () => {
      while (pendingStatusEdit) {
        const edit = pendingStatusEdit;
        pendingStatusEdit = null;
        try {
          await discordDispatch.enqueue(`status:${channelId}`, async () => {
            await status.edit({
              content: edit.content,
              components: edit.includeButtons ? buildStopButtons(channelId) : [],
            });
          });
        } catch {
          // Ignore transient edit failures to keep stream moving.
        }
      }
      statusEditInFlight = false;
    })();
    return statusEditQueue;
  };

  const flushStreamPreview = () => {
    streamFlushTimer = null;
    if (closed) {
      return;
    }
    void queueStatusEdit(
      toStreamingPreview(
        streamedText,
        streamedThinking,
        THINKING_SPINNER_FRAMES[spinnerFrameIndex % THINKING_SPINNER_FRAMES.length],
      ),
      true,
    );
  };

  const scheduleStreamPreview = () => {
    if (closed || streamFlushTimer) {
      return;
    }
    streamFlushTimer = setTimeout(flushStreamPreview, STREAM_PREVIEW_DEBOUNCE_MS);
  };

  const stopSpinner = () => {
    if (!spinnerTimer) {
      return;
    }
    clearInterval(spinnerTimer);
    spinnerTimer = null;
  };

  spinnerTimer = setInterval(() => {
    if (closed) {
      return;
    }
    spinnerFrameIndex = (spinnerFrameIndex + 1) % THINKING_SPINNER_FRAMES.length;
    void queueStatusEdit(
      toStreamingPreview(
        streamedText,
        streamedThinking,
        THINKING_SPINNER_FRAMES[spinnerFrameIndex % THINKING_SPINNER_FRAMES.length],
      ),
      true,
    );
  }, STREAM_SPINNER_INTERVAL_MS);

  return {
    appendText(textDelta: string) {
      streamedText += textDelta;
      scheduleStreamPreview();
    },
    appendThinking(thinkingDelta: string) {
      streamedThinking += thinkingDelta;
      scheduleStreamPreview();
    },
    buildFinalPreview(finalText: string): string {
      return toStreamingPreview(finalText, streamedThinking);
    },
    async close(options: { drain?: boolean } = {}): Promise<void> {
      if (closePromise) {
        return await closePromise;
      }
      const shouldDrain = options.drain ?? true;
      closePromise = (async () => {
        if (streamFlushTimer) {
          clearTimeout(streamFlushTimer);
          streamFlushTimer = null;
        }
        stopSpinner();
        closed = true;
        pendingStatusEdit = null;
        if (shouldDrain) {
          await statusEditQueue;
        }
      })();
      return await closePromise;
    },
  };
}
