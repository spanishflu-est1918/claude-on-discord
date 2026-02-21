import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";

type ThreadDebugDetail = Record<string, unknown>;

export interface ThreadDebugger {
  isEnabled: () => boolean;
  nextRunId: (channelId: string) => string;
  log: (input: {
    event: string;
    channelId?: string;
    runId?: string;
    detail?: ThreadDebugDetail;
  }) => void;
}

const ENABLED_VALUES = new Set(["1", "true", "yes", "on"]);
const MAX_DETAIL_CHARS = 8000;

function isEnabledValue(raw: string | undefined): boolean {
  if (!raw) {
    return false;
  }
  return ENABLED_VALUES.has(raw.trim().toLowerCase());
}

function truncate(value: string, maxChars = MAX_DETAIL_CHARS): string {
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, maxChars)}...<truncated>`;
}

function toDetailString(detail: ThreadDebugDetail | undefined): string | null {
  if (!detail) {
    return null;
  }
  try {
    return truncate(JSON.stringify(detail));
  } catch {
    return truncate(String(detail));
  }
}

function createNoopDebugger(): ThreadDebugger {
  return {
    isEnabled: () => false,
    nextRunId: () => "",
    log: () => {},
  };
}

export function createThreadDebuggerFromEnv(
  env: Record<string, string | undefined> = process.env,
): ThreadDebugger {
  const enabled = isEnabledValue(env.THREAD_DEBUG_TRACE);
  if (!enabled) {
    return createNoopDebugger();
  }

  const filePathRaw = env.THREAD_DEBUG_TRACE_FILE?.trim();
  const filePath = filePathRaw ? path.resolve(filePathRaw) : null;
  if (filePath) {
    try {
      mkdirSync(path.dirname(filePath), { recursive: true });
    } catch {
      // Ignore file path setup failures and keep stdout logging.
    }
  }

  let sequence = 0;

  return {
    isEnabled: () => true,
    nextRunId: (channelId: string) => {
      sequence += 1;
      return `${channelId.slice(-6)}-${Date.now().toString(36)}-${sequence.toString(36)}`;
    },
    log: ({ event, channelId, runId, detail }) => {
      const payload = {
        ts: new Date().toISOString(),
        seq: ++sequence,
        event,
        ...(channelId ? { channelId } : {}),
        ...(runId ? { runId } : {}),
        ...(detail ? { detail } : {}),
      };
      let line: string;
      try {
        line = JSON.stringify(payload);
      } catch {
        line = JSON.stringify({
          ts: payload.ts,
          seq: payload.seq,
          event,
          ...(channelId ? { channelId } : {}),
          ...(runId ? { runId } : {}),
          detail: toDetailString(detail) ?? "unserializable_detail",
        });
      }

      console.log(`[thread-debug] ${line}`);

      if (!filePath) {
        return;
      }
      try {
        appendFileSync(filePath, `${line}\n`, "utf8");
      } catch {
        // Ignore file write failures to avoid affecting runtime behavior.
      }
    },
  };
}
