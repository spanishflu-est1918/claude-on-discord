# claude-on-discord — Implementation Plan

## Context

Claude Code is incredible but lives in the terminal. Discord is always open on your phone and desktop. **claude-on-discord** puts Claude Code in Discord — same experience, same tools (Read, Write, Edit, Bash, Grep, etc.), same CLAUDE.md, same MCP servers — but you can use it from anywhere.

This is a **personal tool** that runs on your machine next to your repos. Not a platform, not multi-tenant. Just Claude Code with Discord as the interface instead of a terminal.

**Stack**: Bun, TypeScript, discord.js v14, `@anthropic-ai/claude-agent-sdk` (Max plan), SQLite via `bun:sqlite`
**Repos to look at**:
- ~./www/claude-code-discord
- ~./www/claude-code-telegram
- ~./www/openclaw

VERIFY THIS PLAN AGAINST ALL REPOS

### Onboarding Target (CLI/TUI)

Add an interactive initializer so first-time users can run one command and be ready:

- Collect `DISCORD_TOKEN`, `APPLICATION_ID`, `DISCORD_GUILD_ID`, model, working dir
- Generate/write `.env`
- Print the OAuth invite URL with `bot + applications.commands` scopes
- Validate access early and show clear remediation if guild access is missing
- Prepare packaging path for `npx` onboarding in a later distribution phase

---

## Architecture

### Core Model

- **Bot works in any channel** it has access to — no special channel creation
- Each channel has its own **Claude session** and **working directory**
- Default working dir is a configured base (e.g. `~/www`)
- `/project` switches directory; conversation history carries over by default
- `/bash` runs shell commands directly without Claude (like SSH before starting claude)

### SDK Integration

One `query()` call per user message, with `resume: sessionId` for continuity. The `Query` object gives us:

- `interrupt()` — soft stop (Escape equivalent)
- `abort()` via AbortController — hard kill
- `setModel()` — switch model mid-session
- `stopTask(taskId)` — kill a specific subtask
- `rewindFiles()` — undo file changes
- `initializationResult()` — account info, available models

Reference: `/Users/gorkolas/www/claude-code-discord/claude/query-manager.ts` (full pattern)

### Hybrid Streaming

| SDK Event        | Discord Rendering                                        |
| ---------------- | -------------------------------------------------------- |
| `text` (partial) | Edit message in-place as tokens arrive (debounced 300ms) |
| `thinking`       | Purple embed (0x9b59b6), sent when block completes       |
| `tool_use`       | Compact one-liner: `🛠️ Edit src/index.ts`                |
| `tool_result`    | Spoiler tag (collapsed by default)                       |
| `result`         | Cost footer: `-# 💰 $0.03 · sonnet · 2.1s`               |
| `error`          | Red embed                                                |
| Files/images     | Discord file attachments                                 |

### Stop Mechanism — Two Separate Buttons

Both buttons appear on bot messages while Claude is processing:

- **⏸️ Interrupt** — `query.interrupt()`. Soft stop. Claude finishes current thought, session stays valid.
- **🛑 Abort** — `abortController.abort()`. Hard kill. Everything stops immediately.

### Status Reactions (on user's message)

🧠 thinking → 💻 coding/tools → 🔍 reading/searching → ✅ done (or ❌ error)

---

## Project Structure

```
claude-on-discord/
  src/
    index.ts                    # Entry: create client, wire events, connect
    config.ts                   # Env vars + validation (Zod)
    types.ts                    # Core domain types

    db/
      schema.ts                 # SQLite table definitions
      repository.ts             # CRUD for channels, costs, settings

    discord/
      client.ts                 # discord.js setup, intents, event routing
      commands.ts               # Slash command definitions + registration
      reactions.ts              # Status emoji lifecycle on user messages
      renderer.ts               # SDK event → Discord message pipeline
      chunker.ts                # Code-fence-aware 2000-char splitter (port from OpenClaw)
      buttons.ts                # Interrupt, Abort, Expand button builders
      embeds.ts                 # Thinking, error, status embed builders

    claude/
      session.ts                # Per-channel session lifecycle (create/resume/destroy)
      runner.ts                 # SDK query() wrapper, streaming event dispatch
      stop.ts                   # Interrupt + abort wiring to Query object
      ring-buffer.ts            # Bounded message history per channel

    commands/
      project.ts                # /project — switch working dir
      bash.ts                   # /bash — direct shell execution
      new.ts                    # /new — reset session
      status.ts                 # /status — session info
      model.ts                  # /model — switch model
      compact.ts                # /compact — summarize context
      cost.ts                   # /cost — spending info
      worktree.ts               # /worktree create|list|remove

  tests/
    chunker.test.ts
    ring-buffer.test.ts
    renderer.test.ts
    stop.test.ts
    repository.test.ts
    session.test.ts
    runner.test.ts
    bash.test.ts

  package.json
  tsconfig.json
  biome.json
  .env.example
  CLAUDE.md
```

---

## SQLite Schema

```sql
CREATE TABLE channels (
  channel_id TEXT PRIMARY KEY,
  guild_id TEXT NOT NULL,
  working_dir TEXT NOT NULL,
  session_id TEXT,
  model TEXT NOT NULL DEFAULT 'sonnet',
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE session_costs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  cost_usd REAL NOT NULL DEFAULT 0,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  model TEXT NOT NULL,
  turn_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);
```

---

## Message Flow

```
User types in channel
  ├─ Bot message? → IGNORE
  ├─ Channel registered? → look up working dir (or use default)
  │
  ▼
  Add 🧠 reaction, start typing indicator
  │
  ▼
  Build prompt:
  │  ├─ User message text
  │  ├─ Attachments (images/files → temp files)
  │  └─ Ring buffer context (if no session to resume)
  │
  ▼
  SDK query({ prompt, options: { cwd, resume, permissionMode: 'bypassPermissions' } })
  │  ├─ Store Query + AbortController for stop buttons
  │  └─ Wire SIGTERM handler (SDK sends SIGTERM on abort — must swallow it)
  │
  ├─ for await (message of query):
  │  ├─ text (partial) → create/edit Discord message in-place (debounced)
  │  ├─ thinking → purple embed
  │  ├─ tool_use → compact one-liner + update reaction to 💻
  │  ├─ tool_result → spoiler tag
  │  ├─ result → save session_id, track cost, add ✅ reaction
  │  └─ error → red embed, add ❌ reaction
  │
  ▼
  Finalize: remove stop buttons, add cost footer, clean up reactions
```

---

## Key Code to Port/Reference

| What                  | Source                                         | Notes                                                    |
| --------------------- | ---------------------------------------------- | -------------------------------------------------------- |
| **Chunker**           | `openclaw/src/discord/chunk.ts`                | Port. Code-fence-aware, line-limited, battle-tested      |
| **Query pattern**     | `claude-code-discord/claude/query-manager.ts`  | Reference. Active query storage, interrupt(), stopTask() |
| **SDK options**       | `claude-code-discord/claude/client.ts:157-230` | Reference. How to call `claudeQuery()` with all options  |
| **Message rendering** | `claude-code-discord/claude/discord-sender.ts` | Reference. SDK message → Discord embed mapping           |
| **MCP loading**       | `claude-code-discord/claude/client.ts:8-37`    | Port. Load .claude/mcp.json for MCP servers              |

---

## Slash Commands

| Command                          | Purpose                    | Notes                                                  |
| -------------------------------- | -------------------------- | ------------------------------------------------------ |
| `/project [path]`                | Switch working dir         | Default carries history. `--fresh` flag to start clean |
| `/bash <command>`                | Run shell command directly | No Claude, no AI overhead. Output in code blocks       |
| `/new`                           | Reset Claude session       | Keeps working dir, clears session + ring buffer        |
| `/status`                        | Show session info          | Project, branch, model, session cost, active/idle      |
| `/model [name]`                  | Switch model               | Uses `query.setModel()` if mid-session                 |
| `/systemprompt set\|show\|clear` | Per-channel system prompt  | Stored per channel, applied to all future turns        |
| `/compact`                       | Summarize context          | Saves tokens on long conversations                     |
| `/cost`                          | Show spending              | Per-session and cumulative                             |
| `/worktree create\|list\|remove` | Git worktree management    | Runs `git worktree` commands via Bun.spawn             |

---

## Implementation Phases

### Phase 1: Foundation

1. Bun project scaffold (`pnpm init`, tsconfig, biome)
2. `config.ts` — env loading with Zod validation
3. `types.ts` — all core domain types
4. `db/` — SQLite schema + repository with tests
5. `claude/ring-buffer.ts` with tests
6. `discord/chunker.ts` — port from OpenClaw, with tests

### Phase 2: Core Loop

7. `discord/client.ts` — discord.js client, intents, MessageCreate routing
8. `claude/session.ts` — session lifecycle (create/resume/destroy)
9. `claude/runner.ts` — SDK query() wrapper with streaming dispatch
10. `claude/stop.ts` — interrupt + abort controller with tests
11. `discord/renderer.ts` — hybrid streaming (text in-place, thinking/tools as blocks)
12. `discord/reactions.ts` — status emoji lifecycle
13. `discord/buttons.ts` — interrupt + abort button components
14. Wire it all: user types → Claude responds → Discord renders

### Phase 3: Commands

15. `/project` with directory switching + history carryover
16. `/bash` — direct shell execution
17. `/new` — session reset
18. `/status`, `/model`, `/cost`
19. `/systemprompt set|show|clear` (per-channel system prompt storage + application)
20. `/compact`
21. Slash command registration with Discord API

### Phase 4: Rich I/O

22. Attachment input (user uploads → Claude via temp files)
23. Attachment output (Claude files → Discord)
24. `/worktree` commands
25. Debounce rapid messages (batch within 300ms window)

### Phase 5: Polish

26. SIGTERM handler (SDK abort sends SIGTERM)
27. Graceful shutdown
28. Error recovery (reconnect, session cleanup)
29. Channel topic updates (show project + branch)
30. MCP server loading from `.claude/mcp.json`
31. Integration tests

### Phase 6: Distribution & Setup UX

32. `init` interactive setup CLI (questionnaire + `.env` writer + invite link)
33. Startup preflight checks with clear access diagnostics
34. Package CLI for external install (`npx` path) once repo is publish-ready

---

## Verification

1. **Unit tests pass**: `bun test` — chunker, ring buffer, renderer, stop controller, repository
2. **Bot connects**: Start bot, verify it appears online in Discord
3. **Basic conversation**: Type in a channel → Claude responds with streamed text
4. **Tool calls render**: Ask Claude to read a file → see compact one-liner + result
5. **Stop buttons work**: Interrupt mid-response → Claude stops gracefully. Abort → hard kill
6. **Project switch**: `/project ~/www/other-repo` → Claude works in new directory, remembers context
7. **Bash command**: `/bash git status` → output appears in code block, no Claude involved
8. **Attachments**: Upload an image → Claude sees it. Ask Claude to create a file → it appears in Discord
9. **Session resume**: Send message → wait → send another → Claude remembers the conversation
10. **Cost tracking**: `/cost` shows accurate spending for the session
