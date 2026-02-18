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
    .setName("branches")
    .setDescription("List active thread branches and git divergence"),
  new SlashCommandBuilder()
    .setName("diff")
    .setDescription("Show git diff for this channel (working tree or thread branch)")
    .addStringOption((option) =>
      option.setName("base").setDescription("Base branch/ref for thread branch comparison"),
    )
    .addBooleanOption((option) =>
      option
        .setName("patch")
        .setDescription("Also include diff summary metadata after the patch output"),
    ),
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
    .setName("worktree")
    .setDescription("Manage git worktrees")
    .addSubcommand((subcommand) =>
      subcommand
        .setName("create")
        .setDescription("Create a git worktree (auto path if omitted)")
        .addStringOption((option) =>
          option.setName("path").setDescription("Optional path override"),
        )
        .addStringOption((option) =>
          option.setName("branch").setDescription("Optional branch name"),
        ),
    )
    .addSubcommand((subcommand) => subcommand.setName("list").setDescription("List git worktrees"))
    .addSubcommand((subcommand) =>
      subcommand
        .setName("remove")
        .setDescription("Remove a git worktree (defaults to current project dir)")
        .addStringOption((option) =>
          option.setName("path").setDescription("Optional path override"),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("thread")
        .setDescription("Provision/switch this thread to a dedicated worktree"),
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
