function safeReadString(
  source: unknown,
  key: "message" | "stderr" | "stdout" | "all",
): string | undefined {
  if (!source || typeof source !== "object") {
    return undefined;
  }
  try {
    const value = (source as Record<string, unknown>)[key];
    return typeof value === "string" ? value : undefined;
  } catch {
    return undefined;
  }
}

function safeReadCause(source: unknown): unknown {
  if (!source || typeof source !== "object") {
    return undefined;
  }
  try {
    return (source as { cause?: unknown }).cause;
  } catch {
    return undefined;
  }
}

function splitErrorLines(raw: string): string[] {
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^\d+\s+\|/.test(line))
    .filter((line) => !/^at\s/.test(line));
}

function clipInline(value: string, maxChars: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxChars - 3))}...`;
}

function summarizeErrorSnippet(raw: string): string | undefined {
  const lines = splitErrorLines(raw);
  if (lines.length === 0) {
    return undefined;
  }

  const preferred = lines.find(
    (line) =>
      /(invalid|failed|error|cannot|must|required|unexpected|enoent|eacces|eperm|permission|schema|json)/i.test(
        line,
      ) && !/\bexited with code 1\b/i.test(line),
  );
  const selected = preferred ?? lines[lines.length - 1];
  if (!selected) {
    return undefined;
  }
  return clipInline(selected, 320);
}

function extractProcessErrorDetail(error: Error): string | undefined {
  const seen = new Set<unknown>();
  const queue: unknown[] = [error];
  const snippets: string[] = [];

  while (queue.length > 0 && seen.size < 10) {
    const current = queue.shift();
    if (!current || typeof current !== "object" || seen.has(current)) {
      continue;
    }
    seen.add(current);

    const message = safeReadString(current, "message");
    if (current !== error && message) {
      snippets.push(message);
    }
    const stderr = safeReadString(current, "stderr");
    if (stderr) {
      snippets.push(stderr);
    }
    const all = safeReadString(current, "all");
    if (all) {
      snippets.push(all);
    }
    const stdout = safeReadString(current, "stdout");
    if (stdout) {
      snippets.push(stdout);
    }
    const cause = safeReadCause(current);
    if (cause) {
      queue.push(cause);
    }
  }

  return summarizeErrorSnippet(snippets.join("\n"));
}

function summarizePrimaryErrorNoThrow(primary: string): string {
  try {
    const firstLine = primary.split(/\r?\n/, 1)[0] ?? "";
    const trimmed = firstLine.trim();
    if (trimmed.length === 0) {
      return "Runner error";
    }
    return trimmed.slice(0, 320);
  } catch {
    return "Runner error";
  }
}

function safePrimaryErrorMessageNoThrow(error: unknown): string {
  try {
    if (error && typeof error === "object") {
      const message = safeReadString(error, "message");
      if (message && message.trim().length > 0) {
        return message.slice(0, 10_000);
      }
    }
  } catch {
    // Ignore and fall back below.
  }
  try {
    return String(error).slice(0, 10_000);
  } catch {
    return "Unknown runner error";
  }
}

function safeExtractProcessErrorDetail(error: Error): string | undefined {
  try {
    const detail = extractProcessErrorDetail(error);
    return detail ? detail.slice(0, 500) : undefined;
  } catch {
    return undefined;
  }
}

export function shouldRetryAfterProcessExit(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return /\bexited with code 1\b/i.test(error.message);
}

export function formatAttemptContext(attemptLabels: string[]): string | undefined {
  if (attemptLabels.length <= 1) {
    return undefined;
  }
  return `Attempted recovery modes: ${attemptLabels.join(" -> ")}.`;
}

export function safeWrapRunnerError(error: unknown, context?: string): Error {
  const primary = safePrimaryErrorMessageNoThrow(error);
  const exitedCode1 = /\bexited with code 1\b/i.test(primary);
  let base = exitedCode1
    ? "Claude Code process exited with code 1"
    : summarizePrimaryErrorNoThrow(primary);
  if (context) {
    base = `${context} ${base}`;
  }
  const detail = error instanceof Error ? safeExtractProcessErrorDetail(error) : undefined;
  const message =
    detail && !/\bexited with code 1\b/i.test(detail) ? `${base} Detail: ${detail}` : base;
  try {
    return new Error(clipInline(message, 420));
  } catch {
    return new Error("Runner error");
  }
}
