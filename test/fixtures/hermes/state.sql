-- Minimal stand-in for Hermes Agent's state.db: only the columns hermes-sessions.py selects.
-- build/check-sources.js loads this into a temp SQLite file with Python's stdlib sqlite3 and runs
-- the real reader script against it. Epoch seconds, as Hermes stores them.
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  source TEXT,
  title TEXT,
  display_name TEXT,
  model TEXT,
  cwd TEXT,
  git_branch TEXT,
  git_repo_root TEXT,
  started_at REAL,
  ended_at REAL,
  end_reason TEXT,
  message_count INTEGER,
  tool_call_count INTEGER,
  pinned INTEGER DEFAULT 0,
  archived INTEGER DEFAULT 0
);
CREATE TABLE messages (
  id INTEGER PRIMARY KEY,
  session_id TEXT,
  timestamp REAL
);
INSERT INTO sessions VALUES ('20250911_090000_bbbbbb', 'cli', 'newest chat', NULL, 'm1', '/work/alpha', 'main', '/work/alpha', 1757566800.0, NULL, NULL, 2, 1, 0, 0);
INSERT INTO sessions VALUES ('20250911_080000_aaaaaa', 'desktop', NULL, 'older chat', 'm2', NULL, NULL, NULL, 1757563200.0, 1757566000.0, 'user', 1, 0, 1, 0);
INSERT INTO sessions VALUES ('20250911_070000_zzzzzz', 'cli', 'archived chat', NULL, 'm1', '/work/gone', NULL, NULL, 1757559600.0, NULL, NULL, 1, 0, 0, 1);
INSERT INTO messages VALUES (1, '20250911_090000_bbbbbb', 1757566900.0);
INSERT INTO messages VALUES (2, '20250911_090000_bbbbbb', 1757569800.5);
INSERT INTO messages VALUES (3, '20250911_080000_aaaaaa', 1757565000.0);
INSERT INTO messages VALUES (4, '20250911_070000_zzzzzz', 1757570000.0);
