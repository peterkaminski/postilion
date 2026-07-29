-- Postilion initial schema.
-- Lifecycle status values: 'active' | 'paused' | 'trashed'.
-- Times are ISO 8601 UTC strings (D1/SQLite datetime('now')).

CREATE TABLE principals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  trashed_at TEXT
);

CREATE TABLE passcodes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  used_by INTEGER REFERENCES principals(id),
  used_at TEXT,
  revoked_at TEXT
);

CREATE TABLE addresses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  principal_id INTEGER NOT NULL REFERENCES principals(id),
  agent_slug TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  sent_count INTEGER NOT NULL DEFAULT 0,
  received_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  trashed_at TEXT,
  UNIQUE (principal_id, agent_slug)
);
CREATE INDEX idx_addresses_token ON addresses (token_hash);

-- One row per mailbox view of a message: an internal delivery writes an 'out'
-- row for the sender and an 'in' row for the recipient; an external inbound
-- writes only the recipient's 'in' row. body is the full IFP-4 JSON.
CREATE TABLE messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  address_id INTEGER NOT NULL REFERENCES addresses(id),
  direction TEXT NOT NULL, -- 'in' | 'out'
  peer TEXT NOT NULL,
  ifp_message_id TEXT,
  subject TEXT,
  size INTEGER NOT NULL,
  status TEXT NOT NULL, -- 'delivered' | 'received'
  body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_messages_addr ON messages (address_id, id);
CREATE INDEX idx_messages_created ON messages (created_at);

-- Pending magic-link/PIN challenges (login and signup share the table; signup
-- rows carry the passcode + chosen slug so the principal is created only after
-- the email round-trip proves address ownership).
CREATE TABLE logins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  pin_hash TEXT NOT NULL,
  purpose TEXT NOT NULL, -- 'login' | 'signup'
  passcode_id INTEGER REFERENCES passcodes(id),
  principal_slug TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token_hash TEXT NOT NULL UNIQUE,
  principal_id INTEGER NOT NULL REFERENCES principals(id),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Admin-set overrides for quota defaults (keys: server_daily_quota,
-- principal_daily_quota).
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Daily send counters, UTC day key. scope is 'server' or 'p:<principal id>'.
CREATE TABLE quota_days (
  day TEXT NOT NULL,
  scope TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, scope)
);
