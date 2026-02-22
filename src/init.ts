import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import { buildInviteUrl, parseEnvFile, renderEnvFile, type SetupValues } from "./bootstrap/setup";

function valueOrDefault(value: string, fallback: string): string {
  return value.trim() ? value.trim() : fallback;
}

async function ask(
  rl: ReturnType<typeof createInterface>,
  prompt: string,
  fallback = "",
): Promise<string> {
  const suffix = fallback ? ` [${fallback}]` : "";
  const answer = await rl.question(`${prompt}${suffix}: `);
  return valueOrDefault(answer, fallback);
}

function parseYesNo(input: string, fallback: boolean): boolean {
  const normalized = input.trim().toLowerCase();
  if (!normalized) {
    return fallback;
  }
  if (["y", "yes", "true", "1"].includes(normalized)) {
    return true;
  }
  if (["n", "no", "false", "0"].includes(normalized)) {
    return false;
  }
  return fallback;
}

function parseGuildIdList(input: string): string[] {
  return Array.from(
    new Set(
      input
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  );
}

async function askYesNo(
  rl: ReturnType<typeof createInterface>,
  prompt: string,
  fallback: boolean,
): Promise<boolean> {
  const suffix = fallback ? " [Y/n]" : " [y/N]";
  const answer = await rl.question(`${prompt}${suffix}: `);
  return parseYesNo(answer, fallback);
}

async function openInviteInBrowser(url: string): Promise<boolean> {
  const cmd =
    process.platform === "darwin"
      ? ["open", url]
      : process.platform === "win32"
        ? ["cmd", "/c", "start", "", url]
        : ["xdg-open", url];

  try {
    const child = Bun.spawn({
      cmd,
      stdout: "ignore",
      stderr: "ignore",
    });
    const exitCode = await child.exited;
    return exitCode === 0;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const envPath = path.resolve(".env");
  const current = existsSync(envPath) ? parseEnvFile(await readFile(envPath, "utf8")) : {};

  const rl = createInterface({ input: stdin, output: stdout });
  try {
    console.log("claude-on-discord setup\n");

    const values: SetupValues = {
      discordToken: await ask(rl, "Discord bot token", current.DISCORD_TOKEN ?? ""),
      applicationId: await ask(
        rl,
        "Application ID (same as client id)",
        current.APPLICATION_ID ?? current.DISCORD_CLIENT_ID ?? "",
      ),
      discordClientId: "",
      discordPublicKey: await ask(
        rl,
        "Discord public key (optional)",
        current.DISCORD_PUBLIC_KEY ?? "",
      ),
      discordGuildIds: await ask(
        rl,
        "Discord guild/server ID(s), comma-separated",
        current.DISCORD_GUILD_IDS ?? current.DISCORD_GUILD_ID ?? "",
      ),
      discordGuildId: "",
      defaultWorkingDir: await ask(
        rl,
        "Default working directory",
        current.DEFAULT_WORKING_DIR ?? "~/www",
      ),
      databasePath: await ask(
        rl,
        "Database path",
        current.DATABASE_PATH ?? "./data/claude-on-discord.sqlite",
      ),
      defaultModel: await ask(rl, "Default model", current.DEFAULT_MODEL ?? "sonnet"),
      autoThreadWorktree: await ask(
        rl,
        "Auto thread worktree (true/false)",
        current.AUTO_THREAD_WORKTREE ?? "false",
      ),
      requireMentionInMultiUserChannels: await ask(
        rl,
        "Require @mention in multi-user channels (true/false)",
        current.REQUIRE_MENTION_IN_MULTI_USER_CHANNELS ?? "false",
      ),
      worktreeBootstrap: await ask(
        rl,
        "Bootstrap new worktrees automatically (true/false)",
        current.WORKTREE_BOOTSTRAP ?? "true",
      ),
      worktreeBootstrapCommand: await ask(
        rl,
        "Custom worktree bootstrap command (optional)",
        current.WORKTREE_BOOTSTRAP_COMMAND ?? "",
      ),
      claudePermissionMode: await ask(
        rl,
        "Claude permission mode",
        current.CLAUDE_PERMISSION_MODE ?? "bypassPermissions",
      ),
    };

    values.discordClientId = values.applicationId;
    const parsedGuildIds = parseGuildIdList(values.discordGuildIds ?? "");
    values.discordGuildId = parsedGuildIds[0] ?? "";
    values.discordGuildIds = parsedGuildIds.join(",");

    if (!values.discordToken || !values.applicationId || parsedGuildIds.length === 0) {
      throw new Error(
        "DISCORD_TOKEN, APPLICATION_ID, and at least one Discord guild ID are required.",
      );
    }

    await writeFile(envPath, renderEnvFile(values), "utf8");

    const inviteUrl = buildInviteUrl({
      applicationId: values.applicationId,
      guildId: values.discordGuildId,
    });

    console.log(`\nWrote ${envPath}`);
    console.log(`Invite URL:\n${inviteUrl}`);

    const shouldOpenInvite = await askYesNo(rl, "Open invite URL in browser now", true);
    if (shouldOpenInvite) {
      const opened = await openInviteInBrowser(inviteUrl);
      if (!opened) {
        console.log("Could not open browser automatically. Open the invite URL manually.");
      }
    }

    console.log("\nNext:");
    console.log("1) Open invite URL and authorize bot for your server(s)");
    console.log("2) bun run start");
  } finally {
    rl.close();
  }
}

main().catch((error) => {
  console.error("setup failed:", error instanceof Error ? error.message : String(error));
  process.exit(1);
});
