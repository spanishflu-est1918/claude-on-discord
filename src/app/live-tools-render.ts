import {
  ContainerBuilder,
  MessageFlags,
  SectionBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
  TextDisplayBuilder,
} from "discord.js";
import { buildToolViewSectionButton } from "../discord/buttons";
import { clipRawText, clipText, italicizeMultiline } from "./text";
import {
  THINKING_SPINNER_FRAMES,
  type LiveToolEntry,
  type LiveToolRenderPayload,
  type LiveToolStatus,
} from "./live-tools-types";

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
  queued: 0x5865f2,
  running: 0xfee75c,
  done: 0x57f287,
  failed: 0xed4245,
  interrupted: 0x95a5a6,
};

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
  return deriveToolActivity(input);
}

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


export function buildSingleLiveToolMessage(
  entry: LiveToolEntry,
  input: { channelId: string; expanded: boolean },
): LiveToolRenderPayload {
  const { channelId, expanded } = input;
  const elapsed = formatElapsedSeconds(entry) ?? "n/a";
  const displayLine = buildToolEntryDisplayLine(entry);

  const headerTexts: TextDisplayBuilder[] = [
    new TextDisplayBuilder().setContent(
      `${toolStatusIcon(entry.status)} **${entry.name}** · ${elapsed}`,
    ),
  ];
  if (displayLine) {
    headerTexts.push(new TextDisplayBuilder().setContent(`-# ${displayLine}`));
  }
  if (entry.summary && !expanded && headerTexts.length < 3) {
    headerTexts.push(new TextDisplayBuilder().setContent(`-# ${clipText(entry.summary, 220)}`));
  }
  const section = new SectionBuilder()
    .addTextDisplayComponents(...headerTexts)
    .setButtonAccessory(buildToolViewSectionButton(channelId, entry.id, expanded));

  const container = new ContainerBuilder()
    .setAccentColor(STATUS_ACCENT_COLORS[entry.status])
    .addSectionComponents(section);

  if (expanded) {
    const expandedParts: string[] = [];
    if (entry.summary) {
      expandedParts.push(`**Summary**\n${clipText(entry.summary, 900)}`);
    }
    if (entry.inputDetails) {
      expandedParts.push(`**Input**\n\`\`\`json\n${clipRawText(entry.inputDetails, 1900)}\n\`\`\``);
    } else if (!displayLine && entry.inputPreview) {
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

  const separator = "\n\n...[truncated live preview]...\n\n";
  const budget = Math.max(0, maxChars - separator.length);
  const headSize = Math.floor(budget * 0.7);
  const tailSize = Math.max(0, budget - headSize);

  if (tailSize === 0) {
    return combined.slice(0, maxChars);
  }
  return `${combined.slice(0, headSize)}${separator}${combined.slice(-tailSize)}`;
}

export { THINKING_SPINNER_FRAMES };
