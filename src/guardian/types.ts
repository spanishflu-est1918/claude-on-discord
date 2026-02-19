export type GuardianConfig = {
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

export type LogEntry = {
  ts: string;
  stream: "guardian" | "stdout" | "stderr";
  line: string;
};

export type WorkerExitInfo = {
  code: number;
  atMs: number;
};

export type GuardianAuthResult =
  | { ok: true; mode: "bearer" | "hmac" | "query" }
  | { ok: false; reason: string };

export type VerifyGuardianAuthorizationInput = {
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
