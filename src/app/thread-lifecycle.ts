import { buildThreadWorktreeChoiceButtons } from "../discord/buttons";
import { parseOriginDefaultBranch } from "../discord/pr";
import { parseThreadBranchMeta } from "../discord/thread-branch";
import { buildChannelTopic, parseGitBranch } from "../discord/topic";
import { runWorktreeBootstrap } from "../discord/worktree-bootstrap";
import type { SessionManager } from "../claude/session";
import type { Repository } from "../db/repository";
import { maybeProvisionThreadWorktree } from "./diff-worktree";

type RunCommand = (
  command: string[],
  cwd: string,
) => Promise<{ exitCode: number; output: string }>;

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

type RenameableThreadChannel = {
  isThread: () => boolean;
  edit: (options: { name: string }) => Promise<unknown>;
  name: string;
};

type ThreadBootstrapChannel = {
  id: string;
  parentId: string | null;
  name?: string;
  isThread: () => boolean;
};

type SendableChannel = {
  send: (options: unknown) => Promise<unknown>;
};

export type EditableSentMessage = {
  edit: (options: unknown) => Promise<unknown>;
};

export type DiscordClientChannelFetcher = {
  channels: {
    fetch: (id: string) => Promise<unknown>;
  };
};

type ThreadBranchMetaInput = {
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
};

function canSetTopic(channel: unknown): channel is TopicChannel {
  return (
    typeof channel === "object" &&
    channel !== null &&
    "setTopic" in channel &&
    typeof (channel as TopicChannel).setTopic === "function"
  );
}

export function canCreateForkThread(channel: unknown): channel is ForkableChannel {
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

export async function setThreadState(channel: unknown, state: ThreadState | null): Promise<void> {
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

export function buildForkThreadTitle(input: {
  requested: string | null;
  channelName?: string;
}): string {
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

export async function detectBranchName(
  workingDir: string,
  runCommand: RunCommand,
): Promise<string | null> {
  const result = await runCommand(["git", "rev-parse", "--abbrev-ref", "HEAD"], workingDir);
  if (result.exitCode !== 0) {
    return null;
  }
  return parseGitBranch(result.output);
}

async function detectOriginDefaultBranch(
  workingDir: string,
  runCommand: RunCommand,
): Promise<string | null> {
  const result = await runCommand(["git", "symbolic-ref", "refs/remotes/origin/HEAD"], workingDir);
  if (result.exitCode !== 0) {
    return null;
  }
  return parseOriginDefaultBranch(result.output);
}

export async function resolvePrBaseBranch(input: {
  channelId: string;
  workingDir: string;
  repository: Repository;
  runCommand: RunCommand;
}): Promise<string> {
  const threadMeta = parseThreadBranchMeta(input.repository.getThreadBranchMeta(input.channelId));
  if (threadMeta) {
    const rootChannel = input.repository.getChannel(threadMeta.rootChannelId);
    const rootBranch = rootChannel
      ? await detectBranchName(rootChannel.workingDir, input.runCommand)
      : null;
    if (rootBranch) {
      return rootBranch;
    }
  }

  const originDefault = await detectOriginDefaultBranch(input.workingDir, input.runCommand);
  if (originDefault) {
    return originDefault;
  }
  return "main";
}

export async function syncChannelTopic(input: {
  channel: unknown;
  workingDir: string;
  runCommand: RunCommand;
}): Promise<void> {
  if (!canSetTopic(input.channel)) {
    return;
  }
  const branch = await detectBranchName(input.workingDir, input.runCommand);
  const topic = buildChannelTopic({ workingDir: input.workingDir, branch });
  try {
    await input.channel.setTopic(topic);
  } catch {
    // Ignore topic update failures when permissions/channel type do not allow it.
  }
}

export function isThreadBootstrapChannel(channel: unknown): channel is ThreadBootstrapChannel {
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

export function canSendMessage(channel: unknown): channel is SendableChannel {
  return (
    typeof channel === "object" &&
    channel !== null &&
    "send" in channel &&
    typeof (channel as SendableChannel).send === "function"
  );
}

export function canEditSentMessage(message: unknown): message is EditableSentMessage {
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

export async function maybeInheritThreadContext(input: {
  channel: unknown;
  channelId: string;
  guildId: string;
  sessions: SessionManager;
  repository: Repository;
  autoThreadWorktree: boolean;
  worktreeBootstrap: boolean;
  worktreeBootstrapCommand?: string;
  runCommand: RunCommand;
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
      runCommand: input.runCommand,
    });
    if (provisioned) {
      if (provisioned.created) {
        const setup = await runWorktreeBootstrap({
          enabled: input.worktreeBootstrap,
          customCommand: input.worktreeBootstrapCommand,
          workingDir: provisioned.worktreePath,
          runCommand: input.runCommand,
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

export function saveThreadBranchMeta(repository: Repository, meta: ThreadBranchMetaInput): void {
  repository.setThreadBranchMeta(meta.channelId, JSON.stringify(meta));
}

export function resolveThreadParentWorkingDir(
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

export async function resolveThreadLifecycleNotificationChannel(input: {
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
