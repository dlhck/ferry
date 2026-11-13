-- The relay store, schema version 1 (design section 10.2).
-- Differences from the design text:
-- - github_installations.account_id can be null: the repository lookup does not give it.
-- - receipts.failures and receipts.retry_at: the count of failed injections and the time of
--   the next delivery.ready after a failure (design section 6.3, at most 3 for each receipt).

CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE owners (
  id TEXT PRIMARY KEY,
  github_user_id INTEGER NOT NULL UNIQUE,
  login TEXT NOT NULL,
  created_at TEXT NOT NULL,
  login_checked_at TEXT NOT NULL
);

CREATE TABLE devices (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES owners(id),
  name TEXT NOT NULL,
  platform TEXT NOT NULL CHECK (platform IN ('linux','darwin')),
  credential_sha256 BLOB NOT NULL UNIQUE,
  created_by_device_id TEXT REFERENCES devices(id),
  created_at TEXT NOT NULL,
  last_seen_at TEXT,
  revoked_at TEXT
);

CREATE TABLE github_installations (
  owner_login TEXT PRIMARY KEY COLLATE NOCASE,
  installation_id INTEGER NOT NULL,
  account_id INTEGER,
  checked_at TEXT NOT NULL
);

CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL CHECK (provider = 'github'),
  provider_repo_id INTEGER NOT NULL,
  full_name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (provider, provider_repo_id)
);

CREATE TABLE project_keys (
  key TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  seen_at TEXT NOT NULL
);

CREATE TABLE access_grants (
  owner_id TEXT NOT NULL REFERENCES owners(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  permission TEXT NOT NULL CHECK (permission IN ('admin','write','read','none')),
  role_name TEXT,
  state TEXT NOT NULL CHECK (state IN ('granted','lost','unverifiable')),
  last_success_at TEXT,
  last_attempt_at TEXT NOT NULL,
  last_error TEXT,
  PRIMARY KEY (owner_id, project_id)
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  address TEXT NOT NULL UNIQUE,
  owner_id TEXT NOT NULL REFERENCES owners(id),
  device_id TEXT NOT NULL REFERENCES devices(id),
  runtime TEXT NOT NULL CHECK (runtime IN ('claude','codex')),
  runtime_session_id TEXT NOT NULL,
  runtime_version TEXT NOT NULL,
  adapter TEXT NOT NULL CHECK (adapter IN ('supported','untested','unconfirmed','unsupported')),
  project_id TEXT REFERENCES projects(id),
  branch TEXT, head TEXT, worktree TEXT, task TEXT,
  state TEXT NOT NULL CHECK (state IN ('live','offline','unknown','retired')),
  activity TEXT CHECK (activity IN ('idle','busy','awaiting-approval')),
  registered_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  ended_at TEXT,
  ended_reason TEXT,
  UNIQUE (owner_id, runtime, runtime_session_id)
);
CREATE INDEX sessions_project ON sessions (project_id, state);
CREATE INDEX sessions_device ON sessions (device_id, state);

CREATE TABLE conversations (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  slug TEXT NOT NULL,
  name TEXT NOT NULL,
  purpose TEXT NOT NULL,
  auto_join TEXT NOT NULL DEFAULT 'none' CHECK (auto_join IN ('none','all')),
  created_by_session_id TEXT NOT NULL REFERENCES sessions(id),
  created_at TEXT NOT NULL,
  next_seq INTEGER NOT NULL DEFAULT 1,
  UNIQUE (project_id, slug)
);

CREATE TABLE conversation_links (
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  kind TEXT NOT NULL CHECK (kind IN ('issue','branch')),
  ref TEXT NOT NULL COLLATE NOCASE,
  PRIMARY KEY (conversation_id, kind, ref)
);
CREATE INDEX conversation_links_ref ON conversation_links (kind, ref);

CREATE TABLE memberships (
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  session_id TEXT NOT NULL REFERENCES sessions(id),
  state TEXT NOT NULL CHECK (state IN ('active','left','suspended','ended')),
  joined_via TEXT NOT NULL CHECK (joined_via IN ('agent','auto-link','auto-all','request','claim','create')),
  joined_at TEXT NOT NULL,
  ended_at TEXT,
  ended_reason TEXT,
  PRIMARY KEY (conversation_id, session_id)
);
CREATE INDEX memberships_session ON memberships (session_id, state);

CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  seq INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('update','request','answer','constraint','notice')),
  sender_session_id TEXT NOT NULL REFERENCES sessions(id),
  sender_owner_id TEXT NOT NULL REFERENCES owners(id),
  body TEXT NOT NULL,
  answers_id TEXT REFERENCES messages(id),
  hop INTEGER NOT NULL CHECK (hop >= 1),
  created_at TEXT NOT NULL,
  UNIQUE (conversation_id, seq)
);

CREATE TABLE message_causes (
  message_id TEXT NOT NULL REFERENCES messages(id),
  cause_id TEXT NOT NULL REFERENCES messages(id),
  PRIMARY KEY (message_id, cause_id)
);

CREATE TABLE requests (
  message_id TEXT PRIMARY KEY REFERENCES messages(id),
  status TEXT NOT NULL CHECK (status IN ('pending','delivered','acknowledged','answered','cancelled','closed')),
  outcome TEXT CHECK (outcome IN ('resolved','unresolved','declined','superseded')),
  original_session_id TEXT NOT NULL REFERENCES sessions(id),
  assignee_session_id TEXT NOT NULL REFERENCES sessions(id),
  generation INTEGER NOT NULL DEFAULT 1,
  answer_message_id TEXT REFERENCES messages(id),
  updated_at TEXT NOT NULL,
  closed_at TEXT
);
CREATE INDEX requests_assignee ON requests (assignee_session_id, status);

CREATE TABLE request_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id TEXT NOT NULL REFERENCES requests(message_id),
  kind TEXT NOT NULL CHECK (kind IN ('created','delivered','acknowledged','answered','claimed','reassigned','cancelled','closed','held','released')),
  actor_session_id TEXT REFERENCES sessions(id),
  from_session_id TEXT REFERENCES sessions(id),
  to_session_id TEXT REFERENCES sessions(id),
  generation INTEGER NOT NULL,
  detail TEXT,
  at TEXT NOT NULL
);
CREATE INDEX request_events_request ON request_events (request_id, id);

CREATE TABLE receipts (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES messages(id),
  recipient_session_id TEXT NOT NULL REFERENCES sessions(id),
  generation INTEGER NOT NULL,
  wake INTEGER NOT NULL CHECK (wake IN (0,1)),
  state TEXT NOT NULL CHECK (state IN ('stored','delivered','acknowledged','answered','superseded')),
  hold TEXT CHECK (hold IN ('wake-rate','wake-hops','recipient-offline','worker-offline','awaiting-approval','runtime-unsupported','runtime-unconfirmed')),
  stored_at TEXT NOT NULL,
  delivered_at TEXT, delivered_evidence TEXT,
  acknowledged_at TEXT, answered_at TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  lease_until TEXT,
  failures INTEGER NOT NULL DEFAULT 0,
  retry_at TEXT,
  UNIQUE (message_id, recipient_session_id, generation)
);
CREATE INDEX receipts_recipient ON receipts (recipient_session_id, state);

CREATE TABLE wake_log (
  session_id TEXT NOT NULL REFERENCES sessions(id),
  receipt_id TEXT NOT NULL REFERENCES receipts(id),
  at TEXT NOT NULL,
  PRIMARY KEY (session_id, at, receipt_id)
);

CREATE TABLE constraints (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  text TEXT NOT NULL,
  owner_id TEXT NOT NULL REFERENCES owners(id),
  responsible_session_id TEXT NOT NULL REFERENCES sessions(id),
  source_message_id TEXT NOT NULL REFERENCES messages(id),
  state TEXT NOT NULL CHECK (state IN ('active','resolved')),
  created_at TEXT NOT NULL,
  resolved_at TEXT,
  resolved_by_session_id TEXT REFERENCES sessions(id),
  resolved_as TEXT CHECK (resolved_as IN ('owner','admin')),
  resolution_note TEXT
);
CREATE INDEX constraints_conversation ON constraints (conversation_id, state);

CREATE TABLE constraint_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  constraint_id TEXT NOT NULL REFERENCES constraints(id),
  kind TEXT NOT NULL CHECK (kind IN ('created','adopted','resolution-requested','resolved','owner-lost-access')),
  actor_session_id TEXT REFERENCES sessions(id),
  from_session_id TEXT REFERENCES sessions(id),
  to_session_id TEXT REFERENCES sessions(id),
  request_id TEXT REFERENCES requests(message_id),
  at TEXT NOT NULL
);

CREATE TABLE idempotency (
  device_id TEXT NOT NULL REFERENCES devices(id),
  key TEXT NOT NULL,
  request_sha256 BLOB NOT NULL,
  status INTEGER NOT NULL,
  response TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (device_id, key)
);

CREATE TABLE events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  payload TEXT NOT NULL,
  at TEXT NOT NULL
);

CREATE TABLE event_targets (
  device_id TEXT NOT NULL REFERENCES devices(id),
  seq INTEGER NOT NULL REFERENCES events(seq),
  PRIMARY KEY (device_id, seq)
);
