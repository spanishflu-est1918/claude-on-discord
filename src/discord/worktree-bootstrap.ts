import { existsSync } from "node:fs";
import path from "node:path";

export type WorktreeBootstrapResult = {
  attempted: boolean;
  commandText?: string;
  exitCode?: number;
  output?: string;
  skippedReason?: string;
};

type RunCommand = (
  cmd: string[],
  cwd: string,
) => Promise<{
  exitCode: number;
  output: string;
}>;

export function detectInstallCommandForWorktree(workingDir: string): string[] | null {
  const hasPackageJson = existsSync(path.join(workingDir, "package.json"));
  if (!hasPackageJson) {
    return null;
  }
  if (existsSync(path.join(workingDir, "yarn.lock"))) {
    return ["yarn", "install"];
  }
  if (existsSync(path.join(workingDir, "pnpm-lock.yaml"))) {
    return ["pnpm", "install", "--frozen-lockfile"];
  }
  if (
    existsSync(path.join(workingDir, "bun.lock")) ||
    existsSync(path.join(workingDir, "bun.lockb"))
  ) {
    return ["bun", "install"];
  }
  if (existsSync(path.join(workingDir, "package-lock.json"))) {
    return ["npm", "install"];
  }
  return ["npm", "install"];
}

function commandToText(cmd: string[]): string {
  return cmd.map((part) => (/\s/.test(part) ? JSON.stringify(part) : part)).join(" ");
}

export async function runWorktreeBootstrap(input: {
  enabled: boolean;
  customCommand?: string;
  workingDir: string;
  runCommand: RunCommand;
}): Promise<WorktreeBootstrapResult> {
  if (!input.enabled) {
    return {
      attempted: false,
      skippedReason: "disabled by WORKTREE_BOOTSTRAP=false",
    };
  }

  const custom = input.customCommand?.trim();
  const cmd = custom ? ["sh", "-lc", custom] : detectInstallCommandForWorktree(input.workingDir);

  if (!cmd) {
    return {
      attempted: false,
      skippedReason: "no package manager setup detected",
    };
  }

  const result = await input.runCommand(cmd, input.workingDir);
  return {
    attempted: true,
    commandText: commandToText(cmd),
    exitCode: result.exitCode,
    output: result.output,
  };
}
