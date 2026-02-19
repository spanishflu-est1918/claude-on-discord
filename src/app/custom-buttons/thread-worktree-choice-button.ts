import { MessageFlags, type ButtonInteraction } from "discord.js";
import type { SessionManager } from "../../claude/session";
import type { Repository } from "../../db/repository";
import { buildThreadWorktreeChoiceButtons } from "../../discord/buttons";
import { runWorktreeBootstrap } from "../../discord/worktree-bootstrap";
import { parseThreadBranchMeta } from "../../discord/thread-branch";
import {
  buildWorktreeBootstrapSummary,
  maybeProvisionThreadWorktree,
} from "../diff-worktree";
import { saveThreadBranchMeta } from "../thread-lifecycle";

export async function handleThreadWorktreeChoiceButton(input: {
  interaction: ButtonInteraction;
  parsed: { action: "create" | "keep"; channelId: string };
  sessions: SessionManager;
  repository: Repository;
  runCommand: (command: string[], cwd: string) => Promise<{ exitCode: number; output: string }>;
  clearSessionPermissionMode: (channelId: string) => void;
  syncChannelTopic: (channel: unknown, workingDir: string) => Promise<void>;
  worktreeBootstrap: boolean;
  worktreeBootstrapCommand?: string;
}): Promise<boolean> {
  if (input.interaction.channelId !== input.parsed.channelId) {
    await input.interaction.reply({
      content: "This thread setup action belongs to a different channel.",
      flags: MessageFlags.Ephemeral,
    });
    return true;
  }

  const guildId = input.interaction.guildId ?? "dm";
  const channelId = input.parsed.channelId;
  const state = input.sessions.getState(channelId, guildId);
  const meta = parseThreadBranchMeta(input.repository.getThreadBranchMeta(channelId));
  if (!meta) {
    await input.interaction.reply({
      content: "Thread setup request expired. Re-run `/status` and `/worktree action:thread`.",
      flags: MessageFlags.Ephemeral,
    });
    return true;
  }

  if (input.parsed.action === "keep") {
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
