import { existsSync, statSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { type Message, MessageFlags } from "discord.js";
import { ClaudeRunner } from "./claude/runner";
import { SessionManager } from "./claude/session";
import { StopController } from "./claude/stop";
import type { AppConfig } from "./config";
import { Repository } from "./db/repository";
import { openDatabase } from "./db/schema";
import {
  buildProjectSwitchButtons,
  buildStopButtons,
  parseProjectSwitchCustomId,
  parseRunControlCustomId,
} from "./discord/buttons";
import { chunkDiscordText } from "./discord/chunker";
import { startDiscordClient } from "./discord/client";
import { registerSlashCommands } from "./discord/commands";

function getMessagePrompt(message: Message): string {
  if (message.content.trim().length > 0) {
    return message.content;
  }
  return "User sent attachments. Describe what they sent and ask how to help.";
}

function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_");
}

async function stageAttachments(message: Message): Promise<{
  stagedPaths: string[];
  promptSuffix: string;
}> {
  if (message.attachments.size === 0) {
    return { stagedPaths: [], promptSuffix: "" };
  }

  const stagedPaths: string[] = [];
  const promptLines: string[] = ["", "User included attachments saved locally:"];
  let index = 0;

  for (const attachment of message.attachments.values()) {
    const filename = sanitizeFilename(attachment.name ?? `attachment-${index + 1}.bin`);
    const targetPath = path.join(tmpdir(), `claude-on-discord-${Date.now()}-${index}-${filename}`);

    try {
      const response = await fetch(attachment.url);
      if (!response.ok) {
        promptLines.push(`- ${filename}: failed to download (${response.status})`);
        index += 1;
        continue;
      }

      const buffer = await response.arrayBuffer();
      await Bun.write(targetPath, buffer);
      stagedPaths.push(targetPath);
      promptLines.push(`- ${filename}: ${targetPath}`);
    } catch {
      promptLines.push(`- ${filename}: failed to download`);
    }

    index += 1;
  }

  return {
    stagedPaths,
    promptSuffix: promptLines.join("\n"),
  };
}

async function addReaction(message: Message, emoji: string): Promise<void> {
  try {
    await message.react(emoji);
  } catch {
    // Ignore reaction failures in channels where bot lacks permissions.
  }
}

async function removeReaction(message: Message, emoji: string): Promise<void> {
  try {
    const reaction = message.reactions.cache.get(emoji);
    if (reaction) {
      await reaction.users.remove(message.client.user?.id ?? "");
    }
  } catch {
    // Ignore reaction cleanup failures.
  }
}

function resolvePath(inputPath: string, baseDir = process.cwd()): string {
  if (inputPath.startsWith("~/")) {
    const home = process.env.HOME;
    if (home) {
      return path.resolve(home, inputPath.slice(2));
    }
  }
  if (path.isAbsolute(inputPath)) {
    return path.resolve(inputPath);
  }
  return path.resolve(baseDir, inputPath);
}

async function pickFolderWithFinder(): Promise<string | null> {
  if (process.platform !== "darwin") {
    return null;
  }

  const subprocess = Bun.spawn({
    cmd: [
      "osascript",
      "-e",
      "try",
      "-e",
      'set selectedFolder to POSIX path of (choose folder with prompt "Select project folder for this channel")',
      "-e",
      "return selectedFolder",
      "-e",
      "on error number -128",
      "-e",
      'return ""',
      "-e",
      "end try",
    ],
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, exitCode] = await Promise.all([
    new Response(subprocess.stdout).text(),
    subprocess.exited,
  ]);

  if (exitCode !== 0) {
    return null;
  }

  const selected = stdout.trim();
  if (!selected) {
    return null;
  }

  return path.resolve(selected);
}

function buildSeededPrompt(
  userPrompt: string,
  history: Array<{ role: "user" | "assistant"; content: string }>,
  hasActiveSession: boolean,
): string {
  if (hasActiveSession || history.length === 0) {
    return userPrompt;
  }

  const normalizedHistory = history
    .slice(-12)
    .map((entry) => {
      const compactText = entry.content.replace(/\s+/g, " ").trim();
      const clipped = compactText.length > 400 ? `${compactText.slice(0, 400)}...` : compactText;
      return `${entry.role.toUpperCase()}: ${clipped}`;
    })
    .join("\n");

  return [
    "Conversation context (carry this forward):",
    normalizedHistory,
    "",
    "Current user message:",
    userPrompt,
  ].join("\n");
}

function compactHistory(
  history: Array<{ role: "user" | "assistant"; content: string }>,
  maxLines = 8,
): string {
  if (history.length === 0) {
    return "No prior context.";
  }

  return history
    .slice(-maxLines)
    .map((entry, index) => {
      const compactText = entry.content.replace(/\s+/g, " ").trim();
      const clipped = compactText.length > 180 ? `${compactText.slice(0, 180)}...` : compactText;
      return `${index + 1}. ${entry.role}: ${clipped}`;
    })
    .join("\n");
}

async function runCommand(
  cmd: string[],
  cwd: string,
): Promise<{ exitCode: number; output: string }> {
  const process = Bun.spawn({
    cmd,
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);

  const output = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n");
  return {
    exitCode,
    output,
  };
}

async function cleanupFiles(paths: string[]): Promise<void> {
  for (const filePath of paths) {
    try {
      await unlink(filePath);
    } catch {
      // Ignore cleanup errors.
    }
  }
}

async function runBashCommand(
  command: string,
  cwd: string,
): Promise<{ exitCode: number; output: string }> {
  const process = Bun.spawn({
    cmd: ["/bin/zsh", "-lc", command],
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);

  const output = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n");
  return {
    exitCode,
    output,
  };
}

function toStreamingPreview(text: string, thinking: string, maxChars = 1800): string {
  const trimmedText = text.trim();
  const trimmedThinking = thinking.trim();
  if (!trimmedText && !trimmedThinking) {
    return "Thinking...";
  }

  const parts: string[] = [];
  if (trimmedThinking) {
    const clippedThinking =
      trimmedThinking.length > 800 ? `...${trimmedThinking.slice(-797)}` : trimmedThinking;
    parts.push(`Thinking:\n${clippedThinking}`);
  }
  if (trimmedText) {
    const clippedText = trimmedText.length > 900 ? `...${trimmedText.slice(-897)}` : trimmedText;
    parts.push(`Answer so far:\n${clippedText}`);
  }

  const combined = parts.join("\n\n");
  if (combined.length <= maxChars) {
    return combined;
  }
  return `...${combined.slice(-(maxChars - 3))}`;
}

export async function startApp(config: AppConfig): Promise<void> {
  const database = openDatabase(config.databasePath);
  const repository = new Repository(database);
  const sessions = new SessionManager(repository, {
    defaultWorkingDir: config.defaultWorkingDir,
    defaultModel: config.defaultModel,
  });
  const stopController = new StopController();
  const runner = new ClaudeRunner();
  const pendingProjectSwitches = new Map<
    string,
    { channelId: string; guildId: string; workingDir: string }
  >();

  await registerSlashCommands({
    token: config.discordToken,
    clientId: config.discordClientId,
    guildId: config.discordGuildId,
  });

  await startDiscordClient({
    token: config.discordToken,
    onButtonInteraction: async (interaction) => {
      const projectSwitch = parseProjectSwitchCustomId(interaction.customId);
      if (projectSwitch) {
        const pending = pendingProjectSwitches.get(projectSwitch.requestId);
        if (!pending) {
          await interaction.reply({
            content: "Project switch request expired. Run /project again.",
            flags: MessageFlags.Ephemeral,
          });
          return;
        }
        if (interaction.channelId !== pending.channelId) {
          await interaction.reply({
            content: "This project switch belongs to a different channel.",
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        pendingProjectSwitches.delete(projectSwitch.requestId);
        const previousChannelState = sessions.getState(pending.channelId, pending.guildId).channel;
        const state = sessions.switchProject(
          pending.channelId,
          pending.guildId,
          pending.workingDir,
          {
            fresh: projectSwitch.action === "fresh",
          },
        );
        const changedProject = previousChannelState.workingDir !== pending.workingDir;
        const suffix =
          projectSwitch.action === "fresh"
            ? " with fresh session."
            : changedProject
              ? " (context kept, session restarted)."
              : " (context kept).";
        await interaction.update({
          content: `Project set to \`${state.channel.workingDir}\`${suffix}`,
          components: [],
        });
        return;
      }

      const control = parseRunControlCustomId(interaction.customId);
      if (!control) {
        await interaction.reply({
          content: "Unknown control button.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (interaction.channelId !== control.channelId) {
        await interaction.reply({
          content: "This control belongs to a different channel session.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (control.action === "interrupt") {
        const interrupted = await stopController.interrupt(control.channelId);
        await interaction.reply({
          content: interrupted ? "Interrupt signal sent." : "No active run to interrupt.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      const aborted = stopController.abort(control.channelId);
      await interaction.reply({
        content: aborted ? "Abort signal sent." : "No active run to abort.",
        flags: MessageFlags.Ephemeral,
      });
    },
    onSlashCommand: async (interaction) => {
      const channelId = interaction.channelId;
      const guildId = interaction.guildId ?? "dm";

      switch (interaction.commandName) {
        case "new": {
          sessions.resetSession(channelId);
          await interaction.reply("Session reset for this channel.");
          break;
        }
        case "compact": {
          const state = sessions.getState(channelId, guildId);
          const summary = compactHistory(state.history);
          sessions.resetSession(channelId);
          sessions.appendTurn(channelId, {
            role: "assistant",
            content: `Context summary:\n${summary}`,
          });
          await interaction.reply("Context compacted and session reset.");
          break;
        }
        case "status": {
          const state = sessions.getState(channelId, guildId);
          const totalCost = repository.getChannelCostTotal(channelId);
          const turns = state.history.length;
          const lines = [
            `Project: \`${state.channel.workingDir}\``,
            `Model: \`${state.channel.model}\``,
            `Session: ${state.channel.sessionId ? `\`${state.channel.sessionId}\`` : "none"}`,
            `In-memory turns: \`${turns}\``,
            `Total channel cost: \`$${totalCost.toFixed(4)}\``,
          ];
          await interaction.reply(lines.join("\n"));
          break;
        }
        case "bash": {
          const command = interaction.options.getString("command", true);
          const state = sessions.getState(channelId, guildId);
          await interaction.deferReply();

          const result = await runBashCommand(command, state.channel.workingDir);
          const outputText = result.output || "(no output)";
          const payload = `\`\`\`bash\n$ ${command}\n${outputText}\n[exit ${result.exitCode}]\n\`\`\``;
          const chunks = chunkDiscordText(payload);
          const firstChunk = chunks[0] ?? "(no output)";
          await interaction.editReply(firstChunk);

          for (let i = 1; i < chunks.length; i++) {
            const chunk = chunks[i];
            if (chunk) {
              await interaction.followUp(chunk);
            }
          }
          break;
        }
        case "project": {
          const state = sessions.getState(channelId, guildId);
          const inputPath = interaction.options.getString("path");
          await interaction.deferReply();

          let selectedPath: string | null = null;
          let sourceDescription = "";

          if (inputPath) {
            selectedPath = resolvePath(inputPath, state.channel.workingDir);
            if (!existsSync(selectedPath)) {
              await interaction.editReply(
                `Path not found: \`${selectedPath}\`\n\`path\` is resolved relative to current project \`${state.channel.workingDir}\` unless absolute.`,
              );
              break;
            }
            const isDirectory = (() => {
              try {
                return statSync(selectedPath).isDirectory();
              } catch {
                return false;
              }
            })();
            if (!isDirectory) {
              await interaction.editReply(
                `Path is not a directory: \`${selectedPath}\`\nProvide a folder path relative to \`${state.channel.workingDir}\` or absolute.`,
              );
              break;
            }
            const isRelative = !path.isAbsolute(inputPath) && !inputPath.startsWith("~/");
            sourceDescription = isRelative
              ? `from \`${inputPath}\` (resolved relative to \`${state.channel.workingDir}\`)`
              : `from \`${inputPath}\``;
          } else {
            if (process.platform !== "darwin") {
              await interaction.editReply(
                `Finder picker is only available on macOS. Use \`/project path:<dir>\` (relative to \`${state.channel.workingDir}\` or absolute).`,
              );
              break;
            }
            selectedPath = await pickFolderWithFinder();
            if (!selectedPath) {
              await interaction.editReply("Folder selection cancelled.");
              break;
            }
            sourceDescription = "from Finder picker";
          }

          const requestId = crypto.randomUUID();
          pendingProjectSwitches.set(requestId, {
            channelId,
            guildId,
            workingDir: selectedPath,
          });
          await interaction.editReply({
            content: `Selected project \`${selectedPath}\` ${sourceDescription}. Keep current context or clear it?`,
            components: buildProjectSwitchButtons(requestId),
          });
          break;
        }
        case "model": {
          const model = interaction.options.getString("name", true);
          sessions.setModel(channelId, model);
          await stopController.setModel(channelId, model);
          await interaction.reply(`Model set to \`${model}\`.`);
          break;
        }
        case "cost": {
          const totalCost = repository.getChannelCostTotal(channelId);
          const totalTurns = repository.getChannelTurnCount(channelId);
          await interaction.reply(
            `Channel spend: \`$${totalCost.toFixed(4)}\` across \`${totalTurns}\` turns.`,
          );
          break;
        }
        case "worktree": {
          const state = sessions.getState(channelId, guildId);
          const action = interaction.options.getString("action", true);
          const inputPath = interaction.options.getString("path");
          const branch = interaction.options.getString("branch");
          await interaction.deferReply();

          if (action === "list") {
            const result = await runCommand(["git", "worktree", "list"], state.channel.workingDir);
            const text = result.output || "(no output)";
            const payload = `\`\`\`bash\n${text}\n\`\`\``;
            const chunks = chunkDiscordText(payload);
            await interaction.editReply(chunks[0] ?? "(no output)");
            for (let i = 1; i < chunks.length; i++) {
              const chunk = chunks[i];
              if (chunk) {
                await interaction.followUp(chunk);
              }
            }
            break;
          }

          if (!inputPath) {
            await interaction.editReply("`path` is required for create/remove.");
            break;
          }

          if (action === "create") {
            const resolvedPath = resolvePath(inputPath);
            const cmd = ["git", "worktree", "add", resolvedPath];
            if (branch) {
              cmd.push(branch);
            }
            const result = await runCommand(cmd, state.channel.workingDir);
            const output = result.output || "(no output)";
            await interaction.editReply(
              `worktree create exit=${result.exitCode}\n\`\`\`bash\n${output}\n\`\`\``,
            );
            break;
          }

          if (action === "remove") {
            const resolvedPath = resolvePath(inputPath);
            const result = await runCommand(
              ["git", "worktree", "remove", resolvedPath],
              state.channel.workingDir,
            );
            const output = result.output || "(no output)";
            await interaction.editReply(
              `worktree remove exit=${result.exitCode}\n\`\`\`bash\n${output}\n\`\`\``,
            );
            break;
          }

          await interaction.editReply(`Unsupported worktree action: ${action}`);
          break;
        }
        default: {
          await interaction.reply({
            content: "Command not implemented.",
            flags: MessageFlags.Ephemeral,
          });
          break;
        }
      }
    },
    onUserMessage: async (message) => {
      const channelId = message.channel.id;
      const guildId = message.guildId ?? "dm";
      const state = sessions.getState(channelId, guildId);
      const stagedAttachments = await stageAttachments(message);

      await addReaction(message, "🧠");
      const status = await message.reply({
        content: "Thinking...",
        components: buildStopButtons(channelId),
      });
      const prompt = `${getMessagePrompt(message)}${stagedAttachments.promptSuffix}`;
      const seededPrompt = buildSeededPrompt(
        prompt,
        state.history,
        Boolean(state.channel.sessionId),
      );
      const abortController = new AbortController();
      const persistedFilenames = new Set<string>();
      let streamedText = "";
      let streamedThinking = "";
      let streamClosed = false;
      let streamFlushTimer: ReturnType<typeof setTimeout> | null = null;
      let statusEditQueue: Promise<unknown> = Promise.resolve();

      const queueStatusEdit = (content: string, includeButtons: boolean) => {
        statusEditQueue = statusEditQueue
          .then(() =>
            status.edit({
              content,
              components: includeButtons ? buildStopButtons(channelId) : [],
            }),
          )
          .catch(() => undefined);
        return statusEditQueue;
      };

      const flushStreamPreview = () => {
        streamFlushTimer = null;
        if (streamClosed) {
          return;
        }
        void queueStatusEdit(toStreamingPreview(streamedText, streamedThinking), true);
      };

      const scheduleStreamPreview = () => {
        if (streamClosed || streamFlushTimer) {
          return;
        }
        streamFlushTimer = setTimeout(flushStreamPreview, 300);
      };

      try {
        sessions.appendTurn(channelId, {
          role: "user",
          content: prompt,
        });

        const result = await runner.run({
          prompt: seededPrompt,
          cwd: state.channel.workingDir,
          sessionId: state.channel.sessionId ?? undefined,
          model: state.channel.model,
          permissionMode: config.claudePermissionMode,
          abortController,
          onQueryStart: (query) => {
            stopController.register(channelId, { query, abortController });
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
          },
        });

        if (streamFlushTimer) {
          clearTimeout(streamFlushTimer);
          streamFlushTimer = null;
        }
        streamClosed = true;
        await statusEditQueue;

        if (result.sessionId) {
          sessions.setSessionId(channelId, result.sessionId);
        }

        const outputText = result.text.trim();
        const finalText =
          outputText.length > 0
            ? outputText
            : stopController.wasInterrupted(channelId)
              ? "Interrupted."
              : "(No response text)";
        sessions.appendTurn(channelId, {
          role: "assistant",
          content: finalText,
        });

        const chunks = chunkDiscordText(finalText);
        if (chunks.length === 0) {
          await status.edit({
            content: finalText,
            components: [],
          });
        } else {
          const firstChunk = chunks[0];
          await status.edit({
            content: firstChunk ?? finalText,
            components: [],
          });
          for (let i = 1; i < chunks.length; i++) {
            const chunk = chunks[i];
            if (chunk) {
              if ("send" in message.channel && typeof message.channel.send === "function") {
                await message.channel.send(chunk);
              }
            }
          }
        }

        if ("send" in message.channel && typeof message.channel.send === "function") {
          for (const filename of persistedFilenames) {
            const absolutePath = path.isAbsolute(filename)
              ? filename
              : path.resolve(state.channel.workingDir, filename);
            if (!existsSync(absolutePath)) {
              continue;
            }
            try {
              await message.channel.send({
                content: `Generated file: \`${filename}\``,
                files: [absolutePath],
              });
            } catch {
              // Ignore attachment send failures.
            }
          }
        }

        await removeReaction(message, "🧠");
        await addReaction(message, "✅");
      } catch (error) {
        if (streamFlushTimer) {
          clearTimeout(streamFlushTimer);
          streamFlushTimer = null;
        }
        streamClosed = true;
        await statusEditQueue;

        const msg = error instanceof Error ? error.message : "Unknown failure";
        await status.edit({
          content: `❌ ${msg}`,
          components: [],
        });
        await removeReaction(message, "🧠");
        await addReaction(message, "❌");
      } finally {
        await cleanupFiles(stagedAttachments.stagedPaths);
        stopController.clear(channelId);
      }
    },
  });
}
