import { describe, expect, test } from "bun:test";
import {
  describeAnthropicAuthMode,
  isAnthropicCreditBalanceError,
  sanitizeAnthropicApiKeyEnv,
  shouldUseAnthropicApiKey,
} from "../src/claude/auth-policy";

describe("auth policy", () => {
  test("defaults API key mode to false", () => {
    expect(shouldUseAnthropicApiKey({})).toBe(false);
  });

  test("parses USE_ANTHROPIC_API_KEY=true", () => {
    expect(shouldUseAnthropicApiKey({ USE_ANTHROPIC_API_KEY: "true" })).toBe(true);
  });

  test("strips ANTHROPIC_API_KEY when API key mode is disabled", () => {
    const env: Record<string, string | undefined> = {
      ANTHROPIC_API_KEY: "sk-ant-test",
      USE_ANTHROPIC_API_KEY: "",
    };
    const logs: string[] = [];
    const result = sanitizeAnthropicApiKeyEnv({
      allowApiKey: false,
      env,
      context: "test",
      log: (line) => logs.push(line),
    });

    expect(result.hadApiKey).toBe(true);
    expect(result.removed).toBe(true);
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(logs.some((line) => line.includes("ignoring ANTHROPIC_API_KEY"))).toBe(true);
  });

  test("keeps ANTHROPIC_API_KEY when API key mode is enabled", () => {
    const env: Record<string, string | undefined> = {
      ANTHROPIC_API_KEY: "sk-ant-test",
      USE_ANTHROPIC_API_KEY: "true",
    };
    const result = sanitizeAnthropicApiKeyEnv({
      allowApiKey: true,
      env,
      context: "test",
    });

    expect(result.hadApiKey).toBe(true);
    expect(result.removed).toBe(false);
    expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-test");
  });

  test("detects credit balance errors", () => {
    expect(isAnthropicCreditBalanceError("credit balance too low")).toBe(true);
    expect(isAnthropicCreditBalanceError("billing required for this key")).toBe(true);
    expect(isAnthropicCreditBalanceError("some other error")).toBe(false);
  });

  test("describes auth mode with key presence", () => {
    const summary = describeAnthropicAuthMode({
      allowApiKey: false,
      env: { ANTHROPIC_API_KEY: "sk-ant-test" },
      context: "worker startup",
    });
    expect(summary).toContain("mode=claude-login");
    expect(summary).toContain("apiKeyPresent=true");
  });
});
