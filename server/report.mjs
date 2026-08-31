// End-of-round shift report.
//
// Two sources, deliberately: the numbers come from our own database (already
// validated against limits server-side), the qualitative observations come from
// the AssemblyAI session timeline — things the operator said that never became
// a reading, like "there's an oil weep at the flange".
import { readingsOfRound, notificationsOfRound, getRound } from './db.mjs'

const AGENTS_BASE = 'https://agents.assemblyai.com'
const LLM_GATEWAY = 'https://llm-gateway.assemblyai.com/v1/chat/completions'
// The only model this account can reach today. Larger Claude/Gemini/GPT models
// on the gateway return "account does not have access" until hackathon credits
// are activated — override with LLM_MODEL once they are.
const MODEL = process.env.LLM_MODEL ?? 'qwen3.5-4b-32k-fast'

async function fetchSessionTimeline(sessionId, apiKey) {
  if (!sessionId) return null
  try {
    const res = await fetch(`${AGENTS_BASE}/v1/sessions/${sessionId}`, {
      headers: { authorization: apiKey },
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) return null
    const session = await res.json()
    const artifact = (session.artifacts ?? []).find((a) => a.type === 'timeline')
    if (!artifact?.url) return null
    // Artifact URLs are short-lived, which is why we re-fetch the session each
    // time rather than caching the link.
    const tl = await fetch(artifact.url, { signal: AbortSignal.timeout(15_000) })
    return tl.ok ? await tl.json() : null
  } catch {
    return null
  }
}

function transcriptLines(timeline) {
  const turns = Array.isArray(timeline) ? timeline : (timeline?.turns ?? [])
  return turns
    .flatMap((t) => [
      t.user_transcript ? `Operator: ${t.user_transcript}` : null,
      t.agent_text ? `Agent: ${t.agent_text}` : null,
    ])
    .filter(Boolean)
    .join('\n')
}

function factsBlock(round, readings, notifications) {
  const lines = readings.map((r) => {
    const limits = [
      r.lo_alarm != null ? `lo alarm ${r.lo_alarm}` : null,
      r.hi_warn != null ? `hi warn ${r.hi_warn}` : null,
      r.hi_alarm != null ? `hi alarm ${r.hi_alarm}` : null,
    ].filter(Boolean).join(', ')
    return `- ${r.asset_tag} (${r.asset_name}) | ${r.label}: ${r.value} ${r.unit} | status ${r.status.toUpperCase()} | limits: ${limits || 'none'}${r.note ? ` | note: ${r.note}` : ''}`
  })
  const tickets = notifications.map((n) => `- ${n.ticket_id} | ${n.asset_tag} | ${n.severity} | ${n.summary}`)
  // Pre-filter the exceptions here rather than asking the model to derive them.
  // Same principle as server-side thresholds: the small models available on a
  // free account will happily write "no alarms" underneath a list of alarms.
  const exceptions = readings.filter((r) => r.status !== 'ok')
  const exLines = exceptions.map(
    (r) => `- ${r.status.toUpperCase()} | ${r.asset_tag} ${r.label}: ${r.value} ${r.unit}`,
  )

  return [
    `Round: ${round.id}`,
    `Operator: ${round.operator}`,
    `Started: ${new Date(round.started_at).toISOString()}`,
    round.ended_at ? `Ended: ${new Date(round.ended_at).toISOString()}` : 'Ended: still open',
    '',
    `EXCEPTIONS (already filtered — ${exceptions.length} of ${readings.length} readings are not ok):`,
    exLines.length ? exLines.join('\n') : '- none, every reading is within limits',
    '',
    'READINGS (authoritative — statuses computed server-side against limits):',
    lines.length ? lines.join('\n') : '- none recorded',
    '',
    'WORK NOTIFICATIONS RAISED:',
    tickets.length ? tickets.join('\n') : '- none',
  ].join('\n')
}

const SYSTEM = `You write end-of-shift round reports for plant maintenance supervisors.

Rules:
- The READINGS block is authoritative. Never recalculate a status or invent a number.
- The EXCEPTIONS block is already filtered for you. Reproduce exactly those entries under
  "## Exceptions" — never re-derive the list, never contradict it, and never write that
  there are no exceptions when the block lists some.
- Pull qualitative observations from the transcript only if the operator actually said them.
- Be terse. A supervisor reads this in under a minute.
- Output GitHub-flavoured markdown: a short summary paragraph, then "## Exceptions",
  "## Work notifications", "## All readings" (a table), "## Operator remarks".
- If there are no exceptions, say so plainly instead of padding.`

export async function buildReport(roundId, apiKey) {
  const round = getRound(roundId)
  if (!round) return { ok: false, error: 'unknown round' }

  const readings = readingsOfRound(roundId)
  const notifications = notificationsOfRound(roundId)
  const timeline = await fetchSessionTimeline(round.session_id, apiKey)
  const transcript = timeline ? transcriptLines(timeline) : ''

  const user = [
    factsBlock(round, readings, notifications),
    '',
    'TRANSCRIPT OF THE ROUND:',
    transcript || '(transcript unavailable)',
  ].join('\n')

  try {
    const res = await fetch(LLM_GATEWAY, {
      method: 'POST',
      headers: { authorization: apiKey, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: 'system', content: SYSTEM },
          { role: 'user', content: user },
        ],
        max_tokens: 1500,
      }),
      signal: AbortSignal.timeout(60_000),
    })
    if (!res.ok) {
      return { ok: false, error: `LLM Gateway ${res.status}: ${(await res.text()).slice(0, 300)}`, fallback: factsBlock(round, readings, notifications) }
    }
    const data = await res.json()
    const markdown = data.choices?.[0]?.message?.content
    if (!markdown) return { ok: false, error: 'empty completion', fallback: factsBlock(round, readings, notifications) }
    return { ok: true, markdown, model: MODEL, had_transcript: Boolean(transcript) }
  } catch (err) {
    return { ok: false, error: String(err), fallback: factsBlock(round, readings, notifications) }
  }
}
