import { existsSync, statSync } from "node:fs";
import { mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  AttachmentBuilder,
  ContainerBuilder,
  type Message,
  MessageFlags,
  SectionBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
  TextDisplayBuilder,
} from "discord.js";
import { ClaudeRunner } from "./claude/runner";
import { SessionManager } from "./claude/session";
import { StopController } from "./claude/stop";
import type { AppConfig } from "./config";
import { type ChannelMentionsMode, type MergeContextRecord, Repository } from "./db/repository";
import { openDatabase } from "./db/schema";
import {
  buildDiffViewButtons,
  buildProjectSwitchButtons,
  buildQueueNoticeButtons,
  buildStopButtons,
  buildThreadCleanupButtons,
  buildThreadWorktreeChoiceButtons,
  buildToolViewSectionButton,
  parseDiffViewCustomId,
  parseProjectSwitchCustomId,
  parseQueueNoticeCustomId,
  parseRunControlCustomId,
  parseThreadCleanupCustomId,
  parseThreadWorktreeChoiceCustomId,
  parseToolViewCustomId,
} from "./discord/buttons";
import { chunkDiscordText } from "./discord/chunker";
import { startDiscordClient } from "./discord/client";
import { registerSlashCommands } from "./discord/commands";
import { buildDiffDelivery } from "./discord/diff-delivery";
import { DiscordDispatchQueue } from "./discord/dispatcher";
import {
  buildPrCreateArgs,
  buildPrMergeArgs,
  extractFirstUrl,
  formatPrStatusLine,
  type PrChecksAction,
  type PrCreateAction,
  type PrInspectAction,
  type PrMergeAction,
  type PrMergeMethod,
  parseOriginDefaultBranch,
  parsePrChecksJson,
  parsePrSummaryJson,
} from "./discord/pr";
import {
  buildThreadBranchAwarenessPrompt,
  buildThreadBranchStatusLines,
  parseThreadBranchMeta,
} from "./discord/thread-branch";
import { buildChannelTopic, parseGitBranch } from "./discord/topic";
import { runWorktreeBootstrap, type WorktreeBootstrapResult } from "./discord/worktree-bootstrap";
import type { ClaudePermissionMode, ClaudeSDKMessage } from "./types";

export type StartAppRuntimeOverrides = {
  openDatabase?: typeof openDatabase;
  registerSlashCommands?: typeof registerSlashCommands;
  startDiscordClient?: typeof startDiscordClient;
  createRunner?: () => ClaudeRunner;
  installSignalHandlers?: boolean;
};

function getMessagePrompt(message: Message): string {
  if (message.content.trim().length > 0) {
    return message.content;
  }
  return "User sent attachments. Describe what they sent and ask how to help.";
}

function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function buildStoredUserTurnContent(message: Message): string {
  const base = getMessagePrompt(message);
  if (message.attachments.size === 0) {
    return base;
  }
  const names = [...message.attachments.values()].map((attachment, index) =>
    sanitizeFilename(attachment.name ?? `attachment-${index + 1}.bin`),
  );
  const listed = names.slice(0, 8).join(", ");
  const overflow = names.length > 8 ? ` (+${names.length - 8} more)` : "";
  return `${base}\n\nAttachments: ${listed}${overflow}`;
}

async function stageAttachments(message: Message): Promise<{
  stagedPaths: string[];
  promptSuffix: string;
}> {
  if (message.attachments.size === 0) {
    return { stagedPaths: [], promptSuffix: "" };
  }

  const stagedPaths: string[] = [];
  const promptLines: string[] = ["", "User included attachments saved locally:"];
  let index = 0;

  for (const attachment of message.attachments.values()) {
    const filename = sanitizeFilename(attachment.name ?? `attachment-${index + 1}.bin`);
    const targetPath = path.join(tmpdir(), `claude-on-discord-${Date.now()}-${index}-${filename}`);

    try {
      const response = await fetch(attachment.url);
      if (!response.ok) {
        promptLines.push(`- ${filename}: failed to download (${response.status})`);
        index += 1;
        continue;
      }

      const buffer = await response.arrayBuffer();
      await Bun.write(targetPath, buffer);
      stagedPaths.push(targetPath);
      promptLines.push(`- ${filename}: ${targetPath}`);
    } catch {
      promptLines.push(`- ${filename}: failed to download`);
    }

    index += 1;
  }

  return {
    stagedPaths,
    promptSuffix: promptLines.join("\n"),
  };
}

async function addReaction(message: Message, emoji: string): Promise<void> {
  try {
    await message.react(emoji);
  } catch {
    // Ignore reaction failures in channels where bot lacks permissions.
  }
}

async function removeReaction(message: Message, emoji: string): Promise<void> {
  try {
    const reaction = message.reactions.cache.get(emoji);
    if (reaction) {
      await reaction.users.remove(message.client.user?.id ?? "");
    }
  } catch {
    // Ignore reaction cleanup failures.
  }
}

function resolvePath(inputPath: string, baseDir = process.cwd()): string {
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

async function pickFolderWithFinder(): Promise<string | null> {
  if (process.platform !== "darwin") {
    return null;
  }

  const subprocess = Bun.spawn({
    cmd: [
      "osascript",
      "-e",
      "try",
      "-e",
      'set selectedFolder to POSIX path of (choose folder with prompt "Select project folder for this channel")',
      "-e",
      "return selectedFolder",
      "-e",
      "on error number -128",
      "-e",
      'return ""',
      "-e",
      "end try",
    ],
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, exitCode] = await Promise.all([
    new Response(subprocess.stdout).text(),
    subprocess.exited,
  ]);

  if (exitCode !== 0) {
    return null;
  }

  const selected = stdout.trim();
  if (!selected) {
    return null;
  }

  return path.resolve(selected);
}

function buildSeededPrompt(
  userPrompt: string,
  history: Array<{ role: "user" | "assistant"; content: string }>,
  hasActiveSession: boolean,
): string {
  if (hasActiveSession || history.length === 0) {
    return userPrompt;
  }

  const normalizedHistory = history
    .slice(-12)
    .map((entry) => {
      const compactText = entry.content.replace(/\s+/g, " ").trim();
      const clipped = compactText.length > 400 ? `${compactText.slice(0, 400)}...` : compactText;
      return `${entry.role.toUpperCase()}: ${clipped}`;
    })
    .join("\n");

  return [
    "Conversation context (carry this forward):",
    normalizedHistory,
    "",
    "Current user message:",
    userPrompt,
  ].join("\n");
}

function parseDirectBashCommand(content: string): string | null {
  const trimmed = content.trim();
  if (!trimmed.startsWith("!")) {
    return null;
  }
  return trimmed.slice(1).trim();
}

function resolveMentionRequirementForChannel(input: {
  repository: Repository;
  channelId: string;
  defaultRequireMention: boolean;
}): { requireMention: boolean; mode: ChannelMentionsMode } {
  const mode = input.repository.getChannelMentionsMode(input.channelId) ?? "default";
  if (mode === "required") {
    return { requireMention: true, mode };
  }
  if (mode === "off") {
    return { requireMention: false, mode };
  }
  return { requireMention: input.defaultRequireMention, mode };
}

function resolvePermissionModeForChannel(input: {
  sessionPermissionMode?: ClaudePermissionMode;
  defaultPermissionMode: ClaudePermissionMode;
}): {
  permissionMode: ClaudePermissionMode;
  mode: ClaudePermissionMode | "default";
} {
  const mode = input.sessionPermissionMode ?? "default";
  if (mode === "default") {
    return { permissionMode: input.defaultPermissionMode, mode };
  }
  return { permissionMode: mode, mode };
}

function buildMergeSummaryPrompt(focus?: string | null): string {
  const lines = [
    "Please provide a short handoff summary of what was accomplished in this conversation branch.",
    "This summary will be merged back into the parent thread as context.",
    "",
    "Output requirements:",
    "- Maximum 8 bullets",
    "- Maximum 900 characters total",
    "- Keep each bullet to one sentence",
    "",
    "Include only:",
    "- Key decisions and rationale",
    "- Files changed (paths only)",
    "- Unresolved issues / next steps",
    "",
    "Be specific and actionable.",
  ];

  if (focus?.trim()) {
    lines.push("", `Focus especially on: ${focus.trim()}`);
  }

  return lines.join("\n");
}

function normalizeMergeSummary(summary: string, maxChars: number): string {
  const cleaned = summary.trim().replace(/\n{3,}/g, "\n\n");
  if (!cleaned) {
    return "(No summary generated.)";
  }
  return clipText(cleaned, maxChars);
}

function summarizeGitMergeOutput(output: string): string {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length === 0) {
    return "No git output.";
  }

  if (lines.some((line) => /already up to date/i.test(line))) {
    return "Already up to date.";
  }

  const conflictLines = lines.filter(
    (line) => line.startsWith("CONFLICT") || /automatic merge failed/i.test(line),
  );
  if (conflictLines.length > 0) {
    const samples = conflictLines.slice(0, 2).map((line) => clipText(line, 120));
    const extra = conflictLines.length > 2 ? ` (+${conflictLines.length - 2} more)` : "";
    return [`Conflicts detected: ${conflictLines.length}${extra}.`, ...samples].join("\n");
  }

  const changedLine = lines.find((line) => /\d+\s+files?\s+changed/i.test(line));
  if (lines.some((line) => /fast-forward/i.test(line))) {
    return changedLine
      ? `Fast-forward merge. ${clipText(changedLine, 140)}`
      : "Fast-forward merge.";
  }

  const firstLine = clipText(lines[0] ?? "", 140);
  if (!changedLine || changedLine === lines[0]) {
    return firstLine;
  }
  return `${firstLine}\n${clipText(changedLine, 140)}`;
}

function buildMergeContextInjection(context: {
  fromChannelId: string;
  fromChannelName: string;
  summary: string;
}): string {
  return [
    `[Merged context from fork \`${context.fromChannelName}\` (<#${context.fromChannelId}>)]`,
    "",
    context.summary,
    "",
    "[End of merged context — continue working in this thread with the above in mind]",
  ].join("\n");
}

function buildMergeReportLines(input: {
  fromChannelId: string;
  fromChannelName: string;
  summary: string;
}): string {
  return [
    `🔀 **Merge from** <#${input.fromChannelId}> (\`${input.fromChannelName}\`)`,
    "",
    input.summary,
    "",
    "_This context has been injected into the next query in this channel._",
  ].join("\n");
}

function compactHistory(
  history: Array<{ role: "user" | "assistant"; content: string }>,
  maxLines = 8,
): string {
  if (history.length === 0) {
    return "No prior context.";
  }

  return history
    .slice(-maxLines)
    .map((entry, index) => {
      const compactText = entry.content.replace(/\s+/g, " ").trim();
      const clipped = compactText.length > 180 ? `${compactText.slice(0, 180)}...` : compactText;
      return `${index + 1}. ${entry.role}: ${clipped}`;
    })
    .join("\n");
}

async function runCommand(
  cmd: string[],
  cwd: string,
): Promise<{ exitCode: number; output: string }> {
  const process = Bun.spawn({
    cmd,
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);

  const output = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n");
  return {
    exitCode,
    output,
  };
}

function buildAgentBrowserSession(channelId: string): string {
  const token = channelId.replace(/[^a-zA-Z0-9_-]/g, "").slice(-24);
  return `claude-discord-${token || "default"}`;
}

async function captureScreenshotWithAgentBrowser(input: {
  channelId: string;
  workingDir: string;
  url: string;
  fullPage: boolean;
}): Promise<{ screenshotPath?: string; output: string; exitCode: number }> {
  const session = buildAgentBrowserSession(input.channelId);
  const screenshotPath = path.join(
    tmpdir(),
    `claude-on-discord-shot-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}.png`,
  );

  const openResult = await runCommand(
    ["agent-browser", "--session", session, "open", input.url],
    input.workingDir,
  );
  if (openResult.exitCode !== 0) {
    return { exitCode: openResult.exitCode, output: openResult.output };
  }

  const screenshotCommand = ["agent-browser", "--session", session, "screenshot"];
  if (input.fullPage) {
    screenshotCommand.push("--full");
  }
  screenshotCommand.push(screenshotPath);
  const screenshotResult = await runCommand(screenshotCommand, input.workingDir);
  const closeResult = await runCommand(
    ["agent-browser", "--session", session, "close"],
    input.workingDir,
  );

  const combinedOutput = [screenshotResult.output, closeResult.output].filter(Boolean).join("\n");
  if (screenshotResult.exitCode !== 0 || !existsSync(screenshotPath)) {
    if (existsSync(screenshotPath)) {
      await cleanupFiles([screenshotPath]);
    }
    return { exitCode: screenshotResult.exitCode, output: combinedOutput };
  }

  return { screenshotPath, exitCode: 0, output: combinedOutput };
}

type TopicChannel = {
  setTopic: (topic: string) => Promise<unknown>;
};

type ForkThread = {
  id: string;
};

type ForkableChannel = {
  name?: string;
  isThread: () => boolean;
  threads: {
    create: (options: { name: string; reason?: string }) => Promise<ForkThread>;
  };
};

function canSetTopic(channel: unknown): channel is TopicChannel {
  return (
    typeof channel === "object" &&
    channel !== null &&
    "setTopic" in channel &&
    typeof (channel as TopicChannel).setTopic === "function"
  );
}

function canCreateForkThread(channel: unknown): channel is ForkableChannel {
  if (typeof channel !== "object" || channel === null) {
    return false;
  }

  if (
    !("isThread" in channel) ||
    typeof (channel as { isThread?: unknown }).isThread !== "function"
  ) {
    return false;
  }

  if (!("threads" in channel)) {
    return false;
  }

  const threads = (channel as { threads?: { create?: unknown } }).threads;
  return typeof threads?.create === "function";
}

type RenameableThreadChannel = {
  isThread: () => boolean;
  edit: (options: { name: string }) => Promise<unknown>;
  name: string;
};

function canRenameThread(channel: unknown): channel is RenameableThreadChannel {
  return (
    typeof channel === "object" &&
    channel !== null &&
    "isThread" in channel &&
    typeof (channel as { isThread?: unknown }).isThread === "function" &&
    (channel as { isThread: () => boolean }).isThread() &&
    "edit" in channel &&
    typeof (channel as { edit?: unknown }).edit === "function" &&
    "name" in channel &&
    typeof (channel as { name?: unknown }).name === "string"
  );
}

const THREAD_STATE_PREFIXES = ["⚠️", "✅", "❌"] as const;
type ThreadState = (typeof THREAD_STATE_PREFIXES)[number];

function stripThreadStatePrefix(name: string): string {
  for (const prefix of THREAD_STATE_PREFIXES) {
    if (name.startsWith(`${prefix} `)) {
      return name.slice(prefix.length + 1);
    }
    if (name.startsWith(prefix)) {
      return name.slice(prefix.length);
    }
  }
  return name;
}

async function setThreadState(channel: unknown, state: ThreadState | null): Promise<void> {
  if (!canRenameThread(channel)) return;
  const baseName = stripThreadStatePrefix(channel.name);
  const newName = state ? `${state} ${baseName}` : baseName;
  if (newName === channel.name) return;
  try {
    await channel.edit({ name: newName.slice(0, 100) });
  } catch {
    // Thread renaming is best-effort — ignore permission or rate-limit failures.
  }
}

function buildForkThreadTitle(input: { requested: string | null; channelName?: string }): string {
  const requested = input.requested?.trim();
  if (requested) {
    return requested.slice(0, 100);
  }

  const base = input.channelName?.trim();
  if (!base) {
    return "fork";
  }

  return `${base}-fork`.slice(0, 100);
}

async function detectBranchName(workingDir: string): Promise<string | null> {
  const result = await runCommand(["git", "rev-parse", "--abbrev-ref", "HEAD"], workingDir);
  if (result.exitCode !== 0) {
    return null;
  }
  return parseGitBranch(result.output);
}

async function detectOriginDefaultBranch(workingDir: string): Promise<string | null> {
  const result = await runCommand(["git", "symbolic-ref", "refs/remotes/origin/HEAD"], workingDir);
  if (result.exitCode !== 0) {
    return null;
  }
  return parseOriginDefaultBranch(result.output);
}

async function resolvePrBaseBranch(input: {
  channelId: string;
  workingDir: string;
  repository: Repository;
}): Promise<string> {
  const threadMeta = parseThreadBranchMeta(input.repository.getThreadBranchMeta(input.channelId));
  if (threadMeta) {
    const rootChannel = input.repository.getChannel(threadMeta.rootChannelId);
    const rootBranch = rootChannel ? await detectBranchName(rootChannel.workingDir) : null;
    if (rootBranch) {
      return rootBranch;
    }
  }

  const originDefault = await detectOriginDefaultBranch(input.workingDir);
  if (originDefault) {
    return originDefault;
  }
  return "main";
}

async function syncChannelTopic(channel: unknown, workingDir: string): Promise<void> {
  if (!canSetTopic(channel)) {
    return;
  }
  const branch = await detectBranchName(workingDir);
  const topic = buildChannelTopic({ workingDir, branch });
  try {
    await channel.setTopic(topic);
  } catch {
    // Ignore topic update failures when permissions/channel type do not allow it.
  }
}

type ThreadBootstrapChannel = {
  id: string;
  parentId: string | null;
  name?: string;
  isThread: () => boolean;
};

function isThreadBootstrapChannel(channel: unknown): channel is ThreadBootstrapChannel {
  return (
    typeof channel === "object" &&
    channel !== null &&
    "id" in channel &&
    typeof (channel as { id?: unknown }).id === "string" &&
    "parentId" in channel &&
    "isThread" in channel &&
    typeof (channel as { isThread?: unknown }).isThread === "function"
  );
}

type SendableChannel = {
  send: (options: unknown) => Promise<unknown>;
};

type EditableSentMessage = {
  edit: (options: unknown) => Promise<unknown>;
};

function canSendMessage(channel: unknown): channel is SendableChannel {
  return (
    typeof channel === "object" &&
    channel !== null &&
    "send" in channel &&
    typeof (channel as SendableChannel).send === "function"
  );
}

function canEditSentMessage(message: unknown): message is EditableSentMessage {
  return (
    typeof message === "object" &&
    message !== null &&
    "edit" in message &&
    typeof (message as EditableSentMessage).edit === "function"
  );
}

function cloneThreadBranchName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) {
    return "thread-branch";
  }
  return trimmed.slice(0, 90);
}

function firstOutputLine(output: string): string {
  return output.split(/\r?\n/, 1)[0]?.trim() ?? "";
}

function parseAheadBehind(output: string): { behind: number; ahead: number } | null {
  const line = firstOutputLine(output);
  const match = line.match(/^(\d+)\s+(\d+)$/);
  if (!match) {
    return null;
  }
  const behindText = match[1];
  const aheadText = match[2];
  if (!behindText || !aheadText) {
    return null;
  }
  const behind = Number.parseInt(behindText, 10);
  const ahead = Number.parseInt(aheadText, 10);
  if (!Number.isFinite(behind) || !Number.isFinite(ahead)) {
    return null;
  }
  return { behind, ahead };
}

function clipOutput(text: string, maxChars = 8000): string {
  if (text.length <= maxChars) {
    return text;
  }
  const hiddenChars = text.length - maxChars;
  return `${text.slice(0, maxChars)}\n... [truncated ${hiddenChars} chars]`;
}

type DiffMode = "working-tree" | "thread-branch";
type DiffDetailAction = "files" | "stat" | "patch";

type DiffContext = {
  channelId: string;
  guildId: string;
  workingDir: string;
  mode: DiffMode;
  baseRef?: string;
  rangeRef?: string;
};

type WorkingTreeDiffSnapshot = {
  stagedFiles: string[];
  unstagedFiles: string[];
  untrackedFiles: string[];
  untrackedPatch: string;
  stagedStat: string;
  unstagedStat: string;
  stagedPatch: string;
  unstagedPatch: string;
};

function linesFromOutput(output: string): string[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

async function buildUntrackedPatchText(
  workingDir: string,
  untrackedFiles: string[],
  maxFiles = 4,
): Promise<string> {
  const selected = untrackedFiles.slice(0, maxFiles);
  if (selected.length === 0) {
    return "";
  }

  const parts: string[] = [];
  for (const file of selected) {
    const result = await runCommand(
      ["git", "diff", "--no-index", "--", "/dev/null", file],
      workingDir,
    );
    if ((result.exitCode === 0 || result.exitCode === 1) && result.output.trim().length > 0) {
      parts.push(result.output.trim());
    }
  }

  if (untrackedFiles.length > selected.length) {
    parts.push(`# additional untracked files: ${untrackedFiles.length - selected.length}`);
  }

  return parts.join("\n\n").trim();
}

async function buildWorkingTreeDiffSnapshot(workingDir: string): Promise<WorkingTreeDiffSnapshot> {
  const [
    stagedFilesResult,
    unstagedFilesResult,
    untrackedFilesResult,
    stagedStatResult,
    unstagedStatResult,
    stagedPatchResult,
    unstagedPatchResult,
  ] = await Promise.all([
    runCommand(["git", "diff", "--cached", "--name-only"], workingDir),
    runCommand(["git", "diff", "--name-only"], workingDir),
    runCommand(["git", "ls-files", "--others", "--exclude-standard"], workingDir),
    runCommand(["git", "diff", "--cached", "--stat"], workingDir),
    runCommand(["git", "diff", "--stat"], workingDir),
    runCommand(["git", "diff", "--cached"], workingDir),
    runCommand(["git", "diff"], workingDir),
  ]);

  const stagedFiles =
    stagedFilesResult.exitCode === 0 ? linesFromOutput(stagedFilesResult.output) : [];
  const unstagedFiles =
    unstagedFilesResult.exitCode === 0 ? linesFromOutput(unstagedFilesResult.output) : [];
  const untrackedFiles =
    untrackedFilesResult.exitCode === 0 ? linesFromOutput(untrackedFilesResult.output) : [];
  const untrackedPatch = await buildUntrackedPatchText(workingDir, untrackedFiles);

  return {
    stagedFiles,
    unstagedFiles,
    untrackedFiles,
    untrackedPatch,
    stagedStat: stagedStatResult.exitCode === 0 ? stagedStatResult.output : "",
    unstagedStat: unstagedStatResult.exitCode === 0 ? unstagedStatResult.output : "",
    stagedPatch: stagedPatchResult.exitCode === 0 ? stagedPatchResult.output : "",
    unstagedPatch: unstagedPatchResult.exitCode === 0 ? unstagedPatchResult.output : "",
  };
}

function buildTaggedFileLines(snapshot: WorkingTreeDiffSnapshot): string[] {
  const tagged = new Map<string, Set<string>>();

  const pushTag = (file: string, tag: string) => {
    const existing = tagged.get(file) ?? new Set<string>();
    existing.add(tag);
    tagged.set(file, existing);
  };

  for (const file of snapshot.stagedFiles) {
    pushTag(file, "staged");
  }
  for (const file of snapshot.unstagedFiles) {
    pushTag(file, "unstaged");
  }
  for (const file of snapshot.untrackedFiles) {
    pushTag(file, "untracked");
  }

  return [...tagged.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([file, tags]) => `${file} [${[...tags].join(", ")}]`);
}

function buildLivePatchText(snapshot: WorkingTreeDiffSnapshot): string {
  const parts: string[] = [];

  if (snapshot.stagedPatch.trim().length > 0) {
    parts.push("# staged");
    parts.push(snapshot.stagedPatch.trim());
  }
  if (snapshot.unstagedPatch.trim().length > 0) {
    parts.push("# unstaged");
    parts.push(snapshot.unstagedPatch.trim());
  }
  if (snapshot.untrackedFiles.length > 0) {
    parts.push("# untracked");
    parts.push(
      snapshot.untrackedPatch.trim().length > 0
        ? snapshot.untrackedPatch.trim()
        : snapshot.untrackedFiles.map((file) => `+ ${file}`).join("\n"),
    );
  }

  return parts.join("\n\n").trim();
}

async function buildDiffContext(input: {
  channelId: string;
  guildId: string;
  workingDir: string;
  baseInput: string | null;
  repository: Repository;
}): Promise<DiffContext> {
  const threadMeta = parseThreadBranchMeta(input.repository.getThreadBranchMeta(input.channelId));
  const hasThreadWorktree = Boolean(
    threadMeta?.worktreePath && existsSync(threadMeta.worktreePath),
  );

  if (!threadMeta || !hasThreadWorktree) {
    return {
      channelId: input.channelId,
      guildId: input.guildId,
      workingDir: input.workingDir,
      mode: "working-tree",
    };
  }

  const rootChannel = input.repository.getChannel(threadMeta.rootChannelId);
  const rootWorkingDir = rootChannel?.workingDir ?? input.workingDir;
  const detectedBase = await detectBranchName(rootWorkingDir);
  const baseRef = input.baseInput?.trim() || detectedBase || "main";
  return {
    channelId: input.channelId,
    guildId: input.guildId,
    workingDir: input.workingDir,
    mode: "thread-branch",
    baseRef,
    rangeRef: `${baseRef}...HEAD`,
  };
}

async function buildDiffDetail(context: DiffContext, action: DiffDetailAction): Promise<string> {
  const snapshot = await buildWorkingTreeDiffSnapshot(context.workingDir);
  const taggedFiles = buildTaggedFileLines(snapshot);

  if (action === "files") {
    const lines = [
      "Staged:",
      ...(snapshot.stagedFiles.length > 0 ? snapshot.stagedFiles : ["(none)"]),
      "",
      "Unstaged:",
      ...(snapshot.unstagedFiles.length > 0 ? snapshot.unstagedFiles : ["(none)"]),
      "",
      "Untracked:",
      ...(snapshot.untrackedFiles.length > 0 ? snapshot.untrackedFiles : ["(none)"]),
      "",
      `Total changed files: ${taggedFiles.length}`,
    ];
    return [
      `Diff files (\`${context.mode}\`)`,
      "```bash",
      clipOutput(lines.join("\n"), 12000),
      "```",
    ].join("\n");
  }
  if (action === "stat") {
    const lines = [
      "Staged:",
      snapshot.stagedStat || "(none)",
      "",
      "Unstaged:",
      snapshot.unstagedStat || "(none)",
      "",
      "Untracked:",
      snapshot.untrackedFiles.length > 0 ? snapshot.untrackedFiles.join("\n") : "(none)",
    ];
    return [
      `Diff stat (\`${context.mode}\`)`,
      "```bash",
      clipOutput(lines.join("\n"), 12000),
      "```",
    ].join("\n");
  }
  const livePatch = buildLivePatchText(snapshot);
  return [
    `Diff patch (\`${context.mode}\`)`,
    "```diff",
    clipOutput(livePatch || "(no differences)", 12000),
    "```",
  ].join("\n");
}

function sanitizeThreadToken(input: string): string {
  const base = input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return base.length > 0 ? base : "thread";
}

async function buildAutoWorktreeTarget(input: {
  baseWorkingDir: string;
  channelId: string;
  branchHint?: string | null;
}): Promise<{ worktreePath: string; branchName: string } | null> {
  const topLevelResult = await runCommand(
    ["git", "rev-parse", "--show-toplevel"],
    input.baseWorkingDir,
  );
  if (topLevelResult.exitCode !== 0) {
    return null;
  }

  const repoRoot = firstOutputLine(topLevelResult.output);
  if (!repoRoot) {
    return null;
  }

  const repoName = path.basename(repoRoot);
  const suffix = input.channelId.slice(-8);
  const token = sanitizeThreadToken(input.branchHint ?? `worktree-${Date.now().toString(36)}`);
  const worktreeRoot = path.resolve(repoRoot, "..", `${repoName}.discord-worktrees`);
  const worktreePath = path.join(worktreeRoot, `${token}-${suffix}`);
  const branchName = input.branchHint ?? `discord/${token.slice(0, 40)}-${suffix}`;
  await mkdir(worktreeRoot, { recursive: true });

  return { worktreePath, branchName };
}

function buildWorktreeBootstrapSummary(result: WorktreeBootstrapResult): string {
  if (!result.attempted) {
    return `setup skipped (${result.skippedReason ?? "not needed"})`;
  }
  const cmd = result.commandText ?? "unknown command";
  if (result.exitCode === 0) {
    return `setup ok (\`${cmd}\`)`;
  }
  const details = result.output?.trim()
    ? `\n\`\`\`bash\n${clipOutput(result.output, 1200)}\n\`\`\``
    : "";
  return `setup failed (\`${cmd}\`, exit=${result.exitCode})${details}`;
}

type ProvisionedWorktree = {
  worktreePath: string;
  created: boolean;
};

async function maybeProvisionThreadWorktree(input: {
  enabled: boolean;
  parentWorkingDir: string;
  threadChannelId: string;
  threadName: string;
}): Promise<ProvisionedWorktree | null> {
  if (!input.enabled) {
    return null;
  }

  const topLevelResult = await runCommand(
    ["git", "rev-parse", "--show-toplevel"],
    input.parentWorkingDir,
  );
  if (topLevelResult.exitCode !== 0) {
    return null;
  }

  const repoRoot = firstOutputLine(topLevelResult.output);
  if (!repoRoot) {
    return null;
  }

  const repoName = path.basename(repoRoot);
  const token = sanitizeThreadToken(input.threadName);
  const suffix = input.threadChannelId.slice(-8);
  const worktreeRoot = path.resolve(repoRoot, "..", `${repoName}.discord-worktrees`);
  const worktreePath = path.join(worktreeRoot, `${token}-${suffix}`);
  const branchName = `discord/${token.slice(0, 40)}-${suffix}`;

  if (existsSync(worktreePath)) {
    return { worktreePath, created: false };
  }

  await mkdir(worktreeRoot, { recursive: true });

  let addResult = await runCommand(
    ["git", "worktree", "add", worktreePath, "-b", branchName],
    repoRoot,
  );
  if (addResult.exitCode !== 0 && /already exists/i.test(addResult.output)) {
    addResult = await runCommand(["git", "worktree", "add", worktreePath, branchName], repoRoot);
  }
  if (addResult.exitCode !== 0) {
    console.warn(
      `Thread worktree provisioning failed for ${input.threadChannelId}: ${addResult.output}`,
    );
    return null;
  }

  return { worktreePath, created: true };
}

async function maybeInheritThreadContext(input: {
  channel: unknown;
  channelId: string;
  guildId: string;
  sessions: SessionManager;
  repository: Repository;
  autoThreadWorktree: boolean;
  worktreeBootstrap: boolean;
  worktreeBootstrapCommand?: string;
}): Promise<void> {
  const existing = input.repository.getChannel(input.channelId);
  if (existing) {
    return;
  }

  if (!isThreadBootstrapChannel(input.channel) || !input.channel.isThread()) {
    input.sessions.ensureChannel(input.channelId, input.guildId);
    return;
  }

  const parentChannelId = input.channel.parentId;
  if (!parentChannelId) {
    input.sessions.ensureChannel(input.channelId, input.guildId);
    return;
  }

  const parent = input.repository.getChannel(parentChannelId);
  if (!parent) {
    input.sessions.ensureChannel(input.channelId, input.guildId);
    return;
  }

  input.sessions.cloneChannelContext(parentChannelId, input.channelId, input.guildId);
  const threadName = cloneThreadBranchName(input.channel.name ?? "");
  const parentPrompt = input.repository.getChannelSystemPrompt(parentChannelId);
  if (parentPrompt) {
    input.repository.setChannelSystemPrompt(input.channelId, parentPrompt);
  }
  const parentMeta = parseThreadBranchMeta(input.repository.getThreadBranchMeta(parentChannelId));
  const rootChannelId = parentMeta?.rootChannelId ?? parentChannelId;
  const forkSourceSessionId = parent.sessionId ?? undefined;

  if (input.autoThreadWorktree) {
    const provisioned = await maybeProvisionThreadWorktree({
      enabled: true,
      parentWorkingDir: parent.workingDir,
      threadChannelId: input.channelId,
      threadName,
    });
    if (provisioned) {
      if (provisioned.created) {
        const setup = await runWorktreeBootstrap({
          enabled: input.worktreeBootstrap,
          customCommand: input.worktreeBootstrapCommand,
          workingDir: provisioned.worktreePath,
          runCommand,
        });
        if (setup.attempted && setup.exitCode !== 0) {
          console.warn(
            `Thread worktree setup failed for ${input.channelId}: ${setup.output || "(no output)"}`,
          );
        }
      }
      input.sessions.setWorkingDir(input.channelId, provisioned.worktreePath);
    }
    saveThreadBranchMeta(input.repository, {
      channelId: input.channelId,
      guildId: input.guildId,
      rootChannelId,
      parentChannelId,
      name: threadName,
      createdAt: Date.now(),
      ...(provisioned
        ? { worktreePath: provisioned.worktreePath, worktreeMode: "worktree" as const }
        : { worktreeMode: "inherited" as const }),
      ...(forkSourceSessionId ? { forkSourceSessionId } : {}),
      lifecycleState: "active",
      cleanupState: "none",
    });
    return;
  }

  saveThreadBranchMeta(input.repository, {
    channelId: input.channelId,
    guildId: input.guildId,
    rootChannelId,
    parentChannelId,
    name: threadName,
    createdAt: Date.now(),
    worktreeMode: "prompt",
    ...(forkSourceSessionId ? { forkSourceSessionId } : {}),
    lifecycleState: "active",
    cleanupState: "none",
  });

  if (!canSendMessage(input.channel)) {
    return;
  }

  try {
    await input.channel.send({
      content:
        `Thread inherited project \`${parent.workingDir}\`.\n` +
        "Choose whether to keep parent project or create a dedicated git worktree for this thread.",
      components: buildThreadWorktreeChoiceButtons(input.channelId),
    });
  } catch {
    // Ignore thread setup message failures (permissions, unsupported channel types, etc).
  }
}

function saveThreadBranchMeta(
  repository: Repository,
  meta: {
    channelId: string;
    guildId: string;
    rootChannelId: string;
    parentChannelId: string | null;
    forkSourceSessionId?: string;
    name: string;
    createdAt: number;
    worktreePath?: string;
    worktreeMode?: "prompt" | "inherited" | "worktree";
    lifecycleState?: "active" | "archived" | "deleted";
    cleanupState?: "none" | "pending" | "kept" | "removed";
    archivedAt?: number;
    deletedAt?: number;
  },
): void {
  repository.setThreadBranchMeta(meta.channelId, JSON.stringify(meta));
}

function resolveThreadParentWorkingDir(
  repository: Repository,
  meta: {
    parentChannelId: string | null;
    rootChannelId: string;
  },
  fallbackWorkingDir: string,
): string {
  const parentChannelId = meta.parentChannelId ?? meta.rootChannelId;
  const parentChannel = repository.getChannel(parentChannelId);
  return parentChannel?.workingDir ?? fallbackWorkingDir;
}

type DiscordClientChannelFetcher = {
  channels: {
    fetch: (id: string) => Promise<unknown>;
  };
};

async function resolveThreadLifecycleNotificationChannel(input: {
  thread: { parent?: unknown } | null;
  parentId: string | null;
  client: DiscordClientChannelFetcher | null;
}): Promise<SendableChannel | null> {
  if (input.thread?.parent && canSendMessage(input.thread.parent)) {
    return input.thread.parent;
  }

  if (!input.parentId || !input.client) {
    return null;
  }

  try {
    const parent = await input.client.channels.fetch(input.parentId);
    return canSendMessage(parent) ? parent : null;
  } catch {
    return null;
  }
}

async function cleanupFiles(paths: string[]): Promise<void> {
  for (const filePath of paths) {
    try {
      await unlink(filePath);
    } catch {
      // Ignore cleanup errors.
    }
  }
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

  // Fallback for tools that report only basename while writing nested paths.
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

function extractAttachmentPathCandidates(text: string, maxCandidates = 40): string[] {
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

function extractStructuredAttachmentDirectives(
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

function formatErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message.trim();
  }
  return "unknown error";
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

async function sendGeneratedFilesToChannel(input: {
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

async function runBashCommand(
  command: string,
  cwd: string,
): Promise<{ exitCode: number; output: string }> {
  const process = Bun.spawn({
    cmd: ["/bin/zsh", "-lc", command],
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);

  const output = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n");
  return {
    exitCode,
    output,
  };
}

type LiveToolStatus = "queued" | "running" | "done" | "failed" | "interrupted";

type LiveToolEntry = {
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

type LiveToolTrace = {
  order: string[];
  byId: Map<string, LiveToolEntry>;
  indexToToolId: Map<number, string>;
  inputJsonBufferByToolId: Map<string, string>;
  taskIdToToolId: Map<string, string>;
};

function createLiveToolTrace(): LiveToolTrace {
  return {
    order: [],
    byId: new Map<string, LiveToolEntry>(),
    indexToToolId: new Map<number, string>(),
    inputJsonBufferByToolId: new Map<string, string>(),
    taskIdToToolId: new Map<string, string>(),
  };
}

function clipText(value: string, maxChars: number): string {
  const trimmed = value.replace(/\s+/g, " ").trim();
  if (trimmed.length <= maxChars) {
    return trimmed;
  }
  return `${trimmed.slice(0, Math.max(0, maxChars - 3))}...`;
}

function clipRawText(value: string, maxChars: number): string {
  const trimmed = value.trim();
  if (trimmed.length <= maxChars) {
    return trimmed;
  }
  return `${trimmed.slice(0, Math.max(0, maxChars - 3))}...`;
}

function italicizeMultiline(text: string): string {
  return text
    .split("\n")
    .map((line) => (line.trim().length === 0 ? "" : `_${line}_`))
    .join("\n");
}

const THINKING_SPINNER_FRAMES = ["-", "\\", "|", "/"] as const;
const ACTIVE_RUN_MAX_AGE_MS = 30 * 60 * 1000;
const ACTIVE_RUN_WATCHDOG_INTERVAL_MS = 30 * 1000;

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

function collectToolIdsFromMessage(trace: LiveToolTrace, message: ClaudeSDKMessage): string[] {
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

function applyToolMessageToTrace(trace: LiveToolTrace, message: ClaudeSDKMessage): boolean {
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

function finalizeLiveToolTrace(
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

type LiveToolRenderPayload = {
  flags: number;
  components: [ContainerBuilder];
};

function buildSingleLiveToolMessage(
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

function toStreamingPreview(
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

export async function startApp(
  config: AppConfig,
  runtimeOverrides: StartAppRuntimeOverrides = {},
): Promise<void> {
  const openDatabaseImpl = runtimeOverrides.openDatabase ?? openDatabase;
  const registerSlashCommandsImpl = runtimeOverrides.registerSlashCommands ?? registerSlashCommands;
  const startDiscordClientImpl = runtimeOverrides.startDiscordClient ?? startDiscordClient;
  const installSignalHandlers = runtimeOverrides.installSignalHandlers ?? true;

  const database = openDatabaseImpl(config.databasePath);
  const repository = new Repository(database);
  const sessions = new SessionManager(repository, {
    defaultWorkingDir: config.defaultWorkingDir,
    defaultModel: config.defaultModel,
    maxHistoryItems: config.sessionHistoryMaxItems,
    maxTurnChars: config.sessionTurnMaxChars,
  });
  const activeRunMaxAgeMs = config.activeRunMaxAgeMs ?? ACTIVE_RUN_MAX_AGE_MS;
  const activeRunWatchdogIntervalMs =
    config.activeRunWatchdogIntervalMs ?? ACTIVE_RUN_WATCHDOG_INTERVAL_MS;
  const stopController = new StopController();
  const runner = runtimeOverrides.createRunner?.() ?? new ClaudeRunner();
  const pendingProjectSwitches = new Map<
    string,
    { channelId: string; guildId: string; workingDir: string }
  >();
  const pendingDiffViews = new Map<string, DiffContext>();
  const pendingMessageRunsByChannel = new Map<string, Promise<void>>();
  // Maps queue notice message ID → steer info; allows mid-run message injection via "Send Now"
  const queuedNoticesByMessageId = new Map<string, { text: string; cancelled: boolean }>();
  const liveToolTracesByChannel = new Map<string, LiveToolTrace>();
  const liveToolExpandStateByChannel = new Map<string, Map<string, boolean>>();
  const sessionPermissionModeByChannel = new Map<string, ClaudePermissionMode>();
  const suspendedChannels = new Set<string>();
  const discordDispatchStats = {
    rateLimitHits: 0,
    lastRateLimitAtMs: 0,
    lastRateLimitLane: "",
  };
  const discordDispatch = new DiscordDispatchQueue({
    maxAttempts: 4,
    baseBackoffMs: 250,
    maxBackoffMs: 4000,
    onRateLimit: ({ laneId, retryAfterMs, attempt }) => {
      discordDispatchStats.rateLimitHits += 1;
      discordDispatchStats.lastRateLimitAtMs = Date.now();
      discordDispatchStats.lastRateLimitLane = laneId;
      console.warn(
        `Discord dispatcher retry lane=${laneId} attempt=${attempt} wait=${retryAfterMs}ms`,
      );
    },
  });
  let shuttingDown = false;
  let shutdownPromise: Promise<void> | null = null;
  let discordClient: Awaited<ReturnType<typeof startDiscordClient>> | null = null;
  let staleRunWatchdog: ReturnType<typeof setInterval> | null = null;
  const workerHeartbeatFile = process.env.WORKER_HEARTBEAT_FILE?.trim();
  const workerHeartbeatIntervalSecondsRaw = process.env.WORKER_HEARTBEAT_INTERVAL_SECONDS?.trim();
  const workerHeartbeatIntervalSeconds = workerHeartbeatIntervalSecondsRaw
    ? Number.parseInt(workerHeartbeatIntervalSecondsRaw, 10)
    : 10;
  const workerHeartbeatIntervalMs =
    Number.isFinite(workerHeartbeatIntervalSeconds) && workerHeartbeatIntervalSeconds > 0
      ? workerHeartbeatIntervalSeconds * 1000
      : 10_000;
  let workerHeartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let heartbeatWriteFailed = false;

  const writeWorkerHeartbeat = async (): Promise<void> => {
    if (!workerHeartbeatFile) {
      return;
    }
    try {
      await writeFile(
        workerHeartbeatFile,
        JSON.stringify({ pid: process.pid, timestampMs: Date.now() }),
        "utf8",
      );
      heartbeatWriteFailed = false;
    } catch (error) {
      if (!heartbeatWriteFailed) {
        const detail = error instanceof Error ? error.message : String(error);
        console.warn(`Failed to write worker heartbeat: ${detail}`);
        heartbeatWriteFailed = true;
      }
    }
  };

  const resolvePermissionModeForSession = (channelId: string) =>
    resolvePermissionModeForChannel({
      sessionPermissionMode: sessionPermissionModeByChannel.get(channelId),
      defaultPermissionMode: config.claudePermissionMode,
    });

  const setSessionPermissionMode = (
    channelId: string,
    mode: ClaudePermissionMode | "default",
  ): void => {
    if (mode === "default") {
      sessionPermissionModeByChannel.delete(channelId);
      return;
    }
    sessionPermissionModeByChannel.set(channelId, mode);
  };

  const clearSessionPermissionMode = (channelId: string): void => {
    sessionPermissionModeByChannel.delete(channelId);
  };

  const getToolExpanded = (channelId: string, toolId: string): boolean => {
    const channelState = liveToolExpandStateByChannel.get(channelId);
    if (!channelState) {
      return true;
    }
    return channelState.get(toolId) ?? true;
  };

  const setToolExpanded = (channelId: string, toolId: string, expanded: boolean): void => {
    const channelState = liveToolExpandStateByChannel.get(channelId) ?? new Map<string, boolean>();
    channelState.set(toolId, expanded);
    liveToolExpandStateByChannel.set(channelId, channelState);
  };

  const rememberDiffView = (requestId: string, context: DiffContext) => {
    pendingDiffViews.set(requestId, context);
    while (pendingDiffViews.size > 250) {
      const oldest = pendingDiffViews.keys().next().value;
      if (!oldest) {
        break;
      }
      pendingDiffViews.delete(oldest);
    }
  };

  const clearActiveRunsWithSessionReset = (reason: string) => {
    const activeChannelIds = stopController.getActiveChannelIds();
    if (activeChannelIds.length === 0) {
      return;
    }
    for (const activeChannelId of activeChannelIds) {
      sessions.setSessionId(activeChannelId, null);
      clearSessionPermissionMode(activeChannelId);
    }
    const aborted = stopController.abortAll();
    console.warn(`Cleared ${aborted.length} active run(s) due to ${reason}.`);
  };

  const abortChannelRunWithSessionReset = (channelId: string, reason: string) => {
    const aborted = stopController.abort(channelId);
    if (!aborted) {
      return false;
    }
    sessions.setSessionId(channelId, null);
    clearSessionPermissionMode(channelId);
    console.warn(`Aborted active run for channel ${channelId} (${reason}).`);
    return true;
  };

  const startStaleRunWatchdog = () => {
    if (staleRunWatchdog) {
      return;
    }
    staleRunWatchdog = setInterval(() => {
      if (shuttingDown) {
        return;
      }
      const staleChannelIds = stopController.abortOlderThan(activeRunMaxAgeMs);
      if (staleChannelIds.length === 0) {
        return;
      }
      for (const staleChannelId of staleChannelIds) {
        sessions.setSessionId(staleChannelId, null);
        clearSessionPermissionMode(staleChannelId);
      }
      console.warn(`Reaped ${staleChannelIds.length} stale active run(s).`);
    }, activeRunWatchdogIntervalMs);
    staleRunWatchdog.unref?.();
  };

  const shutdown = async (reason: string): Promise<void> => {
    if (shutdownPromise) {
      return shutdownPromise;
    }
    shuttingDown = true;
    shutdownPromise = (async () => {
      console.log(`Shutting down (${reason})...`);
      pendingProjectSwitches.clear();
      pendingDiffViews.clear();
      liveToolTracesByChannel.clear();
      liveToolExpandStateByChannel.clear();
      clearActiveRunsWithSessionReset(`shutdown:${reason}`);
      if ("closeAll" in runner && typeof runner.closeAll === "function") {
        runner.closeAll();
      }
      if (staleRunWatchdog) {
        clearInterval(staleRunWatchdog);
        staleRunWatchdog = null;
      }
      if (workerHeartbeatTimer) {
        clearInterval(workerHeartbeatTimer);
        workerHeartbeatTimer = null;
      }

      if (discordClient) {
        try {
          discordClient.destroy();
        } catch (error) {
          console.error("Failed to destroy Discord client during shutdown", error);
        }
      }

      try {
        database.close();
      } catch (error) {
        console.error("Failed to close database during shutdown", error);
      }
      console.log("Shutdown complete.");
    })();

    return shutdownPromise;
  };

  try {
    if (workerHeartbeatFile) {
      try {
        await mkdir(path.dirname(workerHeartbeatFile), { recursive: true });
      } catch {
        // Ignore heartbeat directory errors; heartbeat writes log failures if they persist.
      }
      await writeWorkerHeartbeat();
      workerHeartbeatTimer = setInterval(() => {
        void writeWorkerHeartbeat();
      }, workerHeartbeatIntervalMs);
      workerHeartbeatTimer.unref?.();
    }

    await registerSlashCommandsImpl({
      token: config.discordToken,
      clientId: config.discordClientId,
      guildId: config.discordGuildId,
    });

    discordClient = await startDiscordClientImpl({
      token: config.discordToken,
      shouldRequireMentionForMessage: (message) =>
        resolveMentionRequirementForChannel({
          repository,
          channelId: message.channel.id,
          defaultRequireMention: config.requireMentionInMultiUserChannels,
        }).requireMention,
      onGatewayDisconnect: (code) => {
        if (shuttingDown) {
          return;
        }
        clearActiveRunsWithSessionReset(`gateway disconnect (code=${code})`);
      },
      onGatewayReconnecting: () => {
        if (!shuttingDown) {
          console.warn("Gateway reconnect in progress.");
        }
      },
      onGatewayResume: () => {
        if (!shuttingDown) {
          console.log("Gateway resume completed.");
        }
      },
      onThreadLifecycle: async (event) => {
        if (shuttingDown) {
          return;
        }

        if (event.type === "unarchived") {
          suspendedChannels.delete(event.threadId);
        } else {
          suspendedChannels.add(event.threadId);
          abortChannelRunWithSessionReset(event.threadId, `thread ${event.type}`);
        }

        const meta = parseThreadBranchMeta(repository.getThreadBranchMeta(event.threadId));
        if (!meta) {
          return;
        }

        if (event.type === "unarchived") {
          const { archivedAt: _archivedAt, deletedAt: _deletedAt, ...rest } = meta;
          saveThreadBranchMeta(repository, {
            ...rest,
            lifecycleState: "active",
            cleanupState: meta.cleanupState === "pending" ? "none" : (meta.cleanupState ?? "none"),
          });
          return;
        }

        const lifecycleState = event.type === "archived" ? "archived" : "deleted";
        const updatedMeta = {
          ...meta,
          lifecycleState,
          ...(event.type === "archived" ? { archivedAt: Date.now() } : { deletedAt: Date.now() }),
          cleanupState: meta.cleanupState ?? "none",
        } as const;

        const shouldPromptCleanup =
          Boolean(updatedMeta.worktreePath) && updatedMeta.cleanupState === "none";
        if (!shouldPromptCleanup) {
          saveThreadBranchMeta(repository, updatedMeta);
          return;
        }

        saveThreadBranchMeta(repository, {
          ...updatedMeta,
          cleanupState: "pending",
        });

        const target = await resolveThreadLifecycleNotificationChannel({
          thread: event.thread,
          parentId: event.parentId,
          client: discordClient,
        });
        if (!target) {
          return;
        }

        try {
          const statusVerb = event.type === "archived" ? "archived" : "deleted";
          await discordDispatch.enqueue(`thread-lifecycle:${event.threadId}`, async () => {
            await target.send({
              content:
                `Thread \`${event.threadName}\` was ${statusVerb}.\n` +
                `Worktree \`${updatedMeta.worktreePath}\` still exists. Keep it or remove it now?`,
              components: buildThreadCleanupButtons(event.threadId),
            });
          });
        } catch {
          // Ignore lifecycle prompt failures when channel permissions/cache are limited.
        }
      },
      onButtonInteraction: async (interaction) => {
        if (shuttingDown) {
          await interaction.reply({
            content: "Bot is shutting down. Please retry in a moment.",
            flags: MessageFlags.Ephemeral,
          });
          return;
        }
        const projectSwitch = parseProjectSwitchCustomId(interaction.customId);
        if (projectSwitch) {
          const pending = pendingProjectSwitches.get(projectSwitch.requestId);
          if (!pending) {
            await interaction.reply({
              content: "Project switch request expired. Run /project again.",
              flags: MessageFlags.Ephemeral,
            });
            return;
          }
          if (interaction.channelId !== pending.channelId) {
            await interaction.reply({
              content: "This project switch belongs to a different channel.",
              flags: MessageFlags.Ephemeral,
            });
            return;
          }

          pendingProjectSwitches.delete(projectSwitch.requestId);
          const previousChannelState = sessions.getState(
            pending.channelId,
            pending.guildId,
          ).channel;
          const state = sessions.switchProject(
            pending.channelId,
            pending.guildId,
            pending.workingDir,
            {
              fresh: projectSwitch.action === "fresh",
            },
          );
          const changedProject = previousChannelState.workingDir !== pending.workingDir;
          if (projectSwitch.action === "fresh" || changedProject) {
            clearSessionPermissionMode(pending.channelId);
          }
          const suffix =
            projectSwitch.action === "fresh"
              ? " with fresh session."
              : changedProject
                ? " (context kept, session restarted)."
                : " (context kept).";
          await interaction.update({
            content: `Project set to \`${state.channel.workingDir}\`${suffix}`,
            components: [],
          });
          void syncChannelTopic(interaction.channel, state.channel.workingDir);
          return;
        }

        const threadWorktreeChoice = parseThreadWorktreeChoiceCustomId(interaction.customId);
        if (threadWorktreeChoice) {
          if (interaction.channelId !== threadWorktreeChoice.channelId) {
            await interaction.reply({
              content: "This thread setup action belongs to a different channel.",
              flags: MessageFlags.Ephemeral,
            });
            return;
          }

          const guildId = interaction.guildId ?? "dm";
          const channelId = threadWorktreeChoice.channelId;
          const state = sessions.getState(channelId, guildId);
          const meta = parseThreadBranchMeta(repository.getThreadBranchMeta(channelId));
          if (!meta) {
            await interaction.reply({
              content:
                "Thread setup request expired. Re-run `/status` and `/worktree action:thread`.",
              flags: MessageFlags.Ephemeral,
            });
            return;
          }

          if (threadWorktreeChoice.action === "keep") {
            const { worktreePath: _worktreePath, ...rest } = meta;
            saveThreadBranchMeta(repository, {
              ...rest,
              worktreeMode: "inherited",
              lifecycleState: meta.lifecycleState ?? "active",
              cleanupState: "none",
            });
            await interaction.update({
              content: `Thread will keep parent project \`${state.channel.workingDir}\`.`,
              components: [],
            });
            return;
          }

          const parentChannelId = meta.parentChannelId ?? meta.rootChannelId;
          const parentChannel = repository.getChannel(parentChannelId);
          const parentWorkingDir = parentChannel?.workingDir ?? state.channel.workingDir;
          const provisioned = await maybeProvisionThreadWorktree({
            enabled: true,
            parentWorkingDir,
            threadChannelId: channelId,
            threadName: meta.name,
          });

          if (!provisioned) {
            await interaction.update({
              content:
                `Could not create worktree from \`${parentWorkingDir}\`.\n` +
                "You can keep parent project or retry create worktree.",
              components: buildThreadWorktreeChoiceButtons(channelId),
            });
            return;
          }

          let setupSummary = "";
          if (provisioned.created) {
            const setupResult = await runWorktreeBootstrap({
              enabled: config.worktreeBootstrap,
              customCommand: config.worktreeBootstrapCommand,
              workingDir: provisioned.worktreePath,
              runCommand,
            });
            setupSummary = `\n${buildWorktreeBootstrapSummary(setupResult)}`;
          }

          sessions.switchProject(channelId, guildId, provisioned.worktreePath);
          sessions.setSessionId(channelId, null);
          clearSessionPermissionMode(channelId);
          saveThreadBranchMeta(repository, {
            ...meta,
            worktreePath: provisioned.worktreePath,
            worktreeMode: "worktree",
            lifecycleState: meta.lifecycleState ?? "active",
            cleanupState: "none",
          });
          await interaction.update({
            content:
              `Thread switched to dedicated worktree \`${provisioned.worktreePath}\` (session restarted).` +
              setupSummary,
            components: [],
          });
          void syncChannelTopic(interaction.channel, provisioned.worktreePath);
          return;
        }

        const threadCleanup = parseThreadCleanupCustomId(interaction.customId);
        if (threadCleanup) {
          const channelId = threadCleanup.channelId;
          const meta = parseThreadBranchMeta(repository.getThreadBranchMeta(channelId));
          if (!meta) {
            await interaction.reply({
              content: "Thread cleanup request expired.",
              flags: MessageFlags.Ephemeral,
            });
            return;
          }

          const worktreePath = meta.worktreePath;
          if (!worktreePath) {
            saveThreadBranchMeta(repository, {
              ...meta,
              cleanupState: "removed",
            });
            await interaction.update({
              content: `No dedicated worktree remains for thread \`${meta.name}\`.`,
              components: [],
            });
            return;
          }

          if (threadCleanup.action === "keep") {
            saveThreadBranchMeta(repository, {
              ...meta,
              cleanupState: "kept",
            });
            await interaction.update({
              content: `Keeping worktree \`${worktreePath}\` for thread \`${meta.name}\`.`,
              components: [],
            });
            return;
          }

          if (!existsSync(worktreePath)) {
            const { worktreePath: _removedPath, ...rest } = meta;
            saveThreadBranchMeta(repository, {
              ...rest,
              worktreeMode: "inherited",
              cleanupState: "removed",
            });
            await interaction.update({
              content: `Worktree already removed: \`${worktreePath}\`.`,
              components: [],
            });
            return;
          }

          const fallbackWorkingDir = path.dirname(worktreePath);
          const parentWorkingDir = resolveThreadParentWorkingDir(
            repository,
            meta,
            fallbackWorkingDir,
          );
          const removeResult = await runCommand(
            ["git", "worktree", "remove", worktreePath],
            parentWorkingDir,
          );
          if (removeResult.exitCode !== 0) {
            await interaction.update({
              content:
                `Failed to remove worktree \`${worktreePath}\`.\n` +
                `\`\`\`bash\n${removeResult.output || "(no output)"}\n\`\`\``,
              components: buildThreadCleanupButtons(channelId),
            });
            return;
          }

          const pruneResult = await runCommand(["git", "worktree", "prune"], parentWorkingDir);
          const { worktreePath: _removedPath, ...rest } = meta;
          saveThreadBranchMeta(repository, {
            ...rest,
            worktreeMode: "inherited",
            cleanupState: "removed",
          });

          const pruneSummary =
            pruneResult.exitCode === 0
              ? "git worktree prune complete."
              : `git worktree prune exit=${pruneResult.exitCode}: ${pruneResult.output || "(no output)"}`;
          await interaction.update({
            content: `Removed thread worktree \`${worktreePath}\`.\n` + `${pruneSummary}`,
            components: [],
          });
          return;
        }

        const diffView = parseDiffViewCustomId(interaction.customId);
        if (diffView) {
          const context = pendingDiffViews.get(diffView.requestId);
          if (!context) {
            await interaction.reply({
              content: "Diff view expired. Run `/diff` again.",
              flags: MessageFlags.Ephemeral,
            });
            return;
          }
          if (interaction.channelId !== context.channelId) {
            await interaction.reply({
              content: "This diff view belongs to a different channel.",
              flags: MessageFlags.Ephemeral,
            });
            return;
          }

          const latestState = sessions.getState(context.channelId, context.guildId).channel;
          if (latestState.workingDir !== context.workingDir) {
            pendingDiffViews.delete(diffView.requestId);
            await interaction.reply({
              content: "Project changed since this diff snapshot. Run `/diff` again.",
              flags: MessageFlags.Ephemeral,
            });
            return;
          }

          if (diffView.action === "summary") {
            const refreshedContext = await buildDiffContext({
              channelId: context.channelId,
              guildId: context.guildId,
              workingDir: context.workingDir,
              baseInput: context.baseRef ?? null,
              repository,
            });
            rememberDiffView(diffView.requestId, refreshedContext);
            const patchDetail = await buildDiffDetail(refreshedContext, "patch");
            const delivery = buildDiffDelivery(patchDetail, "diff-patch");
            await interaction.update({
              content: delivery.content,
              files: delivery.files,
              components: buildDiffViewButtons(diffView.requestId),
            });
            return;
          }

          await interaction.deferReply({ flags: MessageFlags.Ephemeral });
          const detail = await buildDiffDetail(context, diffView.action);
          const delivery = buildDiffDelivery(detail, `diff-${diffView.action}`);
          await interaction.editReply({
            content: delivery.content,
            files: delivery.files,
          });
          return;
        }

        const queueNotice = parseQueueNoticeCustomId(interaction.customId);
        if (queueNotice) {
          if (interaction.channelId !== queueNotice.channelId) {
            await interaction.reply({
              content: "This queue notice belongs to a different channel.",
              flags: MessageFlags.Ephemeral,
            });
            return;
          }
          if (interaction.user.id !== queueNotice.userId) {
            await interaction.reply({
              content: "Only the queued user can interact with this notice.",
              flags: MessageFlags.Ephemeral,
            });
            return;
          }

          await interaction.deferUpdate();

          const noticeInfo = queuedNoticesByMessageId.get(interaction.message.id);
          if (queueNotice.action === "steer") {
            const steerText = noticeInfo?.text;
            const steered = steerText ? runner.steer(queueNotice.channelId, steerText) : false;
            if (steered && noticeInfo) {
              noticeInfo.cancelled = true;
              queuedNoticesByMessageId.delete(interaction.message.id);
            }
            try {
              await interaction.message.edit({
                content: steered
                  ? "💬 Sent to Claude."
                  : "⏳ Could not send immediately. Keeping this message queued.",
                components: [],
              });
            } catch {
              // Ignore edit failures.
            }
            return;
          }

          if (noticeInfo) {
            noticeInfo.cancelled = true;
            queuedNoticesByMessageId.delete(interaction.message.id);
          }
          try {
            await interaction.message.delete();
          } catch {
            try {
              await interaction.message.edit({
                content: "Queue notice dismissed.",
                components: [],
              });
            } catch {
              // Ignore queue notice dismiss fallback failures.
            }
          }
          return;
        }

        const toolView = parseToolViewCustomId(interaction.customId);
        if (toolView) {
          if (interaction.channelId !== toolView.channelId) {
            await interaction.reply({
              content: "This tool message belongs to a different channel.",
              flags: MessageFlags.Ephemeral,
            });
            return;
          }
          const trace = liveToolTracesByChannel.get(toolView.channelId);
          const entry = trace?.byId.get(toolView.toolId);
          if (!entry) {
            await interaction.reply({
              content: "Tool state expired for this message.",
              flags: MessageFlags.Ephemeral,
            });
            return;
          }
          const expanded = toolView.action === "expand";
          setToolExpanded(toolView.channelId, toolView.toolId, expanded);
          await interaction.update(
            buildSingleLiveToolMessage(entry, {
              channelId: toolView.channelId,
              expanded,
            }),
          );
          return;
        }

        const control = parseRunControlCustomId(interaction.customId);
        if (!control) {
          await interaction.reply({
            content: "Unknown control button.",
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        if (interaction.channelId !== control.channelId) {
          await interaction.reply({
            content: "This control belongs to a different channel session.",
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        if (control.action === "interrupt") {
          const interrupted = await stopController.interrupt(control.channelId);
          await interaction.reply({
            content: interrupted ? "Interrupt signal sent." : "No active run to interrupt.",
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        const aborted = stopController.abort(control.channelId);
        await interaction.reply({
          content: aborted ? "Abort signal sent." : "No active run to abort.",
          flags: MessageFlags.Ephemeral,
        });
      },
      onSlashCommand: async (interaction) => {
        if (shuttingDown) {
          await interaction.reply({
            content: "Bot is shutting down. Please retry in a moment.",
            flags: MessageFlags.Ephemeral,
          });
          return;
        }
        const channelId = interaction.channelId;
        const guildId = interaction.guildId ?? "dm";
        await maybeInheritThreadContext({
          channel: interaction.channel,
          channelId,
          guildId,
          sessions,
          repository,
          autoThreadWorktree: config.autoThreadWorktree,
          worktreeBootstrap: config.worktreeBootstrap,
          worktreeBootstrapCommand: config.worktreeBootstrapCommand,
        });

        switch (interaction.commandName) {
          case "new": {
            sessions.resetSession(channelId);
            clearSessionPermissionMode(channelId);
            await interaction.reply("Session reset for this channel.");
            break;
          }
          case "fork": {
            if (!interaction.channel) {
              await interaction.reply({
                content: "Could not resolve the current channel for `/fork`.",
                flags: MessageFlags.Ephemeral,
              });
              break;
            }

            if (
              typeof interaction.channel.isThread === "function" &&
              interaction.channel.isThread()
            ) {
              await interaction.reply({
                content:
                  "Run `/fork` from a parent text channel. This command creates a new thread from that channel.",
                flags: MessageFlags.Ephemeral,
              });
              break;
            }

            if (!canCreateForkThread(interaction.channel)) {
              await interaction.reply({
                content: "This channel type does not support creating threads.",
                flags: MessageFlags.Ephemeral,
              });
              break;
            }

            const title = buildForkThreadTitle({
              requested: interaction.options.getString("title"),
              channelName: interaction.channel.name,
            });

            const thread = await interaction.channel.threads.create({
              name: title,
              reason: "Fork created via /fork",
            });
            const threadChannel = isThreadBootstrapChannel(thread)
              ? thread
              : {
                  id: thread.id,
                  parentId: channelId,
                  name: title,
                  isThread: () => true,
                };
            await interaction.reply(`Forked into thread <#${thread.id}> (\`${title}\`).`);
            void maybeInheritThreadContext({
              channel: threadChannel,
              channelId: thread.id,
              guildId,
              sessions,
              repository,
              autoThreadWorktree: config.autoThreadWorktree,
              worktreeBootstrap: config.worktreeBootstrap,
              worktreeBootstrapCommand: config.worktreeBootstrapCommand,
            }).catch((error) => {
              const detail = error instanceof Error ? error.message : String(error);
              console.warn(`Fork thread bootstrap failed for ${thread.id}: ${detail}`);
            });
            break;
          }
          case "merge": {
            const mergeMeta = parseThreadBranchMeta(repository.getThreadBranchMeta(channelId));

            if (mergeMeta?.parentChannelId) {
              // ── Fork thread: summarize and merge context back into parent ──
              const mergeState = sessions.getState(channelId, guildId);
              const forkSessionId = mergeState.channel.sessionId;

              if (!forkSessionId) {
                await interaction.reply({
                  content:
                    "No active session in this fork yet — send at least one message first before merging.",
                  flags: MessageFlags.Ephemeral,
                });
                break;
              }

              await interaction.deferReply();

              try {
                // 1. Run a summarization query against the fork's live session
                const summaryResult = await runner.run({
                  channelId,
                  prompt: buildMergeSummaryPrompt(interaction.options.getString("focus")),
                  cwd: mergeState.channel.workingDir,
                  sessionId: forkSessionId,
                  model: mergeState.channel.model,
                });

                const summaryForContext = normalizeMergeSummary(summaryResult.text, 1000);
                const summaryForReport = normalizeMergeSummary(summaryForContext, 700);

                // 2. Store pending merge context on the parent channel
                const mergeContext: MergeContextRecord = {
                  fromChannelId: channelId,
                  fromChannelName: mergeMeta.name,
                  summary: summaryForContext,
                  mergedAt: Date.now(),
                };
                repository.setMergeContext(mergeMeta.parentChannelId, mergeContext);

                // 3. Post merge report to parent channel
                const mergeReport = buildMergeReportLines({
                  fromChannelId: channelId,
                  fromChannelName: mergeMeta.name,
                  summary: summaryForReport,
                });
                const parentChannel = await interaction.client.channels
                  .fetch(mergeMeta.parentChannelId)
                  .catch(() => null);
                if (parentChannel && canSendMessage(parentChannel)) {
                  const reportChunks = chunkDiscordText(mergeReport);
                  for (const chunk of reportChunks) {
                    if (chunk) {
                      await parentChannel.send(chunk);
                    }
                  }
                }

                // 4. Archive the fork thread
                const forkChannel = interaction.channel;
                if (
                  forkChannel &&
                  typeof (forkChannel as { setArchived?: unknown }).setArchived === "function"
                ) {
                  await (
                    forkChannel as { setArchived: (v: boolean) => Promise<unknown> }
                  ).setArchived(true);
                }

                // 5. Update lifecycle state in metadata
                saveThreadBranchMeta(repository, {
                  ...mergeMeta,
                  lifecycleState: "archived",
                  archivedAt: Date.now(),
                });

                await interaction.editReply(
                  `✅ Merged into <#${mergeMeta.parentChannelId}>. Fork thread archived.`,
                );
              } catch (error) {
                const detail = error instanceof Error ? error.message : String(error);
                await interaction.editReply(`❌ Merge failed: ${detail}`);
              }
            } else {
              // ── Parent channel: list thread worktrees (+ optionally git merge one) ──
              const mergeState = sessions.getState(channelId, guildId);
              const targetBranch = interaction.options.getString("branch");
              await interaction.deferReply();

              const allMetas = repository
                .listThreadBranchMetaEntries()
                .map((entry) => parseThreadBranchMeta(entry.value))
                .filter((entry): entry is NonNullable<typeof entry> => entry !== null);

              const rootWorkingDir = mergeState.channel.workingDir;
              const baseBranch = (await detectBranchName(rootWorkingDir)) ?? "main";

              if (targetBranch) {
                const result = await runCommand(
                  ["git", "merge", targetBranch, "--no-edit"],
                  rootWorkingDir,
                );
                const mergeSummary = summarizeGitMergeOutput(result.output);
                if (result.exitCode === 0) {
                  await interaction.editReply(
                    `✅ Merged \`${targetBranch}\` into \`${baseBranch}\`.\n${mergeSummary}`,
                  );
                } else {
                  await interaction.editReply(
                    `❌ Merge failed for \`${targetBranch}\` into \`${baseBranch}\`.\n${mergeSummary}`,
                  );
                }
                break;
              }

              const activeForMerge = allMetas
                .filter(
                  (meta) =>
                    meta.rootChannelId === channelId &&
                    meta.worktreePath &&
                    existsSync(meta.worktreePath) &&
                    (meta.lifecycleState === "active" ||
                      typeof meta.lifecycleState === "undefined"),
                )
                .sort((a, b) => a.createdAt - b.createdAt);

              if (activeForMerge.length === 0) {
                await interaction.editReply(
                  `No thread worktrees found. Use \`/fork\` + \`/worktree thread\` to create one.`,
                );
                break;
              }

              const mergeLines = [`**Worktrees** (base: \`${baseBranch}\`):`];
              for (const meta of activeForMerge) {
                const branchName = meta.worktreePath
                  ? ((await detectBranchName(meta.worktreePath)) ?? "unknown")
                  : "inherited";
                let divergencePart = "";
                if (meta.worktreePath) {
                  const revList = await runCommand(
                    ["git", "rev-list", "--left-right", "--count", `${baseBranch}...HEAD`],
                    meta.worktreePath,
                  );
                  if (revList.exitCode === 0) {
                    const counts = parseAheadBehind(revList.output);
                    if (counts) {
                      divergencePart = ` ↑${counts.ahead} ↓${counts.behind}`;
                    }
                  }
                }
                mergeLines.push(`- **${meta.name}** \`${branchName}\`${divergencePart}`);
              }
              mergeLines.push(`\nTo git merge: \`/merge branch:<branch-name>\``);

              const mergeChunks = chunkDiscordText(mergeLines.join("\n"));
              await interaction.editReply(mergeChunks[0] ?? "No worktrees.");
              for (let i = 1; i < mergeChunks.length; i++) {
                const chunk = mergeChunks[i];
                if (chunk) await interaction.followUp(chunk);
              }
            }
            break;
          }
          case "compact": {
            const state = sessions.getState(channelId, guildId);
            const summary = compactHistory(state.history);
            sessions.resetSession(channelId);
            clearSessionPermissionMode(channelId);
            sessions.appendTurn(channelId, {
              role: "assistant",
              content: `Context summary:\n${summary}`,
            });
            await interaction.reply("Context compacted and session reset.");
            break;
          }
          case "status": {
            const state = sessions.getState(channelId, guildId);
            const totalCost = repository.getChannelCostTotal(channelId);
            const turns = state.history.length;
            const channelSystemPrompt = repository.getChannelSystemPrompt(channelId);
            const mentionPolicy = resolveMentionRequirementForChannel({
              repository,
              channelId,
              defaultRequireMention: config.requireMentionInMultiUserChannels,
            });
            const permissionPolicy = resolvePermissionModeForSession(channelId);
            const threadStatusLines = buildThreadBranchStatusLines({
              currentChannelId: channelId,
              entries: repository.listThreadBranchMetaEntries(),
            });
            const lines = [
              `**${state.channel.workingDir}**`,
              `model: \`${state.channel.model}\` · turns: \`${turns}\` · cost: \`$${totalCost.toFixed(4)}\``,
              `mode: \`${permissionPolicy.permissionMode}\` · mentions: \`${mentionPolicy.requireMention ? "required" : "off"}\``,
              channelSystemPrompt
                ? `system prompt: set (\`${channelSystemPrompt.length}\` chars)`
                : null,
              state.channel.sessionId ? `session: \`${state.channel.sessionId}\`` : null,
              ...threadStatusLines,
            ].filter((l): l is string => l !== null);
            await interaction.reply(lines.join("\n"));
            break;
          }
          case "branches": {
            const state = sessions.getState(channelId, guildId);
            const metas = repository
              .listThreadBranchMetaEntries()
              .map((entry) => parseThreadBranchMeta(entry.value))
              .filter((entry): entry is NonNullable<typeof entry> => entry !== null);

            const currentMeta = metas.find((meta) => meta.channelId === channelId);
            const rootChannelId = currentMeta?.rootChannelId ?? channelId;
            const rootChannel = repository.getChannel(rootChannelId);
            const rootWorkingDir = rootChannel?.workingDir ?? state.channel.workingDir;
            const baseBranch = (await detectBranchName(rootWorkingDir)) ?? "main";

            const activeBranches = metas
              .filter(
                (meta) =>
                  meta.rootChannelId === rootChannelId &&
                  (meta.lifecycleState === "active" || typeof meta.lifecycleState === "undefined"),
              )
              .sort((a, b) => a.createdAt - b.createdAt);

            if (activeBranches.length === 0) {
              await interaction.reply(
                `No active thread branches tracked for root \`${rootChannelId}\`.`,
              );
              break;
            }

            const lines = [`**Branches** (base: \`${baseBranch}\`):`];

            for (const meta of activeBranches) {
              let branchPart = "inherited";
              let divergencePart = "";
              let worktreePart = "inherited";
              if (meta.worktreePath && existsSync(meta.worktreePath)) {
                worktreePart = meta.worktreePath;
                const branchName = await detectBranchName(meta.worktreePath);
                if (branchName) {
                  branchPart = `\`${branchName}\``;
                }
                const revList = await runCommand(
                  ["git", "rev-list", "--left-right", "--count", `${baseBranch}...HEAD`],
                  meta.worktreePath,
                );
                if (revList.exitCode === 0) {
                  const counts = parseAheadBehind(revList.output);
                  if (counts) {
                    divergencePart = ` ↑${counts.ahead} ↓${counts.behind}`;
                  }
                }
              } else if (meta.worktreeMode === "prompt") {
                worktreePart = "pending";
              }

              lines.push(`- **${meta.name}** ${branchPart}${divergencePart} @ \`${worktreePart}\``);
            }

            const chunks = chunkDiscordText(lines.join("\n"));
            await interaction.reply(chunks[0] ?? "No active thread branches.");
            for (let i = 1; i < chunks.length; i++) {
              const chunk = chunks[i];
              if (chunk) {
                await interaction.followUp(chunk);
              }
            }
            break;
          }
          case "diff": {
            const state = sessions.getState(channelId, guildId);
            await interaction.deferReply();

            const context = await buildDiffContext({
              channelId,
              guildId,
              workingDir: state.channel.workingDir,
              baseInput: null,
              repository,
            });
            const requestId = crypto.randomUUID();
            rememberDiffView(requestId, context);

            const patchDetail = await buildDiffDetail(context, "patch");
            const delivery = buildDiffDelivery(patchDetail, "diff");
            await interaction.editReply({
              content: delivery.content,
              files: delivery.files,
              components: buildDiffViewButtons(requestId),
            });
            break;
          }
          case "pr": {
            const state = sessions.getState(channelId, guildId);
            const action = interaction.options.getSubcommand(true) as
              | PrCreateAction
              | PrChecksAction
              | PrInspectAction
              | PrMergeAction;
            await interaction.deferReply();

            const ghVersion = await runCommand(["gh", "--version"], state.channel.workingDir);
            if (ghVersion.exitCode !== 0) {
              await interaction.editReply(
                "GitHub CLI (`gh`) is not available. Install it and run `/pr` again.",
              );
              break;
            }

            const headResult = await runCommand(
              ["git", "rev-parse", "--abbrev-ref", "HEAD"],
              state.channel.workingDir,
            );
            if (headResult.exitCode !== 0) {
              await interaction.editReply(
                `Not a git repository: \`${state.channel.workingDir}\`\n` +
                  `\`\`\`bash\n${clipOutput(headResult.output || "(no output)", 1800)}\n\`\`\``,
              );
              break;
            }

            const headBranch = parseGitBranch(headResult.output);
            if (!headBranch) {
              await interaction.editReply(
                "Current repository is in detached HEAD state. Checkout a branch before `/pr`.",
              );
              break;
            }

            if (
              action === "status" ||
              action === "view" ||
              action === "checks" ||
              action === "merge"
            ) {
              const inspectResult = await runCommand(
                [
                  "gh",
                  "pr",
                  "view",
                  headBranch,
                  "--json",
                  "number,title,state,isDraft,url,headRefName,baseRefName,body",
                ],
                state.channel.workingDir,
              );
              if (inspectResult.exitCode !== 0) {
                if (/no pull requests found/i.test(inspectResult.output)) {
                  await interaction.editReply(`No PR found for current branch \`${headBranch}\`.`);
                  break;
                }
                await interaction.editReply(
                  `Failed to inspect PR for \`${headBranch}\`.\n` +
                    `\`\`\`bash\n${clipOutput(inspectResult.output || "(no output)", 1800)}\n\`\`\``,
                );
                break;
              }

              const summary = parsePrSummaryJson(inspectResult.output);
              if (!summary) {
                await interaction.editReply(
                  "Could not parse `gh pr view` response. Try again with a newer `gh` version.",
                );
                break;
              }

              if (action === "status") {
                await interaction.editReply(formatPrStatusLine(summary));
                break;
              }

              if (action === "view") {
                const details = [
                  formatPrStatusLine(summary),
                  `Title: ${summary.title}`,
                  `Body:\n${clipOutput(summary.body?.trim() || "(empty)", 2400)}`,
                ].join("\n\n");
                const chunks = chunkDiscordText(details);
                await interaction.editReply(chunks[0] ?? "(no output)");
                for (let i = 1; i < chunks.length; i++) {
                  const chunk = chunks[i];
                  if (chunk) {
                    await interaction.followUp(chunk);
                  }
                }
                break;
              }

              if (action === "checks") {
                const checksResult = await runCommand(
                  [
                    "gh",
                    "pr",
                    "checks",
                    String(summary.number),
                    "--json",
                    "name,state,workflow,link",
                  ],
                  state.channel.workingDir,
                );

                const parsedChecks = parsePrChecksJson(checksResult.output);
                if (!parsedChecks) {
                  if (checksResult.exitCode !== 0) {
                    await interaction.editReply(
                      `Failed to read checks for PR #${summary.number}.\n` +
                        `\`\`\`bash\n${clipOutput(checksResult.output || "(no output)", 1800)}\n\`\`\``,
                    );
                    break;
                  }
                  await interaction.editReply(
                    `Could not parse check output for PR #${summary.number}.`,
                  );
                  break;
                }

                if (parsedChecks.length === 0) {
                  await interaction.editReply(
                    `No checks reported yet for PR #${summary.number}.\n${summary.url}`,
                  );
                  break;
                }

                const counts = new Map<string, number>();
                for (const check of parsedChecks) {
                  counts.set(check.state, (counts.get(check.state) ?? 0) + 1);
                }
                const summaryLine = Array.from(counts.entries())
                  .sort((a, b) => a[0].localeCompare(b[0]))
                  .map(([stateName, count]) => `${stateName}=${count}`)
                  .join(", ");
                const lines = [
                  `Checks for PR #${summary.number} (\`${summary.headRefName}\` -> \`${summary.baseRefName}\`)`,
                  `Summary: ${summaryLine}`,
                  "",
                  ...parsedChecks.map((check) => {
                    const workflow = check.workflow ? ` [${check.workflow}]` : "";
                    const link = check.link ? ` ${check.link}` : "";
                    return `- ${check.state}: ${check.name}${workflow}${link}`;
                  }),
                ];
                const chunks = chunkDiscordText(lines.join("\n"));
                await interaction.editReply(chunks[0] ?? "(no checks output)");
                for (let i = 1; i < chunks.length; i++) {
                  const chunk = chunks[i];
                  if (chunk) {
                    await interaction.followUp(chunk);
                  }
                }
                break;
              }

              const confirmMerge = interaction.options.getBoolean("confirm", true);
              if (!confirmMerge) {
                await interaction.editReply(
                  "Merge safety check failed. Re-run with `confirm:true` to merge.",
                );
                break;
              }
              if (summary.state !== "OPEN") {
                await interaction.editReply(
                  `Cannot merge PR #${summary.number}: state is \`${summary.state}\` (expected OPEN).`,
                );
                break;
              }
              if (summary.isDraft) {
                await interaction.editReply(
                  `Cannot merge PR #${summary.number}: it is still a draft.`,
                );
                break;
              }

              const dirtyResult = await runCommand(
                ["git", "status", "--porcelain"],
                state.channel.workingDir,
              );
              if (dirtyResult.exitCode === 0 && dirtyResult.output.trim().length > 0) {
                await interaction.editReply(
                  "Working tree has uncommitted changes. Commit or stash before `/pr merge`.",
                );
                break;
              }

              const methodInput = interaction.options.getString("method")?.trim() || "squash";
              if (!["squash", "rebase", "merge"].includes(methodInput)) {
                await interaction.editReply(
                  `Unsupported merge method \`${methodInput}\`. Use squash, rebase, or merge.`,
                );
                break;
              }

              const method = methodInput as PrMergeMethod;
              const deleteBranch = interaction.options.getBoolean("delete_branch") ?? false;
              const admin = interaction.options.getBoolean("admin") ?? false;
              const mergeArgs = buildPrMergeArgs({
                number: summary.number,
                method,
                deleteBranch,
                admin,
              });
              const mergeResult = await runCommand(mergeArgs, state.channel.workingDir);
              if (mergeResult.exitCode !== 0) {
                await interaction.editReply(
                  `Failed to merge PR #${summary.number}.\n` +
                    `\`\`\`bash\n${clipOutput(mergeResult.output || "(no output)", 1800)}\n\`\`\``,
                );
                break;
              }

              await interaction.editReply(
                `Merged PR #${summary.number} with \`${method}\` (${deleteBranch ? "branch deleted" : "branch kept"}).\n${summary.url}`,
              );
              break;
            }

            const baseInput = interaction.options.getString("base")?.trim() || null;
            const titleInput = interaction.options.getString("title")?.trim() || null;
            const bodyInput = interaction.options.getString("body")?.trim() || null;
            const baseBranch =
              baseInput ??
              (await resolvePrBaseBranch({
                channelId,
                workingDir: state.channel.workingDir,
                repository,
              }));
            if (baseBranch === headBranch) {
              await interaction.editReply(
                `Head and base are both \`${headBranch}\`. Use \`/pr base:<branch>\` or switch branches.`,
              );
              break;
            }

            const dirtyResult = await runCommand(
              ["git", "status", "--porcelain"],
              state.channel.workingDir,
            );
            if (dirtyResult.exitCode === 0 && dirtyResult.output.trim().length > 0) {
              await interaction.editReply(
                "Working tree has uncommitted changes. Commit or stash before opening a PR.",
              );
              break;
            }

            const aheadResult = await runCommand(
              ["git", "rev-list", "--count", `${baseBranch}..${headBranch}`],
              state.channel.workingDir,
            );
            if (aheadResult.exitCode === 0) {
              const aheadText = firstOutputLine(aheadResult.output);
              const ahead = Number.parseInt(aheadText, 10);
              if (Number.isFinite(ahead) && ahead <= 0) {
                await interaction.editReply(
                  `No commits ahead of \`${baseBranch}\` on \`${headBranch}\`. Nothing to PR.`,
                );
                break;
              }
            }

            let prArgs: string[];
            try {
              prArgs = buildPrCreateArgs({
                action,
                baseBranch,
                headBranch,
                ...(titleInput ? { title: titleInput } : {}),
                ...(bodyInput ? { body: bodyInput } : {}),
              });
            } catch (error) {
              await interaction.editReply(formatErrorMessage(error));
              break;
            }

            const createResult = await runCommand(prArgs, state.channel.workingDir);
            if (createResult.exitCode !== 0) {
              await interaction.editReply(
                `Failed to create PR (\`${headBranch}\` -> \`${baseBranch}\`).\n` +
                  `\`\`\`bash\n${clipOutput(createResult.output || "(no output)", 1800)}\n\`\`\``,
              );
              break;
            }

            const prUrl = extractFirstUrl(createResult.output);
            const prType = action === "draft" ? "Draft PR" : "PR";
            await interaction.editReply(
              `${prType} created (\`${headBranch}\` -> \`${baseBranch}\`).` +
                (prUrl ? `\n${prUrl}` : ""),
            );
            break;
          }
          case "bash": {
            const command = interaction.options.getString("command", true);
            const state = sessions.getState(channelId, guildId);
            await interaction.deferReply();

            const result = await runBashCommand(command, state.channel.workingDir);
            const outputText = result.output || "(no output)";
            const payload = `\`\`\`bash\n$ ${command}\n${outputText}\n[exit ${result.exitCode}]\n\`\`\``;
            const chunks = chunkDiscordText(payload);
            const firstChunk = chunks[0] ?? "(no output)";
            await interaction.editReply(firstChunk);

            for (let i = 1; i < chunks.length; i++) {
              const chunk = chunks[i];
              if (chunk) {
                await interaction.followUp(chunk);
              }
            }
            break;
          }
          case "screenshot": {
            const state = sessions.getState(channelId, guildId);
            const url = interaction.options.getString("url")?.trim() || "http://localhost:3000";
            const fullPage = interaction.options.getBoolean("full") ?? false;
            await interaction.deferReply();

            const result = await captureScreenshotWithAgentBrowser({
              channelId,
              workingDir: state.channel.workingDir,
              url,
              fullPage,
            });

            if (!result.screenshotPath) {
              const diagnostics = result.output.trim() || "(no output)";
              await interaction.editReply(
                `screenshot failed (exit=${result.exitCode}).\n` +
                  "Make sure `agent-browser` is installed and the target URL is reachable.\n" +
                  `\`\`\`bash\n${clipOutput(diagnostics, 1800)}\n\`\`\``,
              );
              break;
            }

            try {
              await interaction.editReply({
                content: `Screenshot captured from \`${url}\`${fullPage ? " (full page)" : ""}.`,
                files: [{ attachment: result.screenshotPath }],
              });
            } finally {
              await cleanupFiles([result.screenshotPath]);
            }
            break;
          }
          case "project": {
            const state = sessions.getState(channelId, guildId);
            const inputPath = interaction.options.getString("path");
            await interaction.deferReply();

            let selectedPath: string | null = null;
            let sourceDescription = "";

            if (inputPath) {
              selectedPath = resolvePath(inputPath, state.channel.workingDir);
              if (!existsSync(selectedPath)) {
                await interaction.editReply(
                  `Path not found: \`${selectedPath}\`\n\`path\` is resolved relative to current project \`${state.channel.workingDir}\` unless absolute.`,
                );
                break;
              }
              const isDirectory = (() => {
                try {
                  return statSync(selectedPath).isDirectory();
                } catch {
                  return false;
                }
              })();
              if (!isDirectory) {
                await interaction.editReply(
                  `Path is not a directory: \`${selectedPath}\`\nProvide a folder path relative to \`${state.channel.workingDir}\` or absolute.`,
                );
                break;
              }
              const isRelative = !path.isAbsolute(inputPath) && !inputPath.startsWith("~/");
              sourceDescription = isRelative
                ? `from \`${inputPath}\` (resolved relative to \`${state.channel.workingDir}\`)`
                : `from \`${inputPath}\``;
            } else {
              if (process.platform !== "darwin") {
                await interaction.editReply(
                  `Finder picker is only available on macOS. Use \`/project path:<dir>\` (relative to \`${state.channel.workingDir}\` or absolute).`,
                );
                break;
              }
              selectedPath = await pickFolderWithFinder();
              if (!selectedPath) {
                await interaction.editReply("Folder selection cancelled.");
                break;
              }
              sourceDescription = "from Finder picker";
            }

            const requestId = crypto.randomUUID();
            pendingProjectSwitches.set(requestId, {
              channelId,
              guildId,
              workingDir: selectedPath,
            });
            await interaction.editReply({
              content: `Selected project \`${selectedPath}\` ${sourceDescription}. Keep current context or clear it?`,
              components: buildProjectSwitchButtons(requestId),
            });
            break;
          }
          case "model": {
            const model = interaction.options.getString("name", true);
            sessions.setModel(channelId, model);
            await stopController.setModel(channelId, model);
            await interaction.reply(`Model set to \`${model}\`.`);
            break;
          }
          case "systemprompt": {
            const action = interaction.options.getSubcommand(true);

            if (action === "set") {
              const text = interaction.options.getString("text", true).trim();
              if (!text) {
                await interaction.reply({
                  content: "System prompt cannot be empty.",
                  flags: MessageFlags.Ephemeral,
                });
                break;
              }

              repository.setChannelSystemPrompt(channelId, text);
              sessions.setSessionId(channelId, null);
              clearSessionPermissionMode(channelId);
              await interaction.reply(
                `Channel system prompt set (\`${text.length}\` chars). Session restarted for this channel.`,
              );
              break;
            }

            if (action === "show") {
              const text = repository.getChannelSystemPrompt(channelId);
              if (!text) {
                await interaction.reply({
                  content: "No channel system prompt is set.",
                  flags: MessageFlags.Ephemeral,
                });
                break;
              }
              const content = `Channel system prompt (\`${text.length}\` chars):\n\`\`\`\n${text}\n\`\`\``;
              const chunks = chunkDiscordText(content);
              await interaction.reply({
                content: chunks[0] ?? "No channel system prompt is set.",
                flags: MessageFlags.Ephemeral,
              });
              for (let i = 1; i < chunks.length; i++) {
                const chunk = chunks[i];
                if (chunk) {
                  await interaction.followUp({
                    content: chunk,
                    flags: MessageFlags.Ephemeral,
                  });
                }
              }
              break;
            }

            repository.clearChannelSystemPrompt(channelId);
            sessions.setSessionId(channelId, null);
            clearSessionPermissionMode(channelId);
            await interaction.reply(
              "Channel system prompt cleared. Session restarted for this channel.",
            );
            break;
          }
          case "mentions": {
            const action = interaction.options.getSubcommand(true);

            if (action === "set") {
              const modeRaw = interaction.options.getString("mode", true).trim().toLowerCase();
              if (modeRaw !== "default" && modeRaw !== "required" && modeRaw !== "off") {
                await interaction.reply({
                  content: "Invalid mode. Use one of: `default`, `required`, `off`.",
                  flags: MessageFlags.Ephemeral,
                });
                break;
              }
              const mode = modeRaw as ChannelMentionsMode;
              repository.setChannelMentionsMode(channelId, mode);
              const effective = resolveMentionRequirementForChannel({
                repository,
                channelId,
                defaultRequireMention: config.requireMentionInMultiUserChannels,
              });
              await interaction.reply(
                `Mentions mode for this channel set to \`${mode}\` (effective: \`${effective.requireMention ? "required" : "off"}\`).`,
              );
              break;
            }

            if (action === "show") {
              const effective = resolveMentionRequirementForChannel({
                repository,
                channelId,
                defaultRequireMention: config.requireMentionInMultiUserChannels,
              });
              const globalDefault = config.requireMentionInMultiUserChannels ? "required" : "off";
              await interaction.reply({
                content:
                  `Mentions mode: \`${effective.mode}\`\n` +
                  `Effective policy: \`${effective.requireMention ? "required" : "off"}\`\n` +
                  `Global default: \`${globalDefault}\``,
                flags: MessageFlags.Ephemeral,
              });
              break;
            }

            repository.clearChannelMentionsMode(channelId);
            const effective = resolveMentionRequirementForChannel({
              repository,
              channelId,
              defaultRequireMention: config.requireMentionInMultiUserChannels,
            });
            await interaction.reply(
              `Mentions mode override cleared (effective: \`${effective.requireMention ? "required" : "off"}\`).`,
            );
            break;
          }
          case "mode": {
            const action = interaction.options.getSubcommand(true);
            const allowedModes = new Set([
              "default",
              "plan",
              "acceptEdits",
              "bypassPermissions",
              "delegate",
              "dontAsk",
            ]);

            if (action === "set") {
              const modeRaw = interaction.options.getString("mode", true).trim();
              if (!allowedModes.has(modeRaw)) {
                await interaction.reply({
                  content:
                    "Invalid mode. Use one of: `default`, `plan`, `acceptEdits`, `bypassPermissions`, `delegate`, `dontAsk`.",
                  flags: MessageFlags.Ephemeral,
                });
                break;
              }

              const mode = modeRaw as ClaudePermissionMode | "default";
              setSessionPermissionMode(channelId, mode);
              const effective = resolvePermissionModeForSession(channelId);
              await interaction.reply(
                `Permission mode for this session set to \`${mode}\` (effective: \`${effective.permissionMode}\`).`,
              );
              break;
            }

            if (action === "show") {
              const effective = resolvePermissionModeForSession(channelId);
              await interaction.reply({
                content:
                  `Permission mode: \`${effective.mode}\`\n` +
                  `Effective mode: \`${effective.permissionMode}\`\n` +
                  `Global default: \`${config.claudePermissionMode}\``,
                flags: MessageFlags.Ephemeral,
              });
              break;
            }

            clearSessionPermissionMode(channelId);
            const effective = resolvePermissionModeForSession(channelId);
            await interaction.reply(
              `Session permission mode override cleared (effective: \`${effective.permissionMode}\`).`,
            );
            break;
          }
          case "cost": {
            const totalCost = repository.getChannelCostTotal(channelId);
            const totalTurns = repository.getChannelTurnCount(channelId);
            await interaction.reply(
              `Channel spend: \`$${totalCost.toFixed(4)}\` across \`${totalTurns}\` turns.`,
            );
            break;
          }
          case "worktree": {
            const state = sessions.getState(channelId, guildId);
            const action = interaction.options.getSubcommand(true);
            const inputPath = interaction.options.getString("path");
            const branch = interaction.options.getString("branch");
            await interaction.deferReply();

            if (action === "list") {
              const result = await runCommand(
                ["git", "worktree", "list"],
                state.channel.workingDir,
              );
              const text = result.output || "(no output)";
              const payload = `\`\`\`bash\n${text}\n\`\`\``;
              const chunks = chunkDiscordText(payload);
              await interaction.editReply(chunks[0] ?? "(no output)");
              for (let i = 1; i < chunks.length; i++) {
                const chunk = chunks[i];
                if (chunk) {
                  await interaction.followUp(chunk);
                }
              }
              break;
            }

            if (action === "thread") {
              const meta = parseThreadBranchMeta(repository.getThreadBranchMeta(channelId));
              if (!meta) {
                await interaction.editReply(
                  "No thread branch metadata found for this channel. Use this action inside a tracked thread.",
                );
                break;
              }

              const parentChannelId = meta.parentChannelId ?? meta.rootChannelId;
              const parentChannel = repository.getChannel(parentChannelId);
              const parentWorkingDir = parentChannel?.workingDir ?? state.channel.workingDir;
              const provisioned = await maybeProvisionThreadWorktree({
                enabled: true,
                parentWorkingDir,
                threadChannelId: channelId,
                threadName: meta.name,
              });

              if (!provisioned) {
                await interaction.editReply(
                  `Failed to provision thread worktree from \`${parentWorkingDir}\`.`,
                );
                break;
              }

              let setupSummary = "";
              if (provisioned.created) {
                const setupResult = await runWorktreeBootstrap({
                  enabled: config.worktreeBootstrap,
                  customCommand: config.worktreeBootstrapCommand,
                  workingDir: provisioned.worktreePath,
                  runCommand,
                });
                setupSummary = `\n${buildWorktreeBootstrapSummary(setupResult)}`;
              }

              sessions.switchProject(channelId, guildId, provisioned.worktreePath);
              sessions.setSessionId(channelId, null);
              clearSessionPermissionMode(channelId);
              saveThreadBranchMeta(repository, {
                ...meta,
                worktreePath: provisioned.worktreePath,
                worktreeMode: "worktree",
                lifecycleState: meta.lifecycleState ?? "active",
                cleanupState: "none",
              });
              void syncChannelTopic(interaction.channel, provisioned.worktreePath);
              await interaction.editReply(
                `Thread switched to dedicated worktree \`${provisioned.worktreePath}\` (session restarted).${setupSummary}`,
              );
              break;
            }

            if (action === "create") {
              let resolvedPath: string;
              let result: { exitCode: number; output: string };

              if (inputPath) {
                resolvedPath = resolvePath(inputPath, state.channel.workingDir);
                const cmd = ["git", "worktree", "add", resolvedPath];
                if (branch) {
                  cmd.push(branch);
                }
                result = await runCommand(cmd, state.channel.workingDir);
              } else {
                const autoTarget = await buildAutoWorktreeTarget({
                  baseWorkingDir: state.channel.workingDir,
                  channelId,
                  branchHint: branch,
                });
                if (!autoTarget) {
                  await interaction.editReply(
                    `Failed to resolve repository root from \`${state.channel.workingDir}\`.`,
                  );
                  break;
                }

                resolvedPath = autoTarget.worktreePath;
                result = await runCommand(
                  ["git", "worktree", "add", resolvedPath, "-b", autoTarget.branchName],
                  state.channel.workingDir,
                );
                if (result.exitCode !== 0 && /already exists/i.test(result.output)) {
                  result = await runCommand(
                    ["git", "worktree", "add", resolvedPath, autoTarget.branchName],
                    state.channel.workingDir,
                  );
                }
              }
              const output = result.output || "(no output)";
              let setupSummary = "setup skipped (worktree creation failed)";
              if (result.exitCode === 0) {
                const setupResult = await runWorktreeBootstrap({
                  enabled: config.worktreeBootstrap,
                  customCommand: config.worktreeBootstrapCommand,
                  workingDir: resolvedPath,
                  runCommand,
                });
                setupSummary = buildWorktreeBootstrapSummary(setupResult);
              }
              await interaction.editReply(
                `worktree create path=\`${resolvedPath}\` exit=${result.exitCode}\n` +
                  `${setupSummary}\n` +
                  `\`\`\`bash\n${output}\n\`\`\``,
              );
              break;
            }

            if (action === "remove") {
              const resolvedPath = inputPath
                ? resolvePath(inputPath, state.channel.workingDir)
                : state.channel.workingDir;
              const result = await runCommand(
                ["git", "worktree", "remove", resolvedPath],
                state.channel.workingDir,
              );
              const output = result.output || "(no output)";
              await interaction.editReply(
                `worktree remove path=\`${resolvedPath}\` exit=${result.exitCode}\n\`\`\`bash\n${output}\n\`\`\``,
              );
              break;
            }

            await interaction.editReply(`Unsupported worktree action: ${action}`);
            break;
          }
          case "kill": {
            if (
              !interaction.channel ||
              !(
                typeof interaction.channel.isThread === "function" && interaction.channel.isThread()
              )
            ) {
              await interaction.reply({
                content: "The `/kill` command only works inside a thread.",
                flags: MessageFlags.Ephemeral,
              });
              break;
            }

            await interaction.deferReply({ flags: MessageFlags.Ephemeral });

            const thread = interaction.channel;

            // Hard-abort any active Claude query before archiving.
            stopController.abort(channelId);

            // Prefix the thread name with 🔴 (idempotent: skip if already present).
            const currentName = thread.name;
            const newName = (
              currentName.startsWith("🔴") ? currentName : `🔴 ${currentName}`
            ).slice(0, 100);

            const wasAlreadyArchived = thread.archived ?? false;

            // Rename + archive in one call → fires threadUpdate → onThreadLifecycle
            // handles suspendedChannels + session reset + metadata update automatically.
            await thread.edit({ name: newName, archived: true });

            const statusNote = wasAlreadyArchived ? " (was already archived)" : "";
            await interaction.editReply(`Killed and archived \`${newName}\`.${statusNote}`);
            break;
          }
          default: {
            await interaction.reply({
              content: "Command not implemented.",
              flags: MessageFlags.Ephemeral,
            });
            break;
          }
        }
      },
      onUserMessage: async (message) => {
        const channelId = message.channel.id;
        if (suspendedChannels.has(channelId)) {
          return;
        }
        const channelSendTarget = canSendMessage(message.channel) ? message.channel : null;
        const queueChannelMessage = async (
          payload: Parameters<typeof message.reply>[0],
        ): Promise<Awaited<ReturnType<typeof message.reply>>> => {
          return await discordDispatch.enqueue(
            `channel:${channelId}`,
            async () => await message.reply(payload),
          );
        };
        const queueChannelSend = async (payload: unknown): Promise<unknown | null> => {
          if (!channelSendTarget) {
            return null;
          }
          return await discordDispatch.enqueue(
            `channel:${channelId}`,
            async () => await channelSendTarget.send(payload),
          );
        };

        // Track steer info so the user can inject this message mid-run via "Send Now"
        let steerInfo: { text: string; cancelled: boolean } | null = null;
        let steerNoticeMessageId: string | null = null;

        const wasQueued = pendingMessageRunsByChannel.has(channelId);
        if (wasQueued) {
          steerInfo = { text: getMessagePrompt(message), cancelled: false };
          try {
            const noticeMsg = await queueChannelMessage({
              content: "⏳ Run in progress for this channel. Queued your message.",
              components: buildQueueNoticeButtons(channelId, message.author.id),
            });
            steerNoticeMessageId = noticeMsg.id;
            queuedNoticesByMessageId.set(noticeMsg.id, steerInfo);
          } catch {
            // Ignore queue notice failures.
          }
        }

        const previousRun = pendingMessageRunsByChannel.get(channelId) ?? Promise.resolve();
        const run = previousRun
          .catch(() => undefined)
          .then(async () => {
            // Clean up steer tracking entry whether cancelled or not
            if (steerNoticeMessageId) {
              queuedNoticesByMessageId.delete(steerNoticeMessageId);
            }
            // If "Send Now" was clicked, the message was already injected — skip normal execution
            if (steerInfo?.cancelled) {
              return;
            }
            if (suspendedChannels.has(channelId)) {
              return;
            }
            if (shuttingDown) {
              try {
                await queueChannelMessage("⚠️ Bot is shutting down. Please retry in a moment.");
              } catch {
                // Ignore reply failures while shutting down.
              }
              return;
            }

            const guildId = message.guildId ?? "dm";
            await maybeInheritThreadContext({
              channel: message.channel,
              channelId,
              guildId,
              sessions,
              repository,
              autoThreadWorktree: config.autoThreadWorktree,
              worktreeBootstrap: config.worktreeBootstrap,
              worktreeBootstrapCommand: config.worktreeBootstrapCommand,
            });
            const state = sessions.getState(channelId, guildId);
            const directBash = parseDirectBashCommand(message.content);
            if (directBash !== null) {
              if (!directBash) {
                await queueChannelMessage(
                  "Direct shell mode expects a command after `!` (example: `!git status`).",
                );
                return;
              }

              const result = await runBashCommand(directBash, state.channel.workingDir);
              const outputText = result.output || "(no output)";
              const payload = `\`\`\`bash\n$ ${directBash}\n${outputText}\n[exit ${result.exitCode}]\n\`\`\``;
              const chunks = chunkDiscordText(payload);
              const firstChunk = chunks[0] ?? "(no output)";
              await queueChannelMessage(firstChunk);
              for (let i = 1; i < chunks.length; i++) {
                const chunk = chunks[i];
                if (chunk) {
                  await queueChannelSend(chunk);
                }
              }
              return;
            }
            const channelSystemPrompt = repository.getChannelSystemPrompt(channelId);
            const pendingMergeContext = repository.getMergeContext(channelId);
            const stagedAttachments = await stageAttachments(message);
            const threadBranchEntries = repository.listThreadBranchMetaEntries();
            const threadBranchContext = buildThreadBranchAwarenessPrompt({
              currentChannelId: channelId,
              entries: threadBranchEntries,
            });
            const threadMeta = parseThreadBranchMeta(repository.getThreadBranchMeta(channelId));
            const forkSourceSessionId =
              !state.channel.sessionId && threadMeta?.forkSourceSessionId
                ? threadMeta.forkSourceSessionId
                : undefined;
            const resumeSessionId = state.channel.sessionId ?? forkSourceSessionId;
            const shouldForkSession = Boolean(forkSourceSessionId && !state.channel.sessionId);
            const runToolTrace = createLiveToolTrace();
            liveToolTracesByChannel.set(channelId, runToolTrace);
            liveToolExpandStateByChannel.set(channelId, new Map());

            await addReaction(message, "🧠");
            await setThreadState(message.channel, null); // strip any stale state prefix — agent is working
            const status = await discordDispatch.enqueue(`channel:${channelId}`, async () => {
              return await message.reply({
                content: toStreamingPreview("", "", THINKING_SPINNER_FRAMES[0]),
                components: buildStopButtons(channelId),
              });
            });
            const mergeContextPrefix = pendingMergeContext
              ? `${buildMergeContextInjection(pendingMergeContext)}\n\n`
              : "";
            const prompt = `${mergeContextPrefix}${threadBranchContext}${getMessagePrompt(message)}${stagedAttachments.promptSuffix}`;
            const seededPrompt = buildSeededPrompt(prompt, state.history, Boolean(resumeSessionId));
            const resumeFallbackPrompt = resumeSessionId
              ? buildSeededPrompt(prompt, state.history, false)
              : undefined;
            const abortController = new AbortController();
            const persistedFilenames = new Set<string>();
            let streamedText = "";
            let streamedThinking = "";
            let streamClosed = false;
            let streamFlushTimer: ReturnType<typeof setTimeout> | null = null;
            let streamSpinnerTimer: ReturnType<typeof setInterval> | null = null;
            let streamToolRenderTimer: ReturnType<typeof setInterval> | null = null;
            let streamSpinnerFrameIndex = 0;
            let statusEditQueue: Promise<void> = Promise.resolve();
            let statusEditInFlight = false;
            let pendingStatusEdit: { content: string; includeButtons: boolean } | null = null;
            const toolSendTarget = canSendMessage(message.channel) ? message.channel : null;
            const toolMessagesById = new Map<string, EditableSentMessage>();
            const pendingToolMessageContent = new Map<string, LiveToolRenderPayload>();
            const toolMessageEditInFlight = new Set<string>();

            const queueStatusEdit = (content: string, includeButtons: boolean): Promise<void> => {
              pendingStatusEdit = { content, includeButtons };
              if (statusEditInFlight) {
                return statusEditQueue;
              }

              statusEditInFlight = true;
              statusEditQueue = (async () => {
                while (pendingStatusEdit) {
                  const edit = pendingStatusEdit;
                  pendingStatusEdit = null;
                  try {
                    await discordDispatch.enqueue(`status:${channelId}`, async () => {
                      await status.edit({
                        content: edit.content,
                        components: edit.includeButtons ? buildStopButtons(channelId) : [],
                      });
                    });
                  } catch {
                    // Ignore transient edit failures to keep stream moving.
                  }
                }
                statusEditInFlight = false;
              })();
              return statusEditQueue;
            };

            const flushStreamPreview = () => {
              streamFlushTimer = null;
              if (streamClosed) {
                return;
              }
              void queueStatusEdit(
                toStreamingPreview(
                  streamedText,
                  streamedThinking,
                  THINKING_SPINNER_FRAMES[streamSpinnerFrameIndex % THINKING_SPINNER_FRAMES.length],
                ),
                true,
              );
            };

            const scheduleStreamPreview = () => {
              if (streamClosed || streamFlushTimer) {
                return;
              }
              streamFlushTimer = setTimeout(flushStreamPreview, 300);
            };

            const stopSpinner = () => {
              if (!streamSpinnerTimer) {
                return;
              }
              clearInterval(streamSpinnerTimer);
              streamSpinnerTimer = null;
            };

            const stopToolRenderTimer = () => {
              if (!streamToolRenderTimer) {
                return;
              }
              clearInterval(streamToolRenderTimer);
              streamToolRenderTimer = null;
            };

            streamSpinnerTimer = setInterval(() => {
              if (streamClosed) {
                return;
              }
              streamSpinnerFrameIndex =
                (streamSpinnerFrameIndex + 1) % THINKING_SPINNER_FRAMES.length;
              void queueStatusEdit(
                toStreamingPreview(
                  streamedText,
                  streamedThinking,
                  THINKING_SPINNER_FRAMES[streamSpinnerFrameIndex % THINKING_SPINNER_FRAMES.length],
                ),
                true,
              );
            }, 900);

            streamToolRenderTimer = setInterval(() => {
              if (streamClosed) {
                return;
              }
              for (const toolId of runToolTrace.order) {
                const entry = runToolTrace.byId.get(toolId);
                if (!entry) {
                  continue;
                }
                if (entry.status === "running" || entry.status === "queued") {
                  queueToolMessageRender(toolId);
                }
              }
            }, 1000);

            const queueToolMessageRender = (toolId: string) => {
              const entry = runToolTrace.byId.get(toolId);
              if (!entry || !toolSendTarget) {
                return;
              }
              pendingToolMessageContent.set(
                toolId,
                buildSingleLiveToolMessage(entry, {
                  channelId,
                  expanded: getToolExpanded(channelId, toolId),
                }),
              );
              if (toolMessageEditInFlight.has(toolId)) {
                return;
              }
              toolMessageEditInFlight.add(toolId);
              void (async () => {
                while (pendingToolMessageContent.has(toolId)) {
                  const nextContent = pendingToolMessageContent.get(toolId);
                  pendingToolMessageContent.delete(toolId);
                  if (!nextContent) {
                    continue;
                  }
                  try {
                    const existing = toolMessagesById.get(toolId);
                    if (existing) {
                      await discordDispatch.enqueue(`tool:${channelId}:${toolId}`, async () => {
                        await existing.edit(nextContent);
                      });
                    } else {
                      const sent = await discordDispatch.enqueue(
                        `tool:${channelId}:${toolId}`,
                        async () => await toolSendTarget.send(nextContent),
                      );
                      if (canEditSentMessage(sent)) {
                        toolMessagesById.set(toolId, sent);
                      }
                    }
                  } catch {
                    // Ignore tool message send/edit failures to keep primary run stable.
                  }
                }
                toolMessageEditInFlight.delete(toolId);
              })();
            };

            try {
              sessions.appendTurn(channelId, {
                role: "user",
                content: buildStoredUserTurnContent(message),
              });
              const permissionPolicy = resolvePermissionModeForSession(channelId);

              const result = await runner.run({
                channelId,
                prompt: seededPrompt,
                ...(resumeFallbackPrompt ? { resumeFallbackPrompt } : {}),
                cwd: state.channel.workingDir,
                ...(resumeSessionId ? { sessionId: resumeSessionId } : {}),
                ...(shouldForkSession ? { forkSession: true } : {}),
                model: state.channel.model,
                systemPrompt: channelSystemPrompt ?? undefined,
                permissionMode: permissionPolicy.permissionMode,
                abortController,
                onQueryStart: (query) => {
                  stopController.register(channelId, { query, abortController });
                },
                onTextDelta: (textDelta) => {
                  streamedText += textDelta;
                  scheduleStreamPreview();
                },
                onThinkingDelta: (thinkingDelta) => {
                  streamedThinking += thinkingDelta;
                  scheduleStreamPreview();
                },
                onMessage: (sdkMessage) => {
                  if (sdkMessage.type === "system" && sdkMessage.subtype === "files_persisted") {
                    for (const file of sdkMessage.files) {
                      persistedFilenames.add(file.filename);
                    }
                  }
                  if (applyToolMessageToTrace(runToolTrace, sdkMessage)) {
                    for (const toolId of collectToolIdsFromMessage(runToolTrace, sdkMessage)) {
                      queueToolMessageRender(toolId);
                    }
                  }
                },
              });

              if (streamFlushTimer) {
                clearTimeout(streamFlushTimer);
                streamFlushTimer = null;
              }
              stopSpinner();
              stopToolRenderTimer();
              streamClosed = true;
              await statusEditQueue;

              if (result.sessionId) {
                sessions.setSessionId(channelId, result.sessionId);
                if (threadMeta?.forkSourceSessionId) {
                  const restMeta = { ...threadMeta, forkSourceSessionId: undefined };
                  saveThreadBranchMeta(repository, restMeta);
                }
              }

              // One-shot: clear pending merge context after it has been consumed
              if (pendingMergeContext) {
                repository.clearMergeContext(channelId);
              }

              const outputText = result.text.trim();
              const structuredAttachments = extractStructuredAttachmentDirectives(outputText);
              const cleanedOutputText = structuredAttachments.cleanedText.trim();
              const interrupted = stopController.wasInterrupted(channelId);
              finalizeLiveToolTrace(runToolTrace, interrupted ? "interrupted" : "success");
              for (const toolId of runToolTrace.order) {
                queueToolMessageRender(toolId);
              }
              const finalText =
                cleanedOutputText.length > 0
                  ? cleanedOutputText
                  : structuredAttachments.filenames.length > 0
                    ? "Attached generated file(s)."
                    : interrupted
                      ? "Interrupted."
                      : "(No response text)";
              sessions.appendTurn(channelId, {
                role: "assistant",
                content: finalText,
              });

              const finalPreview = toStreamingPreview(finalText, streamedThinking);
              await discordDispatch.enqueue(`status:${channelId}`, async () => {
                await status.edit({
                  content: finalPreview,
                  components: [],
                });
              });

              if (finalPreview.includes("...[truncated live preview]...")) {
                const chunks = chunkDiscordText(finalText);
                for (const chunk of chunks) {
                  if (chunk) {
                    await queueChannelSend(chunk);
                  }
                }
              }

              const attachmentChannel = channelSendTarget
                ? {
                    send: async (payload: unknown) => {
                      return await discordDispatch.enqueue(
                        `channel:${channelId}`,
                        async () => await channelSendTarget.send(payload),
                      );
                    },
                  }
                : message.channel;

              await sendGeneratedFilesToChannel({
                channel: attachmentChannel,
                workingDir: state.channel.workingDir,
                filenames: new Set([
                  ...persistedFilenames,
                  ...structuredAttachments.filenames,
                  ...extractAttachmentPathCandidates(outputText),
                ]),
              });

              await removeReaction(message, "🧠");
              await addReaction(message, "✅");
              await setThreadState(message.channel, "⚠️"); // agent responded — needs your attention
            } catch (error) {
              if (streamFlushTimer) {
                clearTimeout(streamFlushTimer);
                streamFlushTimer = null;
              }
              stopSpinner();
              stopToolRenderTimer();
              streamClosed = true;
              await statusEditQueue;
              finalizeLiveToolTrace(
                runToolTrace,
                stopController.wasInterrupted(channelId) ? "interrupted" : "failed",
              );
              for (const toolId of runToolTrace.order) {
                queueToolMessageRender(toolId);
              }

              const msg = error instanceof Error ? error.message : "Unknown failure";
              await discordDispatch.enqueue(`status:${channelId}`, async () => {
                await status.edit({
                  content: `❌ ${msg}`,
                  components: [],
                });
              });
              await removeReaction(message, "🧠");
              await addReaction(message, "❌");
              await setThreadState(message.channel, "❌"); // agent errored — needs attention
            } finally {
              stopSpinner();
              stopToolRenderTimer();
              await cleanupFiles(stagedAttachments.stagedPaths);
              stopController.clear(channelId);
            }
          });

        pendingMessageRunsByChannel.set(channelId, run);
        try {
          await run;
        } finally {
          if (pendingMessageRunsByChannel.get(channelId) === run) {
            pendingMessageRunsByChannel.delete(channelId);
          }
        }
      },
    });
    startStaleRunWatchdog();
  } catch (error) {
    await shutdown("startup error");
    throw error;
  }

  if (installSignalHandlers) {
    const onSigint = () => {
      void shutdown("SIGINT").finally(() => process.exit(0));
    };
    const onSigterm = () => {
      void shutdown("SIGTERM").finally(() => process.exit(0));
    };
    process.once("SIGINT", onSigint);
    process.once("SIGTERM", onSigterm);
  }
}
