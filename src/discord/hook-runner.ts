import { existsSync, chmodSync } from "node:fs";
import path from "node:path";

export type HookEnv = Record<string, string>;

export type HookResult = {
  ran: boolean;
  exitCode?: number;
  output?: string;
  skippedReason?: string;
};

/**
 * Finds the main worktree path (not a secondary worktree) by running
 * `git worktree list --porcelain` and taking the first entry.
 * This works correctly from within secondary worktrees too.
 */
async function findMainWorktreePath(workingDir: string): Promise<string | null> {
  const proc = Bun.spawn({
    cmd: ["git", "worktree", "list", "--porcelain"],
    cwd: workingDir,
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    proc.exited,
  ]);

  if (exitCode !== 0) return null;

  const firstLine = stdout.split("\n")[0];
  if (!firstLine?.startsWith("worktree ")) return null;

  return firstLine.slice("worktree ".length).trim() || null;
}

/**
 * Runs a lifecycle hook from `.claude-hooks/<hookName>` in the main repo root.
 * Returns immediately with `ran: false` if no script exists — not an error.
 * Non-zero exit is returned to the caller to decide whether to abort.
 *
 * Hook scripts receive COD_* environment variables describing the event context.
 */
export async function runHook(input: {
  hookName: string;
  /** Any directory within the project — used to locate the main worktree. */
  workingDir: string;
  env: HookEnv;
}): Promise<HookResult> {
  const mainWorktree = await findMainWorktreePath(input.workingDir);
  if (!mainWorktree) {
    return { ran: false, skippedReason: "not a git repo" };
  }

  const scriptPath = path.join(mainWorktree, ".claude-hooks", input.hookName);
  if (!existsSync(scriptPath)) {
    return { ran: false, skippedReason: "no hook script" };
  }

  try {
    chmodSync(scriptPath, 0o755);
  } catch {
    // ignore — best-effort chmod
  }

  const proc = Bun.spawn({
    cmd: [scriptPath],
    cwd: mainWorktree,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      ...input.env,
      COD_PROJECT_PATH: mainWorktree,
    },
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  const output = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n");
  return { ran: true, exitCode, output };
}
