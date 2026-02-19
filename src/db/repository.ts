import type { Database } from "bun:sqlite";
import type { ChannelRecord, SessionCostInsert, SessionTurn } from "../types";
import {
  GLOBAL_SYSTEM_PROMPT_KEY,
  channelMentionsModeKey,
  channelMergeContextKey,
  channelPermissionModeKey,
  channelSystemPromptKey,
  channelThreadBranchKey,
  mapChannelRow,
  mapSessionTurnRow,
  threadBranchChannelIdFromKey,
  threadBranchKeyPattern,
  type ChannelRow,
  type SessionTurnRow,
  type SettingRow,
} from "./repository-helpers";
import { applySchema } from "./schema";

export type UpsertChannelInput = {
  channelId: string;
  guildId: string;
  workingDir: string;
  model?: string;
  sessionId?: string | null;
};

export type ChannelMentionsMode = "default" | "required" | "off";
export type ChannelPermissionMode =
  | "default"
  | "plan"
  | "acceptEdits"
  | "bypassPermissions"
  | "delegate"
  | "dontAsk";

export interface MergeContextRecord {
  fromChannelId: string;
  fromChannelName: string;
  summary: string;
  mergedAt: number;
}

export class Repository {
  constructor(private readonly database: Database) {
    applySchema(this.database);
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
    const row = this.database
      .query<SettingRow, { key: string }>("SELECT * FROM settings WHERE key = $key;")
      .get({ key: key });
    return row?.value ?? null;
  }

  setSetting(key: string, value: string): void {
    this.database
      .query(
        `
        INSERT INTO settings (key, value)
        VALUES ($key, $value)
        ON CONFLICT(key) DO UPDATE SET
          value = excluded.value,
          updated_at = unixepoch();
        `,
      )
      .run({ key: key, value: value });
  }

  deleteSetting(key: string): void {
    this.database.query("DELETE FROM settings WHERE key = $key;").run({ key });
  }

  getChannelSystemPrompt(channelId: string): string | null {
    return this.getSetting(channelSystemPromptKey(channelId));
  }

  setChannelSystemPrompt(channelId: string, prompt: string): void {
    this.setSetting(channelSystemPromptKey(channelId), prompt);
  }

  clearChannelSystemPrompt(channelId: string): void {
    this.deleteSetting(channelSystemPromptKey(channelId));
  }

  getGlobalSystemPrompt(): string | null {
    return this.getSetting(GLOBAL_SYSTEM_PROMPT_KEY);
  }

  setGlobalSystemPrompt(prompt: string): void {
    this.setSetting(GLOBAL_SYSTEM_PROMPT_KEY, prompt);
  }

  clearGlobalSystemPrompt(): void {
    this.deleteSetting(GLOBAL_SYSTEM_PROMPT_KEY);
  }

  getThreadBranchMeta(channelId: string): string | null {
    return this.getSetting(channelThreadBranchKey(channelId));
  }

  setThreadBranchMeta(channelId: string, metaJson: string): void {
    this.setSetting(channelThreadBranchKey(channelId), metaJson);
  }

  clearThreadBranchMeta(channelId: string): void {
    this.deleteSetting(channelThreadBranchKey(channelId));
  }

  getChannelMentionsMode(channelId: string): ChannelMentionsMode | null {
    const raw = this.getSetting(channelMentionsModeKey(channelId));
    if (raw === "default" || raw === "required" || raw === "off") {
      return raw;
    }
    return null;
  }

  setChannelMentionsMode(channelId: string, mode: ChannelMentionsMode): void {
    this.setSetting(channelMentionsModeKey(channelId), mode);
  }

  clearChannelMentionsMode(channelId: string): void {
    this.deleteSetting(channelMentionsModeKey(channelId));
  }

  getChannelPermissionMode(channelId: string): ChannelPermissionMode | null {
    const raw = this.getSetting(channelPermissionModeKey(channelId));
    if (
      raw === "default" ||
      raw === "plan" ||
      raw === "acceptEdits" ||
      raw === "bypassPermissions" ||
      raw === "delegate" ||
      raw === "dontAsk"
    ) {
      return raw;
    }
    return null;
  }

  setChannelPermissionMode(channelId: string, mode: ChannelPermissionMode): void {
    this.setSetting(channelPermissionModeKey(channelId), mode);
  }

  clearChannelPermissionMode(channelId: string): void {
    this.deleteSetting(channelPermissionModeKey(channelId));
  }

  getMergeContext(channelId: string): MergeContextRecord | null {
    const raw = this.getSetting(channelMergeContextKey(channelId));
    if (!raw) {
      return null;
    }
    try {
      return JSON.parse(raw) as MergeContextRecord;
    } catch {
      return null;
    }
  }

  setMergeContext(channelId: string, context: MergeContextRecord): void {
    this.setSetting(channelMergeContextKey(channelId), JSON.stringify(context));
  }

  clearMergeContext(channelId: string): void {
    this.deleteSetting(channelMergeContextKey(channelId));
  }

  listThreadBranchMetaEntries(): Array<{ channelId: string; value: string }> {
    const rows = this.database
      .query<Pick<SettingRow, "key" | "value">, { pattern: string }>(
        `
        SELECT key, value
        FROM settings
        WHERE key LIKE $pattern;
        `,
      )
      .all({ pattern: threadBranchKeyPattern() });

    return rows
      .map((row) => {
        const channelId = threadBranchChannelIdFromKey(row.key);
        if (!channelId) {
          return null;
        }
        return { channelId, value: row.value };
      })
      .filter((entry): entry is { channelId: string; value: string } => entry !== null);
  }
}
