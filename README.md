# claude-on-discord

Personal Claude Code bridge for Discord, powered by Bun + TypeScript.

## Setup

Install dependencies:

```bash
bun install
```

Copy env file:

```bash
cp .env.example .env
```

Required env vars:

- `DISCORD_TOKEN` (bot token)
- `APPLICATION_ID` (same value as client/app id)
- `DISCORD_GUILD_ID` (server ID where slash commands are registered)

Run tests:

```bash
bun test
```

Run dev mode:

```bash
bun run dev
```
