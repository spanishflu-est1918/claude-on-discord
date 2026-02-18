import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";

const INTERRUPT_PREFIX = "run:interrupt:";
const ABORT_PREFIX = "run:abort:";
const TOOLS_DETAILS_PREFIX = "run:tools:";
const TOOLS_REFRESH_PREFIX = "run:tools:refresh:";
const QUEUE_DISMISS_PREFIX = "queue:dismiss:";
const PROJECT_KEEP_PREFIX = "project:keep:";
const PROJECT_FRESH_PREFIX = "project:fresh:";
const THREAD_WORKTREE_KEEP_PREFIX = "thread:worktree:keep:";
const THREAD_WORKTREE_CREATE_PREFIX = "thread:worktree:create:";
const THREAD_CLEANUP_KEEP_PREFIX = "thread:cleanup:keep:";
const THREAD_CLEANUP_REMOVE_PREFIX = "thread:cleanup:remove:";
const DIFF_SUMMARY_PREFIX = "diff:summary:";
const DIFF_FILES_PREFIX = "diff:files:";
const DIFF_STAT_PREFIX = "diff:stat:";
const DIFF_PATCH_PREFIX = "diff:patch:";

export type RunControlAction = "interrupt" | "abort";
export type ToolInspectAction = "details";
export type ToolPanelAction = "refresh";
export type QueueNoticeAction = "dismiss";
export type ProjectSwitchAction = "keep" | "fresh";
export type ThreadWorktreeAction = "keep" | "create";
export type ThreadCleanupAction = "keep" | "remove";
export type DiffViewAction = "summary" | "files" | "stat" | "patch";

export function buildStopButtons(channelId: string): ActionRowBuilder<ButtonBuilder>[] {
  const interruptButton = new ButtonBuilder()
    .setCustomId(`${INTERRUPT_PREFIX}${channelId}`)
    .setLabel("Interrupt")
    .setStyle(ButtonStyle.Secondary)
    .setEmoji("⏸️");

  const abortButton = new ButtonBuilder()
    .setCustomId(`${ABORT_PREFIX}${channelId}`)
    .setLabel("Abort")
    .setStyle(ButtonStyle.Secondary)
    .setEmoji("🛑");

  const toolsButton = new ButtonBuilder()
    .setCustomId(`${TOOLS_DETAILS_PREFIX}${channelId}`)
    .setLabel("Tools")
    .setStyle(ButtonStyle.Secondary)
    .setEmoji("🛠️");

  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(interruptButton, abortButton, toolsButton),
  ];
}

export function buildQueueDismissButtons(
  channelId: string,
  userId: string,
): ActionRowBuilder<ButtonBuilder>[] {
  const dismissButton = new ButtonBuilder()
    .setCustomId(`${QUEUE_DISMISS_PREFIX}${channelId}:${userId}`)
    .setLabel("Dismiss")
    .setStyle(ButtonStyle.Secondary)
    .setEmoji("✖️");

  return [new ActionRowBuilder<ButtonBuilder>().addComponents(dismissButton)];
}

export function buildProjectSwitchButtons(requestId: string): ActionRowBuilder<ButtonBuilder>[] {
  const keepButton = new ButtonBuilder()
    .setCustomId(`${PROJECT_KEEP_PREFIX}${requestId}`)
    .setLabel("Keep Context")
    .setStyle(ButtonStyle.Secondary);

  const freshButton = new ButtonBuilder()
    .setCustomId(`${PROJECT_FRESH_PREFIX}${requestId}`)
    .setLabel("Clear Context")
    .setStyle(ButtonStyle.Primary);

  return [new ActionRowBuilder<ButtonBuilder>().addComponents(keepButton, freshButton)];
}

export function buildThreadWorktreeChoiceButtons(
  channelId: string,
): ActionRowBuilder<ButtonBuilder>[] {
  const keepButton = new ButtonBuilder()
    .setCustomId(`${THREAD_WORKTREE_KEEP_PREFIX}${channelId}`)
    .setLabel("Keep Parent Project")
    .setStyle(ButtonStyle.Secondary);

  const createButton = new ButtonBuilder()
    .setCustomId(`${THREAD_WORKTREE_CREATE_PREFIX}${channelId}`)
    .setLabel("Create Worktree")
    .setStyle(ButtonStyle.Primary);

  return [new ActionRowBuilder<ButtonBuilder>().addComponents(keepButton, createButton)];
}

export function parseRunControlCustomId(
  customId: string,
): { action: RunControlAction; channelId: string } | null {
  if (customId.startsWith(INTERRUPT_PREFIX)) {
    const channelId = customId.slice(INTERRUPT_PREFIX.length);
    if (channelId) {
      return { action: "interrupt", channelId };
    }
  }

  if (customId.startsWith(ABORT_PREFIX)) {
    const channelId = customId.slice(ABORT_PREFIX.length);
    if (channelId) {
      return { action: "abort", channelId };
    }
  }

  return null;
}

export function parseQueueDismissCustomId(
  customId: string,
): { action: QueueNoticeAction; channelId: string; userId: string } | null {
  if (!customId.startsWith(QUEUE_DISMISS_PREFIX)) {
    return null;
  }
  const suffix = customId.slice(QUEUE_DISMISS_PREFIX.length);
  const separator = suffix.indexOf(":");
  if (separator <= 0 || separator >= suffix.length - 1) {
    return null;
  }
  const channelId = suffix.slice(0, separator);
  const userId = suffix.slice(separator + 1);
  if (!channelId || !userId) {
    return null;
  }
  return { action: "dismiss", channelId, userId };
}

export function parseToolInspectCustomId(
  customId: string,
): { action: ToolInspectAction; channelId: string } | null {
  if (customId.startsWith(TOOLS_REFRESH_PREFIX)) {
    return null;
  }
  if (!customId.startsWith(TOOLS_DETAILS_PREFIX)) {
    return null;
  }
  const channelId = customId.slice(TOOLS_DETAILS_PREFIX.length);
  if (!channelId) {
    return null;
  }
  return { action: "details", channelId };
}

export function buildToolPanelButtons(
  channelId: string,
  userId: string,
): ActionRowBuilder<ButtonBuilder>[] {
  const refreshButton = new ButtonBuilder()
    .setCustomId(`${TOOLS_REFRESH_PREFIX}${channelId}:${userId}`)
    .setLabel("Refresh")
    .setStyle(ButtonStyle.Secondary)
    .setEmoji("🔄");
  return [new ActionRowBuilder<ButtonBuilder>().addComponents(refreshButton)];
}

export function parseToolPanelCustomId(
  customId: string,
): { action: ToolPanelAction; channelId: string; userId: string } | null {
  if (!customId.startsWith(TOOLS_REFRESH_PREFIX)) {
    return null;
  }
  const suffix = customId.slice(TOOLS_REFRESH_PREFIX.length);
  const separator = suffix.indexOf(":");
  if (separator <= 0 || separator >= suffix.length - 1) {
    return null;
  }
  const channelId = suffix.slice(0, separator);
  const userId = suffix.slice(separator + 1);
  if (!channelId || !userId) {
    return null;
  }
  return { action: "refresh", channelId, userId };
}

export function parseProjectSwitchCustomId(
  customId: string,
): { action: ProjectSwitchAction; requestId: string } | null {
  if (customId.startsWith(PROJECT_KEEP_PREFIX)) {
    const requestId = customId.slice(PROJECT_KEEP_PREFIX.length);
    if (requestId) {
      return { action: "keep", requestId };
    }
  }

  if (customId.startsWith(PROJECT_FRESH_PREFIX)) {
    const requestId = customId.slice(PROJECT_FRESH_PREFIX.length);
    if (requestId) {
      return { action: "fresh", requestId };
    }
  }

  return null;
}

export function parseThreadWorktreeChoiceCustomId(
  customId: string,
): { action: ThreadWorktreeAction; channelId: string } | null {
  if (customId.startsWith(THREAD_WORKTREE_KEEP_PREFIX)) {
    const channelId = customId.slice(THREAD_WORKTREE_KEEP_PREFIX.length);
    if (channelId) {
      return { action: "keep", channelId };
    }
  }

  if (customId.startsWith(THREAD_WORKTREE_CREATE_PREFIX)) {
    const channelId = customId.slice(THREAD_WORKTREE_CREATE_PREFIX.length);
    if (channelId) {
      return { action: "create", channelId };
    }
  }

  return null;
}

export function buildThreadCleanupButtons(channelId: string): ActionRowBuilder<ButtonBuilder>[] {
  const keepButton = new ButtonBuilder()
    .setCustomId(`${THREAD_CLEANUP_KEEP_PREFIX}${channelId}`)
    .setLabel("Keep Worktree")
    .setStyle(ButtonStyle.Secondary);

  const removeButton = new ButtonBuilder()
    .setCustomId(`${THREAD_CLEANUP_REMOVE_PREFIX}${channelId}`)
    .setLabel("Remove Worktree")
    .setStyle(ButtonStyle.Primary);

  return [new ActionRowBuilder<ButtonBuilder>().addComponents(keepButton, removeButton)];
}

export function parseThreadCleanupCustomId(
  customId: string,
): { action: ThreadCleanupAction; channelId: string } | null {
  if (customId.startsWith(THREAD_CLEANUP_KEEP_PREFIX)) {
    const channelId = customId.slice(THREAD_CLEANUP_KEEP_PREFIX.length);
    if (channelId) {
      return { action: "keep", channelId };
    }
  }

  if (customId.startsWith(THREAD_CLEANUP_REMOVE_PREFIX)) {
    const channelId = customId.slice(THREAD_CLEANUP_REMOVE_PREFIX.length);
    if (channelId) {
      return { action: "remove", channelId };
    }
  }

  return null;
}

export function buildDiffViewButtons(requestId: string): ActionRowBuilder<ButtonBuilder>[] {
  const summaryButton = new ButtonBuilder()
    .setCustomId(`${DIFF_SUMMARY_PREFIX}${requestId}`)
    .setLabel("Refresh")
    .setStyle(ButtonStyle.Secondary);
  const filesButton = new ButtonBuilder()
    .setCustomId(`${DIFF_FILES_PREFIX}${requestId}`)
    .setLabel("Files")
    .setStyle(ButtonStyle.Secondary);
  const statButton = new ButtonBuilder()
    .setCustomId(`${DIFF_STAT_PREFIX}${requestId}`)
    .setLabel("Stat")
    .setStyle(ButtonStyle.Secondary);
  const patchButton = new ButtonBuilder()
    .setCustomId(`${DIFF_PATCH_PREFIX}${requestId}`)
    .setLabel("Patch")
    .setStyle(ButtonStyle.Primary);

  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      summaryButton,
      filesButton,
      statButton,
      patchButton,
    ),
  ];
}

export function parseDiffViewCustomId(
  customId: string,
): { action: DiffViewAction; requestId: string } | null {
  if (customId.startsWith(DIFF_SUMMARY_PREFIX)) {
    const requestId = customId.slice(DIFF_SUMMARY_PREFIX.length);
    if (requestId) {
      return { action: "summary", requestId };
    }
  }

  if (customId.startsWith(DIFF_FILES_PREFIX)) {
    const requestId = customId.slice(DIFF_FILES_PREFIX.length);
    if (requestId) {
      return { action: "files", requestId };
    }
  }

  if (customId.startsWith(DIFF_STAT_PREFIX)) {
    const requestId = customId.slice(DIFF_STAT_PREFIX.length);
    if (requestId) {
      return { action: "stat", requestId };
    }
  }

  if (customId.startsWith(DIFF_PATCH_PREFIX)) {
    const requestId = customId.slice(DIFF_PATCH_PREFIX.length);
    if (requestId) {
      return { action: "patch", requestId };
    }
  }

  return null;
}
