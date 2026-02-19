import { buildThreadWorktreeChoiceButtons } from "../discord/buttons";
import { parseThreadBranchMeta } from "../discord/thread-branch";
import { runWorktreeBootstrap } from "../discord/worktree-bootstrap";
import type { SessionManager } from "../claude/session";
import type { Repository } from "../db/repository";
import { maybeProvisionThreadWorktree } from "./diff-worktree";
import {
  detectBranchName,
  resolvePrBaseBranch,
  syncChannelTopic,
  type ThreadLifecycleRunCommand,
} from "./thread-lifecycle-branch";
import {
  canCreateForkThread,
  canEditSentMessage,
  canSendMessage,
  isThreadBootstrapChannel,
  buildForkThreadTitle,
} from "./thread-lifecycle-channel-utils";
import type {
  DiscordClientChannelFetcher,
  EditableSentMessage,
  SendableChannel,
} from "./thread-lifecycle-channel-utils";
import { setThreadStatus } from "./thread-status";
export type { ThreadStatus } from "./thread-status";
export {
  buildForkThreadTitle,
  canCreateForkThread,
  canEditSentMessage,
  canSendMessage,
  isThreadBootstrapChannel,
  setThreadStatus,
};
export { detectBranchName, resolvePrBaseBranch, syncChannelTopic };
export type { DiscordClientChannelFetcher, EditableSentMessage };

type RunCommand = ThreadLifecycleRunCommand;

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
  /**
   * When set, clone context from this channel ID instead of from `channel.parentId`.
   * Used for sibling forks where the new thread's Discord parent differs from the
   * channel whose conversation/working-dir should be inherited.
   */
  overrideContextSourceChannelId?: string;
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

  // contextSourceId is the channel we clone context/working-dir from.
  // For a normal fork it equals parentChannelId; for a sibling fork it is the
  // source thread (which shares the same Discord parent but is a separate branch).
  const contextSourceId = input.overrideContextSourceChannelId ?? parentChannelId;

  const parent = input.repository.getChannel(contextSourceId);
  if (!parent) {
    input.sessions.ensureChannel(input.channelId, input.guildId);
    return;
  }

  input.sessions.cloneChannelContext(contextSourceId, input.channelId, input.guildId);
  const threadName = cloneThreadBranchName(input.channel.name ?? "");
  const parentPrompt = input.repository.getChannelSystemPrompt(contextSourceId);
  if (parentPrompt) {
    input.repository.setChannelSystemPrompt(input.channelId, parentPrompt);
  }
  const parentMeta = parseThreadBranchMeta(input.repository.getThreadBranchMeta(contextSourceId));
  const rootChannelId = parentMeta?.rootChannelId ?? contextSourceId;
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
