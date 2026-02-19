import type { SessionManager } from "../../claude/session";
import type { Repository } from "../../db/repository";
import {
  buildForkThreadTitle,
  canCreateForkThread,
  isThreadBootstrapChannel,
  maybeInheritThreadContext,
} from "../thread-lifecycle";

type RunCommand = (
  command: string[],
  cwd: string,
) => Promise<{ exitCode: number; output: string }>;

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

export type ForkActionResult =
  | { ok: false; message: string }
  | { ok: true; threadId: string; title: string; bootstrapWarning?: string };

export async function runForkAction(input: {
  channel: unknown;
  channelId: string;
  guildId: string;
  requestedTitle: string | null;
  sessions: SessionManager;
  repository: Repository;
  autoThreadWorktree: boolean;
  worktreeBootstrap: boolean;
  worktreeBootstrapCommand?: string;
  runCommand: RunCommand;
}): Promise<ForkActionResult> {
  if (!input.channel) {
    return { ok: false, message: "Could not resolve the current channel for `/fork`." };
  }

  if (typeof (input.channel as { isThread?: unknown }).isThread === "function") {
    const isThread = (input.channel as { isThread: () => boolean }).isThread();
    if (isThread) {
      return {
        ok: false,
        message:
          "Run `/fork` from a parent text channel. This command creates a new thread from that channel.",
      };
    }
  }

  if (!canCreateForkThread(input.channel)) {
    return {
      ok: false,
      message: "This channel type does not support creating threads.",
    };
  }

  const channel = input.channel as ForkableChannel;
  const title = buildForkThreadTitle({
    requested: input.requestedTitle,
    channelName: channel.name,
  });

  const thread = await channel.threads.create({
    name: title,
    reason: "Fork created via /fork",
  });
  const threadChannel = isThreadBootstrapChannel(thread)
    ? thread
    : {
        id: thread.id,
        parentId: input.channelId,
        name: title,
        isThread: () => true,
      };

  try {
    await maybeInheritThreadContext({
      channel: threadChannel,
      channelId: thread.id,
      guildId: input.guildId,
      sessions: input.sessions,
      repository: input.repository,
      autoThreadWorktree: input.autoThreadWorktree,
      worktreeBootstrap: input.worktreeBootstrap,
      worktreeBootstrapCommand: input.worktreeBootstrapCommand,
      runCommand: input.runCommand,
    });
    return { ok: true, threadId: thread.id, title };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      ok: true,
      threadId: thread.id,
      title,
      bootstrapWarning: detail,
    };
  }
}
