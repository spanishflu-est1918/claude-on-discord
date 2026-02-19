import { MessageFlags } from "discord.js";
import type { SessionSlashCommandInput } from "./context";

export async function handleModeCommand(input: SessionSlashCommandInput): Promise<void> {
  const action = input.interaction.options.getSubcommand(true);
  const allowedModes = new Set([
    "default",
    "plan",
    "acceptEdits",
    "bypassPermissions",
    "delegate",
    "dontAsk",
  ]);

  if (action === "set") {
    const sessionId = input.getActiveSessionId(input.channelId);
    if (!sessionId) {
      await input.interaction.reply({
        content: "No active session in this channel. Send a message first, then run `/mode set`.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const modeRaw = input.interaction.options.getString("mode", true).trim();
    if (!allowedModes.has(modeRaw)) {
      await input.interaction.reply({
        content:
          "Invalid mode. Use one of: `default`, `plan`, `acceptEdits`, `bypassPermissions`, `delegate`, `dontAsk`.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    input.setSessionPermissionMode(
      input.channelId,
      modeRaw as Parameters<typeof input.setSessionPermissionMode>[1],
    );
    const effective = input.resolvePermissionModeForSession(input.channelId);
    await input.interaction.reply(
      `Permission mode for session \`${sessionId}\` set to \`${modeRaw}\` (effective: \`${effective.permissionMode}\`).`,
    );
    return;
  }

  if (action === "show") {
    const effective = input.resolvePermissionModeForSession(input.channelId);
    await input.interaction.reply({
      content:
        `Permission mode: \`${effective.mode}\`\n` +
        `Effective mode: \`${effective.permissionMode}\`\n` +
        `Global default: \`${input.defaultPermissionMode}\``,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const sessionId = input.getActiveSessionId(input.channelId);
  if (!sessionId) {
    await input.interaction.reply({
      content: "No active session in this channel. Nothing to clear.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  input.clearSessionPermissionMode(input.channelId);
  const effective = input.resolvePermissionModeForSession(input.channelId);
  await input.interaction.reply(
    `Session permission mode override cleared for \`${sessionId}\` (effective: \`${effective.permissionMode}\`).`,
  );
}
