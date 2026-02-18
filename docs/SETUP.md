# Setup Guide

## Prerequisites

- **[Bun](https://bun.sh)** — `curl -fsSL https://bun.sh/install | bash`
- **[Claude Code](https://claude.ai/code)** — installed and authenticated (`claude` in your PATH)
- **A Discord account**

> **Note on auth**: claude-on-discord uses Claude Code's existing credentials — no separate API key required. As long as `claude` works in your terminal, the bot will work.

---

## 1. Create a Discord Application

Go to **[discord.com/developers/applications](https://discord.com/developers/applications)** → **New Application** → give it a name → Create.

---

## 2. Create the Bot

In your new application, go to the **Bot** tab on the left sidebar.

**Copy your token:**
- Click **Reset Token** → confirm → copy it somewhere safe
- This is your `DISCORD_TOKEN` — treat it like a password

**Enable required intents** (same page, scroll down to Privileged Gateway Intents):
- ✅ **Message Content Intent** — required, the bot needs to read your messages

---

## 3. Get Your IDs

**Application ID:**
- Go to the **General Information** tab
- Copy **Application ID** — this is your `APPLICATION_ID`

**Server (Guild) ID:**
- Open Discord, go to your server
- Right-click the server name → **Copy Server ID**
- (If you don't see this option: Settings → Advanced → enable Developer Mode first)
- This is your `DISCORD_GUILD_ID`

---

## 4. Install and Configure

```bash
git clone https://github.com/spanishflu-est1918/claude-on-discord
cd claude-on-discord
bun install
bun run setup
```

The setup wizard will ask for:
- Discord bot token → paste from step 2
- Application ID → paste from step 3
- Guild/server ID → paste from step 3
- Default working directory → your projects folder (e.g. `~/www` or `~/code`)

It writes a `.env` file and prints an invite URL.

---

## 5. Invite the Bot

The setup wizard offers to open the invite URL automatically. If it doesn't open, copy it from the terminal output and open it in your browser.

Select your server → **Authorize**.

---

## 6. Start

```bash
bun start
```

You'll see preflight checks confirming everything is connected:

```
[OK] Working directory: ~/www is readable and writable.
[OK] Database path: database directory is ready.
[OK] Discord auth: Authenticated as bot your-bot-name (...)
[OK] Discord guild access: Bot can access guild Your Server (...)
```

If anything shows `[FAIL]`, see [TROUBLESHOOTING.md](TROUBLESHOOTING.md).

---

## 7. First Message

In any channel where the bot is present, set your working directory:

```
/project path:~/www/my-project
```

Then just talk:

```
what's in this project?
```

Claude Code reads your actual files and responds. You're running.

---

## Keeping It Running

For persistent use, run it as a background process or add it to your shell startup. A simple approach:

```bash
# Run detached, logs to file
nohup bun start > ~/claude-discord.log 2>&1 &
```

Or use whatever process manager you already have (launchd on macOS, systemd on Linux, pm2, etc.).

---

## Next Steps

- `/systemprompt set` — give a channel its own persona or context
- `/model claude-opus-4-5` — switch models per channel
- Create a thread in any channel to start a parallel branch
- `/worktree thread` — bind a thread to its own git worktree

Full command reference in the [README](../README.md).
