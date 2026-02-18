import type { Message } from "discord.js";
import { ClaudeRunner } from "./claude/runner";
import { SessionManager } from "./claude/session";
import { StopController } from "./claude/stop";
import type { AppConfig } from "./config";
import { Repository } from "./db/repository";
import { openDatabase } from "./db/schema";
import { chunkDiscordText } from "./discord/chunker";
import { startDiscordClient } from "./discord/client";

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

export async function startApp(config: AppConfig): Promise<void> {
  const database = openDatabase(config.databasePath);
  const repository = new Repository(database);
  const sessions = new SessionManager(repository, {
    defaultWorkingDir: config.defaultWorkingDir,
    defaultModel: config.defaultModel,
  });
  const stopController = new StopController();
  const runner = new ClaudeRunner();

  await startDiscordClient({
    token: config.discordToken,
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
