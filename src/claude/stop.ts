import type { ClaudeQuery } from "../types";

export interface ActiveRun {
  query: ClaudeQuery;
  abortController: AbortController;
  startedAt: number;
  interrupted: boolean;
}

export class StopController {
  private readonly activeRuns = new Map<string, ActiveRun>();

  register(
    channelId: string,
    run: Omit<ActiveRun, "startedAt" | "interrupted"> & { startedAt?: number },
  ): ActiveRun {
    const value: ActiveRun = {
      ...run,
      startedAt: run.startedAt ?? Date.now(),
      interrupted: false,
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

  clearAll(): number {
    const size = this.activeRuns.size;
    this.activeRuns.clear();
    return size;
  }

  getActiveChannelIds(): string[] {
    return Array.from(this.activeRuns.keys());
  }

  wasInterrupted(channelId: string): boolean {
    const active = this.activeRuns.get(channelId);
    return active?.interrupted ?? false;
  }

  async interrupt(channelId: string): Promise<boolean> {
    const active = this.activeRuns.get(channelId);
    if (!active) {
      return false;
    }
    try {
      await active.query.interrupt();
      active.interrupted = true;
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
    try {
      active.query.close();
    } catch {
      // Ignore close failures and still abort the run controller.
    }
    active.abortController.abort();
    this.activeRuns.delete(channelId);
    return true;
  }

  abortAll(): string[] {
    const channelIds = Array.from(this.activeRuns.keys());
    for (const active of this.activeRuns.values()) {
      try {
        active.query.close();
      } catch {
        // Ignore close failures while shutting down.
      }
      active.abortController.abort();
    }
    this.activeRuns.clear();
    return channelIds;
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
