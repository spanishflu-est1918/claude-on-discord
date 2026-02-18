import { REST, Routes, SlashCommandBuilder } from "discord.js";

const slashCommands = [
  new SlashCommandBuilder()
    .setName("project")
    .setDescription("Switch project dir; path is relative to current dir if not absolute")
    .addStringOption((option) =>
      option
        .setName("path")
        .setDescription("Optional project path (relative to current dir, absolute, or ~/...)"),
    ),
  new SlashCommandBuilder().setName("new").setDescription("Reset Claude session for this channel"),
  new SlashCommandBuilder().setName("status").setDescription("Show current channel session info"),
  new SlashCommandBuilder()
    .setName("compact")
    .setDescription("Compact in-memory context and reset the Claude session"),
  new SlashCommandBuilder()
    .setName("bash")
    .setDescription("Run a shell command directly in this channel's working directory")
    .addStringOption((option) =>
      option.setName("command").setDescription("Shell command to execute").setRequired(true),
    ),
  new SlashCommandBuilder()
    .setName("model")
    .setDescription("Set Claude model for this channel")
    .addStringOption((option) =>
      option.setName("name").setDescription("Model name (e.g. sonnet, opus)").setRequired(true),
    ),
  new SlashCommandBuilder()
    .setName("systemprompt")
    .setDescription("Manage per-channel system prompt")
    .addSubcommand((subcommand) =>
      subcommand
        .setName("set")
        .setDescription("Set system prompt for this channel")
        .addStringOption((option) =>
          option
            .setName("text")
            .setDescription("System prompt text")
            .setRequired(true)
            .setMaxLength(4000),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand.setName("show").setDescription("Show current channel system prompt"),
    )
    .addSubcommand((subcommand) =>
      subcommand.setName("clear").setDescription("Clear current channel system prompt"),
    ),
  new SlashCommandBuilder().setName("cost").setDescription("Show spend for this channel"),
  new SlashCommandBuilder()
    .setName("branch")
    .setDescription("Manage conversation branches for this channel")
    .addSubcommand((subcommand) =>
      subcommand.setName("current").setDescription("Show current branch"),
    )
    .addSubcommand((subcommand) =>
      subcommand.setName("list").setDescription("List available branches"),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("fork")
        .setDescription("Fork current branch into a new branch")
        .addStringOption((option) =>
          option.setName("name").setDescription("Optional branch name").setMaxLength(48),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("switch")
        .setDescription("Switch active branch by id or name")
        .addStringOption((option) =>
          option
            .setName("target")
            .setDescription("Branch id or name to switch to")
            .setRequired(true),
        ),
    ),
  new SlashCommandBuilder()
    .setName("worktree")
    .setDescription("Manage git worktrees")
    .addStringOption((option) =>
      option
        .setName("action")
        .setDescription("Action to execute")
        .setRequired(true)
        .addChoices(
          { name: "create", value: "create" },
          { name: "list", value: "list" },
          { name: "remove", value: "remove" },
        ),
    )
    .addStringOption((option) =>
      option.setName("path").setDescription("Path for create/remove actions"),
    )
    .addStringOption((option) =>
      option.setName("branch").setDescription("Branch for create action"),
    ),
];

export async function registerSlashCommands(input: {
  token: string;
  clientId: string;
  guildId?: string;
}): Promise<void> {
  const rest = new REST({ version: "10" }).setToken(input.token);
  const body = slashCommands.map((command) => command.toJSON());

  if (input.guildId) {
    try {
      await rest.put(Routes.applicationGuildCommands(input.clientId, input.guildId), { body });
      console.log(`Registered ${body.length} guild slash command(s).`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("Missing Access") || message.includes("50001")) {
        throw new Error(
          `Missing access to guild ${input.guildId}. Ensure the bot is invited to that server and has application.commands scope.`,
        );
      }
      throw error;
    }
    return;
  }

  await rest.put(Routes.applicationCommands(input.clientId), { body });
  console.log(`Registered ${body.length} global slash command(s).`);
}
