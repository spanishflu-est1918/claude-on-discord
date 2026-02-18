import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runPreflightChecks } from "../src/bootstrap/preflight";
import type { AppConfig } from "../src/config";

function createConfig(overrides: Partial<AppConfig>): AppConfig {
  return {
    discordToken: "token",
    discordClientId: "123",
    discordGuildId: "999",
    defaultWorkingDir: "/tmp",
    databasePath: "/tmp/bot.sqlite",
    defaultModel: "sonnet",
    autoThreadWorktree: false,
    claudePermissionMode: "bypassPermissions",
    ...overrides,
  };
}

describe("startup preflight", () => {
  test("passes when local paths and discord access are valid", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "preflight-ok-"));
    const workingDir = path.join(root, "work");
    const databasePath = path.join(root, "data", "bot.sqlite");
    await mkdir(workingDir, { recursive: true });

    const report = await runPreflightChecks(
      createConfig({ defaultWorkingDir: workingDir, databasePath }),
      {
        discordProbe: {
          getBotUser: async () => ({ id: "123", username: "hermes" }),
          getGuild: async () => ({ id: "999", name: "Guild" }),
        },
      },
    );

    expect(report.hasFailures).toBe(false);
    expect(report.checks.every((check) => check.status === "ok")).toBe(true);
  });

  test("fails when token bot id does not match configured client id", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "preflight-mismatch-"));
    const workingDir = path.join(root, "work");
    const databasePath = path.join(root, "data", "bot.sqlite");
    await mkdir(workingDir, { recursive: true });
    let guildChecked = false;

    const report = await runPreflightChecks(
      createConfig({ defaultWorkingDir: workingDir, databasePath }),
      {
        discordProbe: {
          getBotUser: async () => ({ id: "456", username: "wrong-bot" }),
          getGuild: async () => {
            guildChecked = true;
            return { id: "999", name: "Guild" };
          },
        },
      },
    );

    expect(report.hasFailures).toBe(true);
    expect(guildChecked).toBe(false);
    expect(
      report.checks.some((check) => check.name === "Discord auth" && check.status === "fail"),
    ).toBe(true);
  });

  test("fails auth and skips guild check when token probe throws", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "preflight-auth-"));
    const workingDir = path.join(root, "work");
    const databasePath = path.join(root, "data", "bot.sqlite");
    await mkdir(workingDir, { recursive: true });

    const report = await runPreflightChecks(
      createConfig({ defaultWorkingDir: workingDir, databasePath }),
      {
        discordProbe: {
          getBotUser: async () => {
            throw new Error("401 unauthorized");
          },
          getGuild: async () => ({ id: "999", name: "Guild" }),
        },
      },
    );

    expect(report.hasFailures).toBe(true);
    expect(
      report.checks.some((check) => check.name === "Discord auth" && check.status === "fail"),
    ).toBe(true);
    expect(
      report.checks.some(
        (check) => check.name === "Discord guild access" && check.status === "warn",
      ),
    ).toBe(true);
  });
});
