// RONDA server: static UI, browser token minting, the four tool endpoints that
// AssemblyAI calls, and the end-of-round report.
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join, extname, normalize } from 'node:path'
import { randomUUID } from 'node:crypto'

// Resolve .env from the project root rather than the working directory: under
// systemd the cwd is whatever WorkingDirectory says, and a silently missing
// key surfaces much later as a confusing 401.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
try { process.loadEnvFile(join(ROOT, '.env')) } catch { /* env may come from the process itself */ }

import { db, readingsOfRound, notificationsOfRound, getRound, breachedLimit } from './db.mjs'
import { bus, getAssetChecklist, logReading, correctLastReading, raiseNotification } from './tools.mjs'
import { buildReport } from './report.mjs'
const WEB = join(ROOT, 'web')
const PORT = Number(process.env.PORT ?? 8787)
const API_KEY = process.env.ASSEMBLYAI_API_KEY
const TOOL_SECRET = process.env.TOOL_SECRET

if (!API_KEY) {
  console.error('ASSEMBLYAI_API_KEY is not set. Copy .env.example to .env and fill it in.')
  process.exit(1)
}

const MIME = { '.html': 'text/html', '.mjs': 'text/javascript', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' }

const json = (res, code, body) => {
  const buf = Buffer.from(JSON.stringify(body))
  res.writeHead(code, { 'content-type': 'application/json', 'content-length': buf.length })
  res.end(buf)
}

async function readBody(req, limit = 256 * 1024) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw new Error('body too large')
    chunks.push(chunk)
  }
  if (!chunks.length) return {}
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw new Error('invalid JSON body') }
}

// AssemblyAI sends this header on every tool call. Without it the tool
// endpoints are open to anyone who finds the public URL.
function toolAuthorised(req) {
  if (!TOOL_SECRET) return true // dev convenience; set TOOL_SECRET in production
  return req.headers['x-ronda-key'] === TOOL_SECRET
}

async function serveStatic(res, urlPath) {
  const rel = normalize(urlPath === '/' ? '/index.html' : urlPath).replace(/^(\.\.[/\\])+/, '')
  const file = join(WEB, rel)
  if (!file.startsWith(WEB)) { res.writeHead(403).end('forbidden'); return }
  try {
    const buf = await readFile(file)
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-cache' })
    res.end(buf)
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('not found')
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`)
  const p = url.pathname

  try {
    // ---- browser: single-use session token (the API key stays here) --------
    if (p === '/api/token' && req.method === 'GET') {
      const qs = new URLSearchParams({ expires_in_seconds: '300', max_session_duration_seconds: '3600' })
      const r = await fetch(`https://agents.assemblyai.com/v1/token?${qs}`, {
        headers: { authorization: `Bearer ${API_KEY}` },
        signal: AbortSignal.timeout(15_000),
      })
      if (!r.ok) return json(res, 502, { error: `token mint failed (${r.status})`, detail: (await r.text()).slice(0, 300) })
      const { token } = await r.json()
      return json(res, 200, { token, agent_id: process.env.AGENT_ID ?? null })
    }

    // ---- round lifecycle ---------------------------------------------------
    if (p === '/api/round' && req.method === 'POST') {
      const body = await readBody(req)
      const id = `R-${new Date().toISOString().slice(0, 10)}-${randomUUID().slice(0, 4).toUpperCase()}`
      db.prepare('INSERT INTO rounds (id, operator, session_id, started_at, ended_at) VALUES (?, ?, NULL, ?, NULL)')
        .run(id, String(body.operator ?? 'Operator').slice(0, 80), Date.now())
      return json(res, 201, { round_id: id })
    }

    const roundMatch = p.match(/^\/api\/round\/([A-Za-z0-9-]+)(\/[a-z]+)?$/)
    if (roundMatch) {
      const [, roundId, sub] = roundMatch
      const round = getRound(roundId)
      if (!round) return json(res, 404, { error: 'unknown round' })

      if (!sub && req.method === 'GET') {
        const readings = readingsOfRound(roundId).map((r) => {
          const lim = breachedLimit(r, r.value, r.status)
          return { ...r, limit: lim ? { kind: lim.edge, value: lim.value } : null }
        })
        return json(res, 200, { round, readings, notifications: notificationsOfRound(roundId) })
      }
      if (sub === '/session' && req.method === 'POST') {
        const { session_id } = await readBody(req)
        db.prepare('UPDATE rounds SET session_id = ? WHERE id = ?').run(String(session_id ?? '').slice(0, 128), roundId)
        return json(res, 200, { ok: true })
      }
      if (sub === '/end' && req.method === 'POST') {
        db.prepare('UPDATE rounds SET ended_at = ? WHERE id = ? AND ended_at IS NULL').run(Date.now(), roundId)
        return json(res, 200, { ok: true })
      }
      if (sub === '/events' && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
        res.write(': connected\n\n')
        const onEvent = (e) => {
          if (e.round_id !== roundId) return
          res.write(`data: ${JSON.stringify(e)}\n\n`)
        }
        bus.on('event', onEvent)
        const ping = setInterval(() => res.write(': ping\n\n'), 25_000)
        req.on('close', () => { clearInterval(ping); bus.off('event', onEvent) })
        return
      }
      if (sub === '/report' && req.method === 'GET') {
        return json(res, 200, await buildReport(roundId, API_KEY))
      }
    }

    // ---- tools, called by AssemblyAI over HTTPS ---------------------------
    if (p.startsWith('/tools/')) {
      if (!toolAuthorised(req)) return json(res, 401, { ok: false, error: 'unauthorised' })
      const started = Date.now()
      let out

      if (p === '/tools/asset-checklist' && req.method === 'GET') {
        out = getAssetChecklist(Object.fromEntries(url.searchParams))
      } else if (p === '/tools/log-reading' && req.method === 'POST') {
        out = logReading(await readBody(req))
      } else if (p === '/tools/correct-last-reading' && req.method === 'POST') {
        out = correctLastReading(await readBody(req))
      } else if (p === '/tools/raise-notification' && req.method === 'POST') {
        out = await raiseNotification(await readBody(req))
      } else {
        return json(res, 404, { ok: false, error: 'no such tool' })
      }

      console.log(`[tool] ${req.method} ${p} -> ${out.ok ? 'ok' : 'ERR'} (${Date.now() - started}ms)`, out.ok ? '' : out.error)
      return json(res, 200, out)
    }

    if (p === '/healthz') return json(res, 200, { ok: true })

    if (req.method === 'GET') return serveStatic(res, p)
    return json(res, 405, { error: 'method not allowed' })
  } catch (err) {
    console.error('[server]', err)
    return json(res, 400, { error: String(err.message ?? err) })
  }
})

server.listen(PORT, () => {
  console.log(`RONDA listening on http://localhost:${PORT}`)
  if (!process.env.AGENT_ID) console.log('  ! AGENT_ID not set — run `npm run publish:agent` first')
  if (!process.env.PUBLIC_URL) console.log('  ! PUBLIC_URL not set — tool calls need a public HTTPS origin')
})
