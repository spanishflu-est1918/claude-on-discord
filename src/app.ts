import path from "node:path";
import type { Message } from "discord.js";
import { ClaudeRunner } from "./claude/runner";
import { SessionManager } from "./claude/session";
import { StopController } from "./claude/stop";
import type { AppConfig } from "./config";
import { Repository } from "./db/repository";
import { openDatabase } from "./db/schema";
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
    ...(config.discordGuildId ? { guildId: config.discordGuildId } : {}),
  });

  await startDiscordClient({
    token: config.discordToken,
    onSlashCommand: async (interaction) => {
      const channelId = interaction.channelId;
      const guildId = interaction.guildId ?? "dm";

      switch (interaction.commandName) {
        case "new": {
          sessions.resetSession(channelId);
          await interaction.reply("Session reset for this channel.");
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
      const status = await message.reply("Thinking...");
      const prompt = getMessagePrompt(message);
      const abortController = new AbortController();

      try {
        sessions.appendTurn(channelId, {
          role: "user",
          content: prompt,
        });

        const result = await runner.run({
          prompt,
          cwd: state.channel.workingDir,
          sessionId: state.channel.sessionId ?? undefined,
          model: state.channel.model,
          permissionMode: config.claudePermissionMode,
          abortController,
          onQueryStart: (query) => {
            stopController.register(channelId, { query, abortController });
          },
        });

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
          await status.edit("(No response text)");
        } else {
          const firstChunk = chunks[0];
          await status.edit(firstChunk ?? "(No response text)");
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
        const msg = error instanceof Error ? error.message : "Unknown failure";
        await status.edit(`❌ ${msg}`);
        await removeReaction(message, "🧠");
        await addReaction(message, "❌");
      } finally {
        stopController.clear(channelId);
      }
    },
  });
}
