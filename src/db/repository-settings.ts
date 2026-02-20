import type { Database } from "bun:sqlite";
import {
  GLOBAL_SYSTEM_PROMPT_KEY,
  channelMentionsModeKey,
  channelMergeContextKey,
  channelPermissionModeKey,
  channelSystemPromptKey,
  channelThreadBranchKey,
  threadBranchChannelIdFromKey,
  threadBranchKeyPattern,
  type SettingRow,
} from "./repository-helpers";

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

export class RepositorySettingsStore {
  constructor(private readonly database: Database) {}

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
