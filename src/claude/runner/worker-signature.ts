import type { Options } from "@anthropic-ai/claude-agent-sdk";
import type { ClaudeMcpServerConfig, ClaudePermissionMode } from "../../types";
import { buildSystemPrompt } from "./prompt-policy";
import type { RunRequest } from "../runner";

export function buildWorkerSignature(input: {
  request: RunRequest;
  permissionMode: ClaudePermissionMode;
  mcpServers?: Record<string, ClaudeMcpServerConfig>;
  includeMcpServers: boolean;
  includeResume: boolean;
  disableTools: boolean;
  settingSources: NonNullable<Options["settingSources"]>;
  toStableMcpSignature: (mcpServers?: Record<string, ClaudeMcpServerConfig>) => unknown;
}): string {
  return JSON.stringify({
    cwd: input.request.cwd,
    model: input.request.model ?? "",
    permissionMode: input.permissionMode,
    thinking: input.request.thinking ?? { type: "adaptive" },
    effort: input.request.effort ?? "",
    maxTurns: input.request.maxTurns ?? null,
    systemPrompt: buildSystemPrompt(input.request.systemPrompt),
    settingSources: input.settingSources,
    includeMcpServers: input.includeMcpServers,
    mcpServers: input.includeMcpServers ? input.toStableMcpSignature(input.mcpServers) : "",
    disallowedTools: input.request.disallowedTools ? [...input.request.disallowedTools].sort() : [],
    tools: input.disableTools ? [] : normalizeToolsSignature(input.request.tools),
    toolPolicyKey: input.request.toolPolicyKey ?? null,
    disableTools: input.disableTools,
    includeResume: input.includeResume,
    resumeSessionId: input.includeResume ? (input.request.sessionId ?? "") : "",
    forkSession: input.includeResume ? Boolean(input.request.forkSession) : false,
  });
}

function normalizeToolsSignature(tools: Options["tools"] | undefined): unknown {
  if (Array.isArray(tools)) {
    return [...tools].sort();
  }
  return tools ?? null;
}
