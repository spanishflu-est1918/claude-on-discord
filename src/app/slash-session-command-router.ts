import type { SessionSlashCommandInput } from "./slash-commands/context";
import { handleCostCommand } from "./slash-commands/cost-command";
import { handleMentionsCommand } from "./slash-commands/mentions-command";
import { handleModeCommand } from "./slash-commands/mode-command";
import { handlePersonaCommand } from "./slash-commands/persona-command";
import { handleSystemPromptCommand } from "./slash-commands/systemprompt-command";

export type SessionSlashCommandRouterInput = SessionSlashCommandInput & {
  commandName: string;
};

export async function handleSessionSlashCommandRoute(
  input: SessionSlashCommandRouterInput,
): Promise<boolean> {
  if (input.commandName === "systemprompt") {
    await handleSystemPromptCommand(input);
    return true;
  }

  if (input.commandName === "persona") {
    await handlePersonaCommand(input);
    return true;
  }

  if (input.commandName === "mentions") {
    await handleMentionsCommand(input);
    return true;
  }

  if (input.commandName === "mode") {
    await handleModeCommand(input);
    return true;
  }

  if (input.commandName === "cost") {
    await handleCostCommand(input);
    return true;
  }

  return false;
}
