import { query as claudeQuery, type Options } from "@anthropic-ai/claude-agent-sdk";
import { AsyncInputQueue } from "./runner/async-input-queue";
import {
  formatAttemptContext,
  safeWrapRunnerError,
  shouldRetryAfterProcessExit,
} from "./runner/error-utils";
import {
  buildUserPromptMessage,
  extractAssistantText,
  extractAssistantThinking,
  extractStreamTextDelta,
  extractStreamThinkingDelta,
  isAssistantMessage,
  isResultMessage,
  readSessionId,
} from "./runner/message-utils";
import {
  buildRunAttempts,
  loadMcpServers,
  mergeMcpServers,
  toStableMcpSignature,
} from "./runner/mcp-utils";
import { buildSystemPrompt } from "./runner/prompt-policy";
import { buildWorkerSignature } from "./runner/worker-signature";
import type {
  ClaudeMcpServerConfig,
  ClaudePermissionMode,
  ClaudeQuery,
  ClaudeSDKMessage,
  ClaudeSDKUserMessage,
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

interface PendingRun {
  request: RunRequest;
  resolve: (result: RunResult) => void;
  reject: (error: unknown) => void;
  started: boolean;
  aborted: boolean;
  messages: ClaudeSDKMessage[];
  text: string;
  sawStreamText: boolean;
  sawStreamThinking: boolean;
  costUsd?: number;
  durationMs?: number;
  turnCount?: number;
  cleanupAbortListener: () => void;
}

interface WorkerConfig {
  signature: string;
  cwd: string;
  permissionMode: ClaudePermissionMode;
  model?: string;
  thinking?: Options["thinking"];
  effort?: Options["effort"];
  maxTurns?: Options["maxTurns"];
  systemPrompt?: string;
  resumeSessionId?: string;
  forkSession?: boolean;
  mcpServers?: Record<string, ClaudeMcpServerConfig>;
  disallowedTools?: string[];
  tools?: Options["tools"];
  canUseTool?: Options["canUseTool"];
  settingSources: NonNullable<Options["settingSources"]>;
}

class ChannelWorker {
  private readonly inputQueue = new AsyncInputQueue<ClaudeSDKUserMessage>();
  private readonly query: ClaudeQuery;
  private readonly pendingRuns: PendingRun[] = [];
  private closed = false;
  private closeError: Error | null = null;
  private sessionId: string | undefined;

  constructor(
    private readonly queryFactory: QueryFactory,
    private readonly config: WorkerConfig,
  ) {
    const options: QueryFactoryInput["options"] = {
      cwd: config.cwd,
      permissionMode: config.permissionMode,
      settingSources: config.settingSources,
      includePartialMessages: true,
      thinking: config.thinking ?? { type: "adaptive" },
      systemPrompt: buildSystemPrompt(config.systemPrompt),
      ...(config.permissionMode === "bypassPermissions"
        ? { allowDangerouslySkipPermissions: true }
        : {}),
      ...(config.model ? { model: config.model } : {}),
      ...(config.effort ? { effort: config.effort } : {}),
      ...(typeof config.maxTurns === "number" ? { maxTurns: config.maxTurns } : {}),
      ...(config.resumeSessionId ? { resume: config.resumeSessionId } : {}),
      ...(config.resumeSessionId && config.forkSession ? { forkSession: true } : {}),
      ...(config.mcpServers ? { mcpServers: config.mcpServers } : {}),
      ...(config.disallowedTools ? { disallowedTools: config.disallowedTools } : {}),
      ...(typeof config.tools !== "undefined" ? { tools: config.tools } : {}),
      ...(config.canUseTool ? { canUseTool: config.canUseTool } : {}),
    };

    this.query = this.queryFactory({
      prompt: this.inputQueue,
      options,
    });
    void this.consumeQueryMessages();
  }

  matches(signature: string): boolean {
    return this.config.signature === signature;
  }

  isClosed(): boolean {
    return this.closed;
  }

  close(reason = "Worker closed"): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    const closeError = new Error(reason);
    this.closeError = closeError;
    this.inputQueue.end();
    try {
      this.query.close();
    } catch {
      // Ignore close errors.
    }
    this.rejectPending(closeError);
  }

  steer(message: string): boolean {
    if (this.closed || this.pendingRuns.length === 0) {
      return false;
    }
    this.inputQueue.enqueue(buildUserPromptMessage(message));
    return true;
  }

  async run(request: RunRequest): Promise<RunResult> {
    if (this.closed) {
      throw this.closeError ?? new Error("Worker is closed.");
    }

    return await new Promise<RunResult>((resolve, reject) => {
      const pending: PendingRun = {
        request,
        resolve,
        reject,
        started: false,
        aborted: false,
        messages: [],
        text: "",
        sawStreamText: false,
        sawStreamThinking: false,
        cleanupAbortListener: () => {},
      };

      const signal = request.abortController?.signal;
      if (signal) {
        const onAbort = () => {
          void this.onAbort(pending);
        };
        signal.addEventListener("abort", onAbort, { once: true });
        pending.cleanupAbortListener = () => signal.removeEventListener("abort", onAbort);
        if (signal.aborted) {
          pending.cleanupAbortListener();
          reject(new Error("Operation aborted."));
          return;
        }
      }

      this.pendingRuns.push(pending);
      if (this.pendingRuns.length === 1) {
        this.startRun(pending);
      }

      this.inputQueue.enqueue(buildUserPromptMessage(request.prompt));
    });
  }

  private startRun(run: PendingRun): void {
    if (run.started) {
      return;
    }
    run.started = true;
    run.request.onQueryStart?.(this.query);
  }

  private async onAbort(run: PendingRun): Promise<void> {
    const index = this.pendingRuns.indexOf(run);
    if (index === -1) {
      return;
    }
    if (index === 0) {
      run.aborted = true;
      this.close("Operation aborted.");
      return;
    }
    this.pendingRuns.splice(index, 1);
    run.cleanupAbortListener();
    run.reject(new Error("Operation aborted."));
  }

  private async consumeQueryMessages(): Promise<void> {
    try {
      for await (const message of this.query) {
        this.sessionId = readSessionId(message) ?? this.sessionId;

        const current = this.pendingRuns[0];
        if (!current) {
          continue;
        }

        current.messages.push(message);
        current.request.onMessage?.(message);

        const streamChunk = extractStreamTextDelta(message);
        if (streamChunk) {
          current.sawStreamText = true;
          current.text += streamChunk;
          current.request.onTextDelta?.(streamChunk);
        }
        const thinkingChunk = extractStreamThinkingDelta(message);
        if (thinkingChunk) {
          current.sawStreamThinking = true;
          current.request.onThinkingDelta?.(thinkingChunk);
        }

        if (isResultMessage(message)) {
          current.costUsd = message.total_cost_usd;
          current.durationMs = message.duration_ms;
          current.turnCount = message.num_turns;

          if (!current.sawStreamText && message.subtype === "success") {
            current.text = message.result;
          }

          this.finishCurrentRun();
        } else if (!current.sawStreamText && isAssistantMessage(message)) {
          const assistantText = extractAssistantText(message);
          if (assistantText) {
            current.text += assistantText;
          }
          if (!current.sawStreamThinking) {
            const assistantThinking = extractAssistantThinking(message);
            if (assistantThinking) {
              current.request.onThinkingDelta?.(assistantThinking);
            }
          }
        }
      }

      if (!this.closed) {
        const error = new Error("Claude query ended unexpectedly.");
        this.closeError = error;
        this.inputQueue.fail(error);
        this.rejectPending(error);
        this.closed = true;
      }
    } catch (error) {
      let wrapped: Error;
      try {
        wrapped = safeWrapRunnerError(error);
      } catch {
        wrapped = new Error("Claude query failed.");
      }
      this.closeError = wrapped;
      this.inputQueue.fail(wrapped);
      this.rejectPending(wrapped);
      this.closed = true;
    }
  }

  private finishCurrentRun(): void {
    const run = this.pendingRuns.shift();
    if (!run) {
      return;
    }

    run.cleanupAbortListener();
    const text = run.aborted && run.text.trim().length === 0 ? "Interrupted." : run.text;
    run.resolve({
      text,
      sessionId: this.sessionId,
      costUsd: run.costUsd,
      durationMs: run.durationMs,
      turnCount: run.turnCount,
      messages: run.messages,
    });

    const next = this.pendingRuns[0];
    if (next) {
      this.startRun(next);
    }
  }

  private rejectPending(error: Error): void {
    while (this.pendingRuns.length > 0) {
      const run = this.pendingRuns.shift();
      if (!run) {
        continue;
      }
      run.cleanupAbortListener();
      run.reject(error);
    }
  }
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
