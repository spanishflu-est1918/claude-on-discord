# claude-on-discord — Marketing Strategy

_February 2026. Internal strategy doc. Not polished prose — direct thinking._

---

## 0. NORTH STAR

**What is this, really?**

claude-on-discord is not a chatbot. It's not a Discord plugin for Claude.ai. It is
**Claude Code** — the full agentic, filesystem-executing, shell-running agent — running
on your machine and reachable from any Discord channel, on any device, at any time.

The single most important thing to get across:
> Your machine is always on. Discord is always open. Now they're connected.

That's the product. Everything else follows from that.

---

## 1. THE REAL STORY (that the current brief undersells)

### What Claude Code actually is (most people don't know)
Claude Code isn't Claude.ai. It's a separate product: an agentic runtime that reads and
writes files, runs shell commands, browses code, installs packages, runs tests, manages
git. It's a tireless dev pair that operates on your actual codebase.

Most people who'd want this don't know it exists.

### The problem it solves
You're not always at your terminal. You're on your phone. In a coffee shop. In a meeting.
Your machine is sitting at home, fully capable, doing nothing.

With claude-on-discord, you type in Discord and Claude Code executes on your machine.
Distance collapses. The machine stops waiting for you.

### The thread branching angle (nobody talks about this)
Discord threads map 1:1 to git branches. This wasn't planned — it emerged from the
architecture. When you create a Discord thread:
- It automatically inherits parent channel context (working directory, model, conversation history)
- You can auto-provision a git worktree for that thread
- `/diff` shows exactly what changed in this lane
- `/pr` ships it when ready

The mental model is: **channels are projects, threads are branches.**
This is the git branching workflow, Discord-native. No friction.

---

## 2. CORE POSITIONING

### Primary message
> Claude Code in Discord, running on your machine.

### Secondary message
> Real filesystem access. Real local execution. Zero cloud dependency.

### What it's NOT (important to say explicitly)
- Not Claude.ai with a Discord wrapper
- Not a chatbot
- Not a SaaS — no monthly fees, no data upload, no vendor lock-in beyond your API key
- Not a toy

### Positioning matrix

| | Claude.ai | GitHub Copilot | Claude Code (terminal) | claude-on-discord |
|---|---|---|---|---|
| Real file access | ❌ | ⚠️ IDE only | ✅ | ✅ |
| Mobile access | ⚠️ Web only | ❌ | ❌ | ✅ Discord |
| Local execution | ❌ | ❌ | ✅ | ✅ |
| Session continuity | ⚠️ | ❌ | ⚠️ | ✅ Per channel |
| Parallel lanes | ❌ | ❌ | ❌ | ✅ Thread branches |
| PR management | ❌ | ❌ | ❌ | ✅ /pr |
| Cost | $20/mo | $10/mo | Usage | Usage |

---

## 3. AUDIENCE PERSONAS

### Primary: The Solo Developer / Indie Hacker
- Works across multiple projects
- Always has Discord open (communities, friends, collab)
- Wants Claude Code but hates being terminal-tethered
- **Hook**: "Keep coding when you're away from your desk"
- **Where they are**: IndieHackers, X, Discord itself

### Secondary: The Technical Founder
- Needs to move fast across codebase and decisions
- Delegates extensively to AI
- Values async: fire off tasks, get results, not babysit a terminal
- **Hook**: "Your AI dev pair, always available"
- **Where they are**: X, ProductHunt, Hacker News

### Tertiary: The Discord-Native Developer
- Lives in Discord (open source communities, gaming dev, crypto, web3)
- Already organizes work through Discord channels
- **Hook**: "The editor that's already in Discord"
- **Where they are**: Discord dev communities, X

### Emerging: The "Build in Public" Creator
- Documents their builds on X/Discord
- Wants Claude Code integrated into where they narrate
- **Hook**: "Let your audience watch you build with AI"

---

## 4. WEBSITE — STRUCTURE & COPY

### Hero Section

**Headline:**
```
Claude Code. In Discord.
Running on your machine.
```

**Subhead:**
```
Real filesystem access. Real local execution.
Available from any device, any Discord channel, any time.
```

**CTA:** `Get started on GitHub →`

**Visual:** Side-by-side — Discord channel on left, terminal output on right.
Or a short GIF showing: type message in Discord → Claude executes → result posts back.

---

### Problem Section (Why this exists)

**Headline:** `Your machine never sleeps. Why does your terminal?`

**Body:**
```
Claude Code is the most capable AI coding agent available.
But it lives in your terminal — which means you have to be there too.

You're on your phone. You're between meetings. You want to ask Claude
to fix that bug, refactor that module, or open that PR. But you can't.
Not until you're back at your desk.

claude-on-discord changes that.
```

---

### How It Works Section

**Headline:** `Three concepts. That's it.`

**Concept 1: Channels are projects**
```
Each Discord channel maps to a working directory on your machine.
Type /project to set it. Claude Code runs there.
Everything stays local — your files, your git, your creds.
```

**Concept 2: Threads are branches**
```
Create a Discord thread. It automatically inherits your project context.
Spin up a git worktree for that thread with one command.
Work on that feature independently. Diff it. Ship it. Merge it.
Parallel lanes without leaving Discord.
```

**Concept 3: Always available**
```
Your bot runs on your machine.
Send a message from your phone at 11pm.
Wake up to results.
```

---

### Feature Deep Dive

**Headline:** `Everything Claude Code can do. From Discord.`

#### Real Execution
- Reads and writes files directly on your machine
- Runs shell commands (`/bash`)
- Installs packages, runs tests, manages git
- No code leaves your machine

#### Thread Branching
- New threads auto-inherit parent context (project, model, history)
- Auto-provision git worktrees per thread
- `/branches` — see all active lanes
- `/diff` — see exactly what changed in this lane
- Branch-aware Claude knows which thread it's in and why

#### PR Management
- `/pr open|draft` — create PRs via `gh` CLI
- `/pr status|view|checks` — inspect PR state without leaving Discord
- `/pr merge` — merge with safety checks baked in
- Base branch resolved from thread root automatically

#### Session Intelligence
- Per-channel conversation memory
- Model switching mid-session (`/model`)
- Per-channel system prompts (`/systemprompt`)
- `/compact` to summarize and continue without losing context
- Cost tracking per channel (`/cost`)

#### Controls
- Live streaming as Claude thinks and writes
- `⏸️ Interrupt` — soft stop, Claude wraps up current thought
- `🛑 Abort` — hard kill, immediate stop
- Session recovery on restart

#### Dev Ops
- `/worktree create|list|remove|thread`
- `/screenshot` — capture web pages
- Attachment input (images, files → Claude context)
- Generated file output → back to Discord

---

### Security Section

**Headline:** `Local-first is the feature, not the limitation.`

**Body:**
```
Your code never leaves your machine. claude-on-discord runs entirely
on your hardware, using your Anthropic API key, talking to your files.

No SaaS backend. No cloud execution. No data pipeline.
Just your machine, your bot, your Discord.

The security model is simple: bot access = shell access.
Treat it like a terminal you can reach from anywhere.
Keep it in trusted servers. Trust it like a dev tool, not a public service.
```

---

### Setup Section

**Headline:** `Set up in five minutes.`

```bash
# 1. Clone and install
git clone https://github.com/your-handle/claude-on-discord
cd claude-on-discord && bun install

# 2. Configure
bun run setup  # interactive wizard

# 3. Invite the bot
# The wizard prints an invite URL — open it in your browser

# 4. Start
bun run start
```

```
After that: /project to set your working directory,
then just talk to it like Claude Code.
```

---

### Roadmap Section

**Headline:** `Where it's going.`

- `→` Worktree per thread, fully automatic
- `→` Branch diff summaries in Discord
- `→` PR review buttons (conductor-style structured prompts)
- `→` `npx` distribution (no clone needed)
- `→` Multi-guild support

---

## 5. TWITTER/X THREADS

### Thread 1: The Origin Story (personal, relateable)

```
Thread: Why I built claude-on-discord 🧵

1/
I was on my phone.
Wanted to ask Claude Code to fix a bug.
Had to wait until I got back to my laptop.

That was dumb.
My machine was running. Claude was available.
I just couldn't reach it.

2/
Claude Code is the most powerful AI coding tool I've ever used.
It reads your files, runs your tests, manages git, opens PRs.
It's not a chatbot — it's an agent that actually works.

But it's trapped in a terminal.
Which means it's trapped at your desk.

3/
Discord, though, is always open.
On my desktop. On my phone. On my second screen.
I already use it to organize my work, my communities, my projects.

So I built the bridge.

4/
claude-on-discord runs Claude Code on your machine
and puts it in every Discord channel you want.

Each channel maps to a project directory.
Each thread becomes a branch lane.
You type. It executes. Results come back.

5/
The features landed in a natural order:
- Per-channel working directories
- Session continuity + model switching
- /bash for direct shell commands
- Thread branching with context inheritance
- Git worktree automation
- PR management via /pr

6/
The thread branching thing surprised me.
I didn't plan it — it emerged.

When you create a Discord thread:
- It auto-inherits the parent channel context
- Claude knows it's in a branch
- You can spin up a git worktree for it
- /diff shows exactly what changed in that lane
- /pr ships it

Discord threads ARE git branches. That's wild.

7/
It's local-first. No SaaS. No cloud execution.
Your code never leaves your machine.
Your API key. Your machine. Your rules.

Security model: treat bot access like terminal access.
Keep it in trusted servers.

8/
Stack: Bun + TypeScript + discord.js + @anthropic-ai/claude-agent-sdk
SQLite for session state and cost tracking.
~8500 lines, 20 test files.

9/
Available on GitHub.
bun install → bun run setup → bun run start.
Five minutes to running.

I use this every day. You might too.

[repo link]
```

---

### Thread 2: Thread Branching Deep Dive (technical insight)

```
Thread: Discord threads are git branches. 🧵

This one weird insight is the heart of claude-on-discord.

1/
Most people think Discord threads are just... nested conversations.
Cosmetic. Organizational.

In claude-on-discord, they're execution lanes.
Parallel Claude Code sessions running on your machine, simultaneously.

2/
Here's the model:

Each Discord CHANNEL = one project directory.
Think of it as `main` — your primary working context.

When you create a Discord THREAD in that channel,
the bot sees it as a branch.

3/
Thread creation triggers:
- Auto-clone of parent channel context (working dir, model, conversation history, system prompt)
- Optional auto-provisioning of a git worktree
- Lightweight metadata injection so Claude knows what branch it's on

No config. No commands. Just create the thread.

4/
From inside the thread, you're working in isolation.
Changes in this lane don't touch main.
Claude knows the topology — ask it "what's the diff from main?" and it knows.

/diff shows the live patch.
/pr opens the PR when you're ready.

5/
Why this matters:
- You can prototype a risky refactor in a thread without touching main
- Run multiple features in parallel without context bleed
- Context inheritance means no re-explaining the codebase per branch
- /branches shows you all active lanes at once

6/
This is the git branching workflow.
Mapped to Discord-native primitives.
No new mental model needed — you already know how to make a thread.

7/
It works on mobile too.
Create a thread from your phone.
The bot provisions the worktree on your machine.
You code from bed.

That's the vision.

[repo link]
```

---

### Thread 3: The "Claude Code from your phone" Demo Thread

```
Thread: I wrote code from my phone today. Here's exactly how. 🧵

Not a prototype. Not a demo. This is how I actually work now.

1/
8am. Coffee in hand. Not at my desk.
Remembered I need to add rate limiting to an endpoint.

Opened Discord on my phone.
Navigated to the #my-project channel.
Typed: "Add rate limiting to the /api/submit endpoint, 10 req/min per IP"

That's it.

2/
claude-on-discord received the message.
On my machine (asleep on my desk), Claude Code woke up.

It:
- Read the current endpoint file
- Checked the existing middleware stack
- Found the right insertion point
- Wrote the implementation
- Ran the type checker
- Committed the change

Took 90 seconds.

3/
I didn't write a line. I didn't touch a keyboard.
I was standing in my kitchen.

The result came back to Discord as a streaming response —
I watched the thinking, saw the code, confirmed it looked right.

4/
This is possible because:
- claude-on-discord runs on my machine (not in the cloud)
- My machine has real access to my codebase
- Discord is the only surface I need to reach it

No SSH. No VPN. No "wait til I'm back at the desk."

5/
The workflow for bigger things:

/project — set which repo
Create a thread — start a feature lane
Work in that thread — context is inherited
/diff — see the patch when you're ready
/pr — ship it

All from Discord. All executing locally.

6/
Commands I actually use daily:

/project → switch context
/bash → run anything directly
/diff → see changes
/pr status → check PR state
/cost → see what this session cost

The interrupts are clutch:
⏸️ Interrupt — soft stop
🛑 Abort — kill it now

7/
Three things make this feel different from every other AI tool:
1. Local execution (my files, my machine, real output)
2. Session memory (Claude knows what we talked about before)
3. Mobile access (it goes where I go)

That combination doesn't exist anywhere else.

[repo link]
```

---

### Thread 4: The Local-First AI Philosophy

```
Thread: Local-first AI is different. Here's why it matters. 🧵

1/
Most AI coding tools run in the cloud.
Your code goes up. Something comes back down.
The model runs on their hardware, in their security perimeter.

claude-on-discord flips this.
The model's still Anthropic's. But the execution is yours.

2/
"Local-first" means:
- Claude Code runs on your machine
- Your files never leave your filesystem
- Shell commands execute in your environment
- Git operations run against your real repo
- Results land in your actual codebase

Not a simulation. The real thing.

3/
Why this matters for coding:

Context. A cloud agent is sandboxed — it sees what you paste.
A local agent sees EVERYTHING:
- Your entire repo structure
- Your git history
- Your running processes
- Your installed toolchain
- Your actual environment variables

The quality of work is categorically different.

4/
Trust model is simpler too.
You're not trusting a third-party cloud.
You're trusting your own machine, your own network, your own API key.

The attack surface is smaller.
The data model is clearer.
"Where did my code go?" — it didn't. It stayed.

5/
The tradeoff is honest:
- You have to run it yourself (one bun run start)
- It needs to be on a machine that's on when you send messages
- It's not instant setup like a SaaS

But for serious dev work, the local execution model is worth it.
Especially when you can reach it from anywhere via Discord.

6/
This is the direction AI dev tooling is going.
Not bigger models in the cloud.
Smarter agents running close to your code.

claude-on-discord is one implementation of that bet.
A personal one. For developers who want real execution, not chat.

[repo link]
```

---

### Thread 5: The Setup Guide (practical tutorial thread)

```
Thread: Set up Claude Code in Discord in 5 minutes. 🧵

Step by step.

1/
What you need before starting:
- Anthropic API key (claude.ai/api)
- Discord account + a server you control
- Bun installed (bun.sh)
- A machine that stays on (or at least when you want to use it)

2/
Step 1: Get the code

git clone https://github.com/[handle]/claude-on-discord
cd claude-on-discord
bun install

3/
Step 2: Run setup

bun run setup

Interactive wizard. It asks:
- Your Discord bot token (you'll create this in a moment)
- Your Application ID
- Your Guild (server) ID
- Default working directory (e.g. ~/www)

4/
How to get your Discord bot token:
→ discord.com/developers/applications
→ New Application
→ Bot tab → Reset Token → copy it
→ Message Content Intent → ON
→ Paste into setup wizard

5/
Step 3: Invite the bot

The wizard prints an invite URL.
Open it. Choose your server. Authorize.

Required permissions:
- Send Messages
- Read Message History
- Manage Messages
- Use Slash Commands
- Attach Files

6/
Step 4: Start the bot

bun run start

You'll see preflight checks:
✅ Working directory exists
✅ Database initialized
✅ Discord auth valid
✅ Guild reachable

Then it's running.

7/
Step 5: First message

In any channel where the bot is present:

/project path:~/www/my-project
→ "Project set to ~/www/my-project"

Then just talk:
"Can you look at the current directory structure and tell me what this project does?"

8/
Key commands to know first:

/project — set working directory
/status — see current context
/bash pwd — verify what directory you're in
/cost — see session spend

/new — reset session if anything feels stale

9/
Advanced from day one:

/systemprompt set "You are working in a monorepo. Always check workspace dependencies before suggesting changes."

This persists per channel. Claude knows its context every session.

10/
That's it. You're running Claude Code from Discord.
Now try it from your phone.

Full docs at [repo link]
```

---

## 6. PRODUCT HUNT LAUNCH COPY (for when ready)

**Tagline:**
> Claude Code in Discord. Running on your machine.

**Description (short):**
> claude-on-discord is a local-first Discord bot that runs the full Claude Code agent on your machine. Real filesystem access, real shell execution, per-channel projects, thread-native branching. Code from anywhere.

**Description (full):**
> Most AI coding tools are either limited (chat-only, no file access) or tethered (terminal-only, desktop-only). claude-on-discord solves both problems.
>
> It runs Claude Code — Anthropic's full agentic coding runtime — on your machine, accessible from any Discord channel, including from your phone.
>
> Key concepts:
> - Channels are projects (each channel maps to a local working directory)
> - Threads are branches (auto-inherit context, auto-provision git worktrees)
> - Everything executes locally (no cloud, no data upload)
>
> Features: per-channel session state, `/bash` for direct shell, `/pr` for GitHub PR management, `/diff` for live patches, `/worktree` for git branch automation, `/screenshot`, streaming with interrupt/abort controls, cost tracking.
>
> Built with Bun + TypeScript + discord.js + Claude Agent SDK. Local setup in 5 minutes.

---

## 7. POSITIONING STATEMENT (internal reference)

For developers who live in Discord and want Claude Code's full power without being
tethered to a terminal, claude-on-discord is a local-first Discord bot that gives
you real filesystem execution from any channel, on any device — unlike cloud AI tools
that see only what you paste, claude-on-discord runs on your machine with full access
to your codebase, git history, and shell environment.

---

## 8. WHAT'S MISSING (assets + gaps)

Before any real launch:

### Must-have assets
- [ ] **Demo GIF** — 30 seconds: type message on phone → Claude executes → result in Discord
- [ ] **Architecture diagram** — visual of local machine ↔ Discord bridge
- [ ] **Screenshots** — /project switch, thread branching, /pr flow, streaming with stop buttons
- [ ] **GitHub repo setup** — proper README, License, Contributing guide, Issue templates

### Messaging gaps to resolve
- Need a clear answer for "why not just use Claude.ai?" (most people will ask this)
  - Answer: Claude.ai has no filesystem access, no shell, no session continuity, no branch awareness
- Need a clear answer for "is this safe?"
  - Answer: runs entirely on your machine, your API key, no cloud backend
- Need a clear answer for "what's the cost?"
  - Answer: Anthropic API usage (same as Claude Code in terminal) + Discord bot (free)

### Distribution channels (in priority order)
1. **GitHub** — public repo, README-first distribution
2. **X/Twitter** — threads (use the drafts above)
3. **Hacker News** — Show HN post ("Show HN: claude-on-discord — Claude Code accessible from any Discord channel")
4. **Product Hunt** — after GitHub and some organic traction
5. **Discord communities** — Anthropic dev Discord, indie hacker servers, AI builders

### npx distribution (unlock more reach)
Once the `bin/claude-on-discord.js` scaffold is complete:
```bash
npx claude-on-discord setup
npx claude-on-discord start
```
This removes the clone-and-install friction and makes it a proper public tool.

---

## 9. ONE-SENTENCE VERSIONS (for social bios, link-in-bio, etc.)

- "Claude Code in Discord, running on your machine."
- "Your AI dev pair, reachable from anywhere."
- "Discord-native Claude Code with thread branching and local execution."
- "The bridge between your machine and your Discord."

---

_Last updated: 2026-02-18_
