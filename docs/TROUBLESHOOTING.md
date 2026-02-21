# Troubleshooting

## Slash Commands Not Appearing

Checks:

1. Confirm bot is invited with `bot` and `applications.commands` scopes.
2. Confirm `DISCORD_GUILD_ID` matches the target server.
3. Restart bot to re-register commands.
4. If needed, re-run `bun run init` and re-invite with fresh URL.

## `Claude Code process exited with code 1`

This is usually startup/resume state mismatch.

What is already implemented:

- retry ladder in runner (MCP/session-safe fallbacks)
- session reset on project switch when directory changes

If it still happens:

1. Run `/status` and verify current project path.
2. Run `/project` and choose `Clear Context` once.
3. Retry the message.
4. If persistent, inspect project `.claude` config and local Claude installation.

## Works with Fresh Context But Fails With Keep

This was historically caused by stale `session_id` across project changes.

Current behavior:

- `keep` now preserves history but restarts session when project changed.

Expected confirmation message:

- `Project set to ... (context kept, session restarted).`

## `/project` on Mobile

Use explicit path input:

- `/project path:<dir>`

Path rules:

- relative paths resolve against current channel project dir
- absolute paths and `~/...` are supported

## `(No response text)` After Stop

Current behavior:

- interrupted empty turns now return `Interrupted.`

If you still see `(No response text)`, verify bot is running latest commits and restarted.

## Thread Runs Hanging / Stalling

Enable internal thread tracing (developer-only) before restart:

```bash
THREAD_DEBUG_TRACE=1 \
THREAD_DEBUG_TRACE_FILE=./data/thread-debug.log \
bun start
```

What it records:

- per-thread queue lifecycle (queued, started, released)
- runner lifecycle (query start, SDK message milestones, result/error)
- thread lifecycle events (archive/unarchive/delete)
- runtime aborts (manual abort, stale-run reaper, shutdown)

Use this when a thread appears stuck and share the relevant trace lines around the stall window.

## Attachment Return Issues

Input attachments are stable.

Known tech debt:

- outgoing image attachment reliability is inconsistent in some flows
- tracked in `gleaming-moseying-codd.md`

## `/screenshot` Fails

Checks:

1. Ensure `agent-browser` is installed and available in PATH.
2. Confirm target URL is reachable from the bot host.
3. Retry with explicit URL: `/screenshot url:https://example.com`

## `/pr` Fails

Checks:

1. Ensure `gh` is installed and authenticated (`gh auth status`).
2. Confirm you are on a branch (not detached HEAD).
3. Commit/stash all local changes before `/pr`.
4. Confirm branch has commits ahead of base branch.

`/pr merge` specifics:

1. You must pass `confirm:true`.
2. PR must be OPEN and not draft.
3. Merge strategy must be one of `squash`, `rebase`, `merge`.
