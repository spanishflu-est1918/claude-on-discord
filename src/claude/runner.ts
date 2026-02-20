import { query as claudeQuery, type Options } from "@anthropic-ai/claude-agent-sdk";
import {
  formatAttemptContext,
  safeWrapRunnerError,
  shouldRetryAfterProcessExit,
} from "./runner/error-utils";
import { ChannelWorker } from "./runner/channel-worker";
import {
  buildRunAttempts,
  loadMcpServers,
  mergeMcpServers,
  toStableMcpSignature,
} from "./runner/mcp-utils";
import { buildWorkerSignature } from "./runner/worker-signature";
import type {
  ClaudeMcpServerConfig,
  ClaudePermissionMode,
  ClaudeQuery,
  ClaudeSDKMessage,
  ClaudeSDKUserMessage
} from "../types";

export type QueryFactoryInput = {
  prompt: string | AsyncIterable<ClaudeSDKUserMessage>;
  abortController?: AbortController;
  options: Omit<
    Pick<
      Options,
      | "cwd"
      | "permissionMode"
      | "model"
      | "resume"
      | "forkSession"
      | "mcpServers"
      | "disallowedTools"
      | "tools"
      | "canUseTool"
      | "settingSources"
      | "thinking"
      | "effort"
      | "maxTurns"
      | "includePartialMessages"
      | "systemPrompt"
      | "allowDangerouslySkipPermissions"
    >,
    "permissionMode"
  > & {
    permissionMode: ClaudePermissionMode;
  };
};

export type QueryFactory = (input: QueryFactoryInput) => ClaudeQuery;

export interface RunRequest {
  channelId: string;
  prompt: string;
  resumeFallbackPrompt?: string;
  cwd: string;
  sessionId?: string;
  forkSession?: boolean;
  model?: string;
  systemPrompt?: string;
  mcpServers?: Record<string, ClaudeMcpServerConfig>;
  thinking?: Options["thinking"];
  effort?: Options["effort"];
  maxTurns?: Options["maxTurns"];
  permissionMode?: ClaudePermissionMode;
  disallowedTools?: string[];
  tools?: Options["tools"];
  canUseTool?: Options["canUseTool"];
  toolPolicyKey?: string;
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

export class ClaudeRunner {
  private readonly workersByChannel = new Map<string, ChannelWorker>();

  constructor(
    private readonly queryFactory: QueryFactory = claudeQuery as unknown as QueryFactory,
  ) {}

  closeAll(): void {
    for (const worker of this.workersByChannel.values()) {
      worker.close("Runner shutdown");
    }
    this.workersByChannel.clear();
  }

  steer(channelId: string, message: string): boolean {
    const worker = this.workersByChannel.get(channelId);
    if (!worker || worker.isClosed()) {
      return false;
    }
    return worker.steer(message);
  }

  async run(request: RunRequest): Promise<RunResult> {
    const permissionMode = request.permissionMode ?? "bypassPermissions";
    const loadedMcpServers = await loadMcpServers(request.cwd);
    const mcpServers = mergeMcpServers(loadedMcpServers, request.mcpServers);
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
        const workerSignature = buildWorkerSignature({
          request,
          permissionMode,
          mcpServers,
          includeMcpServers: attempt.includeMcpServers,
          includeResume: attempt.includeResume,
          disableTools: attempt.disableTools,
          settingSources: attempt.settingSources,
          toStableMcpSignature,
        });
        let worker = this.workersByChannel.get(request.channelId);
        if (worker && (worker.isClosed() || !worker.matches(workerSignature))) {
          worker.close("Worker reconfigured");
          this.workersByChannel.delete(request.channelId);
          worker = undefined;
        }

        if (!worker) {
          worker = new ChannelWorker(this.queryFactory, {
            signature: workerSignature,
            cwd: request.cwd,
            permissionMode,
            model: request.model,
            thinking: request.thinking,
            effort: request.effort,
            maxTurns: request.maxTurns,
            systemPrompt: request.systemPrompt,
            resumeSessionId: attempt.includeResume ? request.sessionId : undefined,
            forkSession: attempt.includeResume ? request.forkSession : undefined,
            mcpServers: attempt.includeMcpServers ? mcpServers : undefined,
            disallowedTools: request.disallowedTools,
            tools: attempt.disableTools ? [] : request.tools,
            canUseTool: request.canUseTool,
            settingSources: attempt.settingSources,
          });
          this.workersByChannel.set(request.channelId, worker);
        }

        const effectivePrompt =
          !attempt.includeResume && request.resumeFallbackPrompt
            ? request.resumeFallbackPrompt
            : request.prompt;
        const result = await worker.run({
          ...request,
          prompt: effectivePrompt,
        });
        const shouldRetryResult =
          attempt.includeResume &&
          index < attempts.length - 1 &&
          shouldRetryAfterExecutionErrorResult(result);
        if (shouldRetryResult) {
          failedAttemptLabels.push(`${attempt.label} (execution error result)`);
          const activeWorker = this.workersByChannel.get(request.channelId);
          if (activeWorker) {
            activeWorker.close("Worker reset after execution error result");
            this.workersByChannel.delete(request.channelId);
          }
          continue;
        }
        return result;
      } catch (error) {
        failedAttemptLabels.push(attempt.label);
        const activeWorker = this.workersByChannel.get(request.channelId);
        if (activeWorker) {
          activeWorker.close("Worker reset after run failure");
          this.workersByChannel.delete(request.channelId);
        }
        const canRetry = shouldRetryAfterProcessExit(error) && index < attempts.length - 1;
        if (!canRetry) {
          throw safeWrapRunnerError(error, formatAttemptContext(failedAttemptLabels));
        }
      }
    }

    throw new Error("Runner exhausted retries without returning a result.");
  }
}

function shouldRetryAfterExecutionErrorResult(result: RunResult): boolean {
  const resultMessage = result.messages.find(
    (message) => message.type === "result",
  ) as Extract<ClaudeSDKMessage, { type: "result" }> | undefined;
  if (!resultMessage) {
    return false;
  }
  return resultMessage.subtype === "error_during_execution";
}
