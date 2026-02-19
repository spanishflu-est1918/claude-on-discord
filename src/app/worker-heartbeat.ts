import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";

export type WorkerHeartbeatManager = {
  start: () => Promise<void>;
  stop: () => void;
};

export function createWorkerHeartbeatManagerFromEnv(
  env: Record<string, string | undefined> = process.env,
): WorkerHeartbeatManager {
  const heartbeatFile = env.WORKER_HEARTBEAT_FILE?.trim();
  const intervalSecondsRaw = env.WORKER_HEARTBEAT_INTERVAL_SECONDS?.trim();
  const intervalSeconds = intervalSecondsRaw ? Number.parseInt(intervalSecondsRaw, 10) : 10;
  const intervalMs =
    Number.isFinite(intervalSeconds) && intervalSeconds > 0 ? intervalSeconds * 1000 : 10_000;

  let timer: ReturnType<typeof setInterval> | null = null;
  let writeFailed = false;

  const writeHeartbeat = async (): Promise<void> => {
    if (!heartbeatFile) {
      return;
    }
    try {
      await writeFile(
        heartbeatFile,
        JSON.stringify({ pid: process.pid, timestampMs: Date.now() }),
        "utf8",
      );
      writeFailed = false;
    } catch (error) {
      if (!writeFailed) {
        const detail = error instanceof Error ? error.message : String(error);
        console.warn(`Failed to write worker heartbeat: ${detail}`);
        writeFailed = true;
      }
    }
  };

  return {
    start: async () => {
      if (!heartbeatFile) {
        return;
      }
      try {
        await mkdir(path.dirname(heartbeatFile), { recursive: true });
      } catch {
        // Ignore heartbeat directory errors; heartbeat writes log failures if they persist.
      }

      await writeHeartbeat();
      timer = setInterval(() => {
        void writeHeartbeat();
      }, intervalMs);
      timer.unref?.();
    },
    stop: () => {
      if (!timer) {
        return;
      }
      clearInterval(timer);
      timer = null;
    },
  };
}
