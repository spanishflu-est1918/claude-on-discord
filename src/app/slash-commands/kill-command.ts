import { MessageFlags, type ChatInputCommandInteraction } from "discord.js";
import type { StopController } from "../../claude/stop";

export async function handleKillCommand(input: {
  interaction: ChatInputCommandInteraction;
  channelId: string;
  stopController: StopController;
}): Promise<void> {
  if (
    !input.interaction.channel ||
    !(
      typeof input.interaction.channel.isThread === "function" && input.interaction.channel.isThread()
    )
  ) {
    await input.interaction.reply({
      content: "The `/kill` command only works inside a thread.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await input.interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const thread = input.interaction.channel;

  input.stopController.abort(input.channelId);

  const currentName = thread.name;
  const newName = (currentName.startsWith("🔴") ? currentName : `🔴 ${currentName}`).slice(0, 100);

  const wasAlreadyArchived = thread.archived ?? false;

  await thread.edit({ name: newName, archived: true });

  const statusNote = wasAlreadyArchived ? " (was already archived)" : "";
  await input.interaction.editReply(`Killed and archived \`${newName}\`.${statusNote}`);
}
