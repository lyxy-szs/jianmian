import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { MIGRATIONS, SCHEMA_VERSION } from './schema.mjs';

export { SCHEMA_VERSION };

export const nowIso = () => new Date().toISOString();
export const newId = () => crypto.randomUUID();
export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
export const sha256 = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');
export const plain = (row) => (row == null ? null : { ...row });
export const plainAll = (rows) => rows.map((row) => ({ ...row }));

export function openDatabase(dbPath) {
  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA busy_timeout = 5000;');
  if (dbPath !== ':memory:') db.exec('PRAGMA journal_mode = WAL;');
  migrate(db);
  return db;
}

export function migrate(db) {
  const current = Number(db.prepare('PRAGMA user_version').get().user_version ?? 0);
  if (current > SCHEMA_VERSION) {
    throw new Error(`数据库版本（${current}）高于当前程序支持的版本（${SCHEMA_VERSION}），请升级程序后再打开。`);
  }
  for (let index = current; index < MIGRATIONS.length; index += 1) {
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(MIGRATIONS[index]);
      db.exec(`PRAGMA user_version = ${index + 1}`);
      db.exec('COMMIT');
    } catch (error) {
      try {
        db.exec('ROLLBACK');
      } catch {
        /* 回滚失败时保留原始错误 */
      }
      throw error;
    }
  }
}

/** 在单个写事务中执行；异常自动回滚。 */
export function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const value = fn();
    db.exec('COMMIT');
    return value;
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* ignore */
    }
    throw error;
  }
}

export function appendEvent(db, { interviewId, scope, type, payload = {}, at = nowIso() }) {
  const result = db
    .prepare('INSERT INTO events (interview_id, scope, type, payload, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(interviewId, scope, type, JSON.stringify(payload), at);
  return { seq: Number(result.lastInsertRowid), interviewId, scope, type, payload, at };
}

export function touchInterview(db, interviewId, { status, at = nowIso() } = {}) {
  if (status) {
    db.prepare('UPDATE interviews SET status = ?, revision = revision + 1, updated_at = ? WHERE id = ?').run(
      status,
      at,
      interviewId,
    );
  } else {
    db.prepare('UPDATE interviews SET revision = revision + 1, updated_at = ? WHERE id = ?').run(at, interviewId);
  }
}

export function eventRowToMessage(row) {
  return {
    seq: row.seq,
    type: row.type,
    scope: row.scope,
    payload: safeParse(row.payload),
    at: row.created_at,
  };
}

export function safeParse(raw, fallback = {}) {
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}
