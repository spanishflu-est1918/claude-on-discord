import type { Database } from "bun:sqlite";
import type { ChannelRecord, SessionCostInsert, SessionTurn } from "../types";
import {
  mapChannelRow,
  mapSessionTurnRow,
  type ChannelRow,
  type SessionTurnRow,
} from "./repository-helpers";
import {
  RepositorySettingsStore,
  type ChannelMentionsMode,
  type ChannelPermissionMode,
  type MergeContextRecord,
} from "./repository-settings";
import { applySchema } from "./schema";

export type UpsertChannelInput = {
  channelId: string;
  guildId: string;
  workingDir: string;
  model?: string;
  sessionId?: string | null;
};

export type { ChannelMentionsMode, ChannelPermissionMode, MergeContextRecord };

export class Repository {
  private readonly settings: RepositorySettingsStore;

  constructor(private readonly database: Database) {
    applySchema(this.database);
    this.settings = new RepositorySettingsStore(this.database);
  }

  upsertChannel(input: UpsertChannelInput): ChannelRecord {
    const model = input.model ?? "sonnet";
    const sessionId = input.sessionId ?? null;

    this.database
      .query(
        `
        INSERT INTO channels (channel_id, guild_id, working_dir, session_id, model)
        VALUES ($channel_id, $guild_id, $working_dir, $session_id, $model)
        ON CONFLICT(channel_id) DO UPDATE SET
          guild_id = excluded.guild_id,
          working_dir = excluded.working_dir,
          session_id = excluded.session_id,
          model = excluded.model,
          updated_at = unixepoch();
        `,
      )
      .run({
        channel_id: input.channelId,
        guild_id: input.guildId,
        working_dir: input.workingDir,
        session_id: sessionId,
        model: model,
      });

    const channel = this.getChannel(input.channelId);
    if (!channel) {
      throw new Error(`Failed to upsert channel ${input.channelId}`);
    }
    return channel;
  }

  getChannel(channelId: string): ChannelRecord | null {
    const row = this.database
      .query<ChannelRow, { channel_id: string }>(
        "SELECT * FROM channels WHERE channel_id = $channel_id;",
      )
      .get({ channel_id: channelId });
    if (!row) {
      return null;
    }
    return mapChannelRow(row);
  }

  setChannelSession(channelId: string, sessionId: string | null): void {
    this.database
      .query(
        `
        UPDATE channels
        SET session_id = $session_id, updated_at = unixepoch()
        WHERE channel_id = $channel_id;
        `,
      )
      .run({ channel_id: channelId, session_id: sessionId });
  }

  setChannelWorkingDir(channelId: string, workingDir: string): void {
    this.database
      .query(
        `
        UPDATE channels
        SET working_dir = $working_dir, updated_at = unixepoch()
        WHERE channel_id = $channel_id;
        `,
      )
      .run({ channel_id: channelId, working_dir: workingDir });
  }

  setChannelModel(channelId: string, model: string): void {
    this.database
      .query(
        `
        UPDATE channels
        SET model = $model, updated_at = unixepoch()
        WHERE channel_id = $channel_id;
        `,
      )
      .run({ channel_id: channelId, model: model });
  }

  addSessionCost(input: SessionCostInsert): void {
    this.database
      .query(
        `
        INSERT INTO session_costs (session_id, channel_id, cost_usd, duration_ms, model, turn_count)
        VALUES ($session_id, $channel_id, $cost_usd, $duration_ms, $model, $turn_count);
        `,
      )
      .run({
        session_id: input.sessionId,
        channel_id: input.channelId,
        cost_usd: input.costUsd,
        duration_ms: input.durationMs,
        model: input.model,
        turn_count: input.turnCount,
      });
  }

  getSessionCostTotal(sessionId: string): number {
    const row = this.database
      .query<{ total: number }, { session_id: string }>(
        "SELECT COALESCE(SUM(cost_usd), 0) AS total FROM session_costs WHERE session_id = $session_id;",
      )
      .get({ session_id: sessionId });
    return row?.total ?? 0;
  }

  getChannelCostTotal(channelId: string): number {
    const row = this.database
      .query<{ total: number }, { channel_id: string }>(
        "SELECT COALESCE(SUM(cost_usd), 0) AS total FROM session_costs WHERE channel_id = $channel_id;",
      )
      .get({ channel_id: channelId });
    return row?.total ?? 0;
  }

  getChannelTurnCount(channelId: string): number {
    const row = this.database
      .query<{ total: number }, { channel_id: string }>(
        "SELECT COALESCE(SUM(turn_count), 0) AS total FROM session_costs WHERE channel_id = $channel_id;",
      )
      .get({ channel_id: channelId });
    return row?.total ?? 0;
  }

  addSessionTurn(input: {
    channelId: string;
    role: SessionTurn["role"];
    content: string;
    timestamp: number;
  }): void {
    this.database
      .query(
        `
        INSERT INTO session_turns (channel_id, role, content, timestamp_ms)
        VALUES ($channel_id, $role, $content, $timestamp_ms);
        `,
      )
      .run({
        channel_id: input.channelId,
        role: input.role,
        content: input.content,
        timestamp_ms: input.timestamp,
      });
  }

  listSessionTurns(channelId: string, limit?: number): SessionTurn[] {
    if (typeof limit === "number") {
      if (limit <= 0) {
        return [];
      }
      const rows = this.database
        .query<
          SessionTurnRow,
          {
            channel_id: string;
            limit: number;
          }
        >(
          `
          SELECT id, channel_id, role, content, timestamp_ms
          FROM session_turns
          WHERE channel_id = $channel_id
          ORDER BY id DESC
          LIMIT $limit;
          `,
        )
        .all({
          channel_id: channelId,
          limit,
        });
      return rows.reverse().map(mapSessionTurnRow);
    }

    const rows = this.database
      .query<SessionTurnRow, { channel_id: string }>(
        `
        SELECT id, channel_id, role, content, timestamp_ms
        FROM session_turns
        WHERE channel_id = $channel_id
        ORDER BY id ASC;
        `,
      )
      .all({ channel_id: channelId });
    return rows.map(mapSessionTurnRow);
  }

  trimSessionTurns(channelId: string, keepLast: number): void {
    if (keepLast <= 0) {
      this.clearSessionTurns(channelId);
      return;
    }
    this.database
      .query(
        `
        DELETE FROM session_turns
        WHERE channel_id = $channel_id
          AND id NOT IN (
            SELECT id
            FROM session_turns
            WHERE channel_id = $channel_id
            ORDER BY id DESC
            LIMIT $limit
          );
        `,
      )
      .run({
        channel_id: channelId,
        limit: keepLast,
      });
  }

  clearSessionTurns(channelId: string): void {
    this.database
      .query(
        `
        DELETE FROM session_turns
        WHERE channel_id = $channel_id;
        `,
      )
      .run({ channel_id: channelId });
  }

  cloneSessionTurns(sourceChannelId: string, targetChannelId: string, maxItems: number): void {
    this.clearSessionTurns(targetChannelId);
    const turns = this.listSessionTurns(sourceChannelId, maxItems);
    for (const turn of turns) {
      this.addSessionTurn({
        channelId: targetChannelId,
        role: turn.role,
        content: turn.content,
        timestamp: turn.timestamp,
      });
    }
  }

  getSetting(key: string): string | null {
    return this.settings.getSetting(key);
  }

  setSetting(key: string, value: string): void {
    this.settings.setSetting(key, value);
  }

  deleteSetting(key: string): void {
    this.settings.deleteSetting(key);
  }

  getChannelSystemPrompt(channelId: string): string | null {
    return this.settings.getChannelSystemPrompt(channelId);
  }

  setChannelSystemPrompt(channelId: string, prompt: string): void {
    this.settings.setChannelSystemPrompt(channelId, prompt);
  }

  clearChannelSystemPrompt(channelId: string): void {
    this.settings.clearChannelSystemPrompt(channelId);
  }

  getGlobalSystemPrompt(): string | null {
    return this.settings.getGlobalSystemPrompt();
  }

  setGlobalSystemPrompt(prompt: string): void {
    this.settings.setGlobalSystemPrompt(prompt);
  }

  clearGlobalSystemPrompt(): void {
    this.settings.clearGlobalSystemPrompt();
  }

  getThreadBranchMeta(channelId: string): string | null {
    return this.settings.getThreadBranchMeta(channelId);
  }

  setThreadBranchMeta(channelId: string, metaJson: string): void {
    this.settings.setThreadBranchMeta(channelId, metaJson);
  }

  clearThreadBranchMeta(channelId: string): void {
    this.settings.clearThreadBranchMeta(channelId);
  }

  getChannelMentionsMode(channelId: string): ChannelMentionsMode | null {
    return this.settings.getChannelMentionsMode(channelId);
  }

  setChannelMentionsMode(channelId: string, mode: ChannelMentionsMode): void {
    this.settings.setChannelMentionsMode(channelId, mode);
  }

  clearChannelMentionsMode(channelId: string): void {
    this.settings.clearChannelMentionsMode(channelId);
  }

  getChannelPermissionMode(channelId: string): ChannelPermissionMode | null {
    return this.settings.getChannelPermissionMode(channelId);
  }

  setChannelPermissionMode(channelId: string, mode: ChannelPermissionMode): void {
    this.settings.setChannelPermissionMode(channelId, mode);
  }

  clearChannelPermissionMode(channelId: string): void {
    this.settings.clearChannelPermissionMode(channelId);
  }

  getMergeContext(channelId: string): MergeContextRecord | null {
    return this.settings.getMergeContext(channelId);
  }

  setMergeContext(channelId: string, context: MergeContextRecord): void {
    this.settings.setMergeContext(channelId, context);
  }

  clearMergeContext(channelId: string): void {
    this.settings.clearMergeContext(channelId);
  }

  listThreadBranchMetaEntries(): Array<{ channelId: string; value: string }> {
    return this.settings.listThreadBranchMetaEntries();
  }
}
