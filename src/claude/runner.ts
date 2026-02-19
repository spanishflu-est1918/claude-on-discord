import { readFile } from "node:fs/promises";
import path from "node:path";
import { query as claudeQuery, type Options } from "@anthropic-ai/claude-agent-sdk";
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
  options: Pick<
    Options,
    | "cwd"
    | "permissionMode"
    | "model"
    | "resume"
    | "forkSession"
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

type RunAttempt = {
  includeMcpServers: boolean;
  includeResume: boolean;
  settingSources: NonNullable<Options["settingSources"]>;
  label: string;
};

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

class AsyncInputQueue<T> implements AsyncIterable<T> {
  private values: T[] = [];
  private waiters: Array<{
    resolve: (result: IteratorResult<T>) => void;
    reject: (error: unknown) => void;
  }> = [];
  private ended = false;
  private endedError: Error | null = null;

  enqueue(value: T): void {
    if (this.ended) {
      return;
    }
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter.resolve({ done: false, value });
      return;
    }
    this.values.push(value);
  }

  end(): void {
    if (this.ended) {
      return;
    }
    this.ended = true;
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift();
      waiter?.resolve({ done: true, value: undefined as T });
    }
  }

  fail(error: Error): void {
    if (this.ended) {
      return;
    }
    this.ended = true;
    this.endedError = error;
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift();
      waiter?.reject(error);
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: async (): Promise<IteratorResult<T>> => {
        if (this.values.length > 0) {
          const value = this.values.shift();
          if (typeof value === "undefined") {
            return { done: true, value: undefined };
          }
          return { done: false, value };
        }
        if (this.ended) {
          if (this.endedError) {
            throw this.endedError;
          }
          return { done: true, value: undefined };
        }
        return await new Promise<IteratorResult<T>>((resolve, reject) => {
          this.waiters.push({ resolve, reject });
        });
      },
      return: async (): Promise<IteratorResult<T>> => {
        this.end();
        return { done: true, value: undefined };
      },
    };
  }
}

interface WorkerConfig {
  signature: string;
  cwd: string;
  permissionMode: ClaudePermissionMode;
  model?: string;
  thinking?: Options["thinking"];
  effort?: Options["effort"];
  systemPrompt?: string;
  resumeSessionId?: string;
  forkSession?: boolean;
  mcpServers?: Record<string, ClaudeMcpServerConfig>;
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
      ...(config.resumeSessionId ? { resume: config.resumeSessionId } : {}),
      ...(config.resumeSessionId && config.forkSession ? { forkSession: true } : {}),
      ...(config.mcpServers ? { mcpServers: config.mcpServers } : {}),
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
      const wrapped = wrapRunnerError(error);
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
          settingSources: attempt.settingSources,
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
            systemPrompt: request.systemPrompt,
            resumeSessionId: attempt.includeResume ? request.sessionId : undefined,
            forkSession: attempt.includeResume ? request.forkSession : undefined,
            mcpServers: attempt.includeMcpServers ? mcpServers : undefined,
            settingSources: attempt.settingSources,
          });
          this.workersByChannel.set(request.channelId, worker);
        }

        const effectivePrompt =
          !attempt.includeResume && request.resumeFallbackPrompt
            ? request.resumeFallbackPrompt
            : request.prompt;
        return await worker.run({
          ...request,
          prompt: effectivePrompt,
        });
      } catch (error) {
        failedAttemptLabels.push(attempt.label);
        const activeWorker = this.workersByChannel.get(request.channelId);
        if (activeWorker) {
          activeWorker.close("Worker reset after run failure");
          this.workersByChannel.delete(request.channelId);
        }
        const canRetry = shouldRetryAfterProcessExit(error) && index < attempts.length - 1;
        if (!canRetry) {
          throw wrapRunnerError(error, formatAttemptContext(failedAttemptLabels));
        }
      }
    }

    throw new Error("Runner exhausted retries without returning a result.");
  }
}

function buildWorkerSignature(input: {
  request: RunRequest;
  permissionMode: ClaudePermissionMode;
  mcpServers?: Record<string, ClaudeMcpServerConfig>;
  includeMcpServers: boolean;
  includeResume: boolean;
  settingSources: NonNullable<Options["settingSources"]>;
}): string {
  return JSON.stringify({
    cwd: input.request.cwd,
    model: input.request.model ?? "",
    permissionMode: input.permissionMode,
    thinking: input.request.thinking ?? { type: "adaptive" },
    effort: input.request.effort ?? "",
    systemPrompt: buildSystemPrompt(input.request.systemPrompt),
    settingSources: input.settingSources,
    includeMcpServers: input.includeMcpServers,
    mcpServers: input.includeMcpServers ? toStableMcpSignature(input.mcpServers) : "",
    includeResume: input.includeResume,
    resumeSessionId: input.includeResume ? (input.request.sessionId ?? "") : "",
    forkSession: input.includeResume ? Boolean(input.request.forkSession) : false,
  });
}

function toStableMcpSignature(
  mcpServers?: Record<string, ClaudeMcpServerConfig>,
): Array<[string, Record<string, unknown>]> {
  if (!mcpServers) {
    return [];
  }
  return Object.entries(mcpServers)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, config]) => [name, toSerializableMcpConfig(config)]);
}

function toSerializableMcpConfig(config: ClaudeMcpServerConfig): Record<string, unknown> {
  if (config.type === "sdk") {
    return {
      type: "sdk",
      name: config.name,
    };
  }
  return config;
}

function mergeMcpServers(
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

function buildUserPromptMessage(prompt: string): ClaudeSDKUserMessage {
  return {
    type: "user",
    session_id: "",
    message: {
      role: "user",
      content: prompt,
    },
    parent_tool_use_id: null,
  };
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

function extractAssistantThinking(
  message: Extract<ClaudeSDKMessage, { type: "assistant" }>,
): string | null {
  const blocks = message.message.content;
  if (!Array.isArray(blocks)) {
    return null;
  }

  const parts: string[] = [];
  for (const block of blocks) {
    if (
      block &&
      typeof block === "object" &&
      "type" in block &&
      (block as { type?: string }).type === "thinking" &&
      "thinking" in block &&
      typeof (block as { thinking?: unknown }).thinking === "string"
    ) {
      parts.push((block as { thinking: string }).thinking);
    }
  }

  if (parts.length === 0) {
    return null;
  }
  return parts.join("");
}
