import { MessageFlags, type ButtonInteraction } from "discord.js";
import type { SessionManager } from "../../claude/session";
import type { PendingProjectSwitch } from "../slash-commands/project-command";

export async function handleProjectSwitchButton(input: {
  interaction: ButtonInteraction;
  parsed: { action: "keep" | "fresh"; requestId: string };
  pendingProjectSwitches: Map<string, PendingProjectSwitch>;
  sessions: SessionManager;
  clearSessionPermissionMode: (channelId: string) => void;
  syncChannelTopic: (channel: unknown, workingDir: string) => Promise<void>;
}): Promise<boolean> {
  const pending = input.pendingProjectSwitches.get(input.parsed.requestId);
  if (!pending) {
    await input.interaction.reply({
      content: "Project switch request expired. Run /project again.",
      flags: MessageFlags.Ephemeral,
    });
    return true;
  }
  if (input.interaction.channelId !== pending.channelId) {
    await input.interaction.reply({
      content: "This project switch belongs to a different channel.",
      flags: MessageFlags.Ephemeral,
    });
    return true;
  }

  input.pendingProjectSwitches.delete(input.parsed.requestId);
  const previousChannelState = input.sessions.getState(pending.channelId, pending.guildId).channel;
  const state = input.sessions.switchProject(pending.channelId, pending.guildId, pending.workingDir, {
    fresh: input.parsed.action === "fresh",
  });
  const changedProject = previousChannelState.workingDir !== pending.workingDir;
  if (input.parsed.action === "fresh" || changedProject) {
    input.clearSessionPermissionMode(pending.channelId);
  }
  const suffix =
    input.parsed.action === "fresh"
      ? " with fresh session."
      : changedProject
        ? " (context kept, session restarted)."
        : " (context kept).";
  await input.interaction.update({
    content: `Project set to \`${state.channel.workingDir}\`${suffix}`,
    components: [],
  });
  void input.syncChannelTopic(input.interaction.channel, state.channel.workingDir);
  return true;
}
