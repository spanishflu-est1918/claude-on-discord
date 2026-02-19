import type { WorkerExitInfo } from "./types";

export type GuardianStatusSnapshot = {
  ok: true;
  guardianPid: number;
  uptimeMs: number;
  worker: {
    running: boolean;
    pid: number | null;
    startedAtMs: number | null;
    heartbeatAgeMs: number | null;
    staleHeartbeat: boolean;
    lastExit: WorkerExitInfo | null;
    manualStop: boolean;
    cooldownRemainingMs: number;
    recentRestartCount: number;
  };
};

export function buildGuardianStatusSnapshot(input: {
  nowMs: number;
  startedAtMs: number;
  guardianPid: number;
  childPid: number | null;
  childStartedAtMs: number | null;
  heartbeatAgeMs: number | null;
  heartbeatTimeoutMs: number;
  lastExit: WorkerExitInfo | null;
  manualStop: boolean;
  cooldownUntilMs: number;
  restartHistoryCount: number;
}): GuardianStatusSnapshot {
  const cooldownRemainingMs = input.cooldownUntilMs > input.nowMs ? input.cooldownUntilMs - input.nowMs : 0;
  return {
    ok: true,
    guardianPid: input.guardianPid,
    uptimeMs: input.nowMs - input.startedAtMs,
    worker: {
      running: Boolean(input.childPid),
      pid: input.childPid,
      startedAtMs: input.childStartedAtMs,
      heartbeatAgeMs: input.heartbeatAgeMs,
      staleHeartbeat:
        typeof input.heartbeatAgeMs === "number" && input.heartbeatAgeMs > input.heartbeatTimeoutMs,
      lastExit: input.lastExit,
      manualStop: input.manualStop,
      cooldownRemainingMs,
      recentRestartCount: input.restartHistoryCount,
    },
  };
}
