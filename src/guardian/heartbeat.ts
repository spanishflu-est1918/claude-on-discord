import { existsSync, statSync } from "node:fs";

export function getGuardianHeartbeatAgeMs(input: {
  childStartedAtMs: number | null;
  heartbeatFile: string;
  nowMs: number;
}): number | null {
  if (!input.childStartedAtMs) {
    return null;
  }
  if (!existsSync(input.heartbeatFile)) {
    return null;
  }
  try {
    const stat = statSync(input.heartbeatFile);
    if (stat.mtimeMs + 1000 < input.childStartedAtMs) {
      return null;
    }
    return Math.max(0, input.nowMs - stat.mtimeMs);
  } catch {
    return null;
  }
}
