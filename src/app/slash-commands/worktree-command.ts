import { type ChatInputCommandInteraction } from "discord.js";
import type { SessionManager } from "../../claude/session";
import type { Repository } from "../../db/repository";
import { runWorktreeBootstrap } from "../../discord/worktree-bootstrap";
import { parseThreadBranchMeta } from "../../discord/thread-branch";
import {
  buildAutoWorktreeTarget,
  buildWorktreeBootstrapSummary,
  maybeProvisionThreadWorktree,
} from "../diff-worktree";
import { resolvePath } from "../message-helpers";
import type { saveThreadBranchMeta } from "../thread-lifecycle";

export async function handleWorktreeCommand(input: {
  interaction: ChatInputCommandInteraction;
  channelId: string;
  guildId: string;
  sessions: SessionManager;
  repository: Repository;
  runCommand: (command: string[], cwd: string) => Promise<{ exitCode: number; output: string }>;
  chunkDiscordText: (text: string) => string[];
  worktreeBootstrap: boolean;
  worktreeBootstrapCommand?: string;
  clearSessionPermissionMode: (channelId: string) => void;
  saveThreadBranchMeta: typeof saveThreadBranchMeta;
  syncChannelTopic: (channel: unknown, workingDir: string) => Promise<void>;
}): Promise<void> {
  const state = input.sessions.getState(input.channelId, input.guildId);
  const action = input.interaction.options.getSubcommand(true);
  const inputPath = input.interaction.options.getString("path");
  const branch = input.interaction.options.getString("branch");
  await input.interaction.deferReply();

  if (action === "list") {
    const result = await input.runCommand(["git", "worktree", "list"], state.channel.workingDir);
    const text = result.output || "(no output)";
    const payload = `\`\`\`bash\n${text}\n\`\`\``;
    const chunks = input.chunkDiscordText(payload);
    await input.interaction.editReply(chunks[0] ?? "(no output)");
    for (let i = 1; i < chunks.length; i++) {
      const chunk = chunks[i];
      if (chunk) {
        await input.interaction.followUp(chunk);
      }
    }
    return;
  }

  if (action === "thread") {
    const meta = parseThreadBranchMeta(input.repository.getThreadBranchMeta(input.channelId));
    if (!meta) {
      await input.interaction.editReply(
        "No thread branch metadata found for this channel. Use this action inside a tracked thread.",
      );
      return;
    }

    const parentChannelId = meta.parentChannelId ?? meta.rootChannelId;
    const parentChannel = input.repository.getChannel(parentChannelId);
    const parentWorkingDir = parentChannel?.workingDir ?? state.channel.workingDir;
    const provisioned = await maybeProvisionThreadWorktree({
      enabled: true,
      parentWorkingDir,
      threadChannelId: input.channelId,
      threadName: meta.name,
      runCommand: input.runCommand,
    });

    if (!provisioned) {
      await input.interaction.editReply(
        `Failed to provision thread worktree from \`${parentWorkingDir}\`.`,
      );
      return;
    }

    let setupSummary = "";
    if (provisioned.created) {
      const setupResult = await runWorktreeBootstrap({
        enabled: input.worktreeBootstrap,
        customCommand: input.worktreeBootstrapCommand,
        workingDir: provisioned.worktreePath,
        runCommand: input.runCommand,
      });
      setupSummary = `\n${buildWorktreeBootstrapSummary(setupResult)}`;
    }

    input.sessions.switchProject(input.channelId, input.guildId, provisioned.worktreePath);
    input.clearSessionPermissionMode(input.channelId);
    input.sessions.setSessionId(input.channelId, null);
    input.saveThreadBranchMeta(input.repository, {
      ...meta,
      worktreePath: provisioned.worktreePath,
      worktreeMode: "worktree",
      lifecycleState: meta.lifecycleState ?? "active",
      cleanupState: "none",
    });
    void input.syncChannelTopic(input.interaction.channel, provisioned.worktreePath);
    await input.interaction.editReply(
      `Thread switched to dedicated worktree \`${provisioned.worktreePath}\` (session restarted).${setupSummary}`,
    );
    return;
  }

  if (action === "create") {
    let resolvedPath: string;
    let result: { exitCode: number; output: string };

    if (inputPath) {
      resolvedPath = resolvePath(inputPath, state.channel.workingDir);
      const cmd = ["git", "worktree", "add", resolvedPath];
      if (branch) {
        cmd.push(branch);
      }
      result = await input.runCommand(cmd, state.channel.workingDir);
    } else {
      const autoTarget = await buildAutoWorktreeTarget({
        baseWorkingDir: state.channel.workingDir,
        channelId: input.channelId,
        branchHint: branch,
        runCommand: input.runCommand,
      });
      if (!autoTarget) {
        await input.interaction.editReply(
          `Failed to resolve repository root from \`${state.channel.workingDir}\`.`,
        );
        return;
      }

      resolvedPath = autoTarget.worktreePath;
      result = await input.runCommand(
        ["git", "worktree", "add", resolvedPath, "-b", autoTarget.branchName],
        state.channel.workingDir,
      );
      if (result.exitCode !== 0 && /already exists/i.test(result.output)) {
        result = await input.runCommand(
          ["git", "worktree", "add", resolvedPath, autoTarget.branchName],
          state.channel.workingDir,
        );
      }
    }
    const output = result.output || "(no output)";
    let setupSummary = "setup skipped (worktree creation failed)";
    if (result.exitCode === 0) {
      const setupResult = await runWorktreeBootstrap({
        enabled: input.worktreeBootstrap,
        customCommand: input.worktreeBootstrapCommand,
        workingDir: resolvedPath,
        runCommand: input.runCommand,
      });
      setupSummary = buildWorktreeBootstrapSummary(setupResult);
    }
    await input.interaction.editReply(
      `worktree create path=\`${resolvedPath}\` exit=${result.exitCode}\n` +
        `${setupSummary}\n` +
        `\`\`\`bash\n${output}\n\`\`\``,
    );
    return;
  }

  if (action === "remove") {
    const resolvedPath = inputPath ? resolvePath(inputPath, state.channel.workingDir) : state.channel.workingDir;
    const result = await input.runCommand(["git", "worktree", "remove", resolvedPath], state.channel.workingDir);
    const output = result.output || "(no output)";
    await input.interaction.editReply(
      `worktree remove path=\`${resolvedPath}\` exit=${result.exitCode}\n\`\`\`bash\n${output}\n\`\`\``,
    );
    return;
  }

  await input.interaction.editReply(`Unsupported worktree action: ${action}`);
}
