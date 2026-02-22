# claude-on-discord

Claude Code in Discord. Real filesystem. Real tools. No SSH required.

> Inspired by [claude-code-telegram](https://github.com/punkpeye/claude-code-telegram) — built on Discord because Discord has threads.

---

## Thread Branching

Create a Discord thread and it becomes a parallel coding lane — automatically.

The new thread inherits everything from the parent channel: working directory, model, conversation history, and system prompt. No setup. No context loss. Just branch and go.

Enable `AUTO_THREAD_WORKTREE=true` and each thread also gets its own git worktree, fully bootstrapped (`bun install` / `pnpm install` / etc. runs automatically). Real parallel branches, not just separate chats.

---

## Per-Channel System Prompts

Every channel can have its own system prompt. One channel is your Rails expert. Another is your senior TypeScript reviewer. Another speaks only in bash one-liners.

```
/systemprompt set You are a senior Rails developer. Be terse. No explanations unless asked.
```

System prompts persist per channel and survive session resets. Switch projects, the prompt stays.

---

## Claude Code vs other AI tools

Claude Code goes deeper than general-purpose AI assistants. It reads your entire codebase, runs shell commands, manages git history, installs packages, runs tests, opens PRs. It's built for the kind of work that actually requires understanding a real codebase — complex refactors, architectural decisions, features that have to land right.

If you're already running agents in Discord — OpenClaw or otherwise — Claude Code belongs there too. Same surface. Different depth. Use the right tool for the task.

---

## How It Works

- **Channel = coding lane** — each channel has its own working directory, model, and Claude session
- **Thread = branch** — inherits full parent context, optionally gets its own git worktree
- **Streams everything** — partial text, thinking previews, tool events, live-edited in a single message
- **Your machine** — files are real, tools are real, Claude Code runs locally

---

## Quick Start

**Requires**: [Bun](https://bun.sh) · [Claude Code](https://claude.ai/code) (installed + authenticated) · a Discord account

```bash
git clone https://github.com/spanishflu-est1918/claude-on-discord
cd claude-on-discord
bun install
bun run setup    # interactive: writes .env, prints Discord invite URL
```

Invite the bot to your server, then:

```bash
bun start
```

**First time?** See the [full setup guide](docs/SETUP.md) — it walks through creating the Discord app, getting your credentials, and first run.

---

## Commands

| Command | What it does |
|---------|-------------|
| `/project [path]` | Switch working directory — no path on macOS opens Finder picker |
| `/new` | Reset session and history |
| `/fork [title]` | Create a new thread from the current channel (conversation fork) |
| `/model <name>` | Switch Claude model |
| `/bash <command>` | Run shell command directly in current project |
| `!<command>` | Direct shell shortcut from any channel message |
| `/systemprompt set/show/clear` | Per-channel system prompt |
| `/mode set/show/clear` | Per-session Claude permission mode (including `plan`) |
| `/worktree create/list/remove/thread` | Git worktree management |
| `/pr open/draft/status/merge` | GitHub PR workflow (requires `gh` CLI) |
| `/diff` | Current lane patch as a `.diff` attachment |
| `/screenshot [url]` | Webpage screenshot via agent-browser |
| `/cost` | Per-channel spend and turn count |
| `/status` | Channel status, session, branch info |
| `/branches` | Active thread branches with worktree info |
| `/compact` | Compact context and reset session |
| `start` (CLI) | Start self-healing supervisor + secure control API (recommended) |
| `worker` (CLI) | Start bridge directly without supervisor (advanced/debug) |
| `guardian` (CLI) | Alias for `start` |

While Claude is running, **Interrupt** (soft stop) and **Abort** (hard stop) buttons appear inline.

---

## Configuration

Copy `.env.example` → `.env`:

```env
# Required
DISCORD_TOKEN=            # Discord bot token
APPLICATION_ID=           # Discord application ID
DISCORD_GUILD_IDS=        # Comma-separated server IDs (preferred)
DISCORD_GUILD_ID=         # Single server ID fallback (legacy)

# Optional guardian control overrides
GUARDIAN_CONTROL_SECRET=
GUARDIAN_CONTROL_BIND=0.0.0.0
```

Minimal starter template: [.env.example](.env.example)

Advanced overrides are still supported (worktree behavior, session limits, watchdog tuning, restart backoff, auth skew/nonce windows), but intentionally omitted from the default template to reduce setup friction.

For deep thread/run diagnostics, enable internal tracing with `THREAD_DEBUG_TRACE=1` (optional file sink: `THREAD_DEBUG_TRACE_FILE=./data/thread-debug.log`). See [Troubleshooting](docs/TROUBLESHOOTING.md).

### Guardian mode (default `start`, recommended for mobile reliability)

Run with self-healing supervision and a remote control surface:

```bash
bun start
```

Equivalent aliases:

```bash
bun run guardian
claude-on-discord start
```

On startup, guardian prints a ready-to-open mobile control URL (already tokenized), so you can open it directly on your phone.

What it adds:

- automatic worker restart with backoff/cooldown crash-loop protection
- heartbeat-based stale-process detection and restart
- control API for phone/remote actions:
  - `GET /healthz`
  - `GET /status`
  - `POST /restart`
  - `POST /stop`
  - `POST /start`
  - `GET /logs?tail=200`

Auth options for control API:

1. Bearer token (simple): `Authorization: Bearer $GUARDIAN_CONTROL_SECRET`
2. HMAC headers (replay-protected): `x-guardian-ts`, `x-guardian-nonce`, `x-guardian-signature`
3. Query token for mobile/browser links: `?token=$GUARDIAN_CONTROL_SECRET`

If `GUARDIAN_CONTROL_SECRET` is empty, guardian auto-generates a strong secret and persists it to `GUARDIAN_CONTROL_SECRET_FILE`.

Example (Bearer):

```bash
curl -sS http://127.0.0.1:8787/status \
  -H "Authorization: Bearer $GUARDIAN_CONTROL_SECRET"
```

Security notes:

- default bind is `0.0.0.0` for easier phone access; set `127.0.0.1` if you want local-only control
- if binding non-loopback, keep the auto-generated secret file private (or set your own long `GUARDIAN_CONTROL_SECRET`)
- never expose this API publicly without an authenticated tunnel/reverse proxy

---

## More Features

- **MCP support** — loads `.claude/mcp.json` from your project directory automatically
- **Attachment I/O** — send files in, Claude can send files back to Discord
- **Multi-user mention policy** — require `@bot` mention in shared channels (global + per-channel)
- **Cost tracking** — SQLite-backed per-channel spend and turn counts
- **Startup preflight** — checks working dir, database, and Discord auth before boot

---

## Roadmap

- `→` Interview mode — Claude asks structured clarifying questions (with choices) before starting a task, mirroring Claude Code's native interview behavior
- `→` Plan mode — proposal-first workflow with explicit approval before tool execution
- `→` Thinking mode — extended thinking per channel for deep analysis and architectural work
- `→` `npx` distribution — `npx claude-on-discord setup`, no clone required
- `→` tmux attach — attach to running tmux sessions from Discord, monitor builds and dev servers from your phone
- `→` Fix double threads — deduplicate thread creation events at the gateway level
- `→` Worktree per thread, fully automatic
- `→` Webhooks into channels — map signed webhook endpoints to Discord channels for work automation
- `→` MCP parity for slash commands — expose every slash command as an MCP tool backed by the same action/service implementation
- `→` Agent-guided `/fork` tool — Claude proposes and creates a new thread lane after explicit user confirmation
- `→` PR review conductor — structured review buttons with targeted prompts
- `→` Orphan process reaper — detect/kill stale Claude subprocesses and clear stuck channel run state
- `→` Codex support — run OpenAI Codex CLI as an alternative agent, per channel

---

## Development

```bash
bun run dev        # Watch mode
bun run typecheck  # TypeScript
bun run lint       # Biome
bun test           # Tests
```

Docs: [ARCHITECTURE](docs/ARCHITECTURE.md) · [SECURITY](docs/SECURITY.md) · [TROUBLESHOOTING](docs/TROUBLESHOOTING.md)

---

Built with [Claude Agent SDK](https://github.com/anthropics/claude-agent-sdk) + [discord.js](https://discord.js.org)
