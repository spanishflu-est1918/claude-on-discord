import {
  type AnyThreadChannel,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  Client,
  GatewayIntentBits,
  type Message,
  MessageFlags,
  Partials,
} from "discord.js";

export interface DiscordClientOptions {
  token: string;
  onUserMessage: (message: Message) => Promise<void>;
  onSlashCommand: (interaction: ChatInputCommandInteraction) => Promise<void>;
  onButtonInteraction: (interaction: ButtonInteraction) => Promise<void>;
  requireMentionInMultiUserChannels?: boolean;
  shouldRequireMentionForMessage?: (message: Message) => boolean;
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
    return false;
  }
  const mentionPattern = new RegExp(`<@!?${escapeRegExp(botId)}>`);
  return mentionPattern.test(message.content);
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

  client.on("messageCreate", async (message) => {
    if (message.author.bot) {
      return;
    }
    const content = message.content.trim();
    if (!content && message.attachments.size === 0) {
      return;
    }
    const requireMention =
      options.shouldRequireMentionForMessage?.(message) ??
      options.requireMentionInMultiUserChannels;
    if (requireMention && message.guildId) {
      const senderId = typeof message.author.id === "string" ? message.author.id : "";
      if (senderId) {
        const seenInChannel = observedHumanSendersByChannel.get(message.channel.id) ?? new Set();
        seenInChannel.add(senderId);
        observedHumanSendersByChannel.set(message.channel.id, seenInChannel);

        if (seenInChannel.size > 1) {
          const botId =
            typeof client.user?.id === "string"
              ? client.user.id
              : typeof message.client.user?.id === "string"
                ? message.client.user.id
                : null;
          if (!hasExplicitBotMention(message, botId)) {
            return;
          }
        }
      }
    }

    try {
      await options.onUserMessage(message);
    } catch (error) {
      console.error("message handler failed", error);
      const msg = error instanceof Error ? error.message : "Unknown error";
      await message.reply(`❌ Failed to process message: ${msg}`);
    }
  });

  client.on("interactionCreate", async (interaction) => {
    if (interaction.isButton()) {
      try {
        await options.onButtonInteraction(interaction);
      } catch (error) {
        console.error("button interaction failed", error);
        const msg = error instanceof Error ? error.message : "Unknown error";
        if (interaction.deferred || interaction.replied) {
          await interaction.followUp({ content: `❌ ${msg}`, flags: MessageFlags.Ephemeral });
        } else {
          await interaction.reply({ content: `❌ ${msg}`, flags: MessageFlags.Ephemeral });
        }
      }
      return;
    }

    if (interaction.isChatInputCommand()) {
      try {
        await options.onSlashCommand(interaction);
      } catch (error) {
        console.error("slash command failed", error);
        const msg = error instanceof Error ? error.message : "Unknown error";
        if (interaction.deferred || interaction.replied) {
          await interaction.followUp({ content: `❌ ${msg}`, flags: MessageFlags.Ephemeral });
        } else {
          await interaction.reply({ content: `❌ ${msg}`, flags: MessageFlags.Ephemeral });
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
