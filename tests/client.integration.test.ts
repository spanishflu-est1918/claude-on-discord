import { describe, expect, test } from "bun:test";
import { MessageFlags } from "discord.js";
import { createDiscordClient } from "../src/discord/client";

function createBaseInteraction() {
  return {
    deferred: false,
    replied: false,
    replyCalls: [] as unknown[],
    followUpCalls: [] as unknown[],
    async reply(payload: unknown) {
      this.replied = true;
      this.replyCalls.push(payload);
    },
    async followUp(payload: unknown) {
      this.followUpCalls.push(payload);
    },
  };
}

function emitEvent(client: unknown, event: string, ...args: unknown[]): void {
  const emitter = client as { emit: (name: string, ...params: unknown[]) => boolean };
  emitter.emit(event, ...args);
}

describe("Discord client integration routing", () => {
  test("routes user message and ignores bot/empty messages", async () => {
    const seen: string[] = [];
    const client = createDiscordClient({
      token: "unused",
      onUserMessage: async (message) => {
        seen.push(message.content);
      },
      onSlashCommand: async () => {},
      onButtonInteraction: async () => {},
    });

    emitEvent(client, "messageCreate", {
      author: { bot: true },
      content: "bot",
      attachments: { size: 0 },
      reply: async () => {},
    });
    emitEvent(client, "messageCreate", {
      author: { bot: false },
      content: "   ",
      attachments: { size: 0 },
      reply: async () => {},
    });
    emitEvent(client, "messageCreate", {
      author: { bot: false },
      content: "hello",
      attachments: { size: 0 },
      reply: async () => {},
    });

    await Bun.sleep(0);
    expect(seen).toEqual(["hello"]);
    client.destroy();
  });

  test("accepts explicit mention from external bot authors", async () => {
    const seen: string[] = [];
    const client = createDiscordClient({
      token: "unused",
      onUserMessage: async (message) => {
        seen.push(message.content);
      },
      onSlashCommand: async () => {},
      onButtonInteraction: async () => {},
    });

    emitEvent(client, "messageCreate", {
      author: { bot: true, id: "other-bot" },
      content: "<@bot-1> ping",
      attachments: { size: 0 },
      client: { user: { id: "bot-1", username: "hermes_claude" } },
      mentions: {
        has: () => true,
        users: { has: (id: string) => id === "bot-1" },
      },
      reply: async () => {},
    });

    await Bun.sleep(0);
    expect(seen).toEqual(["<@bot-1> ping"]);
    client.destroy();
  });

  test("ignores Discord system/service messages", async () => {
    const seen: string[] = [];
    const client = createDiscordClient({
      token: "unused",
      onUserMessage: async (message) => {
        seen.push(message.content);
      },
      onSlashCommand: async () => {},
      onButtonInteraction: async () => {},
    });

    emitEvent(client, "messageCreate", {
      author: { bot: false },
      system: true,
      type: 7,
      content: "SPANISH FLU welcomes @hermes_claude",
      attachments: { size: 0 },
      reply: async () => {},
    });

    emitEvent(client, "messageCreate", {
      author: { bot: false },
      system: false,
      type: 0,
      content: "hello",
      attachments: { size: 0 },
      reply: async () => {},
    });

    await Bun.sleep(0);
    expect(seen).toEqual(["hello"]);
    client.destroy();
  });

  test("deduplicates repeated messageCreate events with the same message id", async () => {
    const seen: string[] = [];
    const client = createDiscordClient({
      token: "unused",
      onUserMessage: async (message) => {
        seen.push(message.content);
      },
      onSlashCommand: async () => {},
      onButtonInteraction: async () => {},
    });

    const duplicateMessage = {
      id: "msg-dup-1",
      author: { bot: false },
      content: "testing forks",
      attachments: { size: 0 },
      reply: async () => {},
    };

    emitEvent(client, "messageCreate", duplicateMessage);
    emitEvent(client, "messageCreate", duplicateMessage);

    await Bun.sleep(0);
    expect(seen).toEqual(["testing forks"]);
    client.destroy();
  });

  test("requires explicit mention in guild channels when shared-mention policy is enabled", async () => {
    const seen: string[] = [];
    const client = createDiscordClient({
      token: "unused",
      requireMentionInMultiUserChannels: true,
      onUserMessage: async (message) => {
        seen.push(message.content);
      },
      onSlashCommand: async () => {},
      onButtonInteraction: async () => {},
    });

    const makeMessage = (authorId: string, content: string, mentionBot: boolean) => ({
      author: { bot: false, id: authorId },
      guildId: "guild-1",
      content,
      attachments: { size: 0 },
      channel: {
        id: "channel-1",
        members: {
          size: 3,
          has: (id: string) => id === "bot-1" || id === "u1" || id === "u2",
        },
      },
      client: { user: { id: "bot-1" } },
      mentions: {
        has: () => mentionBot,
        users: { has: (id: string) => mentionBot && id === "bot-1" },
      },
      reply: async () => {},
    });

    emitEvent(client, "messageCreate", makeMessage("u1", "hello", false));
    emitEvent(client, "messageCreate", makeMessage("u2", "no mention yet", false));
    emitEvent(client, "messageCreate", makeMessage("u2", "<@bot-1> mentioned", true));
    emitEvent(client, "messageCreate", makeMessage("u1", "<@!bot-1> mentioned too", false));

    await Bun.sleep(0);
    expect(seen).toEqual(["<@bot-1> mentioned", "<@!bot-1> mentioned too"]);
    client.destroy();
  });

  test("defaults to strict mention requirement when participant data is unavailable", async () => {
    const seen: string[] = [];
    const client = createDiscordClient({
      token: "unused",
      requireMentionInMultiUserChannels: true,
      onUserMessage: async (message) => {
        seen.push(message.content);
      },
      onSlashCommand: async () => {},
      onButtonInteraction: async () => {},
    });

    emitEvent(client, "messageCreate", {
      author: { bot: false, id: "u1" },
      guildId: "guild-1",
      content: "first from user",
      attachments: { size: 0 },
      channel: { id: "channel-1" },
      client: { user: { id: "bot-1", username: "hermes_claude" } },
      mentions: {
        has: () => false,
        users: { has: () => false },
      },
      reply: async () => {},
    });

    emitEvent(client, "messageCreate", {
      author: { bot: false, id: "u1" },
      guildId: "guild-1",
      content: "<@bot-1> second with mention",
      attachments: { size: 0 },
      channel: { id: "channel-1" },
      client: { user: { id: "bot-1", username: "hermes_claude" } },
      mentions: {
        has: () => true,
        users: { has: (id: string) => id === "bot-1" },
      },
      reply: async () => {},
    });

    await Bun.sleep(0);
    expect(seen).toEqual(["<@bot-1> second with mention"]);
    client.destroy();
  });

  test("passes observed and participant-based channel context to user message handler", async () => {
    const counts: Array<{
      humans: number;
      nonClaude: number;
      participantNonClaude: number | null;
      shared: boolean;
    }> = [];
    const client = createDiscordClient({
      token: "unused",
      requireMentionInMultiUserChannels: false,
      onUserMessage: async (_message, context) => {
        counts.push({
          humans: context?.observedHumanUserCount ?? -1,
          nonClaude: context?.observedNonClaudeUserCount ?? -1,
          participantNonClaude: context?.participantNonClaudeUserCount ?? null,
          shared: context?.sharedChannel ?? false,
        });
      },
      onSlashCommand: async () => {},
      onButtonInteraction: async () => {},
    });

    emitEvent(client, "messageCreate", {
      author: { bot: false, id: "u1" },
      guildId: "guild-1",
      content: "hello",
      attachments: { size: 0 },
      channel: {
        id: "channel-ctx",
        members: { size: 3, has: (id: string) => id === "bot-1" || id === "u1" || id === "u2" },
      },
      client: { user: { id: "bot-1", username: "hermes_claude" } },
      mentions: { has: () => false, users: { has: () => false } },
      reply: async () => {},
    });

    emitEvent(client, "messageCreate", {
      author: { bot: true, id: "other-bot" },
      guildId: "guild-1",
      content: "<@bot-1> ping",
      attachments: { size: 0 },
      channel: {
        id: "channel-ctx",
        members: {
          size: 4,
          has: (id: string) => id === "bot-1" || id === "u1" || id === "u2" || id === "other-bot",
        },
      },
      client: { user: { id: "bot-1", username: "hermes_claude" } },
      mentions: { has: () => true, users: { has: (id: string) => id === "bot-1" } },
      reply: async () => {},
    });

    await Bun.sleep(0);
    expect(counts).toEqual([
      { humans: 1, nonClaude: 1, participantNonClaude: null, shared: true },
      { humans: 1, nonClaude: 2, participantNonClaude: null, shared: true },
    ]);
    client.destroy();
  });

  test("uses thread participant count to skip mention requirement when only one non-Claude participant exists", async () => {
    const seen: string[] = [];
    const client = createDiscordClient({
      token: "unused",
      requireMentionInMultiUserChannels: true,
      onUserMessage: async (message) => {
        seen.push(message.content);
      },
      onSlashCommand: async () => {},
      onButtonInteraction: async () => {},
    });

    emitEvent(client, "messageCreate", {
      author: { bot: false, id: "u1" },
      guildId: "guild-1",
      content: "thread hello",
      attachments: { size: 0 },
      channel: {
        id: "thread-1",
        isThread: () => true,
        memberCount: 2,
      },
      client: { user: { id: "bot-1", username: "hermes_claude" } },
      mentions: { has: () => false, users: { has: () => false } },
      reply: async () => {},
    });

    await Bun.sleep(0);
    expect(seen).toEqual(["thread hello"]);
    client.destroy();
  });

  test("uses per-message mention policy callback when provided", async () => {
    const seen: string[] = [];
    const client = createDiscordClient({
      token: "unused",
      requireMentionInMultiUserChannels: true,
      shouldRequireMentionForMessage: () => false,
      onUserMessage: async (message) => {
        seen.push(message.content);
      },
      onSlashCommand: async () => {},
      onButtonInteraction: async () => {},
    });

    const makeMessage = (authorId: string, content: string) => ({
      author: { bot: false, id: authorId },
      guildId: "guild-1",
      content,
      attachments: { size: 0 },
      channel: { id: "channel-1" },
      client: { user: { id: "bot-1" } },
      mentions: {
        has: () => false,
        users: { has: () => false },
      },
      reply: async () => {},
    });

    emitEvent(client, "messageCreate", makeMessage("u1", "first"));
    emitEvent(client, "messageCreate", makeMessage("u2", "second"));

    await Bun.sleep(0);
    expect(seen).toEqual(["first", "second"]);
    client.destroy();
  });

  test("enforces immediate mention when callback returns always", async () => {
    const seen: string[] = [];
    const client = createDiscordClient({
      token: "unused",
      shouldRequireMentionForMessage: () => "always",
      onUserMessage: async (message) => {
        seen.push(message.content);
      },
      onSlashCommand: async () => {},
      onButtonInteraction: async () => {},
    });

    const makeMessage = (content: string, mentionBot: boolean) => ({
      author: { bot: false, id: "u1" },
      guildId: "guild-1",
      content,
      attachments: { size: 0 },
      channel: { id: "channel-1" },
      client: { user: { id: "bot-1" } },
      mentions: {
        has: () => mentionBot,
        users: { has: (id: string) => mentionBot && id === "bot-1" },
      },
      reply: async () => {},
    });

    emitEvent(client, "messageCreate", makeMessage("plain hello", false));
    emitEvent(client, "messageCreate", makeMessage("<@bot-1> hello", true));

    await Bun.sleep(0);
    expect(seen).toEqual(["<@bot-1> hello"]);
    client.destroy();
  });

  test("enforces mention when inGuild() is true even if guildId is missing", async () => {
    const seen: string[] = [];
    const client = createDiscordClient({
      token: "unused",
      shouldRequireMentionForMessage: () => "always",
      onUserMessage: async (message) => {
        seen.push(message.content);
      },
      onSlashCommand: async () => {},
      onButtonInteraction: async () => {},
    });

    const makeMessage = (content: string, mentionBot: boolean) => ({
      author: { bot: false, id: "u1" },
      guildId: null,
      inGuild: () => true,
      content,
      attachments: { size: 0 },
      channel: { id: "channel-1" },
      client: { user: { id: "bot-1" } },
      mentions: {
        has: () => mentionBot,
        users: { has: (id: string) => mentionBot && id === "bot-1" },
      },
      reply: async () => {},
    });

    emitEvent(client, "messageCreate", makeMessage("plain hello", false));
    emitEvent(client, "messageCreate", makeMessage("<@bot-1> hello", true));

    await Bun.sleep(0);
    expect(seen).toEqual(["<@bot-1> hello"]);
    client.destroy();
  });

  test("accepts @username text mention fallback when mention objects are unavailable", async () => {
    const seen: string[] = [];
    const client = createDiscordClient({
      token: "unused",
      shouldRequireMentionForMessage: () => true,
      onUserMessage: async (message) => {
        seen.push(message.content);
      },
      onSlashCommand: async () => {},
      onButtonInteraction: async () => {},
    });

    emitEvent(client, "messageCreate", {
      author: { bot: false, id: "u1" },
      guildId: "guild-1",
      content: "@hermes_claude please check this",
      attachments: { size: 0 },
      channel: { id: "channel-1" },
      client: { user: { id: "bot-1", username: "hermes_claude" } },
      mentions: {
        has: () => false,
        users: { has: () => false },
      },
      reply: async () => {},
    });

    await Bun.sleep(0);
    expect(seen).toEqual(["@hermes_claude please check this"]);
    client.destroy();
  });

  test("replies with failure text when user message handler throws", async () => {
    const replies: string[] = [];
    const client = createDiscordClient({
      token: "unused",
      onUserMessage: async () => {
        throw new Error("boom");
      },
      onSlashCommand: async () => {},
      onButtonInteraction: async () => {},
    });

    emitEvent(client, "messageCreate", {
      author: { bot: false },
      content: "trigger",
      attachments: { size: 0 },
      reply: async (payload: string) => {
        replies.push(payload);
      },
    });

    await Bun.sleep(0);
    expect(replies[0]).toContain("❌ Failed to process message: boom");
    client.destroy();
  });

  test("routes button interactions and handles thrown errors", async () => {
    let buttonCalls = 0;
    const client = createDiscordClient({
      token: "unused",
      onUserMessage: async () => {},
      onSlashCommand: async () => {},
      onButtonInteraction: async () => {
        buttonCalls += 1;
      },
    });

    const okInteraction = {
      ...createBaseInteraction(),
      isButton: () => true,
      isChatInputCommand: () => false,
    };
    emitEvent(client, "interactionCreate", okInteraction);

    const failingClient = createDiscordClient({
      token: "unused",
      onUserMessage: async () => {},
      onSlashCommand: async () => {},
      onButtonInteraction: async () => {
        throw new Error("button fail");
      },
    });
    const failInteraction = {
      ...createBaseInteraction(),
      isButton: () => true,
      isChatInputCommand: () => false,
    };
    emitEvent(failingClient, "interactionCreate", failInteraction);

    await Bun.sleep(0);
    expect(buttonCalls).toBe(1);
    expect((failInteraction.replyCalls[0] as { flags: number }).flags).toBe(MessageFlags.Ephemeral);
    expect((failInteraction.replyCalls[0] as { content: string }).content).toContain("button fail");
    client.destroy();
    failingClient.destroy();
  });

  test("uses followUp for deferred button/slash error replies", async () => {
    const client = createDiscordClient({
      token: "unused",
      onUserMessage: async () => {},
      onSlashCommand: async () => {
        throw new Error("slash fail");
      },
      onButtonInteraction: async () => {
        throw new Error("button fail");
      },
    });

    const deferredButton = {
      ...createBaseInteraction(),
      deferred: true,
      isButton: () => true,
      isChatInputCommand: () => false,
    };
    const deferredSlash = {
      ...createBaseInteraction(),
      deferred: true,
      isButton: () => false,
      isChatInputCommand: () => true,
    };

    emitEvent(client, "interactionCreate", deferredButton);
    emitEvent(client, "interactionCreate", deferredSlash);
    await Bun.sleep(0);

    expect(deferredButton.followUpCalls.length).toBe(1);
    expect(deferredSlash.followUpCalls.length).toBe(1);
    expect((deferredSlash.followUpCalls[0] as { content: string }).content).toContain("slash fail");
    client.destroy();
  });

  test("emits gateway lifecycle callbacks", () => {
    const calls: string[] = [];
    const client = createDiscordClient({
      token: "unused",
      onUserMessage: async () => {},
      onSlashCommand: async () => {},
      onButtonInteraction: async () => {},
      onGatewayDisconnect: (code) => calls.push(`disconnect:${code}`),
      onGatewayReconnecting: () => calls.push("reconnecting"),
      onGatewayResume: (replayed) => calls.push(`resume:${replayed}`),
    });

    emitEvent(client, "shardDisconnect", { code: 1000 });
    emitEvent(client, "shardReconnecting", 0);
    emitEvent(client, "shardResume", 17, 0);

    expect(calls).toEqual(["disconnect:1000", "reconnecting", "resume:17"]);
    client.destroy();
  });

  test("emits thread lifecycle callbacks for archive/unarchive/delete", async () => {
    const calls: string[] = [];
    const client = createDiscordClient({
      token: "unused",
      onUserMessage: async () => {},
      onSlashCommand: async () => {},
      onButtonInteraction: async () => {},
      onThreadLifecycle: async (event) => {
        calls.push(`${event.type}:${event.threadId}`);
      },
    });

    emitEvent(
      client,
      "threadUpdate",
      { archived: false },
      {
        archived: true,
        id: "t1",
        parentId: "p1",
        name: "thread-1",
      },
    );
    emitEvent(
      client,
      "threadUpdate",
      { archived: true },
      {
        archived: false,
        id: "t1",
        parentId: "p1",
        name: "thread-1",
      },
    );
    emitEvent(client, "threadDelete", {
      id: "t1",
      parentId: "p1",
      name: "thread-1",
    });

    await Bun.sleep(0);
    expect(calls).toEqual(["archived:t1", "unarchived:t1", "deleted:t1"]);
    client.destroy();
  });
});
