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
  buildSingleLiveToolMessage,
  collectToolIdsFromMessage,
  createLiveToolTrace,
  finalizeLiveToolTrace,
  type LiveToolRenderPayload,
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
  canEditSentMessage,
  canSendMessage,
  type EditableSentMessage,
  maybeInheritThreadContext,
  saveThreadBranchMeta,
  setThreadState,
} from "./thread-lifecycle";
import { extractAttachmentPathCandidates, extractStructuredAttachmentDirectives, formatErrorMessage, sendGeneratedFilesToChannel, cleanupFiles } from "./file-artifacts";

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
    const channelSendTarget = canSendMessage(message.channel) ? message.channel : null;
    const queueChannelMessage = async (
      payload: Parameters<typeof message.reply>[0],
    ): Promise<Awaited<ReturnType<typeof message.reply>>> => {
      return await input.discordDispatch.enqueue(
        `channel:${channelId}`,
        async () => await message.reply(payload),
      );
    };
    const queueChannelSend = async (payload: unknown): Promise<unknown | null> => {
      if (!channelSendTarget) {
        return null;
      }
      return await input.discordDispatch.enqueue(
        `channel:${channelId}`,
        async () => await channelSendTarget.send(payload),
      );
    };

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
          if (!directBash) {
            await queueChannelMessage(
              "Direct shell mode expects a command after `!` (example: `!git status`).",
            );
            return;
          }

          const result = await input.runBashCommand(directBash, state.channel.workingDir);
          const outputText = result.output || "(no output)";
          const payload = `\`\`\`bash\n$ ${directBash}\n${outputText}\n[exit ${result.exitCode}]\n\`\`\``;
          const chunks = chunkDiscordText(payload);
          const firstChunk = chunks[0] ?? "(no output)";
          await queueChannelMessage(firstChunk);
          for (let i = 1; i < chunks.length; i++) {
            const chunk = chunks[i];
            if (chunk) {
              await queueChannelSend(chunk);
            }
          }
          return;
        }

        const channelSystemPrompt = input.repository.getChannelSystemPrompt(channelId);
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
        await setThreadState(message.channel, null);
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
        const guardedDisallowedTools = applyRunnerSafetyGuards ? ["Task"] : undefined;
        const guardedMaxTurns = applyRunnerSafetyGuards ? 2 : undefined;
        const guardedThinking = applyRunnerSafetyGuards ? ({ type: "disabled" } as const) : undefined;
        if (applyRunnerSafetyGuards) {
          console.warn(`runner guard active for channel ${channelId}: Task disabled, maxTurns=2`);
        }
        const seededPrompt = buildSeededPrompt(prompt, state.history, Boolean(resumeSessionId));
        const resumeFallbackPrompt = resumeSessionId
          ? buildSeededPrompt(prompt, state.history, false)
          : undefined;
        const abortController = new AbortController();
        const persistedFilenames = new Set<string>();
        let streamedText = "";
        let streamedThinking = "";
        let streamClosed = false;
        let streamFlushTimer: ReturnType<typeof setTimeout> | null = null;
        let streamSpinnerTimer: ReturnType<typeof setInterval> | null = null;
        let streamToolRenderTimer: ReturnType<typeof setInterval> | null = null;
        let streamSpinnerFrameIndex = 0;
        let statusEditQueue: Promise<void> = Promise.resolve();
        let statusEditInFlight = false;
        let pendingStatusEdit: { content: string; includeButtons: boolean } | null = null;
        const toolSendTarget = canSendMessage(message.channel) ? message.channel : null;
        const toolMessagesById = new Map<string, EditableSentMessage>();
        const pendingToolMessageContent = new Map<string, LiveToolRenderPayload>();
        const toolMessageEditInFlight = new Set<string>();

        const queueStatusEdit = (content: string, includeButtons: boolean): Promise<void> => {
          pendingStatusEdit = { content, includeButtons };
          if (statusEditInFlight) {
            return statusEditQueue;
          }

          statusEditInFlight = true;
          statusEditQueue = (async () => {
            while (pendingStatusEdit) {
              const edit = pendingStatusEdit;
              pendingStatusEdit = null;
              try {
                await input.discordDispatch.enqueue(`status:${channelId}`, async () => {
                  await status.edit({
                    content: edit.content,
                    components: edit.includeButtons ? buildStopButtons(channelId) : [],
                  });
                });
              } catch {
                // Ignore transient edit failures to keep stream moving.
              }
            }
            statusEditInFlight = false;
          })();
          return statusEditQueue;
        };

        const flushStreamPreview = () => {
          streamFlushTimer = null;
          if (streamClosed) {
            return;
          }
          void queueStatusEdit(
            toStreamingPreview(
              streamedText,
              streamedThinking,
              THINKING_SPINNER_FRAMES[streamSpinnerFrameIndex % THINKING_SPINNER_FRAMES.length],
            ),
            true,
          );
        };

        const scheduleStreamPreview = () => {
          if (streamClosed || streamFlushTimer) {
            return;
          }
          streamFlushTimer = setTimeout(flushStreamPreview, 300);
        };

        const stopSpinner = () => {
          if (!streamSpinnerTimer) {
            return;
          }
          clearInterval(streamSpinnerTimer);
          streamSpinnerTimer = null;
        };

        const stopToolRenderTimer = () => {
          if (!streamToolRenderTimer) {
            return;
          }
          clearInterval(streamToolRenderTimer);
          streamToolRenderTimer = null;
        };

        streamSpinnerTimer = setInterval(() => {
          if (streamClosed) {
            return;
          }
          streamSpinnerFrameIndex =
            (streamSpinnerFrameIndex + 1) % THINKING_SPINNER_FRAMES.length;
          void queueStatusEdit(
            toStreamingPreview(
              streamedText,
              streamedThinking,
              THINKING_SPINNER_FRAMES[streamSpinnerFrameIndex % THINKING_SPINNER_FRAMES.length],
            ),
            true,
          );
        }, 900);

        const queueToolMessageRender = (toolId: string) => {
          const entry = runToolTrace.byId.get(toolId);
          if (!entry || !toolSendTarget) {
            return;
          }
          pendingToolMessageContent.set(
            toolId,
            buildSingleLiveToolMessage(entry, {
              channelId,
              expanded: input.getToolExpanded(channelId, toolId),
            }),
          );
          if (toolMessageEditInFlight.has(toolId)) {
            return;
          }
          toolMessageEditInFlight.add(toolId);
          void (async () => {
            while (pendingToolMessageContent.has(toolId)) {
              const nextContent = pendingToolMessageContent.get(toolId);
              pendingToolMessageContent.delete(toolId);
              if (!nextContent) {
                continue;
              }
              try {
                const existing = toolMessagesById.get(toolId);
                if (existing) {
                  await input.discordDispatch.enqueue(`tool:${channelId}:${toolId}`, async () => {
                    await existing.edit(nextContent);
                  });
                } else {
                  const sent = await input.discordDispatch.enqueue(
                    `tool:${channelId}:${toolId}`,
                    async () => await toolSendTarget.send(nextContent),
                  );
                  if (canEditSentMessage(sent)) {
                    toolMessagesById.set(toolId, sent);
                  }
                }
              } catch {
                // Ignore tool message send/edit failures to keep primary run stable.
              }
            }
            toolMessageEditInFlight.delete(toolId);
          })();
        };

        streamToolRenderTimer = setInterval(() => {
          if (streamClosed) {
            return;
          }
          for (const toolId of runToolTrace.order) {
            const entry = runToolTrace.byId.get(toolId);
            if (!entry) {
              continue;
            }
            if (entry.status === "running" || entry.status === "queued") {
              queueToolMessageRender(toolId);
            }
          }
        }, 1000);

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
            systemPrompt: channelSystemPrompt ?? undefined,
            permissionMode: permissionPolicy.permissionMode,
            ...(guardedDisallowedTools ? { disallowedTools: guardedDisallowedTools } : {}),
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
              streamedText += textDelta;
              scheduleStreamPreview();
            },
            onThinkingDelta: (thinkingDelta) => {
              streamedThinking += thinkingDelta;
              scheduleStreamPreview();
            },
            onMessage: (sdkMessage) => {
              if (sdkMessage.type === "system" && sdkMessage.subtype === "files_persisted") {
                for (const file of sdkMessage.files) {
                  persistedFilenames.add(file.filename);
                }
              }
              if (applyToolMessageToTrace(runToolTrace, sdkMessage)) {
                for (const toolId of collectToolIdsFromMessage(runToolTrace, sdkMessage)) {
                  queueToolMessageRender(toolId);
                }
              }
            },
          });

          if (streamFlushTimer) {
            clearTimeout(streamFlushTimer);
            streamFlushTimer = null;
          }
          stopSpinner();
          stopToolRenderTimer();
          streamClosed = true;
          await statusEditQueue;

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
            queueToolMessageRender(toolId);
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

          const finalPreview = toStreamingPreview(finalText, streamedThinking);
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
          await setThreadState(message.channel, "⚠️");
        } catch (error) {
          if (streamFlushTimer) {
            clearTimeout(streamFlushTimer);
            streamFlushTimer = null;
          }
          stopSpinner();
          stopToolRenderTimer();
          streamClosed = true;
          await statusEditQueue;
          finalizeLiveToolTrace(
            runToolTrace,
            input.stopController.wasInterrupted(channelId) ? "interrupted" : "failed",
          );
          for (const toolId of runToolTrace.order) {
            queueToolMessageRender(toolId);
          }

          const msg = formatErrorMessage(error);
          console.error(`runner failure in channel ${channelId}: ${msg}`);
          let surfacedByStatus = false;
          try {
            await input.discordDispatch.enqueue(`status:${channelId}`, async () => {
              await status.edit({
                content: `❌ ${msg}`,
                components: [],
              });
            });
            surfacedByStatus = true;
          } catch {
            // Keep run failures contained even if the status message can no longer be edited.
          }
          if (!surfacedByStatus) {
            try {
              await queueChannelMessage(`❌ ${msg}`);
            } catch (notifyError) {
              const detail = notifyError instanceof Error ? notifyError.message : String(notifyError);
              console.error(`failed to send failure notice for ${channelId}: ${detail}`);
            }
          }
          await removeReaction(message, "🧠");
          await addReaction(message, "❌");
          await setThreadState(message.channel, "❌");
        } finally {
          stopSpinner();
          stopToolRenderTimer();
          await cleanupFiles(stagedAttachments.stagedPaths);
          input.stopController.clear(channelId);
        }
      });

    input.pendingMessageRunsByChannel.set(channelId, run);
    try {
      await run;
    } finally {
      if (input.pendingMessageRunsByChannel.get(channelId) === run) {
        input.pendingMessageRunsByChannel.delete(channelId);
      }
    }
  };
}
