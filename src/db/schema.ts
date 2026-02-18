import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";

export const SCHEMA_STATEMENTS = [
  `
  CREATE TABLE IF NOT EXISTS channels (
    channel_id TEXT PRIMARY KEY,
    guild_id TEXT NOT NULL,
    working_dir TEXT NOT NULL,
    session_id TEXT,
    model TEXT NOT NULL DEFAULT 'sonnet',
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
  );
  `,
  `
  CREATE TABLE IF NOT EXISTS session_costs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    cost_usd REAL NOT NULL DEFAULT 0,
    duration_ms INTEGER NOT NULL DEFAULT 0,
    model TEXT NOT NULL,
    turn_count INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  );
  `,
  `
  CREATE TABLE IF NOT EXISTS session_turns (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_id TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
    content TEXT NOT NULL,
    timestamp_ms INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
  );
  `,
  `
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
  );
  `,
  "CREATE INDEX IF NOT EXISTS idx_session_costs_session_id ON session_costs(session_id);",
  "CREATE INDEX IF NOT EXISTS idx_session_costs_channel_id ON session_costs(channel_id);",
  "CREATE INDEX IF NOT EXISTS idx_session_turns_channel_id_id ON session_turns(channel_id, id);",
] as const;

export function applySchema(database: Database): void {
  database.exec("PRAGMA journal_mode = WAL;");
  database.exec("PRAGMA foreign_keys = ON;");
  for (const statement of SCHEMA_STATEMENTS) {
    database.exec(statement);
  }
}

export function openDatabase(dbPath: string): Database {
  const absolute = path.resolve(dbPath);
  mkdirSync(path.dirname(absolute), { recursive: true });
  const database = new Database(absolute, { create: true, strict: true });
  applySchema(database);
  return database;
}
