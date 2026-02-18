# claude-on-discord

Claude Code in Discord. Real filesystem. Real tools. No SSH required.

Each channel becomes a coding lane — its own project, session, and context. Create a thread and it inherits the parent context, becoming a parallel branch. Everything runs on your machine and streams back to Discord.

> Inspired by [claude-code-telegram](https://github.com/punkpeye/claude-code-telegram) — built on Discord because Discord has threads.

---

## Quick Start

**Requires**: [Bun](https://bun.sh), a Claude subscription, a Discord bot token

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

---

## How It Works

- **Channel = coding lane** — each channel has its own working directory, model, and Claude session
- **Thread = branch** — create a Discord thread and it inherits parent context automatically (project, model, conversation, system prompt)
- **Streams everything** — partial text, thinking previews, tool events, all live-edited in a single Discord message
- **Your machine** — files are real, tools are real, Claude Code runs locally with full filesystem access

---

## Commands

| Command | What it does |
|---------|-------------|
| `/project [path]` | Switch working directory — no path on macOS opens Finder picker |
| `/new` | Reset session and history |
| `/model <name>` | Switch Claude model |
| `/bash <command>` | Run shell command directly in current project |
| `!<command>` | Direct shell shortcut from any channel message |
| `/systemprompt set/show/clear` | Per-channel system prompt |
| `/worktree create/list/remove/thread` | Git worktree management |
| `/pr open/draft/status/merge` | GitHub PR workflow (requires `gh` CLI) |
| `/diff` | Current lane patch as a `.diff` attachment |
| `/screenshot [url]` | Webpage screenshot via agent-browser |
| `/cost` | Per-channel spend and turn count |
| `/status` | Channel status, session, branch info |
| `/branches` | Active thread branches with worktree info |
| `/compact` | Compact context and reset session |

While Claude is running, **Interrupt** (soft stop) and **Abort** (hard stop) buttons appear inline.

---

## Configuration

Copy `.env.example` → `.env`:

```env
# Required
DISCORD_TOKEN=            # Discord bot token
APPLICATION_ID=           # Discord application ID
DISCORD_GUILD_ID=         # Your server ID

# Optional
DEFAULT_WORKING_DIR=~/www
DEFAULT_MODEL=sonnet
AUTO_THREAD_WORKTREE=false
REQUIRE_MENTION_IN_MULTI_USER_CHANNELS=false
```

Full reference: [.env.example](.env.example)

---

## More Features

- **MCP support** — loads `.claude/mcp.json` from your project directory automatically
- **Attachment I/O** — send files in, Claude can send files back to Discord
- **Per-channel system prompts** — different context per project lane
- **Multi-user mention policy** — require `@bot` mention in shared channels (global + per-channel)
- **Cost tracking** — SQLite-backed per-channel spend and turn counts
- **Startup preflight** — checks working dir, database, and Discord auth with actionable diagnostics on failure

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
