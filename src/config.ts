import path from "node:path";
import { z } from "zod";
import type { ClaudePermissionMode } from "./types";

const envSchema = z.object({
  DISCORD_TOKEN: z.string().min(1, "DISCORD_TOKEN is required"),
  APPLICATION_ID: z.string().trim().optional(),
  DISCORD_CLIENT_ID: z.string().trim().optional(),
  DISCORD_PUBLIC_KEY: z.string().trim().optional(),
  DISCORD_GUILD_ID: z.string().trim().min(1, "DISCORD_GUILD_ID is required"),
  DEFAULT_WORKING_DIR: z.string().trim().default("~/www"),
  DATABASE_PATH: z.string().trim().default("./data/claude-on-discord.sqlite"),
  DEFAULT_MODEL: z.string().trim().default("sonnet"),
  AUTO_THREAD_WORKTREE: z.string().trim().optional(),
  CLAUDE_PERMISSION_MODE: z
    .enum(["default", "plan", "acceptEdits", "bypassPermissions", "delegate", "dontAsk"])
    .default("bypassPermissions"),
});

export type AppConfig = {
  discordToken: string;
  discordClientId: string;
  discordPublicKey?: string;
  discordGuildId: string;
  defaultWorkingDir: string;
  databasePath: string;
  defaultModel: string;
  autoThreadWorktree: boolean;
  claudePermissionMode: ClaudePermissionMode;
};

function parseEnvBoolean(input: string | undefined, fallback: boolean): boolean {
  if (!input || input.trim().length === 0) {
    return fallback;
  }
  const normalized = input.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  throw new Error(
    "Invalid environment configuration: AUTO_THREAD_WORKTREE must be one of 1/0/true/false/yes/no/on/off",
  );
}

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
  const discordClientId = value.APPLICATION_ID || value.DISCORD_CLIENT_ID;
  if (!discordClientId) {
    throw new Error(
      "Invalid environment configuration: APPLICATION_ID (or DISCORD_CLIENT_ID) is required",
    );
  }

  const resolvedWorkingDir = path.resolve(expandHome(value.DEFAULT_WORKING_DIR));
  const resolvedDbPath = path.resolve(expandHome(value.DATABASE_PATH));
  const autoThreadWorktree = parseEnvBoolean(value.AUTO_THREAD_WORKTREE, false);

  return {
    discordToken: value.DISCORD_TOKEN,
    discordClientId,
    ...(value.DISCORD_PUBLIC_KEY ? { discordPublicKey: value.DISCORD_PUBLIC_KEY } : {}),
    discordGuildId: value.DISCORD_GUILD_ID,
    defaultWorkingDir: resolvedWorkingDir,
    databasePath: resolvedDbPath,
    defaultModel: value.DEFAULT_MODEL,
    autoThreadWorktree,
    claudePermissionMode: value.CLAUDE_PERMISSION_MODE,
  };
}
