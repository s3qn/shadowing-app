"""The sqlite schema, run by store.init on every start."""

SCHEMA = """
CREATE TABLE IF NOT EXISTS islands (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL,
  stage       TEXT NOT NULL DEFAULT '',
  error       TEXT NOT NULL DEFAULT '',
  complexity  TEXT NOT NULL DEFAULT 'simple',
  register    TEXT NOT NULL DEFAULT 'polite',
  language    TEXT NOT NULL DEFAULT 'ja',
  native      TEXT NOT NULL DEFAULT 'en',
  source      TEXT NOT NULL DEFAULT 'voice',
  source_name TEXT NOT NULL DEFAULT '',
  speaker     INTEGER NOT NULL DEFAULT 3,
  transcript  TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS lines (
  island_id   TEXT NOT NULL,
  idx         INTEGER NOT NULL,
  ja          TEXT NOT NULL,
  kana        TEXT NOT NULL DEFAULT '',
  romaji      TEXT NOT NULL DEFAULT '',
  en          TEXT NOT NULL DEFAULT '',
  duration    REAL NOT NULL DEFAULT 0,
  timeline    TEXT NOT NULL DEFAULT '[]',
  words       TEXT NOT NULL DEFAULT '[]',
  offset      REAL NOT NULL DEFAULT 0,
  tatoeba_id  INTEGER,
  span        TEXT NOT NULL DEFAULT '',
  sure        INTEGER,
  PRIMARY KEY (island_id, idx),
  FOREIGN KEY (island_id) REFERENCES islands(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS word_context (
  word        TEXT NOT NULL,
  sentence    TEXT NOT NULL,
  context     TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  PRIMARY KEY (word, sentence)
);
CREATE TABLE IF NOT EXISTS explain_cache (
  sentence    TEXT NOT NULL,
  marked      TEXT NOT NULL,
  question    TEXT NOT NULL,
  answer      TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  PRIMARY KEY (sentence, marked, question)
);
CREATE TABLE IF NOT EXISTS say_cache (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  created_at  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS build_stats (
    kind TEXT NOT NULL,
    media_s REAL NOT NULL,
    work_s REAL NOT NULL,
    at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS builds (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  device      TEXT NOT NULL,
  kind        TEXT NOT NULL,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_builds_device_kind_created
  ON builds (device, kind, created_at);
CREATE INDEX IF NOT EXISTS idx_builds_created ON builds (created_at);
CREATE TABLE IF NOT EXISTS videos (
  island_id   TEXT PRIMARY KEY REFERENCES islands(id) ON DELETE CASCADE,
  video_id    TEXT NOT NULL,
  start_s     REAL NOT NULL DEFAULT 0,
  duration    REAL NOT NULL DEFAULT 0,
  title       TEXT NOT NULL DEFAULT '',
  author      TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL,
  align_status   TEXT NOT NULL DEFAULT '',
  align_error    TEXT NOT NULL DEFAULT '',
  align_attempts INTEGER NOT NULL DEFAULT 0,
  repair_status   TEXT NOT NULL DEFAULT '',
  repair_error    TEXT NOT NULL DEFAULT '',
  repair_attempts INTEGER NOT NULL DEFAULT 0,
  repair_version  INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS video_repairs (
  video_id    TEXT PRIMARY KEY,
  context     TEXT NOT NULL DEFAULT '{}',
  version     INTEGER NOT NULL DEFAULT 0,
  lines_hash  TEXT NOT NULL DEFAULT '',
  result      TEXT NOT NULL DEFAULT '',
  updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS take_scores (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  device     TEXT NOT NULL,
  island_id  TEXT NOT NULL,
  idx        INTEGER NOT NULL,
  language   TEXT NOT NULL DEFAULT 'ja',
  total      INTEGER,
  content    INTEGER,
  timing     INTEGER,
  pitch      INTEGER,
  speed      REAL NOT NULL DEFAULT 1,
  whole_line INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_take_scores_device_created ON take_scores(device, created_at);

CREATE TABLE IF NOT EXISTS known_lines (
  device     TEXT NOT NULL,
  island_id  TEXT NOT NULL,
  idx        INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (device, island_id, idx)
);

CREATE TABLE IF NOT EXISTS review_sessions (
  id                TEXT PRIMARY KEY,
  device            TEXT NOT NULL,
  size              INTEGER NOT NULL,
  planned_sentences INTEGER NOT NULL DEFAULT 0,
  planned_seconds   REAL NOT NULL DEFAULT 0,
  plan              TEXT NOT NULL DEFAULT '{}',
  started_at        TEXT NOT NULL,
  finished_at       TEXT NOT NULL DEFAULT '',
  actual_sentences  INTEGER NOT NULL DEFAULT 0,
  actual_seconds    REAL NOT NULL DEFAULT 0,
  avg_score         REAL,
  completed         INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS review_session_lines (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  device     TEXT NOT NULL,
  island_id  TEXT NOT NULL,
  idx        INTEGER NOT NULL,
  position   INTEGER NOT NULL,
  seconds    REAL NOT NULL DEFAULT 0,
  score      INTEGER
);
CREATE INDEX IF NOT EXISTS idx_review_session_lines_session ON review_session_lines(session_id);
CREATE INDEX IF NOT EXISTS idx_review_sessions_device ON review_sessions(device, started_at);
CREATE TABLE IF NOT EXISTS energy_ledger (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  device      TEXT NOT NULL,
  kind        TEXT NOT NULL,
  units       INTEGER NOT NULL,
  from_grant  INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_energy_ledger_device_created ON energy_ledger(device, created_at);
CREATE INDEX IF NOT EXISTS idx_energy_ledger_created ON energy_ledger(created_at);
CREATE TABLE IF NOT EXISTS energy_warned (
  day TEXT PRIMARY KEY
);
CREATE TABLE IF NOT EXISTS energy_grants (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  target_device   TEXT NOT NULL,
  target_username TEXT NOT NULL,
  amount          INTEGER NOT NULL,
  note            TEXT NOT NULL DEFAULT '',
  granted_by      TEXT NOT NULL,
  created_at      TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS llm_calls (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  tag           TEXT NOT NULL,
  model         TEXT NOT NULL,
  input_tokens  INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  usd           REAL NOT NULL DEFAULT 0,
  ok            INTEGER NOT NULL DEFAULT 1,
  ref           TEXT NOT NULL DEFAULT '',
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_llm_calls_created ON llm_calls(created_at);
CREATE TABLE IF NOT EXISTS client_ops (
  owner      TEXT NOT NULL,
  op         TEXT NOT NULL,
  reply      TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  PRIMARY KEY (owner, op)
);
CREATE INDEX IF NOT EXISTS idx_client_ops_created ON client_ops(created_at);
"""
