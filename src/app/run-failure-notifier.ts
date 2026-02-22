import type { MessageEditOptions } from "discord.js";
import type { DiscordDispatchQueue } from "../discord/dispatcher";

type EditableStatusMessage = {
  edit: (payload: MessageEditOptions) => Promise<unknown>;
};

export async function notifyRunFailure(input: {
  channelId: string;
  msg: string;
  runawayStop: boolean;
  status: EditableStatusMessage;
  discordDispatch: DiscordDispatchQueue;
  contentPrefix?: string;
  allowedMentions?: MessageEditOptions["allowedMentions"];
  queueChannelMessage: (payload: string) => Promise<unknown>;
}): Promise<void> {
  const {
    channelId,
    msg,
    runawayStop,
    status,
    discordDispatch,
    queueChannelMessage,
    contentPrefix,
    allowedMentions,
  } = input;
  const responseContent = `${contentPrefix ?? ""}${runawayStop ? "⚠️" : "❌"} ${msg}`;
  let surfacedByStatus = false;
  try {
    await discordDispatch.enqueue(`status:${channelId}`, async () => {
      await status.edit({
        content: responseContent,
        components: [],
        ...(allowedMentions ? { allowedMentions } : {}),
      });
    });
    surfacedByStatus = true;
  } catch {
    // Keep run failures contained even if the status message can no longer be edited.
  }
  if (!surfacedByStatus) {
    try {
      await queueChannelMessage(responseContent);
    } catch (notifyError) {
      const detail = notifyError instanceof Error ? notifyError.message : String(notifyError);
      console.error(`failed to send failure notice for ${channelId}: ${detail}`);
    }
  }
}
