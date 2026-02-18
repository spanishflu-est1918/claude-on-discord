# Security

## Threat Model

This project is local-first and single-operator, but high impact:

- can execute shell commands
- can edit files in local repos
- can run with `bypassPermissions` mode

Treat bot access like shell access.

## Operational Rules

- Never commit real tokens to git.
- Rotate Discord bot token if leaked.
- Keep `.env` local only.
- Limit bot to trusted servers/channels.

## Current Defaults and Risks

Default permission mode is `bypassPermissions` for speed.

Tradeoff:

- Pros: less friction in coding workflows
- Cons: more dangerous if bot is triggered maliciously

If sharing server space, consider stricter permission mode.

## Recommended Hardening

- Run bot in isolated local user/workspace where possible.
- Scope Discord bot permissions to minimum required.
- Restrict channel access to trusted users.
- Add allowlist controls if moving beyond personal usage.

## Secrets Handling

Expected secrets:

- `DISCORD_TOKEN`

Sensitive identifiers (not secret but should be handled carefully):

- `APPLICATION_ID`
- `DISCORD_PUBLIC_KEY`
- `DISCORD_GUILD_ID`

## Incident Response

If token is exposed:

1. Regenerate token in Discord Developer Portal.
2. Update local `.env`.
3. Restart bot.
4. Audit recent bot actions.
