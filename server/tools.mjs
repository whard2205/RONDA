// The four tools the voice agent can call.
//
// These run on OUR server, invoked by AssemblyAI's servers over HTTPS. The
// browser never sees a tool call, so every handler also publishes an event
// that the UI picks up over SSE.
import { EventEmitter } from 'node:events'
import {
  db, evaluateStatus, breachedLimit, findAsset, checksFor, findCheck,
  previousReading, lastReadingOfRound, getRound, newestOpenRound,
} from './db.mjs'

export const bus = new EventEmitter()
bus.setMaxListeners(0)

const round1 = (n) => Math.round(n * 10) / 10

// AssemblyAI caps tool responses at 8 KiB, so everything below stays terse and
// pre-summarised rather than dumping rows.
function resolveRound(roundId) {
  const direct = roundId ? getRound(roundId) : null
  if (direct) return { round: direct, recovered: false }
  // The model occasionally drops or mangles the id. Losing a reading is worse
  // than attaching it to the obvious round, so fall back to the open one.
  const fallback = newestOpenRound()
  return fallback ? { round: fallback, recovered: true } : { round: null, recovered: false }
}

function describeAge(ms) {
  const hours = (Date.now() - ms) / 3_600_000
  if (hours < 4) return 'an earlier round today'
  if (hours < 36) return 'the previous shift'
  return `${Math.round(hours / 24)} days ago`
}

export function getAssetChecklist({ asset_tag }) {
  const asset = findAsset(asset_tag)
  if (!asset) {
    const known = db.prepare('SELECT tag FROM assets ORDER BY tag').all().map((r) => r.tag)
    return { ok: false, error: `No asset tagged "${asset_tag}". Known assets: ${known.join(', ')}.` }
  }
  return {
    ok: true,
    tag: asset.tag,
    name: asset.name,
    location: asset.location,
    checks: checksFor(asset.tag).map((c) => ({ label: c.label, unit: c.unit })),
  }
}

export function logReading({ round_id, asset_tag, check, value, unit, note }) {
  const { round, recovered } = resolveRound(round_id)
  if (!round) return { ok: false, error: 'No active round. Ask the operator to start a round in the app.' }

  const asset = findAsset(asset_tag)
  if (!asset) return { ok: false, error: `No asset tagged "${asset_tag}".` }

  const target = findCheck(asset.tag, check)
  if (!target) {
    const labels = checksFor(asset.tag).map((c) => c.label)
    return { ok: false, error: `"${check}" is not a check point on ${asset.tag}. Valid: ${labels.join(', ')}.` }
  }

  const num = Number(value)
  if (!Number.isFinite(num)) return { ok: false, error: `"${value}" is not a number. Ask the operator to repeat the reading.` }

  const status = evaluateStatus(target, num)
  const limit = breachedLimit(target, num, status)
  const prev = previousReading(target.id, round.id)

  db.prepare(
    `INSERT INTO readings (round_id, asset_tag, check_id, value, unit, status, note, superseded, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)`,
  ).run(round.id, asset.tag, target.id, num, unit ?? target.unit, status, note ?? null, Date.now())

  const done = new Set(
    db.prepare('SELECT DISTINCT check_id FROM readings WHERE round_id = ? AND asset_tag = ? AND superseded = 0')
      .all(round.id, asset.tag).map((r) => r.check_id),
  )
  const remaining = checksFor(asset.tag).filter((c) => !done.has(c.id)).map((c) => c.label)

  const out = {
    ok: true,
    asset: asset.tag,
    check: target.label,
    value: num,
    unit: unit ?? target.unit,
    status,
    remaining_checks_on_this_asset: remaining,
  }
  if (limit) out.limit = { kind: limit.edge, value: limit.value }
  if (prev) {
    const delta = round1(num - prev.value)
    out.previous = { value: prev.value, when: describeAge(prev.created_at) }
    out.trend = delta === 0 ? 'unchanged' : `${delta > 0 ? 'up' : 'down'} ${Math.abs(delta)} since ${describeAge(prev.created_at)}`
  }
  if (recovered) out.note_to_agent = 'round_id was missing or unknown; attached to the open round.'

  bus.emit('event', { round_id: round.id, kind: 'reading', payload: { ...out, at: Date.now() } })
  return out
}

export function correctLastReading({ round_id, value }) {
  const { round } = resolveRound(round_id)
  if (!round) return { ok: false, error: 'No active round.' }

  const last = lastReadingOfRound(round.id)
  if (!last) return { ok: false, error: 'Nothing logged yet in this round, so there is nothing to correct.' }

  const num = Number(value)
  if (!Number.isFinite(num)) return { ok: false, error: `"${value}" is not a number.` }

  const target = db.prepare('SELECT * FROM checks WHERE id = ?').get(last.check_id)
  const status = evaluateStatus(target, num)
  const limit = breachedLimit(target, num, status)

  db.prepare('UPDATE readings SET superseded = 1 WHERE id = ?').run(last.id)
  db.prepare(
    `INSERT INTO readings (round_id, asset_tag, check_id, value, unit, status, note, superseded, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)`,
  ).run(round.id, last.asset_tag, last.check_id, num, last.unit, status, last.note, Date.now())

  const out = {
    ok: true,
    asset: last.asset_tag,
    check: target.label,
    corrected_from: last.value,
    corrected_to: num,
    unit: last.unit,
    status,
  }
  if (limit) out.limit = { kind: limit.edge, value: limit.value }

  bus.emit('event', { round_id: round.id, kind: 'correction', payload: { ...out, at: Date.now() } })
  return out
}

export async function raiseNotification({ round_id, asset_tag, severity, summary }) {
  const { round } = resolveRound(round_id)
  const asset = findAsset(asset_tag)
  if (!asset) return { ok: false, error: `No asset tagged "${asset_tag}".` }
  if (!summary) return { ok: false, error: 'A one-line summary of the problem is required.' }

  const sev = ['low', 'medium', 'high'].includes(String(severity).toLowerCase())
    ? String(severity).toLowerCase()
    : 'medium'

  const seq = 1041 + db.prepare('SELECT COUNT(*) AS c FROM notifications').get().c
  const ticket = `WN-${seq}`
  db.prepare(
    `INSERT INTO notifications (ticket_id, round_id, asset_tag, severity, summary, delivered, created_at)
     VALUES (?, ?, ?, ?, ?, 0, ?)`,
  ).run(ticket, round?.id ?? null, asset.tag, sev, summary, Date.now())

  const delivered = await notifyTelegram(ticket, asset, sev, summary)
  if (delivered) db.prepare('UPDATE notifications SET delivered = 1 WHERE ticket_id = ?').run(ticket)

  const out = { ok: true, ticket_id: ticket, asset: asset.tag, severity: sev, dispatched: delivered }
  bus.emit('event', { round_id: round?.id, kind: 'notification', payload: { ...out, summary, at: Date.now() } })
  return out
}

async function notifyTelegram(ticket, asset, severity, summary) {
  const token = process.env.TELEGRAM_BOT_TOKEN
  const chat = process.env.TELEGRAM_CHAT_ID
  if (!token || !chat) return false
  const text = `${ticket} — ${asset.tag} ${asset.name}\nLocation: ${asset.location}\nSeverity: ${severity}\n${summary}`
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, text }),
      signal: AbortSignal.timeout(8000),
    })
    return res.ok
  } catch {
    return false // never let a notification failure break the conversation
  }
}
