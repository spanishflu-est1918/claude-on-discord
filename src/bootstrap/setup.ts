export const DEFAULT_DISCORD_PERMISSIONS = "412317248576";

export type SetupValues = {
  discordToken: string;
  applicationId: string;
  discordClientId?: string;
  discordPublicKey?: string;
  discordGuildId: string;
  defaultWorkingDir: string;
  databasePath: string;
  defaultModel: string;
  autoThreadWorktree: string;
  worktreeBootstrap: string;
  worktreeBootstrapCommand?: string;
  claudePermissionMode: string;
};

export function buildInviteUrl(input: {
  applicationId: string;
  guildId?: string;
  permissions?: string;
}): string {
  const params = new URLSearchParams({
    client_id: input.applicationId,
    scope: "bot applications.commands",
    permissions: input.permissions ?? DEFAULT_DISCORD_PERMISSIONS,
  });

  if (input.guildId) {
    params.set("guild_id", input.guildId);
    params.set("disable_guild_select", "true");
  }

  return `https://discord.com/oauth2/authorize?${params.toString()}`;
}

export function parseEnvFile(content: string): Record<string, string> {
  const env: Record<string, string> = {};
  const lines = content.split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const separator = line.indexOf("=");
    if (separator <= 0) {
      continue;
    }
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    env[key] = value;
  }
  return env;
}

export function renderEnvFile(values: SetupValues): string {
  const rows = [
    "# claude-on-discord runtime configuration",
    `DISCORD_TOKEN=${values.discordToken}`,
    `APPLICATION_ID=${values.applicationId}`,
    `DISCORD_CLIENT_ID=${values.discordClientId ?? values.applicationId}`,
    `DISCORD_PUBLIC_KEY=${values.discordPublicKey ?? ""}`,
    `DISCORD_GUILD_ID=${values.discordGuildId}`,
    `DEFAULT_WORKING_DIR=${values.defaultWorkingDir}`,
    `DATABASE_PATH=${values.databasePath}`,
    `DEFAULT_MODEL=${values.defaultModel}`,
    `AUTO_THREAD_WORKTREE=${values.autoThreadWorktree}`,
    `WORKTREE_BOOTSTRAP=${values.worktreeBootstrap}`,
    `WORKTREE_BOOTSTRAP_COMMAND=${values.worktreeBootstrapCommand ?? ""}`,
    `CLAUDE_PERMISSION_MODE=${values.claudePermissionMode}`,
    "",
  ];
  return rows.join("\n");
}
