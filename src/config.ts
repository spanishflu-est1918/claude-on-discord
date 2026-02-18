import path from "node:path";
import { z } from "zod";
import type { ClaudePermissionMode } from "./types";

const envSchema = z.object({
  DISCORD_TOKEN: z.string().min(1, "DISCORD_TOKEN is required"),
  DISCORD_CLIENT_ID: z.string().min(1, "DISCORD_CLIENT_ID is required"),
  DISCORD_GUILD_ID: z.string().trim().optional().default(""),
  DEFAULT_WORKING_DIR: z.string().trim().default("~/www"),
  DATABASE_PATH: z.string().trim().default("./data/claude-on-discord.sqlite"),
  DEFAULT_MODEL: z.string().trim().default("sonnet"),
  CLAUDE_PERMISSION_MODE: z
    .enum(["default", "plan", "acceptEdits", "bypassPermissions", "delegate", "dontAsk"])
    .default("bypassPermissions"),
});

export type AppConfig = {
  discordToken: string;
  discordClientId: string;
  discordGuildId?: string;
  defaultWorkingDir: string;
  databasePath: string;
  defaultModel: string;
  claudePermissionMode: ClaudePermissionMode;
};

function expandHome(inputPath: string): string {
  if (!inputPath.startsWith("~/")) {
    return inputPath;
  }
  const home = process.env.HOME;
  if (!home) {
    return inputPath;
  }
  return path.join(home, inputPath.slice(2));
}

export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((issue) => issue.message).join("; ");
    throw new Error(`Invalid environment configuration: ${detail}`);
  }

  const value = parsed.data;
  const resolvedWorkingDir = path.resolve(expandHome(value.DEFAULT_WORKING_DIR));
  const resolvedDbPath = path.resolve(expandHome(value.DATABASE_PATH));

  return {
    discordToken: value.DISCORD_TOKEN,
    discordClientId: value.DISCORD_CLIENT_ID,
    ...(value.DISCORD_GUILD_ID ? { discordGuildId: value.DISCORD_GUILD_ID } : {}),
    defaultWorkingDir: resolvedWorkingDir,
    databasePath: resolvedDbPath,
    defaultModel: value.DEFAULT_MODEL,
    claudePermissionMode: value.CLAUDE_PERMISSION_MODE,
  };
}
