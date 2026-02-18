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
      discordGuildId: await ask(rl, "Discord guild/server ID", current.DISCORD_GUILD_ID ?? ""),
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
      claudePermissionMode: await ask(
        rl,
        "Claude permission mode",
        current.CLAUDE_PERMISSION_MODE ?? "bypassPermissions",
      ),
    };

    values.discordClientId = values.applicationId;

    if (!values.discordToken || !values.applicationId || !values.discordGuildId) {
      throw new Error("DISCORD_TOKEN, APPLICATION_ID, and DISCORD_GUILD_ID are required.");
    }

    await writeFile(envPath, renderEnvFile(values), "utf8");

    const inviteUrl = buildInviteUrl({
      applicationId: values.applicationId,
      guildId: values.discordGuildId,
    });

    console.log(`\nWrote ${envPath}`);
    console.log(`Invite URL:\n${inviteUrl}`);
    console.log("\nNext:");
    console.log("1) Open invite URL and authorize bot for your server");
    console.log("2) bun run start");
  } finally {
    rl.close();
  }
}

main().catch((error) => {
  console.error("setup failed:", error instanceof Error ? error.message : String(error));
  process.exit(1);
});
