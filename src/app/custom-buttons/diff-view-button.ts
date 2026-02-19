import { MessageFlags, type ButtonInteraction } from "discord.js";
import type { SessionManager } from "../../claude/session";
import type { Repository } from "../../db/repository";
import { buildDiffViewButtons } from "../../discord/buttons";
import { buildDiffDelivery } from "../../discord/diff-delivery";
import { buildDiffContext, buildDiffDetail, type DiffContext } from "../diff-worktree";

export async function handleDiffViewButton(input: {
  interaction: ButtonInteraction;
  parsed: { action: "summary" | "patch" | "files" | "stat"; requestId: string };
  pendingDiffViews: Map<string, DiffContext>;
  sessions: SessionManager;
  repository: Repository;
  runCommand: (command: string[], cwd: string) => Promise<{ exitCode: number; output: string }>;
  detectBranchName: (workingDir: string) => Promise<string | null>;
  rememberDiffView: (requestId: string, context: DiffContext) => void;
}): Promise<boolean> {
  const context = input.pendingDiffViews.get(input.parsed.requestId);
  if (!context) {
    await input.interaction.reply({
      content: "Diff view expired. Run `/diff` again.",
      flags: MessageFlags.Ephemeral,
    });
    return true;
  }
  if (input.interaction.channelId !== context.channelId) {
    await input.interaction.reply({
      content: "This diff view belongs to a different channel.",
      flags: MessageFlags.Ephemeral,
    });
    return true;
  }

  const latestState = input.sessions.getState(context.channelId, context.guildId).channel;
  if (latestState.workingDir !== context.workingDir) {
    input.pendingDiffViews.delete(input.parsed.requestId);
    await input.interaction.reply({
      content: "Project changed since this diff snapshot. Run `/diff` again.",
      flags: MessageFlags.Ephemeral,
    });
    return true;
  }

  if (input.parsed.action === "summary") {
    const refreshedContext = await buildDiffContext({
      channelId: context.channelId,
      guildId: context.guildId,
      workingDir: context.workingDir,
      baseInput: context.baseRef ?? null,
      repository: input.repository,
      detectBranchName: input.detectBranchName,
    });
    input.rememberDiffView(input.parsed.requestId, refreshedContext);
    const patchDetail = await buildDiffDetail(refreshedContext, "patch", input.runCommand);
    const delivery = buildDiffDelivery(patchDetail, "diff-patch");
    await input.interaction.update({
      content: delivery.content,
      files: delivery.files,
      components: buildDiffViewButtons(input.parsed.requestId),
    });
    return true;
  }

  await input.interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const detail = await buildDiffDetail(context, input.parsed.action, input.runCommand);
  const delivery = buildDiffDelivery(detail, `diff-${input.parsed.action}`);
  await input.interaction.editReply({
    content: delivery.content,
    files: delivery.files,
  });
  return true;
}
