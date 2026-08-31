// Seeds a small fictional water-treatment plant.
// Deliberately invented assets and limits — no real plant data.
import { db } from './db.mjs'

const ASSETS = [
  {
    tag: 'P-3A', name: 'Raw Water Pump 3A', location: 'Intake Bay', kind: 'centrifugal pump',
    checks: [
      { label: 'drive end bearing temperature',     unit: 'degrees celsius', hi_warn: 70,  hi_alarm: 75 },
      { label: 'non drive end bearing temperature', unit: 'degrees celsius', hi_warn: 70,  hi_alarm: 75 },
      { label: 'discharge pressure',                unit: 'bar', lo_alarm: 3.0, lo_warn: 3.5, hi_warn: 6.0, hi_alarm: 6.5 },
      { label: 'motor current',                     unit: 'amperes', hi_warn: 42, hi_alarm: 46 },
      { label: 'vibration',                         unit: 'millimetres per second', hi_warn: 4.5, hi_alarm: 7.1 },
    ],
  },
  {
    tag: 'P-3B', name: 'Raw Water Pump 3B', location: 'Intake Bay', kind: 'centrifugal pump',
    checks: [
      { label: 'drive end bearing temperature',     unit: 'degrees celsius', hi_warn: 70, hi_alarm: 75 },
      { label: 'non drive end bearing temperature', unit: 'degrees celsius', hi_warn: 70, hi_alarm: 75 },
      { label: 'discharge pressure',                unit: 'bar', lo_alarm: 3.0, lo_warn: 3.5, hi_warn: 6.0, hi_alarm: 6.5 },
      { label: 'motor current',                     unit: 'amperes', hi_warn: 42, hi_alarm: 46 },
      { label: 'vibration',                         unit: 'millimetres per second', hi_warn: 4.5, hi_alarm: 7.1 },
    ],
  },
  {
    tag: 'AER-1', name: 'Surface Aerator 1', location: 'Aeration Basin A', kind: 'surface aerator',
    checks: [
      { label: 'gearbox oil temperature', unit: 'degrees celsius', hi_warn: 75, hi_alarm: 82 },
      { label: 'motor current',           unit: 'amperes', hi_warn: 38, hi_alarm: 42 },
      { label: 'vibration',               unit: 'millimetres per second', hi_warn: 4.5, hi_alarm: 7.1 },
      { label: 'dissolved oxygen',        unit: 'milligrams per litre', lo_alarm: 1.5, lo_warn: 2.0 },
    ],
  },
  {
    tag: 'AER-2', name: 'Surface Aerator 2', location: 'Aeration Basin B', kind: 'surface aerator',
    checks: [
      { label: 'gearbox oil temperature', unit: 'degrees celsius', hi_warn: 75, hi_alarm: 82 },
      { label: 'motor current',           unit: 'amperes', hi_warn: 38, hi_alarm: 42 },
      { label: 'vibration',               unit: 'millimetres per second', hi_warn: 4.5, hi_alarm: 7.1 },
      { label: 'dissolved oxygen',        unit: 'milligrams per litre', lo_alarm: 1.5, lo_warn: 2.0 },
    ],
  },
  {
    tag: 'BL-2', name: 'Process Air Blower 2', location: 'Blower House', kind: 'rotary lobe blower',
    checks: [
      { label: 'discharge air temperature',            unit: 'degrees celsius', hi_warn: 95, hi_alarm: 110 },
      { label: 'suction filter differential pressure', unit: 'millibar', hi_warn: 25, hi_alarm: 35 },
      { label: 'motor current',                        unit: 'amperes', hi_warn: 55, hi_alarm: 60 },
      { label: 'vibration',                            unit: 'millimetres per second', hi_warn: 4.5, hi_alarm: 7.1 },
    ],
  },
  {
    tag: 'CP-7', name: 'Circulation Pump 7', location: 'Cooling Tower Deck', kind: 'centrifugal pump',
    checks: [
      { label: 'drive end bearing temperature', unit: 'degrees celsius', hi_warn: 70, hi_alarm: 75 },
      { label: 'discharge pressure',            unit: 'bar', lo_alarm: 2.0, lo_warn: 2.4, hi_warn: 4.5, hi_alarm: 5.0 },
      { label: 'motor current',                 unit: 'amperes', hi_warn: 30, hi_alarm: 34 },
      { label: 'seal water flow',               unit: 'litres per minute', lo_alarm: 0.8, lo_warn: 1.2 },
    ],
  },
]

// Plausible readings for the previous shift, so the agent can talk about trend
// on the very first live round instead of saying "no previous reading".
const YESTERDAY = {
  'P-3A': [68.4, 66.1, 4.8, 39.2, 3.1],
  'P-3B': [64.0, 63.2, 4.9, 38.0, 2.6],
  'AER-1': [69.5, 34.1, 3.2, 3.4],
  'AER-2': [70.2, 33.8, 3.0, 3.1],
  'BL-2': [88.0, 18.0, 51.4, 3.9],
  'CP-7': [61.0, 3.2, 27.5, 2.1],
}

const checkId = (tag, label) => `${tag}:${label.replace(/\s+/g, '-')}`.toLowerCase()

db.exec('DELETE FROM readings; DELETE FROM notifications; DELETE FROM rounds; DELETE FROM checks; DELETE FROM assets;')

const insAsset = db.prepare('INSERT INTO assets (tag, name, location, kind) VALUES (?, ?, ?, ?)')
const insCheck = db.prepare(
  `INSERT INTO checks (id, asset_tag, label, unit, lo_alarm, lo_warn, hi_warn, hi_alarm, seq)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
)
const insRound = db.prepare('INSERT INTO rounds (id, operator, session_id, started_at, ended_at) VALUES (?, ?, ?, ?, ?)')
const insReading = db.prepare(
  `INSERT INTO readings (round_id, asset_tag, check_id, value, unit, status, note, superseded, created_at)
   VALUES (?, ?, ?, ?, ?, ?, NULL, 0, ?)`,
)

const dayAgo = Date.now() - 24 * 60 * 60 * 1000
insRound.run('R-SEED-PREV', 'Previous shift', null, dayAgo, dayAgo + 30 * 60 * 1000)

let checkCount = 0
for (const a of ASSETS) {
  insAsset.run(a.tag, a.name, a.location, a.kind)
  a.checks.forEach((c, i) => {
    const id = checkId(a.tag, c.label)
    insCheck.run(id, a.tag, c.label, c.unit, c.lo_alarm ?? null, c.lo_warn ?? null, c.hi_warn ?? null, c.hi_alarm ?? null, i + 1)
    checkCount++
    const prev = YESTERDAY[a.tag]?.[i]
    if (prev != null) {
      insReading.run('R-SEED-PREV', a.tag, id, prev, c.unit, 'ok', dayAgo + i * 60_000)
    }
  })
}

console.log(`seeded ${ASSETS.length} assets, ${checkCount} check points, 1 historical round`)
