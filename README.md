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

Optional:

- `DISCORD_GUILD_ID` for instant guild command registration during dev (without it, global slash commands can take time to appear).

Run tests:

```bash
bun test
```

Run dev mode:

```bash
bun run dev
```
