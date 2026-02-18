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
    | "allowDangerouslySkipPermissions"
  >;
};

export type QueryFactory = (input: QueryFactoryInput) => ClaudeQuery;

export interface RunRequest {
  prompt: string;
  cwd: string;
  sessionId?: string;
  model?: string;
  permissionMode?: ClaudePermissionMode;
  abortController?: AbortController;
  onQueryStart?: (query: ClaudeQuery) => void;
  onMessage?: (message: ClaudeSDKMessage) => void;
  onTextDelta?: (text: string) => void;
}

export interface RunResult {
  text: string;
  sessionId?: string;
  costUsd?: number;
  durationMs?: number;
  turnCount?: number;
  messages: ClaudeSDKMessage[];
}

export class ClaudeRunner {
  constructor(
    private readonly queryFactory: QueryFactory = claudeQuery as unknown as QueryFactory,
  ) {}

  async run(request: RunRequest): Promise<RunResult> {
    const abortController = request.abortController ?? new AbortController();
    const permissionMode = request.permissionMode ?? "bypassPermissions";
    const mcpServers = await loadMcpServers(request.cwd);
    const hasMcpServers = Boolean(mcpServers);
    try {
      return await this.runSingleQuery({
        request,
        abortController,
        permissionMode,
        mcpServers,
        includeMcpServers: true,
        includeResume: true,
      });
    } catch (error) {
      if (hasMcpServers && shouldRetryWithoutMcp(error)) {
        try {
          return await this.runSingleQuery({
            request,
            abortController,
            permissionMode,
            mcpServers,
            includeMcpServers: false,
            includeResume: true,
          });
        } catch (retryError) {
          if (request.sessionId && shouldRetryWithoutResume(retryError)) {
            try {
              return await this.runSingleQuery({
                request,
                abortController,
                permissionMode,
                mcpServers,
                includeMcpServers: false,
                includeResume: false,
              });
            } catch (freshSessionError) {
              throw wrapRunnerError(
                freshSessionError,
                "Retried without MCP and without session resume after Claude process failures.",
              );
            }
          }
          throw wrapRunnerError(
            retryError,
            "Retried without MCP servers after the initial Claude process failed.",
          );
        }
      }

      if (request.sessionId && shouldRetryWithoutResume(error)) {
        try {
          return await this.runSingleQuery({
            request,
            abortController,
            permissionMode,
            mcpServers,
            includeMcpServers: true,
            includeResume: false,
          });
        } catch (freshSessionError) {
          throw wrapRunnerError(
            freshSessionError,
            "Retried without session resume after the initial Claude process failed.",
          );
        }
      }

      throw wrapRunnerError(error);
    }
  }

  private async runSingleQuery(input: {
    request: RunRequest;
    abortController: AbortController;
    permissionMode: ClaudePermissionMode;
    mcpServers?: Record<string, ClaudeMcpServerConfig>;
    includeMcpServers: boolean;
    includeResume: boolean;
  }): Promise<RunResult> {
    const options: QueryFactoryInput["options"] = {
      cwd: input.request.cwd,
      permissionMode: input.permissionMode,
      settingSources: ["project", "local"],
      ...(input.permissionMode === "bypassPermissions"
        ? { allowDangerouslySkipPermissions: true }
        : {}),
      ...(input.request.model ? { model: input.request.model } : {}),
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

function shouldRetryWithoutMcp(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return /\bexited with code 1\b/i.test(error.message);
}

function shouldRetryWithoutResume(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return /\bexited with code 1\b/i.test(error.message);
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
