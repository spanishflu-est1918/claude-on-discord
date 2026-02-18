export type PrCreateAction = "open" | "draft";
export type PrInspectAction = "status" | "view";

export type PrSummary = {
  number: number;
  title: string;
  state: string;
  isDraft: boolean;
  url: string;
  headRefName: string;
  baseRefName: string;
  body?: string;
};

export function parseOriginDefaultBranch(symbolicRefOutput: string): string | null {
  const line = symbolicRefOutput.split(/\r?\n/, 1)[0]?.trim() ?? "";
  const match = line.match(/^refs\/remotes\/origin\/(.+)$/);
  if (!match) {
    return null;
  }
  const branch = match[1]?.trim();
  return branch || null;
}

export function extractFirstUrl(text: string): string | null {
  const match = text.match(/https?:\/\/\S+/);
  return match?.[0] ?? null;
}

export function buildPrCreateArgs(input: {
  action: PrCreateAction;
  baseBranch: string;
  headBranch: string;
  title?: string;
  body?: string;
}): string[] {
  const title = input.title?.trim();
  const body = input.body?.trim();
  if (body && !title) {
    throw new Error("PR body requires a PR title.");
  }

  const args = ["gh", "pr", "create", "--base", input.baseBranch, "--head", input.headBranch];
  if (input.action === "draft") {
    args.push("--draft");
  }

  if (title) {
    args.push("--title", title, "--body", body ?? "");
  } else {
    args.push("--fill");
  }

  return args;
}

export function parsePrSummaryJson(output: string): PrSummary | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }
  const value = parsed as Record<string, unknown>;
  if (
    typeof value.number !== "number" ||
    typeof value.title !== "string" ||
    typeof value.state !== "string" ||
    typeof value.isDraft !== "boolean" ||
    typeof value.url !== "string" ||
    typeof value.headRefName !== "string" ||
    typeof value.baseRefName !== "string"
  ) {
    return null;
  }
  return {
    number: value.number,
    title: value.title,
    state: value.state,
    isDraft: value.isDraft,
    url: value.url,
    headRefName: value.headRefName,
    baseRefName: value.baseRefName,
    ...(typeof value.body === "string" ? { body: value.body } : {}),
  };
}

export function formatPrStatusLine(summary: PrSummary): string {
  const draft = summary.isDraft ? "draft" : "ready";
  return `PR #${summary.number} (${draft}, state=${summary.state}) \`${summary.headRefName}\` -> \`${summary.baseRefName}\`\n${summary.url}`;
}
