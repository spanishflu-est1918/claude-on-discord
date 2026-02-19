import { existsSync } from "node:fs";
import path from "node:path";
import { MessageFlags, type ButtonInteraction } from "discord.js";
import type { ClaudeRunner } from "../claude/runner";
import type { SessionManager } from "../claude/session";
import type { StopController } from "../claude/stop";
import type { Repository } from "../db/repository";
import {
  buildDiffViewButtons,
  buildThreadCleanupButtons,
  buildThreadWorktreeChoiceButtons,
  parseDiffViewCustomId,
  parseProjectSwitchCustomId,
  parseThreadCleanupCustomId,
  parseThreadWorktreeChoiceCustomId,
} from "../discord/buttons";
import { buildDiffDelivery } from "../discord/diff-delivery";
import { runWorktreeBootstrap } from "../discord/worktree-bootstrap";
import { parseThreadBranchMeta } from "../discord/thread-branch";
import { handleBasicButtonInteractions, type QueueNoticeInfo } from "./button-interactions";
import {
  buildDiffContext,
  buildDiffDetail,
  buildWorktreeBootstrapSummary,
  maybeProvisionThreadWorktree,
  type DiffContext,
} from "./diff-worktree";
import type { LiveToolTrace } from "./live-tools";
import type { PendingProjectSwitch } from "./slash-commands/project-command";
import { resolveThreadParentWorkingDir, saveThreadBranchMeta } from "./thread-lifecycle";

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
}): Promise<boolean> {
  const projectSwitch = parseProjectSwitchCustomId(input.interaction.customId);
  if (projectSwitch) {
    const pending = input.pendingProjectSwitches.get(projectSwitch.requestId);
    if (!pending) {
      await input.interaction.reply({
        content: "Project switch request expired. Run /project again.",
        flags: MessageFlags.Ephemeral,
      });
      return true;
    }
    if (input.interaction.channelId !== pending.channelId) {
      await input.interaction.reply({
        content: "This project switch belongs to a different channel.",
        flags: MessageFlags.Ephemeral,
      });
      return true;
    }

    input.pendingProjectSwitches.delete(projectSwitch.requestId);
    const previousChannelState = input.sessions.getState(pending.channelId, pending.guildId).channel;
    const state = input.sessions.switchProject(pending.channelId, pending.guildId, pending.workingDir, {
      fresh: projectSwitch.action === "fresh",
    });
    const changedProject = previousChannelState.workingDir !== pending.workingDir;
    if (projectSwitch.action === "fresh" || changedProject) {
      input.clearSessionPermissionMode(pending.channelId);
    }
    const suffix =
      projectSwitch.action === "fresh"
        ? " with fresh session."
        : changedProject
          ? " (context kept, session restarted)."
          : " (context kept).";
    await input.interaction.update({
      content: `Project set to \`${state.channel.workingDir}\`${suffix}`,
      components: [],
    });
    void input.syncChannelTopic(input.interaction.channel, state.channel.workingDir);
    return true;
  }

  const threadWorktreeChoice = parseThreadWorktreeChoiceCustomId(input.interaction.customId);
  if (threadWorktreeChoice) {
    if (input.interaction.channelId !== threadWorktreeChoice.channelId) {
      await input.interaction.reply({
        content: "This thread setup action belongs to a different channel.",
        flags: MessageFlags.Ephemeral,
      });
      return true;
    }

    const guildId = input.interaction.guildId ?? "dm";
    const channelId = threadWorktreeChoice.channelId;
    const state = input.sessions.getState(channelId, guildId);
    const meta = parseThreadBranchMeta(input.repository.getThreadBranchMeta(channelId));
    if (!meta) {
      await input.interaction.reply({
        content: "Thread setup request expired. Re-run `/status` and `/worktree action:thread`.",
        flags: MessageFlags.Ephemeral,
      });
      return true;
    }

    if (threadWorktreeChoice.action === "keep") {
      const { worktreePath: _worktreePath, ...rest } = meta;
      saveThreadBranchMeta(input.repository, {
        ...rest,
        worktreeMode: "inherited",
        lifecycleState: meta.lifecycleState ?? "active",
        cleanupState: "none",
      });
      await input.interaction.update({
        content: `Thread will keep parent project \`${state.channel.workingDir}\`.`,
        components: [],
      });
      return true;
    }

    const parentChannelId = meta.parentChannelId ?? meta.rootChannelId;
    const parentChannel = input.repository.getChannel(parentChannelId);
    const parentWorkingDir = parentChannel?.workingDir ?? state.channel.workingDir;
    const provisioned = await maybeProvisionThreadWorktree({
      enabled: true,
      parentWorkingDir,
      threadChannelId: channelId,
      threadName: meta.name,
      runCommand: input.runCommand,
    });

    if (!provisioned) {
      await input.interaction.update({
        content:
          `Could not create worktree from \`${parentWorkingDir}\`.\n` +
          "You can keep parent project or retry create worktree.",
        components: buildThreadWorktreeChoiceButtons(channelId),
      });
      return true;
    }

    let setupSummary = "";
    if (provisioned.created) {
      const setupResult = await runWorktreeBootstrap({
        enabled: input.worktreeBootstrap,
        customCommand: input.worktreeBootstrapCommand,
        workingDir: provisioned.worktreePath,
        runCommand: input.runCommand,
      });
      setupSummary = `\n${buildWorktreeBootstrapSummary(setupResult)}`;
    }

    input.sessions.switchProject(channelId, guildId, provisioned.worktreePath);
    input.clearSessionPermissionMode(channelId);
    input.sessions.setSessionId(channelId, null);
    saveThreadBranchMeta(input.repository, {
      ...meta,
      worktreePath: provisioned.worktreePath,
      worktreeMode: "worktree",
      lifecycleState: meta.lifecycleState ?? "active",
      cleanupState: "none",
    });
    await input.interaction.update({
      content:
        `Thread switched to dedicated worktree \`${provisioned.worktreePath}\` (session restarted).` +
        setupSummary,
      components: [],
    });
    void input.syncChannelTopic(input.interaction.channel, provisioned.worktreePath);
    return true;
  }

  const threadCleanup = parseThreadCleanupCustomId(input.interaction.customId);
  if (threadCleanup) {
    const channelId = threadCleanup.channelId;
    const meta = parseThreadBranchMeta(input.repository.getThreadBranchMeta(channelId));
    if (!meta) {
      await input.interaction.reply({
        content: "Thread cleanup request expired.",
        flags: MessageFlags.Ephemeral,
      });
      return true;
    }

    const worktreePath = meta.worktreePath;
    if (!worktreePath) {
      saveThreadBranchMeta(input.repository, {
        ...meta,
        cleanupState: "removed",
      });
      await input.interaction.update({
        content: `No dedicated worktree remains for thread \`${meta.name}\`.`,
        components: [],
      });
      return true;
    }

    if (threadCleanup.action === "keep") {
      saveThreadBranchMeta(input.repository, {
        ...meta,
        cleanupState: "kept",
      });
      await input.interaction.update({
        content: `Keeping worktree \`${worktreePath}\` for thread \`${meta.name}\`.`,
        components: [],
      });
      return true;
    }

    if (!existsSync(worktreePath)) {
      const { worktreePath: _removedPath, ...rest } = meta;
      saveThreadBranchMeta(input.repository, {
        ...rest,
        worktreeMode: "inherited",
        cleanupState: "removed",
      });
      await input.interaction.update({
        content: `Worktree already removed: \`${worktreePath}\`.`,
        components: [],
      });
      return true;
    }

    const fallbackWorkingDir = path.dirname(worktreePath);
    const parentWorkingDir = resolveThreadParentWorkingDir(
      input.repository,
      meta,
      fallbackWorkingDir,
    );
    const removeResult = await input.runCommand(["git", "worktree", "remove", worktreePath], parentWorkingDir);
    if (removeResult.exitCode !== 0) {
      await input.interaction.update({
        content:
          `Failed to remove worktree \`${worktreePath}\`.\n` +
          `\`\`\`bash\n${removeResult.output || "(no output)"}\n\`\`\``,
        components: buildThreadCleanupButtons(channelId),
      });
      return true;
    }

    const pruneResult = await input.runCommand(["git", "worktree", "prune"], parentWorkingDir);
    const { worktreePath: _removedPath, ...rest } = meta;
    saveThreadBranchMeta(input.repository, {
      ...rest,
      worktreeMode: "inherited",
      cleanupState: "removed",
    });

    const pruneSummary =
      pruneResult.exitCode === 0
        ? "git worktree prune complete."
        : `git worktree prune exit=${pruneResult.exitCode}: ${pruneResult.output || "(no output)"}`;
    await input.interaction.update({
      content: `Removed thread worktree \`${worktreePath}\`.\n${pruneSummary}`,
      components: [],
    });
    return true;
  }

  const diffView = parseDiffViewCustomId(input.interaction.customId);
  if (diffView) {
    const context = input.pendingDiffViews.get(diffView.requestId);
    if (!context) {
      await input.interaction.reply({
        content: "Diff view expired. Run `/diff` again.",
        flags: MessageFlags.Ephemeral,
      });
      return true;
    }
    if (input.interaction.channelId !== context.channelId) {
      await input.interaction.reply({
        content: "This diff view belongs to a different channel.",
        flags: MessageFlags.Ephemeral,
      });
      return true;
    }

    const latestState = input.sessions.getState(context.channelId, context.guildId).channel;
    if (latestState.workingDir !== context.workingDir) {
      input.pendingDiffViews.delete(diffView.requestId);
      await input.interaction.reply({
        content: "Project changed since this diff snapshot. Run `/diff` again.",
        flags: MessageFlags.Ephemeral,
      });
      return true;
    }

    if (diffView.action === "summary") {
      const refreshedContext = await buildDiffContext({
        channelId: context.channelId,
        guildId: context.guildId,
        workingDir: context.workingDir,
        baseInput: context.baseRef ?? null,
        repository: input.repository,
        detectBranchName: input.detectBranchName,
      });
      input.rememberDiffView(diffView.requestId, refreshedContext);
      const patchDetail = await buildDiffDetail(refreshedContext, "patch", input.runCommand);
      const delivery = buildDiffDelivery(patchDetail, "diff-patch");
      await input.interaction.update({
        content: delivery.content,
        files: delivery.files,
        components: buildDiffViewButtons(diffView.requestId),
      });
      return true;
    }

    await input.interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const detail = await buildDiffDetail(context, diffView.action, input.runCommand);
    const delivery = buildDiffDelivery(detail, `diff-${diffView.action}`);
    await input.interaction.editReply({
      content: delivery.content,
      files: delivery.files,
    });
    return true;
  }

  const handledBasicButton = await handleBasicButtonInteractions({
    interaction: input.interaction,
    queuedNoticesByMessageId: input.queuedNoticesByMessageId,
    liveToolTracesByChannel: input.liveToolTracesByChannel,
    getToolExpanded: input.getToolExpanded,
    setToolExpanded: input.setToolExpanded,
    steerRunner: input.runner,
    stopController: input.stopController,
  });
  if (handledBasicButton) {
    return true;
  }

  return false;
}
