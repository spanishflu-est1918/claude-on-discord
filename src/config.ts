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
  REQUIRE_MENTION_IN_MULTI_USER_CHANNELS: z.string().trim().optional(),
  WORKTREE_BOOTSTRAP: z.string().trim().optional(),
  WORKTREE_BOOTSTRAP_COMMAND: z.string().trim().optional(),
  SESSION_HISTORY_MAX_ITEMS: z.string().trim().optional(),
  SESSION_TURN_MAX_CHARS: z.string().trim().optional(),
  ACTIVE_RUN_MAX_AGE_MINUTES: z.string().trim().optional(),
  ACTIVE_RUN_WATCHDOG_INTERVAL_SECONDS: z.string().trim().optional(),
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
  requireMentionInMultiUserChannels: boolean;
  worktreeBootstrap: boolean;
  worktreeBootstrapCommand?: string;
  sessionHistoryMaxItems?: number;
  sessionTurnMaxChars?: number;
  activeRunMaxAgeMs?: number;
  activeRunWatchdogIntervalMs?: number;
  claudePermissionMode: ClaudePermissionMode;
};

function parseEnvBoolean(
  input: string | undefined,
  fallback: boolean,
  variableName: string,
): boolean {
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
    `Invalid environment configuration: ${variableName} must be one of 1/0/true/false/yes/no/on/off`,
  );
}

function parseEnvInt(
  input: string | undefined,
  fallback: number,
  variableName: string,
  options: { min?: number; max?: number } = {},
): number {
  if (!input || input.trim().length === 0) {
    return fallback;
  }
  const parsed = Number.parseInt(input.trim(), 10);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid environment configuration: ${variableName} must be an integer`);
  }
  if (typeof options.min === "number" && parsed < options.min) {
    throw new Error(`Invalid environment configuration: ${variableName} must be >= ${options.min}`);
  }
  if (typeof options.max === "number" && parsed > options.max) {
    throw new Error(`Invalid environment configuration: ${variableName} must be <= ${options.max}`);
  }
  return parsed;
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
  const autoThreadWorktree = parseEnvBoolean(
    value.AUTO_THREAD_WORKTREE,
    false,
    "AUTO_THREAD_WORKTREE",
  );
  const requireMentionInMultiUserChannels = parseEnvBoolean(
    value.REQUIRE_MENTION_IN_MULTI_USER_CHANNELS,
    false,
    "REQUIRE_MENTION_IN_MULTI_USER_CHANNELS",
  );
  const worktreeBootstrap = parseEnvBoolean(value.WORKTREE_BOOTSTRAP, true, "WORKTREE_BOOTSTRAP");
  const worktreeBootstrapCommand = value.WORKTREE_BOOTSTRAP_COMMAND?.trim() || undefined;
  const sessionHistoryMaxItems = parseEnvInt(
    value.SESSION_HISTORY_MAX_ITEMS,
    40,
    "SESSION_HISTORY_MAX_ITEMS",
    { min: 1, max: 1000 },
  );
  const sessionTurnMaxChars = parseEnvInt(
    value.SESSION_TURN_MAX_CHARS,
    6000,
    "SESSION_TURN_MAX_CHARS",
    { min: 200, max: 200000 },
  );
  const activeRunMaxAgeMinutes = parseEnvInt(
    value.ACTIVE_RUN_MAX_AGE_MINUTES,
    30,
    "ACTIVE_RUN_MAX_AGE_MINUTES",
    { min: 1, max: 24 * 60 },
  );
  const activeRunWatchdogIntervalSeconds = parseEnvInt(
    value.ACTIVE_RUN_WATCHDOG_INTERVAL_SECONDS,
    30,
    "ACTIVE_RUN_WATCHDOG_INTERVAL_SECONDS",
    { min: 5, max: 3600 },
  );

  return {
    discordToken: value.DISCORD_TOKEN,
    discordClientId,
    ...(value.DISCORD_PUBLIC_KEY ? { discordPublicKey: value.DISCORD_PUBLIC_KEY } : {}),
    discordGuildId: value.DISCORD_GUILD_ID,
    defaultWorkingDir: resolvedWorkingDir,
    databasePath: resolvedDbPath,
    defaultModel: value.DEFAULT_MODEL,
    autoThreadWorktree,
    requireMentionInMultiUserChannels,
    worktreeBootstrap,
    ...(worktreeBootstrapCommand ? { worktreeBootstrapCommand } : {}),
    sessionHistoryMaxItems,
    sessionTurnMaxChars,
    activeRunMaxAgeMs: activeRunMaxAgeMinutes * 60 * 1000,
    activeRunWatchdogIntervalMs: activeRunWatchdogIntervalSeconds * 1000,
    claudePermissionMode: value.CLAUDE_PERMISSION_MODE,
  };
}
