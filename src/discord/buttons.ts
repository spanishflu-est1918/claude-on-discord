import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";

const INTERRUPT_PREFIX = "run:interrupt:";
const ABORT_PREFIX = "run:abort:";
const PROJECT_KEEP_PREFIX = "project:keep:";
const PROJECT_FRESH_PREFIX = "project:fresh:";

export type RunControlAction = "interrupt" | "abort";
export type ProjectSwitchAction = "keep" | "fresh";

export function buildStopButtons(channelId: string): ActionRowBuilder<ButtonBuilder>[] {
  const interruptButton = new ButtonBuilder()
    .setCustomId(`${INTERRUPT_PREFIX}${channelId}`)
    .setLabel("Interrupt")
    .setStyle(ButtonStyle.Secondary)
    .setEmoji("⏸️");

  const abortButton = new ButtonBuilder()
    .setCustomId(`${ABORT_PREFIX}${channelId}`)
    .setLabel("Abort")
    .setStyle(ButtonStyle.Secondary)
    .setEmoji("🛑");

  return [new ActionRowBuilder<ButtonBuilder>().addComponents(interruptButton, abortButton)];
}

export function buildProjectSwitchButtons(requestId: string): ActionRowBuilder<ButtonBuilder>[] {
  const keepButton = new ButtonBuilder()
    .setCustomId(`${PROJECT_KEEP_PREFIX}${requestId}`)
    .setLabel("Keep Context")
    .setStyle(ButtonStyle.Secondary);

  const freshButton = new ButtonBuilder()
    .setCustomId(`${PROJECT_FRESH_PREFIX}${requestId}`)
    .setLabel("Clear Context")
    .setStyle(ButtonStyle.Primary);

  return [new ActionRowBuilder<ButtonBuilder>().addComponents(keepButton, freshButton)];
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

export function parseProjectSwitchCustomId(
  customId: string,
): { action: ProjectSwitchAction; requestId: string } | null {
  if (customId.startsWith(PROJECT_KEEP_PREFIX)) {
    const requestId = customId.slice(PROJECT_KEEP_PREFIX.length);
    if (requestId) {
      return { action: "keep", requestId };
    }
  }

  if (customId.startsWith(PROJECT_FRESH_PREFIX)) {
    const requestId = customId.slice(PROJECT_FRESH_PREFIX.length);
    if (requestId) {
      return { action: "fresh", requestId };
    }
  }

  return null;
}
