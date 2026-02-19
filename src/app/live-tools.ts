import {
  ContainerBuilder,
  MessageFlags,
  SectionBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
  TextDisplayBuilder,
} from "discord.js";
import { buildToolViewSectionButton } from "../discord/buttons";
import type { ClaudeSDKMessage } from "../types";
import { clipRawText, clipText, italicizeMultiline } from "./text";

export const THINKING_SPINNER_FRAMES = ["-", "\\", "|", "/"] as const;

export type LiveToolStatus = "queued" | "running" | "done" | "failed" | "interrupted";

export type LiveToolEntry = {
  id: string;
  name: string;
  status: LiveToolStatus;
  inputPreview?: string;
  inputDetails?: string;
  activity?: string;
  summary?: string;
  elapsedSeconds?: number;
  timeline: string[];
  startedAtMs: number;
  updatedAtMs: number;
  completedAtMs?: number;
};

export type LiveToolTrace = {
  order: string[];
  byId: Map<string, LiveToolEntry>;
  indexToToolId: Map<number, string>;
  inputJsonBufferByToolId: Map<string, string>;
  taskIdToToolId: Map<string, string>;
};

export function createLiveToolTrace(): LiveToolTrace {
  return {
    order: [],
    byId: new Map<string, LiveToolEntry>(),
    indexToToolId: new Map<number, string>(),
    inputJsonBufferByToolId: new Map<string, string>(),
    taskIdToToolId: new Map<string, string>(),
  };
}

function readStringField(source: unknown, keys: string[]): string | undefined {
  if (typeof source !== "object" || source === null) {
    return undefined;
  }
  for (const key of keys) {
    if (!(key in source)) {
      continue;
    }
    const value = (source as Record<string, unknown>)[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

function deriveToolActivity(input: unknown): string | undefined {
  const command = readStringField(input, ["command", "cmd", "shell_command"]);
  if (command) {
    return `$ ${clipText(command, 120)}`;
  }
  const url = readStringField(input, ["url", "uri"]);
  if (url) {
    return `url: ${clipText(url, 120)}`;
  }
  const pathValue = readStringField(input, [
    "path",
    "file_path",
    "filePath",
    "relative_workspace_path",
    "absolute_path",
    "cwd",
  ]);
  if (pathValue) {
    return `path: ${clipText(pathValue, 120)}`;
  }
  const query = readStringField(input, ["query", "pattern", "glob", "regex"]);
  if (query) {
    return `query: ${clipText(query, 120)}`;
  }
  const subagentType = readStringField(input, ["subagent_type", "agent_type", "type"]);
  const prompt = readStringField(input, ["prompt", "request", "message"]);
  if (subagentType && prompt) {
    return `${subagentType}: ${clipText(prompt, 100)}`;
  }
  const description = readStringField(input, ["description", "task", "objective"]);
  if (description) {
    return clipText(description, 120);
  }
  return undefined;
}

const STATUS_ACCENT_COLORS: Record<LiveToolStatus, number> = {
  queued: 0x5865f2, // Discord blurple
  running: 0xfee75c, // Yellow
  done: 0x57f287, // Green
  failed: 0xed4245, // Red
  interrupted: 0x95a5a6, // Gray
};

/**
 * Returns a short, human-readable description of what a tool is doing.
 * Handles common Claude SDK tool schemas with emoji prefixes.
 * Falls back to deriveToolActivity for unknown tools.
 */
function getToolDisplayLine(toolName: string, input: unknown): string | undefined {
  const str = (keys: string | string[]) =>
    readStringField(input, Array.isArray(keys) ? keys : [keys]);
  const num = (key: string): number | undefined => {
    if (typeof input !== "object" || input === null) return undefined;
    const val = (input as Record<string, unknown>)[key];
    return typeof val === "number" && Number.isFinite(val) ? val : undefined;
  };
  const shortenPath = (p: string) =>
    p.replace(/^\/Users\/[^/]+\//, "~/").replace(/^\/home\/[^/]+\//, "~/");

  switch (toolName) {
    case "Read": {
      const filePath = str("file_path");
      if (!filePath) break;
      const offset = num("offset");
      const limit = num("limit");
      const lineInfo =
        offset && limit
          ? ` · lines ${offset}–${offset + limit - 1}`
          : offset
            ? ` · from line ${offset}`
            : limit
              ? ` · first ${limit} lines`
              : "";
      return `📄 \`${shortenPath(filePath)}\`${lineInfo}`;
    }
    case "Write": {
      const filePath = str("file_path");
      return filePath ? `📝 \`${shortenPath(filePath)}\`` : undefined;
    }
    case "Edit": {
      const filePath = str("file_path");
      return filePath ? `✏️ \`${shortenPath(filePath)}\`` : undefined;
    }
    case "Bash": {
      const cmd = str(["command", "cmd"]);
      return cmd ? `\`$ ${clipText(cmd, 100)}\`` : undefined;
    }
    case "Glob": {
      const pattern = str("pattern");
      const searchPath = str("path");
      if (!pattern) break;
      return searchPath
        ? `🔍 \`${pattern}\` in \`${shortenPath(searchPath)}\``
        : `🔍 \`${pattern}\``;
    }
    case "Grep": {
      const pattern = str("pattern");
      const searchPath = str(["path", "glob"]);
      if (!pattern) break;
      return searchPath
        ? `🔍 \`${clipText(pattern, 60)}\` in \`${shortenPath(searchPath)}\``
        : `🔍 \`${clipText(pattern, 60)}\``;
    }
    case "WebSearch": {
      const query = str("query");
      return query ? `🌐 "${clipText(query, 100)}"` : undefined;
    }
    case "WebFetch": {
      const url = str("url");
      return url ? `🔗 ${clipText(url, 100)}` : undefined;
    }
    case "Task": {
      const subagentType = str(["subagent_type", "agent_type"]);
      const prompt = str(["prompt", "description", "task", "objective"]);
      if (subagentType && prompt) {
        return `🤖 ${subagentType}: ${clipText(prompt, 80)}`;
      }
      return prompt ? `🤖 ${clipText(prompt, 100)}` : undefined;
    }
    case "TodoWrite": {
      const todos =
        typeof input === "object" && input !== null
          ? (input as Record<string, unknown>).todos
          : undefined;
      const count = Array.isArray(todos) ? todos.length : undefined;
      return `📋 ${count !== undefined ? `${count} todo${count !== 1 ? "s" : ""}` : "todos"}`;
    }
    case "NotebookEdit": {
      const nbPath = str("notebook_path");
      return nbPath ? `📓 \`${shortenPath(nbPath)}\`` : undefined;
    }
  }
  // Fallback: reuse deriveToolActivity for unknown / MCP tools
  return deriveToolActivity(input);
}

/**
 * Derives a human-readable display line from a LiveToolEntry by parsing its
 * stored input preview/details JSON and calling getToolDisplayLine.
 * Falls back to the pre-computed activity string.
 */
function buildToolEntryDisplayLine(entry: LiveToolEntry): string | undefined {
  const tryParse = (json: string | undefined): unknown => {
    if (!json) return null;
    try {
      return JSON.parse(json);
    } catch {
      return null;
    }
  };
  const parsed = tryParse(entry.inputPreview) ?? tryParse(entry.inputDetails);
  if (parsed !== null && typeof parsed === "object") {
    const line = getToolDisplayLine(entry.name, parsed);
    if (line) return line;
  }
  return entry.activity;
}

function summarizeToolInput(input: unknown): {
  preview?: string;
  details?: string;
  activity?: string;
} {
  if (typeof input === "undefined") {
    return {};
  }
  if (typeof input === "string") {
    const normalized = input.trim();
    if (!normalized) {
      return {};
    }
    return {
      preview: clipText(normalized, 240),
      details: clipRawText(normalized, 2200),
      activity: clipText(normalized, 140),
    };
  }
  try {
    const compact = JSON.stringify(input);
    const pretty = JSON.stringify(input, null, 2);
    const empty =
      !compact || compact === "{}" || compact === "[]" || compact === "null" || compact === '""';
    return {
      preview: empty ? undefined : clipText(compact, 260),
      details: empty ? undefined : clipRawText(pretty ?? compact, 2600),
      activity: deriveToolActivity(input),
    };
  } catch {
    return {};
  }
}

function appendToolTimeline(entry: LiveToolEntry, line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) {
    return false;
  }
  const last = entry.timeline[entry.timeline.length - 1];
  if (last === trimmed) {
    return false;
  }
  entry.timeline.push(trimmed);
  if (entry.timeline.length > 8) {
    entry.timeline.splice(0, entry.timeline.length - 8);
  }
  return true;
}

function ensureLiveToolEntry(
  trace: LiveToolTrace,
  input: {
    id: string;
    name?: string;
    inputPreview?: string;
    inputDetails?: string;
    activity?: string;
  },
): LiveToolEntry {
  const existing = trace.byId.get(input.id);
  if (existing) {
    if (input.name) {
      existing.name = input.name;
    }
    if (input.inputPreview) {
      existing.inputPreview = input.inputPreview;
    }
    if (input.inputDetails) {
      existing.inputDetails = input.inputDetails;
    }
    if (input.activity) {
      existing.activity = input.activity;
    }
    existing.updatedAtMs = Date.now();
    return existing;
  }

  const created: LiveToolEntry = {
    id: input.id,
    name: input.name ?? "tool",
    status: "queued",
    inputPreview: input.inputPreview,
    inputDetails: input.inputDetails,
    activity: input.activity,
    timeline: [],
    startedAtMs: Date.now(),
    updatedAtMs: Date.now(),
  };
  trace.byId.set(input.id, created);
  trace.order.push(input.id);
  return created;
}

function extractToolStartFromStreamEvent(message: ClaudeSDKMessage): {
  id: string;
  index?: number;
  name?: string;
  inputPreview?: string;
  inputDetails?: string;
  activity?: string;
  inputBufferSeed?: string;
} | null {
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
      // Don't seed with trivially empty JSON — deltas will build the real input
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

export function collectToolIdsFromMessage(
  trace: LiveToolTrace,
  message: ClaudeSDKMessage,
): string[] {
  const ids = new Set<string>();
  const streamStart = extractToolStartFromStreamEvent(message);
  if (streamStart?.id) {
    ids.add(streamStart.id);
  }
  if (message.type === "tool_progress") {
    ids.add(message.tool_use_id);
  }
  if (message.type === "system" && message.subtype === "task_started" && message.tool_use_id) {
    ids.add(message.tool_use_id);
  }
  if (message.type === "system" && message.subtype === "task_notification") {
    const taskToolId = trace.taskIdToToolId.get(message.task_id);
    if (taskToolId) {
      ids.add(taskToolId);
    }
  }
  if (message.type === "tool_use_summary") {
    for (const toolUseId of message.preceding_tool_use_ids) {
      ids.add(toolUseId);
    }
  }
  if (message.type === "result" && message.is_error) {
    for (const toolId of trace.order) {
      ids.add(toolId);
    }
  }
  return [...ids];
}

function extractToolInputDelta(
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

function parsePossiblyPartialJson(text: string): unknown | null {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function findLatestRunningTaskToolId(trace: LiveToolTrace): string | null {
  for (let index = trace.order.length - 1; index >= 0; index -= 1) {
    const toolId = trace.order[index];
    if (!toolId) {
      continue;
    }
    const entry = trace.byId.get(toolId);
    if (!entry) {
      continue;
    }
    if ((entry.status === "running" || entry.status === "queued") && /task/i.test(entry.name)) {
      return toolId;
    }
  }
  return null;
}

function resolveToolIdForInputDelta(trace: LiveToolTrace, index: number): string | undefined {
  const mapped = trace.indexToToolId.get(index);
  if (mapped) {
    return mapped;
  }

  const activeToolIds = trace.order.filter((toolId) => {
    const entry = trace.byId.get(toolId);
    return Boolean(entry && (entry.status === "running" || entry.status === "queued"));
  });
  if (activeToolIds.length === 0) {
    return undefined;
  }

  const fallbackToolId = activeToolIds[activeToolIds.length - 1];
  if (fallbackToolId) {
    trace.indexToToolId.set(index, fallbackToolId);
  }
  return fallbackToolId;
}

export function applyToolMessageToTrace(trace: LiveToolTrace, message: ClaudeSDKMessage): boolean {
  let changed = false;
  const now = Date.now();

  const streamStart = extractToolStartFromStreamEvent(message);
  if (streamStart) {
    const entry = ensureLiveToolEntry(trace, streamStart);
    if (entry.status !== "running") {
      entry.status = "running";
      changed = true;
    }
    if (streamStart.activity && appendToolTimeline(entry, `start: ${streamStart.activity}`)) {
      changed = true;
    } else if (appendToolTimeline(entry, "start")) {
      changed = true;
    }
    entry.updatedAtMs = now;
    if (streamStart.inputBufferSeed && !trace.inputJsonBufferByToolId.has(streamStart.id)) {
      trace.inputJsonBufferByToolId.set(streamStart.id, streamStart.inputBufferSeed);
    }
    if (typeof streamStart.index === "number") {
      trace.indexToToolId.set(streamStart.index, streamStart.id);
    }
  }

  const toolInputDelta = extractToolInputDelta(message);
  if (toolInputDelta) {
    const toolId = resolveToolIdForInputDelta(trace, toolInputDelta.index);
    if (toolId) {
      const currentBuffer = trace.inputJsonBufferByToolId.get(toolId) ?? "";
      const nextBuffer = `${currentBuffer}${toolInputDelta.partialJson}`;
      trace.inputJsonBufferByToolId.set(toolId, nextBuffer);
      const entry = ensureLiveToolEntry(trace, { id: toolId });
      const parsed = parsePossiblyPartialJson(nextBuffer);
      const summarized =
        parsed !== null
          ? summarizeToolInput(parsed)
          : {
              preview: clipText(nextBuffer.replace(/\s+/g, " "), 260),
              details: clipRawText(nextBuffer, 2600),
            };
      if (summarized.preview && entry.inputPreview !== summarized.preview) {
        entry.inputPreview = summarized.preview;
        entry.updatedAtMs = now;
        changed = true;
      }
      if (
        summarized.details &&
        entry.inputDetails !== summarized.details &&
        (parsed !== null ||
          !entry.inputDetails ||
          summarized.details.length >= entry.inputDetails.length)
      ) {
        entry.inputDetails = summarized.details;
        entry.updatedAtMs = now;
        changed = true;
      }
      if (summarized.activity && entry.activity !== summarized.activity) {
        entry.activity = summarized.activity;
        if (appendToolTimeline(entry, `focus: ${summarized.activity}`)) {
          changed = true;
        }
      }
    }
  }

  if (message.type === "tool_progress") {
    const entry = ensureLiveToolEntry(trace, {
      id: message.tool_use_id,
      name: message.tool_name,
    });
    if (entry.status !== "running") {
      entry.status = "running";
      changed = true;
    }
    if (entry.elapsedSeconds !== message.elapsed_time_seconds) {
      entry.elapsedSeconds = message.elapsed_time_seconds;
      changed = true;
    }
    if (appendToolTimeline(entry, `progress: ${formatElapsedSeconds(entry) ?? "running"}`)) {
      changed = true;
    }
    entry.updatedAtMs = now;
  }

  if (message.type === "system" && message.subtype === "task_started") {
    const linkedToolId =
      message.tool_use_id ?? findLatestRunningTaskToolId(trace) ?? `task:${message.task_id}`;
    trace.taskIdToToolId.set(message.task_id, linkedToolId);
    const entry = ensureLiveToolEntry(trace, {
      id: linkedToolId,
      name: message.task_type || "Task",
    });
    entry.status = "running";
    entry.summary = clipText(message.description, 120);
    if (
      (!entry.activity || /^task$/i.test(entry.activity)) &&
      message.description.trim().length > 0
    ) {
      entry.activity = clipText(message.description, 120);
    }
    if (appendToolTimeline(entry, `task started: ${clipText(message.description, 140)}`)) {
      changed = true;
    }
    entry.updatedAtMs = now;
    changed = true;
  }

  if (message.type === "system" && message.subtype === "task_notification") {
    const linkedToolId =
      trace.taskIdToToolId.get(message.task_id) ??
      findLatestRunningTaskToolId(trace) ??
      `task:${message.task_id}`;
    const entry = ensureLiveToolEntry(trace, {
      id: linkedToolId,
      name: "Task",
    });
    if (message.status === "completed") {
      entry.status = "done";
    } else if (message.status === "failed") {
      entry.status = "failed";
    } else {
      entry.status = "interrupted";
    }
    entry.summary = clipText(message.summary, 180);
    entry.completedAtMs = now;
    if (appendToolTimeline(entry, `${message.status}: ${clipText(message.summary, 140)}`)) {
      changed = true;
    }
    entry.updatedAtMs = now;
    changed = true;
  }

  if (message.type === "tool_use_summary") {
    for (const toolUseId of message.preceding_tool_use_ids) {
      const entry = ensureLiveToolEntry(trace, {
        id: toolUseId,
      });
      entry.summary = clipText(message.summary, 120);
      entry.status = "done";
      entry.completedAtMs = now;
      if (appendToolTimeline(entry, `summary: ${clipText(message.summary, 140)}`)) {
        changed = true;
      }
      entry.updatedAtMs = now;
      changed = true;
    }
  }

  if (message.type === "result" && message.is_error) {
    for (const entry of trace.byId.values()) {
      if (entry.status === "queued" || entry.status === "running") {
        entry.status = "failed";
        entry.completedAtMs = now;
        if (appendToolTimeline(entry, "result: failed")) {
          changed = true;
        }
        entry.updatedAtMs = now;
        changed = true;
      }
    }
  }

  return changed;
}

export function finalizeLiveToolTrace(
  trace: LiveToolTrace,
  outcome: "success" | "failed" | "interrupted",
): void {
  const now = Date.now();
  for (const entry of trace.byId.values()) {
    if (entry.status !== "queued" && entry.status !== "running") {
      continue;
    }
    entry.status =
      outcome === "success" ? "done" : outcome === "interrupted" ? "interrupted" : "failed";
    entry.completedAtMs = now;
    entry.updatedAtMs = now;
  }
}

function toolStatusIcon(status: LiveToolStatus): string {
  switch (status) {
    case "queued":
      return "🕓";
    case "running":
      return "⏳";
    case "done":
      return "✅";
    case "failed":
      return "❌";
    case "interrupted":
      return "⏹️";
  }
}

function formatElapsedSeconds(entry: LiveToolEntry): string | null {
  if (typeof entry.elapsedSeconds === "number" && Number.isFinite(entry.elapsedSeconds)) {
    return entry.elapsedSeconds >= 10
      ? `${Math.round(entry.elapsedSeconds)}s`
      : `${entry.elapsedSeconds.toFixed(1)}s`;
  }
  const endMs =
    entry.status === "running" || entry.status === "queued" ? Date.now() : entry.completedAtMs;
  if (!endMs) {
    return null;
  }
  const seconds = Math.max(0, (endMs - entry.startedAtMs) / 1000);
  if (seconds < 0.1) {
    return null;
  }
  return seconds >= 10 ? `${Math.round(seconds)}s` : `${seconds.toFixed(1)}s`;
}

function buildTimelineBlock(entry: LiveToolEntry, maxLines = 8): string | null {
  if (entry.timeline.length === 0 || maxLines <= 0) {
    return null;
  }
  const lines = entry.timeline
    .slice(-maxLines)
    .map((line) => `- ${clipText(line, 180)}`)
    .join("\n");
  return `**Timeline**\n${lines}`;
}

export type LiveToolRenderPayload = {
  flags: number;
  components: [ContainerBuilder];
};

export function buildSingleLiveToolMessage(
  entry: LiveToolEntry,
  input: { channelId: string; expanded: boolean },
): LiveToolRenderPayload {
  const { channelId, expanded } = input;
  const elapsed = formatElapsedSeconds(entry) ?? "n/a";
  const displayLine = buildToolEntryDisplayLine(entry);

  // Section: compact header with inline expand/collapse button (right-aligned).
  // Up to 3 TextDisplays per Section; the button accessory sits flush to the right.
  const headerTexts: TextDisplayBuilder[] = [
    new TextDisplayBuilder().setContent(
      `${toolStatusIcon(entry.status)} **${entry.name}** · ${elapsed}`,
    ),
  ];
  if (displayLine) {
    // -# renders as small muted subtext — keeps the display line visible but secondary
    headerTexts.push(new TextDisplayBuilder().setContent(`-# ${displayLine}`));
  }
  const collapsedTimeline = !expanded ? buildTimelineBlock(entry, 3) : null;
  if (collapsedTimeline && headerTexts.length < 3) {
    headerTexts.push(new TextDisplayBuilder().setContent(clipRawText(collapsedTimeline, 900)));
  } else if (!collapsedTimeline && entry.summary && !expanded && headerTexts.length < 3) {
    headerTexts.push(new TextDisplayBuilder().setContent(`-# ${clipText(entry.summary, 220)}`));
  }
  const section = new SectionBuilder()
    .addTextDisplayComponents(...headerTexts)
    .setButtonAccessory(buildToolViewSectionButton(channelId, entry.id, expanded));

  const container = new ContainerBuilder()
    .setAccentColor(STATUS_ACCENT_COLORS[entry.status])
    .addSectionComponents(section);

  // Expanded: details below a horizontal separator
  if (expanded) {
    const expandedParts: string[] = [];
    if (entry.summary) {
      expandedParts.push(`**Summary**\n${clipText(entry.summary, 900)}`);
    }
    const fullTimeline = buildTimelineBlock(entry, 8);
    if (fullTimeline) {
      expandedParts.push(fullTimeline);
    }
    if (entry.inputDetails) {
      expandedParts.push(`**Input**\n\`\`\`json\n${clipRawText(entry.inputDetails, 1900)}\n\`\`\``);
    } else if (!displayLine && entry.inputPreview) {
      // Only show raw preview when no human-readable display line is available
      expandedParts.push(`**Input**\n\`\`\`json\n${clipRawText(entry.inputPreview, 700)}\n\`\`\``);
    }

    if (expandedParts.length > 0) {
      container.addSeparatorComponents(
        new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small),
      );
      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(clipRawText(expandedParts.join("\n\n"), 3000)),
      );
    }
  }

  return {
    flags: MessageFlags.IsComponentsV2 | MessageFlags.SuppressNotifications,
    components: [container],
  };
}

export function toStreamingPreview(
  text: string,
  thinking: string,
  thinkingSpinnerFrame?: string,
  maxChars = 1800,
): string {
  const spinnerSuffix = thinkingSpinnerFrame ? ` ${thinkingSpinnerFrame}` : "";
  const trimmedText = text.trim();
  const trimmedThinking = thinking.trim();
  if (!trimmedText && !trimmedThinking) {
    return `_Thinking${spinnerSuffix}..._`;
  }

  const parts: string[] = [];
  if (trimmedThinking) {
    parts.push(`_Thinking${spinnerSuffix}_\n${italicizeMultiline(trimmedThinking)}`);
  } else if (!trimmedText) {
    parts.push(`_Thinking${spinnerSuffix}..._`);
  }
  if (trimmedText) {
    if (trimmedThinking) {
      parts.push("---");
    }
    parts.push(trimmedText);
  }

  const combined = parts.join("\n\n");
  if (combined.length <= maxChars) {
    return combined;
  }

  // Preserve accumulated context while still showing latest progress when over limit.
  const separator = "\n\n...[truncated live preview]...\n\n";
  const budget = Math.max(0, maxChars - separator.length);
  const headSize = Math.floor(budget * 0.7);
  const tailSize = Math.max(0, budget - headSize);

  if (tailSize === 0) {
    return combined.slice(0, maxChars);
  }
  return `${combined.slice(0, headSize)}${separator}${combined.slice(-tailSize)}`;
}
