import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  detectInstallCommandForWorktree,
  runWorktreeBootstrap,
} from "../src/discord/worktree-bootstrap";

describe("worktree bootstrap", () => {
  test("detects yarn install when yarn.lock exists", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "worktree-bootstrap-yarn-"));
    try {
      await writeFile(path.join(dir, "package.json"), "{}", "utf-8");
      await writeFile(path.join(dir, "yarn.lock"), "", "utf-8");
      expect(detectInstallCommandForWorktree(dir)).toEqual(["yarn", "install"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("skips when package manager setup is not detected", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "worktree-bootstrap-skip-"));
    try {
      const result = await runWorktreeBootstrap({
        enabled: true,
        workingDir: dir,
        runCommand: async () => ({ exitCode: 0, output: "" }),
      });
      expect(result.attempted).toBeFalse();
      expect(result.skippedReason).toContain("no package manager");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("uses custom command when configured", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "worktree-bootstrap-custom-"));
    try {
      const calls: Array<{ cmd: string[]; cwd: string }> = [];
      const result = await runWorktreeBootstrap({
        enabled: true,
        customCommand: "echo setup",
        workingDir: dir,
        runCommand: async (cmd, cwd) => {
          calls.push({ cmd, cwd });
          return { exitCode: 0, output: "ok" };
        },
      });
      expect(result.attempted).toBeTrue();
      expect(calls).toEqual([{ cmd: ["sh", "-lc", "echo setup"], cwd: dir }]);
      expect(result.commandText).toContain("echo setup");
      expect(result.exitCode).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
