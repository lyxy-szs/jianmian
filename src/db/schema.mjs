/**
 * 数据库结构定义与版本迁移。
 * 使用 SQLite `PRAGMA user_version` 记录 schema 版本；每次升级只追加迁移。
 */

export const DEFAULT_GROUPS = Object.freeze([
  { key: 'highlight', name: '亮点', isSystem: 0 },
  { key: 'concern', name: '疑虑', isSystem: 0 },
  { key: 'verify', name: '待验证', isSystem: 0 },
  { key: 'uncategorized', name: '未分类', isSystem: 1 },
]);

const V1 = `
CREATE TABLE interviews (
  id TEXT PRIMARY KEY,
  candidate_name TEXT NOT NULL,
  position TEXT NOT NULL,
  internal_brief TEXT NOT NULL DEFAULT '',
  internal_focus TEXT NOT NULL DEFAULT '',
  public_brief TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','evaluating','completed')),
  revision INTEGER NOT NULL DEFAULT 1,
  round INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE TABLE participants (
  id TEXT PRIMARY KEY,
  interview_id TEXT NOT NULL REFERENCES interviews(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('lead','co','candidate')),
  name TEXT,
  claimed_at TEXT,
  generation INTEGER NOT NULL DEFAULT 0,
  ready INTEGER NOT NULL DEFAULT 0,
  ready_at TEXT,
  revoked_at TEXT,
  UNIQUE (interview_id, role)
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  participant_id TEXT NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  interview_id TEXT NOT NULL REFERENCES interviews(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  generation INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE INDEX idx_sessions_participant ON sessions(participant_id);

CREATE TABLE invitations (
  id TEXT PRIMARY KEY,
  interview_id TEXT NOT NULL REFERENCES interviews(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('lead','co','candidate')),
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  revoked_at TEXT
);
CREATE INDEX idx_invitations_interview ON invitations(interview_id, role);

CREATE TABLE join_requests (
  id TEXT PRIMARY KEY,
  interview_id TEXT NOT NULL REFERENCES interviews(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  invitation_id TEXT,
  participant_id TEXT,
  generation INTEGER,
  session_issued_at TEXT,
  created_at TEXT NOT NULL,
  decided_at TEXT
);
CREATE INDEX idx_join_requests_interview ON join_requests(interview_id, status);

CREATE TABLE groups (
  id TEXT PRIMARY KEY,
  interview_id TEXT NOT NULL REFERENCES interviews(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_system INTEGER NOT NULL DEFAULT 0,
  deleted_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_groups_interview ON groups(interview_id);

CREATE TABLE notes (
  id TEXT PRIMARY KEY,
  interview_id TEXT NOT NULL REFERENCES interviews(id) ON DELETE CASCADE,
  round INTEGER NOT NULL,
  author_id TEXT NOT NULL,
  author_name TEXT NOT NULL,
  body TEXT NOT NULL,
  group_id TEXT NOT NULL,
  sort_order REAL NOT NULL DEFAULT 0,
  important INTEGER NOT NULL DEFAULT 0,
  needs_discussion INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 1,
  deleted_at TEXT,
  deleted_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_moved_by TEXT,
  last_moved_at TEXT
);
CREATE INDEX idx_notes_interview ON notes(interview_id, group_id);

CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  interview_id TEXT NOT NULL REFERENCES interviews(id) ON DELETE CASCADE,
  round INTEGER NOT NULL,
  author_id TEXT NOT NULL,
  author_name TEXT NOT NULL,
  body TEXT NOT NULL,
  reply_to TEXT,
  reply_excerpt TEXT,
  note_id TEXT,
  note_excerpt TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_messages_interview ON messages(interview_id, created_at);

CREATE TABLE evaluations (
  id TEXT PRIMARY KEY,
  interview_id TEXT NOT NULL REFERENCES interviews(id) ON DELETE CASCADE,
  round INTEGER NOT NULL,
  evaluator_id TEXT NOT NULL,
  evaluator_name TEXT NOT NULL DEFAULT '',
  level TEXT CHECK (level IS NULL OR level IN ('strong_yes','yes','hold','no')),
  reason TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','submitted')),
  version INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL,
  submitted_at TEXT,
  UNIQUE (interview_id, round, evaluator_id)
);

CREATE TABLE decisions (
  id TEXT PRIMARY KEY,
  interview_id TEXT NOT NULL REFERENCES interviews(id) ON DELETE CASCADE,
  round INTEGER NOT NULL,
  final_level TEXT NOT NULL CHECK (final_level IN ('strong_yes','yes','hold','no')),
  reason TEXT NOT NULL,
  divergence_note TEXT NOT NULL DEFAULT '',
  decided_by TEXT NOT NULL,
  decided_by_name TEXT NOT NULL,
  decided_at TEXT NOT NULL,
  report_snapshot TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  UNIQUE (interview_id, round)
);

CREATE TABLE events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  interview_id TEXT NOT NULL REFERENCES interviews(id) ON DELETE CASCADE,
  scope TEXT NOT NULL CHECK (scope IN ('internal','candidate')),
  type TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX idx_events_interview ON events(interview_id, seq);

CREATE TABLE applied_operations (
  participant_id TEXT NOT NULL,
  op_id TEXT NOT NULL,
  result TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (participant_id, op_id)
);
`;

const V2 = `
ALTER TABLE notes ADD COLUMN author_generation INTEGER NOT NULL DEFAULT 0;
ALTER TABLE messages ADD COLUMN author_generation INTEGER NOT NULL DEFAULT 0;
`;

export const MIGRATIONS = [V1, V2];

export const SCHEMA_VERSION = MIGRATIONS.length;
