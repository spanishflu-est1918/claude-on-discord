import { clipText } from "./text";

export function buildSeededPrompt(
  userPrompt: string,
  history: Array<{ role: "user" | "assistant"; content: string }>,
  hasActiveSession: boolean,
): string {
  if (hasActiveSession || history.length === 0) {
    return userPrompt;
  }

  const normalizedHistory = history
    .slice(-12)
    .map((entry) => {
      const compactText = entry.content.replace(/\s+/g, " ").trim();
      const clipped = compactText.length > 400 ? `${compactText.slice(0, 400)}...` : compactText;
      return `${entry.role.toUpperCase()}: ${clipped}`;
    })
    .join("\n");

  return [
    "Conversation context (carry this forward):",
    normalizedHistory,
    "",
    "Current user message:",
    userPrompt,
  ].join("\n");
}

export function parseDirectBashCommand(content: string): string | null {
  const trimmed = content.trim();
  if (!trimmed.startsWith("!")) {
    return null;
  }
  return trimmed.slice(1).trim();
}

export function buildMergeSummaryPrompt(focus?: string | null): string {
  const lines = [
    "Please provide a short handoff summary of what was accomplished in this conversation branch.",
    "This summary will be merged back into the parent thread as context.",
    "",
    "Output requirements:",
    "- Maximum 8 bullets",
    "- Maximum 900 characters total",
    "- Keep each bullet to one sentence",
    "",
    "Include only:",
    "- Key decisions and rationale",
    "- Files changed (paths only)",
    "- Unresolved issues / next steps",
    "",
    "Be specific and actionable.",
  ];

  if (focus?.trim()) {
    lines.push("", `Focus especially on: ${focus.trim()}`);
  }

  return lines.join("\n");
}

export function normalizeMergeSummary(summary: string, maxChars: number): string {
  const cleaned = summary.trim().replace(/\n{3,}/g, "\n\n");
  if (!cleaned) {
    return "(No summary generated.)";
  }
  return clipText(cleaned, maxChars);
}

export function summarizeGitMergeOutput(output: string): string {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length === 0) {
    return "No git output.";
  }

  if (lines.some((line) => /already up to date/i.test(line))) {
    return "Already up to date.";
  }

  const conflictLines = lines.filter(
    (line) => line.startsWith("CONFLICT") || /automatic merge failed/i.test(line),
  );
  if (conflictLines.length > 0) {
    const samples = conflictLines.slice(0, 2).map((line) => clipText(line, 120));
    const extra = conflictLines.length > 2 ? ` (+${conflictLines.length - 2} more)` : "";
    return [`Conflicts detected: ${conflictLines.length}${extra}.`, ...samples].join("\n");
  }

  const changedLine = lines.find((line) => /\d+\s+files?\s+changed/i.test(line));
  if (lines.some((line) => /fast-forward/i.test(line))) {
    return changedLine
      ? `Fast-forward merge. ${clipText(changedLine, 140)}`
      : "Fast-forward merge.";
  }

  const firstLine = clipText(lines[0] ?? "", 140);
  if (!changedLine || changedLine === lines[0]) {
    return firstLine;
  }
  return `${firstLine}\n${clipText(changedLine, 140)}`;
}

export function buildMergeContextInjection(context: {
  fromChannelId: string;
  fromChannelName: string;
  summary: string;
}): string {
  return [
    `[Merged context from fork \`${context.fromChannelName}\` (<#${context.fromChannelId}>)]`,
    "",
    context.summary,
    "",
    "[End of merged context — continue working in this thread with the above in mind]",
  ].join("\n");
}

export function buildMergeReportLines(input: {
  fromChannelId: string;
  fromChannelName: string;
  summary: string;
}): string {
  return [
    `🔀 **Merge from** <#${input.fromChannelId}> (\`${input.fromChannelName}\`)`,
    "",
    input.summary,
    "",
    "_This context has been injected into the next query in this channel._",
  ].join("\n");
}

export function compactHistory(
  history: Array<{ role: "user" | "assistant"; content: string }>,
  maxLines = 8,
): string {
  if (history.length === 0) {
    return "No prior context.";
  }

  return history
    .slice(-maxLines)
    .map((entry, index) => {
      const compactText = entry.content.replace(/\s+/g, " ").trim();
      const clipped = compactText.length > 180 ? `${compactText.slice(0, 180)}...` : compactText;
      return `${index + 1}. ${entry.role}: ${clipped}`;
    })
    .join("\n");
}
