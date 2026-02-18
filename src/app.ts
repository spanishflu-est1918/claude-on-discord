import path from "node:path";
import type { Message } from "discord.js";
import { ClaudeRunner } from "./claude/runner";
import { SessionManager } from "./claude/session";
import { StopController } from "./claude/stop";
import type { AppConfig } from "./config";
import { Repository } from "./db/repository";
import { openDatabase } from "./db/schema";
import { buildStopButtons, parseRunControlCustomId } from "./discord/buttons";
import { chunkDiscordText } from "./discord/chunker";
import { startDiscordClient } from "./discord/client";
import { registerSlashCommands } from "./discord/commands";

function getMessagePrompt(message: Message): string {
  if (message.content.trim().length > 0) {
    return message.content;
  }
  return "User sent attachments. Describe what they sent and ask how to help.";
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

function resolvePath(inputPath: string): string {
  if (inputPath.startsWith("~/")) {
    const home = process.env.HOME;
    if (home) {
      return path.resolve(home, inputPath.slice(2));
    }
  }
  return path.resolve(inputPath);
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

function toStreamingPreview(text: string, maxChars = 1800): string {
  if (!text.trim()) {
    return "Thinking...";
  }
  if (text.length <= maxChars) {
    return text;
  }
  return `...${text.slice(-(maxChars - 3))}`;
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

  await registerSlashCommands({
    token: config.discordToken,
    clientId: config.discordClientId,
    guildId: config.discordGuildId,
  });

  await startDiscordClient({
    token: config.discordToken,
    onButtonInteraction: async (interaction) => {
      const control = parseRunControlCustomId(interaction.customId);
      if (!control) {
        await interaction.reply({ content: "Unknown control button.", ephemeral: true });
        return;
      }

      if (interaction.channelId !== control.channelId) {
        await interaction.reply({
          content: "This control belongs to a different channel session.",
          ephemeral: true,
        });
        return;
      }

      if (control.action === "interrupt") {
        const interrupted = await stopController.interrupt(control.channelId);
        await interaction.reply({
          content: interrupted ? "Interrupt signal sent." : "No active run to interrupt.",
          ephemeral: true,
        });
        return;
      }

      const aborted = stopController.abort(control.channelId);
      await interaction.reply({
        content: aborted ? "Abort signal sent." : "No active run to abort.",
        ephemeral: true,
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
          const inputPath = interaction.options.getString("path", true);
          const fresh = interaction.options.getBoolean("fresh") ?? false;
          const resolvedPath = resolvePath(inputPath);
          const state = sessions.switchProject(channelId, guildId, resolvedPath, { fresh });
          await interaction.reply(
            `Project set to \`${state.channel.workingDir}\`${fresh ? " with fresh session." : "."}`,
          );
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
          await interaction.reply({ content: "Command not implemented.", ephemeral: true });
          break;
        }
      }
    },
    onUserMessage: async (message) => {
      const channelId = message.channel.id;
      const guildId = message.guildId ?? "dm";
      const state = sessions.getState(channelId, guildId);

      await addReaction(message, "🧠");
      const status = await message.reply({
        content: "Thinking...",
        components: buildStopButtons(channelId),
      });
      const prompt = getMessagePrompt(message);
      const seededPrompt = buildSeededPrompt(
        prompt,
        state.history,
        Boolean(state.channel.sessionId),
      );
      const abortController = new AbortController();
      let streamedText = "";
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
        void queueStatusEdit(toStreamingPreview(streamedText), true);
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

        const outputText = result.text.trim() || "(No response text)";
        sessions.appendTurn(channelId, {
          role: "assistant",
          content: outputText,
        });

        const chunks = chunkDiscordText(outputText);
        if (chunks.length === 0) {
          await status.edit({
            content: "(No response text)",
            components: [],
          });
        } else {
          const firstChunk = chunks[0];
          await status.edit({
            content: firstChunk ?? "(No response text)",
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
        stopController.clear(channelId);
      }
    },
  });
}
