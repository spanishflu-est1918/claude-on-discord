import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { type ChatInputCommandInteraction } from "discord.js";
import { buildProjectSwitchButtons } from "../../discord/buttons";
import type { SessionManager } from "../../claude/session";
import { pickFolderWithFinder, resolvePath } from "../message-helpers";

export type PendingProjectSwitch = {
  channelId: string;
  guildId: string;
  workingDir: string;
};

export async function handleProjectCommand(input: {
  interaction: ChatInputCommandInteraction;
  channelId: string;
  guildId: string;
  sessions: SessionManager;
  pendingProjectSwitches: Map<string, PendingProjectSwitch>;
}): Promise<void> {
  const state = input.sessions.getState(input.channelId, input.guildId);
  const inputPath = input.interaction.options.getString("path");
  await input.interaction.deferReply();

  let selectedPath: string | null = null;
  let sourceDescription = "";

  if (inputPath) {
    selectedPath = resolvePath(inputPath, state.channel.workingDir);
    if (!existsSync(selectedPath)) {
      await input.interaction.editReply(
        `Path not found: \`${selectedPath}\`\n\`path\` is resolved relative to current project \`${state.channel.workingDir}\` unless absolute.`,
      );
      return;
    }
    const isDirectory = (() => {
      try {
        return statSync(selectedPath).isDirectory();
      } catch {
        return false;
      }
    })();
    if (!isDirectory) {
      await input.interaction.editReply(
        `Path is not a directory: \`${selectedPath}\`\nProvide a folder path relative to \`${state.channel.workingDir}\` or absolute.`,
      );
      return;
    }
    const isRelative = !path.isAbsolute(inputPath) && !inputPath.startsWith("~/");
    sourceDescription = isRelative
      ? `from \`${inputPath}\` (resolved relative to \`${state.channel.workingDir}\`)`
      : `from \`${inputPath}\``;
  } else {
    if (process.platform !== "darwin") {
      await input.interaction.editReply(
        `Finder picker is only available on macOS. Use \`/project path:<dir>\` (relative to \`${state.channel.workingDir}\` or absolute).`,
      );
      return;
    }
    selectedPath = await pickFolderWithFinder();
    if (!selectedPath) {
      await input.interaction.editReply("Folder selection cancelled.");
      return;
    }
    sourceDescription = "from Finder picker";
  }

  const requestId = crypto.randomUUID();
  input.pendingProjectSwitches.set(requestId, {
    channelId: input.channelId,
    guildId: input.guildId,
    workingDir: selectedPath,
  });
  await input.interaction.editReply({
    content: `Selected project \`${selectedPath}\` ${sourceDescription}. Keep current context or clear it?`,
    components: buildProjectSwitchButtons(requestId),
  });
}
