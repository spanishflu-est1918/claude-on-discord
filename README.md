# Claude on Discord

Run Claude Code from Discord channels and threads. Real filesystem. Real tools. Real local repos. No SSH required.

This is a local-first bridge between Discord and Claude Code. Each channel becomes a coding lane with its own working directory, model, session, history, system prompt, and cost tracking. Each Discord thread can become a branch of the parent lane, optionally backed by its own git worktree.

Inspired by [`claude-code-telegram`](https://github.com/punkpeye/claude-code-telegram), but built around Discord because Discord has channels, threads, buttons, slash commands, and a collaboration surface people already use.

## What It Proves

- Practical agent workflow design, not just a chatbot.
- Claude Code exposed through a collaborative interface with lanes, threads, buttons, slash commands, and status surfaces.
- Real filesystem and git workflows from Discord: worktrees, diffs, shell commands, PR helpers, generated files, and screenshots.
- Local-first operational thinking: SQLite state, guardian supervisor, preflight checks, crash-loop protection, control API, and troubleshooting docs.
- Product judgment around agent UX: stream tool events, interrupt/abort buttons, per-channel prompts, permission modes, and channel policies.

## Core Model

```text
Discord channel
  -> coding lane
  -> local working directory
  -> Claude Code session
  -> streamed status/tool events
  -> files, diffs, comments, PRs, screenshots
```

```text
Discord thread
  -> inherited parent context
  -> optional git worktree
  -> parallel branch of work
```

## Highlights

- **Channel = coding lane**: each channel has its own working directory, model, session, system prompt, and permission mode.
- **Thread = branch**: a Discord thread inherits parent context and can optionally get a real git worktree.
- **Live streaming**: answer deltas, thinking previews, tool events, and status updates render into Discord.
- **Real tools**: Claude Code can read the repo, edit files, run commands, manage git, and attach generated files.
- **Operator controls**: interrupt, abort, status, cost, diff, branch, PR, and guardian controls are available from Discord.
- **Local-first state**: SQLite stores channel/session metadata, settings, thread branch metadata, conversation turns, and spend tracking.
- **Guardian mode**: self-healing supervisor with heartbeat checks, restart backoff, and a secure control API for mobile/remote operation.

## Quick Start

Requires:

- [Bun](https://bun.sh)
- [Claude Code](https://claude.ai/code), installed and authenticated
- a Discord account and Discord application

Option A, npx distribution:

```bash
npx claude-on-discord setup
npx claude-on-discord start
```

`npx` installs the runtime into `~/.claude-on-discord` on first run. Override with `CLAUDE_ON_DISCORD_HOME`.

Option B, git checkout:

```bash
git clone https://github.com/spanishflu-est1918/claude-on-discord
cd claude-on-discord
bun install
bun run setup
```

The setup wizard writes `.env` and prints a Discord invite URL.

Start the recommended guardian runtime:

```bash
bun start
```

Full setup guide: [`docs/SETUP.md`](docs/SETUP.md).

## Commands

| Command | What it does |
| --- | --- |
| `/project [path]` | Switch working directory. On macOS, no path opens a Finder picker. |
| `/new` | Reset session and history. |
| `/fork [title]` | Create a new thread from the current channel. |
| `/model <name>` | Switch Claude model. |
| `/bash <command>` | Run a shell command directly in the current project. |
| `!<command>` | Direct shell shortcut from any channel message. |
| `/systemprompt set/show/clear` | Manage the per-channel system prompt. |
| `/mode set/show/clear` | Manage per-session Claude permission mode, including `plan`. |
| `/worktree create/list/remove/thread` | Manage git worktrees. |
| `/pr open/draft/status/merge` | Use GitHub PR workflow helpers, requires `gh`. |
| `/diff` | Send the current lane patch as a `.diff` attachment. |
| `/screenshot [url]` | Capture a webpage screenshot through agent-browser. |
| `/cost` | Show per-channel spend and turn count. |
| `/status` | Show channel status, session, and branch info. |
| `/branches` | Show active thread branches and worktree info. |
| `/compact` | Compact context and reset session. |

CLI commands:

| Command | What it does |
| --- | --- |
| `claude-on-discord install [path]` | Install or update runtime. Defaults to `~/.claude-on-discord`. |
| `claude-on-discord setup` | Run setup wizard. |
| `claude-on-discord start` | Start guardian supervisor and secure control API. |
| `claude-on-discord worker` | Start the Discord bridge directly, mainly for debugging. |

While Claude is running, Discord shows inline **Interrupt** and **Abort** buttons.

## Configuration

Copy `.env.example` to `.env`:

```env
DISCORD_TOKEN=
APPLICATION_ID=
DISCORD_GUILD_IDS=
DISCORD_GUILD_ID=
USE_ANTHROPIC_API_KEY=

GUARDIAN_CONTROL_SECRET=
GUARDIAN_CONTROL_BIND=0.0.0.0
```

Minimal template: [`.env.example`](.env.example).

Advanced overrides are supported for worktree behavior, session limits, watchdog tuning, restart backoff, auth skew/nonce windows, and tracing. The default template stays small to reduce setup friction.

For deep thread/run diagnostics:

```env
THREAD_DEBUG_TRACE=1
THREAD_DEBUG_TRACE_FILE=./data/thread-debug.log
```

Troubleshooting guide: [`docs/TROUBLESHOOTING.md`](docs/TROUBLESHOOTING.md).

## Guardian Mode

Guardian mode is the recommended default:

```bash
bun start
```

It adds:

- worker restart with backoff and crash-loop protection
- heartbeat-based stale-process detection
- startup preflight checks
- mobile-friendly control URL
- control API endpoints for health, status, restart, stop, start, and log tailing

Control API auth options:

- Bearer token: `Authorization: Bearer $GUARDIAN_CONTROL_SECRET`
- HMAC headers: `x-guardian-ts`, `x-guardian-nonce`, `x-guardian-signature`
- Query token for mobile links: `?token=$GUARDIAN_CONTROL_SECRET`

If `GUARDIAN_CONTROL_SECRET` is empty, guardian generates and persists a strong secret.

Security note: bot access is equivalent to shell access on the configured workspace. Use trusted servers/channels, keep `.env` local, and do not expose the guardian API publicly without an authenticated tunnel or reverse proxy.

## Architecture

Key components:

```text
src/app.ts                         Discord event orchestration and Claude run lifecycle
src/discord/client.ts              Discord client init and event routing
src/discord/commands.ts            slash command registration
src/discord/buttons.ts             stop/project switch buttons
src/claude/runner.ts               Claude SDK query wrapper, retries, streaming extraction
src/claude/session.ts              per-channel state lifecycle and project switching
src/db/repository.ts               SQLite persistence for channels, settings, turns, costs
src/discord/thread-branch.ts       thread metadata and branch-awareness prompt context
src/guardian/*                     supervisor, control API, auth, heartbeat, log tailing
```

Message flow:

1. User sends a Discord message.
2. The bot resolves channel state: working directory, model, session, prompt policy, thread branch metadata.
3. Attachments are staged to local temp files and appended to the prompt context.
4. Claude Code runs with cwd, optional session resume, streaming enabled, and the configured permission mode.
5. Status, thinking previews, tool events, generated files, costs, and final text are posted back to Discord.

Docs:

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)
- [`docs/SECURITY.md`](docs/SECURITY.md)
- [`docs/TROUBLESHOOTING.md`](docs/TROUBLESHOOTING.md)
- [`docs/DISTRIBUTION.md`](docs/DISTRIBUTION.md)

## Development

```bash
bun install
bun run dev
bun run typecheck
bun run lint
bun test
```

Release/package checks:

```bash
bun run dist:check
```

## Status

Working:

- Discord channel-to-session mapping.
- Thread branching with inherited context.
- Optional worktree-per-thread behavior.
- Per-channel system prompts.
- Session permission modes, including plan mode.
- Shell shortcuts and slash commands.
- Diff, status, cost, branch, PR, screenshot, and compact commands.
- Guardian supervisor and control API.
- SQLite-backed settings, history, and cost tracking.
- Test coverage across app commands, lifecycle, guardian, sessions, worktrees, PR helpers, and routing.

Needs more public packaging:

- Move or mirror into `gorkamolero`.
- Add screenshots from a sanitized test server.
- Add a short architecture diagram to the README.
- Add a concise demo video showing thread branching and tool streaming.

## Portfolio Context

This is one of the strongest agentic-tooling projects in the portfolio. It shows how to turn a powerful local coding agent into an operational collaboration surface with real state, real files, real controls, and a workflow model that maps naturally to Discord.

## Prior Art

Inspired by [`claude-code-telegram`](https://github.com/punkpeye/claude-code-telegram).

## Built With

- [Claude Agent SDK](https://github.com/anthropics/claude-agent-sdk)
- [discord.js](https://discord.js.org)
- Bun
- SQLite
