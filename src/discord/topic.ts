import path from "node:path";

const MAX_TOPIC_LENGTH = 1024;

function truncateFromStart(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  if (maxLength <= 3) {
    return value.slice(0, maxLength);
  }
  return `...${value.slice(-(maxLength - 3))}`;
}

export function parseGitBranch(rawOutput: string): string | null {
  const branch = rawOutput.split(/\r?\n/, 1)[0]?.trim() ?? "";
  if (!branch || branch === "HEAD") {
    return null;
  }
  return branch;
}

export function buildChannelTopic(input: { workingDir: string; branch?: string | null }): string {
  const projectName = path.basename(input.workingDir) || input.workingDir;
  const base = input.branch
    ? `Claude project=${projectName} branch=${input.branch} dir=${input.workingDir}`
    : `Claude project=${projectName} dir=${input.workingDir}`;
  return truncateFromStart(base, MAX_TOPIC_LENGTH);
}
