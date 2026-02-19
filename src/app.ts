import { MessageFlags } from "discord.js";
import { captureScreenshotWithAgentBrowser } from "./app/agent-browser";
import { ACTIVE_RUN_MAX_AGE_MS, ACTIVE_RUN_WATCHDOG_INTERVAL_MS } from "./app/constants";
import { createRuntimeLifecycleManager } from "./app/runtime-lifecycle";
import { createAppRuntimeState } from "./app/runtime-state";
import { createSessionPermissionBindings } from "./app/session-permissions";
import { handleSlashCommands } from "./app/slash-session-commands";
import { createUserMessageHandler } from "./app/user-message-handler";
import {
  createMentionPolicyResolver,
  createSessionPermissionModeStore,
} from "./app/channel-policies";
import { handleCustomButtonInteraction } from "./app/custom-button-interactions";
import { runBashCommand, runCommand } from "./app/process-utils";
import { createThreadLifecycleEventHandler } from "./app/thread-lifecycle-events";
import { createThreadLifecycleOps } from "./app/thread-lifecycle-ops";
import { createWorkerHeartbeatManagerFromEnv } from "./app/worker-heartbeat";
import { ClaudeRunner } from "./claude/runner";
import { SessionManager } from "./claude/session";
import { StopController } from "./claude/stop";
import type { AppConfig } from "./config";
import { Repository } from "./db/repository";
import { openDatabase } from "./db/schema";
import { chunkDiscordText } from "./discord/chunker";
import { startDiscordClient } from "./discord/client";
import { registerSlashCommands } from "./discord/commands";
import { DiscordDispatchQueue } from "./discord/dispatcher";

export type StartAppRuntimeOverrides = {
  openDatabase?: typeof openDatabase;
  registerSlashCommands?: typeof registerSlashCommands;
  startDiscordClient?: typeof startDiscordClient;
  createRunner?: () => ClaudeRunner;
  installSignalHandlers?: boolean;
};

export async function startApp(
  config: AppConfig,
  runtimeOverrides: StartAppRuntimeOverrides = {},
): Promise<void> {
  const openDatabaseImpl = runtimeOverrides.openDatabase ?? openDatabase;
  const registerSlashCommandsImpl = runtimeOverrides.registerSlashCommands ?? registerSlashCommands;
  const startDiscordClientImpl = runtimeOverrides.startDiscordClient ?? startDiscordClient;
  const installSignalHandlers = runtimeOverrides.installSignalHandlers ?? true;

  const database = openDatabaseImpl(config.databasePath);
  const repository = new Repository(database);
  const sessions = new SessionManager(repository, {
    defaultWorkingDir: config.defaultWorkingDir,
    defaultModel: config.defaultModel,
    maxHistoryItems: config.sessionHistoryMaxItems,
    maxTurnChars: config.sessionTurnMaxChars,
  });
  const activeRunMaxAgeMs = config.activeRunMaxAgeMs ?? ACTIVE_RUN_MAX_AGE_MS;
  const activeRunWatchdogIntervalMs =
    config.activeRunWatchdogIntervalMs ?? ACTIVE_RUN_WATCHDOG_INTERVAL_MS;
  const stopController = new StopController();
  const runner = runtimeOverrides.createRunner?.() ?? new ClaudeRunner();
  const runtimeState = createAppRuntimeState();
  const {
    pendingProjectSwitches,
    pendingDiffViews,
    pendingMessageRunsByChannel,
    queuedNoticesByMessageId,
    liveToolTracesByChannel,
    liveToolExpandStateByChannel,
    suspendedChannels,
    getToolExpanded,
    setToolExpanded,
    rememberDiffView,
    clearTransientState,
  } = runtimeState;
  const resolveMentionRequirementForChannel = createMentionPolicyResolver({
    repository,
    defaultRequireMention: config.requireMentionInMultiUserChannels,
  });
  const sessionPermissionModeStore = createSessionPermissionModeStore(config.claudePermissionMode);
  const threadLifecycleOps = createThreadLifecycleOps({ runCommand });
  const detectBranchName = threadLifecycleOps.detectBranchName;
  const resolvePrBaseBranch = threadLifecycleOps.resolvePrBaseBranch;
  const syncChannelTopic = threadLifecycleOps.syncChannelTopic;
  const discordDispatch = new DiscordDispatchQueue({
    maxAttempts: 4,
    baseBackoffMs: 250,
    maxBackoffMs: 4000,
    onRateLimit: ({ laneId, retryAfterMs, attempt }) => {
      console.warn(
        `Discord dispatcher retry lane=${laneId} attempt=${attempt} wait=${retryAfterMs}ms`,
      );
    },
  });
  let shuttingDown = false;
  let discordClient: Awaited<ReturnType<typeof startDiscordClient>> | null = null;
  const workerHeartbeatManager = createWorkerHeartbeatManagerFromEnv();
  const {
    getActiveSessionId,
    resolvePermissionModeForSession,
    setSessionPermissionMode,
    clearSessionPermissionMode,
  } = createSessionPermissionBindings({
    repository,
    store: sessionPermissionModeStore,
  });
  const worktreeConfig = {
    autoThreadWorktree: config.autoThreadWorktree,
    worktreeBootstrap: config.worktreeBootstrap,
    ...(config.worktreeBootstrapCommand
      ? { worktreeBootstrapCommand: config.worktreeBootstrapCommand }
      : {}),
  };

  const runtimeLifecycle = createRuntimeLifecycleManager({
    stopController,
    clearSessionPermissionMode,
    setSessionId: (channelId, sessionId) => {
      sessions.setSessionId(channelId, sessionId);
    },
    activeRunMaxAgeMs,
    activeRunWatchdogIntervalMs,
    isShuttingDown: () => shuttingDown,
    setShuttingDown: (value) => {
      shuttingDown = value;
    },
    clearTransientState,
    runner,
    workerHeartbeatManager,
    getDiscordClient: () => discordClient,
    closeDatabase: () => database.close(),
  });
  const shutdown = runtimeLifecycle.shutdown;

  const onUserMessage = createUserMessageHandler({
    isShuttingDown: () => shuttingDown,
    suspendedChannels,
    pendingMessageRunsByChannel,
    queuedNoticesByMessageId,
    liveToolTracesByChannel,
    liveToolExpandStateByChannel,
    getToolExpanded,
    resolvePermissionModeForSession: (targetChannelId) =>
      resolvePermissionModeForSession(targetChannelId),
    sessions,
    repository,
    stopController,
    runner,
    discordDispatch,
    config: worktreeConfig,
    runCommand,
    runBashCommand,
  });

  try {
    await workerHeartbeatManager.start();

    await registerSlashCommandsImpl({
      token: config.discordToken,
      clientId: config.discordClientId,
      guildId: config.discordGuildId,
    });

    discordClient = await startDiscordClientImpl({
      token: config.discordToken,
      shouldRequireMentionForMessage: (message) =>
        resolveMentionRequirementForChannel(message.channel.id).requireMention,
      onGatewayDisconnect: (code) => {
        if (shuttingDown) {
          return;
        }
        runtimeLifecycle.clearActiveRunsWithSessionReset(`gateway disconnect (code=${code})`);
      },
      onGatewayReconnecting: () => {
        if (!shuttingDown) {
          console.warn("Gateway reconnect in progress.");
        }
      },
      onGatewayResume: () => {
        if (!shuttingDown) {
          console.log("Gateway resume completed.");
        }
      },
      onThreadLifecycle: createThreadLifecycleEventHandler({
        isShuttingDown: () => shuttingDown,
        suspendedChannels,
        abortChannelRunWithSessionReset: runtimeLifecycle.abortChannelRunWithSessionReset,
        repository,
        discordDispatch,
        getDiscordClient: () => discordClient,
      }),
      onButtonInteraction: async (interaction) => {
        if (shuttingDown) {
          await interaction.reply({
            content: "Bot is shutting down. Please retry in a moment.",
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        const handledCustomButton = await handleCustomButtonInteraction({
          interaction,
          pendingProjectSwitches,
          pendingDiffViews,
          sessions,
          repository,
          runCommand,
          detectBranchName,
          rememberDiffView,
          clearSessionPermissionMode,
          syncChannelTopic,
          worktreeBootstrap: config.worktreeBootstrap,
          worktreeBootstrapCommand: config.worktreeBootstrapCommand,
          queuedNoticesByMessageId,
          liveToolTracesByChannel,
          getToolExpanded,
          setToolExpanded,
          runner,
          stopController,
        });
        if (handledCustomButton) {
          return;
        }

        await interaction.reply({
          content: "Unknown control button.",
          flags: MessageFlags.Ephemeral,
        });
      },
      onSlashCommand: async (interaction) => {
        await handleSlashCommands({
          interaction,
          shuttingDown,
          sessions,
          repository,
          runner,
          stopController,
          runCommand,
          runBashCommand,
          detectBranchName,
          resolvePrBaseBranch,
          syncChannelTopic,
          rememberDiffView,
          pendingProjectSwitches,
          resolveMentionRequirementForChannel,
          resolvePermissionModeForSession,
          getActiveSessionId,
          setSessionPermissionMode,
          clearSessionPermissionMode,
          config: {
            ...worktreeConfig,
            defaultRequireMention: config.requireMentionInMultiUserChannels,
            defaultPermissionMode: config.claudePermissionMode,
          },
          captureScreenshotWithAgentBrowser: async (value) =>
            await captureScreenshotWithAgentBrowser({
              ...value,
              runCommand,
            }),
          chunkDiscordText,
        });
      },
      onUserMessage,
    });
    runtimeLifecycle.startStaleRunWatchdog();
  } catch (error) {
    await shutdown("startup error");
    throw error;
  }

  if (installSignalHandlers) {
    const onSigint = () => {
      void shutdown("SIGINT").finally(() => process.exit(0));
    };
    const onSigterm = () => {
      void shutdown("SIGTERM").finally(() => process.exit(0));
    };
    process.once("SIGINT", onSigint);
    process.once("SIGTERM", onSigterm);
  }
}
