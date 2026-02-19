import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  buildSignaturePayload,
  computeGuardianSignature,
  loadGuardianConfig,
  verifyGuardianAuthorization,
} from "../src/guardian";

describe("guardian auth", () => {
  test("accepts bearer auth", () => {
    const result = verifyGuardianAuthorization({
      method: "POST",
      path: "/restart",
      body: "",
      headers: {
        authorization: "Bearer secret-123",
      },
      queryToken: null,
      secret: "secret-123",
      nowMs: Date.now(),
      nonceExpirations: new Map(),
      maxSkewMs: 300_000,
      nonceTtlMs: 600_000,
    });
    expect(result.ok).toBeTrue();
  });

  test("accepts query token auth", () => {
    const result = verifyGuardianAuthorization({
      method: "GET",
      path: "/mobile",
      body: "",
      headers: {},
      queryToken: "secret-123",
      secret: "secret-123",
      nowMs: Date.now(),
      nonceExpirations: new Map(),
      maxSkewMs: 300_000,
      nonceTtlMs: 600_000,
    });
    expect(result.ok).toBeTrue();
  });

  test("accepts valid hmac auth and rejects nonce replay", () => {
    const nowMs = Date.now();
    const timestamp = String(nowMs);
    const nonce = "nonce-1";
    const payload = buildSignaturePayload({
      method: "POST",
      path: "/restart",
      timestamp,
      nonce,
      body: '{"reason":"manual"}',
    });
    const signature = computeGuardianSignature("secret-123", payload);
    const nonceExpirations = new Map<string, number>();

    const first = verifyGuardianAuthorization({
      method: "POST",
      path: "/restart",
      body: '{"reason":"manual"}',
      headers: {
        "x-guardian-ts": timestamp,
        "x-guardian-nonce": nonce,
        "x-guardian-signature": signature,
      },
      queryToken: null,
      secret: "secret-123",
      nowMs,
      nonceExpirations,
      maxSkewMs: 300_000,
      nonceTtlMs: 600_000,
    });
    expect(first.ok).toBeTrue();

    const replay = verifyGuardianAuthorization({
      method: "POST",
      path: "/restart",
      body: '{"reason":"manual"}',
      headers: {
        "x-guardian-ts": timestamp,
        "x-guardian-nonce": nonce,
        "x-guardian-signature": signature,
      },
      queryToken: null,
      secret: "secret-123",
      nowMs: nowMs + 1000,
      nonceExpirations,
      maxSkewMs: 300_000,
      nonceTtlMs: 600_000,
    });
    expect(replay.ok).toBeFalse();
  });
});

describe("guardian config", () => {
  test("auto-generates and persists secret when missing", () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "guardian-secret-test-"));
    try {
      const secretFile = path.join(tempDir, "guardian-control.secret");
      const first = loadGuardianConfig({
        GUARDIAN_CONTROL_SECRET_FILE: secretFile,
      });
      expect(first.controlSecret.length).toBeGreaterThanOrEqual(32);
      expect(first.controlSecretSource).toBe("generated");
      expect(existsSync(secretFile)).toBeTrue();
      expect(readFileSync(secretFile, "utf8").trim()).toBe(first.controlSecret);

      const second = loadGuardianConfig({
        GUARDIAN_CONTROL_SECRET_FILE: secretFile,
      });
      expect(second.controlSecret).toBe(first.controlSecret);
      expect(second.controlSecretSource).toBe("file");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("requires minimum secret length for non-loopback bind", () => {
    expect(() =>
      loadGuardianConfig({
        GUARDIAN_CONTROL_BIND: "0.0.0.0",
        GUARDIAN_CONTROL_SECRET: "short",
      }),
    ).toThrow("at least 16 characters");
  });
});
