import { REST, Routes, SlashCommandBuilder, type SlashCommandSubcommandBuilder } from "discord.js";

function addPrOptions(subcommand: SlashCommandSubcommandBuilder): SlashCommandSubcommandBuilder {
  return subcommand
    .addStringOption((option) =>
      option.setName("base").setDescription("Base branch (default: root branch or origin default)"),
    )
    .addStringOption((option) =>
      option.setName("title").setDescription("PR title (optional; defaults to commit-based fill)"),
    )
    .addStringOption((option) =>
      option
        .setName("body")
        .setDescription("PR body (optional; requires title)")
        .setMaxLength(4000),
    );
}

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
  new SlashCommandBuilder()
    .setName("fork")
    .setDescription("Fork this channel conversation into a new thread")
    .addStringOption((option) =>
      option.setName("title").setDescription("Optional thread title").setMaxLength(100),
    ),
  new SlashCommandBuilder().setName("status").setDescription("Show current channel session info"),
  new SlashCommandBuilder()
    .setName("branches")
    .setDescription("List active thread branches and git divergence"),
  new SlashCommandBuilder()
    .setName("diff")
    .setDescription("Show current git patch for this channel as a .diff attachment"),
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
    .setName("screenshot")
    .setDescription("Capture a webpage screenshot via agent-browser")
    .addStringOption((option) =>
      option.setName("url").setDescription("URL to capture (defaults to http://localhost:3000)"),
    )
    .addBooleanOption((option) =>
      option.setName("full").setDescription("Capture full page (default: false)"),
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
  new SlashCommandBuilder()
    .setName("mentions")
    .setDescription("Manage mention requirement policy for this channel")
    .addSubcommand((subcommand) =>
      subcommand
        .setName("set")
        .setDescription("Set per-channel mention policy")
        .addStringOption((option) =>
          option
            .setName("mode")
            .setDescription("Mention policy mode")
            .setRequired(true)
            .addChoices(
              { name: "default", value: "default" },
              { name: "required", value: "required" },
              { name: "off", value: "off" },
            ),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand.setName("show").setDescription("Show effective mention policy for this channel"),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("clear")
        .setDescription("Clear per-channel mention policy override (use global default)"),
    ),
  new SlashCommandBuilder()
    .setName("mode")
    .setDescription("Manage Claude permission mode for the current session")
    .addSubcommand((subcommand) =>
      subcommand
        .setName("set")
        .setDescription("Set current session permission mode override")
        .addStringOption((option) =>
          option
            .setName("mode")
            .setDescription("Permission mode")
            .setRequired(true)
            .addChoices(
              { name: "default", value: "default" },
              { name: "plan", value: "plan" },
              { name: "acceptEdits", value: "acceptEdits" },
              { name: "bypassPermissions", value: "bypassPermissions" },
              { name: "delegate", value: "delegate" },
              { name: "dontAsk", value: "dontAsk" },
            ),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("show")
        .setDescription("Show effective permission mode for the current session"),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("clear")
        .setDescription("Clear current session permission mode override (use global default)"),
    ),
  new SlashCommandBuilder().setName("cost").setDescription("Show spend for this channel"),
  new SlashCommandBuilder()
    .setName("pr")
    .setDescription("Create a GitHub pull request from current branch")
    .addSubcommand((subcommand) =>
      addPrOptions(subcommand.setName("open").setDescription("Create/open a regular pull request")),
    )
    .addSubcommand((subcommand) =>
      addPrOptions(subcommand.setName("draft").setDescription("Create a draft pull request")),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("status")
        .setDescription("Show PR status for current branch (if one exists)"),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("view")
        .setDescription("Show PR details for current branch (if one exists)"),
    )
    .addSubcommand((subcommand) =>
      subcommand.setName("checks").setDescription("Show CI/check status for current branch PR"),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("merge")
        .setDescription("Merge current branch PR (requires confirm=true)")
        .addBooleanOption((option) =>
          option
            .setName("confirm")
            .setDescription("Required safety confirmation")
            .setRequired(true),
        )
        .addStringOption((option) =>
          option
            .setName("method")
            .setDescription("Merge strategy")
            .addChoices(
              { name: "squash", value: "squash" },
              { name: "rebase", value: "rebase" },
              { name: "merge", value: "merge" },
            ),
        )
        .addBooleanOption((option) =>
          option
            .setName("delete_branch")
            .setDescription("Delete branch after merge (default: false)"),
        )
        .addBooleanOption((option) =>
          option.setName("admin").setDescription("Use admin merge for protected branches"),
        ),
    ),
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
  new SlashCommandBuilder()
    .setName("kill")
    .setDescription("Kill the active Claude process, archive this thread, and mark it red"),
];

export function getSlashCommandDefinitions(): ReturnType<SlashCommandBuilder["toJSON"]>[] {
  return slashCommands.map((command) => command.toJSON());
}

export async function registerSlashCommands(input: {
  token: string;
  clientId: string;
  guildId?: string;
}): Promise<void> {
  const rest = new REST({ version: "10" }).setToken(input.token);
  const body = getSlashCommandDefinitions();

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
