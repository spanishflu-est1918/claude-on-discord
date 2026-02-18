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
});
