import type { ThreadBranchMeta } from "../types";

function isThreadBranchMeta(value: unknown): value is ThreadBranchMeta {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<ThreadBranchMeta>;
  return (
    typeof candidate.channelId === "string" &&
    typeof candidate.guildId === "string" &&
    typeof candidate.rootChannelId === "string" &&
    (typeof candidate.parentChannelId === "string" || candidate.parentChannelId === null) &&
    typeof candidate.name === "string" &&
    typeof candidate.createdAt === "number" &&
    Number.isFinite(candidate.createdAt) &&
    (typeof candidate.worktreePath === "string" || typeof candidate.worktreePath === "undefined")
  );
}

export function parseThreadBranchMeta(raw: string | null): ThreadBranchMeta | null {
  if (!raw) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    return isThreadBranchMeta(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function buildThreadBranchAwarenessPrompt(input: {
  currentChannelId: string;
  entries: Array<{ channelId: string; value: string }>;
  maxBranches?: number;
}): string {
  const maxBranches = Math.max(3, input.maxBranches ?? 12);
  const metas = input.entries
    .map((entry) => parseThreadBranchMeta(entry.value))
    .filter((entry): entry is ThreadBranchMeta => entry !== null)
    .sort((a, b) => a.createdAt - b.createdAt);

  if (metas.length === 0) {
    return "";
  }

  const byChannel = new Map<string, ThreadBranchMeta>();
  for (const meta of metas) {
    byChannel.set(meta.channelId, meta);
  }

  const lines: string[] = [
    "Discord thread branch metadata (structural context):",
    "Use this only when the user asks about branch/thread topology; otherwise ignore it.",
  ];

  const currentMeta = byChannel.get(input.currentChannelId);
  if (currentMeta) {
    const related = metas.filter((meta) => meta.rootChannelId === currentMeta.rootChannelId);
    lines.push(`Current channel id: ${currentMeta.channelId}`);
    lines.push(`Root channel id: ${currentMeta.rootChannelId}`);
    lines.push(`Parent channel id: ${currentMeta.parentChannelId ?? "none"}`);
    lines.push("Known thread branches:");

    for (const meta of related.slice(0, maxBranches)) {
      lines.push(
        `- name=${meta.name}; channel=${meta.channelId}; parent=${meta.parentChannelId ?? meta.rootChannelId}; worktree=${meta.worktreePath ?? "inherited-root"}`,
      );
    }
    if (related.length > maxBranches) {
      lines.push(`- ... ${related.length - maxBranches} more thread branches not shown`);
    }

    return `${lines.join("\n")}\n\n`;
  }

  const rootedHere = metas.filter((meta) => meta.rootChannelId === input.currentChannelId);
  if (rootedHere.length === 0) {
    return "";
  }
  lines.push(`Current channel id: ${input.currentChannelId}`);
  lines.push("Current channel is a root with child thread branches:");
  for (const meta of rootedHere.slice(0, maxBranches)) {
    lines.push(
      `- name=${meta.name}; channel=${meta.channelId}; parent=${meta.parentChannelId ?? "none"}; worktree=${meta.worktreePath ?? "inherited-root"}`,
    );
  }
  if (rootedHere.length > maxBranches) {
    lines.push(`- ... ${rootedHere.length - maxBranches} more thread branches not shown`);
  }

  return `${lines.join("\n")}\n\n`;
}

export function buildThreadBranchStatusLines(input: {
  currentChannelId: string;
  entries: Array<{ channelId: string; value: string }>;
}): string[] {
  const metas = input.entries
    .map((entry) => parseThreadBranchMeta(entry.value))
    .filter((entry): entry is ThreadBranchMeta => entry !== null);

  if (metas.length === 0) {
    return [];
  }

  const byChannel = new Map<string, ThreadBranchMeta>();
  for (const meta of metas) {
    byChannel.set(meta.channelId, meta);
  }

  const current = byChannel.get(input.currentChannelId);
  if (current) {
    const lines = [
      `Thread branch: \`${current.name}\` (\`${current.channelId}\`)`,
      `Thread root: \`${current.rootChannelId}\``,
      `Thread parent: ${current.parentChannelId ? `\`${current.parentChannelId}\`` : "none"}`,
    ];
    if (current.worktreePath) {
      lines.push(`Thread worktree: \`${current.worktreePath}\``);
    }
    return lines;
  }

  const childCount = metas.filter((meta) => meta.rootChannelId === input.currentChannelId).length;
  if (childCount > 0) {
    return [
      `Thread role: root (\`${input.currentChannelId}\`)`,
      `Thread branches: \`${childCount}\``,
    ];
  }

  return [];
}
