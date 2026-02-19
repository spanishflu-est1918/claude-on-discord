import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { cleanupFiles } from "./file-artifacts";

type RunCommand = (
  command: string[],
  cwd: string,
) => Promise<{ exitCode: number; output: string }>;

function buildAgentBrowserSession(channelId: string): string {
  const token = channelId.replace(/[^a-zA-Z0-9_-]/g, "").slice(-24);
  return `claude-discord-${token || "default"}`;
}

export async function captureScreenshotWithAgentBrowser(input: {
  channelId: string;
  workingDir: string;
  url: string;
  fullPage: boolean;
  runCommand: RunCommand;
}): Promise<{ screenshotPath?: string; output: string; exitCode: number }> {
  const session = buildAgentBrowserSession(input.channelId);
  const screenshotPath = path.join(
    tmpdir(),
    `claude-on-discord-shot-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}.png`,
  );

  const openResult = await input.runCommand(
    ["agent-browser", "--session", session, "open", input.url],
    input.workingDir,
  );
  if (openResult.exitCode !== 0) {
    return { exitCode: openResult.exitCode, output: openResult.output };
  }

  const screenshotCommand = ["agent-browser", "--session", session, "screenshot"];
  if (input.fullPage) {
    screenshotCommand.push("--full");
  }
  screenshotCommand.push(screenshotPath);
  const screenshotResult = await input.runCommand(screenshotCommand, input.workingDir);
  const closeResult = await input.runCommand(
    ["agent-browser", "--session", session, "close"],
    input.workingDir,
  );

  const combinedOutput = [screenshotResult.output, closeResult.output].filter(Boolean).join("\n");
  if (screenshotResult.exitCode !== 0 || !existsSync(screenshotPath)) {
    if (existsSync(screenshotPath)) {
      await cleanupFiles([screenshotPath]);
    }
    return { exitCode: screenshotResult.exitCode, output: combinedOutput };
  }

  return { screenshotPath, exitCode: 0, output: combinedOutput };
}
