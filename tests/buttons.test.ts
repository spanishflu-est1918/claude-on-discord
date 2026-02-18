import { describe, expect, test } from "bun:test";
import { buildStopButtons, parseRunControlCustomId } from "../src/discord/buttons";

describe("discord buttons", () => {
  test("builds interrupt and abort controls with channel-bound ids", () => {
    const rows = buildStopButtons("123");
    expect(rows).toHaveLength(1);

    const components = rows[0]?.components ?? [];
    expect(components).toHaveLength(2);

    const interrupt = components[0]?.toJSON();
    const abort = components[1]?.toJSON();
    const interruptId = interrupt && "custom_id" in interrupt ? interrupt.custom_id : undefined;
    const abortId = abort && "custom_id" in abort ? abort.custom_id : undefined;

    expect(interruptId).toBe("run:interrupt:123");
    expect(abortId).toBe("run:abort:123");
  });

  test("parses interrupt and abort ids", () => {
    expect(parseRunControlCustomId("run:interrupt:abc")).toEqual({
      action: "interrupt",
      channelId: "abc",
    });

    expect(parseRunControlCustomId("run:abort:xyz")).toEqual({
      action: "abort",
      channelId: "xyz",
    });
  });

  test("returns null for unknown/invalid ids", () => {
    expect(parseRunControlCustomId("noop")).toBeNull();
    expect(parseRunControlCustomId("run:interrupt:")).toBeNull();
    expect(parseRunControlCustomId("run:abort:")).toBeNull();
  });
});
