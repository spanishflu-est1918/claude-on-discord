import { existsSync } from "node:fs";
import { readdir, readFile, unlink } from "node:fs/promises";
import path from "node:path";
import { AttachmentBuilder } from "discord.js";

type SendableChannel = {
  send: (payload: unknown) => Promise<unknown>;
};

function canSendMessage(channel: unknown): channel is SendableChannel {
  return (
    typeof channel === "object" &&
    channel !== null &&
    "send" in channel &&
    typeof (channel as SendableChannel).send === "function"
  );
}

function resolvePath(inputPath: string, baseDir: string): string {
  if (inputPath.startsWith("~/")) {
    const home = process.env.HOME;
    if (home) {
      return path.resolve(home, inputPath.slice(2));
    }
  }
  if (path.isAbsolute(inputPath)) {
    return path.resolve(inputPath);
  }
  return path.resolve(baseDir, inputPath);
}

async function findFileByBasename(input: {
  rootDir: string;
  basename: string;
  maxDepth?: number;
  maxEntries?: number;
}): Promise<string | null> {
  const maxDepth = input.maxDepth ?? 4;
  const maxEntries = input.maxEntries ?? 2000;
  let scanned = 0;

  async function walk(currentDir: string, depth: number): Promise<string | null> {
    if (depth > maxDepth || scanned >= maxEntries) {
      return null;
    }
    let entries: Array<{
      name: string | Buffer;
      isFile: () => boolean;
      isDirectory: () => boolean;
    }>;
    try {
      entries = await readdir(currentDir, { withFileTypes: true });
    } catch {
      return null;
    }

    for (const entry of entries) {
      if (scanned >= maxEntries) {
        return null;
      }
      scanned += 1;
      const entryName = typeof entry.name === "string" ? entry.name : entry.name.toString();
      const entryPath = path.join(currentDir, entryName);
      if (entry.isFile() && entryName === input.basename) {
        return entryPath;
      }
      if (entry.isDirectory()) {
        const found = await walk(entryPath, depth + 1);
        if (found) {
          return found;
        }
      }
    }
    return null;
  }

  return walk(input.rootDir, 0);
}

async function resolvePersistedFilename(
  workingDir: string,
  filename: string,
): Promise<string | null> {
  if (path.isAbsolute(filename)) {
    return existsSync(filename) ? filename : null;
  }

  const direct = resolvePath(filename, workingDir);
  if (existsSync(direct)) {
    return direct;
  }

  const basename = path.basename(filename);
  if (!basename) {
    return null;
  }
  return findFileByBasename({ rootDir: workingDir, basename });
}

function normalizeAttachmentCandidate(candidate: string): string {
  return candidate
    .trim()
    .replace(/^[("']+/, "")
    .replace(/[)"'.,;:!?]+$/, "");
}

function looksLikeAttachmentPath(candidate: string): boolean {
  if (!candidate || candidate.includes("\n") || candidate.includes("\r")) {
    return false;
  }
  if (candidate.startsWith("http://") || candidate.startsWith("https://")) {
    return false;
  }
  if (
    candidate.startsWith("~/") ||
    candidate.startsWith("./") ||
    candidate.startsWith("../") ||
    candidate.startsWith("/") ||
    /^[A-Za-z]:[\\/]/.test(candidate)
  ) {
    return true;
  }
  if (candidate.includes("/")) {
    return true;
  }
  return /^[^/\s]+\.[A-Za-z0-9]{1,12}$/.test(candidate);
}

function collectErrorLines(error: Error): string[] {
  const lines: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;

  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const value = current as { message?: unknown; cause?: unknown };
    if (typeof value.message === "string") {
      lines.push(...splitErrorLines(value.message));
    }
    current = value.cause;
  }

  return Array.from(new Set(lines));
}

function splitErrorLines(input: string): string[] {
  return input
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^\d+\s+\|/.test(line))
    .filter((line) => !/^at\s/.test(line));
}

function clipInlineError(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxChars - 3))}...`;
}

function getSentAttachmentCount(message: unknown): number | null {
  if (!message || typeof message !== "object") {
    return null;
  }
  const candidate = message as {
    attachments?: { size?: number };
  };
  if (!candidate.attachments || typeof candidate.attachments !== "object") {
    return null;
  }
  if (typeof candidate.attachments.size === "number") {
    return candidate.attachments.size;
  }
  return null;
}

export async function cleanupFiles(paths: string[]): Promise<void> {
  for (const filePath of paths) {
    try {
      await unlink(filePath);
    } catch {
      // Ignore cleanup errors.
    }
  }
}

export function extractAttachmentPathCandidates(text: string, maxCandidates = 40): string[] {
  if (!text.trim()) {
    return [];
  }

  const results = new Set<string>();
  const capture = (value: string) => {
    const normalized = normalizeAttachmentCandidate(value);
    if (!normalized || !looksLikeAttachmentPath(normalized)) {
      return;
    }
    if (normalized.length > 512) {
      return;
    }
    if (results.size < maxCandidates) {
      results.add(normalized);
    }
  };

  const backtickRegex = /`([^`\n]+)`/g;
  for (const match of text.matchAll(backtickRegex)) {
    const candidate = match[1];
    if (candidate) {
      capture(candidate);
    }
  }

  const absoluteRegex = /(?:^|\s)(~\/[^\s`"'(){}[\]<>]+|\/[^\s`"'(){}[\]<>]+)/g;
  for (const match of text.matchAll(absoluteRegex)) {
    const candidate = match[1];
    if (candidate) {
      capture(candidate);
    }
  }

  const relativeRegex =
    /(?:^|\s)(\.{1,2}\/[^\s`"'(){}[\]<>]+|[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+)/g;
  for (const match of text.matchAll(relativeRegex)) {
    const candidate = match[1];
    if (candidate) {
      capture(candidate);
    }
  }

  return Array.from(results);
}

export function extractStructuredAttachmentDirectives(
  text: string,
  maxCandidates = 20,
): {
  filenames: string[];
  cleanedText: string;
} {
  if (!text.trim()) {
    return { filenames: [], cleanedText: text };
  }

  const filenames = new Set<string>();
  const keptLines: string[] = [];
  let inCodeFence = false;
  const directiveRegex = /^\s*(?:[-*]\s*)?(?:attach|media|file)\s*:\s*(.+?)\s*$/i;

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith("```")) {
      inCodeFence = !inCodeFence;
      keptLines.push(line);
      continue;
    }
    if (inCodeFence) {
      keptLines.push(line);
      continue;
    }

    const match = line.match(directiveRegex);
    if (!match) {
      keptLines.push(line);
      continue;
    }

    const candidate = normalizeAttachmentCandidate(match[1] ?? "");
    if (
      candidate &&
      looksLikeAttachmentPath(candidate) &&
      candidate.length <= 512 &&
      filenames.size < maxCandidates
    ) {
      filenames.add(candidate);
      continue;
    }

    keptLines.push(line);
  }

  return {
    filenames: Array.from(filenames),
    cleanedText: keptLines.join("\n"),
  };
}

export function formatErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) {
    return "unknown error";
  }

  const lines = collectErrorLines(error);
  if (lines.length === 0) {
    return "unknown error";
  }

  const exitLine = lines.find((line) => /\bexited with code 1\b/i.test(line));
  const detailLine = lines.find((line) => !/\bexited with code 1\b/i.test(line));
  if (exitLine && detailLine) {
    return clipInlineError(`${exitLine} Detail: ${detailLine}`, 420);
  }
  return clipInlineError(lines[0] ?? "unknown error", 420);
}

export async function sendGeneratedFilesToChannel(input: {
  channel: unknown;
  workingDir: string;
  filenames: Iterable<string>;
}): Promise<void> {
  if (!canSendMessage(input.channel)) {
    return;
  }

  const sentPaths = new Set<string>();
  const failures: string[] = [];
  for (const filename of input.filenames) {
    const resolved = await resolvePersistedFilename(input.workingDir, filename);
    if (!resolved) {
      continue;
    }
    if (sentPaths.has(resolved)) {
      continue;
    }
    sentPaths.add(resolved);

    try {
      const fileData = await readFile(resolved);
      const uploadName = path.basename(resolved) || "artifact.bin";
      const sentMessage = await input.channel.send({
        content: `Generated file: \`${filename}\``,
        files: [new AttachmentBuilder(fileData, { name: uploadName })],
      });
      const attachmentCount = getSentAttachmentCount(sentMessage);
      if (attachmentCount === 0) {
        failures.push(
          `- \`${filename}\`: Discord acknowledged message but no attachment was present`,
        );
      }
    } catch (error) {
      failures.push(`- \`${filename}\`: ${formatErrorMessage(error)}`);
    }
  }

  if (failures.length > 0) {
    const detail = failures.slice(0, 6).join("\n");
    const overflow =
      failures.length > 6 ? `\n- ... ${failures.length - 6} additional attachment issue(s)` : "";
    await input.channel.send(
      [
        "Generated files could not all be attached:",
        detail + overflow,
        "Tip: ensure files exist in the project directory and are under Discord upload limits.",
      ].join("\n"),
    );
  }
}
