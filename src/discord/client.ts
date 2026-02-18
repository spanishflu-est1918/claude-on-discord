import { Client, GatewayIntentBits, type Message, Partials } from "discord.js";

export interface DiscordClientOptions {
  token: string;
  onUserMessage: (message: Message) => Promise<void>;
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

  client.once("ready", () => {
    const user = client.user?.tag ?? "unknown";
    console.log(`Discord client ready as ${user}`);
  });

  client.on("messageCreate", async (message) => {
    if (message.author.bot) {
      return;
    }
    const content = message.content.trim();
    if (!content && message.attachments.size === 0) {
      return;
    }

    try {
      await options.onUserMessage(message);
    } catch (error) {
      console.error("message handler failed", error);
      const msg = error instanceof Error ? error.message : "Unknown error";
      await message.reply(`❌ Failed to process message: ${msg}`);
    }
  });

  return client;
}

export async function startDiscordClient(options: DiscordClientOptions): Promise<Client> {
  const client = createDiscordClient(options);
  await client.login(options.token);
  return client;
}
