import { describe, expect, test } from "bun:test";
import { GuardianSupervisor } from "../src/guardian/supervisor";
import type { GuardianConfig } from "../src/guardian/types";

function buildGuardianConfig(): GuardianConfig {
  return {
    controlBind: "127.0.0.1",
    controlPort: 8787,
    controlSecret: "secret",
    controlSecretSource: "env",
    controlSecretFile: "./data/guardian-control.secret",
    workerHeartbeatFile: "./data/worker-heartbeat.json",
    workerHeartbeatIntervalSeconds: 10,
    heartbeatTimeoutMs: 45_000,
    heartbeatCheckIntervalMs: 5_000,
    restartBaseMs: 1_000,
    restartMaxMs: 30_000,
    restartWindowMs: 5 * 60_000,
    restartMaxCount: 12,
    restartCooldownMs: 120_000,
    logTailLimit: 200,
    signatureMaxSkewMs: 300_000,
    signatureNonceTtlMs: 600_000,
  };
}

describe("GuardianSupervisor", () => {
  test("rolls back worker startup when control API bind fails", async () => {
    const supervisor = new GuardianSupervisor(buildGuardianConfig());

    let startWorkerCalls = 0;
    let stopWorkerCalls = 0;
    (supervisor as unknown as { startWorker: () => Promise<boolean> }).startWorker = async () => {
      startWorkerCalls += 1;
      (
        supervisor as unknown as {
          child: { pid: number; kill: () => void; exited: Promise<number> };
        }
      ).child = {
        pid: 12345,
        kill: () => {},
        exited: Promise.resolve(0),
      };
      return true;
    };
    (supervisor as unknown as { stopWorker: () => Promise<void> }).stopWorker = async () => {
      stopWorkerCalls += 1;
    };

    const bunMutable = Bun as unknown as { serve: typeof Bun.serve };
    const originalServe = bunMutable.serve;
    bunMutable.serve = (() => {
      throw new Error("EADDRINUSE");
    }) as typeof Bun.serve;

    try {
      await expect(supervisor.start()).rejects.toThrow("EADDRINUSE");
    } finally {
      bunMutable.serve = originalServe;
    }

    expect(startWorkerCalls).toBe(1);
    expect(stopWorkerCalls).toBe(1);
  });
});
