-- Fonoster Cloudflare D1 Initial Schema
-- Replaces PostgreSQL/Prisma with Cloudflare D1 SQLite tables

CREATE TABLE IF NOT EXISTS users (
  ref TEXT PRIMARY KEY,
  access_key_id TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  email_verified INTEGER DEFAULT 0,
  password_hash TEXT NOT NULL,
  phone_number TEXT,
  phone_number_verified INTEGER DEFAULT 0,
  avatar TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  extended TEXT
);

CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_access_key ON users(access_key_id);

CREATE TABLE IF NOT EXISTS workspaces (
  ref TEXT PRIMARY KEY,
  access_key_id TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  owner_ref TEXT NOT NULL REFERENCES users(ref) ON DELETE CASCADE,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_workspaces_owner ON workspaces(owner_ref);
CREATE INDEX IF NOT EXISTS idx_workspaces_access_key ON workspaces(access_key_id);

CREATE TABLE IF NOT EXISTS workspace_members (
  ref TEXT PRIMARY KEY,
  user_ref TEXT NOT NULL REFERENCES users(ref) ON DELETE CASCADE,
  workspace_ref TEXT NOT NULL REFERENCES workspaces(ref) ON DELETE CASCADE,
  role TEXT DEFAULT 'WORKSPACE_MEMBER', -- USER, WORKSPACE_ADMIN, WORKSPACE_OWNER, WORKSPACE_MEMBER
  status TEXT DEFAULT 'ACTIVE',          -- PENDING, ACTIVE
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(user_ref, workspace_ref)
);

CREATE TABLE IF NOT EXISTS api_keys (
  ref TEXT PRIMARY KEY,
  access_key_id TEXT UNIQUE NOT NULL,
  access_key_secret TEXT NOT NULL,
  role TEXT DEFAULT 'WORKSPACE_MEMBER',
  workspace_ref TEXT NOT NULL REFERENCES workspaces(ref) ON DELETE CASCADE,
  expires_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_api_keys_workspace ON api_keys(workspace_ref);

CREATE TABLE IF NOT EXISTS products (
  ref TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  vendor TEXT NOT NULL, -- CLOUDFLARE, GOOGLE, MICROSOFT, AMAZON, DEEPGRAM, OPENAI, GROQ, ANTHROPIC, ELEVEN_LABS
  type TEXT NOT NULL    -- TTS, STT, LLM
);

CREATE TABLE IF NOT EXISTS applications (
  ref TEXT PRIMARY KEY,
  workspace_ref TEXT NOT NULL REFERENCES workspaces(ref) ON DELETE CASCADE,
  access_key_id TEXT NOT NULL,
  name TEXT NOT NULL,
  type TEXT DEFAULT 'EXTERNAL', -- EXTERNAL, AUTOPILOT
  endpoint TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_apps_workspace ON applications(workspace_ref);

CREATE TABLE IF NOT EXISTS tts_services (
  ref TEXT PRIMARY KEY,
  application_ref TEXT UNIQUE NOT NULL REFERENCES applications(ref) ON DELETE CASCADE,
  product_ref TEXT NOT NULL REFERENCES products(ref) ON DELETE CASCADE,
  config TEXT NOT NULL,
  credentials_hash TEXT
);

CREATE TABLE IF NOT EXISTS stt_services (
  ref TEXT PRIMARY KEY,
  application_ref TEXT UNIQUE NOT NULL REFERENCES applications(ref) ON DELETE CASCADE,
  product_ref TEXT NOT NULL REFERENCES products(ref) ON DELETE CASCADE,
  config TEXT NOT NULL,
  credentials_hash TEXT
);

CREATE TABLE IF NOT EXISTS intelligence_services (
  ref TEXT PRIMARY KEY,
  application_ref TEXT UNIQUE NOT NULL REFERENCES applications(ref) ON DELETE CASCADE,
  product_ref TEXT NOT NULL REFERENCES products(ref) ON DELETE CASCADE,
  config TEXT NOT NULL,
  credentials_hash TEXT
);

CREATE TABLE IF NOT EXISTS secrets (
  ref TEXT PRIMARY KEY,
  workspace_ref TEXT NOT NULL REFERENCES workspaces(ref) ON DELETE CASCADE,
  access_key_id TEXT NOT NULL,
  name TEXT NOT NULL,
  secret_hash TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- SIPNet Models
CREATE TABLE IF NOT EXISTS acls (
  ref TEXT PRIMARY KEY,
  workspace_ref TEXT NOT NULL REFERENCES workspaces(ref) ON DELETE CASCADE,
  name TEXT NOT NULL,
  allow_rules TEXT NOT NULL DEFAULT '[]',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS domains (
  ref TEXT PRIMARY KEY,
  workspace_ref TEXT NOT NULL REFERENCES workspaces(ref) ON DELETE CASCADE,
  name TEXT NOT NULL,
  domain_uri TEXT UNIQUE NOT NULL,
  egress_rule TEXT,
  acl_ref TEXT REFERENCES acls(ref) ON DELETE SET NULL,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS trunks (
  ref TEXT PRIMARY KEY,
  workspace_ref TEXT NOT NULL REFERENCES workspaces(ref) ON DELETE CASCADE,
  name TEXT NOT NULL,
  host TEXT NOT NULL,
  port INTEGER DEFAULT 5060,
  transport TEXT DEFAULT 'UDP', -- UDP, TCP, TLS, WSS
  username TEXT,
  secret TEXT,
  inbound_uri TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS numbers (
  ref TEXT PRIMARY KEY,
  workspace_ref TEXT NOT NULL REFERENCES workspaces(ref) ON DELETE CASCADE,
  e164_number TEXT UNIQUE NOT NULL,
  country_iso TEXT NOT NULL DEFAULT 'US',
  aor TEXT,
  app_ref TEXT REFERENCES applications(ref) ON DELETE SET NULL,
  trunk_ref TEXT REFERENCES trunks(ref) ON DELETE SET NULL,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS agents (
  ref TEXT PRIMARY KEY,
  workspace_ref TEXT NOT NULL REFERENCES workspaces(ref) ON DELETE CASCADE,
  name TEXT NOT NULL,
  username TEXT NOT NULL,
  domain_ref TEXT NOT NULL REFERENCES domains(ref) ON DELETE CASCADE,
  secret TEXT NOT NULL,
  privacy TEXT DEFAULT 'PRIVATE',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(username, domain_ref)
);

CREATE TABLE IF NOT EXISTS call_detail_records (
  ref TEXT PRIMARY KEY,
  workspace_ref TEXT NOT NULL REFERENCES workspaces(ref) ON DELETE CASCADE,
  call_id TEXT UNIQUE NOT NULL,
  from_number TEXT NOT NULL,
  to_number TEXT NOT NULL,
  app_ref TEXT,
  direction TEXT NOT NULL,       -- INBOUND, OUTBOUND
  status TEXT NOT NULL,          -- INITIATING, RINGING, ANSWERED, COMPLETED, FAILED, BUSY, NO_ANSWER
  duration_seconds INTEGER DEFAULT 0,
  recording_url TEXT,
  metadata TEXT,
  started_at TEXT DEFAULT (datetime('now')),
  ended_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_cdr_workspace ON call_detail_records(workspace_ref);
CREATE INDEX IF NOT EXISTS idx_cdr_call_id ON call_detail_records(call_id);
