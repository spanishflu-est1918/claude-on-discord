import { parseOriginDefaultBranch } from "../discord/pr";
import { parseThreadBranchMeta } from "../discord/thread-branch";
import { buildChannelTopic, parseGitBranch } from "../discord/topic";
import type { Repository } from "../db/repository";

export type ThreadLifecycleRunCommand = (
  command: string[],
  cwd: string,
) => Promise<{ exitCode: number; output: string }>;

type TopicChannel = {
  setTopic: (topic: string) => Promise<unknown>;
};

function canSetTopic(channel: unknown): channel is TopicChannel {
  return (
    typeof channel === "object" &&
    channel !== null &&
    "setTopic" in channel &&
    typeof (channel as TopicChannel).setTopic === "function"
  );
}

export async function detectBranchName(
  workingDir: string,
  runCommand: ThreadLifecycleRunCommand,
): Promise<string | null> {
  const result = await runCommand(["git", "rev-parse", "--abbrev-ref", "HEAD"], workingDir);
  if (result.exitCode !== 0) {
    return null;
  }
  return parseGitBranch(result.output);
}

async function detectOriginDefaultBranch(
  workingDir: string,
  runCommand: ThreadLifecycleRunCommand,
): Promise<string | null> {
  const result = await runCommand(["git", "symbolic-ref", "refs/remotes/origin/HEAD"], workingDir);
  if (result.exitCode !== 0) {
    return null;
  }
  return parseOriginDefaultBranch(result.output);
}

export async function resolvePrBaseBranch(input: {
  channelId: string;
  workingDir: string;
  repository: Repository;
  runCommand: ThreadLifecycleRunCommand;
}): Promise<string> {
  const threadMeta = parseThreadBranchMeta(input.repository.getThreadBranchMeta(input.channelId));
  if (threadMeta) {
    const rootChannel = input.repository.getChannel(threadMeta.rootChannelId);
    const rootBranch = rootChannel
      ? await detectBranchName(rootChannel.workingDir, input.runCommand)
      : null;
    if (rootBranch) {
      return rootBranch;
    }
  }

  const originDefault = await detectOriginDefaultBranch(input.workingDir, input.runCommand);
  if (originDefault) {
    return originDefault;
  }
  return "main";
}

export async function syncChannelTopic(input: {
  channel: unknown;
  workingDir: string;
  runCommand: ThreadLifecycleRunCommand;
}): Promise<void> {
  if (!canSetTopic(input.channel)) {
    return;
  }
  const branch = await detectBranchName(input.workingDir, input.runCommand);
  const topic = buildChannelTopic({ workingDir: input.workingDir, branch });
  try {
    await input.channel.setTopic(topic);
  } catch {
    // Ignore topic update failures when permissions/channel type do not allow it.
  }
}
