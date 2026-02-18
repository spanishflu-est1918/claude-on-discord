import type { RingBufferSnapshot } from "../types";

export class RingBuffer<T> {
  private readonly values: T[] = [];

  constructor(public readonly maxSize: number) {
    if (!Number.isInteger(maxSize) || maxSize <= 0) {
      throw new Error(`RingBuffer maxSize must be a positive integer. Received: ${maxSize}`);
    }
  }

  get size(): number {
    return this.values.length;
  }

  get isFull(): boolean {
    return this.values.length === this.maxSize;
  }

  push(value: T): void {
    if (this.values.length === this.maxSize) {
      this.values.shift();
    }
    this.values.push(value);
  }

  clear(): void {
    this.values.length = 0;
  }

  toArray(): T[] {
    return [...this.values];
  }

  snapshot(): RingBufferSnapshot<T> {
    return {
      maxSize: this.maxSize,
      items: this.toArray(),
    };
  }
}
