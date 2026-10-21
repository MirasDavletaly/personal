-- Team Kazakhstan: initial schema.
-- Applied automatically at start-up inside one BEGIN IMMEDIATE transaction
-- (see src/server/db.ts). Never edit an applied migration: add a new file.

CREATE TABLE companies (
  id          INTEGER PRIMARY KEY,
  name        TEXT    NOT NULL,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  active      INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at  TEXT    NOT NULL,
  updated_at  TEXT    NOT NULL
);
CREATE UNIQUE INDEX companies_name_uq ON companies (name COLLATE NOCASE);

CREATE TABLE teams (
  id          INTEGER PRIMARY KEY,
  company_id  INTEGER NOT NULL REFERENCES companies (id) ON DELETE RESTRICT,
  name        TEXT    NOT NULL,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  active      INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at  TEXT    NOT NULL,
  updated_at  TEXT    NOT NULL
);
CREATE UNIQUE INDEX teams_company_name_uq ON teams (company_id, name COLLATE NOCASE);

CREATE TABLE employees (
  id                      INTEGER PRIMARY KEY,
  first_name              TEXT    NOT NULL,
  last_name               TEXT    NOT NULL,
  company_id              INTEGER REFERENCES companies (id) ON DELETE RESTRICT,
  team_id                 INTEGER REFERENCES teams (id) ON DELETE RESTRICT,
  official_title          TEXT    NOT NULL DEFAULT '',
  profession              TEXT    NOT NULL DEFAULT '',
  current_work            TEXT    NOT NULL DEFAULT '',
  languages               TEXT    NOT NULL DEFAULT '[]',
  work_email              TEXT,
  phone                   TEXT,
  algoritmi_availability  TEXT CHECK (algoritmi_availability IN ('yes', 'partial', 'no')),
  photo_id                TEXT UNIQUE,
  photo_updated_at        TEXT,
  status                  TEXT    NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  is_demo                 INTEGER NOT NULL DEFAULT 0 CHECK (is_demo IN (0, 1)),
  created_at              TEXT    NOT NULL,
  updated_at              TEXT    NOT NULL,
  updated_by              INTEGER REFERENCES users (id) ON DELETE SET NULL
);
CREATE INDEX employees_company_team_idx ON employees (company_id, team_id);
CREATE INDEX employees_status_idx ON employees (status);

CREATE TABLE users (
  id             INTEGER PRIMARY KEY,
  username       TEXT    NOT NULL,
  display_name   TEXT    NOT NULL,
  role           TEXT    NOT NULL CHECK (role IN ('admin', 'coordinator', 'employee', 'viewer')),
  employee_id    INTEGER UNIQUE REFERENCES employees (id) ON DELETE SET NULL,
  password_hash  TEXT,
  status         TEXT    NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  locale         TEXT CHECK (locale IN ('en', 'ru')),
  created_at     TEXT    NOT NULL,
  updated_at     TEXT    NOT NULL,
  last_login_at  TEXT
);
CREATE UNIQUE INDEX users_username_uq ON users (username COLLATE NOCASE);

-- Server-side sessions. id is the SHA-256 of the cookie value: a copy of the
-- database does not contain usable session tokens.
CREATE TABLE sessions (
  id            TEXT    PRIMARY KEY,
  user_id       INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  csrf_token    TEXT    NOT NULL,
  created_at    TEXT    NOT NULL,
  expires_at    TEXT    NOT NULL,
  last_seen_at  TEXT    NOT NULL,
  ip            TEXT,
  user_agent    TEXT
);
CREATE INDEX sessions_user_idx ON sessions (user_id);

-- One-time links: invitations, password resets and the first administrator
-- set-up. Only the SHA-256 of the token is stored.
CREATE TABLE invites (
  id               INTEGER PRIMARY KEY,
  token_hash       TEXT    NOT NULL UNIQUE,
  kind             TEXT    NOT NULL CHECK (kind IN ('invite', 'reset', 'setup')),
  role             TEXT    NOT NULL CHECK (role IN ('admin', 'coordinator', 'employee', 'viewer')),
  employee_id      INTEGER REFERENCES employees (id) ON DELETE CASCADE,
  user_id          INTEGER REFERENCES users (id) ON DELETE CASCADE,
  display_name     TEXT,
  created_by       INTEGER REFERENCES users (id) ON DELETE SET NULL,
  created_at       TEXT    NOT NULL,
  expires_at       TEXT    NOT NULL,
  used_at          TEXT,
  used_by_user_id  INTEGER REFERENCES users (id) ON DELETE SET NULL,
  revoked_at       TEXT,
  revoked_by       INTEGER REFERENCES users (id) ON DELETE SET NULL
);
CREATE INDEX invites_employee_idx ON invites (employee_id);
CREATE INDEX invites_user_idx ON invites (user_id);

CREATE TABLE audit_log (
  id             INTEGER PRIMARY KEY,
  at             TEXT    NOT NULL,
  actor_user_id  INTEGER,
  actor_label    TEXT    NOT NULL,
  action         TEXT    NOT NULL,
  entity_type    TEXT,
  entity_id      TEXT,
  details        TEXT    NOT NULL DEFAULT '{}',
  ip             TEXT
);
CREATE INDEX audit_at_idx ON audit_log (at);
CREATE INDEX audit_action_idx ON audit_log (action);

CREATE TABLE settings (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
