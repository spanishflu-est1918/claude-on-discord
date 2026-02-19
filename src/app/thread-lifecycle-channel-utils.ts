type ForkThread = {
  id: string;
};

export type ForkableChannel = {
  name?: string;
  isThread: () => boolean;
  threads: {
    create: (options: { name: string; reason?: string }) => Promise<ForkThread>;
  };
};

type RenameableThreadChannel = {
  isThread: () => boolean;
  edit: (options: { name: string }) => Promise<unknown>;
  name: string;
};

export type ThreadBootstrapChannel = {
  id: string;
  parentId: string | null;
  name?: string;
  isThread: () => boolean;
};

export type SendableChannel = {
  send: (options: unknown) => Promise<unknown>;
};

export type EditableSentMessage = {
  edit: (options: unknown) => Promise<unknown>;
};

export type DiscordClientChannelFetcher = {
  channels: {
    fetch: (id: string) => Promise<unknown>;
  };
};

export function canCreateForkThread(channel: unknown): channel is ForkableChannel {
  if (typeof channel !== "object" || channel === null) {
    return false;
  }

  if (
    !("isThread" in channel) ||
    typeof (channel as { isThread?: unknown }).isThread !== "function"
  ) {
    return false;
  }

  if (!("threads" in channel)) {
    return false;
  }

  const threads = (channel as { threads?: { create?: unknown } }).threads;
  return typeof threads?.create === "function";
}

function canRenameThread(channel: unknown): channel is RenameableThreadChannel {
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

const THREAD_STATE_PREFIXES = ["⚠️", "✅", "❌"] as const;
type ThreadState = (typeof THREAD_STATE_PREFIXES)[number];

function stripThreadStatePrefix(name: string): string {
  for (const prefix of THREAD_STATE_PREFIXES) {
    if (name.startsWith(`${prefix} `)) {
      return name.slice(prefix.length + 1);
    }
    if (name.startsWith(prefix)) {
      return name.slice(prefix.length);
    }
  }
  return name;
}

export async function setThreadState(channel: unknown, state: ThreadState | null): Promise<void> {
  if (!canRenameThread(channel)) return;
  const baseName = stripThreadStatePrefix(channel.name);
  const newName = state ? `${state} ${baseName}` : baseName;
  if (newName === channel.name) return;
  try {
    await channel.edit({ name: newName.slice(0, 100) });
  } catch {
    // Thread renaming is best-effort — ignore permission or rate-limit failures.
  }
}

export function buildForkThreadTitle(input: {
  requested: string | null;
  channelName?: string;
}): string {
  const requested = input.requested?.trim();
  if (requested) {
    return requested.slice(0, 100);
  }

  const base = input.channelName?.trim();
  if (!base) {
    return "fork";
  }

  return `${base}-fork`.slice(0, 100);
}

export function isThreadBootstrapChannel(channel: unknown): channel is ThreadBootstrapChannel {
  return (
    typeof channel === "object" &&
    channel !== null &&
    "id" in channel &&
    typeof (channel as { id?: unknown }).id === "string" &&
    "parentId" in channel &&
    "isThread" in channel &&
    typeof (channel as { isThread?: unknown }).isThread === "function"
  );
}

export function canSendMessage(channel: unknown): channel is SendableChannel {
  return (
    typeof channel === "object" &&
    channel !== null &&
    "send" in channel &&
    typeof (channel as SendableChannel).send === "function"
  );
}

export function canEditSentMessage(message: unknown): message is EditableSentMessage {
  return (
    typeof message === "object" &&
    message !== null &&
    "edit" in message &&
    typeof (message as EditableSentMessage).edit === "function"
  );
}
