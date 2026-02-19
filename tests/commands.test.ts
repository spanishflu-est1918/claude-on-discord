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

  test("/fork exposes an optional title option", () => {
    const commands = getSlashCommandDefinitions();
    const fork = commands.find((command) => command.name === "fork");
    expect(fork).toBeDefined();
    const options = fork?.options ?? [];
    expect(options).toHaveLength(1);
    const title = options[0] as { name?: string; required?: boolean; max_length?: number };
    expect(title.name).toBe("title");
    expect(title.required).not.toBeTrue();
    expect(title.max_length).toBe(100);
  });

  test("/merge exposes optional focus and branch options", () => {
    const commands = getSlashCommandDefinitions();
    const merge = commands.find((command) => command.name === "merge");
    expect(merge).toBeDefined();
    const options = merge?.options ?? [];
    const names = options
      .map((option) => ("name" in option && typeof option.name === "string" ? option.name : ""))
      .filter(Boolean);
    expect(names).toEqual(["focus", "branch"]);
  });

  test("/kill has no options", () => {
    const commands = getSlashCommandDefinitions();
    const kill = commands.find((command) => command.name === "kill");
    expect(kill).toBeDefined();
    expect(kill?.options ?? []).toHaveLength(0);
  });

  test("/pr exposes create and inspect subcommands", () => {
    const commands = getSlashCommandDefinitions();
    const pr = commands.find((command) => command.name === "pr");
    expect(pr).toBeDefined();
    const subcommands = (pr?.options ?? [])
      .map((option) => ("name" in option && typeof option.name === "string" ? option.name : ""))
      .filter(Boolean);
    expect(subcommands).toEqual(["open", "draft", "status", "view", "checks", "merge"]);
  });

  test("/mentions exposes set/show/clear subcommands", () => {
    const commands = getSlashCommandDefinitions();
    const mentions = commands.find((command) => command.name === "mentions");
    expect(mentions).toBeDefined();
    const subcommands = (mentions?.options ?? [])
      .map((option) => ("name" in option && typeof option.name === "string" ? option.name : ""))
      .filter(Boolean);
    expect(subcommands).toEqual(["set", "show", "clear"]);
  });

  test("/mode exposes set/show/clear subcommands", () => {
    const commands = getSlashCommandDefinitions();
    const mode = commands.find((command) => command.name === "mode");
    expect(mode).toBeDefined();
    const subcommands = (mode?.options ?? [])
      .map((option) => ("name" in option && typeof option.name === "string" ? option.name : ""))
      .filter(Boolean);
    expect(subcommands).toEqual(["set", "show", "clear"]);
  });

  test("required command options are ordered before optional options", () => {
    const commands = getSlashCommandDefinitions();

    const assertRequiredFirst = (options: unknown, path: string) => {
      if (!Array.isArray(options)) {
        return;
      }

      let sawOptional = false;
      for (let index = 0; index < options.length; index++) {
        const option = options[index];
        if (!option || typeof option !== "object") {
          continue;
        }

        const candidate = option as {
          name?: unknown;
          required?: unknown;
          options?: unknown;
        };
        const optionName = typeof candidate.name === "string" ? candidate.name : String(index);
        const optionPath = `${path}.${optionName}`;
        const required = candidate.required === true;

        if (required && sawOptional) {
          throw new Error(`Required option appears after optional option at ${optionPath}`);
        }
        if (!required) {
          sawOptional = true;
        }

        assertRequiredFirst(candidate.options, optionPath);
      }
    };

    for (const command of commands) {
      assertRequiredFirst(command.options, `/${command.name}`);
    }
  });
});
