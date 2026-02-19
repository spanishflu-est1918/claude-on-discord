import { MessageFlags, type ChatInputCommandInteraction } from "discord.js";
import type { ClaudeRunner } from "../claude/runner";
import type { SessionManager } from "../claude/session";
import type { StopController } from "../claude/stop";
import type { Repository, ChannelMentionsMode } from "../db/repository";
import type { ClaudePermissionMode } from "../types";
import {
  buildMergeReportLines,
  buildMergeSummaryPrompt,
  compactHistory,
  normalizeMergeSummary,
} from "./conversation-helpers";
import { parseAheadBehind, type DiffContext } from "./diff-worktree";
import { canSendMessage, maybeInheritThreadContext, saveThreadBranchMeta } from "./thread-lifecycle";
import { handleBashCommand } from "./slash-commands/bash-command";
import { handleBranchesCommand } from "./slash-commands/branches-command";
import { handleCompactCommand } from "./slash-commands/compact-command";
import type { SessionSlashCommandInput } from "./slash-commands/context";
import { handleDiffCommand } from "./slash-commands/diff-command";
import { handleForkCommand } from "./slash-commands/fork-command";
import { handleKillCommand } from "./slash-commands/kill-command";
import { handleStopCommand } from "./slash-commands/stop-command";
import { handleMentionsCommand } from "./slash-commands/mentions-command";
import { handleMergeCommand } from "./slash-commands/merge-command";
import { handleModeCommand } from "./slash-commands/mode-command";
import { handleModelCommand } from "./slash-commands/model-command";
import { handleNewCommand } from "./slash-commands/new-command";
import { handlePrCommand } from "./slash-commands/pr-command";
import { type PendingProjectSwitch, handleProjectCommand } from "./slash-commands/project-command";
import { handleScreenshotCommand } from "./slash-commands/screenshot-command";
import { handleStatusCommand } from "./slash-commands/status-command";
import { handlePersonaCommand } from "./slash-commands/persona-command";
import { handleSystemPromptCommand } from "./slash-commands/systemprompt-command";
import { handleWorktreeCommand } from "./slash-commands/worktree-command";

export type HandleSessionSlashCommandsInput = SessionSlashCommandInput & {
  commandName: string;
};

export async function handleSessionSlashCommands(
  input: HandleSessionSlashCommandsInput,
): Promise<boolean> {
  if (input.commandName === "systemprompt") {
    await handleSystemPromptCommand(input);
    return true;
  }

  if (input.commandName === "persona") {
    await handlePersonaCommand(input);
    return true;
  }

  if (input.commandName === "mentions") {
    await handleMentionsCommand(input);
    return true;
  }

  if (input.commandName === "mode") {
    await handleModeCommand(input);
    return true;
  }

  if (input.commandName === "cost") {
    const { handleCostCommand } = await import("./slash-commands/cost-command");
    await handleCostCommand(input);
    return true;
  }

  return false;
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

  switch (input.interaction.commandName) {
    case "new": {
      await handleNewCommand({
        interaction: input.interaction,
        channelId,
        sessions: input.sessions,
        clearSessionPermissionMode: input.clearSessionPermissionMode,
      });
      break;
    }
    case "fork": {
      await handleForkCommand({
        interaction: input.interaction,
        channelId,
        guildId,
        sessions: input.sessions,
        repository: input.repository,
        autoThreadWorktree: input.config.autoThreadWorktree,
        worktreeBootstrap: input.config.worktreeBootstrap,
        worktreeBootstrapCommand: input.config.worktreeBootstrapCommand,
        runCommand: input.runCommand,
      });
      break;
    }
    case "merge": {
      await handleMergeCommand({
        interaction: input.interaction,
        channelId,
        guildId,
        sessions: input.sessions,
        repository: input.repository,
        runner: input.runner,
        chunkDiscordText: input.chunkDiscordText,
        runCommand: input.runCommand,
        detectBranchName: input.detectBranchName,
        parseAheadBehind,
        buildMergeSummaryPrompt,
        normalizeMergeSummary,
        buildMergeReportLines,
        canSendMessage,
        saveThreadBranchMeta,
      });
      break;
    }
    case "compact": {
      await handleCompactCommand({
        interaction: input.interaction,
        channelId,
        guildId,
        sessions: input.sessions,
        compactHistory,
        clearSessionPermissionMode: input.clearSessionPermissionMode,
      });
      break;
    }
    case "status": {
      await handleStatusCommand({
        interaction: input.interaction,
        channelId,
        guildId,
        sessions: input.sessions,
        repository: input.repository,
        resolveMentionRequirementForChannel: input.resolveMentionRequirementForChannel,
        resolvePermissionModeForSession: input.resolvePermissionModeForSession,
      });
      break;
    }
    case "branches": {
      await handleBranchesCommand({
        interaction: input.interaction,
        channelId,
        guildId,
        sessions: input.sessions,
        repository: input.repository,
        detectBranchName: input.detectBranchName,
        runCommand: input.runCommand,
        parseAheadBehind,
        chunkDiscordText: input.chunkDiscordText,
      });
      break;
    }
    case "diff": {
      await handleDiffCommand({
        interaction: input.interaction,
        channelId,
        guildId,
        sessions: input.sessions,
        repository: input.repository,
        detectBranchName: input.detectBranchName,
        runCommand: input.runCommand,
        rememberDiffView: input.rememberDiffView,
      });
      break;
    }
    case "pr": {
      await handlePrCommand({
        interaction: input.interaction,
        channelId,
        guildId,
        sessions: input.sessions,
        runCommand: input.runCommand,
        chunkDiscordText: input.chunkDiscordText,
        resolvePrBaseBranch: async (value) =>
          await input.resolvePrBaseBranch({
            channelId: value.channelId,
            workingDir: value.workingDir,
            repository: input.repository,
          }),
      });
      break;
    }
    case "bash": {
      await handleBashCommand({
        interaction: input.interaction,
        channelId,
        guildId,
        sessions: input.sessions,
        runBashCommand: input.runBashCommand,
        chunkDiscordText: input.chunkDiscordText,
      });
      break;
    }
    case "screenshot": {
      await handleScreenshotCommand({
        interaction: input.interaction,
        channelId,
        guildId,
        sessions: input.sessions,
        captureScreenshotWithAgentBrowser: input.captureScreenshotWithAgentBrowser,
      });
      break;
    }
    case "project": {
      await handleProjectCommand({
        interaction: input.interaction,
        channelId,
        guildId,
        sessions: input.sessions,
        pendingProjectSwitches: input.pendingProjectSwitches,
      });
      break;
    }
    case "model": {
      await handleModelCommand({
        interaction: input.interaction,
        channelId,
        sessions: input.sessions,
        stopController: input.stopController,
      });
      break;
    }
    case "worktree": {
      await handleWorktreeCommand({
        interaction: input.interaction,
        channelId,
        guildId,
        sessions: input.sessions,
        repository: input.repository,
        runCommand: input.runCommand,
        chunkDiscordText: input.chunkDiscordText,
        worktreeBootstrap: input.config.worktreeBootstrap,
        worktreeBootstrapCommand: input.config.worktreeBootstrapCommand,
        clearSessionPermissionMode: input.clearSessionPermissionMode,
        saveThreadBranchMeta,
        syncChannelTopic: input.syncChannelTopic,
      });
      break;
    }
    case "kill": {
      await handleKillCommand({
        interaction: input.interaction,
        channelId,
        stopController: input.stopController,
      });
      break;
    }
    case "stop": {
      await handleStopCommand({
        interaction: input.interaction,
        channelId,
        stopController: input.stopController,
      });
      break;
    }
    default: {
      await input.interaction.reply({
        content: "Command not implemented.",
        flags: MessageFlags.Ephemeral,
      });
      break;
    }
  }
}
