import type { MessageEditOptions } from "discord.js";
import { isAnthropicCreditBalanceError, shouldUseAnthropicApiKey } from "../claude/auth-policy";
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
  const apiCreditFailure = isAnthropicCreditBalanceError(msg);
  if (apiCreditFailure) {
    const apiModeEnabled = shouldUseAnthropicApiKey();
    const apiKeyPresent = Boolean(process.env.ANTHROPIC_API_KEY?.trim());
    console.error(
      `[auth] Anthropic credit error detected in ${channelId}. apiModeEnabled=${apiModeEnabled} apiKeyPresent=${apiKeyPresent}`,
    );
  }
  const authHint = apiCreditFailure
    ? "\nTip: run setup and keep Claude login mode (default). Use API mode only if you explicitly want Anthropic API billing."
    : "";
  const responseContent = `${contentPrefix ?? ""}${runawayStop ? "⚠️" : "❌"} ${msg}${authHint}`;
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
