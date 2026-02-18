# claude-on-discord

`claude-on-discord` is a local-first Discord bridge for Claude Code.
It gives you a channel-based coding workflow in Discord while keeping real filesystem/project execution on your machine.

## Why This Exists

- Claude Code is excellent in terminal, but Discord is always open on desktop + mobile.
- You can run real coding/help workflows from Discord without SSHing into your machine.
- Each Discord channel can act like a separate working lane with its own project/session context.

## Current Feature Set

- Per-channel working directory, model, and session state
- `/project` switching with keep/clear context controls
- Session safety on project switch (`keep` restarts session if directory changes)
- Channel topic sync on project switch (project + git branch when available)
- Streaming text + thinking preview in status updates
- Stop controls on active runs:
  - `Interrupt` (soft stop)
  - `Abort` (hard stop)
- Per-channel custom system prompt:
  - `/systemprompt set`
  - `/systemprompt show`
  - `/systemprompt clear`
- Automatic thread branching:
  - when a new Discord thread starts, it inherits parent context automatically
  - inherited context includes project, model, in-memory turns, and system prompt
  - optional auto-worktree mode can provision per-thread git worktrees
  - prompt context includes lightweight thread-branch metadata for branch-aware Q&A
- Direct shell execution via `/bash`
- Git worktree utilities via `/worktree`
- Cost tracking via `/cost`
- Attachment input staging and generated file output back into Discord
- MCP config loading from project `.claude/mcp.json`
- Recovery ladder for `Claude Code process exited with code 1` failure modes

## Power Feature: Thread Branching

- Branching is Discord-native: create a thread, and it becomes a branch lane automatically.
- New threads inherit parent execution context:
  - working directory
  - model
  - in-memory conversation turns
  - per-channel system prompt
- Prompts include lightweight branch/thread topology metadata so Claude can answer lineage questions when asked.
- Result: parallel coding tracks without losing local execution guarantees.

## Quick Start

### 1. Install

```bash
bun install
```

Optional local CLI entrypoint:

```bash
node ./bin/claude-on-discord.js help
```

### 2. Run Interactive Setup

```bash
bun run setup
```

This writes `.env` and prints a Discord invite URL with the required scopes.
Setup can optionally open the invite URL in your browser immediately.

### 3. Invite the Bot

Use the URL from `bun run init`, authorize it in your target server, then run:

```bash
bun run dev
```

or:

```bash
bun run start
```

Equivalent CLI commands:

```bash
claude-on-discord setup
claude-on-discord init
claude-on-discord dev
claude-on-discord start
```

`bun run start` now performs startup preflight checks (working dir, database path, Discord auth/guild reachability) and prints actionable diagnostics before the bot boots.

## Required Configuration

Required environment variables:

- `DISCORD_TOKEN`: bot token
- `APPLICATION_ID`: Discord application ID
- `DISCORD_GUILD_ID`: guild/server ID for slash command registration

Common optional variables:

- `DEFAULT_WORKING_DIR`: default project root (default: `~/www`)
- `DATABASE_PATH`: sqlite path (default: `./data/claude-on-discord.sqlite`)
- `DEFAULT_MODEL`: Claude model alias/name (default: `sonnet`)
- `AUTO_THREAD_WORKTREE`: auto-provision per-thread git worktrees (default: `false`)
- `CLAUDE_PERMISSION_MODE`: SDK permission mode (default: `bypassPermissions`)

## Commands

- `/project [path]`: switch project directory
  - no `path` on macOS: opens Finder picker
  - with `path`: resolves relative to current channel project dir unless absolute/`~/`
  - follow-up buttons let you keep or clear context
- `/new`: reset channel session/history
- `/status`: show current channel status and totals
  - includes thread branch/root/parent info when running inside thread branches
- `/branches`: list active thread branches with worktree/divergence info
- `/model <name>`: set channel model
- `/systemprompt set <text>`: set per-channel system prompt (session restarts)
- `/systemprompt show`: view current per-channel system prompt
- `/systemprompt clear`: clear per-channel system prompt (session restarts)
- `/bash <command>`: run shell command directly in current project
- `/worktree create|list|remove|thread`: git worktree operations
  - `create`: auto-generates path when omitted
  - `remove`: defaults to current project dir when omitted
  - `thread`: provision/switch this thread to dedicated worktree
- `/compact`: compact in-memory context and reset session
- `/cost`: show total channel spend/turns

## Runtime Behavior

- Each channel maps to one row in `channels` (working dir, model, session ID).
- First message in a new Discord thread auto-clones parent channel context.
- If project changes with context kept, session ID is reset to avoid stale resume failures.
- During active runs, the bot streams partial answer/thinking previews and shows stop buttons.
- Interrupted runs with no final text are rendered as `Interrupted.`.

## Attachments

- Input attachments are downloaded to temp files and added to Claude prompt context.
- Generated files can be sent back to Discord automatically when persisted by Claude.

Known limitation:

- Outgoing image attachment reliability is still inconsistent in some real Discord flows.
- Tracked as technical debt in `gleaming-moseying-codd.md`.

## Development

Run lint:

```bash
bun run lint
```

Typecheck:

```bash
bun run typecheck
```

Run tests:

```bash
bun test
```

## Documentation

- `docs/README.md`
- `docs/ARCHITECTURE.md`
- `docs/TROUBLESHOOTING.md`
- `docs/SECURITY.md`
- `docs/WEBSITE_BRIEF.md`

## Positioning / Next

- This project is moving beyond prototype status and should be documented like a product.
- Next documentation steps:
  - GitHub-ready docs structure (`README`, setup guide, troubleshooting, architecture notes)
  - Website/landing page with workflow demos and use-cases
  - Later: `npx`-friendly distribution flow
- Post-MVP roadmap for branch power users:
  - Optional thread→worktree binding (auto-create per-thread git worktree)
  - Branch diffs summarized in Discord (`/diff` with compact review output)
  - PR flow from thread branch to root/main (`/pr` draft/open)
