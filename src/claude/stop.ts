import type { ClaudeQuery } from "../types";

export interface ActiveRun {
  query: ClaudeQuery;
  abortController: AbortController;
  startedAt: number;
}

export class StopController {
  private readonly activeRuns = new Map<string, ActiveRun>();

  register(
    channelId: string,
    run: Omit<ActiveRun, "startedAt"> & { startedAt?: number },
  ): ActiveRun {
    const value: ActiveRun = {
      ...run,
      startedAt: run.startedAt ?? Date.now(),
    };
    this.activeRuns.set(channelId, value);
    return value;
  }

  get(channelId: string): ActiveRun | null {
    return this.activeRuns.get(channelId) ?? null;
  }

  isActive(channelId: string): boolean {
    return this.activeRuns.has(channelId);
  }

  clear(channelId: string): void {
    this.activeRuns.delete(channelId);
  }

  async interrupt(channelId: string): Promise<boolean> {
    const active = this.activeRuns.get(channelId);
    if (!active) {
      return false;
    }
    try {
      await active.query.interrupt();
      return true;
    } catch {
      return false;
    }
  }

  abort(channelId: string): boolean {
    const active = this.activeRuns.get(channelId);
    if (!active) {
      return false;
    }
    active.abortController.abort();
    this.activeRuns.delete(channelId);
    return true;
  }

  async setModel(channelId: string, model?: string): Promise<boolean> {
    const active = this.activeRuns.get(channelId);
    if (!active) {
      return false;
    }
    try {
      await active.query.setModel(model);
      return true;
    } catch {
      return false;
    }
  }

  async stopTask(channelId: string, taskId: string): Promise<boolean> {
    const active = this.activeRuns.get(channelId);
    if (!active) {
      return false;
    }
    try {
      await active.query.stopTask(taskId);
      return true;
    } catch {
      return false;
    }
  }
}
