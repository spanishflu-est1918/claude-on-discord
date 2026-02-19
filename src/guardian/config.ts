import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import path from "node:path";
import process from "node:process";
import type { GuardianConfig } from "./types";

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

export function isLoopbackAddress(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase();
  return (
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized === "localhost" ||
    normalized === "::ffff:127.0.0.1"
  );
}

export function isAnyAddress(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase();
  return normalized === "0.0.0.0" || normalized === "::" || normalized === "[::]";
}

export function listLanIpv4Addresses(): string[] {
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

export function escapeHtml(input: string): string {
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
