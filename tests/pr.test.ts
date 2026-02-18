import { describe, expect, test } from "bun:test";
import {
  buildPrCreateArgs,
  buildPrMergeArgs,
  extractFirstUrl,
  formatPrStatusLine,
  parseOriginDefaultBranch,
  parsePrSummaryJson,
} from "../src/discord/pr";

describe("PR helpers", () => {
  test("parseOriginDefaultBranch extracts origin default branch", () => {
    expect(parseOriginDefaultBranch("refs/remotes/origin/main\n")).toBe("main");
    expect(parseOriginDefaultBranch("refs/remotes/origin/develop")).toBe("develop");
    expect(parseOriginDefaultBranch("HEAD")).toBeNull();
  });

  test("extractFirstUrl returns first URL when present", () => {
    expect(extractFirstUrl("created: https://github.com/acme/repo/pull/1\nok")).toBe(
      "https://github.com/acme/repo/pull/1",
    );
    expect(extractFirstUrl("no links here")).toBeNull();
  });

  test("buildPrCreateArgs builds draft/open commands", () => {
    expect(
      buildPrCreateArgs({
        action: "open",
        baseBranch: "main",
        headBranch: "feature",
      }),
    ).toEqual(["gh", "pr", "create", "--base", "main", "--head", "feature", "--fill"]);

    expect(
      buildPrCreateArgs({
        action: "draft",
        baseBranch: "main",
        headBranch: "feature",
        title: "My PR",
      }),
    ).toEqual([
      "gh",
      "pr",
      "create",
      "--base",
      "main",
      "--head",
      "feature",
      "--draft",
      "--title",
      "My PR",
      "--body",
      "",
    ]);
  });

  test("buildPrCreateArgs rejects body without title", () => {
    expect(() =>
      buildPrCreateArgs({
        action: "open",
        baseBranch: "main",
        headBranch: "feature",
        body: "body",
      }),
    ).toThrow("PR body requires a PR title.");
  });

  test("parsePrSummaryJson returns parsed summary for gh json output", () => {
    const parsed = parsePrSummaryJson(
      JSON.stringify({
        number: 42,
        title: "Add feature",
        state: "OPEN",
        isDraft: true,
        url: "https://github.com/acme/repo/pull/42",
        headRefName: "feature",
        baseRefName: "main",
        body: "details",
      }),
    );
    expect(parsed).toEqual({
      number: 42,
      title: "Add feature",
      state: "OPEN",
      isDraft: true,
      url: "https://github.com/acme/repo/pull/42",
      headRefName: "feature",
      baseRefName: "main",
      body: "details",
    });
  });

  test("formatPrStatusLine renders concise status", () => {
    const line = formatPrStatusLine({
      number: 9,
      title: "Title",
      state: "OPEN",
      isDraft: false,
      url: "https://github.com/acme/repo/pull/9",
      headRefName: "feature",
      baseRefName: "main",
    });
    expect(line).toContain("PR #9");
    expect(line).toContain("ready");
    expect(line).toContain("feature");
    expect(line).toContain("main");
  });

  test("buildPrMergeArgs builds merge command with strategy and flags", () => {
    expect(
      buildPrMergeArgs({
        number: 22,
        method: "squash",
        deleteBranch: false,
        admin: false,
      }),
    ).toEqual(["gh", "pr", "merge", "22", "--squash", "--keep-branch"]);

    expect(
      buildPrMergeArgs({
        number: 23,
        method: "merge",
        deleteBranch: true,
        admin: true,
      }),
    ).toEqual(["gh", "pr", "merge", "23", "--merge", "--delete-branch", "--admin"]);
  });
});
