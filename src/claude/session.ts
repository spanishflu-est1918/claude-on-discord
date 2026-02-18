import type { Repository } from "../db/repository";
import type { ChannelRecord, SessionTurn } from "../types";

export interface SessionManagerOptions {
  defaultWorkingDir: string;
  defaultModel: string;
  maxHistoryItems?: number;
  maxTurnChars?: number;
}

export interface ChannelSessionState {
  channel: ChannelRecord;
  history: SessionTurn[];
}

export class SessionManager {
  private readonly maxHistoryItems: number;
  private readonly maxTurnChars: number;

  constructor(
    private readonly repository: Repository,
    private readonly options: SessionManagerOptions,
  ) {
    this.maxHistoryItems = options.maxHistoryItems ?? 40;
    this.maxTurnChars = options.maxTurnChars ?? 6000;
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
      history: this.repository.listSessionTurns(channelId, this.maxHistoryItems),
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
    const boundedContent =
      turn.content.length <= this.maxTurnChars
        ? turn.content
        : `${turn.content.slice(0, Math.max(0, this.maxTurnChars - 3))}...`;
    const value: SessionTurn = {
      ...turn,
      content: boundedContent,
      timestamp: Date.now(),
    };
    this.repository.addSessionTurn({
      channelId,
      role: value.role,
      content: value.content,
      timestamp: value.timestamp,
    });
    this.repository.trimSessionTurns(channelId, this.maxHistoryItems);
    return value;
  }

  getHistory(channelId: string): SessionTurn[] {
    return this.repository.listSessionTurns(channelId, this.maxHistoryItems);
  }

  switchProject(
    channelId: string,
    guildId: string,
    workingDir: string,
    opts: { fresh?: boolean } = {},
  ): ChannelSessionState {
    const existing = this.ensureChannel(channelId, guildId);
    const projectChanged = existing.workingDir !== workingDir;

    this.repository.setChannelWorkingDir(channelId, workingDir);
    if (opts.fresh) {
      this.repository.setChannelSession(channelId, null);
      this.repository.clearSessionTurns(channelId);
    } else if (projectChanged) {
      // Session IDs are project-scoped in practice; avoid stale resume errors after switching dirs.
      this.repository.setChannelSession(channelId, null);
    }
    return this.getState(channelId, guildId);
  }

  resetSession(channelId: string): void {
    this.repository.setChannelSession(channelId, null);
    this.repository.clearSessionTurns(channelId);
  }

  cloneChannelContext(
    sourceChannelId: string,
    targetChannelId: string,
    targetGuildId: string,
  ): ChannelSessionState {
    const source = this.repository.getChannel(sourceChannelId);
    if (!source) {
      throw new Error(`Source channel not found: ${sourceChannelId}`);
    }

    this.repository.upsertChannel({
      channelId: targetChannelId,
      guildId: targetGuildId,
      workingDir: source.workingDir,
      model: source.model,
      sessionId: null,
    });

    this.repository.cloneSessionTurns(sourceChannelId, targetChannelId, this.maxHistoryItems);

    return this.getState(targetChannelId, targetGuildId);
  }
}
