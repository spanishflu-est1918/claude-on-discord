import { describe, expect, test } from "bun:test";
import { ButtonStyle } from "discord.js";
import {
  buildDiffViewButtons,
  buildProjectSwitchButtons,
  buildQueueNoticeButtons,
  buildStopButtons,
  buildThreadCleanupButtons,
  buildThreadWorktreeChoiceButtons,
  buildToolViewButtons,
  parseDiffViewCustomId,
  parseProjectSwitchCustomId,
  parseQueueNoticeCustomId,
  parseRunControlCustomId,
  parseThreadCleanupCustomId,
  parseThreadWorktreeChoiceCustomId,
  parseToolViewCustomId,
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

  test("builds queue notice buttons with Send Now + Dismiss", () => {
    const rows = buildQueueNoticeButtons("chan-9", "user-5");
    expect(rows).toHaveLength(1);

    const components = rows[0]?.components ?? [];
    expect(components).toHaveLength(2);

    const steer = components[0]?.toJSON();
    const dismiss = components[1]?.toJSON();
    const steerId = steer && "custom_id" in steer ? steer.custom_id : undefined;
    const dismissId = dismiss && "custom_id" in dismiss ? dismiss.custom_id : undefined;
    const steerStyle = steer && "style" in steer ? steer.style : undefined;
    const dismissStyle = dismiss && "style" in dismiss ? dismiss.style : undefined;

    expect(steerId).toBe("queue:steer:chan-9:user-5");
    expect(dismissId).toBe("queue:dismiss:chan-9:user-5");
    expect(steerStyle).toBe(ButtonStyle.Primary);
    expect(dismissStyle).toBe(ButtonStyle.Secondary);
  });

  test("parses queue notice custom ids for both dismiss and steer actions", () => {
    expect(parseQueueNoticeCustomId("queue:dismiss:chan-9:user-5")).toEqual({
      action: "dismiss",
      channelId: "chan-9",
      userId: "user-5",
    });

    expect(parseQueueNoticeCustomId("queue:steer:chan-9:user-5")).toEqual({
      action: "steer",
      channelId: "chan-9",
      userId: "user-5",
    });
  });

  test("builds and parses tool view expand/collapse buttons", () => {
    const expandedRows = buildToolViewButtons("chan-9", "tool-123", true);
    const expandedButton = expandedRows[0]?.components[0]?.toJSON();
    const expandedId =
      expandedButton && "custom_id" in expandedButton ? expandedButton.custom_id : undefined;
    expect(expandedId).toBe("run:toolview:collapse:chan-9:tool-123");
    expect(parseToolViewCustomId("run:toolview:collapse:chan-9:tool-123")).toEqual({
      action: "collapse",
      channelId: "chan-9",
      toolId: "tool-123",
    });

    const collapsedRows = buildToolViewButtons("chan-9", "tool-123", false);
    const collapsedButton = collapsedRows[0]?.components[0]?.toJSON();
    const collapsedId =
      collapsedButton && "custom_id" in collapsedButton ? collapsedButton.custom_id : undefined;
    expect(collapsedId).toBe("run:toolview:expand:chan-9:tool-123");
    expect(parseToolViewCustomId("run:toolview:expand:chan-9:tool-123")).toEqual({
      action: "expand",
      channelId: "chan-9",
      toolId: "tool-123",
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
    expect(parseToolViewCustomId("run:toolview:expand:chan-only")).toBeNull();
    expect(parseToolViewCustomId("run:toolview:oops:chan:tool")).toBeNull();
    expect(parseQueueNoticeCustomId("queue:dismiss:")).toBeNull();
    expect(parseQueueNoticeCustomId("queue:dismiss:chan-only")).toBeNull();
    expect(parseQueueNoticeCustomId("queue:dismiss::user-only")).toBeNull();
    expect(parseQueueNoticeCustomId("queue:steer:")).toBeNull();
    expect(parseQueueNoticeCustomId("queue:steer:chan-only")).toBeNull();
    expect(parseProjectSwitchCustomId("project:keep:")).toBeNull();
    expect(parseProjectSwitchCustomId("project:fresh:")).toBeNull();
    expect(parseThreadWorktreeChoiceCustomId("thread:worktree:keep:")).toBeNull();
    expect(parseThreadWorktreeChoiceCustomId("thread:worktree:create:")).toBeNull();
    expect(parseThreadCleanupCustomId("thread:cleanup:keep:")).toBeNull();
    expect(parseThreadCleanupCustomId("thread:cleanup:remove:")).toBeNull();
    expect(parseDiffViewCustomId("diff:summary:")).toBeNull();
    expect(parseDiffViewCustomId("diff:files:")).toBeNull();
    expect(parseDiffViewCustomId("diff:stat:")).toBeNull();
    expect(parseDiffViewCustomId("diff:patch:")).toBeNull();
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

  test("builds and parses thread cleanup buttons", () => {
    const rows = buildThreadCleanupButtons("thread-2");
    expect(rows).toHaveLength(1);

    const components = rows[0]?.components ?? [];
    expect(components).toHaveLength(2);

    const keep = components[0]?.toJSON();
    const remove = components[1]?.toJSON();
    const keepId = keep && "custom_id" in keep ? keep.custom_id : undefined;
    const removeId = remove && "custom_id" in remove ? remove.custom_id : undefined;
    const keepStyle = keep && "style" in keep ? keep.style : undefined;
    const removeStyle = remove && "style" in remove ? remove.style : undefined;

    expect(keepId).toBe("thread:cleanup:keep:thread-2");
    expect(removeId).toBe("thread:cleanup:remove:thread-2");
    expect(keepStyle).toBe(ButtonStyle.Secondary);
    expect(removeStyle).toBe(ButtonStyle.Primary);

    expect(parseThreadCleanupCustomId("thread:cleanup:keep:thread-2")).toEqual({
      action: "keep",
      channelId: "thread-2",
    });
    expect(parseThreadCleanupCustomId("thread:cleanup:remove:thread-2")).toEqual({
      action: "remove",
      channelId: "thread-2",
    });
  });

  test("builds and parses diff view buttons", () => {
    const rows = buildDiffViewButtons("req-77");
    expect(rows).toHaveLength(1);

    const components = rows[0]?.components ?? [];
    expect(components).toHaveLength(4);

    const ids = components
      .map((component) => component.toJSON())
      .map((json) => ("custom_id" in json ? json.custom_id : undefined));
    expect(ids).toEqual([
      "diff:summary:req-77",
      "diff:files:req-77",
      "diff:stat:req-77",
      "diff:patch:req-77",
    ]);

    expect(parseDiffViewCustomId("diff:summary:req-77")).toEqual({
      action: "summary",
      requestId: "req-77",
    });
    expect(parseDiffViewCustomId("diff:files:req-77")).toEqual({
      action: "files",
      requestId: "req-77",
    });
    expect(parseDiffViewCustomId("diff:stat:req-77")).toEqual({
      action: "stat",
      requestId: "req-77",
    });
    expect(parseDiffViewCustomId("diff:patch:req-77")).toEqual({
      action: "patch",
      requestId: "req-77",
    });
  });
});
