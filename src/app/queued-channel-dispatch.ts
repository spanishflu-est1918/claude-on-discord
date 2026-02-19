import type { Message } from "discord.js";
import type { DiscordDispatchQueue } from "../discord/dispatcher";
import { canSendMessage } from "./thread-lifecycle";

export function createQueuedChannelDispatch(input: {
  channelId: string;
  message: Message;
  discordDispatch: DiscordDispatchQueue;
}) {
  const { channelId, message, discordDispatch } = input;
  const channelSendTarget = canSendMessage(message.channel) ? message.channel : null;
  const queueChannelMessage = async (
    payload: Parameters<typeof message.reply>[0],
  ): Promise<Awaited<ReturnType<typeof message.reply>>> => {
    return await discordDispatch.enqueue(
      `channel:${channelId}`,
      async () => await message.reply(payload),
    );
  };
  const queueChannelSend = async (payload: unknown): Promise<unknown | null> => {
    if (!channelSendTarget) {
      return null;
    }
    return await discordDispatch.enqueue(
      `channel:${channelId}`,
      async () => await channelSendTarget.send(payload),
    );
  };

  return {
    channelSendTarget,
    queueChannelMessage,
    queueChannelSend,
  };
}
