import { describe, expect, test } from "bun:test";
import { ButtonStyle } from "discord.js";
import {
  buildProjectSwitchButtons,
  buildStopButtons,
  buildThreadWorktreeChoiceButtons,
  parseProjectSwitchCustomId,
  parseRunControlCustomId,
  parseThreadWorktreeChoiceCustomId,
} from "../src/discord/buttons";

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
    const interruptStyle = interrupt && "style" in interrupt ? interrupt.style : undefined;
    const abortStyle = abort && "style" in abort ? abort.style : undefined;

    expect(interruptId).toBe("run:interrupt:123");
    expect(abortId).toBe("run:abort:123");
    expect(interruptStyle).toBe(ButtonStyle.Secondary);
    expect(abortStyle).toBe(ButtonStyle.Secondary);
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

  test("builds and parses project switch buttons", () => {
    const rows = buildProjectSwitchButtons("req-1");
    expect(rows).toHaveLength(1);

    const components = rows[0]?.components ?? [];
    expect(components).toHaveLength(2);

    const keep = components[0]?.toJSON();
    const fresh = components[1]?.toJSON();
    const keepId = keep && "custom_id" in keep ? keep.custom_id : undefined;
    const freshId = fresh && "custom_id" in fresh ? fresh.custom_id : undefined;

    expect(keepId).toBe("project:keep:req-1");
    expect(freshId).toBe("project:fresh:req-1");

    expect(parseProjectSwitchCustomId("project:keep:req-1")).toEqual({
      action: "keep",
      requestId: "req-1",
    });
    expect(parseProjectSwitchCustomId("project:fresh:req-1")).toEqual({
      action: "fresh",
      requestId: "req-1",
    });
  });

  test("returns null for unknown/invalid ids", () => {
    expect(parseRunControlCustomId("noop")).toBeNull();
    expect(parseRunControlCustomId("run:interrupt:")).toBeNull();
    expect(parseRunControlCustomId("run:abort:")).toBeNull();
    expect(parseProjectSwitchCustomId("project:keep:")).toBeNull();
    expect(parseProjectSwitchCustomId("project:fresh:")).toBeNull();
    expect(parseThreadWorktreeChoiceCustomId("thread:worktree:keep:")).toBeNull();
    expect(parseThreadWorktreeChoiceCustomId("thread:worktree:create:")).toBeNull();
  });

  test("builds and parses thread worktree choice buttons", () => {
    const rows = buildThreadWorktreeChoiceButtons("thread-1");
    expect(rows).toHaveLength(1);

    const components = rows[0]?.components ?? [];
    expect(components).toHaveLength(2);

    const keep = components[0]?.toJSON();
    const create = components[1]?.toJSON();
    const keepId = keep && "custom_id" in keep ? keep.custom_id : undefined;
    const createId = create && "custom_id" in create ? create.custom_id : undefined;
    const keepStyle = keep && "style" in keep ? keep.style : undefined;
    const createStyle = create && "style" in create ? create.style : undefined;

    expect(keepId).toBe("thread:worktree:keep:thread-1");
    expect(createId).toBe("thread:worktree:create:thread-1");
    expect(keepStyle).toBe(ButtonStyle.Secondary);
    expect(createStyle).toBe(ButtonStyle.Primary);

    expect(parseThreadWorktreeChoiceCustomId("thread:worktree:keep:thread-1")).toEqual({
      action: "keep",
      channelId: "thread-1",
    });
    expect(parseThreadWorktreeChoiceCustomId("thread:worktree:create:thread-1")).toEqual({
      action: "create",
      channelId: "thread-1",
    });
  });
});
