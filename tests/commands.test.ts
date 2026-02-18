import { describe, expect, test } from "bun:test";
import { getSlashCommandDefinitions } from "../src/discord/commands";

describe("slash commands", () => {
  test("/diff has no options", () => {
    const commands = getSlashCommandDefinitions();
    const diff = commands.find((command) => command.name === "diff");
    expect(diff).toBeDefined();
    expect(diff?.options ?? []).toHaveLength(0);
  });
});
