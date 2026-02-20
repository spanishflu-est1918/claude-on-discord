import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import type { ClaudeMcpServerConfig } from "../../types";

type RunAttempt = {
  includeMcpServers: boolean;
  includeResume: boolean;
  disableTools: boolean;
  settingSources: NonNullable<Options["settingSources"]>;
  label: string;
};

function toSerializableMcpConfig(config: ClaudeMcpServerConfig): Record<string, unknown> {
  if (config.type === "sdk") {
    return {
      type: "sdk",
      name: config.name,
    };
  }
  return config;
}

export function toStableMcpSignature(
  mcpServers?: Record<string, ClaudeMcpServerConfig>,
): Array<[string, Record<string, unknown>]> {
  if (!mcpServers) {
    return [];
  }
  return Object.entries(mcpServers)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, config]) => [name, toSerializableMcpConfig(config)]);
}

export function mergeMcpServers(
  loaded?: Record<string, ClaudeMcpServerConfig>,
  runtime?: Record<string, ClaudeMcpServerConfig>,
): Record<string, ClaudeMcpServerConfig> | undefined {
  if (!loaded && !runtime) {
    return undefined;
  }

  return {
    ...(loaded ?? {}),
    ...(runtime ?? {}),
  };
}

export function buildRunAttempts(input: {
  hasMcpServers: boolean;
  hasSessionId: boolean;
  settingSources: NonNullable<Options["settingSources"]>;
}): RunAttempt[] {
  const attempts: RunAttempt[] = [];
  const seen = new Set<string>();

  const push = (attempt: RunAttempt) => {
    const key = [
      attempt.includeMcpServers ? "mcp" : "no-mcp",
      attempt.includeResume ? "resume" : "no-resume",
      attempt.disableTools ? "no-tools" : "tools",
      attempt.settingSources.join(","),
    ].join("|");
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    attempts.push(attempt);
  };

  push({
    includeMcpServers: false,
    includeResume: input.hasSessionId,
    disableTools: false,
    settingSources: input.settingSources,
    label: "default",
  });

  if (input.hasMcpServers) {
    push({
      includeMcpServers: false,
      includeResume: true,
      disableTools: false,
      settingSources: input.settingSources,
      label: "without MCP",
    });
  }

  if (input.hasSessionId) {
    push({
      includeMcpServers: false,
      includeResume: false,
      disableTools: false,
      settingSources: input.settingSources,
      label: "without session resume",
    });
  }

  if (input.hasMcpServers && input.hasSessionId) {
    push({
      includeMcpServers: false,
      includeResume: false,
      disableTools: false,
      settingSources: input.settingSources,
      label: "without MCP and session resume",
    });
  }

  push({
    includeMcpServers: false,
    includeResume: false,
    disableTools: false,
    settingSources: input.settingSources,
    label: "safe mode (SDK isolation)",
  });

  push({
    includeMcpServers: false,
    includeResume: false,
    disableTools: true,
    settingSources: input.settingSources,
    label: "safe mode (SDK isolation, tools disabled)",
  });

  return attempts;
}

export async function loadMcpServers(
  workDir: string,
): Promise<Record<string, ClaudeMcpServerConfig> | undefined> {
  const mcpPath = path.join(workDir, ".claude", "mcp.json");
  try {
    const raw = await readFile(mcpPath, "utf-8");
    const parsed = JSON.parse(raw) as { mcpServers?: Record<string, unknown> };
    if (!parsed.mcpServers || typeof parsed.mcpServers !== "object") {
      return undefined;
    }

    const servers: Record<string, ClaudeMcpServerConfig> = {};
    for (const [name, config] of Object.entries(parsed.mcpServers)) {
      if (!config || typeof config !== "object") {
        continue;
      }
      const value = config as {
        command?: string;
        args?: string[];
        env?: Record<string, string>;
      };
      if (!value.command) {
        continue;
      }
      const args = Array.isArray(value.args)
        ? value.args.map((arg) => arg.replace(/\$\{workspaceFolder:-\.?\}/g, workDir))
        : undefined;
      servers[name] = {
        type: "stdio",
        command: value.command,
        ...(args ? { args } : {}),
        ...(value.env ? { env: value.env } : {}),
      };
    }

    return Object.keys(servers).length > 0 ? servers : undefined;
  } catch {
    return undefined;
  }
}
