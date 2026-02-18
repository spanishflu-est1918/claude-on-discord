import { describe, expect, test } from "bun:test";
import { getSlashCommandDefinitions } from "../src/discord/commands";

describe("slash commands", () => {
  test("/diff has no options", () => {
    const commands = getSlashCommandDefinitions();
    const diff = commands.find((command) => command.name === "diff");
    expect(diff).toBeDefined();
    expect(diff?.options ?? []).toHaveLength(0);
  });

  test("/screenshot exposes url/full options", () => {
    const commands = getSlashCommandDefinitions();
    const screenshot = commands.find((command) => command.name === "screenshot");
    expect(screenshot).toBeDefined();
    const options = screenshot?.options ?? [];
    const names = options
      .map((option) => ("name" in option && typeof option.name === "string" ? option.name : ""))
      .filter(Boolean);
    expect(names).toEqual(["url", "full"]);
  });
});
