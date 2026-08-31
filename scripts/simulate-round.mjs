// Drives a realistic round through the tool endpoints so the UI can be
// exercised without a published agent. Open the printed URL and watch it fill.
//
//   node server/index.mjs          # in one terminal
//   node scripts/simulate-round.mjs
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
try { process.loadEnvFile(join(ROOT, '.env')) } catch {}

const BASE = `http://localhost:${process.env.PORT ?? 8787}`
const SECRET = process.env.TOOL_SECRET ?? ''
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

const tool = async (path, body, method = 'POST') => {
  const res = await fetch(`${BASE}/tools/${path}`, {
    method,
    headers: { 'x-ronda-key': SECRET, 'content-type': 'application/json' },
    body: method === 'POST' ? JSON.stringify(body) : undefined,
  })
  return res.json()
}

// Paced like a real round: the operator walks, reads a gauge, speaks.
const SCRIPT = [
  { say: 'Pump three A.',            asset: 'P-3A',  check: 'drive end bearing temperature',     value: 69.8, gap: 2200 },
  { say: 'Non drive end, sixty six.', asset: 'P-3A', check: 'non drive end bearing temperature', value: 66.4, gap: 2600 },
  { say: 'Discharge four point seven.', asset: 'P-3A', check: 'discharge pressure',              value: 4.7,  gap: 2400 },
  { say: 'Current forty point one.', asset: 'P-3A',  check: 'motor current',                     value: 40.1, gap: 2800 },
  { say: 'Vibration eight point four, there is a rumble at the drive end.',
    asset: 'P-3A', check: 'vibration', value: 8.4, note: 'audible rumble at the drive end', gap: 3200 },
  { notify: { asset: 'P-3A', severity: 'high',
    summary: 'Vibration 8.4 mm/s against a 7.1 alarm limit, up from 3.1 last shift, audible rumble at the drive end.' }, gap: 3000 },
  { say: 'Aerator one. Gearbox oil seventy one five.', asset: 'AER-1', check: 'gearbox oil temperature', value: 71.5, gap: 2600 },
  { say: 'Dissolved oxygen three point one.', asset: 'AER-1', check: 'dissolved oxygen', value: 3.1, gap: 2000 },
  { correct: 1.4, say: 'Sorry, one point four.', gap: 2600 },
  { say: 'Current thirty four.', asset: 'AER-1', check: 'motor current', value: 34.0, gap: 0 },
]

const round = await (await fetch(`${BASE}/api/round`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ operator: 'Simulated operator' }),
})).json()

console.log(`\n  round ${round.round_id}`)
console.log(`  watch it live:  ${BASE}/?follow=${round.round_id}\n`)
console.log('  starting in 5s — open that URL now\n')
await wait(5000)

for (const step of SCRIPT) {
  let out
  if (step.notify) {
    out = await tool('raise-notification', { round_id: round.round_id, asset_tag: step.notify.asset, ...step.notify })
    console.log(`  → raised ${out.ticket_id} (${step.notify.severity})`)
  } else if (step.correct != null) {
    out = await tool('correct-last-reading', { round_id: round.round_id, value: step.correct })
    console.log(`  "${step.say}"`)
    console.log(`  → corrected ${out.corrected_from} to ${out.corrected_to} — ${out.status}`)
  } else {
    out = await tool('log-reading', {
      round_id: round.round_id, asset_tag: step.asset, check: step.check, value: step.value, note: step.note,
    })
    console.log(`  "${step.say}"`)
    console.log(`  → ${step.check}: ${out.value} — ${out.status}${out.trend ? ` (${out.trend})` : ''}`)
  }
  await wait(step.gap)
}

await fetch(`${BASE}/api/round/${round.round_id}/end`, { method: 'POST' })
console.log(`\n  round closed. Report: ${BASE}/api/round/${round.round_id}/report\n`)
