import type { Database } from "bun:sqlite";
import type { ChannelRecord, SessionCostInsert } from "../types";
import { applySchema } from "./schema";

type ChannelRow = {
  channel_id: string;
  guild_id: string;
  working_dir: string;
  session_id: string | null;
  model: string;
  created_at: number;
  updated_at: number;
};

type SettingRow = {
  key: string;
  value: string;
  updated_at: number;
};

export type UpsertChannelInput = {
  channelId: string;
  guildId: string;
  workingDir: string;
  model?: string;
  sessionId?: string | null;
};

const CHANNEL_SYSTEM_PROMPT_PREFIX = "channel_system_prompt:";

function channelSystemPromptKey(channelId: string): string {
  return `${CHANNEL_SYSTEM_PROMPT_PREFIX}${channelId}`;
}

function mapChannelRow(row: ChannelRow): ChannelRecord {
  return {
    channelId: row.channel_id,
    guildId: row.guild_id,
    workingDir: row.working_dir,
    sessionId: row.session_id,
    model: row.model,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
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
}
