import { type ChatInputCommandInteraction } from "discord.js";
import type { SessionManager } from "../../claude/session";
import type { Repository } from "../../db/repository";
import { buildDiffViewButtons } from "../../discord/buttons";
import { buildDiffDelivery } from "../../discord/diff-delivery";
import { buildDiffContext, buildDiffDetail, type DiffContext } from "../diff-worktree";

export async function handleDiffCommand(input: {
  interaction: ChatInputCommandInteraction;
  channelId: string;
  guildId: string;
  sessions: SessionManager;
  repository: Repository;
  detectBranchName: (workingDir: string) => Promise<string | null>;
  runCommand: (command: string[], cwd: string) => Promise<{ exitCode: number; output: string }>;
  rememberDiffView: (requestId: string, context: DiffContext) => void;
}): Promise<void> {
  const state = input.sessions.getState(input.channelId, input.guildId);
  await input.interaction.deferReply();

  const context = await buildDiffContext({
    channelId: input.channelId,
    guildId: input.guildId,
    workingDir: state.channel.workingDir,
    baseInput: null,
    repository: input.repository,
    detectBranchName: input.detectBranchName,
  });
  const requestId = crypto.randomUUID();
  input.rememberDiffView(requestId, context);

  const patchDetail = await buildDiffDetail(context, "patch", input.runCommand);
  const delivery = buildDiffDelivery(patchDetail, "diff");
  await input.interaction.editReply({
    content: delivery.content,
    files: delivery.files,
    components: buildDiffViewButtons(requestId),
  });
}
