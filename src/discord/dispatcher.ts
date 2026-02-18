export type DiscordRateLimitEvent = {
  laneId: string;
  attempt: number;
  retryAfterMs: number;
  message?: string;
};

export interface DiscordDispatchQueueOptions {
  maxAttempts?: number;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  onRateLimit?: (event: DiscordRateLimitEvent) => void;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readNumeric(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readRetryAfterSeconds(error: unknown): number | null {
  if (!error || typeof error !== "object") {
    return null;
  }
  const direct = readNumeric((error as { retry_after?: unknown }).retry_after);
  if (direct !== null) {
    return direct;
  }
  const rawError = (error as { rawError?: unknown }).rawError;
  if (rawError && typeof rawError === "object") {
    const nested = readNumeric((rawError as { retry_after?: unknown }).retry_after);
    if (nested !== null) {
      return nested;
    }
  }
  return null;
}

function readStatusCode(error: unknown): number | null {
  if (!error || typeof error !== "object") {
    return null;
  }
  return readNumeric((error as { status?: unknown }).status);
}

function computeBackoffMs(attempt: number, baseBackoffMs: number, maxBackoffMs: number): number {
  const exponent = Math.max(0, attempt - 1);
  const backoff = baseBackoffMs * 2 ** exponent;
  return Math.min(maxBackoffMs, Math.max(baseBackoffMs, Math.round(backoff)));
}

function readRateLimitDelayMs(error: unknown): number | null {
  const retryAfterSeconds = readRetryAfterSeconds(error);
  if (retryAfterSeconds === null) {
    return null;
  }
  return Math.max(1, Math.round(retryAfterSeconds * 1000));
}

export class DiscordDispatchQueue {
  private readonly lanes = new Map<string, Promise<void>>();
  private readonly maxAttempts: number;
  private readonly baseBackoffMs: number;
  private readonly maxBackoffMs: number;

  constructor(private readonly options: DiscordDispatchQueueOptions = {}) {
    this.maxAttempts = Math.max(1, options.maxAttempts ?? 3);
    this.baseBackoffMs = Math.max(1, options.baseBackoffMs ?? 250);
    this.maxBackoffMs = Math.max(this.baseBackoffMs, options.maxBackoffMs ?? 4000);
  }

  enqueue<T>(laneId: string, task: () => Promise<T>): Promise<T> {
    let resolveResult: (value: T | PromiseLike<T>) => void = () => {};
    let rejectResult: (reason?: unknown) => void = () => {};
    const result = new Promise<T>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });

    const previous = this.lanes.get(laneId) ?? Promise.resolve();
    const lane = previous
      .catch(() => {
        // Keep lane progression alive even when a previous operation failed.
      })
      .then(async () => {
        try {
          const value = await this.executeWithRetry(laneId, task);
          resolveResult(value);
        } catch (error) {
          rejectResult(error);
        }
      });

    this.lanes.set(laneId, lane);
    void lane.finally(() => {
      if (this.lanes.get(laneId) === lane) {
        this.lanes.delete(laneId);
      }
    });

    return result;
  }

  private async executeWithRetry<T>(laneId: string, task: () => Promise<T>): Promise<T> {
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      try {
        return await task();
      } catch (error) {
        const status = readStatusCode(error);
        const rateLimitDelayMs = readRateLimitDelayMs(error);
        const shouldRetryRateLimit =
          (status === 429 || rateLimitDelayMs !== null) && attempt < this.maxAttempts;
        const shouldRetryServerError =
          status !== null && status >= 500 && status < 600 && attempt < this.maxAttempts;

        if (!shouldRetryRateLimit && !shouldRetryServerError) {
          throw error;
        }

        const retryAfterMs =
          rateLimitDelayMs ?? computeBackoffMs(attempt, this.baseBackoffMs, this.maxBackoffMs);

        this.options.onRateLimit?.({
          laneId,
          attempt,
          retryAfterMs,
          message: error instanceof Error ? error.message : undefined,
        });
        await sleep(retryAfterMs);
      }
    }

    throw new Error("Dispatcher retries exhausted.");
  }
}
