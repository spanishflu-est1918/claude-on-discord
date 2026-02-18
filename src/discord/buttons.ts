import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";

const INTERRUPT_PREFIX = "run:interrupt:";
const ABORT_PREFIX = "run:abort:";

export type RunControlAction = "interrupt" | "abort";

export function buildStopButtons(channelId: string): ActionRowBuilder<ButtonBuilder>[] {
  const interruptButton = new ButtonBuilder()
    .setCustomId(`${INTERRUPT_PREFIX}${channelId}`)
    .setLabel("Interrupt")
    .setStyle(ButtonStyle.Secondary)
    .setEmoji("⏸️");

  const abortButton = new ButtonBuilder()
    .setCustomId(`${ABORT_PREFIX}${channelId}`)
    .setLabel("Abort")
    .setStyle(ButtonStyle.Danger)
    .setEmoji("🛑");

  return [new ActionRowBuilder<ButtonBuilder>().addComponents(interruptButton, abortButton)];
}

export function parseRunControlCustomId(
  customId: string,
): { action: RunControlAction; channelId: string } | null {
  if (customId.startsWith(INTERRUPT_PREFIX)) {
    const channelId = customId.slice(INTERRUPT_PREFIX.length);
    if (channelId) {
      return { action: "interrupt", channelId };
    }
  }

  if (customId.startsWith(ABORT_PREFIX)) {
    const channelId = customId.slice(ABORT_PREFIX.length);
    if (channelId) {
      return { action: "abort", channelId };
    }
  }

  return null;
}
