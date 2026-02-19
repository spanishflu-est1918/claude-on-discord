import { createHmac, timingSafeEqual } from "node:crypto";
import type {
  GuardianAuthResult,
  VerifyGuardianAuthorizationInput,
} from "./types";

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

export function normalizeHeaderMap(headers: Headers): Record<string, string | undefined> {
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
