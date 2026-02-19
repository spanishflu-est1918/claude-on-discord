import { MessageFlags } from "discord.js";
import { runPermissionModeAction } from "../command-actions/permission-mode-action";
import type { SessionSlashCommandInput } from "./context";

export async function handleModeCommand(input: SessionSlashCommandInput): Promise<void> {
  const action = input.interaction.options.getSubcommand(true);
  const result = runPermissionModeAction({
    channelId: input.channelId,
    action:
      action === "set"
        ? { type: "set", mode: input.interaction.options.getString("mode", true) }
        : action === "show"
          ? { type: "show" }
          : { type: "clear" },
    defaultPermissionMode: input.defaultPermissionMode,
    getActiveSessionId: input.getActiveSessionId,
    setSessionPermissionMode: input.setSessionPermissionMode,
    clearSessionPermissionMode: input.clearSessionPermissionMode,
    resolvePermissionModeForSession: input.resolvePermissionModeForSession,
  });

  if (!result.ok) {
    await input.interaction.reply({
      content: result.message,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (result.shouldReplyEphemeral) {
    await input.interaction.reply({
      content: result.message,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await input.interaction.reply(result.message);
}
