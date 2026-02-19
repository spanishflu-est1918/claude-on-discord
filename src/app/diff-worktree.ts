import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { Repository } from "../db/repository";
import { parseThreadBranchMeta } from "../discord/thread-branch";
import type { WorktreeBootstrapResult } from "../discord/worktree-bootstrap";

export type CommandRunner = (
  cmd: string[],
  cwd: string,
) => Promise<{ exitCode: number; output: string }>;

export type DiffMode = "working-tree" | "thread-branch";
export type DiffDetailAction = "files" | "stat" | "patch";

export type DiffContext = {
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

export type ProvisionedWorktree = {
  worktreePath: string;
  created: boolean;
};

export function firstOutputLine(output: string): string {
  return output.split(/\r?\n/, 1)[0]?.trim() ?? "";
}

export function parseAheadBehind(output: string): { behind: number; ahead: number } | null {
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

export function clipOutput(text: string, maxChars = 8000): string {
  if (text.length <= maxChars) {
    return text;
  }
  const hiddenChars = text.length - maxChars;
  return `${text.slice(0, maxChars)}\n... [truncated ${hiddenChars} chars]`;
}

function linesFromOutput(output: string): string[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function sanitizeThreadToken(input: string): string {
  const base = input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return base.length > 0 ? base : "thread";
}

async function buildUntrackedPatchText(
  workingDir: string,
  untrackedFiles: string[],
  runCommand: CommandRunner,
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

async function buildWorkingTreeDiffSnapshot(
  workingDir: string,
  runCommand: CommandRunner,
): Promise<WorkingTreeDiffSnapshot> {
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
  const untrackedPatch = await buildUntrackedPatchText(workingDir, untrackedFiles, runCommand);

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

export async function buildDiffContext(input: {
  channelId: string;
  guildId: string;
  workingDir: string;
  baseInput: string | null;
  repository: Repository;
  detectBranchName: (workingDir: string) => Promise<string | null>;
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
  const detectedBase = await input.detectBranchName(rootWorkingDir);
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

export async function buildDiffDetail(
  context: DiffContext,
  action: DiffDetailAction,
  runCommand: CommandRunner,
): Promise<string> {
  const snapshot = await buildWorkingTreeDiffSnapshot(context.workingDir, runCommand);
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
      "Diff files (`" + context.mode + "`)",
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
      "Diff stat (`" + context.mode + "`)",
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

export async function buildAutoWorktreeTarget(input: {
  baseWorkingDir: string;
  channelId: string;
  branchHint?: string | null;
  runCommand: CommandRunner;
}): Promise<{ worktreePath: string; branchName: string } | null> {
  const topLevelResult = await input.runCommand(
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

export function buildWorktreeBootstrapSummary(result: WorktreeBootstrapResult): string {
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

export async function maybeProvisionThreadWorktree(input: {
  enabled: boolean;
  parentWorkingDir: string;
  threadChannelId: string;
  threadName: string;
  runCommand: CommandRunner;
}): Promise<ProvisionedWorktree | null> {
  if (!input.enabled) {
    return null;
  }

  const topLevelResult = await input.runCommand(
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

  let addResult = await input.runCommand(
    ["git", "worktree", "add", worktreePath, "-b", branchName],
    repoRoot,
  );
  if (addResult.exitCode !== 0 && /already exists/i.test(addResult.output)) {
    addResult = await input.runCommand(
      ["git", "worktree", "add", worktreePath, branchName],
      repoRoot,
    );
  }
  if (addResult.exitCode !== 0) {
    console.warn(
      `Thread worktree provisioning failed for ${input.threadChannelId}: ${addResult.output}`,
    );
    return null;
  }

  return { worktreePath, created: true };
}
