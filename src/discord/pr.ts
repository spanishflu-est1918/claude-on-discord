export type PrCreateAction = "open" | "draft";

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
