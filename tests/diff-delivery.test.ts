import { describe, expect, test } from "bun:test";
import { buildDiffDelivery } from "../src/discord/diff-delivery";

describe("diff delivery", () => {
  test("returns no-output message when diff text is empty", () => {
    const delivery = buildDiffDelivery("   ", "diff");
    expect(delivery.content).toBe("(no diff output)");
    expect(delivery.files).toBeUndefined();
  });

  test("returns a single attachment payload for non-empty diff", async () => {
    const delivery = buildDiffDelivery("diff --git a/x b/x\n+hello", "My Prefix");
    expect(delivery.content).toContain("Full output attached as");
    expect(delivery.files).toBeDefined();
    expect(delivery.files).toHaveLength(1);

    const attachment = delivery.files?.[0];
    expect(attachment?.name).toMatch(/^my-prefix-[a-z0-9]+\.diff$/);
    expect(Buffer.isBuffer(attachment?.attachment)).toBe(true);
    const body = (attachment?.attachment as Buffer).toString("utf8");
    expect(body).toContain("diff --git a/x b/x");
    expect(body).toContain("+hello");
  });
});
