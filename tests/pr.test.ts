import { describe, expect, test } from "bun:test";
import { buildPrCreateArgs, extractFirstUrl, parseOriginDefaultBranch } from "../src/discord/pr";

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
});
