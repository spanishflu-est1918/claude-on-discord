import type { ClaudeQuery } from "../types";

export function logRunnerSkillDebug(channelId: string, query: ClaudeQuery): void {
  if (process.env.DEBUG_SKILL_LOADS !== "1") {
    return;
  }
  void (async () => {
    try {
      const commands = await query.supportedCommands();
      const names = commands.map((command) => command.name);
      const flagged = names.filter(
        (name) =>
          name.includes(":") || /(?:skill|agent|docs|review|security|feature|design)/i.test(name),
      );
      const preview = flagged.slice(0, 30).join(", ");
      console.log(
        `[skill-debug] channel=${channelId} commands=${names.length} flagged=${flagged.length}${preview ? ` names=${preview}` : ""}`,
      );
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      console.error(`[skill-debug] failed in ${channelId}: ${detail}`);
    }
  })();
}
