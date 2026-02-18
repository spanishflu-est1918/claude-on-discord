import { describe, expect, test } from "bun:test";
import { RingBuffer } from "../src/claude/ring-buffer";

describe("RingBuffer", () => {
  test("throws for invalid max size", () => {
    expect(() => new RingBuffer<string>(0)).toThrow();
  });

  test("stores values up to max size", () => {
    const buffer = new RingBuffer<number>(3);
    buffer.push(1);
    buffer.push(2);
    buffer.push(3);
    expect(buffer.size).toBe(3);
    expect(buffer.isFull).toBe(true);
    expect(buffer.toArray()).toEqual([1, 2, 3]);
  });

  test("drops the oldest value when full", () => {
    const buffer = new RingBuffer<string>(2);
    buffer.push("a");
    buffer.push("b");
    buffer.push("c");
    expect(buffer.toArray()).toEqual(["b", "c"]);
  });

  test("clears values", () => {
    const buffer = new RingBuffer<number>(2);
    buffer.push(1);
    buffer.clear();
    expect(buffer.size).toBe(0);
    expect(buffer.toArray()).toEqual([]);
  });
});
