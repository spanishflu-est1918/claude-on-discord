import { readFile } from "node:fs/promises";
import path from "node:path";
import { query as claudeQuery, type Options } from "@anthropic-ai/claude-agent-sdk";
import type {
  ClaudeMcpServerConfig,
  ClaudePermissionMode,
  ClaudeQuery,
  ClaudeSDKMessage,
} from "../types";

export type QueryFactoryInput = {
  prompt: string;
  abortController?: AbortController;
  options: Pick<
    Options,
    | "cwd"
    | "permissionMode"
    | "model"
    | "resume"
    | "mcpServers"
    | "settingSources"
    | "thinking"
    | "effort"
    | "includePartialMessages"
    | "systemPrompt"
    | "allowDangerouslySkipPermissions"
  >;
};

export type QueryFactory = (input: QueryFactoryInput) => ClaudeQuery;

export interface RunRequest {
  prompt: string;
  cwd: string;
  sessionId?: string;
  model?: string;
  systemPrompt?: string;
  thinking?: Options["thinking"];
  effort?: Options["effort"];
  permissionMode?: ClaudePermissionMode;
  abortController?: AbortController;
  onQueryStart?: (query: ClaudeQuery) => void;
  onMessage?: (message: ClaudeSDKMessage) => void;
  onTextDelta?: (text: string) => void;
  onThinkingDelta?: (thinking: string) => void;
}

export interface RunResult {
  text: string;
  sessionId?: string;
  costUsd?: number;
  durationMs?: number;
  turnCount?: number;
  messages: ClaudeSDKMessage[];
}

const DISCORD_BRIDGE_PROMPT_POLICY = [
  "You are running inside a Discord bridge host.",
  "Important: you CAN return files/images to the user via this host.",
  "Do not claim that you cannot send attachments.",
  "When you want the bridge to attach a file, include a standalone line: ATTACH: <path-to-file>.",
  "For web testing/screenshots, use agent-browser commands when needed.",
  "When asked to return an artifact (image/file), create or modify a real file and keep it on disk.",
  "Prefer writing outputs in the current project directory unless the user requests otherwise.",
].join(" ");

function buildSystemPrompt(channelSystemPrompt?: string): string {
  if (!channelSystemPrompt?.trim()) {
    return DISCORD_BRIDGE_PROMPT_POLICY;
  }
  return [DISCORD_BRIDGE_PROMPT_POLICY, channelSystemPrompt.trim()].join("\n\n");
}

export class ClaudeRunner {
  constructor(
    private readonly queryFactory: QueryFactory = claudeQuery as unknown as QueryFactory,
  ) {}

  async run(request: RunRequest): Promise<RunResult> {
    const abortController = request.abortController ?? new AbortController();
    const permissionMode = request.permissionMode ?? "bypassPermissions";
    const mcpServers = await loadMcpServers(request.cwd);
    const attempts = buildRunAttempts({
      hasMcpServers: Boolean(mcpServers),
      hasSessionId: Boolean(request.sessionId),
    });
    const failedAttemptLabels: string[] = [];

    for (let index = 0; index < attempts.length; index++) {
      const attempt = attempts[index];
      if (!attempt) {
        continue;
      }
      try {
        return await this.runSingleQuery({
          request,
          abortController,
          permissionMode,
          mcpServers,
          includeMcpServers: attempt.includeMcpServers,
          includeResume: attempt.includeResume,
          settingSources: attempt.settingSources,
        });
      } catch (error) {
        failedAttemptLabels.push(attempt.label);
        const canRetry = shouldRetryAfterProcessExit(error) && index < attempts.length - 1;
        if (!canRetry) {
          throw wrapRunnerError(error, formatAttemptContext(failedAttemptLabels));
        }
      }
    }

    throw new Error("Runner exhausted retries without returning a result.");
  }

  private async runSingleQuery(input: {
    request: RunRequest;
    abortController: AbortController;
    permissionMode: ClaudePermissionMode;
    mcpServers?: Record<string, ClaudeMcpServerConfig>;
    includeMcpServers: boolean;
    includeResume: boolean;
    settingSources: NonNullable<Options["settingSources"]>;
  }): Promise<RunResult> {
    const options: QueryFactoryInput["options"] = {
      cwd: input.request.cwd,
      permissionMode: input.permissionMode,
      settingSources: input.settingSources,
      includePartialMessages: true,
      thinking: input.request.thinking ?? { type: "adaptive" },
      systemPrompt: buildSystemPrompt(input.request.systemPrompt),
      ...(input.permissionMode === "bypassPermissions"
        ? { allowDangerouslySkipPermissions: true }
        : {}),
      ...(input.request.model ? { model: input.request.model } : {}),
      ...(input.request.effort ? { effort: input.request.effort } : {}),
      ...(input.includeResume && input.request.sessionId
        ? { resume: input.request.sessionId }
        : {}),
      ...(input.includeMcpServers && input.mcpServers ? { mcpServers: input.mcpServers } : {}),
    };

    const query = this.queryFactory({
      prompt: input.request.prompt,
      abortController: input.abortController,
      options,
    });

    input.request.onQueryStart?.(query);

    const messages: ClaudeSDKMessage[] = [];
    let text = "";
    let sawStreamText = false;
    let sessionId: string | undefined;
    let costUsd: number | undefined;
    let durationMs: number | undefined;
    let turnCount: number | undefined;

    for await (const message of query) {
      messages.push(message);
      input.request.onMessage?.(message);

      sessionId = readSessionId(message) ?? sessionId;
      const streamChunk = extractStreamTextDelta(message);
      if (streamChunk) {
        sawStreamText = true;
        text += streamChunk;
        input.request.onTextDelta?.(streamChunk);
      }
      const thinkingChunk = extractStreamThinkingDelta(message);
      if (thinkingChunk) {
        input.request.onThinkingDelta?.(thinkingChunk);
      }

      if (isResultMessage(message)) {
        costUsd = message.total_cost_usd;
        durationMs = message.duration_ms;
        turnCount = message.num_turns;

        if (!sawStreamText && message.subtype === "success") {
          text = message.result;
        }
      } else if (!sawStreamText && isAssistantMessage(message)) {
        const assistantText = extractAssistantText(message);
        if (assistantText) {
          text += assistantText;
        }
      }
    }

    return {
      text,
      sessionId,
      costUsd,
      durationMs,
      turnCount,
      messages,
    };
  }
}

type RunAttempt = {
  includeMcpServers: boolean;
  includeResume: boolean;
  settingSources: NonNullable<Options["settingSources"]>;
  label: string;
};

function buildRunAttempts(input: { hasMcpServers: boolean; hasSessionId: boolean }): RunAttempt[] {
  const attempts: RunAttempt[] = [];
  const seen = new Set<string>();

  const push = (attempt: RunAttempt) => {
    const key = [
      attempt.includeMcpServers ? "mcp" : "no-mcp",
      attempt.includeResume ? "resume" : "no-resume",
      attempt.settingSources.join(","),
    ].join("|");
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    attempts.push(attempt);
  };

  push({
    includeMcpServers: true,
    includeResume: true,
    settingSources: ["project", "local"],
    label: "default",
  });

  if (input.hasMcpServers) {
    push({
      includeMcpServers: false,
      includeResume: true,
      settingSources: ["project", "local"],
      label: "without MCP",
    });
  }

  if (input.hasSessionId) {
    push({
      includeMcpServers: true,
      includeResume: false,
      settingSources: ["project", "local"],
      label: "without session resume",
    });
  }

  if (input.hasMcpServers && input.hasSessionId) {
    push({
      includeMcpServers: false,
      includeResume: false,
      settingSources: ["project", "local"],
      label: "without MCP and session resume",
    });
  }

  push({
    includeMcpServers: false,
    includeResume: false,
    settingSources: ["user"],
    label: "safe mode (user settings only)",
  });

  return attempts;
}

function shouldRetryAfterProcessExit(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return /\bexited with code 1\b/i.test(error.message);
}

function formatAttemptContext(attemptLabels: string[]): string | undefined {
  if (attemptLabels.length <= 1) {
    return undefined;
  }
  return `Attempted recovery modes: ${attemptLabels.join(" -> ")}.`;
}

function wrapRunnerError(error: unknown, context?: string): Error {
  if (error instanceof Error) {
    const message = context ? `${context} ${error.message}` : error.message;
    return new Error(message, { cause: error });
  }
  const message = context ? `${context} ${String(error)}` : String(error);
  return new Error(message);
}

async function loadMcpServers(
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

function readSessionId(message: ClaudeSDKMessage): string | undefined {
  if ("session_id" in message && typeof message.session_id === "string") {
    return message.session_id;
  }
  return undefined;
}

function isResultMessage(
  message: ClaudeSDKMessage,
): message is Extract<ClaudeSDKMessage, { type: "result" }> {
  return message.type === "result";
}

function isAssistantMessage(
  message: ClaudeSDKMessage,
): message is Extract<ClaudeSDKMessage, { type: "assistant" }> {
  return message.type === "assistant";
}

function extractStreamTextDelta(message: ClaudeSDKMessage): string | null {
  if (message.type !== "stream_event") {
    return null;
  }

  const event = message.event;
  if (!event || event.type !== "content_block_delta") {
    return null;
  }

  const delta = event.delta;
  if (!delta || delta.type !== "text_delta" || typeof delta.text !== "string") {
    return null;
  }

  return delta.text;
}

function extractStreamThinkingDelta(message: ClaudeSDKMessage): string | null {
  if (message.type !== "stream_event") {
    return null;
  }

  const event = message.event;
  if (!event || event.type !== "content_block_delta") {
    return null;
  }

  const delta = event.delta;
  if (!delta || delta.type !== "thinking_delta" || typeof delta.thinking !== "string") {
    return null;
  }

  return delta.thinking;
}

function extractAssistantText(message: Extract<ClaudeSDKMessage, { type: "assistant" }>): string {
  const blocks = message.message.content;
  if (!Array.isArray(blocks)) {
    return "";
  }

  const parts: string[] = [];
  for (const block of blocks) {
    if (block.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
    }
  }
  return parts.join("");
}
