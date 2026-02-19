import type { Repository } from "../db/repository";
import {
  detectBranchName as detectBranchNameInThreadLifecycle,
  resolvePrBaseBranch as resolvePrBaseBranchInThreadLifecycle,
  syncChannelTopic as syncChannelTopicInThreadLifecycle,
} from "./thread-lifecycle";

type RunCommand = (
  command: string[],
  cwd: string,
) => Promise<{ exitCode: number; output: string }>;

export function createThreadLifecycleOps(input: { runCommand: RunCommand }): {
  detectBranchName: (workingDir: string) => Promise<string | null>;
  resolvePrBaseBranch: (value: {
    channelId: string;
    workingDir: string;
    repository: Repository;
  }) => Promise<string>;
  syncChannelTopic: (channel: unknown, workingDir: string) => Promise<void>;
} {
  return {
    detectBranchName: async (workingDir: string) =>
      await detectBranchNameInThreadLifecycle(workingDir, input.runCommand),
    resolvePrBaseBranch: async (value) =>
      await resolvePrBaseBranchInThreadLifecycle({
        ...value,
        runCommand: input.runCommand,
      }),
    syncChannelTopic: async (channel: unknown, workingDir: string) =>
      await syncChannelTopicInThreadLifecycle({
        channel,
        workingDir,
        runCommand: input.runCommand,
      }),
  };
}
