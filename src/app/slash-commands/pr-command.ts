import { type ChatInputCommandInteraction } from "discord.js";
import type { SessionManager } from "../../claude/session";
import {
  buildPrCreateArgs,
  buildPrMergeArgs,
  extractFirstUrl,
  formatPrStatusLine,
  type PrChecksAction,
  type PrCreateAction,
  type PrInspectAction,
  type PrMergeAction,
  type PrMergeMethod,
  parsePrChecksJson,
  parsePrSummaryJson,
} from "../../discord/pr";
import { parseGitBranch } from "../../discord/topic";
import { clipOutput, firstOutputLine } from "../diff-worktree";
import { formatErrorMessage } from "../file-artifacts";

export async function handlePrCommand(input: {
  interaction: ChatInputCommandInteraction;
  channelId: string;
  guildId: string;
  sessions: SessionManager;
  runCommand: (command: string[], cwd: string) => Promise<{ exitCode: number; output: string }>;
  chunkDiscordText: (text: string) => string[];
  resolvePrBaseBranch: (value: {
    channelId: string;
    workingDir: string;
  }) => Promise<string>;
}): Promise<void> {
  const state = input.sessions.getState(input.channelId, input.guildId);
  const action = input.interaction.options.getSubcommand(true) as
    | PrCreateAction
    | PrChecksAction
    | PrInspectAction
    | PrMergeAction;
  await input.interaction.deferReply();

  const ghVersion = await input.runCommand(["gh", "--version"], state.channel.workingDir);
  if (ghVersion.exitCode !== 0) {
    await input.interaction.editReply("GitHub CLI (`gh`) is not available. Install it and run `/pr` again.");
    return;
  }

  const headResult = await input.runCommand(
    ["git", "rev-parse", "--abbrev-ref", "HEAD"],
    state.channel.workingDir,
  );
  if (headResult.exitCode !== 0) {
    await input.interaction.editReply(
      `Not a git repository: \`${state.channel.workingDir}\`\n` +
        `\`\`\`bash\n${clipOutput(headResult.output || "(no output)", 1800)}\n\`\`\``,
    );
    return;
  }

  const headBranch = parseGitBranch(headResult.output);
  if (!headBranch) {
    await input.interaction.editReply(
      "Current repository is in detached HEAD state. Checkout a branch before `/pr`.",
    );
    return;
  }

  if (action === "status" || action === "view" || action === "checks" || action === "merge") {
    const inspectResult = await input.runCommand(
      [
        "gh",
        "pr",
        "view",
        headBranch,
        "--json",
        "number,title,state,isDraft,url,headRefName,baseRefName,body",
      ],
      state.channel.workingDir,
    );
    if (inspectResult.exitCode !== 0) {
      if (/no pull requests found/i.test(inspectResult.output)) {
        await input.interaction.editReply(`No PR found for current branch \`${headBranch}\`.`);
        return;
      }
      await input.interaction.editReply(
        `Failed to inspect PR for \`${headBranch}\`.\n` +
          `\`\`\`bash\n${clipOutput(inspectResult.output || "(no output)", 1800)}\n\`\`\``,
      );
      return;
    }

    const summary = parsePrSummaryJson(inspectResult.output);
    if (!summary) {
      await input.interaction.editReply(
        "Could not parse `gh pr view` response. Try again with a newer `gh` version.",
      );
      return;
    }

    if (action === "status") {
      await input.interaction.editReply(formatPrStatusLine(summary));
      return;
    }

    if (action === "view") {
      const details = [
        formatPrStatusLine(summary),
        `Title: ${summary.title}`,
        `Body:\n${clipOutput(summary.body?.trim() || "(empty)", 2400)}`,
      ].join("\n\n");
      const chunks = input.chunkDiscordText(details);
      await input.interaction.editReply(chunks[0] ?? "(no output)");
      for (let i = 1; i < chunks.length; i++) {
        const chunk = chunks[i];
        if (chunk) {
          await input.interaction.followUp(chunk);
        }
      }
      return;
    }

    if (action === "checks") {
      const checksResult = await input.runCommand(
        ["gh", "pr", "checks", String(summary.number), "--json", "name,state,workflow,link"],
        state.channel.workingDir,
      );

      const parsedChecks = parsePrChecksJson(checksResult.output);
      if (!parsedChecks) {
        if (checksResult.exitCode !== 0) {
          await input.interaction.editReply(
            `Failed to read checks for PR #${summary.number}.\n` +
              `\`\`\`bash\n${clipOutput(checksResult.output || "(no output)", 1800)}\n\`\`\``,
          );
          return;
        }
        await input.interaction.editReply(`Could not parse check output for PR #${summary.number}.`);
        return;
      }

      if (parsedChecks.length === 0) {
        await input.interaction.editReply(`No checks reported yet for PR #${summary.number}.\n${summary.url}`);
        return;
      }

      const counts = new Map<string, number>();
      for (const check of parsedChecks) {
        counts.set(check.state, (counts.get(check.state) ?? 0) + 1);
      }
      const summaryLine = Array.from(counts.entries())
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([stateName, count]) => `${stateName}=${count}`)
        .join(", ");
      const lines = [
        `Checks for PR #${summary.number} (\`${summary.headRefName}\` -> \`${summary.baseRefName}\`)`,
        `Summary: ${summaryLine}`,
        "",
        ...parsedChecks.map((check) => {
          const workflow = check.workflow ? ` [${check.workflow}]` : "";
          const link = check.link ? ` ${check.link}` : "";
          return `- ${check.state}: ${check.name}${workflow}${link}`;
        }),
      ];
      const chunks = input.chunkDiscordText(lines.join("\n"));
      await input.interaction.editReply(chunks[0] ?? "(no checks output)");
      for (let i = 1; i < chunks.length; i++) {
        const chunk = chunks[i];
        if (chunk) {
          await input.interaction.followUp(chunk);
        }
      }
      return;
    }

    const confirmMerge = input.interaction.options.getBoolean("confirm", true);
    if (!confirmMerge) {
      await input.interaction.editReply(
        "Merge safety check failed. Re-run with `confirm:true` to merge.",
      );
      return;
    }
    if (summary.state !== "OPEN") {
      await input.interaction.editReply(
        `Cannot merge PR #${summary.number}: state is \`${summary.state}\` (expected OPEN).`,
      );
      return;
    }
    if (summary.isDraft) {
      await input.interaction.editReply(`Cannot merge PR #${summary.number}: it is still a draft.`);
      return;
    }

    const dirtyResult = await input.runCommand(["git", "status", "--porcelain"], state.channel.workingDir);
    if (dirtyResult.exitCode === 0 && dirtyResult.output.trim().length > 0) {
      await input.interaction.editReply(
        "Working tree has uncommitted changes. Commit or stash before `/pr merge`.",
      );
      return;
    }

    const methodInput = input.interaction.options.getString("method")?.trim() || "squash";
    if (!["squash", "rebase", "merge"].includes(methodInput)) {
      await input.interaction.editReply(
        `Unsupported merge method \`${methodInput}\`. Use squash, rebase, or merge.`,
      );
      return;
    }

    const method = methodInput as PrMergeMethod;
    const deleteBranch = input.interaction.options.getBoolean("delete_branch") ?? false;
    const admin = input.interaction.options.getBoolean("admin") ?? false;
    const mergeArgs = buildPrMergeArgs({
      number: summary.number,
      method,
      deleteBranch,
      admin,
    });
    const mergeResult = await input.runCommand(mergeArgs, state.channel.workingDir);
    if (mergeResult.exitCode !== 0) {
      await input.interaction.editReply(
        `Failed to merge PR #${summary.number}.\n` +
          `\`\`\`bash\n${clipOutput(mergeResult.output || "(no output)", 1800)}\n\`\`\``,
      );
      return;
    }

    await input.interaction.editReply(
      `Merged PR #${summary.number} with \`${method}\` (${deleteBranch ? "branch deleted" : "branch kept"}).\n${summary.url}`,
    );
    return;
  }

  const baseInput = input.interaction.options.getString("base")?.trim() || null;
  const titleInput = input.interaction.options.getString("title")?.trim() || null;
  const bodyInput = input.interaction.options.getString("body")?.trim() || null;
  const baseBranch =
    baseInput ??
    (await input.resolvePrBaseBranch({
      channelId: input.channelId,
      workingDir: state.channel.workingDir,
    }));
  if (baseBranch === headBranch) {
    await input.interaction.editReply(
      `Head and base are both \`${headBranch}\`. Use \`/pr base:<branch>\` or switch branches.`,
    );
    return;
  }

  const dirtyResult = await input.runCommand(["git", "status", "--porcelain"], state.channel.workingDir);
  if (dirtyResult.exitCode === 0 && dirtyResult.output.trim().length > 0) {
    await input.interaction.editReply(
      "Working tree has uncommitted changes. Commit or stash before opening a PR.",
    );
    return;
  }

  const aheadResult = await input.runCommand(
    ["git", "rev-list", "--count", `${baseBranch}..${headBranch}`],
    state.channel.workingDir,
  );
  if (aheadResult.exitCode === 0) {
    const aheadText = firstOutputLine(aheadResult.output);
    const ahead = Number.parseInt(aheadText, 10);
    if (Number.isFinite(ahead) && ahead <= 0) {
      await input.interaction.editReply(
        `No commits ahead of \`${baseBranch}\` on \`${headBranch}\`. Nothing to PR.`,
      );
      return;
    }
  }

  let prArgs: string[];
  try {
    prArgs = buildPrCreateArgs({
      action,
      baseBranch,
      headBranch,
      ...(titleInput ? { title: titleInput } : {}),
      ...(bodyInput ? { body: bodyInput } : {}),
    });
  } catch (error) {
    await input.interaction.editReply(formatErrorMessage(error));
    return;
  }

  const createResult = await input.runCommand(prArgs, state.channel.workingDir);
  if (createResult.exitCode !== 0) {
    await input.interaction.editReply(
      `Failed to create PR (\`${headBranch}\` -> \`${baseBranch}\`).\n` +
        `\`\`\`bash\n${clipOutput(createResult.output || "(no output)", 1800)}\n\`\`\``,
    );
    return;
  }

  const prUrl = extractFirstUrl(createResult.output);
  const prType = action === "draft" ? "Draft PR" : "PR";
  await input.interaction.editReply(
    `${prType} created (\`${headBranch}\` -> \`${baseBranch}\`).${prUrl ? `\n${prUrl}` : ""}`,
  );
}
