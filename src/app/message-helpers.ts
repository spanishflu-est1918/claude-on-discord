import { tmpdir } from "node:os";
import path from "node:path";
import type { Message } from "discord.js";

function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_");
}

export function getMessagePrompt(message: Message): string {
  if (message.content.trim().length > 0) {
    return message.content;
  }
  return "User sent attachments. Describe what they sent and ask how to help.";
}

export function buildStoredUserTurnContent(message: Message): string {
  const base = getMessagePrompt(message);
  if (message.attachments.size === 0) {
    return base;
  }
  const names = [...message.attachments.values()].map((attachment, index) =>
    sanitizeFilename(attachment.name ?? `attachment-${index + 1}.bin`),
  );
  const listed = names.slice(0, 8).join(", ");
  const overflow = names.length > 8 ? ` (+${names.length - 8} more)` : "";
  return `${base}\n\nAttachments: ${listed}${overflow}`;
}

export async function stageAttachments(message: Message): Promise<{
  stagedPaths: string[];
  promptSuffix: string;
}> {
  if (message.attachments.size === 0) {
    return { stagedPaths: [], promptSuffix: "" };
  }

  const stagedPaths: string[] = [];
  const promptLines: string[] = ["", "User included attachments saved locally:"];
  let index = 0;

  for (const attachment of message.attachments.values()) {
    const filename = sanitizeFilename(attachment.name ?? `attachment-${index + 1}.bin`);
    const targetPath = path.join(tmpdir(), `claude-on-discord-${Date.now()}-${index}-${filename}`);

    try {
      const response = await fetch(attachment.url);
      if (!response.ok) {
        promptLines.push(`- ${filename}: failed to download (${response.status})`);
        index += 1;
        continue;
      }

      const buffer = await response.arrayBuffer();
      await Bun.write(targetPath, buffer);
      stagedPaths.push(targetPath);
      promptLines.push(`- ${filename}: ${targetPath}`);
    } catch {
      promptLines.push(`- ${filename}: failed to download`);
    }

    index += 1;
  }

  return {
    stagedPaths,
    promptSuffix: promptLines.join("\n"),
  };
}

export async function addReaction(message: Message, emoji: string): Promise<void> {
  try {
    await message.react(emoji);
  } catch {
    // Ignore reaction failures in channels where bot lacks permissions.
  }
}

export async function removeReaction(message: Message, emoji: string): Promise<void> {
  try {
    const reaction = message.reactions.cache.get(emoji);
    if (reaction) {
      await reaction.users.remove(message.client.user?.id ?? "");
    }
  } catch {
    // Ignore reaction cleanup failures.
  }
}

export function resolvePath(inputPath: string, baseDir = process.cwd()): string {
  if (inputPath.startsWith("~/")) {
    const home = process.env.HOME;
    if (home) {
      return path.resolve(home, inputPath.slice(2));
    }
  }
  if (path.isAbsolute(inputPath)) {
    return path.resolve(inputPath);
  }
  return path.resolve(baseDir, inputPath);
}

export async function pickFolderWithFinder(): Promise<string | null> {
  if (process.platform !== "darwin") {
    return null;
  }

  const subprocess = Bun.spawn({
    cmd: [
      "osascript",
      "-e",
      "try",
      "-e",
      'set selectedFolder to POSIX path of (choose folder with prompt "Select project folder for this channel")',
      "-e",
      "return selectedFolder",
      "-e",
      "on error number -128",
      "-e",
      'return ""',
      "-e",
      "end try",
    ],
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, exitCode] = await Promise.all([
    new Response(subprocess.stdout).text(),
    subprocess.exited,
  ]);

  if (exitCode !== 0) {
    return null;
  }

  const selected = stdout.trim();
  if (!selected) {
    return null;
  }

  return path.resolve(selected);
}
