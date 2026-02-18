import { describe, expect, test } from "bun:test";
import { buildChannelTopic, parseGitBranch } from "../src/discord/topic";

describe("topic helpers", () => {
  test("parseGitBranch returns null for detached head output", () => {
    expect(parseGitBranch("HEAD\n")).toBeNull();
    expect(parseGitBranch("")).toBeNull();
  });

  test("parseGitBranch returns branch name from git output", () => {
    expect(parseGitBranch("main\n")).toBe("main");
  });

  test("buildChannelTopic includes project, branch, and working dir", () => {
    const topic = buildChannelTopic({
      workingDir: "/Users/dev/projects/mercurius",
      branch: "main",
    });

    expect(topic).toContain("project=mercurius");
    expect(topic).toContain("branch=main");
    expect(topic).toContain("dir=/Users/dev/projects/mercurius");
  });

  test("buildChannelTopic clamps to discord topic limit", () => {
    const longPath = `/Users/dev/${"a".repeat(1200)}`;
    const topic = buildChannelTopic({ workingDir: longPath, branch: "feature/topic" });

    expect(topic.length).toBeLessThanOrEqual(1024);
    expect(topic.startsWith("...")).toBe(true);
    expect(topic).toContain(longPath.slice(-64));
  });
});
