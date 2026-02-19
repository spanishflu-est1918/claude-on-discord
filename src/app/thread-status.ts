/**
 * Isolated module for thread status — the emoji prefix shown in the Discord
 * sidebar next to a thread name. All status definitions, strip logic, and the
 * single public mutator live here. No other file should hardcode status emojis
 * or call channel.edit() for rename purposes.
 */

// ─── Status registry ─────────────────────────────────────────────────────────

export const THREAD_STATUSES = {
  /** Agent is actively processing a message. */
  working: "⚙️",
  /** Run finished — needs human review / follow-up. */
  needsAttention: "⚠️",
  /** Run ended with an unhandled exception. */
  error: "❌",
  /** Thread was manually killed and archived. */
  killed: "🔴",
} as const satisfies Record<string, string>;

/**
 * Named thread status values.
 * Use `"clean"` to remove any status prefix entirely.
 */
export type ThreadStatus = keyof typeof THREAD_STATUSES | "clean";

// ─── Internal helpers ─────────────────────────────────────────────────────────

type RenameableThread = {
  name: string;
  isThread: () => boolean;
  edit: (options: { name: string }) => Promise<unknown>;
};

function canRenameThread(channel: unknown): channel is RenameableThread {
  return (
    typeof channel === "object" &&
    channel !== null &&
    "isThread" in channel &&
    typeof (channel as { isThread?: unknown }).isThread === "function" &&
    (channel as { isThread: () => boolean }).isThread() &&
    "edit" in channel &&
    typeof (channel as { edit?: unknown }).edit === "function" &&
    "name" in channel &&
    typeof (channel as { name?: unknown }).name === "string"
  );
}

const ALL_STATUS_EMOJIS = Object.values(THREAD_STATUSES);

function stripStatusPrefix(name: string): string {
  for (const emoji of ALL_STATUS_EMOJIS) {
    if (name.startsWith(`${emoji} `)) return name.slice(emoji.length + 1);
    if (name.startsWith(emoji)) return name.slice(emoji.length);
  }
  return name;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Apply a named status to a thread's sidebar name, or remove it with `"clean"`.
 * Best-effort: permission and rate-limit errors are silently ignored.
 */
export async function setThreadStatus(
  channel: unknown,
  status: ThreadStatus,
): Promise<void> {
  if (!canRenameThread(channel)) return;
  const base = stripStatusPrefix(channel.name);
  const newName = status === "clean" ? base : `${THREAD_STATUSES[status]} ${base}`;
  if (newName === channel.name) return;
  try {
    await channel.edit({ name: newName.slice(0, 100) });
  } catch {
    // Thread renaming is best-effort — ignore permission or rate-limit failures.
  }
}
