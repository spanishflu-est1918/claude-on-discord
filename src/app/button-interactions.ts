import { type ButtonInteraction, MessageFlags } from "discord.js";
import {
  parseQueueNoticeCustomId,
  parseRunControlCustomId,
  parseToolViewCustomId,
} from "../discord/buttons";
import { buildSingleLiveToolMessage, type LiveToolTrace } from "./live-tools";

export type QueueNoticeInfo = {
  text: string;
  cancelled: boolean;
};

type BasicButtonInteractionHandlersInput = {
  interaction: ButtonInteraction;
  queuedNoticesByMessageId: Map<string, QueueNoticeInfo>;
  liveToolTracesByChannel: Map<string, LiveToolTrace>;
  getToolExpanded: (channelId: string, toolId: string) => boolean;
  setToolExpanded: (channelId: string, toolId: string, expanded: boolean) => void;
  steerRunner: { steer: (channelId: string, message: string) => boolean };
  stopController: {
    interrupt: (channelId: string) => Promise<boolean>;
    abort: (channelId: string) => boolean;
    abortPending: (channelId: string) => boolean;
  };
};

async function handleQueueNoticeInteraction(
  input: BasicButtonInteractionHandlersInput,
): Promise<boolean> {
  const queueNotice = parseQueueNoticeCustomId(input.interaction.customId);
  if (!queueNotice) {
    return false;
  }
  if (input.interaction.channelId !== queueNotice.channelId) {
    await input.interaction.reply({
      content: "This queue notice belongs to a different channel.",
      flags: MessageFlags.Ephemeral,
    });
    return true;
  }
  if (input.interaction.user.id !== queueNotice.userId) {
    await input.interaction.reply({
      content: "Only the queued user can interact with this notice.",
      flags: MessageFlags.Ephemeral,
    });
    return true;
  }

  await input.interaction.deferUpdate();

  // Atomically claim the notice before any async work — prevents double-fire from
  // rapid clicks. If already claimed (cancelled or absent), silently ignore.
  const noticeInfo = input.queuedNoticesByMessageId.get(input.interaction.message.id);
  if (!noticeInfo || noticeInfo.cancelled) {
    return true;
  }
  noticeInfo.cancelled = true;
  input.queuedNoticesByMessageId.delete(input.interaction.message.id);

  if (queueNotice.action === "steer") {
    const steered = input.steerRunner.steer(queueNotice.channelId, noticeInfo.text);
    if (!steered) {
      // Steer failed (no active run to inject into) — release the claim so the
      // message still runs normally once the current run finishes.
      noticeInfo.cancelled = false;
    }
    try {
      await input.interaction.message.edit({
        content: steered
          ? "💬 Sent to Claude."
          : "⏳ Could not send immediately. Keeping this message queued.",
        components: [],
      });
    } catch {
      // Ignore edit failures.
    }
    return true;
  }
  try {
    await input.interaction.message.delete();
  } catch {
    try {
      await input.interaction.message.edit({
        content: "Queue notice dismissed.",
        components: [],
      });
    } catch {
      // Ignore queue notice dismiss fallback failures.
    }
  }
  return true;
}

async function handleToolViewInteraction(
  input: BasicButtonInteractionHandlersInput,
): Promise<boolean> {
  const toolView = parseToolViewCustomId(input.interaction.customId);
  if (!toolView) {
    return false;
  }
  if (input.interaction.channelId !== toolView.channelId) {
    await input.interaction.reply({
      content: "This tool message belongs to a different channel.",
      flags: MessageFlags.Ephemeral,
    });
    return true;
  }
  const trace = input.liveToolTracesByChannel.get(toolView.channelId);
  const entry = trace?.byId.get(toolView.toolId);
  if (!entry) {
    await input.interaction.reply({
      content: "Tool state expired for this message.",
      flags: MessageFlags.Ephemeral,
    });
    return true;
  }
  const expanded = toolView.action === "expand";
  input.setToolExpanded(toolView.channelId, toolView.toolId, expanded);
  await input.interaction.update(
    buildSingleLiveToolMessage(entry, {
      channelId: toolView.channelId,
      expanded: input.getToolExpanded(toolView.channelId, toolView.toolId),
    }),
  );
  return true;
}

async function handleRunControlInteraction(
  input: BasicButtonInteractionHandlersInput,
): Promise<boolean> {
  const control = parseRunControlCustomId(input.interaction.customId);
  if (!control) {
    return false;
  }
  if (input.interaction.channelId !== control.channelId) {
    await input.interaction.reply({
      content: "This control belongs to a different channel session.",
      flags: MessageFlags.Ephemeral,
    });
    return true;
  }
  if (control.action === "interrupt") {
    const interrupted = await input.stopController.interrupt(control.channelId);
    await input.interaction.reply({
      content: interrupted ? "Interrupt signal sent." : "No active run to interrupt.",
      flags: MessageFlags.Ephemeral,
    });
    return true;
  }
  const aborted = input.stopController.abort(control.channelId);
  const abortedPending = !aborted ? input.stopController.abortPending(control.channelId) : false;
  await input.interaction.reply({
    content: aborted || abortedPending ? "Abort signal sent." : "No active run to abort.",
    flags: MessageFlags.Ephemeral,
  });
  return true;
}

export async function handleBasicButtonInteractions(
  input: BasicButtonInteractionHandlersInput,
): Promise<boolean> {
  if (await handleQueueNoticeInteraction(input)) {
    return true;
  }
  if (await handleToolViewInteraction(input)) {
    return true;
  }
  if (await handleRunControlInteraction(input)) {
    return true;
  }
  return false;
}
