# claude-on-discord — 60-Second Demo Script

**Tool**: [Screen Studio](https://screenstudio.lemonsqueezy.com) — auto cursor zoom on click, clean macOS capture, direct MP4 export. Worth it. Fallback: QuickTime + iMovie for manual zoom.

**Resolution**: 1440p windowed Discord, 100% zoom, terminal hidden.

**Edit**: Hard cuts only. No transitions. Add captions — levelsio's audience watches muted.

---

## Pre-Recording Checklist

Do all of this before you hit record.

### Discord State

- [ ] Server name is clean (e.g. `dev-workspace`, not `My Server 1234`)
- [ ] `#main-project` channel exists — cwd set to a real project with actual files (`src/`, etc.)
- [ ] `#rails-expert` channel exists — system prompt already set: `You are a senior Rails developer. Be terse. No explanations unless asked.`
- [ ] Two threads pre-created under `#main-project`: `feat/auth-refactor` and `feat/dark-mode`
  - Each thread has one completed exchange so Claude has context
- [ ] Bot is idle, no active queries
- [ ] Member list sidebar hidden, Discord in windowed mode
- [ ] Do Not Disturb on (macOS: System Settings → Focus → Do Not Disturb)

### Local State

- [ ] `bun start` running in a terminal not visible on screen
- [ ] Project in `#main-project` is a real repo with real files
- [ ] `AUTO_THREAD_WORKTREE=false` (no worktree setup delay during demo)
- [ ] Bot has a non-default avatar

### Clipboard / Snippets (load in Raycast or similar, in order)

1. `add a loading spinner to the auth button`
2. `what's the cleanest way to add optimistic UI here?`
3. `best way to handle N+1 in this query?`
4. `git status`
5. `refactor the entire auth module to use JWT` (for interrupt shot)

---

## Shot-by-Shot Script

### [0:00 – 0:05] Hook

**Screen**: Discord open, `#main-project`, clean and idle

**Caption**: *"Claude Code is great. SSH is annoying. What if your terminal lived in Discord?"*

---

### [0:05 – 0:12] It works — first message

**Action**: Send snippet 1 → `add a loading spinner to the auth button`

**Screen**: Bot immediately shows thinking, then streams — tool events (`Read src/…`, `Edit src/…`), text builds live in a single message

**Caption**: *"Real filesystem. Real tools. Claude Code running on your machine — controlled from Discord."*

**Cut** the moment meaningful output is visible. Don't wait for completion.

---

### [0:12 – 0:22] Thread branching ← this is the demo

**Action**: Open thread list, click `feat/auth-refactor`

**Caption**: *"Discord has threads. So this uses them as parallel coding lanes."*

**Action**: Send snippet 2 → `what's the cleanest way to add optimistic UI here?`

**Screen**: Claude responds with context already intact — no `/project`, no re-explaining

**Caption**: *"Every thread inherits parent context automatically. Branch without losing history."*

**Action**: Click back to `#main-project`, click `feat/dark-mode` — different work, same project

**Caption**: *"Parallel tracks. No collision."*

---

### [0:22 – 0:30] Per-channel system prompts

**Action**: Switch to `#rails-expert`, run `/systemprompt show`

**Screen**: Bot returns the saved prompt

**Caption**: *"Every channel has its own system prompt. This one's your Rails expert. Another channel, different persona."*

**Action**: Send snippet 3 → `best way to handle N+1 in this query?` — show the terse response

**Cut** before it finishes if it runs long.

---

### [0:30 – 0:38] Direct shell

**Action**: Back to `#main-project`, run `/bash command: git status`

**Screen**: Raw git output in a code block, instant

**Caption**: *"Direct shell access without invoking Claude. Runs in the project directory."*

---

### [0:38 – 0:48] Interrupt / Abort

**Action**: Send snippet 5 → `refactor the entire auth module to use JWT`

**Screen**: While streaming and tool events are firing — two inline buttons appear: `Interrupt` and `Abort`

**Action**: Click `Interrupt`

**Screen**: Streaming stops cleanly

**Caption**: *"Soft stop or hard kill. Both work mid-stream."*

---

### [0:48 – 0:55] Setup

**Screen**: Cut to terminal (only terminal shot)

**Show this sequence**:
```
git clone github.com/spanishflu-est1918/claude-on-discord
cd claude-on-discord
bun install && bun run setup
bun start
```

**Caption**: *"Five commands. Your machine. Your files. Your API key."*

---

### [0:55 – 1:00] CTA

**Screen**: Back to Discord, threads visible

**Static overlay**: `github.com/spanishflu-est1918/claude-on-discord`

**Caption**: *"Local-first Claude Code. In Discord. Link below."*

---

## Timing

| Segment | Time | Duration |
|---------|------|----------|
| Hook | 0:00 | 5s |
| First message | 0:05 | 7s |
| Thread branching | 0:12 | 10s |
| System prompts | 0:22 | 8s |
| Direct shell | 0:30 | 8s |
| Interrupt / Abort | 0:38 | 10s |
| Setup | 0:48 | 7s |
| CTA | 0:55 | 5s |

---

## Recovery Notes

**Bot doesn't respond** — check if `bun start` crashed on your hidden terminal. Keep it on a second monitor.

**Response streams too long** — speed ramp to 1.5x in post. Text streaming at 1.5x is imperceptible. 2x starts to look choppy.

**Thread doesn't inherit context** — parent channel needs at least one completed exchange. Create threads from within the channel, not from Discord server settings.

**`/systemprompt show` returns empty** — re-run `/systemprompt set …` in `#rails-expert` and verify with `show` before recording.

**Interrupt buttons don't appear** — the prompt needs to be heavy enough that Claude doesn't finish before you can click. Use snippet 5 as-is.

---

## Edit Notes

- Speed ramp streaming sections to 1.5x — this is where your budget goes
- Thread branching section (0:12–0:22) is the centerpiece — do not cut it short
- Upload natively to X (not a YouTube link). Under 60s native video gets dramatically more reach
- Captions are mandatory — write them before you edit, use the lines above
