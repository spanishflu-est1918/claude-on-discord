const REPEATED_TOOL_FINGERPRINT_ABORT_STREAK = 8;
const REPEATED_WEBFETCH_ABORT_COUNT = 24;

type ToolCall = {
  name: string;
  fingerprint: string;
};

function canonicalizeForFingerprint(value: unknown, depth = 0): unknown {
  if (depth > 4) {
    return "[depth-limit]";
  }
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.slice(0, 30).map((item) => canonicalizeForFingerprint(item, depth + 1));
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const sortedEntries = Object.entries(record)
      .sort(([a], [b]) => a.localeCompare(b))
      .slice(0, 40);
    const normalized: Record<string, unknown> = {};
    for (const [key, item] of sortedEntries) {
      normalized[key] = canonicalizeForFingerprint(item, depth + 1);
    }
    return normalized;
  }
  return String(value);
}

function buildToolFingerprint(name: string, input: unknown): string {
  try {
    const normalized = canonicalizeForFingerprint(input);
    const json = JSON.stringify(normalized);
    const clipped = json.length > 600 ? `${json.slice(0, 600)}...` : json;
    return `${name}:${clipped}`;
  } catch {
    return `${name}:[unserializable-input]`;
  }
}

function extractAssistantToolCalls(message: unknown): ToolCall[] {
  if (!message || typeof message !== "object") {
    return [];
  }
  const typed = message as {
    type?: unknown;
    message?: { content?: unknown };
  };
  if (typed.type !== "assistant") {
    return [];
  }
  const content = typed.message?.content;
  if (!Array.isArray(content)) {
    return [];
  }

  const calls: ToolCall[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const typedBlock = block as {
      type?: unknown;
      name?: unknown;
      input?: unknown;
    };
    if (typedBlock.type !== "tool_use" && typedBlock.type !== "server_tool_use") {
      continue;
    }
    if (typeof typedBlock.name !== "string" || typedBlock.name.trim().length === 0) {
      continue;
    }
    calls.push({
      name: typedBlock.name,
      fingerprint: buildToolFingerprint(typedBlock.name, typedBlock.input),
    });
  }
  return calls;
}

export type RunawayToolGuard = {
  observeMessage: (message: unknown) => string | null;
};

export function createRunawayToolGuard(): RunawayToolGuard {
  const toolCallCountByName = new Map<string, number>();
  let lastToolFingerprint: string | null = null;
  let repeatedToolFingerprintStreak = 0;
  let runawayStopReason: string | null = null;

  return {
    observeMessage: (message: unknown): string | null => {
      if (runawayStopReason) {
        return runawayStopReason;
      }

      for (const toolCall of extractAssistantToolCalls(message)) {
        const nextCount = (toolCallCountByName.get(toolCall.name) ?? 0) + 1;
        toolCallCountByName.set(toolCall.name, nextCount);

        if (toolCall.fingerprint === lastToolFingerprint) {
          repeatedToolFingerprintStreak += 1;
        } else {
          repeatedToolFingerprintStreak = 1;
          lastToolFingerprint = toolCall.fingerprint;
        }

        if (repeatedToolFingerprintStreak >= REPEATED_TOOL_FINGERPRINT_ABORT_STREAK) {
          runawayStopReason = `Stopped runaway tool loop after ${repeatedToolFingerprintStreak} repeated ${toolCall.name} calls.`;
          return runawayStopReason;
        }
        if (toolCall.name === "WebFetch" && nextCount >= REPEATED_WEBFETCH_ABORT_COUNT) {
          runawayStopReason = `Stopped runaway tool loop after ${nextCount} WebFetch calls.`;
          return runawayStopReason;
        }
      }
      return null;
    },
  };
}
