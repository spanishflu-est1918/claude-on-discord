# Website Brief (Draft)

## Goal

Position `claude-on-discord` as the serious way to run Claude Code from Discord, with real local execution.

## Core Message

"Claude Code in Discord, running on your machine."

## Key Proof Points

- Real project access (not toy chat)
- Per-channel project/session model
- Thread-native branching with automatic context inheritance
- Streaming responses with stop controls
- Direct shell + worktree commands
- Per-channel system prompts

## Audience

- solo developers
- technical founders
- power users already living in Discord

## Suggested Site Sections

1. Hero: what it is + one-sentence value
2. How it works: local runtime + Discord interface
3. Feature deep dive: commands, session model, stop controls, prompts
4. Security posture: local-first, token handling, trust boundaries
5. Setup guide: install, init, invite, first run
6. Roadmap: plan mode (approval-gated execution), channel webhooks for automation, agent-guided thread forks, branch automation (worktree/diff/PR), attachment reliability, packaging

## Assets Needed Later

- short terminal+Discord demo GIF
- architecture diagram
- screenshots of key flows (`/project`, `/systemprompt`, interrupt/abort)
- concise comparison vs terminal-only workflow
