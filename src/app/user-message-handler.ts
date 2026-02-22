import type { Message } from "discord.js";
import type { ClaudeRunner } from "../claude/runner";
import type { SessionManager } from "../claude/session";
import type { ActiveRun, StopController } from "../claude/stop";
import type { Repository } from "../db/repository";
import { buildQueueNoticeButtons, buildStopButtons } from "../discord/buttons";
import { chunkDiscordText } from "../discord/chunker";
import type { DiscordDispatchQueue } from "../discord/dispatcher";
import { runHook } from "../discord/hook-runner";
import { buildThreadBranchAwarenessPrompt, parseThreadBranchMeta } from "../discord/thread-branch";
import type { ClaudePermissionMode } from "../types";
import type { QueueNoticeInfo } from "./button-interactions";
import {
  buildMergeContextInjection,
  buildSeededPrompt,
  parseDirectBashCommand,
} from "./conversation-helpers";
import { handleDirectBashMessage } from "./direct-bash-handler";
import {
  cleanupFiles,
  extractAttachmentPathCandidates,
  extractStructuredAttachmentDirectives,
  formatErrorMessage,
  sendGeneratedFilesToChannel,
} from "./file-artifacts";
import { createLiveToolMessageController } from "./live-tool-message-controller";
import {
  applyToolMessageToTrace,
  collectToolIdsFromMessage,
  createLiveToolTrace,
  finalizeLiveToolTrace,
  type LiveToolTrace,
  THINKING_SPINNER_FRAMES,
  toStreamingPreview,
} from "./live-tools";
import {
  addReaction,
  buildStoredUserTurnContent,
  getMessagePrompt,
  removeReaction,
  stageAttachments,
} from "./message-helpers";
import { shouldApplyRunnerSafetyGuards, withNoInteractiveToolDirective } from "./prompt-directives";
import { createQueuedChannelDispatch } from "./queued-channel-dispatch";
import { notifyRunFailure } from "./run-failure-notifier";
import { createRunawayToolGuard } from "./runaway-tool-guard";
import { logRunnerSkillDebug } from "./runner-skill-debug";
import { createStreamingStatusController } from "./streaming-status-controller";
import type { ThreadDebugger } from "./thread-debugger";
import {
  maybeInheritThreadContext,
  saveThreadBranchMeta,
  setThreadStatus,
} from "./thread-lifecycle";

const SAFETY_DISALLOWED_TOOLS = [
  "Task",
  "Bash",
  "Read",
  "Grep",
  "Glob",
  "LS",
  "WebFetch",
  "WebSearch",
  "Edit",
  "Write",
  "MultiEdit",
  "NotebookEdit",
  "NotebookRead",
  "TodoRead",
  "TodoWrite",
  "AskUserQuestion",
  "ListMcpResourcesTool",
  "ReadMcpResourceTool",
  "Skill",
  "TaskOutput",
  "mcp__filesystem-with-morph__warpgrep_codebase_search",
  "mcp__exa__get_code_context_exa",
  "mcp__exa__web_search_exa",
  "mcp__exa__web_search",
  "mcp__exa__company_research_exa",
  "mcp__claude_ai_Cybertantra_Guru__search_lectures",
  "mcp__claude_ai_Cybertantra_Guru__query_guru",
  "mcp__qmd__search",
  "mcp__qmd__deep_search",
  "mcp__qmd__vector_search",
  "mcp__qmd__get",
  "mcp__qmd__status",
  "mcp__filesystem-with-morph__*",
  "mcp__exa__*",
  "mcp__claude_ai_Cybertantra_Guru__*",
  "mcp__qmd__*",
  "mcp__*",
] as const;

const NON_FATAL_PRE_RUN_STEP_TIMEOUT_MS = 1_500;

function firstToolNameFromSdkMessage(message: unknown): string | null {
  if (!message || typeof message !== "object") {
    return null;
  }
  const typed = message as {
    type?: unknown;
    message?: { content?: unknown };
  };
  if (typed.type !== "assistant") {
    return null;
  }
  const content = typed.message?.content;
  if (!Array.isArray(content)) {
    return null;
  }
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const typedBlock = block as { type?: unknown; name?: unknown };
    if (
      (typedBlock.type === "tool_use" || typedBlock.type === "server_tool_use") &&
      typeof typedBlock.name === "string" &&
      typedBlock.name.trim().length > 0
    ) {
      return typedBlock.name;
    }
  }
  return null;
}

function createAbortError(): Error {
  return new Error("Operation aborted.");
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) {
    return;
  }
  throw createAbortError();
}

function isAbortError(error: unknown, signal: AbortSignal): boolean {
  return (
    signal.aborted || (error instanceof Error && error.message.trim() === "Operation aborted.")
  );
}

async function awaitWithAbortTimeout<T>(input: {
  task: Promise<T>;
  signal: AbortSignal;
  timeoutMs: number;
  stepName: string;
}): Promise<T> {
  throwIfAborted(input.signal);
  let timeout: ReturnType<typeof setTimeout> | null = null;
  let removeAbortListener: () => void = () => {};
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      reject(new Error(`Timeout while ${input.stepName} (${input.timeoutMs}ms)`));
    }, input.timeoutMs);
  });
  const abortPromise = new Promise<never>((_, reject) => {
    const onAbort = () => {
      reject(createAbortError());
    };
    input.signal.addEventListener("abort", onAbort, { once: true });
    removeAbortListener = () => input.signal.removeEventListener("abort", onAbort);
  });

  try {
    return await Promise.race([input.task, timeoutPromise, abortPromise]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
    removeAbortListener();
  }
}

async function awaitBestEffortWithAbortTimeout<T>(input: {
  task: Promise<T>;
  signal: AbortSignal;
  timeoutMs: number;
  stepName: string;
  onFailure: (error: unknown) => void;
}): Promise<T | null> {
  try {
    return await awaitWithAbortTimeout({
      task: input.task,
      signal: input.signal,
      timeoutMs: input.timeoutMs,
      stepName: input.stepName,
    });
  } catch (error) {
    if (isAbortError(error, input.signal)) {
      throw error;
    }
    input.onFailure(error);
    return null;
  }
}

export function createUserMessageHandler(input: {
  isShuttingDown: () => boolean;
  suspendedChannels: Set<string>;
  pendingMessageRunsByChannel: Map<string, Promise<void>>;
  pendingRunAbortControllersByChannel: Map<string, AbortController>;
  queuedNoticesByMessageId: Map<string, QueueNoticeInfo>;
  liveToolTracesByChannel: Map<string, LiveToolTrace>;
  liveToolExpandStateByChannel: Map<string, Map<string, boolean>>;
  getToolExpanded: (channelId: string, toolId: string) => boolean;
  resolvePermissionModeForSession: (channelId: string) => {
    permissionMode: ClaudePermissionMode;
    mode: string;
  };
  sessions: SessionManager;
  repository: Repository;
  stopController: StopController;
  runner: ClaudeRunner;
  discordDispatch: DiscordDispatchQueue;
  config: {
    autoThreadWorktree: boolean;
    worktreeBootstrap: boolean;
    worktreeBootstrapCommand?: string;
  };
  runCommand: (command: string[], cwd: string) => Promise<{ exitCode: number; output: string }>;
  runBashCommand: (command: string, cwd: string) => Promise<{ exitCode: number; output: string }>;
  threadDebugger?: ThreadDebugger;
}): (
  message: Message,
  context?: {
    observedHumanUserCount: number;
    observedNonClaudeUserCount: number;
    participantNonClaudeUserCount: number | null;
    sharedChannel: boolean;
  },
) => Promise<void> {
  return async (
    message: Message,
    context?: {
      observedHumanUserCount: number;
      observedNonClaudeUserCount: number;
      participantNonClaudeUserCount: number | null;
      sharedChannel: boolean;
    },
  ) => {
    const channelId = message.channel.id;
    const authorId =
      typeof message.author?.id === "string" && message.author.id.length > 0
        ? message.author.id
        : null;
    const contentChars = typeof message.content === "string" ? message.content.length : 0;
    const attachmentCount =
      typeof message.attachments?.size === "number" ? message.attachments.size : 0;
    const observedNonClaudeUserCount =
      context?.observedNonClaudeUserCount ?? context?.observedHumanUserCount ?? 1;
    const sharedGuildChannel =
      Boolean(message.guildId) &&
      (typeof context?.sharedChannel === "boolean"
        ? context.sharedChannel
        : observedNonClaudeUserCount > 1);
    const directedUserId = sharedGuildChannel ? authorId : null;
    const directedPrefix = directedUserId ? `<@${directedUserId}> ` : "";
    const directedAllowedMentions = directedUserId
      ? ({
          parse: [],
          users: [directedUserId],
          repliedUser: true,
        } as const)
      : undefined;
    const runAbortController = new AbortController();
    const runAbortSignal = runAbortController.signal;
    const runId = input.threadDebugger?.nextRunId(channelId) ?? "";
    input.threadDebugger?.log({
      event: "message.received",
      channelId,
      runId,
      detail: {
        messageId: message.id,
        guildId: message.guildId ?? "dm",
        authorId: authorId ?? "unknown",
        contentChars,
        attachments: attachmentCount,
        observedNonClaudeUserCount,
        participantNonClaudeUserCount: context?.participantNonClaudeUserCount ?? null,
        sharedGuildChannel,
      },
    });
    if (input.suspendedChannels.has(channelId)) {
      input.threadDebugger?.log({
        event: "message.ignored_suspended",
        channelId,
        runId,
      });
      return;
    }
    const { channelSendTarget, queueChannelMessage, queueChannelSend } =
      createQueuedChannelDispatch({
        channelId,
        message,
        discordDispatch: input.discordDispatch,
      });

    let steerInfo: { text: string; cancelled: boolean } | null = null;
    let steerNoticeMessageId: string | null = null;

    const wasQueued = input.pendingMessageRunsByChannel.has(channelId);
    input.threadDebugger?.log({
      event: "queue.check",
      channelId,
      runId,
      detail: {
        wasQueued,
        activeQueueSize: input.pendingMessageRunsByChannel.size,
      },
    });
    if (wasQueued) {
      steerInfo = { text: getMessagePrompt(message), cancelled: false };
      try {
        const noticeMsg = await queueChannelMessage({
          content: "⏳ Run in progress for this channel. Queued your message.",
          components: buildQueueNoticeButtons(channelId, authorId ?? "unknown"),
        });
        steerNoticeMessageId = noticeMsg.id;
        input.queuedNoticesByMessageId.set(noticeMsg.id, steerInfo);
        input.threadDebugger?.log({
          event: "queue.notice_sent",
          channelId,
          runId,
          detail: { noticeMessageId: noticeMsg.id },
        });
      } catch {
        // Ignore queue notice failures.
        input.threadDebugger?.log({
          event: "queue.notice_failed",
          channelId,
          runId,
        });
      }
    }

    const previousRun = input.pendingMessageRunsByChannel.get(channelId) ?? Promise.resolve();
    const run = previousRun
      .catch(() => undefined)
      .then(async () => {
        input.threadDebugger?.log({
          event: "run.slot_acquired",
          channelId,
          runId,
        });
        input.pendingRunAbortControllersByChannel.set(channelId, runAbortController);
        throwIfAborted(runAbortSignal);
        if (steerNoticeMessageId) {
          input.queuedNoticesByMessageId.delete(steerNoticeMessageId);
          input.threadDebugger?.log({
            event: "queue.notice_cleared",
            channelId,
            runId,
            detail: { noticeMessageId: steerNoticeMessageId },
          });
        }
        if (steerInfo?.cancelled) {
          input.threadDebugger?.log({
            event: "run.skipped_cancelled",
            channelId,
            runId,
          });
          return;
        }
        throwIfAborted(runAbortSignal);
        if (input.suspendedChannels.has(channelId)) {
          input.threadDebugger?.log({
            event: "run.skipped_suspended",
            channelId,
            runId,
          });
          return;
        }
        if (input.isShuttingDown()) {
          input.threadDebugger?.log({
            event: "run.skipped_shutdown",
            channelId,
            runId,
          });
          try {
            await queueChannelMessage("⚠️ Bot is shutting down. Please retry in a moment.");
          } catch {
            // Ignore reply failures while shutting down.
          }
          return;
        }
        throwIfAborted(runAbortSignal);

        const guildId = message.guildId ?? "dm";
        input.threadDebugger?.log({
          event: "thread_context.inherit_start",
          channelId,
          runId,
          detail: { guildId },
        });
        await maybeInheritThreadContext({
          channel: message.channel,
          channelId,
          guildId,
          sessions: input.sessions,
          repository: input.repository,
          autoThreadWorktree: input.config.autoThreadWorktree,
          worktreeBootstrap: input.config.worktreeBootstrap,
          worktreeBootstrapCommand: input.config.worktreeBootstrapCommand,
          runCommand: input.runCommand,
        });
        input.threadDebugger?.log({
          event: "thread_context.inherit_done",
          channelId,
          runId,
        });
        throwIfAborted(runAbortSignal);
        const state = input.sessions.getState(channelId, guildId);
        const directBash = parseDirectBashCommand(message.content);
        if (directBash !== null) {
          input.threadDebugger?.log({
            event: "direct_bash.start",
            channelId,
            runId,
            detail: { commandChars: directBash.length },
          });
          await handleDirectBashMessage({
            directBash,
            workingDir: state.channel.workingDir,
            runBashCommand: input.runBashCommand,
            queueChannelMessage: async (payload) => await queueChannelMessage(payload),
            queueChannelSend: async (payload) => await queueChannelSend(payload),
          });
          input.threadDebugger?.log({
            event: "direct_bash.done",
            channelId,
            runId,
          });
          return;
        }

        const globalSystemPrompt = input.repository.getGlobalSystemPrompt();
        const channelSystemPrompt = input.repository.getChannelSystemPrompt(channelId);
        const composedSystemPrompt =
          [globalSystemPrompt, channelSystemPrompt].filter(Boolean).join("\n\n") || undefined;
        const pendingMergeContext = input.repository.getMergeContext(channelId);
        const stagedAttachments = await awaitWithAbortTimeout({
          task: stageAttachments(message),
          signal: runAbortSignal,
          timeoutMs: 15_000,
          stepName: "staging attachments",
        });
        const threadBranchEntries = input.repository.listThreadBranchMetaEntries();
        const threadBranchContext = buildThreadBranchAwarenessPrompt({
          currentChannelId: channelId,
          entries: threadBranchEntries,
        });
        const threadMeta = parseThreadBranchMeta(input.repository.getThreadBranchMeta(channelId));
        const forkSourceSessionId =
          !state.channel.sessionId && threadMeta?.forkSourceSessionId
            ? threadMeta.forkSourceSessionId
            : undefined;
        const resumeSessionId = state.channel.sessionId ?? forkSourceSessionId;
        const shouldForkSession = Boolean(forkSourceSessionId && !state.channel.sessionId);
        const runToolTrace = createLiveToolTrace();
        input.liveToolTracesByChannel.set(channelId, runToolTrace);
        input.liveToolExpandStateByChannel.set(channelId, new Map());

        await awaitBestEffortWithAbortTimeout({
          task: addReaction(message, "🧠"),
          signal: runAbortSignal,
          timeoutMs: NON_FATAL_PRE_RUN_STEP_TIMEOUT_MS,
          stepName: "adding reaction",
          onFailure: (error) => {
            const msg = error instanceof Error ? error.message : String(error);
            console.warn(
              `non-fatal pre-run step failed in channel ${channelId}: add reaction (${msg})`,
            );
            input.threadDebugger?.log({
              event: "run.non_fatal_step_failed",
              channelId,
              runId,
              detail: {
                step: "add_reaction",
                message: msg,
              },
            });
          },
        });
        await awaitBestEffortWithAbortTimeout({
          task: setThreadStatus(message.channel, "working"),
          signal: runAbortSignal,
          timeoutMs: NON_FATAL_PRE_RUN_STEP_TIMEOUT_MS,
          stepName: "setting thread status",
          onFailure: (error) => {
            const msg = error instanceof Error ? error.message : String(error);
            console.warn(
              `non-fatal pre-run step failed in channel ${channelId}: set thread status (${msg})`,
            );
            input.threadDebugger?.log({
              event: "run.non_fatal_step_failed",
              channelId,
              runId,
              detail: {
                step: "set_thread_status",
                message: msg,
              },
            });
          },
        });
        input.threadDebugger?.log({
          event: "run.status_message.start",
          channelId,
          runId,
        });
        const status = await input.discordDispatch.enqueue(`channel:${channelId}`, async () => {
          return await message.reply({
            content: `${directedPrefix}${toStreamingPreview("", "", THINKING_SPINNER_FRAMES[0])}`,
            components: buildStopButtons(channelId),
            ...(directedAllowedMentions ? { allowedMentions: directedAllowedMentions } : {}),
          });
        });
        input.threadDebugger?.log({
          event: "run.status_message.sent",
          channelId,
          runId,
        });
        const mergeContextPrefix = pendingMergeContext
          ? `${buildMergeContextInjection(pendingMergeContext)}\n\n`
          : "";
        const basePrompt = `${mergeContextPrefix}${threadBranchContext}${getMessagePrompt(message)}${stagedAttachments.promptSuffix}`;
        const prompt = withNoInteractiveToolDirective(basePrompt);
        const applyRunnerSafetyGuards = shouldApplyRunnerSafetyGuards(prompt);
        const guardedMaxTurns = applyRunnerSafetyGuards ? 8 : undefined;
        const guardedThinking = applyRunnerSafetyGuards
          ? ({ type: "disabled" } as const)
          : undefined;
        const guardedDisallowedTools = applyRunnerSafetyGuards
          ? [...SAFETY_DISALLOWED_TOOLS]
          : undefined;
        if (applyRunnerSafetyGuards) {
          console.warn(`runner guard active for channel ${channelId}: maxTurns=8`);
        }
        const seededPrompt = buildSeededPrompt(prompt, state.history, Boolean(resumeSessionId));
        const resumeFallbackPrompt = resumeSessionId
          ? buildSeededPrompt(prompt, state.history, false)
          : undefined;
        const abortController = runAbortController;
        let registeredRun: ActiveRun | null = null;
        const persistedFilenames = new Set<string>();
        const runawayToolGuard = createRunawayToolGuard();
        let runawayStopReason: string | null = null;
        const streamingStatus = createStreamingStatusController({
          channelId,
          status,
          discordDispatch: input.discordDispatch,
          contentPrefix: directedPrefix,
          ...(directedAllowedMentions ? { allowedMentions: directedAllowedMentions } : {}),
        });
        const liveToolMessages = createLiveToolMessageController({
          channelId,
          runToolTrace,
          discordDispatch: input.discordDispatch,
          toolSendTarget: channelSendTarget,
          getToolExpanded: (toolId) => input.getToolExpanded(channelId, toolId),
        });
        liveToolMessages.startPolling();

        const runStartAt = Date.now();
        let runOutcome: "success" | "error" | "interrupted" | "turn_limit" = "error";
        let sdkMessageCount = 0;
        let textDeltaChars = 0;
        let thinkingDeltaChars = 0;
        void runHook({
          hookName: "run_start",
          workingDir: state.channel.workingDir,
          env: {
            COD_THREAD_ID: channelId,
            COD_WORKING_DIR: state.channel.workingDir,
            COD_PROMPT_PREVIEW: prompt.slice(0, 300),
          },
        });

        try {
          input.threadDebugger?.log({
            event: "run.start",
            channelId,
            runId,
            detail: {
              workingDir: state.channel.workingDir,
              hasSessionId: Boolean(state.channel.sessionId),
              resumeSessionId,
              shouldForkSession,
              model: state.channel.model,
            },
          });
          input.sessions.appendTurn(channelId, {
            role: "user",
            content: buildStoredUserTurnContent(message),
          });
          const permissionPolicy = input.resolvePermissionModeForSession(channelId);

          const result = await input.runner.run({
            channelId,
            prompt: seededPrompt,
            ...(resumeFallbackPrompt ? { resumeFallbackPrompt } : {}),
            cwd: state.channel.workingDir,
            ...(resumeSessionId ? { sessionId: resumeSessionId } : {}),
            ...(shouldForkSession ? { forkSession: true } : {}),
            model: state.channel.model,
            systemPrompt: composedSystemPrompt,
            permissionMode: permissionPolicy.permissionMode,
            ...(applyRunnerSafetyGuards ? { disableResume: true } : {}),
            ...(typeof guardedMaxTurns === "number" ? { maxTurns: guardedMaxTurns } : {}),
            ...(guardedThinking ? { thinking: guardedThinking } : {}),
            ...(guardedDisallowedTools ? { disallowedTools: guardedDisallowedTools } : {}),
            abortController,
            onQueryStart: (query) => {
              registeredRun = input.stopController.register(channelId, { query, abortController });
              logRunnerSkillDebug(channelId, query);
              input.threadDebugger?.log({
                event: "runner.query_start",
                channelId,
                runId,
              });
            },
            onTextDelta: (textDelta) => {
              streamingStatus.appendText(textDelta);
              textDeltaChars += textDelta.length;
            },
            onThinkingDelta: (thinkingDelta) => {
              streamingStatus.appendThinking(thinkingDelta);
              thinkingDeltaChars += thinkingDelta.length;
            },
            onMessage: (sdkMessage) => {
              sdkMessageCount += 1;
              const guardedToolName = applyRunnerSafetyGuards
                ? firstToolNameFromSdkMessage(sdkMessage)
                : null;
              const typedMessage = sdkMessage as { type?: unknown; subtype?: unknown };
              input.threadDebugger?.log({
                event: "runner.sdk_message",
                channelId,
                runId,
                detail: {
                  index: sdkMessageCount,
                  type: typedMessage.type,
                  subtype: typedMessage.subtype,
                  tool: guardedToolName,
                },
              });
              if (guardedToolName) {
                runawayStopReason =
                  runawayStopReason ??
                  `Stopped safety-guarded run after blocked tool call: ${guardedToolName}.`;
              }
              runawayStopReason = runawayStopReason ?? runawayToolGuard.observeMessage(sdkMessage);
              if (runawayStopReason && !abortController.signal.aborted) {
                console.warn(`runner runaway guard in channel ${channelId}: ${runawayStopReason}`);
                input.threadDebugger?.log({
                  event: "runner.runaway_abort",
                  channelId,
                  runId,
                  detail: { reason: runawayStopReason },
                });
                abortController.abort();
              }
              if (sdkMessage.type === "system" && sdkMessage.subtype === "files_persisted") {
                for (const file of sdkMessage.files) {
                  persistedFilenames.add(file.filename);
                }
              }
              if (applyToolMessageToTrace(runToolTrace, sdkMessage)) {
                for (const toolId of collectToolIdsFromMessage(runToolTrace, sdkMessage)) {
                  liveToolMessages.queueToolMessageRender(toolId);
                }
              }
            },
          });

          liveToolMessages.stopPolling();
          await streamingStatus.close();

          if (result.sessionId) {
            input.sessions.setSessionId(channelId, result.sessionId);
            if (threadMeta?.forkSourceSessionId) {
              const restMeta = { ...threadMeta, forkSourceSessionId: undefined };
              saveThreadBranchMeta(input.repository, restMeta);
            }
          }

          if (pendingMergeContext) {
            input.repository.clearMergeContext(channelId);
          }

          const outputText = result.text.trim();
          const structuredAttachments = extractStructuredAttachmentDirectives(outputText);
          const cleanedOutputText = structuredAttachments.cleanedText.trim();
          const resultSubtype = result.messages.find(
            (sdkMessage) => sdkMessage.type === "result",
          )?.subtype;
          const hitTurnLimit = resultSubtype === "error_max_turns";
          const interrupted = input.stopController.wasInterrupted(channelId);
          input.threadDebugger?.log({
            event: "run.result",
            channelId,
            runId,
            detail: {
              interrupted,
              hitTurnLimit,
              resultSubtype: resultSubtype ?? null,
              outputChars: result.text.length,
              sdkMessageCount,
              textDeltaChars,
              thinkingDeltaChars,
            },
          });
          finalizeLiveToolTrace(runToolTrace, interrupted ? "interrupted" : "success");
          for (const toolId of runToolTrace.order) {
            liveToolMessages.queueToolMessageRender(toolId);
          }
          const baseFinalText =
            cleanedOutputText.length > 0
              ? cleanedOutputText
              : structuredAttachments.filenames.length > 0
                ? "Attached generated file(s)."
                : interrupted
                  ? "Interrupted."
                  : "(No response text)";
          const finalText = hitTurnLimit
            ? `${baseFinalText}\n\nStopped early by a safety turn limit. Re-run with a narrower ask and I will continue.`
            : baseFinalText;
          input.sessions.appendTurn(channelId, {
            role: "assistant",
            content: finalText,
          });

          const finalPreview = streamingStatus.buildFinalPreview(finalText);
          await input.discordDispatch.enqueue(`status:${channelId}`, async () => {
            await status.edit({
              content: finalPreview,
              components: [],
            });
          });

          if (finalPreview.includes("...[truncated live preview]...")) {
            const chunks = chunkDiscordText(finalText);
            for (const chunk of chunks) {
              if (chunk) {
                await queueChannelSend(chunk);
              }
            }
          }

          const attachmentChannel = channelSendTarget
            ? {
                send: async (payload: unknown) => {
                  return await input.discordDispatch.enqueue(
                    `channel:${channelId}`,
                    async () => await channelSendTarget.send(payload),
                  );
                },
              }
            : message.channel;

          await sendGeneratedFilesToChannel({
            channel: attachmentChannel,
            workingDir: state.channel.workingDir,
            filenames: new Set([
              ...persistedFilenames,
              ...structuredAttachments.filenames,
              ...extractAttachmentPathCandidates(outputText),
            ]),
          });

          await removeReaction(message, "🧠");
          await addReaction(message, "✅");
          runOutcome = interrupted ? "interrupted" : hitTurnLimit ? "turn_limit" : "success";
          await awaitBestEffortWithAbortTimeout({
            task: setThreadStatus(message.channel, "needsAttention"),
            signal: runAbortSignal,
            timeoutMs: NON_FATAL_PRE_RUN_STEP_TIMEOUT_MS,
            stepName: "setting thread status",
            onFailure: (error) => {
              const msg = error instanceof Error ? error.message : String(error);
              console.warn(
                `non-fatal post-run step failed in channel ${channelId}: set thread status (${msg})`,
              );
              input.threadDebugger?.log({
                event: "run.non_fatal_step_failed",
                channelId,
                runId,
                detail: {
                  step: "set_thread_status",
                  message: msg,
                },
              });
            },
          });
        } catch (error) {
          const abortedBySignal = runAbortSignal.aborted;
          input.threadDebugger?.log({
            event: "run.error",
            channelId,
            runId,
            detail: {
              message: error instanceof Error ? error.message : String(error),
              runawayStopReason,
              interrupted: input.stopController.wasInterrupted(channelId),
              abortedBySignal,
            },
          });
          liveToolMessages.stopPolling();
          await streamingStatus.close({ drain: !abortedBySignal });
          finalizeLiveToolTrace(
            runToolTrace,
            input.stopController.wasInterrupted(channelId) || abortedBySignal
              ? "interrupted"
              : "failed",
          );
          for (const toolId of runToolTrace.order) {
            liveToolMessages.queueToolMessageRender(toolId);
          }

          const msg = runawayStopReason ?? formatErrorMessage(error);
          const abortedError =
            abortedBySignal ||
            (error instanceof Error && error.message.trim() === "Operation aborted.");

          if (abortedError && !runawayStopReason) {
            runOutcome = "interrupted";
            await removeReaction(message, "🧠");
            await addReaction(message, "⚠️");
            await awaitBestEffortWithAbortTimeout({
              task: setThreadStatus(message.channel, "needsAttention"),
              signal: runAbortSignal,
              timeoutMs: NON_FATAL_PRE_RUN_STEP_TIMEOUT_MS,
              stepName: "setting thread status",
              onFailure: (statusError) => {
                const msg =
                  statusError instanceof Error ? statusError.message : String(statusError);
                console.warn(
                  `non-fatal abort step failed in channel ${channelId}: set thread status (${msg})`,
                );
                input.threadDebugger?.log({
                  event: "run.non_fatal_step_failed",
                  channelId,
                  runId,
                  detail: {
                    step: "set_thread_status",
                    message: msg,
                  },
                });
              },
            });
            input.threadDebugger?.log({
              event: "run.abort_handled_fast",
              channelId,
              runId,
            });
            return;
          }

          if (runawayStopReason) {
            console.warn(`runner run interrupted in channel ${channelId}: ${msg}`);
          } else {
            console.error(`runner failure in channel ${channelId}: ${msg}`);
          }
          await notifyRunFailure({
            channelId,
            msg,
            runawayStop: Boolean(runawayStopReason),
            status,
            discordDispatch: input.discordDispatch,
            contentPrefix: directedPrefix,
            ...(directedAllowedMentions ? { allowedMentions: directedAllowedMentions } : {}),
            queueChannelMessage: async (payload) => await queueChannelMessage(payload),
          });
          await removeReaction(message, "🧠");
          await addReaction(message, runawayStopReason ? "⚠️" : "❌");
          runOutcome =
            input.stopController.wasInterrupted(channelId) || runawayStopReason
              ? "interrupted"
              : "error";
          await awaitBestEffortWithAbortTimeout({
            task: setThreadStatus(message.channel, runawayStopReason ? "needsAttention" : "error"),
            signal: runAbortSignal,
            timeoutMs: NON_FATAL_PRE_RUN_STEP_TIMEOUT_MS,
            stepName: "setting thread status",
            onFailure: (statusError) => {
              const statusErrorMessage =
                statusError instanceof Error ? statusError.message : String(statusError);
              console.warn(
                `non-fatal error step failed in channel ${channelId}: set thread status (${statusErrorMessage})`,
              );
              input.threadDebugger?.log({
                event: "run.non_fatal_step_failed",
                channelId,
                runId,
                detail: {
                  step: "set_thread_status",
                  message: statusErrorMessage,
                },
              });
            },
          });
        } finally {
          input.threadDebugger?.log({
            event: "run.finally.start",
            channelId,
            runId,
            detail: { runOutcome },
          });
          // Release queue slot immediately so the next user message isn't
          // held behind file cleanup / stopController teardown.  The outer
          // finally is kept as a safety net for unexpected early exits.
          if (input.pendingMessageRunsByChannel.get(channelId) === run) {
            input.pendingMessageRunsByChannel.delete(channelId);
            input.threadDebugger?.log({
              event: "queue.slot_released_inner",
              channelId,
              runId,
            });
          }
          if (input.pendingRunAbortControllersByChannel.get(channelId) === runAbortController) {
            input.pendingRunAbortControllersByChannel.delete(channelId);
          }
          liveToolMessages.stopPolling();
          void runHook({
            hookName: "run_end",
            workingDir: state.channel.workingDir,
            env: {
              COD_THREAD_ID: channelId,
              COD_WORKING_DIR: state.channel.workingDir,
              COD_RESULT: runOutcome,
              COD_DURATION_MS: String(Date.now() - runStartAt),
            },
          });
          await cleanupFiles(stagedAttachments.stagedPaths);
          if (registeredRun) {
            input.stopController.clear(channelId, registeredRun);
          }
          input.threadDebugger?.log({
            event: "run.finally.done",
            channelId,
            runId,
            detail: {
              durationMs: Date.now() - runStartAt,
              hadRegisteredRun: Boolean(registeredRun),
            },
          });
        }
      });

    input.pendingMessageRunsByChannel.set(channelId, run);
    input.threadDebugger?.log({
      event: "queue.slot_reserved",
      channelId,
      runId,
      detail: { activeQueueSize: input.pendingMessageRunsByChannel.size },
    });
    try {
      await run;
      input.threadDebugger?.log({
        event: "run.await_complete",
        channelId,
        runId,
      });
    } catch (error) {
      const aborted = isAbortError(error, runAbortSignal);
      if (!aborted) {
        throw error;
      }
      input.threadDebugger?.log({
        event: "run.await_aborted",
        channelId,
        runId,
      });
    } finally {
      // Safety net: inner finally should have already deleted this, but
      // guard against any unexpected early exit from the .then() callback.
      if (input.pendingMessageRunsByChannel.get(channelId) === run) {
        input.pendingMessageRunsByChannel.delete(channelId);
        input.threadDebugger?.log({
          event: "queue.slot_released_outer",
          channelId,
          runId,
        });
      }
      if (input.pendingRunAbortControllersByChannel.get(channelId) === runAbortController) {
        input.pendingRunAbortControllersByChannel.delete(channelId);
      }
    }
  };
}
