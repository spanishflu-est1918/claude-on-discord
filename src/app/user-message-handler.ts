import type { Message } from "discord.js";
import type { ClaudeRunner } from "../claude/runner";
import type { SessionManager } from "../claude/session";
import type { StopController } from "../claude/stop";
import type { Repository } from "../db/repository";
import type { ClaudePermissionMode } from "../types";
import { buildQueueNoticeButtons, buildStopButtons } from "../discord/buttons";
import { chunkDiscordText } from "../discord/chunker";
import { type DiscordDispatchQueue } from "../discord/dispatcher";
import { buildThreadBranchAwarenessPrompt, parseThreadBranchMeta } from "../discord/thread-branch";
import type { QueueNoticeInfo } from "./button-interactions";
import {
  buildMergeContextInjection,
  buildSeededPrompt,
  parseDirectBashCommand,
} from "./conversation-helpers";
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
import {
  shouldApplyRunnerSafetyGuards,
  withNoInteractiveToolDirective,
} from "./prompt-directives";
import {
  maybeInheritThreadContext,
  saveThreadBranchMeta,
  setThreadStatus,
} from "./thread-lifecycle";
import {
  cleanupFiles,
  extractAttachmentPathCandidates,
  extractStructuredAttachmentDirectives,
  formatErrorMessage,
  sendGeneratedFilesToChannel,
} from "./file-artifacts";
import { createRunawayToolGuard } from "./runaway-tool-guard";
import { handleDirectBashMessage } from "./direct-bash-handler";
import { createStreamingStatusController } from "./streaming-status-controller";
import { createLiveToolMessageController } from "./live-tool-message-controller";
import { notifyRunFailure } from "./run-failure-notifier";
import { createQueuedChannelDispatch } from "./queued-channel-dispatch";
import { runHook } from "../discord/hook-runner";

export function createUserMessageHandler(input: {
  isShuttingDown: () => boolean;
  suspendedChannels: Set<string>;
  pendingMessageRunsByChannel: Map<string, Promise<void>>;
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
}): (message: Message) => Promise<void> {
  return async (message: Message) => {
    const channelId = message.channel.id;
    if (input.suspendedChannels.has(channelId)) {
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
    if (wasQueued) {
      steerInfo = { text: getMessagePrompt(message), cancelled: false };
      try {
        const noticeMsg = await queueChannelMessage({
          content: "⏳ Run in progress for this channel. Queued your message.",
          components: buildQueueNoticeButtons(channelId, message.author.id),
        });
        steerNoticeMessageId = noticeMsg.id;
        input.queuedNoticesByMessageId.set(noticeMsg.id, steerInfo);
      } catch {
        // Ignore queue notice failures.
      }
    }

    const previousRun = input.pendingMessageRunsByChannel.get(channelId) ?? Promise.resolve();
    const run = previousRun
      .catch(() => undefined)
      .then(async () => {
        if (steerNoticeMessageId) {
          input.queuedNoticesByMessageId.delete(steerNoticeMessageId);
        }
        if (steerInfo?.cancelled) {
          return;
        }
        if (input.suspendedChannels.has(channelId)) {
          return;
        }
        if (input.isShuttingDown()) {
          try {
            await queueChannelMessage("⚠️ Bot is shutting down. Please retry in a moment.");
          } catch {
            // Ignore reply failures while shutting down.
          }
          return;
        }

        const guildId = message.guildId ?? "dm";
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
        const state = input.sessions.getState(channelId, guildId);
        const directBash = parseDirectBashCommand(message.content);
        if (directBash !== null) {
          await handleDirectBashMessage({
            directBash,
            workingDir: state.channel.workingDir,
            runBashCommand: input.runBashCommand,
            queueChannelMessage: async (payload) => await queueChannelMessage(payload),
            queueChannelSend: async (payload) => await queueChannelSend(payload),
          });
          return;
        }

        const globalSystemPrompt = input.repository.getGlobalSystemPrompt();
        const channelSystemPrompt = input.repository.getChannelSystemPrompt(channelId);
        const composedSystemPrompt =
          [globalSystemPrompt, channelSystemPrompt].filter(Boolean).join("\n\n") || undefined;
        const pendingMergeContext = input.repository.getMergeContext(channelId);
        const stagedAttachments = await stageAttachments(message);
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

        await addReaction(message, "🧠");
        await setThreadStatus(message.channel, "working");
        const status = await input.discordDispatch.enqueue(`channel:${channelId}`, async () => {
          return await message.reply({
            content: toStreamingPreview("", "", THINKING_SPINNER_FRAMES[0]),
            components: buildStopButtons(channelId),
          });
        });
        const mergeContextPrefix = pendingMergeContext
          ? `${buildMergeContextInjection(pendingMergeContext)}\n\n`
          : "";
        const basePrompt = `${mergeContextPrefix}${threadBranchContext}${getMessagePrompt(message)}${stagedAttachments.promptSuffix}`;
        const prompt = withNoInteractiveToolDirective(basePrompt);
        const applyRunnerSafetyGuards = shouldApplyRunnerSafetyGuards(prompt);
        const guardedMaxTurns = applyRunnerSafetyGuards ? 8 : undefined;
        const guardedThinking = applyRunnerSafetyGuards ? ({ type: "disabled" } as const) : undefined;
        if (applyRunnerSafetyGuards) {
          console.warn(`runner guard active for channel ${channelId}: maxTurns=8`);
        }
        const seededPrompt = buildSeededPrompt(prompt, state.history, Boolean(resumeSessionId));
        const resumeFallbackPrompt = resumeSessionId
          ? buildSeededPrompt(prompt, state.history, false)
          : undefined;
        const abortController = new AbortController();
        const persistedFilenames = new Set<string>();
        const runawayToolGuard = createRunawayToolGuard();
        let runawayStopReason: string | null = null;
        const streamingStatus = createStreamingStatusController({
          channelId,
          status,
          discordDispatch: input.discordDispatch,
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
            ...(typeof guardedMaxTurns === "number" ? { maxTurns: guardedMaxTurns } : {}),
            ...(guardedThinking ? { thinking: guardedThinking } : {}),
            abortController,
            onQueryStart: (query) => {
              input.stopController.register(channelId, { query, abortController });
              if (process.env.DEBUG_SKILL_LOADS === "1") {
                void (async () => {
                  try {
                    const commands = await query.supportedCommands();
                    const names = commands.map((command) => command.name);
                    const flagged = names.filter(
                      (name) =>
                        name.includes(":") ||
                        /(?:skill|agent|docs|review|security|feature|design)/i.test(name),
                    );
                    const preview = flagged.slice(0, 30).join(", ");
                    console.log(
                      `[skill-debug] channel=${channelId} commands=${names.length} flagged=${flagged.length}${preview ? ` names=${preview}` : ""}`,
                    );
                  } catch (error) {
                    const detail = error instanceof Error ? error.message : String(error);
                    console.error(`[skill-debug] failed in ${channelId}: ${detail}`);
                  }
                })();
              }
            },
            onTextDelta: (textDelta) => {
              streamingStatus.appendText(textDelta);
            },
            onThinkingDelta: (thinkingDelta) => {
              streamingStatus.appendThinking(thinkingDelta);
            },
            onMessage: (sdkMessage) => {
              runawayStopReason = runawayStopReason ?? runawayToolGuard.observeMessage(sdkMessage);
              if (runawayStopReason && !abortController.signal.aborted) {
                console.warn(`runner runaway guard in channel ${channelId}: ${runawayStopReason}`);
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
          const resultSubtype = result.messages.find((sdkMessage) => sdkMessage.type === "result")
            ?.subtype;
          const hitTurnLimit = resultSubtype === "error_max_turns";
          const interrupted = input.stopController.wasInterrupted(channelId);
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
          await setThreadStatus(message.channel, "needsAttention");
        } catch (error) {
          liveToolMessages.stopPolling();
          await streamingStatus.close();
          finalizeLiveToolTrace(
            runToolTrace,
            input.stopController.wasInterrupted(channelId) ? "interrupted" : "failed",
          );
          for (const toolId of runToolTrace.order) {
            liveToolMessages.queueToolMessageRender(toolId);
          }

          const msg = runawayStopReason ?? formatErrorMessage(error);
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
            queueChannelMessage: async (payload) => await queueChannelMessage(payload),
          });
          await removeReaction(message, "🧠");
          await addReaction(message, runawayStopReason ? "⚠️" : "❌");
          runOutcome =
            input.stopController.wasInterrupted(channelId) || runawayStopReason
              ? "interrupted"
              : "error";
          await setThreadStatus(message.channel, runawayStopReason ? "needsAttention" : "error");
        } finally {
          // Release queue slot immediately so the next user message isn't
          // held behind file cleanup / stopController teardown.  The outer
          // finally is kept as a safety net for unexpected early exits.
          if (input.pendingMessageRunsByChannel.get(channelId) === run) {
            input.pendingMessageRunsByChannel.delete(channelId);
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
          input.stopController.clear(channelId);
        }
      });

    input.pendingMessageRunsByChannel.set(channelId, run);
    try {
      await run;
    } finally {
      // Safety net: inner finally should have already deleted this, but
      // guard against any unexpected early exit from the .then() callback.
      if (input.pendingMessageRunsByChannel.get(channelId) === run) {
        input.pendingMessageRunsByChannel.delete(channelId);
      }
    }
  };
}
