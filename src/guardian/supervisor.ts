import process from "node:process";
import { handleGuardianControlRequest } from "./control-api";
import { isLoopbackAddress } from "./config";
import { getGuardianHeartbeatAgeMs } from "./heartbeat";
import { buildGuardianMobileUrls } from "./mobile-urls";
import { buildGuardianStatusSnapshot } from "./status-snapshot";
import { consumeStreamLines } from "./stream-lines";
import type { GuardianConfig, LogEntry, WorkerExitInfo } from "./types";

export class GuardianSupervisor {
  private readonly startedAtMs = Date.now();
  private readonly nonceExpirations = new Map<string, number>();
  private readonly logs: LogEntry[] = [];
  private readonly restartHistoryMs: number[] = [];
  private child: ReturnType<typeof Bun.spawn> | null = null;
  private childStartedAtMs: number | null = null;
  private lastExit: WorkerExitInfo | null = null;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private shuttingDown = false;
  private stoppingForRestart = false;
  private manualStop = false;
  private restartInFlight = false;
  private cooldownUntilMs = 0;
  private server: ReturnType<typeof Bun.serve> | null = null;

  constructor(private readonly config: GuardianConfig) {}

  async start(): Promise<void> {
    await this.startWorker("initial start", { force: true });
    this.heartbeatTimer = setInterval(() => {
      void this.checkWorkerHeartbeat();
    }, this.config.heartbeatCheckIntervalMs);
    this.heartbeatTimer.unref?.();

    this.server = Bun.serve({
      hostname: this.config.controlBind,
      port: this.config.controlPort,
      fetch: (request) => this.handleRequest(request),
    });
    this.appendLog(
      "guardian",
      `Control API listening on http://${this.config.controlBind}:${this.server.port}`,
    );
    const mobileUrls = this.buildMobileUrls();
    if (mobileUrls.length > 0) {
      this.appendLog("guardian", "Mobile control URL:");
      for (const mobileUrl of mobileUrls) {
        this.appendLog("guardian", `  ${mobileUrl}`);
      }
    }
    if (this.config.controlSecretSource === "generated") {
      this.appendLog(
        "guardian",
        `Generated control secret and saved it to ${this.config.controlSecretFile}.`,
      );
    }
    if (this.config.controlSecretSource === "file") {
      this.appendLog("guardian", `Loaded control secret from ${this.config.controlSecretFile}.`);
    }
    if (this.config.controlSecretSource === "generated-ephemeral") {
      this.appendLog(
        "guardian",
        "Generated an in-memory control secret because persistent secret file write failed.",
      );
    }
    if (!isLoopbackAddress(this.config.controlBind)) {
      this.appendLog(
        "guardian",
        "Warning: control API is bound to a non-loopback address. Keep GUARDIAN_CONTROL_SECRET private.",
      );
    }
  }

  private buildMobileUrls(): string[] {
    if (!this.server) {
      return [];
    }
    const port = this.server.port;
    if (typeof port !== "number") {
      return [];
    }
    return buildGuardianMobileUrls({
      controlBind: this.config.controlBind,
      port,
      controlSecret: this.config.controlSecret,
    });
  }

  async shutdown(reason: string): Promise<void> {
    if (this.shuttingDown) {
      return;
    }
    this.shuttingDown = true;
    this.appendLog("guardian", `Shutting down (${reason})...`);
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    this.server?.stop(true);
    this.server = null;
    await this.stopWorker("guardian shutdown", { manual: true });
    this.appendLog("guardian", "Shutdown complete.");
  }

  private appendLog(stream: LogEntry["stream"], line: string): void {
    const entry: LogEntry = {
      ts: new Date().toISOString(),
      stream,
      line,
    };
    this.logs.push(entry);
    const overflow = this.logs.length - this.config.logTailLimit;
    if (overflow > 0) {
      this.logs.splice(0, overflow);
    }
    if (stream === "stderr") {
      console.error(`[worker:${stream}] ${line}`);
      return;
    }
    const prefix = stream === "guardian" ? "[guardian]" : `[worker:${stream}]`;
    console.log(`${prefix} ${line}`);
  }

  private async startWorker(
    reason: string,
    options: {
      force?: boolean;
    } = {},
  ): Promise<boolean> {
    if (this.child) {
      return false;
    }
    const nowMs = Date.now();
    if (!options.force && this.cooldownUntilMs > nowMs) {
      const waitMs = this.cooldownUntilMs - nowMs;
      this.appendLog(
        "guardian",
        `Start request ignored during cooldown (${Math.ceil(waitMs / 1000)}s remaining).`,
      );
      return false;
    }

    const workerEnv: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (typeof value !== "string") {
        continue;
      }
      if (key.startsWith("GUARDIAN_")) {
        continue;
      }
      workerEnv[key] = value;
    }
    workerEnv.WORKER_HEARTBEAT_FILE = this.config.workerHeartbeatFile;
    workerEnv.WORKER_HEARTBEAT_INTERVAL_SECONDS = String(
      this.config.workerHeartbeatIntervalSeconds,
    );

    const child = Bun.spawn({
      cmd: [process.execPath, "run", "src/index.ts"],
      cwd: process.cwd(),
      env: workerEnv,
      stdout: "pipe",
      stderr: "pipe",
    });
    this.child = child;
    this.childStartedAtMs = nowMs;
    this.cooldownUntilMs = 0;
    this.appendLog("guardian", `Starting worker (${reason}) pid=${child.pid}.`);
    void consumeStreamLines(child.stdout, (line) => this.appendLog("stdout", line));
    void consumeStreamLines(child.stderr, (line) => this.appendLog("stderr", line));

    void (async () => {
      const code = await child.exited;
      await this.handleWorkerExit(child, code);
    })();
    return true;
  }

  private async handleWorkerExit(child: ReturnType<typeof Bun.spawn>, code: number): Promise<void> {
    if (this.child === child) {
      this.child = null;
      this.childStartedAtMs = null;
    }
    this.lastExit = {
      code,
      atMs: Date.now(),
    };
    this.appendLog("guardian", `Worker exited (code=${code}).`);

    if (this.shuttingDown) {
      return;
    }
    if (this.manualStop) {
      this.appendLog("guardian", "Worker is stopped manually. Auto-restart disabled.");
      return;
    }
    if (this.stoppingForRestart) {
      this.stoppingForRestart = false;
      return;
    }
    this.scheduleAutoRestart();
  }

  private scheduleAutoRestart(): void {
    const nowMs = Date.now();
    this.restartHistoryMs.push(nowMs);
    while (this.restartHistoryMs.length > 0) {
      const oldest = this.restartHistoryMs[0];
      if (typeof oldest !== "number" || oldest >= nowMs - this.config.restartWindowMs) {
        break;
      }
      this.restartHistoryMs.shift();
    }

    let delayMs = Math.min(
      this.config.restartBaseMs * 2 ** Math.max(0, this.restartHistoryMs.length - 1),
      this.config.restartMaxMs,
    );
    if (this.restartHistoryMs.length > this.config.restartMaxCount) {
      this.cooldownUntilMs = nowMs + this.config.restartCooldownMs;
      delayMs = Math.max(delayMs, this.config.restartCooldownMs);
      this.appendLog(
        "guardian",
        `Crash-loop protection triggered. Cooling down for ${Math.ceil(this.config.restartCooldownMs / 1000)}s.`,
      );
    }

    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
    }
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      void this.startWorker("auto-restart");
    }, delayMs);
    this.appendLog("guardian", `Scheduling auto-restart in ${Math.ceil(delayMs / 1000)}s.`);
  }

  private async stopWorker(
    reason: string,
    input: {
      manual: boolean;
    },
  ): Promise<void> {
    if (!this.child) {
      return;
    }
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    this.manualStop = input.manual;
    this.stoppingForRestart = !input.manual;

    const child = this.child;
    this.appendLog("guardian", `Stopping worker (${reason}) pid=${child.pid}...`);
    try {
      child.kill("SIGTERM");
    } catch {
      // Ignore signal send errors if process already exited.
    }

    const terminated = await Promise.race([
      child.exited.then(() => true),
      Bun.sleep(8000).then(() => false),
    ]);
    if (!terminated) {
      this.appendLog("guardian", "Worker did not stop after SIGTERM; sending SIGKILL.");
      try {
        child.kill("SIGKILL");
      } catch {
        // Ignore signal send errors if process already exited.
      }
      await child.exited;
    }
  }

  private async restartWorker(reason: string): Promise<boolean> {
    if (this.restartInFlight || this.shuttingDown) {
      return false;
    }
    this.restartInFlight = true;
    try {
      this.manualStop = false;
      await this.stopWorker(reason, { manual: false });
      return await this.startWorker(`restart:${reason}`, { force: true });
    } finally {
      this.restartInFlight = false;
      this.stoppingForRestart = false;
    }
  }

  private getHeartbeatAgeMs(nowMs: number): number | null {
    return getGuardianHeartbeatAgeMs({
      childStartedAtMs: this.childStartedAtMs,
      heartbeatFile: this.config.workerHeartbeatFile,
      nowMs,
    });
  }

  private async checkWorkerHeartbeat(): Promise<void> {
    if (this.shuttingDown || !this.child || this.restartInFlight) {
      return;
    }
    const nowMs = Date.now();
    if (!this.childStartedAtMs || nowMs - this.childStartedAtMs < this.config.heartbeatTimeoutMs) {
      return;
    }
    const heartbeatAgeMs = this.getHeartbeatAgeMs(nowMs);
    if (heartbeatAgeMs !== null && heartbeatAgeMs <= this.config.heartbeatTimeoutMs) {
      return;
    }
    const staleForMs = heartbeatAgeMs ?? nowMs - this.childStartedAtMs;
    this.appendLog(
      "guardian",
      `Heartbeat stale for ${Math.ceil(staleForMs / 1000)}s; restarting worker.`,
    );
    await this.restartWorker("stale heartbeat");
  }

  private statusSnapshot() {
    const nowMs = Date.now();
    const heartbeatAgeMs = this.getHeartbeatAgeMs(nowMs);
    return buildGuardianStatusSnapshot({
      nowMs,
      startedAtMs: this.startedAtMs,
      guardianPid: process.pid,
      childPid: this.child?.pid ?? null,
      childStartedAtMs: this.childStartedAtMs,
      heartbeatAgeMs,
      heartbeatTimeoutMs: this.config.heartbeatTimeoutMs,
      lastExit: this.lastExit,
      manualStop: this.manualStop,
      cooldownUntilMs: this.cooldownUntilMs,
      restartHistoryCount: this.restartHistoryMs.length,
    });
  }

  private async handleRequest(request: Request): Promise<Response> {
    return await handleGuardianControlRequest({
      request,
      config: this.config,
      nonceExpirations: this.nonceExpirations,
      logs: this.logs,
      statusSnapshot: () => this.statusSnapshot(),
      restartWorker: async () => await this.restartWorker("control API"),
      stopWorker: async () => {
        this.manualStop = true;
        await this.stopWorker("control API", { manual: true });
      },
      startWorker: async () => {
        this.manualStop = false;
        return await this.startWorker("control API", { force: true });
      },
    });
  }
}
