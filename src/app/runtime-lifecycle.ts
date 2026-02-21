import type { StopController } from "../claude/stop";
import type { ThreadDebugger } from "./thread-debugger";
import type { WorkerHeartbeatManager } from "./worker-heartbeat";

export function createRuntimeLifecycleManager(input: {
  stopController: StopController;
  clearSessionPermissionMode: (channelId: string) => void;
  setSessionId: (channelId: string, sessionId: string | null) => void;
  activeRunMaxAgeMs: number;
  activeRunWatchdogIntervalMs: number;
  isShuttingDown: () => boolean;
  setShuttingDown: (value: boolean) => void;
  clearTransientState: () => void;
  runner: { closeAll?: () => void };
  workerHeartbeatManager: WorkerHeartbeatManager;
  getDiscordClient: () => { destroy: () => void } | null;
  closeDatabase: () => void;
  threadDebugger?: ThreadDebugger;
}): {
  clearActiveRunsWithSessionReset: (reason: string) => void;
  abortChannelRunWithSessionReset: (channelId: string, reason: string) => boolean;
  startStaleRunWatchdog: () => void;
  shutdown: (reason: string) => Promise<void>;
} {
  let staleRunWatchdog: ReturnType<typeof setInterval> | null = null;
  let shutdownPromise: Promise<void> | null = null;

  const clearActiveRunsWithSessionReset = (reason: string): void => {
    const activeChannelIds = input.stopController.getActiveChannelIds();
    input.threadDebugger?.log({
      event: "runtime.clear_active_runs.start",
      detail: { reason, activeChannels: activeChannelIds },
    });
    if (activeChannelIds.length === 0) {
      return;
    }
    for (const activeChannelId of activeChannelIds) {
      input.clearSessionPermissionMode(activeChannelId);
      input.setSessionId(activeChannelId, null);
    }
    const aborted = input.stopController.abortAll();
    console.warn(`Cleared ${aborted.length} active run(s) due to ${reason}.`);
    input.threadDebugger?.log({
      event: "runtime.clear_active_runs.end",
      detail: { reason, abortedChannels: aborted },
    });
  };

  const abortChannelRunWithSessionReset = (channelId: string, reason: string): boolean => {
    input.threadDebugger?.log({
      event: "runtime.abort_channel.start",
      channelId,
      detail: { reason },
    });
    const aborted = input.stopController.abort(channelId);
    if (!aborted) {
      input.threadDebugger?.log({
        event: "runtime.abort_channel.miss",
        channelId,
        detail: { reason },
      });
      return false;
    }
    input.clearSessionPermissionMode(channelId);
    input.setSessionId(channelId, null);
    console.warn(`Aborted active run for channel ${channelId} (${reason}).`);
    input.threadDebugger?.log({
      event: "runtime.abort_channel.done",
      channelId,
      detail: { reason },
    });
    return true;
  };

  const startStaleRunWatchdog = (): void => {
    if (staleRunWatchdog) {
      return;
    }
    staleRunWatchdog = setInterval(() => {
      if (input.isShuttingDown()) {
        return;
      }
      const staleChannelIds = input.stopController.abortOlderThan(input.activeRunMaxAgeMs);
      if (staleChannelIds.length === 0) {
        return;
      }
      for (const staleChannelId of staleChannelIds) {
        input.clearSessionPermissionMode(staleChannelId);
        input.setSessionId(staleChannelId, null);
      }
      console.warn(`Reaped ${staleChannelIds.length} stale active run(s).`);
      input.threadDebugger?.log({
        event: "runtime.stale_runs_reaped",
        detail: { staleChannelIds, maxAgeMs: input.activeRunMaxAgeMs },
      });
    }, input.activeRunWatchdogIntervalMs);
    staleRunWatchdog.unref?.();
  };

  const shutdown = async (reason: string): Promise<void> => {
    if (shutdownPromise) {
      return shutdownPromise;
    }
    input.setShuttingDown(true);
    input.threadDebugger?.log({
      event: "runtime.shutdown.start",
      detail: { reason },
    });
    shutdownPromise = (async () => {
      console.log(`Shutting down (${reason})...`);
      input.clearTransientState();
      clearActiveRunsWithSessionReset(`shutdown:${reason}`);
      if (typeof input.runner.closeAll === "function") {
        input.runner.closeAll();
      }
      if (staleRunWatchdog) {
        clearInterval(staleRunWatchdog);
        staleRunWatchdog = null;
      }
      input.workerHeartbeatManager.stop();

      const discordClient = input.getDiscordClient();
      if (discordClient) {
        try {
          discordClient.destroy();
        } catch (error) {
          console.error("Failed to destroy Discord client during shutdown", error);
        }
      }

      try {
        input.closeDatabase();
      } catch (error) {
        console.error("Failed to close database during shutdown", error);
      }

      console.log("Shutdown complete.");
      input.threadDebugger?.log({
        event: "runtime.shutdown.complete",
        detail: { reason },
      });
    })();

    return shutdownPromise;
  };

  return {
    clearActiveRunsWithSessionReset,
    abortChannelRunWithSessionReset,
    startStaleRunWatchdog,
    shutdown,
  };
}
