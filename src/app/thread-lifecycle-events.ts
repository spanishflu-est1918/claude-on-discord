import type { ThreadLifecycleEvent } from "../discord/client";
import { buildThreadCleanupButtons } from "../discord/buttons";
import type { DiscordDispatchQueue } from "../discord/dispatcher";
import { parseThreadBranchMeta } from "../discord/thread-branch";
import type { Repository } from "../db/repository";
import {
  resolveThreadLifecycleNotificationChannel,
  saveThreadBranchMeta,
  type DiscordClientChannelFetcher,
} from "./thread-lifecycle";

export function createThreadLifecycleEventHandler(input: {
  isShuttingDown: () => boolean;
  suspendedChannels: Set<string>;
  abortChannelRunWithSessionReset: (channelId: string, reason: string) => boolean;
  repository: Repository;
  discordDispatch: DiscordDispatchQueue;
  getDiscordClient: () => DiscordClientChannelFetcher | null;
}): (event: ThreadLifecycleEvent) => Promise<void> {
  return async (event: ThreadLifecycleEvent) => {
    if (input.isShuttingDown()) {
      return;
    }

    if (event.type === "unarchived") {
      input.suspendedChannels.delete(event.threadId);
    } else {
      input.suspendedChannels.add(event.threadId);
      input.abortChannelRunWithSessionReset(event.threadId, `thread ${event.type}`);
    }

    const meta = parseThreadBranchMeta(input.repository.getThreadBranchMeta(event.threadId));
    if (!meta) {
      return;
    }

    if (event.type === "unarchived") {
      const { archivedAt: _archivedAt, deletedAt: _deletedAt, ...rest } = meta;
      saveThreadBranchMeta(input.repository, {
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
      saveThreadBranchMeta(input.repository, updatedMeta);
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
    } catch {
      // Ignore lifecycle prompt failures when channel permissions/cache are limited.
    }
  };
}
