import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Client } from "discord.js";
import { startApp } from "../src/app";
import type { AppConfig } from "../src/config";
import { openDatabase } from "../src/db/schema";

async function runGit(args: string[], cwd: string): Promise<void> {
  const process = Bun.spawn({
    cmd: ["git", ...args],
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed (${exitCode}): ${stdout}\n${stderr}`);
  }
}

async function createDirtyGitRepo(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "app-diff-"));
  await runGit(["init"], root);
  await writeFile(path.join(root, "README.md"), "base\n", "utf-8");
  await runGit(["add", "README.md"], root);
  await runGit(
    ["-c", "user.name=Test User", "-c", "user.email=test@example.com", "commit", "-m", "init"],
    root,
  );
  await writeFile(path.join(root, "README.md"), "base\nupdated\n", "utf-8");
  return root;
}

describe("startApp slash diff integration", () => {
  test("delivers /diff via a single editReply without followUp", async () => {
    const repoDir = await createDirtyGitRepo();
    const dbPath = path.join(repoDir, "state.sqlite");
    let capturedSlashHandler: ((interaction: unknown) => Promise<void>) | undefined;
    let openedDb: { close: () => void } | undefined;

    try {
      const config: AppConfig = {
        discordToken: "unused-token",
        discordClientId: "unused-client",
        discordGuildId: "unused-guild",
        defaultWorkingDir: repoDir,
        databasePath: dbPath,
        defaultModel: "sonnet",
        autoThreadWorktree: false,
        worktreeBootstrap: true,
        claudePermissionMode: "bypassPermissions",
      };

      await startApp(config, {
        openDatabase: (databasePath) => {
          const db = openDatabase(databasePath);
          openedDb = db;
          return db;
        },
        registerSlashCommands: async () => {},
        startDiscordClient: async (options) => {
          capturedSlashHandler = options.onSlashCommand as (interaction: unknown) => Promise<void>;
          return {
            destroy: () => {},
            channels: {
              fetch: async () => null,
            },
          } as unknown as Client;
        },
        installSignalHandlers: false,
      });

      if (typeof capturedSlashHandler !== "function") {
        throw new Error("slash handler was not captured");
      }

      const editReplyCalls: unknown[] = [];
      const followUpCalls: unknown[] = [];
      let deferReplyCalls = 0;
      const interaction = {
        commandName: "diff",
        channelId: "channel-1",
        guildId: "guild-1",
        channel: {
          isThread: () => false,
        },
        deferred: false,
        replied: false,
        options: {
          getString: () => null,
          getSubcommand: () => "patch",
        },
        async deferReply() {
          this.deferred = true;
          deferReplyCalls += 1;
        },
        async editReply(payload: unknown) {
          this.replied = true;
          editReplyCalls.push(payload);
        },
        async followUp(payload: unknown) {
          followUpCalls.push(payload);
        },
        async reply(_payload: unknown) {
          throw new Error("reply should not be called for /diff");
        },
      };

      const slashHandler = capturedSlashHandler;
      await slashHandler(interaction);

      expect(deferReplyCalls).toBe(1);
      expect(editReplyCalls).toHaveLength(1);
      expect(followUpCalls).toHaveLength(0);

      const payload = editReplyCalls[0] as {
        content?: string;
        files?: Array<{ attachment?: Buffer | Uint8Array; name?: string }>;
      };
      expect(payload.content).not.toBe("(no diff output)");
      expect(payload.files?.length).toBe(1);

      const attachment = payload.files?.[0];
      expect(attachment?.name).toMatch(/^diff-[a-z0-9]+\.diff$/);
      const data = attachment?.attachment;
      if (!data) {
        throw new Error("diff attachment is missing");
      }
      const body = Buffer.isBuffer(data) ? data.toString("utf-8") : new TextDecoder().decode(data);
      expect(body).toContain("diff --git");
      expect(body).toContain("+updated");
    } finally {
      openedDb?.close();
      await rm(repoDir, { recursive: true, force: true });
    }
  });
});
