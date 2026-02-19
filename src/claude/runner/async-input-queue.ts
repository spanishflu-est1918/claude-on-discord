export class AsyncInputQueue<T> implements AsyncIterable<T> {
  private values: T[] = [];
  private waiters: Array<{
    resolve: (result: IteratorResult<T>) => void;
    reject: (error: unknown) => void;
  }> = [];
  private ended = false;
  private endedError: Error | null = null;

  enqueue(value: T): void {
    if (this.ended) {
      return;
    }
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter.resolve({ done: false, value });
      return;
    }
    this.values.push(value);
  }

  end(): void {
    if (this.ended) {
      return;
    }
    this.ended = true;
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift();
      waiter?.resolve({ done: true, value: undefined as T });
    }
  }

  fail(error: Error): void {
    if (this.ended) {
      return;
    }
    this.ended = true;
    this.endedError = error;
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift();
      waiter?.reject(error);
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: async (): Promise<IteratorResult<T>> => {
        if (this.values.length > 0) {
          const value = this.values.shift();
          if (typeof value === "undefined") {
            return { done: true, value: undefined };
          }
          return { done: false, value };
        }
        if (this.ended) {
          if (this.endedError) {
            throw this.endedError;
          }
          return { done: true, value: undefined };
        }
        return await new Promise<IteratorResult<T>>((resolve, reject) => {
          this.waiters.push({ resolve, reject });
        });
      },
      return: async (): Promise<IteratorResult<T>> => {
        this.end();
        return { done: true, value: undefined };
      },
    };
  }
}
