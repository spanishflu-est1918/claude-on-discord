import type { Repository } from "../db/repository";
import type { ChannelRecord } from "../types";
import { RingBuffer } from "./ring-buffer";

export interface SessionTurn {
  role: "user" | "assistant";
  content: string;
  timestamp: number;
}

export interface SessionManagerOptions {
  defaultWorkingDir: string;
  defaultModel: string;
  maxHistoryItems?: number;
}

export interface ChannelSessionState {
  channel: ChannelRecord;
  history: SessionTurn[];
}

export class SessionManager {
  private readonly historyByChannel = new Map<string, RingBuffer<SessionTurn>>();
  private readonly maxHistoryItems: number;

  constructor(
    private readonly repository: Repository,
    private readonly options: SessionManagerOptions,
  ) {
    this.maxHistoryItems = options.maxHistoryItems ?? 40;
  }

  ensureChannel(channelId: string, guildId: string): ChannelRecord {
    const existing = this.repository.getChannel(channelId);
    if (existing) {
      return existing;
    }
    return this.repository.upsertChannel({
      channelId,
      guildId,
      workingDir: this.options.defaultWorkingDir,
      model: this.options.defaultModel,
      sessionId: null,
    });
  }

  getState(channelId: string, guildId: string): ChannelSessionState {
    const channel = this.ensureChannel(channelId, guildId);
    return {
      channel,
      history: this.getHistoryBuffer(channelId).toArray(),
    };
  }

  setSessionId(channelId: string, sessionId: string | null): void {
    this.repository.setChannelSession(channelId, sessionId);
  }

  setModel(channelId: string, model: string): void {
    this.repository.setChannelModel(channelId, model);
  }

  setWorkingDir(channelId: string, workingDir: string): void {
    this.repository.setChannelWorkingDir(channelId, workingDir);
  }

  appendTurn(channelId: string, turn: Omit<SessionTurn, "timestamp">): SessionTurn {
    const value: SessionTurn = {
      ...turn,
      timestamp: Date.now(),
    };
    this.getHistoryBuffer(channelId).push(value);
    return value;
  }

  getHistory(channelId: string): SessionTurn[] {
    return this.getHistoryBuffer(channelId).toArray();
  }

  switchProject(
    channelId: string,
    guildId: string,
    workingDir: string,
    opts: { fresh?: boolean } = {},
  ): ChannelSessionState {
    this.ensureChannel(channelId, guildId);
    this.repository.setChannelWorkingDir(channelId, workingDir);
    if (opts.fresh) {
      this.repository.setChannelSession(channelId, null);
      this.getHistoryBuffer(channelId).clear();
    }
    return this.getState(channelId, guildId);
  }

  resetSession(channelId: string): void {
    this.repository.setChannelSession(channelId, null);
    this.getHistoryBuffer(channelId).clear();
  }

  private getHistoryBuffer(channelId: string): RingBuffer<SessionTurn> {
    const existing = this.historyByChannel.get(channelId);
    if (existing) {
      return existing;
    }
    const created = new RingBuffer<SessionTurn>(this.maxHistoryItems);
    this.historyByChannel.set(channelId, created);
    return created;
  }
}
