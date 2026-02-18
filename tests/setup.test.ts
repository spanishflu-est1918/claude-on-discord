import { describe, expect, test } from "bun:test";
import {
  buildInviteUrl,
  parseEnvFile,
  renderEnvFile,
  type SetupValues,
} from "../src/bootstrap/setup";

describe("bootstrap setup helpers", () => {
  test("buildInviteUrl includes guild lock when guild id is provided", () => {
    const url = buildInviteUrl({
      applicationId: "123",
      guildId: "456",
    });
    expect(url).toContain("client_id=123");
    expect(url).toContain("guild_id=456");
    expect(url).toContain("disable_guild_select=true");
    expect(url).toContain("scope=bot+applications.commands");
  });

  test("parseEnvFile extracts key value lines", () => {
    const parsed = parseEnvFile(
      ["# comment", "DISCORD_TOKEN=abc", "APPLICATION_ID=123", "INVALID_LINE", ""].join("\n"),
    );
    expect(parsed.DISCORD_TOKEN).toBe("abc");
    expect(parsed.APPLICATION_ID).toBe("123");
    expect(parsed.INVALID_LINE).toBeUndefined();
  });

  test("renderEnvFile writes deterministic content", () => {
    const values: SetupValues = {
      discordToken: "token",
      applicationId: "app",
      discordClientId: "app",
      discordPublicKey: "pub",
      discordGuildId: "guild",
      defaultWorkingDir: "~/www",
      databasePath: "./data/db.sqlite",
      defaultModel: "sonnet",
      claudePermissionMode: "bypassPermissions",
    };
    const content = renderEnvFile(values);
    expect(content).toContain("DISCORD_TOKEN=token");
    expect(content).toContain("APPLICATION_ID=app");
    expect(content).toContain("DISCORD_GUILD_ID=guild");
  });
});
