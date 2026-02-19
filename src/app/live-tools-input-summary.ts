import { clipRawText, clipText } from "./text";

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

export function summarizeToolInput(input: unknown): {
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
