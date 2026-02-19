import { type ButtonInteraction } from "discord.js";
import type { Repository } from "../../db/repository";
import type { MergeArchiveAction } from "../../discord/buttons";
import { parseThreadBranchMeta } from "../../discord/thread-branch";
import { saveThreadBranchMeta } from "../thread-lifecycle";

export async function handleMergeArchiveButton(input: {
  interaction: ButtonInteraction;
  parsed: { action: MergeArchiveAction; channelId: string };
  repository: Repository;
}): Promise<boolean> {
  const channelId = input.parsed.channelId;

  if (input.parsed.action === "keep") {
    await input.interaction.update({
      content: "Thread stays open 🔓 Keep building.",
      components: [],
    });
    return true;
  }

  // Archive: update message first to ack the interaction, then archive the channel
  await input.interaction.update({
    content: "Thread archived 📦",
    components: [],
  });

  const channel = input.interaction.channel;
  if (channel && typeof (channel as { setArchived?: unknown }).setArchived === "function") {
    await (channel as { setArchived: (v: boolean) => Promise<unknown> }).setArchived(true);
  }

  const meta = parseThreadBranchMeta(input.repository.getThreadBranchMeta(channelId));
  if (meta) {
    saveThreadBranchMeta(input.repository, {
      ...meta,
      lifecycleState: "archived",
      archivedAt: Date.now(),
    });
  }

  return true;
}
