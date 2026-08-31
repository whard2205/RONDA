// Runs against a throwaway database so it never touches the real ronda.db.
// RONDA_DB must be set before server/db.mjs is imported, hence dynamic imports.
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.RONDA_DB = join(mkdtempSync(join(tmpdir(), 'ronda-test-')), 'test.db')
process.env.TELEGRAM_BOT_TOKEN = ''

const D = await import('../server/db.mjs')
await import('../server/seed.mjs')
const T = await import('../server/tools.mjs')

let seq = 0
function newRound() {
  const id = `R-TEST-${++seq}`
  D.db.prepare('INSERT INTO rounds (id, operator, session_id, started_at, ended_at) VALUES (?, ?, NULL, ?, NULL)')
    .run(id, 'Test', Date.now())
  return id
}
const active = (roundId) => D.readingsOfRound(roundId)
const closeAllRounds = () =>
  D.db.prepare('UPDATE rounds SET ended_at = ? WHERE ended_at IS NULL').run(Date.now())

describe('threshold evaluation', () => {
  const check = { lo_alarm: 3, lo_warn: 3.5, hi_warn: 6, hi_alarm: 6.5 }

  test('classifies each band', () => {
    assert.equal(D.evaluateStatus(check, 4.7), 'ok')
    assert.equal(D.evaluateStatus(check, 3.5), 'warn', 'lo_warn is inclusive')
    assert.equal(D.evaluateStatus(check, 6), 'warn', 'hi_warn is inclusive')
    assert.equal(D.evaluateStatus(check, 3), 'alarm', 'lo_alarm is inclusive')
    assert.equal(D.evaluateStatus(check, 6.5), 'alarm', 'hi_alarm is inclusive')
  })

  test('alarm wins over warn at the same value', () => {
    assert.equal(D.evaluateStatus({ hi_warn: 5, hi_alarm: 5 }, 5), 'alarm')
  })

  test('absent bounds are not breaches', () => {
    assert.equal(D.evaluateStatus({ hi_warn: null, hi_alarm: null, lo_warn: null, lo_alarm: null }, -999), 'ok')
  })

  test('reports which edge was crossed', () => {
    assert.deepEqual(D.breachedLimit(check, 7, 'alarm'), { edge: 'high alarm', value: 6.5 })
    assert.deepEqual(D.breachedLimit(check, 3.2, 'warn'), { edge: 'low warning', value: 3.5 })
    assert.equal(D.breachedLimit(check, 4.7, 'ok'), null)
  })
})

describe('asset lookup', () => {
  test('matches however speech mangles the tag', () => {
    for (const spoken of ['P-3A', 'p3a', 'P 3A', 'p_3a', '  p-3a  ']) {
      assert.equal(D.findAsset(spoken)?.tag, 'P-3A', `failed on ${JSON.stringify(spoken)}`)
    }
  })

  test('returns null for an unknown tag', () => {
    assert.equal(D.findAsset('XX-9'), null)
  })
})

describe('check point resolution', () => {
  test('resolves an exact label', () => {
    assert.equal(D.findCheck('P-3A', 'motor current').check.label, 'motor current')
  })

  test('resolves a unique partial', () => {
    assert.equal(D.findCheck('P-3A', 'vibration').check.label, 'vibration')
  })

  // The bug this guards: P-3A has drive end AND non drive end bearing
  // temperature. Picking the first match would log against the wrong point.
  test('refuses to guess between two matching check points', () => {
    const r = D.findCheck('P-3A', 'temperature')
    assert.ok(r.ambiguous, 'expected ambiguity, got ' + JSON.stringify(r))
    assert.equal(r.ambiguous.length, 2)
    assert.ok(!r.check, 'must not silently pick one')
  })

  test('an exact label still wins even when it is a prefix of another', () => {
    // "drive end bearing temperature" is a substring of the non-drive-end one,
    // but an exact match must not be reported as ambiguous.
    assert.equal(D.findCheck('P-3A', 'drive end bearing temperature').check.label, 'drive end bearing temperature')
  })

  test('reports nothing for an unknown check', () => {
    assert.ok(D.findCheck('P-3A', 'oil colour').none)
  })
})

describe('log_reading', () => {
  test('records a value and its server-computed status', () => {
    const round = newRound()
    const out = T.logReading({ round_id: round, asset_tag: 'P-3A', check: 'vibration', value: 8.4 })
    assert.equal(out.ok, true)
    assert.equal(out.status, 'alarm')
    assert.deepEqual(out.limit, { kind: 'high alarm', value: 7.1 })
    assert.equal(active(round).length, 1)
  })

  test('surfaces ambiguity instead of logging to the wrong point', () => {
    const round = newRound()
    const out = T.logReading({ round_id: round, asset_tag: 'P-3A', check: 'temperature', value: 78 })
    assert.equal(out.ok, false)
    assert.match(out.error, /more than one check point/)
    assert.equal(active(round).length, 0, 'nothing may be written on an ambiguous match')
  })

  // The bug this guards: two active rows for one check point would be
  // double-counted by the shift report.
  test('a re-read supersedes the earlier value rather than duplicating it', () => {
    const round = newRound()
    T.logReading({ round_id: round, asset_tag: 'P-3A', check: 'motor current', value: 40 })
    const second = T.logReading({ round_id: round, asset_tag: 'P-3A', check: 'motor current', value: 44 })
    assert.equal(second.replaced_earlier_value, 40)
    const rows = active(round)
    assert.equal(rows.length, 1)
    assert.equal(rows[0].value, 44)
  })

  test('rejects a non-numeric value', () => {
    const round = newRound()
    const out = T.logReading({ round_id: round, asset_tag: 'P-3A', check: 'vibration', value: 'seventy eight' })
    assert.equal(out.ok, false)
    assert.match(out.error, /not a number/)
  })

  test('recovers an unknown round_id when exactly one round is open', () => {
    closeAllRounds()
    const round = newRound()
    const out = T.logReading({ round_id: 'NOPE', asset_tag: 'P-3A', check: 'discharge pressure', value: 4.7 })
    assert.equal(out.ok, true)
    assert.ok(out.note_to_agent, 'the agent should be told the id did not resolve')
    assert.equal(active(round).length, 1, 'the reading must not be lost')
  })

  // Two operators can be out on rounds at the same time. Filing a reading
  // against the wrong one is worse than refusing to file it at all.
  test('refuses to guess when several rounds are open', () => {
    closeAllRounds()
    const first = newRound()
    const second = newRound()
    const out = T.logReading({ round_id: 'NOPE', asset_tag: 'P-3A', check: 'discharge pressure', value: 4.7 })
    assert.equal(out.ok, false)
    assert.match(out.error, /Several rounds are open/)
    assert.equal(active(first).length, 0)
    assert.equal(active(second).length, 0)
  })

  test('lists the check points still outstanding', () => {
    const round = newRound()
    const out = T.logReading({ round_id: round, asset_tag: 'AER-1', check: 'dissolved oxygen', value: 3.2 })
    assert.equal(out.remaining_checks_on_this_asset.length, 3)
    assert.ok(!out.remaining_checks_on_this_asset.includes('dissolved oxygen'))
  })

  test('compares against the previous shift', () => {
    const round = newRound()
    const out = T.logReading({ round_id: round, asset_tag: 'BL-2', check: 'motor current', value: 53.4 })
    assert.equal(out.previous.value, 51.4)
    assert.match(out.trend, /^up 2 since/)
  })
})

describe('correct_last_reading', () => {
  test('replaces the value and re-evaluates the status', () => {
    const round = newRound()
    T.logReading({ round_id: round, asset_tag: 'AER-1', check: 'dissolved oxygen', value: 3.1 })
    const out = T.correctLastReading({ round_id: round, value: 1.4 })
    assert.equal(out.corrected_from, 3.1)
    assert.equal(out.corrected_to, 1.4)
    assert.equal(out.status, 'alarm', 'crossing the low alarm must be recomputed, not carried over')
    const rows = active(round)
    assert.equal(rows.length, 1)
    assert.equal(rows[0].value, 1.4)
  })

  test('refuses when the round has nothing logged', () => {
    const out = T.correctLastReading({ round_id: newRound(), value: 5 })
    assert.equal(out.ok, false)
  })
})

describe('raise_notification', () => {
  test('issues a ticket and records it against the round', async () => {
    const round = newRound()
    const out = await T.raiseNotification({
      round_id: round, asset_tag: 'P-3A', severity: 'high', summary: 'Vibration above alarm limit.',
    })
    assert.equal(out.ok, true)
    assert.match(out.ticket_id, /^WN-\d+$/)
    assert.equal(out.dispatched, false, 'no telegram configured in tests')
    assert.equal(D.notificationsOfRound(round).length, 1)
  })

  test('normalises an unexpected severity instead of failing', async () => {
    const out = await T.raiseNotification({
      round_id: newRound(), asset_tag: 'P-3A', severity: 'catastrophic', summary: 'x',
    })
    assert.equal(out.severity, 'medium')
  })

  test('requires a summary', async () => {
    const out = await T.raiseNotification({ round_id: newRound(), asset_tag: 'P-3A', severity: 'high' })
    assert.equal(out.ok, false)
  })
})

describe('get_asset_checklist', () => {
  test('returns the check points in order', () => {
    const out = T.getAssetChecklist({ asset_tag: 'p 3a' })
    assert.equal(out.tag, 'P-3A')
    assert.equal(out.checks.length, 5)
    assert.equal(out.checks[0].label, 'drive end bearing temperature')
  })

  test('lists the known assets when the tag is wrong', () => {
    const out = T.getAssetChecklist({ asset_tag: 'XX-9' })
    assert.equal(out.ok, false)
    assert.match(out.error, /AER-1/)
  })
})
