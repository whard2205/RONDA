// Storage layer for RONDA. Zero dependencies: node:sqlite ships with Node 22.5+.
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
export const DB_PATH = process.env.RONDA_DB ?? join(ROOT, 'ronda.db')

export const db = new DatabaseSync(DB_PATH)
db.exec('PRAGMA journal_mode = WAL')
db.exec('PRAGMA foreign_keys = ON')

db.exec(`
CREATE TABLE IF NOT EXISTS assets (
  tag       TEXT PRIMARY KEY,
  name      TEXT NOT NULL,
  location  TEXT NOT NULL,
  kind      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS checks (
  id         TEXT PRIMARY KEY,
  asset_tag  TEXT NOT NULL REFERENCES assets(tag),
  label      TEXT NOT NULL,
  unit       TEXT NOT NULL,
  lo_alarm   REAL,
  lo_warn    REAL,
  hi_warn    REAL,
  hi_alarm   REAL,
  seq        INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS rounds (
  id          TEXT PRIMARY KEY,
  operator    TEXT NOT NULL,
  session_id  TEXT,
  started_at  INTEGER NOT NULL,
  ended_at    INTEGER
);

CREATE TABLE IF NOT EXISTS readings (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  round_id    TEXT NOT NULL REFERENCES rounds(id),
  asset_tag   TEXT NOT NULL,
  check_id    TEXT NOT NULL,
  value       REAL NOT NULL,
  unit        TEXT,
  status      TEXT NOT NULL,
  note        TEXT,
  superseded  INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS notifications (
  ticket_id   TEXT PRIMARY KEY,
  round_id    TEXT,
  asset_tag   TEXT NOT NULL,
  severity    TEXT NOT NULL,
  summary     TEXT NOT NULL,
  delivered   INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_readings_round ON readings(round_id, superseded);
CREATE INDEX IF NOT EXISTS idx_readings_check ON readings(check_id, superseded, created_at);
CREATE INDEX IF NOT EXISTS idx_checks_asset ON checks(asset_tag, seq);
`)

// --- threshold evaluation -------------------------------------------------
// This runs on the server on purpose. The language model is never asked to
// decide whether a reading breaches a limit; it only reads out the verdict.
export function evaluateStatus(check, value) {
  if (check.hi_alarm != null && value >= check.hi_alarm) return 'alarm'
  if (check.lo_alarm != null && value <= check.lo_alarm) return 'alarm'
  if (check.hi_warn != null && value >= check.hi_warn) return 'warn'
  if (check.lo_warn != null && value <= check.lo_warn) return 'warn'
  return 'ok'
}

// The limit the reading is actually being measured against, so the agent can
// say "78 against a 75 limit" instead of reciting all four bounds.
export function breachedLimit(check, value, status) {
  if (status === 'ok') return null
  if (check.hi_alarm != null && value >= check.hi_alarm) return { edge: 'high alarm', value: check.hi_alarm }
  if (check.lo_alarm != null && value <= check.lo_alarm) return { edge: 'low alarm', value: check.lo_alarm }
  if (check.hi_warn != null && value >= check.hi_warn) return { edge: 'high warning', value: check.hi_warn }
  if (check.lo_warn != null && value <= check.lo_warn) return { edge: 'low warning', value: check.lo_warn }
  return null
}

// --- lookups --------------------------------------------------------------
const norm = (s) => String(s ?? '').trim().toUpperCase().replace(/[\s_]+/g, '-')

export function findAsset(tag) {
  const wanted = norm(tag)
  const direct = db.prepare('SELECT * FROM assets WHERE UPPER(tag) = ?').get(wanted)
  if (direct) return direct
  // Speech gives us "pump three A" -> "P-3A", but also "P3A" or "P 3A".
  // Compare with separators stripped before giving up.
  const loose = wanted.replace(/-/g, '')
  for (const a of db.prepare('SELECT * FROM assets').all()) {
    if (a.tag.toUpperCase().replace(/-/g, '') === loose) return a
  }
  return null
}

export function checksFor(tag) {
  return db.prepare('SELECT * FROM checks WHERE asset_tag = ? ORDER BY seq').all(tag)
}

export function findCheck(assetTag, checkRef) {
  const rows = checksFor(assetTag)
  const wanted = String(checkRef ?? '').trim().toLowerCase()
  if (!wanted) return null
  return (
    rows.find((c) => c.id.toLowerCase() === wanted) ??
    rows.find((c) => c.label.toLowerCase() === wanted) ??
    rows.find((c) => c.label.toLowerCase().includes(wanted)) ??
    rows.find((c) => wanted.includes(c.label.toLowerCase())) ??
    null
  )
}

export function previousReading(checkId, roundId) {
  // Ordering puts readings from finished rounds first: a reading from a
  // completed shift is a more meaningful comparison than one from a round
  // somebody abandoned ten minutes ago.
  return db
    .prepare(
      `SELECT r.value, r.unit, r.status, r.created_at, ro.ended_at
       FROM readings r
       JOIN rounds ro ON ro.id = r.round_id
       WHERE r.check_id = ? AND r.round_id != ? AND r.superseded = 0
       ORDER BY (ro.ended_at IS NULL), r.created_at DESC
       LIMIT 1`,
    )
    .get(checkId, roundId)
}

export function lastReadingOfRound(roundId) {
  return db
    .prepare(
      `SELECT * FROM readings WHERE round_id = ? AND superseded = 0
       ORDER BY created_at DESC, id DESC LIMIT 1`,
    )
    .get(roundId)
}

export function readingsOfRound(roundId) {
  return db
    .prepare(
      `SELECT r.*, c.label, c.hi_warn, c.hi_alarm, c.lo_warn, c.lo_alarm, a.name AS asset_name
       FROM readings r
       JOIN checks c ON c.id = r.check_id
       JOIN assets a ON a.tag = r.asset_tag
       WHERE r.round_id = ? AND r.superseded = 0
       ORDER BY r.created_at, r.id`,
    )
    .all(roundId)
}

export function notificationsOfRound(roundId) {
  return db
    .prepare('SELECT * FROM notifications WHERE round_id = ? ORDER BY created_at')
    .all(roundId)
}

export function getRound(id) {
  return db.prepare('SELECT * FROM rounds WHERE id = ?').get(id)
}

// Defensive fallback: if the model omits or mangles round_id we attach the
// reading to the most recent round that is still open rather than losing it.
export function newestOpenRound() {
  return db
    .prepare('SELECT * FROM rounds WHERE ended_at IS NULL ORDER BY started_at DESC LIMIT 1')
    .get()
}
