# claude-on-discord

## Project Purpose

`claude-on-discord` brings Claude Code into Discord as a personal local tool.
It should feel like Claude Code in terminal, but controlled through Discord:

- Same coding/tooling flow (read/write/edit/bash/grep)
- Same `CLAUDE.md` behavior and project context
- Same MCP server support via `.claude/mcp.json`
- Session continuity per Discord channel

This is intentionally single-user and local-first, not a multi-tenant SaaS.

## Core Product Model

- Bot can run in any channel it is added to
- Each channel maps to its own Claude session + working directory
- Default working directory is configurable (for example `~/www`)
- `/project` switches cwd (history carries over by default)
- `/bash` executes shell commands directly, without invoking Claude

## Stack

- Runtime: Bun
- Language: TypeScript
- Discord: `discord.js` v14
- Claude integration: `@anthropic-ai/claude-agent-sdk`
- Storage: SQLite via `bun:sqlite`

## Architecture Targets

- One SDK `query()` call per incoming user message
- Use `resume: sessionId` for continuity
- Track active query to support:
  - soft stop: `interrupt()`
  - hard stop: `AbortController.abort()`
  - model switches: `setModel()`
  - task stop: `stopTask(taskId)`
  - rewind support: `rewindFiles()`

## Streaming UX Targets

- Partial text streams edit a Discord message in place
- Thinking/tool events are rendered as compact structured blocks
- Two stop buttons while running:
  - `⏸️ Interrupt` (soft stop)
  - `🛑 Abort` (hard kill)
- Status reactions on user message:
  - `🧠` thinking
  - `💻` coding/tools
  - `🔍` reading/searching
  - `✅` complete or `❌` error

## Data Model

SQLite tables:

- `channels` (channel ↔ cwd/session/model mapping)
- `session_costs` (per-turn cost/duration/model accounting)
- `settings` (global key/value config)

## Reference Repositories

When implementing or refactoring, verify behavior against:

- `/Users/gorkolas/www/claude-code-discord`
- `/Users/gorkolas/www/claude-code-telegram`
- `/Users/gorkolas/www/openclaw`

Priority references:

- chunking: `openclaw/src/discord/chunk.ts`
- query control patterns: `claude-code-discord/claude/query-manager.ts`
- SDK options + MCP loading: `claude-code-discord/claude/client.ts`
- Discord rendering patterns: `claude-code-discord/claude/discord-sender.ts`

## Working Rules

- Use Bun-native tooling (`bun install`, `bun test`, `bun run ...`)
- Prefer strict typing and explicit interfaces at module boundaries
- Keep modules small and testable
- Add tests for chunking, ring buffer, repository, and stop logic before expanding features
- Slash command architecture:
  - One slash command per file, named by command (for example `fork-command.ts`, `merge-command.ts`, `project-command.ts`)
  - Keep a thin slash-command router that only dispatches to command modules
  - Do not add new generic `helpers` modules for command behavior
  - Shared logic should live in explicitly named action/service modules (for example `fork-action.ts`)
- MCP/tool reuse requirement:
  - Each slash command must expose core behavior through a reusable typed action/service function
  - Discord command files should adapt Discord I/O to that reusable action, not own the business logic
  - MCP tools and internal agents must call the same action/service function used by slash commands
