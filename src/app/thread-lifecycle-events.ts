import type { Repository } from "../db/repository";
import { buildThreadCleanupButtons } from "../discord/buttons";
import type { ThreadLifecycleEvent } from "../discord/client";
import type { DiscordDispatchQueue } from "../discord/dispatcher";
import { parseThreadBranchMeta } from "../discord/thread-branch";
import type { ThreadDebugger } from "./thread-debugger";
import {
  type DiscordClientChannelFetcher,
  resolveThreadLifecycleNotificationChannel,
  saveThreadBranchMeta,
} from "./thread-lifecycle";

export function createThreadLifecycleEventHandler(input: {
  isShuttingDown: () => boolean;
  suspendedChannels: Set<string>;
  abortChannelRunWithSessionReset: (channelId: string, reason: string) => boolean;
  repository: Repository;
  discordDispatch: DiscordDispatchQueue;
  getDiscordClient: () => DiscordClientChannelFetcher | null;
  threadDebugger?: ThreadDebugger;
}): (event: ThreadLifecycleEvent) => Promise<void> {
  return async (event: ThreadLifecycleEvent) => {
    input.threadDebugger?.log({
      event: "thread.lifecycle.received",
      channelId: event.threadId,
      detail: {
        type: event.type,
        parentId: event.parentId,
        threadName: event.threadName,
      },
    });
    if (input.isShuttingDown()) {
      input.threadDebugger?.log({
        event: "thread.lifecycle.ignored_shutdown",
        channelId: event.threadId,
        detail: { type: event.type },
      });
      return;
    }

    if (event.type === "unarchived") {
      input.suspendedChannels.delete(event.threadId);
    } else {
      input.suspendedChannels.add(event.threadId);
      input.abortChannelRunWithSessionReset(event.threadId, `thread ${event.type}`);
    }
    input.threadDebugger?.log({
      event: "thread.lifecycle.suspension_updated",
      channelId: event.threadId,
      detail: {
        type: event.type,
        suspended: input.suspendedChannels.has(event.threadId),
      },
    });

    const meta = parseThreadBranchMeta(input.repository.getThreadBranchMeta(event.threadId));
    if (!meta) {
      input.threadDebugger?.log({
        event: "thread.lifecycle.no_meta",
        channelId: event.threadId,
        detail: { type: event.type },
      });
      return;
    }

    if (event.type === "unarchived") {
      const { archivedAt: _archivedAt, deletedAt: _deletedAt, ...rest } = meta;
      saveThreadBranchMeta(input.repository, {
        ...rest,
        lifecycleState: "active",
        cleanupState: meta.cleanupState === "pending" ? "none" : (meta.cleanupState ?? "none"),
      });
      input.threadDebugger?.log({
        event: "thread.lifecycle.unarchived_saved",
        channelId: event.threadId,
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
      saveThreadBranchMeta(input.repository, updatedMeta);
      input.threadDebugger?.log({
        event: "thread.lifecycle.updated_without_prompt",
        channelId: event.threadId,
        detail: {
          state: lifecycleState,
          cleanupState: updatedMeta.cleanupState,
        },
      });
      return;
    }

    saveThreadBranchMeta(input.repository, {
      ...updatedMeta,
      cleanupState: "pending",
    });

    const target = await resolveThreadLifecycleNotificationChannel({
      thread: event.thread,
      parentId: event.parentId,
      client: input.getDiscordClient(),
    });
    if (!target) {
      input.threadDebugger?.log({
        event: "thread.lifecycle.cleanup_prompt_skipped_no_target",
        channelId: event.threadId,
      });
      return;
    }

    try {
      const statusVerb = event.type === "archived" ? "archived" : "deleted";
      await input.discordDispatch.enqueue(`thread-lifecycle:${event.threadId}`, async () => {
        await target.send({
          content:
            `Thread \`${event.threadName}\` was ${statusVerb}.\n` +
            `Worktree \`${updatedMeta.worktreePath}\` still exists. Keep it or remove it now?`,
          components: buildThreadCleanupButtons(event.threadId),
        });
      });
      input.threadDebugger?.log({
        event: "thread.lifecycle.cleanup_prompt_sent",
        channelId: event.threadId,
        detail: { statusVerb, worktreePath: updatedMeta.worktreePath },
      });
    } catch {
      // Ignore lifecycle prompt failures when channel permissions/cache are limited.
      input.threadDebugger?.log({
        event: "thread.lifecycle.cleanup_prompt_failed",
        channelId: event.threadId,
      });
    }
  };
}
