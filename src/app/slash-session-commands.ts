import { MessageFlags, type ChatInputCommandInteraction } from "discord.js";
import type { ClaudeRunner } from "../claude/runner";
import type { SessionManager } from "../claude/session";
import type { StopController } from "../claude/stop";
import type { Repository, ChannelMentionsMode } from "../db/repository";
import type { ClaudePermissionMode } from "../types";
import type { DiffContext } from "./diff-worktree";
import { maybeInheritThreadContext } from "./thread-lifecycle";
import type { SessionSlashCommandInput } from "./slash-commands/context";
import { handleChannelSlashCommandRoute } from "./slash-channel-command-router";
import { handleSessionSlashCommandRoute } from "./slash-session-command-router";
import type { PendingProjectSwitch } from "./slash-commands/project-command";

export type HandleSessionSlashCommandsInput = SessionSlashCommandInput & {
  commandName: string;
};

export async function handleSessionSlashCommands(
  input: HandleSessionSlashCommandsInput,
): Promise<boolean> {
  return await handleSessionSlashCommandRoute(input);
}

export type HandleSlashCommandsInput = {
  interaction: ChatInputCommandInteraction;
  shuttingDown: boolean;
  sessions: SessionManager;
  repository: Repository;
  runner: ClaudeRunner;
  stopController: StopController;
  runCommand: (command: string[], cwd: string) => Promise<{ exitCode: number; output: string }>;
  runBashCommand: (command: string, cwd: string) => Promise<{ exitCode: number; output: string }>;
  detectBranchName: (workingDir: string) => Promise<string | null>;
  resolvePrBaseBranch: (input: {
    channelId: string;
    workingDir: string;
    repository: Repository;
  }) => Promise<string>;
  syncChannelTopic: (channel: unknown, workingDir: string) => Promise<void>;
  rememberDiffView: (requestId: string, context: DiffContext) => void;
  pendingProjectSwitches: Map<string, PendingProjectSwitch>;
  resolveMentionRequirementForChannel: (channelId: string) => {
    requireMention: boolean;
    mode: ChannelMentionsMode;
  };
  resolvePermissionModeForSession: (channelId: string) => {
    permissionMode: ClaudePermissionMode;
    mode: ClaudePermissionMode | "default";
  };
  getActiveSessionId: (channelId: string) => string | null;
  setSessionPermissionMode: (channelId: string, mode: ClaudePermissionMode | "default") => void;
  clearSessionPermissionMode: (channelId: string) => void;
  config: {
    autoThreadWorktree: boolean;
    worktreeBootstrap: boolean;
    worktreeBootstrapCommand?: string;
    defaultRequireMention: boolean;
    defaultPermissionMode: ClaudePermissionMode;
  };
  captureScreenshotWithAgentBrowser: (input: {
    channelId: string;
    workingDir: string;
    url: string;
    fullPage: boolean;
  }) => Promise<{ screenshotPath?: string; output: string; exitCode: number }>;
  chunkDiscordText: (text: string) => string[];
};

export async function handleSlashCommands(input: HandleSlashCommandsInput): Promise<void> {
  if (input.shuttingDown) {
    await input.interaction.reply({
      content: "Bot is shutting down. Please retry in a moment.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const channelId = input.interaction.channelId;
  const guildId = input.interaction.guildId ?? "dm";
  await maybeInheritThreadContext({
    channel: input.interaction.channel,
    channelId,
    guildId,
    sessions: input.sessions,
    repository: input.repository,
    autoThreadWorktree: input.config.autoThreadWorktree,
    worktreeBootstrap: input.config.worktreeBootstrap,
    worktreeBootstrapCommand: input.config.worktreeBootstrapCommand,
    runCommand: input.runCommand,
  });

  const handledSessionSlashCommand = await handleSessionSlashCommands({
    interaction: input.interaction,
    channelId,
    commandName: input.interaction.commandName,
    defaultRequireMention: input.config.defaultRequireMention,
    defaultPermissionMode: input.config.defaultPermissionMode,
    getChannelCostTotal: (targetChannelId) => input.repository.getChannelCostTotal(targetChannelId),
    getChannelTurnCount: (targetChannelId) => input.repository.getChannelTurnCount(targetChannelId),
    setChannelSystemPrompt: (targetChannelId, text) =>
      input.repository.setChannelSystemPrompt(targetChannelId, text),
    getChannelSystemPrompt: (targetChannelId) =>
      input.repository.getChannelSystemPrompt(targetChannelId),
    clearChannelSystemPrompt: (targetChannelId) =>
      input.repository.clearChannelSystemPrompt(targetChannelId),
    setGlobalSystemPrompt: (text) => input.repository.setGlobalSystemPrompt(text),
    getGlobalSystemPrompt: () => input.repository.getGlobalSystemPrompt(),
    clearGlobalSystemPrompt: () => input.repository.clearGlobalSystemPrompt(),
    setChannelMentionsMode: (targetChannelId, mode) =>
      input.repository.setChannelMentionsMode(targetChannelId, mode as ChannelMentionsMode),
    clearChannelMentionsMode: (targetChannelId) => input.repository.clearChannelMentionsMode(targetChannelId),
    resetSessionId: (targetChannelId) => {
      input.clearSessionPermissionMode(targetChannelId);
      input.sessions.setSessionId(targetChannelId, null);
    },
    getActiveSessionId: input.getActiveSessionId,
    setSessionPermissionMode: input.setSessionPermissionMode,
    clearSessionPermissionMode: input.clearSessionPermissionMode,
    resolveMentionRequirementForChannel: input.resolveMentionRequirementForChannel,
    resolvePermissionModeForSession: input.resolvePermissionModeForSession,
    chunkDiscordText: input.chunkDiscordText,
  });
  if (handledSessionSlashCommand) {
    return;
  }

  await handleChannelSlashCommandRoute({
    interaction: input.interaction,
    channelId,
    guildId,
    sessions: input.sessions,
    repository: input.repository,
    runner: input.runner,
    stopController: input.stopController,
    runCommand: input.runCommand,
    runBashCommand: input.runBashCommand,
    detectBranchName: input.detectBranchName,
    resolvePrBaseBranch: input.resolvePrBaseBranch,
    syncChannelTopic: input.syncChannelTopic,
    rememberDiffView: input.rememberDiffView,
    pendingProjectSwitches: input.pendingProjectSwitches,
    clearSessionPermissionMode: input.clearSessionPermissionMode,
    config: {
      autoThreadWorktree: input.config.autoThreadWorktree,
      worktreeBootstrap: input.config.worktreeBootstrap,
      worktreeBootstrapCommand: input.config.worktreeBootstrapCommand,
    },
    captureScreenshotWithAgentBrowser: input.captureScreenshotWithAgentBrowser,
    chunkDiscordText: input.chunkDiscordText,
    resolveMentionRequirementForChannel: input.resolveMentionRequirementForChannel,
    resolvePermissionModeForSession: input.resolvePermissionModeForSession,
  });
}
