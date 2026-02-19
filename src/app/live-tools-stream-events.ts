import type { ClaudeSDKMessage } from "../types";
import { summarizeToolInput } from "./live-tools-input-summary";

type ToolStartStreamEvent = {
  id: string;
  index?: number;
  name?: string;
  inputPreview?: string;
  inputDetails?: string;
  activity?: string;
  inputBufferSeed?: string;
};

export function extractToolStartFromStreamEvent(
  message: ClaudeSDKMessage,
): ToolStartStreamEvent | null {
  if (message.type !== "stream_event") {
    return null;
  }
  const event = message.event as {
    type?: string;
    index?: number;
    content_block_index?: number;
    content_block?: {
      type?: string;
      id?: string;
      tool_use_id?: string;
      name?: string;
      tool_name?: string;
      input?: unknown;
    };
  };
  if (event.type !== "content_block_start") {
    return null;
  }
  const block = event.content_block;
  if (!block || (block.type !== "tool_use" && block.type !== "server_tool_use")) {
    return null;
  }
  const id = block.id ?? block.tool_use_id;
  if (!id) {
    return null;
  }
  const eventIndex =
    typeof event.index === "number"
      ? event.index
      : typeof event.content_block_index === "number"
        ? event.content_block_index
        : undefined;
  let inputBufferSeed: string | undefined;
  if (typeof block.input === "string") {
    inputBufferSeed = block.input || undefined;
  } else if (typeof block.input !== "undefined") {
    try {
      const serialized = JSON.stringify(block.input);
      if (serialized && serialized !== "{}" && serialized !== "[]" && serialized !== "null") {
        inputBufferSeed = serialized;
      }
    } catch {
      inputBufferSeed = undefined;
    }
  }
  const summarized = summarizeToolInput(block.input);
  return {
    id,
    index: eventIndex,
    name: block.name ?? block.tool_name,
    inputPreview: summarized.preview,
    inputDetails: summarized.details,
    activity: summarized.activity,
    inputBufferSeed,
  };
}

export function extractToolInputDelta(
  message: ClaudeSDKMessage,
): { index: number; partialJson: string } | null {
  if (message.type !== "stream_event") {
    return null;
  }
  const event = message.event as {
    type?: string;
    index?: number;
    delta?: { type?: string; partial_json?: string };
  };
  if (event.type !== "content_block_delta" || typeof event.index !== "number") {
    return null;
  }
  const delta = event.delta;
  if (!delta || delta.type !== "input_json_delta" || typeof delta.partial_json !== "string") {
    return null;
  }
  return { index: event.index, partialJson: delta.partial_json };
}
