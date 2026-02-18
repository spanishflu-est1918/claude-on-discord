import { describe, expect, test } from "bun:test";
import { chunkDiscordText, chunkDiscordTextWithMode } from "../src/discord/chunker";

function countLines(text: string): number {
  return text.split("\n").length;
}

function hasBalancedFences(chunk: string): boolean {
  let open: { markerChar: string; markerLen: number } | null = null;
  for (const line of chunk.split("\n")) {
    const match = line.match(/^( {0,3})(`{3,}|~{3,})(.*)$/);
    if (!match) {
      continue;
    }
    const marker = match[2];
    if (!marker) {
      continue;
    }
    if (!open) {
      open = { markerChar: marker[0] ?? "`", markerLen: marker.length };
      continue;
    }
    if (open.markerChar === (marker[0] ?? "`") && marker.length >= open.markerLen) {
      open = null;
    }
  }
  return open === null;
}

describe("chunkDiscordText", () => {
  test("splits tall messages even when under 2000 chars", () => {
    const text = Array.from({ length: 45 }, (_, i) => `line-${i + 1}`).join("\n");
    expect(text.length).toBeLessThan(2000);

    const chunks = chunkDiscordText(text, { maxChars: 2000, maxLines: 20 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(countLines(chunk)).toBeLessThanOrEqual(20);
    }
  });

  test("keeps fenced code blocks balanced across chunks", () => {
    const body = Array.from({ length: 30 }, (_, i) => `console.log(${i});`).join("\n");
    const text = `Here is code:\n\n\`\`\`js\n${body}\n\`\`\`\n\nDone.`;

    const chunks = chunkDiscordText(text, { maxChars: 2000, maxLines: 10 });
    expect(chunks.length).toBeGreaterThan(1);

    for (const chunk of chunks) {
      expect(hasBalancedFences(chunk)).toBe(true);
      expect(chunk.length).toBeLessThanOrEqual(2000);
    }

    expect(chunks[0]).toContain("```js");
    expect(chunks.at(-1)).toContain("Done.");
  });

  test("keeps fenced blocks intact when chunkMode is newline", () => {
    const text = "```js\nconst a = 1;\nconst b = 2;\n```\nAfter";
    const chunks = chunkDiscordTextWithMode(text, {
      maxChars: 2000,
      maxLines: 50,
      chunkMode: "newline",
    });
    expect(chunks).toEqual([text]);
  });

  test("reserves space for closing fences when chunking", () => {
    const body = "a".repeat(120);
    const text = `\`\`\`txt\n${body}\n\`\`\``;

    const chunks = chunkDiscordText(text, { maxChars: 50, maxLines: 50 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(50);
      expect(hasBalancedFences(chunk)).toBe(true);
    }
  });

  test("preserves whitespace when splitting long lines", () => {
    const text = Array.from({ length: 40 }, () => "word").join(" ");
    const chunks = chunkDiscordText(text, { maxChars: 20, maxLines: 50 });
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join("")).toBe(text);
  });

  test("preserves mixed whitespace across chunk boundaries", () => {
    const text = "alpha  beta\tgamma   delta epsilon  zeta";
    const chunks = chunkDiscordText(text, { maxChars: 12, maxLines: 50 });
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join("")).toBe(text);
  });

  test("keeps leading whitespace when splitting long lines", () => {
    const text = "    indented line with words that force splits";
    const chunks = chunkDiscordText(text, { maxChars: 14, maxLines: 50 });
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join("")).toBe(text);
  });

  test("keeps reasoning italics balanced across chunks", () => {
    const body = Array.from({ length: 25 }, (_, i) => `${i + 1}. line`).join("\n");
    const text = `Reasoning:\n_${body}_`;

    const chunks = chunkDiscordText(text, { maxLines: 10, maxChars: 2000 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      const count = (chunk.match(/_/g) || []).length;
      expect(count % 2).toBe(0);
    }
  });
});
