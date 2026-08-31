// Boots the real HTTP server on an ephemeral port against a throwaway database.
import { test, describe, after } from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.RONDA_DB = join(mkdtempSync(join(tmpdir(), 'ronda-http-')), 'test.db')
process.env.ASSEMBLYAI_API_KEY = 'test-key-not-used'
process.env.TOOL_SECRET = 'test-secret'
process.env.AGENT_ID = 'test-agent-id'
process.env.PORT = '0'

await import('../server/db.mjs')
await import('../server/seed.mjs')
const { server } = await import('../server/index.mjs')
if (!server.listening) await once(server, 'listening')
const BASE = `http://127.0.0.1:${server.address().port}`

after(() => server.close())

const get = (p, init) => fetch(BASE + p, init)
const tool = (p, body) =>
  fetch(BASE + p, {
    method: 'POST',
    headers: { 'x-ronda-key': 'test-secret', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

async function newRound() {
  const res = await fetch(BASE + '/api/round', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ operator: 'HTTP test' }),
  })
  return (await res.json()).round_id
}

describe('tool endpoint authorisation', () => {
  test('rejects a call with no shared secret', async () => {
    const res = await get('/tools/asset-checklist?asset_tag=P-3A')
    assert.equal(res.status, 401)
  })

  test('rejects a call with the wrong secret', async () => {
    const res = await get('/tools/asset-checklist?asset_tag=P-3A', { headers: { 'x-ronda-key': 'wrong' } })
    assert.equal(res.status, 401)
  })

  test('accepts the right secret', async () => {
    const res = await get('/tools/asset-checklist?asset_tag=P-3A', { headers: { 'x-ronda-key': 'test-secret' } })
    assert.equal(res.status, 200)
    assert.equal((await res.json()).tag, 'P-3A')
  })

  test('404s an unknown tool', async () => {
    const res = await tool('/tools/nope', {})
    assert.equal(res.status, 404)
  })
})

describe('round lifecycle', () => {
  test('creates, reads, closes', async () => {
    const id = await newRound()
    assert.match(id, /^R-\d{4}-\d{2}-\d{2}-[A-Z0-9]{4}$/)

    await tool('/tools/log-reading', { round_id: id, asset_tag: 'P-3A', check: 'vibration', value: 8.4 })

    const state = await (await get(`/api/round/${id}`)).json()
    assert.equal(state.readings.length, 1)
    assert.equal(state.readings[0].status, 'alarm')
    // the limit is computed server-side for the follow-mode backfill
    assert.deepEqual(state.readings[0].limit, { kind: 'high alarm', value: 7.1 })

    assert.equal((await get(`/api/round/${id}/end`, { method: 'POST' })).status, 200)
    const closed = await (await get(`/api/round/${id}`)).json()
    assert.ok(closed.round.ended_at, 'round should be closed')
  })

  test('404s an unknown round', async () => {
    assert.equal((await get('/api/round/R-9999-99-99-ZZZZ')).status, 404)
  })

  test('records the session id', async () => {
    const id = await newRound()
    await get(`/api/round/${id}/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session_id: 'sess-123' }),
    })
    const state = await (await get(`/api/round/${id}`)).json()
    assert.equal(state.round.session_id, 'sess-123')
  })
})

describe('static files and safety', () => {
  test('serves the UI at the root', async () => {
    const res = await get('/')
    assert.equal(res.status, 200)
    assert.match(res.headers.get('content-type'), /text\/html/)
    assert.match(await res.text(), /RONDA/)
  })

  test('serves the audio worklet as javascript', async () => {
    const res = await get('/pcm-worklet.mjs')
    assert.equal(res.status, 200)
    assert.match(res.headers.get('content-type'), /javascript/)
  })

  test('does not serve files outside the web directory', async () => {
    for (const attempt of ['/../.env', '/../../.env', '/%2e%2e/.env', '/../package.json']) {
      const res = await get(attempt)
      assert.ok(res.status === 404 || res.status === 403, `${attempt} returned ${res.status}`)
      const body = await res.text()
      assert.ok(!body.includes('ASSEMBLYAI_API_KEY'), `${attempt} leaked env contents`)
    }
  })

  test('healthz reports ok', async () => {
    assert.deepEqual(await (await get('/healthz')).json(), { ok: true })
  })

  test('rejects a non-GET to an unknown path', async () => {
    assert.equal((await get('/nope', { method: 'DELETE' })).status, 405)
  })
})

describe('malformed input', () => {
  test('rejects a body that is not JSON', async () => {
    const res = await fetch(BASE + '/tools/log-reading', {
      method: 'POST',
      headers: { 'x-ronda-key': 'test-secret', 'content-type': 'application/json' },
      body: 'not json at all',
    })
    assert.equal(res.status, 400)
  })

  test('an ambiguous check name is refused over HTTP', async () => {
    const id = await newRound()
    const body = await (await tool('/tools/log-reading', {
      round_id: id, asset_tag: 'P-3A', check: 'temperature', value: 78,
    })).json()
    assert.equal(body.ok, false)
    assert.match(body.error, /more than one check point/)
  })
})
