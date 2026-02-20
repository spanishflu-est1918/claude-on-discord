import type { Options } from "@anthropic-ai/claude-agent-sdk";
import type {
  ClaudeMcpServerConfig,
  ClaudePermissionMode,
  ClaudeQuery,
  ClaudeSDKMessage,
  ClaudeSDKUserMessage,
} from "../../types";
import { AsyncInputQueue } from "./async-input-queue";
import { safeWrapRunnerError } from "./error-utils";
import {
  buildUserPromptMessage,
  extractAssistantText,
  extractAssistantThinking,
  extractStreamTextDelta,
  extractStreamThinkingDelta,
  isAssistantMessage,
  isResultMessage,
  readSessionId,
} from "./message-utils";
import { buildSystemPrompt } from "./prompt-policy";
import type { QueryFactory, QueryFactoryInput, RunRequest, RunResult } from "../runner";

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

export interface WorkerConfig {
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

export class ChannelWorker {
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
