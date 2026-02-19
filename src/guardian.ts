import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import path from "node:path";
import process from "node:process";
import { renderPreflightReport, runPreflightChecks } from "./bootstrap/preflight";
import { loadConfig } from "./config";

type GuardianConfig = {
  controlBind: string;
  controlPort: number;
  controlSecret: string;
  controlSecretSource: "env" | "file" | "generated" | "generated-ephemeral";
  controlSecretFile: string;
  workerHeartbeatFile: string;
  workerHeartbeatIntervalSeconds: number;
  heartbeatTimeoutMs: number;
  heartbeatCheckIntervalMs: number;
  restartBaseMs: number;
  restartMaxMs: number;
  restartWindowMs: number;
  restartMaxCount: number;
  restartCooldownMs: number;
  logTailLimit: number;
  signatureMaxSkewMs: number;
  signatureNonceTtlMs: number;
};

type LogEntry = {
  ts: string;
  stream: "guardian" | "stdout" | "stderr";
  line: string;
};

type WorkerExitInfo = {
  code: number;
  atMs: number;
};

type GuardianAuthResult =
  | { ok: true; mode: "bearer" | "hmac" | "query" }
  | { ok: false; reason: string };

type VerifyGuardianAuthorizationInput = {
  method: string;
  path: string;
  body: string;
  headers: Record<string, string | undefined>;
  queryToken: string | null;
  secret: string;
  nowMs: number;
  nonceExpirations: Map<string, number>;
  maxSkewMs: number;
  nonceTtlMs: number;
};

const DEFAULT_CONTROL_BIND = "0.0.0.0";
const DEFAULT_CONTROL_PORT = 8787;
const DEFAULT_CONTROL_SECRET_FILE = "./data/guardian-control.secret";
const DEFAULT_HEARTBEAT_TIMEOUT_MS = 45_000;
const DEFAULT_HEARTBEAT_CHECK_MS = 5_000;
const DEFAULT_HEARTBEAT_INTERVAL_SECONDS = 10;
const DEFAULT_RESTART_BASE_MS = 1_000;
const DEFAULT_RESTART_MAX_MS = 30_000;
const DEFAULT_RESTART_WINDOW_MS = 5 * 60_000;
const DEFAULT_RESTART_MAX_COUNT = 12;
const DEFAULT_RESTART_COOLDOWN_MS = 2 * 60_000;
const DEFAULT_LOG_TAIL_LIMIT = 200;
const DEFAULT_SIGNATURE_SKEW_MS = 5 * 60_000;
const DEFAULT_SIGNATURE_NONCE_TTL_MS = 10 * 60_000;

function parseIntEnv(
  rawValue: string | undefined,
  fallback: number,
  variableName: string,
  options: { min?: number; max?: number } = {},
): number {
  if (!rawValue || rawValue.trim().length === 0) {
    return fallback;
  }
  const parsed = Number.parseInt(rawValue.trim(), 10);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid ${variableName}: expected integer, got "${rawValue}"`);
  }
  if (typeof options.min === "number" && parsed < options.min) {
    throw new Error(`Invalid ${variableName}: expected >= ${options.min}, got ${parsed}`);
  }
  if (typeof options.max === "number" && parsed > options.max) {
    throw new Error(`Invalid ${variableName}: expected <= ${options.max}, got ${parsed}`);
  }
  return parsed;
}

function isLoopbackAddress(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase();
  return (
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized === "localhost" ||
    normalized === "::ffff:127.0.0.1"
  );
}

function isAnyAddress(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase();
  return normalized === "0.0.0.0" || normalized === "::" || normalized === "[::]";
}

function listLanIpv4Addresses(): string[] {
  const nets = networkInterfaces();
  const addresses = new Set<string>();
  for (const entries of Object.values(nets)) {
    if (!entries) {
      continue;
    }
    for (const entry of entries) {
      if (!entry || entry.family !== "IPv4" || entry.internal) {
        continue;
      }
      if (entry.address.trim().length > 0) {
        addresses.add(entry.address);
      }
    }
  }
  return [...addresses];
}

function escapeHtml(input: string): string {
  return input
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function loadControlSecretFromFile(secretFile: string): string | null {
  if (!existsSync(secretFile)) {
    return null;
  }
  const existingSecret = readFileSync(secretFile, "utf8").trim();
  return existingSecret.length > 0 ? existingSecret : null;
}

function writeControlSecretToFile(secretFile: string, secret: string): void {
  mkdirSync(path.dirname(secretFile), { recursive: true });
  writeFileSync(secretFile, `${secret}\n`, { encoding: "utf8", mode: 0o600 });
  try {
    chmodSync(secretFile, 0o600);
  } catch {
    // Best-effort permission hardening for platforms that support chmod.
  }
}

export function loadGuardianConfig(
  env: Record<string, string | undefined> = process.env,
): GuardianConfig {
  const controlBind = (env.GUARDIAN_CONTROL_BIND ?? DEFAULT_CONTROL_BIND).trim();
  const controlPort = parseIntEnv(
    env.GUARDIAN_CONTROL_PORT,
    DEFAULT_CONTROL_PORT,
    "GUARDIAN_CONTROL_PORT",
    {
      min: 1,
      max: 65535,
    },
  );
  const controlSecretFile = (
    env.GUARDIAN_CONTROL_SECRET_FILE ?? DEFAULT_CONTROL_SECRET_FILE
  ).trim();
  let controlSecret = env.GUARDIAN_CONTROL_SECRET?.trim() ?? "";
  let controlSecretSource: GuardianConfig["controlSecretSource"] = "env";
  if (!controlSecret) {
    const fileSecret = loadControlSecretFromFile(controlSecretFile);
    if (fileSecret) {
      controlSecret = fileSecret;
      controlSecretSource = "file";
    } else {
      controlSecret = randomBytes(32).toString("hex");
      try {
        writeControlSecretToFile(controlSecretFile, controlSecret);
        controlSecretSource = "generated";
      } catch {
        controlSecretSource = "generated-ephemeral";
      }
    }
  }
  if (!controlSecret) {
    throw new Error("Guardian control secret could not be initialized.");
  }
  if (!isLoopbackAddress(controlBind) && controlSecret.length < 16) {
    throw new Error(
      "GUARDIAN_CONTROL_SECRET must be at least 16 characters when GUARDIAN_CONTROL_BIND is non-loopback.",
    );
  }

  const workerHeartbeatFile = (
    env.GUARDIAN_WORKER_HEARTBEAT_FILE ?? "./data/worker-heartbeat.json"
  ).trim();
  const workerHeartbeatIntervalSeconds = parseIntEnv(
    env.GUARDIAN_WORKER_HEARTBEAT_INTERVAL_SECONDS,
    DEFAULT_HEARTBEAT_INTERVAL_SECONDS,
    "GUARDIAN_WORKER_HEARTBEAT_INTERVAL_SECONDS",
    { min: 1, max: 300 },
  );
  const heartbeatTimeoutMs =
    parseIntEnv(
      env.GUARDIAN_HEARTBEAT_TIMEOUT_SECONDS,
      DEFAULT_HEARTBEAT_TIMEOUT_MS / 1000,
      "GUARDIAN_HEARTBEAT_TIMEOUT_SECONDS",
      { min: 5, max: 3600 },
    ) * 1000;
  const heartbeatCheckIntervalMs =
    parseIntEnv(
      env.GUARDIAN_HEARTBEAT_CHECK_INTERVAL_SECONDS,
      DEFAULT_HEARTBEAT_CHECK_MS / 1000,
      "GUARDIAN_HEARTBEAT_CHECK_INTERVAL_SECONDS",
      { min: 1, max: 300 },
    ) * 1000;
  const restartBaseMs =
    parseIntEnv(
      env.GUARDIAN_RESTART_BASE_SECONDS,
      DEFAULT_RESTART_BASE_MS / 1000,
      "GUARDIAN_RESTART_BASE_SECONDS",
      { min: 1, max: 300 },
    ) * 1000;
  const restartMaxMs =
    parseIntEnv(
      env.GUARDIAN_RESTART_MAX_SECONDS,
      DEFAULT_RESTART_MAX_MS / 1000,
      "GUARDIAN_RESTART_MAX_SECONDS",
      { min: 1, max: 1800 },
    ) * 1000;
  const restartWindowMs =
    parseIntEnv(
      env.GUARDIAN_RESTART_WINDOW_SECONDS,
      DEFAULT_RESTART_WINDOW_MS / 1000,
      "GUARDIAN_RESTART_WINDOW_SECONDS",
      { min: 10, max: 24 * 3600 },
    ) * 1000;
  const restartMaxCount = parseIntEnv(
    env.GUARDIAN_RESTART_MAX_COUNT,
    DEFAULT_RESTART_MAX_COUNT,
    "GUARDIAN_RESTART_MAX_COUNT",
    { min: 1, max: 1000 },
  );
  const restartCooldownMs =
    parseIntEnv(
      env.GUARDIAN_RESTART_COOLDOWN_SECONDS,
      DEFAULT_RESTART_COOLDOWN_MS / 1000,
      "GUARDIAN_RESTART_COOLDOWN_SECONDS",
      { min: 5, max: 24 * 3600 },
    ) * 1000;
  const logTailLimit = parseIntEnv(
    env.GUARDIAN_LOG_TAIL_LIMIT,
    DEFAULT_LOG_TAIL_LIMIT,
    "GUARDIAN_LOG_TAIL_LIMIT",
    { min: 10, max: 10_000 },
  );
  const signatureMaxSkewMs =
    parseIntEnv(
      env.GUARDIAN_SIGNATURE_SKEW_SECONDS,
      DEFAULT_SIGNATURE_SKEW_MS / 1000,
      "GUARDIAN_SIGNATURE_SKEW_SECONDS",
      { min: 10, max: 24 * 3600 },
    ) * 1000;
  const signatureNonceTtlMs =
    parseIntEnv(
      env.GUARDIAN_NONCE_TTL_SECONDS,
      DEFAULT_SIGNATURE_NONCE_TTL_MS / 1000,
      "GUARDIAN_NONCE_TTL_SECONDS",
      { min: 10, max: 24 * 3600 },
    ) * 1000;

  return {
    controlBind,
    controlPort,
    controlSecret,
    controlSecretSource,
    controlSecretFile,
    workerHeartbeatFile,
    workerHeartbeatIntervalSeconds,
    heartbeatTimeoutMs,
    heartbeatCheckIntervalMs,
    restartBaseMs,
    restartMaxMs,
    restartWindowMs,
    restartMaxCount,
    restartCooldownMs,
    logTailLimit,
    signatureMaxSkewMs,
    signatureNonceTtlMs,
  };
}

export function buildSignaturePayload(input: {
  method: string;
  path: string;
  timestamp: string;
  nonce: string;
  body: string;
}): string {
  return `${input.method.toUpperCase()}\n${input.path}\n${input.timestamp}\n${input.nonce}\n${input.body}`;
}

export function computeGuardianSignature(secret: string, payload: string): string {
  return createHmac("sha256", secret).update(payload).digest("hex");
}

function parseAuthHeaderBearer(rawHeader: string | undefined): string | null {
  if (!rawHeader) {
    return null;
  }
  const [scheme, token] = rawHeader.split(/\s+/, 2);
  if (!scheme || !token || scheme.toLowerCase() !== "bearer") {
    return null;
  }
  return token;
}

function normalizeHeaderMap(headers: Headers): Record<string, string | undefined> {
  const normalized: Record<string, string | undefined> = {};
  for (const [key, value] of headers.entries()) {
    normalized[key.toLowerCase()] = value;
  }
  return normalized;
}

function pruneExpiredNonces(nonceExpirations: Map<string, number>, nowMs: number): void {
  for (const [nonce, expiry] of nonceExpirations.entries()) {
    if (expiry <= nowMs) {
      nonceExpirations.delete(nonce);
    }
  }
}

function toTimestampMs(timestampRaw: string): number | null {
  if (!timestampRaw.trim()) {
    return null;
  }
  const numeric = Number(timestampRaw);
  if (!Number.isFinite(numeric)) {
    return null;
  }
  return numeric > 1e12 ? Math.trunc(numeric) : Math.trunc(numeric * 1000);
}

export function verifyGuardianAuthorization(
  input: VerifyGuardianAuthorizationInput,
): GuardianAuthResult {
  if (input.queryToken && input.queryToken === input.secret) {
    return { ok: true, mode: "query" };
  }

  const bearerToken = parseAuthHeaderBearer(input.headers.authorization);
  if (bearerToken && bearerToken === input.secret) {
    return { ok: true, mode: "bearer" };
  }

  const timestampRaw = input.headers["x-guardian-ts"]?.trim() ?? "";
  const nonce = input.headers["x-guardian-nonce"]?.trim() ?? "";
  const signatureRaw = input.headers["x-guardian-signature"]?.trim() ?? "";
  if (!timestampRaw || !nonce || !signatureRaw) {
    return {
      ok: false,
      reason:
        "Missing auth. Provide ?token=<secret>, Authorization: Bearer <secret>, or x-guardian-ts/x-guardian-nonce/x-guardian-signature.",
    };
  }

  const timestampMs = toTimestampMs(timestampRaw);
  if (timestampMs === null) {
    return { ok: false, reason: "Invalid x-guardian-ts header." };
  }
  if (Math.abs(input.nowMs - timestampMs) > input.maxSkewMs) {
    return { ok: false, reason: "Request timestamp is outside allowed skew window." };
  }

  pruneExpiredNonces(input.nonceExpirations, input.nowMs);
  const replayExpiry = input.nonceExpirations.get(nonce);
  if (typeof replayExpiry === "number" && replayExpiry > input.nowMs) {
    return { ok: false, reason: "Nonce already used (replay detected)." };
  }

  const payload = buildSignaturePayload({
    method: input.method,
    path: input.path,
    timestamp: timestampRaw,
    nonce,
    body: input.body,
  });
  const expectedSignature = computeGuardianSignature(input.secret, payload);
  const providedSignature = signatureRaw.startsWith("sha256=")
    ? signatureRaw.slice("sha256=".length)
    : signatureRaw;

  if (providedSignature.length !== expectedSignature.length) {
    return { ok: false, reason: "Invalid signature length." };
  }
  const matches = timingSafeEqual(
    Buffer.from(providedSignature, "utf8"),
    Buffer.from(expectedSignature, "utf8"),
  );
  if (!matches) {
    return { ok: false, reason: "Invalid request signature." };
  }

  input.nonceExpirations.set(nonce, input.nowMs + input.nonceTtlMs);
  return { ok: true, mode: "hmac" };
}

class GuardianSupervisor {
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
    const token = encodeURIComponent(this.config.controlSecret);
    const port = this.server.port;
    if (isLoopbackAddress(this.config.controlBind)) {
      return [`http://127.0.0.1:${port}/mobile?token=${token}`];
    }
    if (isAnyAddress(this.config.controlBind)) {
      const lan = listLanIpv4Addresses();
      if (lan.length === 0) {
        return [`http://127.0.0.1:${port}/mobile?token=${token}`];
      }
      return lan.map((address) => `http://${address}:${port}/mobile?token=${token}`);
    }
    return [`http://${this.config.controlBind}:${port}/mobile?token=${token}`];
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

  private async consumeStreamLines(
    stream: ReadableStream<Uint8Array> | null | undefined,
    streamName: "stdout" | "stderr",
  ): Promise<void> {
    if (!stream) {
      return;
    }
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let pending = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      pending += decoder.decode(value, { stream: true });
      while (true) {
        const newlineIndex = pending.indexOf("\n");
        if (newlineIndex < 0) {
          break;
        }
        const line = pending.slice(0, newlineIndex).replace(/\r$/, "");
        pending = pending.slice(newlineIndex + 1);
        if (line.trim().length > 0) {
          this.appendLog(streamName, line);
        }
      }
    }
    const rest = pending.trim();
    if (rest.length > 0) {
      this.appendLog(streamName, rest);
    }
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
    void this.consumeStreamLines(child.stdout, "stdout");
    void this.consumeStreamLines(child.stderr, "stderr");

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
    if (!this.childStartedAtMs) {
      return null;
    }
    if (!existsSync(this.config.workerHeartbeatFile)) {
      return null;
    }
    try {
      const stat = statSync(this.config.workerHeartbeatFile);
      if (stat.mtimeMs + 1000 < this.childStartedAtMs) {
        return null;
      }
      return Math.max(0, nowMs - stat.mtimeMs);
    } catch {
      return null;
    }
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
    const cooldownRemainingMs = this.cooldownUntilMs > nowMs ? this.cooldownUntilMs - nowMs : 0;
    return {
      ok: true,
      guardianPid: process.pid,
      uptimeMs: nowMs - this.startedAtMs,
      worker: {
        running: Boolean(this.child),
        pid: this.child?.pid ?? null,
        startedAtMs: this.childStartedAtMs,
        heartbeatAgeMs,
        staleHeartbeat:
          typeof heartbeatAgeMs === "number" && heartbeatAgeMs > this.config.heartbeatTimeoutMs,
        lastExit: this.lastExit,
        manualStop: this.manualStop,
        cooldownRemainingMs,
        recentRestartCount: this.restartHistoryMs.length,
      },
    };
  }

  private renderMobilePage(
    status: ReturnType<GuardianSupervisor["statusSnapshot"]>,
    token: string,
  ): string {
    const tokenParam = encodeURIComponent(token);
    const workerStatus = status.worker.running ? "Running" : "Stopped";
    const heartbeatAge =
      typeof status.worker.heartbeatAgeMs === "number"
        ? `${Math.round(status.worker.heartbeatAgeMs / 1000)}s`
        : "unknown";
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Guardian Control</title>
  <style>
    body { font-family: -apple-system, system-ui, sans-serif; margin: 16px; line-height: 1.4; }
    h1 { margin: 0 0 12px; font-size: 1.2rem; }
    .row { display: flex; gap: 8px; flex-wrap: wrap; margin: 12px 0; }
    button { font-size: 1rem; padding: 10px 14px; border-radius: 10px; border: 1px solid #333; background: #fff; }
    pre { white-space: pre-wrap; background: #f7f7f7; border-radius: 10px; padding: 12px; font-size: 0.85rem; }
    .meta { color: #444; font-size: 0.92rem; }
  </style>
</head>
<body>
  <h1>Claude on Discord Guardian</h1>
  <div class="meta">Worker: <strong>${escapeHtml(workerStatus)}</strong> | Heartbeat age: <strong>${escapeHtml(heartbeatAge)}</strong></div>
  <div class="row">
    <form method="post" action="/restart?token=${tokenParam}"><button type="submit">Restart</button></form>
    <form method="post" action="/stop?token=${tokenParam}"><button type="submit">Stop</button></form>
    <form method="post" action="/start?token=${tokenParam}"><button type="submit">Start</button></form>
  </div>
  <div class="row">
    <a href="/status?token=${tokenParam}">Status JSON</a>
    <a href="/logs?tail=200&token=${tokenParam}">Logs JSON</a>
    <a href="/mobile?token=${tokenParam}">Refresh</a>
  </div>
  <pre>${escapeHtml(JSON.stringify(status, null, 2))}</pre>
</body>
</html>`;
  }

  private async handleRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/healthz") {
      return Response.json({
        ok: true,
        service: "guardian",
        ts: Date.now(),
      });
    }

    const queryToken = url.searchParams.get("token") ?? url.searchParams.get("k");
    const body = request.method === "GET" || request.method === "HEAD" ? "" : await request.text();
    const headers = normalizeHeaderMap(request.headers);
    const auth = verifyGuardianAuthorization({
      method: request.method,
      path: url.pathname,
      body,
      headers,
      queryToken,
      secret: this.config.controlSecret,
      nowMs: Date.now(),
      nonceExpirations: this.nonceExpirations,
      maxSkewMs: this.config.signatureMaxSkewMs,
      nonceTtlMs: this.config.signatureNonceTtlMs,
    });
    if (!auth.ok) {
      return Response.json(
        {
          ok: false,
          error: auth.reason,
        },
        {
          status: 401,
        },
      );
    }
    if (request.method === "GET" && url.pathname === "/mobile") {
      return new Response(this.renderMobilePage(this.statusSnapshot(), this.config.controlSecret), {
        headers: {
          "content-type": "text/html; charset=utf-8",
        },
      });
    }
    const isFormPost = request.headers
      .get("content-type")
      ?.includes("application/x-www-form-urlencoded");
    const shouldRedirectToMobile = request.method === "POST" && isFormPost && Boolean(queryToken);
    const mobileLocation = `/mobile?token=${encodeURIComponent(queryToken ?? "")}`;

    if (request.method === "GET" && url.pathname === "/status") {
      return Response.json(this.statusSnapshot());
    }
    if (request.method === "POST" && url.pathname === "/restart") {
      const restarted = await this.restartWorker("control API");
      if (shouldRedirectToMobile) {
        return Response.redirect(mobileLocation, 303);
      }
      return Response.json({
        ...this.statusSnapshot(),
        restarted,
      });
    }
    if (request.method === "POST" && url.pathname === "/stop") {
      this.manualStop = true;
      await this.stopWorker("control API", { manual: true });
      if (shouldRedirectToMobile) {
        return Response.redirect(mobileLocation, 303);
      }
      return Response.json(this.statusSnapshot());
    }
    if (request.method === "POST" && url.pathname === "/start") {
      this.manualStop = false;
      const started = await this.startWorker("control API", { force: true });
      if (shouldRedirectToMobile) {
        return Response.redirect(mobileLocation, 303);
      }
      return Response.json({
        ...this.statusSnapshot(),
        started,
      });
    }
    if (request.method === "GET" && url.pathname === "/logs") {
      const tailRaw = url.searchParams.get("tail");
      const tail = tailRaw ? Number.parseInt(tailRaw, 10) : 200;
      const safeTail = Number.isFinite(tail)
        ? Math.min(Math.max(tail, 10), this.config.logTailLimit)
        : 200;
      return Response.json({
        ok: true,
        logs: this.logs.slice(-safeTail),
      });
    }
    return Response.json(
      {
        ok: false,
        error: "Not found.",
      },
      {
        status: 404,
      },
    );
  }
}

async function main(): Promise<void> {
  const guardianConfig = loadGuardianConfig();
  const appConfig = loadConfig();
  const preflight = await runPreflightChecks(appConfig);
  console.log(renderPreflightReport(preflight));
  if (preflight.hasFailures) {
    throw new Error("Startup preflight failed. Fix reported checks before running guardian.");
  }

  const supervisor = new GuardianSupervisor(guardianConfig);
  await supervisor.start();

  const onSigint = () => {
    void supervisor.shutdown("SIGINT").finally(() => process.exit(0));
  };
  const onSigterm = () => {
    void supervisor.shutdown("SIGTERM").finally(() => process.exit(0));
  };
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);
}

if (import.meta.main) {
  main().catch((error) => {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(`guardian startup error: ${detail}`);
    process.exit(1);
  });
}
