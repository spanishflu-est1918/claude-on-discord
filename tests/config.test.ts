import { describe, expect, test } from "bun:test";
import { loadConfig } from "../src/config";

function createEnv(overrides: Record<string, string | undefined> = {}): Record<string, string> {
  return {
    DISCORD_TOKEN: "token",
    APPLICATION_ID: "app-id",
    DEFAULT_WORKING_DIR: "/tmp",
    DATABASE_PATH: "/tmp/claude-on-discord.sqlite",
    ...overrides,
  };
}

describe("loadConfig guild parsing", () => {
  test("parses DISCORD_GUILD_IDS as comma-separated list with dedupe", () => {
    const config = loadConfig(
      createEnv({
        DISCORD_GUILD_IDS: "guild-1, guild-2, guild-1",
        DISCORD_GUILD_ID: "guild-3",
      }),
    );

    expect(config.discordGuildId).toBe("guild-1");
    expect(config.discordGuildIds).toEqual(["guild-1", "guild-2", "guild-3"]);
  });

  test("falls back to DISCORD_GUILD_ID when DISCORD_GUILD_IDS is unset", () => {
    const config = loadConfig(
      createEnv({
        DISCORD_GUILD_ID: "guild-only",
      }),
    );

    expect(config.discordGuildId).toBe("guild-only");
    expect(config.discordGuildIds).toEqual(["guild-only"]);
  });

  test("throws when no guild ids are configured", () => {
    expect(() => loadConfig(createEnv())).toThrow(
      "DISCORD_GUILD_IDS (or DISCORD_GUILD_ID) is required",
    );
  });
});
