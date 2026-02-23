import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

async function runNode(
  args: string[],
  options?: { cwd?: string; env?: Record<string, string | undefined> },
): Promise<{ exitCode: number; output: string }> {
  const child = Bun.spawn({
    cmd: [globalThis.process.execPath, path.resolve("bin/claude-on-discord.js"), ...args],
    cwd: options?.cwd,
    env: options?.env ?? process.env,
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);

  return {
    exitCode,
    output: `${stdout}${stderr}`,
  };
}

describe("cli bin", () => {
  test("prints help and exits 0", async () => {
    const result = await runNode(["--help"]);
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("Usage:");
    expect(result.output).toContain("claude-on-discord <command>");
    expect(result.output).toContain("install");
    expect(result.output).toContain("guardian");
    expect(result.output).toContain("worker");
  });

  test("rejects unknown command", async () => {
    const result = await runNode(["wat"]);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("Unknown command: wat");
  });

  test("runs bun from CLAUDE_ON_DISCORD_HOME when outside repo", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "claude-on-discord-cli-"));
    const runtimeRoot = path.join(tempRoot, "runtime");
    const fakeBinDir = path.join(tempRoot, "fake-bin");
    const externalCwd = path.join(tempRoot, "outside");
    await mkdir(runtimeRoot, { recursive: true });
    await mkdir(path.join(runtimeRoot, "src"), { recursive: true });
    await mkdir(fakeBinDir, { recursive: true });
    await mkdir(externalCwd, { recursive: true });

    await writeFile(
      path.join(runtimeRoot, "package.json"),
      JSON.stringify({ name: "claude-on-discord" }),
      "utf8",
    );
    await writeFile(path.join(runtimeRoot, "src", "index.ts"), "console.log('worker')\n", "utf8");

    const bunStubPath = path.join(fakeBinDir, "bun");
    await writeFile(
      bunStubPath,
      "#!/usr/bin/env bash\necho \"FAKE_BUN_CWD=$PWD\"\necho \"FAKE_BUN_ARGS=$*\"\n",
      "utf8",
    );
    await Bun.$`chmod +x ${bunStubPath}`.quiet();

    const result = await runNode(["worker", "--example-arg"], {
      cwd: externalCwd,
      env: {
        ...process.env,
        CLAUDE_ON_DISCORD_HOME: runtimeRoot,
        PATH: `${fakeBinDir}:${process.env.PATH ?? ""}`,
      },
    });
    const runtimeRealPath = await realpath(runtimeRoot);
    const expectedCwds = [`FAKE_BUN_CWD=${runtimeRoot}`, `FAKE_BUN_CWD=${runtimeRealPath}`];

    expect(result.exitCode).toBe(0);
    expect(expectedCwds.some((marker) => result.output.includes(marker))).toBe(true);
    expect(result.output).toContain("FAKE_BUN_ARGS=run src/index.ts --example-arg");
  });
});
