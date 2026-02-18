# Demo Script

**Target length**: ~60 seconds
**Demo repo**: https://github.com/spanishflu-est1918/demo-api
**What it shows**: streaming, thread branching, per-channel system prompts

---

## Pre-recording Setup

Before you hit record:

1. **Clone the demo repo** somewhere local:
   ```bash
   git clone https://github.com/spanishflu-est1918/demo-api ~/www/demo-api
   ```

2. **Discord — set up two channels**:
   - `#api-work` → project set to `~/www/demo-api`
   - `#code-review` → same project, different system prompt (see shot 3)

3. **Set the system prompt on `#code-review`**:
   ```
   /systemprompt set You are a blunt senior engineer. Review code ruthlessly. No praise, just problems.
   ```

4. **Clear `#api-work` history** (`/new`) so the screen is clean

5. **Window layout**: Discord full screen, font size comfortable for video

---

## Shot 1 — The Bug (0–20s)

**Channel**: `#api-work`

Type this message and hit send:

> the tests are failing. fix them.

**What happens on screen**:
- 🧠 thinking reaction appears on your message
- Claude streams a status update: reading files, running `bun test`
- You see the 2 failures in the stream
- Claude reads `src/routes/tasks.ts`, spots the missing null check
- Makes the fix, re-runs tests
- 💻 → ✅ reaction
- Final message: "Fixed. Added a null check in `GET /tasks/:id` — was returning 200 with an undefined body. 7/7 tests passing."

**Cut at**: tests green, ✅ reaction visible

---

## Shot 2 — Thread Branch (20–40s)

Still in `#api-work`. Create a new thread on **any message** in the channel.

Name the thread:

> feat: filter tasks by status

**In the thread**, type:

> add a `?status=` query param to GET /tasks so I can filter by pending, in_progress, or done

**What happens on screen**:
- Thread starts — no `/project`, no context setup needed
- Claude already knows the codebase (inherited from parent)
- Adds the filter to `listTasks()` in `db.ts` and the handler in `tasks.ts`
- Adds a test for it
- All tests pass

**The point to land**: the thread picked up exactly where the main channel left off. No context re-explaining. Parallel lane, zero friction.

**Cut at**: Claude's response in the thread showing the new filter working

---

## Shot 3 — System Prompt (40–55s)

**Switch to `#code-review`** (the channel with the blunt reviewer prompt).

Type:

> review the null check fix from #api-work

**What happens on screen**:
- Same Claude, completely different voice
- Terse, critical, no pleasantries
- Might flag: "should also validate that `id` is a valid format, not just check for undefined"

**Cut at**: first full response visible — the personality contrast is the point

---

## Shot 4 — Close (55–60s)

Back in `#api-work`, type:

> /cost

Show the spend. Should be cents. Caption it yourself or let it speak.

---

## Notes

- Don't rush the streaming — that's the visual. Let it run.
- The thread shot is the money shot. Make sure the thread name is visible before typing.
- If anything goes sideways, `/new` resets the channel and you re-run from shot 1.
- Record at 1x speed. No need to speed anything up — the streaming is fast enough.
