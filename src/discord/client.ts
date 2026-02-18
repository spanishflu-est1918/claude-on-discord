import {
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

  return client;
}

export async function startDiscordClient(options: DiscordClientOptions): Promise<Client> {
  const client = createDiscordClient(options);
  await client.login(options.token);
  return client;
}
