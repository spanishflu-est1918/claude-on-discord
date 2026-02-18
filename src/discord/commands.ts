import { REST, Routes, SlashCommandBuilder } from "discord.js";

const slashCommands = [
  new SlashCommandBuilder()
    .setName("project")
    .setDescription("Switch the working directory for this channel")
    .addStringOption((option) =>
      option.setName("path").setDescription("Absolute or ~ path").setRequired(true),
    )
    .addBooleanOption((option) =>
      option.setName("fresh").setDescription("Start with a fresh Claude session"),
    ),
  new SlashCommandBuilder().setName("new").setDescription("Reset Claude session for this channel"),
  new SlashCommandBuilder().setName("status").setDescription("Show current channel session info"),
  new SlashCommandBuilder()
    .setName("model")
    .setDescription("Set Claude model for this channel")
    .addStringOption((option) =>
      option.setName("name").setDescription("Model name (e.g. sonnet, opus)").setRequired(true),
    ),
  new SlashCommandBuilder().setName("cost").setDescription("Show spend for this channel"),
];

export async function registerSlashCommands(input: {
  token: string;
  clientId: string;
  guildId?: string;
}): Promise<void> {
  const rest = new REST({ version: "10" }).setToken(input.token);
  const body = slashCommands.map((command) => command.toJSON());

  if (input.guildId) {
    await rest.put(Routes.applicationGuildCommands(input.clientId, input.guildId), { body });
    console.log(`Registered ${body.length} guild slash command(s).`);
    return;
  }

  await rest.put(Routes.applicationCommands(input.clientId), { body });
  console.log(`Registered ${body.length} global slash command(s).`);
}
