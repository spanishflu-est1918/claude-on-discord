import type { ClaudeSDKMessage, ClaudeSDKUserMessage } from "../../types";

export function buildUserPromptMessage(prompt: string): ClaudeSDKUserMessage {
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

export function readSessionId(message: ClaudeSDKMessage): string | undefined {
  if ("session_id" in message && typeof message.session_id === "string") {
    return message.session_id;
  }
  return undefined;
}

export function isResultMessage(
  message: ClaudeSDKMessage,
): message is Extract<ClaudeSDKMessage, { type: "result" }> {
  return message.type === "result";
}

export function isAssistantMessage(
  message: ClaudeSDKMessage,
): message is Extract<ClaudeSDKMessage, { type: "assistant" }> {
  return message.type === "assistant";
}

export function extractStreamTextDelta(message: ClaudeSDKMessage): string | null {
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

export function extractStreamThinkingDelta(message: ClaudeSDKMessage): string | null {
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

export function extractAssistantText(
  message: Extract<ClaudeSDKMessage, { type: "assistant" }>,
): string {
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

export function extractAssistantThinking(
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
