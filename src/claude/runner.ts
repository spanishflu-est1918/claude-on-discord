import { query as claudeQuery, type Options } from "@anthropic-ai/claude-agent-sdk";
import type { ClaudePermissionMode, ClaudeQuery, ClaudeSDKMessage } from "../types";

export type QueryFactoryInput = {
  prompt: string;
  abortController?: AbortController;
  options: Pick<Options, "cwd" | "permissionMode" | "model" | "resume">;
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
    const query = this.queryFactory({
      prompt: request.prompt,
      abortController,
      options: {
        cwd: request.cwd,
        permissionMode: request.permissionMode ?? "bypassPermissions",
        ...(request.model ? { model: request.model } : {}),
        ...(request.sessionId ? { resume: request.sessionId } : {}),
      },
    });

    request.onQueryStart?.(query);

    const messages: ClaudeSDKMessage[] = [];
    let text = "";
    let sawStreamText = false;
    let sessionId: string | undefined;
    let costUsd: number | undefined;
    let durationMs: number | undefined;
    let turnCount: number | undefined;

    for await (const message of query) {
      messages.push(message);
      request.onMessage?.(message);

      sessionId = readSessionId(message) ?? sessionId;
      const streamChunk = extractStreamTextDelta(message);
      if (streamChunk) {
        sawStreamText = true;
        text += streamChunk;
        request.onTextDelta?.(streamChunk);
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
