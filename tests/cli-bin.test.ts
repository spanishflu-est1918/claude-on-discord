import { describe, expect, test } from "bun:test";
import path from "node:path";

async function runNode(args: string[]): Promise<{ exitCode: number; output: string }> {
  const child = Bun.spawn({
    cmd: [globalThis.process.execPath, path.resolve("bin/claude-on-discord.js"), ...args],
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
    expect(result.output).toContain("guardian");
    expect(result.output).toContain("worker");
  });

  test("rejects unknown command", async () => {
    const result = await runNode(["wat"]);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("Unknown command: wat");
  });
});
