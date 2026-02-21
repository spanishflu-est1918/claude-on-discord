import type { ButtonInteraction } from "discord.js";
import type { ClaudeRunner } from "../claude/runner";
import type { SessionManager } from "../claude/session";
import type { StopController } from "../claude/stop";
import type { Repository } from "../db/repository";
import {
  parseDiffViewCustomId,
  parseMergeCleanupCustomId,
  parseProjectSwitchCustomId,
  parseThreadCleanupCustomId,
  parseThreadWorktreeChoiceCustomId,
} from "../discord/buttons";
import { handleBasicButtonInteractions, type QueueNoticeInfo } from "./button-interactions";
import { handleDiffViewButton } from "./custom-buttons/diff-view-button";
import { handleMergeCleanupButton } from "./custom-buttons/merge-cleanup-button";
import { handleProjectSwitchButton } from "./custom-buttons/project-switch-button";
import { handleThreadCleanupButton } from "./custom-buttons/thread-cleanup-button";
import { handleThreadWorktreeChoiceButton } from "./custom-buttons/thread-worktree-choice-button";
import type { DiffContext } from "./diff-worktree";
import type { LiveToolTrace } from "./live-tools";
import type { PendingProjectSwitch } from "./slash-commands/project-command";

export async function handleCustomButtonInteraction(input: {
  interaction: ButtonInteraction;
  pendingProjectSwitches: Map<string, PendingProjectSwitch>;
  pendingDiffViews: Map<string, DiffContext>;
  sessions: SessionManager;
  repository: Repository;
  runCommand: (command: string[], cwd: string) => Promise<{ exitCode: number; output: string }>;
  detectBranchName: (workingDir: string) => Promise<string | null>;
  rememberDiffView: (requestId: string, context: DiffContext) => void;
  clearSessionPermissionMode: (channelId: string) => void;
  syncChannelTopic: (channel: unknown, workingDir: string) => Promise<void>;
  worktreeBootstrap: boolean;
  worktreeBootstrapCommand?: string;
  queuedNoticesByMessageId: Map<string, QueueNoticeInfo>;
  liveToolTracesByChannel: Map<string, LiveToolTrace>;
  getToolExpanded: (channelId: string, toolId: string) => boolean;
  setToolExpanded: (channelId: string, toolId: string, expanded: boolean) => void;
  runner: ClaudeRunner;
  stopController: StopController;
  abortPendingRun: (channelId: string) => boolean;
}): Promise<boolean> {
  const projectSwitch = parseProjectSwitchCustomId(input.interaction.customId);
  if (projectSwitch) {
    return await handleProjectSwitchButton({
      interaction: input.interaction,
      parsed: projectSwitch,
      pendingProjectSwitches: input.pendingProjectSwitches,
      sessions: input.sessions,
      clearSessionPermissionMode: input.clearSessionPermissionMode,
      syncChannelTopic: input.syncChannelTopic,
    });
  }

  const threadWorktreeChoice = parseThreadWorktreeChoiceCustomId(input.interaction.customId);
  if (threadWorktreeChoice) {
    return await handleThreadWorktreeChoiceButton({
      interaction: input.interaction,
      parsed: threadWorktreeChoice,
      sessions: input.sessions,
      repository: input.repository,
      runCommand: input.runCommand,
      clearSessionPermissionMode: input.clearSessionPermissionMode,
      syncChannelTopic: input.syncChannelTopic,
      worktreeBootstrap: input.worktreeBootstrap,
      worktreeBootstrapCommand: input.worktreeBootstrapCommand,
    });
  }

  const mergeCleanup = parseMergeCleanupCustomId(input.interaction.customId);
  if (mergeCleanup) {
    return await handleMergeCleanupButton({
      interaction: input.interaction,
      parsed: mergeCleanup,
      repository: input.repository,
      runCommand: input.runCommand,
      detectBranchName: input.detectBranchName,
    });
  }

  const threadCleanup = parseThreadCleanupCustomId(input.interaction.customId);
  if (threadCleanup) {
    return await handleThreadCleanupButton({
      interaction: input.interaction,
      parsed: threadCleanup,
      repository: input.repository,
      runCommand: input.runCommand,
    });
  }

  const diffView = parseDiffViewCustomId(input.interaction.customId);
  if (diffView) {
    return await handleDiffViewButton({
      interaction: input.interaction,
      parsed: diffView,
      pendingDiffViews: input.pendingDiffViews,
      sessions: input.sessions,
      repository: input.repository,
      runCommand: input.runCommand,
      detectBranchName: input.detectBranchName,
      rememberDiffView: input.rememberDiffView,
    });
  }

  const handledBasicButton = await handleBasicButtonInteractions({
    interaction: input.interaction,
    queuedNoticesByMessageId: input.queuedNoticesByMessageId,
    liveToolTracesByChannel: input.liveToolTracesByChannel,
    getToolExpanded: input.getToolExpanded,
    setToolExpanded: input.setToolExpanded,
    steerRunner: input.runner,
    stopController: {
      interrupt: async (channelId) => await input.stopController.interrupt(channelId),
      abort: (channelId) => input.stopController.abort(channelId),
      abortPending: (channelId) => input.abortPendingRun(channelId),
    },
  });
  if (handledBasicButton) {
    return true;
  }

  return false;
}
