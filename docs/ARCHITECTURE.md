# Architecture

## High-Level Model

`claude-on-discord` is a local runtime that bridges Discord messages to Claude Code SDK queries.

- The bot runs on your machine.
- Each Discord channel maps to a local state:
  - `working_dir`
  - `model`
  - `session_id`
  - persisted conversation turns (bounded retention)
- SQLite persists channel/session metadata, conversation history, and spend tracking.

## Core Components

- `src/app.ts`: orchestration loop for Discord events and Claude runs
- `src/discord/client.ts`: Discord client init and event routing
- `src/discord/commands.ts`: slash command definitions and registration
- `src/discord/buttons.ts`: stop/project switch button builders + parsers
- `src/claude/runner.ts`: Claude SDK query wrapper, retries, streaming extraction
- `src/claude/session.ts`: per-channel state lifecycle and project switching rules
- `src/claude/stop.ts`: interrupt/abort tracking for active runs
- `src/db/repository.ts`: channel/session/settings persistence
- `src/discord/thread-branch.ts`: thread metadata parsing + branch-awareness prompt context

## Data Model

SQLite tables:

- `channels`: channel → working dir/session/model mapping
- `session_costs`: per-turn cost/duration/model accounting
- `settings`: key/value storage (includes per-channel system prompts and thread branch metadata)

Per-channel system prompt key pattern:

- `channel_system_prompt:<channel_id>`

Thread branch metadata key pattern:

- `channel_thread_branch:<channel_id>`

## Message Flow

1. User sends a message in Discord.
2. If this is a new thread, bot auto-inherits parent context into thread channel state.
3. Bot resolves channel state (`working_dir`, model, session).
4. Attachments are staged to local temp files and appended to prompt context.
5. Lightweight thread-branch topology metadata is injected into prompt context for branch-aware Q&A.
6. Bot starts a Claude SDK query with:
   - cwd
   - optional session resume
   - system prompt (bridge policy + optional per-channel system prompt)
   - streaming enabled
7. Stream events update Discord status preview (thinking + answer deltas).
8. Final text is posted, generated files are attached, costs/session are saved.

## Reliability Strategy

Runner includes a retry ladder for `exit code 1` startup failures:

1. default config
2. without MCP
3. without session resume
4. without MCP + without resume
5. safe mode (`settingSources=["user"]`)

Project switch safety:

- If project path changes and user selects "keep context", session ID is reset.
- This preserves conversation history while preventing stale resume errors.

## Stop Controls

- `Interrupt`: soft stop via `query.interrupt()`
- `Abort`: hard stop via `AbortController.abort()`

If interrupted and no final text is emitted, final output is rendered as `Interrupted.`.
