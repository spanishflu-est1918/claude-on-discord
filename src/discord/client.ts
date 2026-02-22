import {
  type AnyThreadChannel,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  Client,
  GatewayIntentBits,
  type Message,
  MessageFlags,
  MessageType,
  Partials,
} from "discord.js";

export interface DiscordClientOptions {
  token: string;
  onUserMessage: (
    message: Message,
    context?: {
      observedHumanUserCount: number;
      observedNonClaudeUserCount: number;
      participantNonClaudeUserCount: number | null;
      sharedChannel: boolean;
    },
  ) => Promise<void>;
  onSlashCommand: (interaction: ChatInputCommandInteraction) => Promise<void>;
  onButtonInteraction: (interaction: ButtonInteraction) => Promise<void>;
  requireMentionInMultiUserChannels?: boolean;
  shouldRequireMentionForMessage?: (message: Message) => boolean | "always";
  onGatewayDisconnect?: (code: number) => void;
  onGatewayReconnecting?: () => void;
  onGatewayResume?: (replayedEvents: number) => void;
  onThreadLifecycle?: (event: ThreadLifecycleEvent) => Promise<void>;
}

export interface ThreadLifecycleEvent {
  type: "archived" | "unarchived" | "deleted";
  threadId: string;
  parentId: string | null;
  threadName: string;
  thread: AnyThreadChannel;
}

const RECENT_MESSAGE_ID_TTL_MS = 5 * 60 * 1000;
const MAX_RECENT_MESSAGE_IDS = 5000;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hasExplicitBotMention(message: Message, botId: string | null): boolean {
  const mentions = message.mentions as unknown as {
    has?: (user: unknown) => boolean;
    users?: { has?: (id: string) => boolean };
  };
  if (mentions && typeof mentions.has === "function" && message.client.user) {
    try {
      if (mentions.has(message.client.user)) {
        return true;
      }
    } catch {
      // Fall through to alternate mention checks.
    }
  }
  if (botId && mentions?.users && typeof mentions.users.has === "function") {
    try {
      if (mentions.users.has(botId)) {
        return true;
      }
    } catch {
      // Fall through to raw content pattern check.
    }
  }
  if (!botId) {
    // Fall through to @username style text mention checks.
  } else {
    const mentionPattern = new RegExp(`<@!?${escapeRegExp(botId)}>`);
    if (mentionPattern.test(message.content)) {
      return true;
    }
  }

  const botUser =
    (
      message as unknown as {
        client?: { user?: { username?: string; globalName?: string | null } };
      }
    ).client?.user ?? {};
  const candidateNames = [botUser.username, botUser.globalName]
    .map((value) => (typeof value === "string" ? value.trim() : ""))
    .filter(Boolean);
  const content = message.content;
  for (const name of candidateNames) {
    const atNamePattern = new RegExp(`(^|\\s)@${escapeRegExp(name)}(\\b|\\s|$)`, "i");
    if (atNamePattern.test(content)) {
      return true;
    }
  }

  return false;
}

function isGuildMessage(message: Message): boolean {
  if (typeof message.inGuild === "function") {
    try {
      return message.inGuild();
    } catch {
      // Fall through to guildId check.
    }
  }
  return typeof message.guildId === "string" && message.guildId.length > 0;
}

function collectionSize(value: unknown): number | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const typed = value as { size?: unknown };
  if (typeof typed.size === "number") {
    return typed.size;
  }
  return null;
}

function collectionHasUser(value: unknown, userId: string | null): boolean {
  if (!userId || !value || typeof value !== "object") {
    return false;
  }
  const typed = value as { has?: (id: string) => boolean };
  if (typeof typed.has !== "function") {
    return false;
  }
  try {
    return typed.has(userId);
  } catch {
    return false;
  }
}

function estimateNonClaudeParticipantCount(message: Message, selfId: string | null): number | null {
  const channel = message.channel as unknown as {
    isThread?: () => boolean;
    memberCount?: number | null;
    members?: unknown;
  };

  if (typeof channel.isThread === "function") {
    try {
      if (channel.isThread()) {
        if (typeof channel.memberCount === "number") {
          return Math.max(0, channel.memberCount - 1);
        }
        const threadMembers =
          (
            channel.members as
              | { cache?: unknown; has?: (id: string) => boolean; size?: number }
              | undefined
          )?.cache ?? channel.members;
        const threadMemberCount = collectionSize(threadMembers);
        if (threadMemberCount !== null) {
          const selfAdjustment = selfId && collectionHasUser(threadMembers, selfId) ? 1 : 0;
          return Math.max(0, threadMemberCount - selfAdjustment);
        }
      }
    } catch {
      // Fall through to unknown participant count.
    }
  }
  // For regular guild text channels we don't have reliable participant counts
  // without privileged member intent, so force strict mention mode via null.
  return null;
}

export function createDiscordClient(options: DiscordClientOptions): Client {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.DirectMessages,
      GatewayIntentBits.MessageContent,
    ],
    partials: [Partials.Channel],
  });

  client.once("clientReady", () => {
    const user = client.user?.tag ?? "unknown";
    console.log(`Discord client ready as ${user}`);
  });

  client.on("shardDisconnect", (event) => {
    const code = event.code ?? 0;
    console.warn(`Discord gateway disconnected (code=${code}).`);
    options.onGatewayDisconnect?.(code);
  });

  client.on("shardReconnecting", () => {
    console.warn("Discord gateway reconnecting...");
    options.onGatewayReconnecting?.();
  });

  client.on("shardResume", (replayedEvents) => {
    console.log(`Discord gateway resumed (replayed=${replayedEvents}).`);
    options.onGatewayResume?.(replayedEvents);
  });

  client.on("error", (error) => {
    console.error("Discord client error", error);
  });

  const observedHumanSendersByChannel = new Map<string, Set<string>>();
  const observedNonClaudeSendersByChannel = new Map<string, Set<string>>();
  const recentlySeenMessageIds = new Map<string, number>();

  const shouldSkipDuplicateMessage = (messageId: string): boolean => {
    const now = Date.now();
    for (const [seenMessageId, seenAt] of recentlySeenMessageIds) {
      if (now - seenAt > RECENT_MESSAGE_ID_TTL_MS) {
        recentlySeenMessageIds.delete(seenMessageId);
      }
    }

    if (recentlySeenMessageIds.has(messageId)) {
      return true;
    }

    recentlySeenMessageIds.set(messageId, now);
    while (recentlySeenMessageIds.size > MAX_RECENT_MESSAGE_IDS) {
      const oldestMessageId = recentlySeenMessageIds.keys().next().value;
      if (!oldestMessageId) {
        break;
      }
      recentlySeenMessageIds.delete(oldestMessageId);
    }
    return false;
  };

  client.on("messageCreate", async (message) => {
    const channelId =
      typeof message.channel?.id === "string" && message.channel.id.length > 0
        ? message.channel.id
        : "unknown";
    const selfId =
      typeof client.user?.id === "string"
        ? client.user.id
        : typeof message.client?.user?.id === "string"
          ? message.client.user.id
          : null;
    const authorId = typeof message.author.id === "string" ? message.author.id : null;
    if (authorId && authorId !== selfId) {
      const observedNonClaude =
        observedNonClaudeSendersByChannel.get(channelId) ?? new Set<string>();
      observedNonClaude.add(authorId);
      observedNonClaudeSendersByChannel.set(channelId, observedNonClaude);

      if (!message.author.bot) {
        const observedHumans = observedHumanSendersByChannel.get(channelId) ?? new Set<string>();
        observedHumans.add(authorId);
        observedHumanSendersByChannel.set(channelId, observedHumans);
      }
    }

    if (message.author.bot) {
      if (selfId && authorId === selfId) {
        return;
      }
      // Allow bot-to-bot steering only when explicitly mentioned.
      if (!hasExplicitBotMention(message, selfId)) {
        return;
      }
    }
    // Ignore Discord system/service events (join/welcome/pins/boost/etc.).
    const isSystemOrServiceMessage =
      message.system ||
      (typeof message.type === "number" &&
        message.type !== MessageType.Default &&
        message.type !== MessageType.Reply);
    if (isSystemOrServiceMessage) {
      return;
    }
    if (typeof message.id === "string" && shouldSkipDuplicateMessage(message.id)) {
      return;
    }
    const observedHumanUserCount = observedHumanSendersByChannel.get(channelId)?.size ?? 0;
    const observedNonClaudeUserCount = observedNonClaudeSendersByChannel.get(channelId)?.size ?? 0;
    const participantNonClaudeUserCount = isGuildMessage(message)
      ? estimateNonClaudeParticipantCount(message, selfId)
      : null;
    const sharedChannel =
      isGuildMessage(message) &&
      (participantNonClaudeUserCount === null ? true : participantNonClaudeUserCount > 1);
    const content = message.content.trim();
    if (!content && message.attachments.size === 0) {
      return;
    }
    const mentionPolicy =
      options.shouldRequireMentionForMessage?.(message) ??
      options.requireMentionInMultiUserChannels;
    const requireMention = mentionPolicy === "always" || (mentionPolicy === true && sharedChannel);
    if (requireMention && isGuildMessage(message)) {
      if (!hasExplicitBotMention(message, selfId)) {
        return;
      }
    }

    try {
      await options.onUserMessage(message, {
        observedHumanUserCount,
        observedNonClaudeUserCount,
        participantNonClaudeUserCount,
        sharedChannel,
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      console.error(`message handler failed: ${detail}`);
      const msg = error instanceof Error ? error.message : "Unknown error";
      try {
        await message.reply(`❌ Failed to process message: ${msg}`);
      } catch (replyError) {
        const replyDetail = replyError instanceof Error ? replyError.message : String(replyError);
        console.error(`failed to send message error reply: ${replyDetail}`);
      }
    }
  });

  client.on("interactionCreate", async (interaction) => {
    if (interaction.isButton()) {
      try {
        await options.onButtonInteraction(interaction);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        console.error(`button interaction failed: ${detail}`);
        const msg = error instanceof Error ? error.message : "Unknown error";
        try {
          if (interaction.deferred || interaction.replied) {
            await interaction.followUp({ content: `❌ ${msg}`, flags: MessageFlags.Ephemeral });
          } else {
            await interaction.reply({ content: `❌ ${msg}`, flags: MessageFlags.Ephemeral });
          }
        } catch (replyError) {
          const replyDetail = replyError instanceof Error ? replyError.message : String(replyError);
          console.error(`failed to send button error reply: ${replyDetail}`);
        }
      }
      return;
    }

    if (interaction.isChatInputCommand()) {
      try {
        await options.onSlashCommand(interaction);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        console.error(`slash command failed: ${detail}`);
        const msg = error instanceof Error ? error.message : "Unknown error";
        try {
          if (interaction.deferred || interaction.replied) {
            await interaction.followUp({ content: `❌ ${msg}`, flags: MessageFlags.Ephemeral });
          } else {
            await interaction.reply({ content: `❌ ${msg}`, flags: MessageFlags.Ephemeral });
          }
        } catch (replyError) {
          const replyDetail = replyError instanceof Error ? replyError.message : String(replyError);
          console.error(`failed to send slash error reply: ${replyDetail}`);
        }
      }
    }
  });

  client.on("threadUpdate", async (oldThread, newThread) => {
    const didArchive = !oldThread.archived && newThread.archived;
    const didUnarchive = oldThread.archived && !newThread.archived;
    if (!didArchive && !didUnarchive) {
      return;
    }
    const type = didArchive ? "archived" : "unarchived";
    try {
      await options.onThreadLifecycle?.({
        type,
        threadId: newThread.id,
        parentId: newThread.parentId,
        threadName: newThread.name,
        thread: newThread,
      });
    } catch (error) {
      console.error("thread lifecycle handler failed", error);
    }
  });

  client.on("threadDelete", async (thread) => {
    try {
      await options.onThreadLifecycle?.({
        type: "deleted",
        threadId: thread.id,
        parentId: thread.parentId,
        threadName: thread.name,
        thread,
      });
    } catch (error) {
      console.error("thread lifecycle handler failed", error);
    }
  });

  return client;
}

export async function startDiscordClient(options: DiscordClientOptions): Promise<Client> {
  const client = createDiscordClient(options);
  await client.login(options.token);
  return client;
}
