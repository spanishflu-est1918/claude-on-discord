import { existsSync, statSync } from "node:fs";
import { mkdir, readdir, readFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { AttachmentBuilder, type Message, MessageFlags } from "discord.js";
import { ClaudeRunner } from "./claude/runner";
import { SessionManager } from "./claude/session";
import { StopController } from "./claude/stop";
import type { AppConfig } from "./config";
import { type ChannelMentionsMode, Repository } from "./db/repository";
import { openDatabase } from "./db/schema";
import {
  buildDiffViewButtons,
  buildProjectSwitchButtons,
  buildQueueDismissButtons,
  buildStopButtons,
  buildThreadCleanupButtons,
  buildThreadWorktreeChoiceButtons,
  parseDiffViewCustomId,
  parseProjectSwitchCustomId,
  parseQueueDismissCustomId,
  parseRunControlCustomId,
  parseThreadCleanupCustomId,
  parseThreadWorktreeChoiceCustomId,
  parseToolInspectCustomId,
} from "./discord/buttons";
import { chunkDiscordText } from "./discord/chunker";
import { startDiscordClient } from "./discord/client";
import { registerSlashCommands } from "./discord/commands";
import { buildDiffDelivery } from "./discord/diff-delivery";
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
import type { ClaudeSDKMessage } from "./types";

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

function canSetTopic(channel: unknown): channel is TopicChannel {
  return (
    typeof channel === "object" &&
    channel !== null &&
    "setTopic" in channel &&
    typeof (channel as TopicChannel).setTopic === "function"
  );
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

function canSendMessage(channel: unknown): channel is SendableChannel {
  return (
    typeof channel === "object" &&
    channel !== null &&
    "send" in channel &&
    typeof (channel as SendableChannel).send === "function"
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
  summary?: string;
  elapsedSeconds?: number;
  startedAtMs: number;
  updatedAtMs: number;
  completedAtMs?: number;
};

type LiveToolTrace = {
  order: string[];
  byId: Map<string, LiveToolEntry>;
};

function createLiveToolTrace(): LiveToolTrace {
  return {
    order: [],
    byId: new Map<string, LiveToolEntry>(),
  };
}

function clipText(value: string, maxChars: number): string {
  const trimmed = value.replace(/\s+/g, " ").trim();
  if (trimmed.length <= maxChars) {
    return trimmed;
  }
  return `${trimmed.slice(0, Math.max(0, maxChars - 3))}...`;
}

function stringifyToolInput(input: unknown): string | undefined {
  if (typeof input === "undefined") {
    return undefined;
  }
  if (typeof input === "string") {
    return clipText(input, 90);
  }
  try {
    return clipText(JSON.stringify(input), 90);
  } catch {
    return undefined;
  }
}

function ensureLiveToolEntry(
  trace: LiveToolTrace,
  input: { id: string; name?: string; inputPreview?: string },
): LiveToolEntry {
  const existing = trace.byId.get(input.id);
  if (existing) {
    if (input.name) {
      existing.name = input.name;
    }
    if (input.inputPreview) {
      existing.inputPreview = input.inputPreview;
    }
    existing.updatedAtMs = Date.now();
    return existing;
  }

  const created: LiveToolEntry = {
    id: input.id,
    name: input.name ?? "tool",
    status: "queued",
    inputPreview: input.inputPreview,
    startedAtMs: Date.now(),
    updatedAtMs: Date.now(),
  };
  trace.byId.set(input.id, created);
  trace.order.push(input.id);
  return created;
}

function extractToolStartFromStreamEvent(
  message: ClaudeSDKMessage,
): { id: string; name?: string; inputPreview?: string } | null {
  if (message.type !== "stream_event") {
    return null;
  }
  const event = message.event as {
    type?: string;
    content_block?: {
      type?: string;
      id?: string;
      tool_use_id?: string;
      name?: string;
      input?: unknown;
    };
  };
  if (event.type !== "content_block_start") {
    return null;
  }
  const block = event.content_block;
  if (!block || block.type !== "tool_use") {
    return null;
  }
  const id = block.id ?? block.tool_use_id;
  if (!id) {
    return null;
  }
  return {
    id,
    name: block.name,
    inputPreview: stringifyToolInput(block.input),
  };
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
    entry.updatedAtMs = now;
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
    entry.updatedAtMs = now;
  }

  if (message.type === "tool_use_summary") {
    for (const toolUseId of message.preceding_tool_use_ids) {
      const entry = ensureLiveToolEntry(trace, {
        id: toolUseId,
      });
      entry.summary = clipText(message.summary, 120);
      entry.status = "done";
      entry.completedAtMs = now;
      entry.updatedAtMs = now;
      changed = true;
    }
  }

  if (message.type === "result" && message.is_error) {
    for (const entry of trace.byId.values()) {
      if (entry.status === "queued" || entry.status === "running") {
        entry.status = "failed";
        entry.completedAtMs = now;
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

function buildLiveToolPanel(trace: LiveToolTrace, maxLines = 5): string | null {
  const allEntries = trace.order
    .map((id) => trace.byId.get(id))
    .filter((entry): entry is LiveToolEntry => Boolean(entry));
  if (allEntries.length === 0) {
    return null;
  }

  const running = allEntries.filter(
    (entry) => entry.status === "running" || entry.status === "queued",
  );
  const finished = allEntries.filter(
    (entry) => entry.status !== "running" && entry.status !== "queued",
  );
  const selected = [
    ...running.slice(-maxLines),
    ...finished.slice(-(maxLines - Math.min(maxLines, running.length))),
  ].slice(-maxLines);

  const lines = selected.map((entry) => {
    const elapsed = formatElapsedSeconds(entry);
    const descriptor = entry.summary ?? entry.inputPreview;
    const tokens = [
      `${toolStatusIcon(entry.status)} ${entry.name}`,
      elapsed ? `(${elapsed})` : "",
      descriptor ? `- ${clipText(descriptor, 70)}` : "",
    ].filter(Boolean);
    return tokens.join(" ");
  });

  const hidden = allEntries.length - selected.length;
  if (hidden > 0) {
    lines.push(`... +${hidden} more tool call(s)`);
  }
  return ["Tools:", ...lines].join("\n");
}

function buildLiveToolDetails(trace: LiveToolTrace, maxChars = 1800): string {
  const entries = trace.order
    .map((id) => trace.byId.get(id))
    .filter((entry): entry is LiveToolEntry => Boolean(entry));
  if (entries.length === 0) {
    return "No tool calls captured yet for this channel.";
  }

  const lines: string[] = ["Tool Calls:"];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (!entry) {
      continue;
    }
    const elapsed = formatElapsedSeconds(entry);
    const header = `${index + 1}. ${toolStatusIcon(entry.status)} ${entry.name} [${entry.id.slice(0, 10)}]${
      elapsed ? ` (${elapsed})` : ""
    }`;
    lines.push(header);
    if (entry.inputPreview) {
      lines.push(`   input: ${entry.inputPreview}`);
    }
    if (entry.summary) {
      lines.push(`   summary: ${entry.summary}`);
    }
  }

  const joined = lines.join("\n");
  if (joined.length <= maxChars) {
    return joined;
  }
  return `${joined.slice(0, Math.max(0, maxChars - 27))}\n...[truncated tool details]...`;
}

function toStreamingPreview(
  text: string,
  thinking: string,
  toolPanel?: string | null,
  maxChars = 1800,
): string {
  const trimmedText = text.trim();
  const trimmedThinking = thinking.trim();
  if (!trimmedText && !trimmedThinking && !toolPanel) {
    return "_Thinking..._";
  }

  const parts: string[] = [];
  if (trimmedThinking) {
    parts.push(`_Thinking_\n${trimmedThinking}`);
  } else if (!trimmedText) {
    parts.push("_Thinking..._");
  }
  if (toolPanel) {
    parts.push(toolPanel);
  }
  if (trimmedText) {
    if (trimmedThinking || toolPanel) {
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
  });
  const stopController = new StopController();
  const runner = runtimeOverrides.createRunner?.() ?? new ClaudeRunner();
  const pendingProjectSwitches = new Map<
    string,
    { channelId: string; guildId: string; workingDir: string }
  >();
  const pendingDiffViews = new Map<string, DiffContext>();
  const pendingMessageRunsByChannel = new Map<string, Promise<void>>();
  const liveToolTracesByChannel = new Map<string, LiveToolTrace>();
  let shuttingDown = false;
  let shutdownPromise: Promise<void> | null = null;
  let discordClient: Awaited<ReturnType<typeof startDiscordClient>> | null = null;

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
    }
    const aborted = stopController.abortAll();
    console.warn(`Cleared ${aborted.length} active run(s) due to ${reason}.`);
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
      clearActiveRunsWithSessionReset(`shutdown:${reason}`);
      if ("closeAll" in runner && typeof runner.closeAll === "function") {
        runner.closeAll();
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
          await target.send({
            content:
              `Thread \`${event.threadName}\` was ${statusVerb}.\n` +
              `Worktree \`${updatedMeta.worktreePath}\` still exists. Keep it or remove it now?`,
            components: buildThreadCleanupButtons(event.threadId),
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

        const queueDismiss = parseQueueDismissCustomId(interaction.customId);
        if (queueDismiss) {
          if (interaction.channelId !== queueDismiss.channelId) {
            await interaction.reply({
              content: "This queue notice belongs to a different channel.",
              flags: MessageFlags.Ephemeral,
            });
            return;
          }
          if (interaction.user.id !== queueDismiss.userId) {
            await interaction.reply({
              content: "Only the queued user can dismiss this notice.",
              flags: MessageFlags.Ephemeral,
            });
            return;
          }

          await interaction.deferUpdate();
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

        const toolInspect = parseToolInspectCustomId(interaction.customId);
        if (toolInspect) {
          if (interaction.channelId !== toolInspect.channelId) {
            await interaction.reply({
              content: "This tools panel belongs to a different channel.",
              flags: MessageFlags.Ephemeral,
            });
            return;
          }

          const trace = liveToolTracesByChannel.get(toolInspect.channelId);
          await interaction.reply({
            content: trace
              ? buildLiveToolDetails(trace)
              : "No tool calls captured yet for this channel.",
            flags: MessageFlags.Ephemeral,
          });
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
            await interaction.reply("Session reset for this channel.");
            break;
          }
          case "compact": {
            const state = sessions.getState(channelId, guildId);
            const summary = compactHistory(state.history);
            sessions.resetSession(channelId);
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
            const threadStatusLines = buildThreadBranchStatusLines({
              currentChannelId: channelId,
              entries: repository.listThreadBranchMetaEntries(),
            });
            const lines = [
              `Project: \`${state.channel.workingDir}\``,
              `Model: \`${state.channel.model}\``,
              `Session: ${state.channel.sessionId ? `\`${state.channel.sessionId}\`` : "none"}`,
              `System prompt: ${channelSystemPrompt ? `set (\`${channelSystemPrompt.length}\` chars)` : "none"}`,
              `Mentions: mode=\`${mentionPolicy.mode}\`, effective=\`${mentionPolicy.requireMention ? "required" : "off"}\``,
              ...threadStatusLines,
              `In-memory turns: \`${turns}\``,
              `Total channel cost: \`$${totalCost.toFixed(4)}\``,
            ];
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

            const lines = [
              `Root channel: \`${rootChannelId}\``,
              `Base branch: \`${baseBranch}\` (from \`${rootWorkingDir}\`)`,
              "Active thread branches:",
            ];

            for (const meta of activeBranches) {
              const lifecycle = meta.lifecycleState ?? "active";
              const worktreeMode =
                meta.worktreePath ??
                (meta.worktreeMode === "prompt" ? "pending-choice" : "inherited-parent/root");

              let branchInfo = "branch=unknown";
              let divergence = "ahead/behind=unknown";
              if (meta.worktreePath && existsSync(meta.worktreePath)) {
                const branchName = await detectBranchName(meta.worktreePath);
                if (branchName) {
                  branchInfo = `branch=${branchName}`;
                }
                const revList = await runCommand(
                  ["git", "rev-list", "--left-right", "--count", `${baseBranch}...HEAD`],
                  meta.worktreePath,
                );
                if (revList.exitCode === 0) {
                  const counts = parseAheadBehind(revList.output);
                  if (counts) {
                    divergence = `ahead=${counts.ahead}, behind=${counts.behind}`;
                  }
                }
              } else if (!meta.worktreePath) {
                branchInfo = "branch=inherited";
                divergence = "ahead/behind=n/a";
              }

              lines.push(
                `- ${meta.name} (\`${meta.channelId}\`): lifecycle=${lifecycle}; worktree=${worktreeMode}; ${branchInfo}; ${divergence}`,
              );
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
        const wasQueued = pendingMessageRunsByChannel.has(channelId);
        if (wasQueued) {
          try {
            await message.reply({
              content: "⏳ Run in progress for this channel. Queued your message.",
              components: buildQueueDismissButtons(channelId, message.author.id),
            });
          } catch {
            // Ignore queue notice failures.
          }
        }

        const previousRun = pendingMessageRunsByChannel.get(channelId) ?? Promise.resolve();
        const run = previousRun
          .catch(() => undefined)
          .then(async () => {
            if (shuttingDown) {
              try {
                await message.reply("⚠️ Bot is shutting down. Please retry in a moment.");
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
                await message.reply(
                  "Direct shell mode expects a command after `!` (example: `!git status`).",
                );
                return;
              }

              const result = await runBashCommand(directBash, state.channel.workingDir);
              const outputText = result.output || "(no output)";
              const payload = `\`\`\`bash\n$ ${directBash}\n${outputText}\n[exit ${result.exitCode}]\n\`\`\``;
              const chunks = chunkDiscordText(payload);
              const firstChunk = chunks[0] ?? "(no output)";
              await message.reply(firstChunk);
              for (let i = 1; i < chunks.length; i++) {
                const chunk = chunks[i];
                if (
                  chunk &&
                  "send" in message.channel &&
                  typeof message.channel.send === "function"
                ) {
                  await message.channel.send(chunk);
                }
              }
              return;
            }
            const channelSystemPrompt = repository.getChannelSystemPrompt(channelId);
            const stagedAttachments = await stageAttachments(message);
            const threadBranchContext = buildThreadBranchAwarenessPrompt({
              currentChannelId: channelId,
              entries: repository.listThreadBranchMetaEntries(),
            });
            const runToolTrace = createLiveToolTrace();
            liveToolTracesByChannel.set(channelId, runToolTrace);

            await addReaction(message, "🧠");
            const status = await message.reply({
              content: toStreamingPreview("", "", buildLiveToolPanel(runToolTrace)),
              components: buildStopButtons(channelId),
            });
            const prompt = `${threadBranchContext}${getMessagePrompt(message)}${stagedAttachments.promptSuffix}`;
            const seededPrompt = buildSeededPrompt(
              prompt,
              state.history,
              Boolean(state.channel.sessionId),
            );
            const abortController = new AbortController();
            const persistedFilenames = new Set<string>();
            let streamedText = "";
            let streamedThinking = "";
            let streamClosed = false;
            let streamFlushTimer: ReturnType<typeof setTimeout> | null = null;
            let statusEditQueue: Promise<unknown> = Promise.resolve();

            const queueStatusEdit = (content: string, includeButtons: boolean) => {
              statusEditQueue = statusEditQueue
                .then(() =>
                  status.edit({
                    content,
                    components: includeButtons ? buildStopButtons(channelId) : [],
                  }),
                )
                .catch(() => undefined);
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
                  buildLiveToolPanel(runToolTrace),
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

            try {
              sessions.appendTurn(channelId, {
                role: "user",
                content: prompt,
              });

              const result = await runner.run({
                channelId,
                prompt: seededPrompt,
                cwd: state.channel.workingDir,
                sessionId: state.channel.sessionId ?? undefined,
                model: state.channel.model,
                systemPrompt: channelSystemPrompt ?? undefined,
                permissionMode: config.claudePermissionMode,
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
                    scheduleStreamPreview();
                  }
                },
              });

              if (streamFlushTimer) {
                clearTimeout(streamFlushTimer);
                streamFlushTimer = null;
              }
              streamClosed = true;
              await statusEditQueue;

              if (result.sessionId) {
                sessions.setSessionId(channelId, result.sessionId);
              }

              const outputText = result.text.trim();
              const structuredAttachments = extractStructuredAttachmentDirectives(outputText);
              const cleanedOutputText = structuredAttachments.cleanedText.trim();
              const interrupted = stopController.wasInterrupted(channelId);
              finalizeLiveToolTrace(runToolTrace, interrupted ? "interrupted" : "success");
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

              const finalToolPanel = buildLiveToolPanel(runToolTrace);
              const finalPreview = toStreamingPreview(finalText, streamedThinking, finalToolPanel);
              await status.edit({
                content: finalPreview,
                components: [],
              });

              if (finalPreview.includes("...[truncated live preview]...")) {
                const chunks = chunkDiscordText(finalText);
                for (const chunk of chunks) {
                  if (
                    chunk &&
                    "send" in message.channel &&
                    typeof message.channel.send === "function"
                  ) {
                    await message.channel.send(chunk);
                  }
                }
              }

              await sendGeneratedFilesToChannel({
                channel: message.channel,
                workingDir: state.channel.workingDir,
                filenames: new Set([
                  ...persistedFilenames,
                  ...structuredAttachments.filenames,
                  ...extractAttachmentPathCandidates(outputText),
                ]),
              });

              await removeReaction(message, "🧠");
              await addReaction(message, "✅");
            } catch (error) {
              if (streamFlushTimer) {
                clearTimeout(streamFlushTimer);
                streamFlushTimer = null;
              }
              streamClosed = true;
              await statusEditQueue;
              finalizeLiveToolTrace(
                runToolTrace,
                stopController.wasInterrupted(channelId) ? "interrupted" : "failed",
              );

              const msg = error instanceof Error ? error.message : "Unknown failure";
              await status.edit({
                content: `❌ ${msg}`,
                components: [],
              });
              await removeReaction(message, "🧠");
              await addReaction(message, "❌");
            } finally {
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
