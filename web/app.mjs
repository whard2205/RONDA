const SAMPLE_RATE = 24_000
const WS_URL = 'wss://agents.assemblyai.com/v1/ws'

const $ = (id) => document.getElementById(id)
const els = {
  mic: $('mic'), micLabel: $('mic-label'), status: $('status'),
  transcript: $('transcript'), readings: $('readings'), tickets: $('tickets'),
  roundId: $('round-id'), reportBtn: $('report-btn'), report: $('report'),
  operator: $('operator'),
}

const state = {
  roundId: null, sessionId: null, ws: null, sse: null,
  ctx: null, stream: null, node: null, gain: null,
  sources: new Set(), playhead: 0,
  ready: false, live: false, rows: new Map(),
  closing: false, resumeAttempts: 0,
}

// ---------------------------------------------------------------- status ---
function setStatus(text, tone = 'idle') {
  els.status.textContent = text
  els.status.dataset.tone = tone
}

// ------------------------------------------------------------ transcript ---
// transcript.user.delta supersedes the previous delta for the same item_id;
// concatenating them would duplicate the whole utterance.
const bubbles = new Map()

function renderTurn(itemId, who, text, { partial = false } = {}) {
  if (!text) return
  let el = bubbles.get(itemId)
  if (!el) {
    el = document.createElement('div')
    el.className = `turn ${who}`
    bubbles.set(itemId, el)
    els.transcript.append(el)
  }
  el.textContent = text
  el.dataset.partial = String(partial)
  els.transcript.scrollTop = els.transcript.scrollHeight
}

// -------------------------------------------------------------- playback ---
function playChunk(base64) {
  const bin = atob(base64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  const pcm = new Int16Array(bytes.buffer)

  const f32 = new Float32Array(pcm.length)
  for (let i = 0; i < pcm.length; i++) f32[i] = pcm[i] / 32768

  const buf = state.ctx.createBuffer(1, f32.length, SAMPLE_RATE)
  buf.copyToChannel(f32, 0)
  const src = state.ctx.createBufferSource()
  src.buffer = buf
  src.connect(state.gain)

  // Schedule against a running playhead rather than timers: the audio clock
  // absorbs network jitter, wall-clock timers drift and produce gaps.
  const now = state.ctx.currentTime
  if (state.playhead < now) state.playhead = now + 0.04
  src.start(state.playhead)
  state.playhead += buf.duration

  state.sources.add(src)
  src.onended = () => state.sources.delete(src)
}

function flushPlayback() {
  for (const s of state.sources) { try { s.stop() } catch { /* already ended */ } }
  state.sources.clear()
  state.playhead = 0
}

// ------------------------------------------------------------- live data ---
// Tools run on AssemblyAI's servers, so the browser never sees a tool call.
// The readings table is driven by our own server over SSE instead.
function openEventStream(roundId) {
  const sse = new EventSource(`/api/round/${roundId}/events`)
  sse.onmessage = (e) => {
    const { kind, payload } = JSON.parse(e.data)
    if (kind === 'reading') upsertReading(payload)
    else if (kind === 'correction') upsertReading({ ...payload, value: payload.corrected_to, corrected: true })
    else if (kind === 'notification') addTicket(payload)
  }
  return sse
}

function upsertReading(r) {
  const key = `${r.asset}|${r.check}`
  let row = state.rows.get(key)
  if (!row) {
    row = document.createElement('tr')
    state.rows.set(key, row)
    els.readings.querySelector('tbody').append(row)
    els.readings.dataset.empty = 'false'
  }
  const limit = r.limit ? `${r.limit.kind} ${r.limit.value}` : '—'
  const trend = r.trend ?? '—'
  row.dataset.status = r.status
  row.innerHTML = `
    <td class="tag">${r.asset}</td>
    <td>${r.check}${r.corrected ? ' <span class="flag">corrected</span>' : ''}</td>
    <td class="num">${r.value}</td>
    <td class="lim">${limit}</td>
    <td class="trend">${trend}</td>
    <td><span class="pill" data-status="${r.status}">${r.status}</span></td>`
  row.animate?.([{ background: 'rgba(255,255,255,.14)' }, { background: 'transparent' }], { duration: 700 })
}

function addTicket(t) {
  const card = document.createElement('div')
  card.className = 'ticket'
  card.dataset.severity = t.severity
  card.innerHTML = `<strong>${t.ticket_id}</strong> · ${t.asset} · ${t.severity}
    <p>${t.summary ?? ''}</p>
    <small>${t.dispatched ? 'dispatched' : 'recorded'}</small>`
  els.tickets.prepend(card)
  els.tickets.dataset.empty = 'false'
}

// ------------------------------------------------------------- lifecycle ---
async function startRound() {
  els.mic.disabled = true
  setStatus('starting round…', 'busy')

  try {
    const roundRes = await fetch('/api/round', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ operator: els.operator.value.trim() || 'Operator' }),
    })
    if (!roundRes.ok) throw new Error(`could not open a round (${roundRes.status})`)
    const { round_id } = await roundRes.json()
    state.roundId = round_id
    els.roundId.textContent = round_id
    state.sse = openEventStream(round_id)

    setStatus('minting token…', 'busy')
    const tokRes = await fetch('/api/token')
    if (!tokRes.ok) throw new Error(`token mint failed (${tokRes.status})`)
    const { token, agent_id } = await tokRes.json()
    if (!agent_id) throw new Error('AGENT_ID is not configured on the server — run npm run publish:agent')

    // Mic first: if permission is refused there is no point opening a session.
    setStatus('opening microphone…', 'busy')
    state.ctx = new AudioContext({ sampleRate: SAMPLE_RATE })
    await state.ctx.audioWorklet.addModule('/pcm-worklet.mjs')
    state.stream = await navigator.mediaDevices.getUserMedia({
      // Echo cancellation keeps the agent from hearing its own voice.
      // Noise suppression stays OFF on purpose: AssemblyAI's guidance is that
      // its artefacts hurt accuracy more than plant noise does.
      audio: { echoCancellation: true, noiseSuppression: false, autoGainControl: true },
    })
    state.gain = state.ctx.createGain()
    state.gain.connect(state.ctx.destination)

    setStatus('connecting…', 'busy')
    await openSocket(token, agent_id)
  } catch (err) {
    console.error(err)
    setStatus(err.message ?? String(err), 'error')
    await stopRound({ silent: true })
    els.mic.disabled = false
  }
}

function openSocket(token, agentId, { resumeSessionId = null } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(WS_URL)
    url.searchParams.set('token', token)
    const ws = new WebSocket(url)
    state.ws = ws
    let settled = false

    ws.onopen = () => {
      // Resuming carries the previous conversation across a dropped connection;
      // the server only honours it for a short window after the drop.
      ws.send(JSON.stringify(
        resumeSessionId
          ? { type: 'session.resume', session_id: resumeSessionId }
          : { type: 'session.update', session: { agent_id: agentId } },
      ))
    }

    ws.onmessage = async (ev) => {
      const msg = JSON.parse(ev.data)
      switch (msg.type) {
        case 'session.ready': {
          const resumed = state.resumeAttempts > 0
          state.resumeAttempts = 0
          state.sessionId = msg.session_id
          state.ready = true
          fetch(`/api/round/${state.roundId}/session`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ session_id: msg.session_id }),
          }).catch(() => {})

          // Hand the agent the round id it must echo back on every tool call.
          // If this ever fails to land, the server attaches readings to the
          // newest open round rather than dropping them.
          ws.send(JSON.stringify({
            type: 'conversation.message',
            role: 'system',
            content: `round_id for this round is ${state.roundId}. Include it in every tool call.`,
          }))

          if (!resumed) startMic()
          setStatus(resumed ? 'reconnected' : 'listening', 'live')
          els.mic.disabled = false
          els.mic.dataset.active = 'true'
          els.micLabel.textContent = 'End round'
          state.live = true
          if (!settled) { settled = true; resolve() }
          break
        }
        case 'input.speech.started':
          setStatus('hearing you', 'live')
          break
        case 'transcript.user.delta':
          renderTurn(msg.item_id, 'user', msg.delta ?? msg.transcript, { partial: true })
          break
        case 'transcript.user':
          renderTurn(msg.item_id, 'user', msg.transcript)
          break
        case 'reply.started':
          setStatus('replying', 'live')
          break
        case 'reply.audio':
          // Note the asymmetry: audio in arrives on `audio`, audio out on `data`.
          playChunk(msg.data)
          break
        case 'transcript.agent':
          renderTurn(msg.item_id ?? `agent-${msg.reply_id}`, 'agent', msg.transcript ?? msg.text)
          break
        case 'reply.done':
          if (msg.status === 'interrupted') flushPlayback()
          setStatus('listening', 'live')
          break
        case 'session.ended':
          setStatus('round ended', 'idle')
          break
        case 'session.error':
          console.error('session.error', msg)
          setStatus(msg.message ?? 'session error', 'error')
          break
      }
    }

    ws.onerror = () => { if (!settled) { settled = true; reject(new Error('websocket failed to connect')) } }
    ws.onclose = () => {
      state.ready = false
      if (!settled) { settled = true; reject(new Error('websocket closed before the session was ready')) }
      // An operator walking a plant loses signal. Losing the connection must not
      // silently end the round and drop the readings that follow.
      if (!state.closing && state.live && state.sessionId) { attemptResume(); return }
      state.live = false
      finishUi()
    }
  })
}

const RESUME_TRIES = 3

async function attemptResume() {
  if (state.resumeAttempts >= RESUME_TRIES) {
    state.live = false
    setStatus('connection lost — start a new round to continue', 'error')
    // The round stays open server-side, so a fresh session keeps appending to it.
    finishUi()
    return
  }
  state.resumeAttempts++
  setStatus(`reconnecting (${state.resumeAttempts}/${RESUME_TRIES})…`, 'busy')
  await new Promise((r) => setTimeout(r, 400 * state.resumeAttempts))

  try {
    // Tokens are single-use, so a reconnect needs a fresh one.
    const { token, agent_id } = await (await fetch('/api/token')).json()
    await openSocket(token, agent_id, { resumeSessionId: state.sessionId })
  } catch {
    attemptResume()
  }
}

function startMic() {
  const src = state.ctx.createMediaStreamSource(state.stream)
  state.node = new AudioWorkletNode(state.ctx, 'pcm-worklet')
  state.node.port.onmessage = ({ data }) => {
    if (!state.ready || state.ws?.readyState !== WebSocket.OPEN) return
    const bytes = new Uint8Array(data)
    let bin = ''
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
    state.ws.send(JSON.stringify({ type: 'input.audio', audio: btoa(bin) }))
  }
  src.connect(state.node)
  // Keep the worklet pulling without routing the mic back to the speakers.
  const mute = state.ctx.createGain()
  mute.gain.value = 0
  state.node.connect(mute).connect(state.ctx.destination)
}

async function stopRound({ silent = false } = {}) {
  state.closing = true
  state.ready = false
  try { state.ws?.readyState === WebSocket.OPEN && state.ws.send(JSON.stringify({ type: 'session.end' })) } catch {}
  // Give the server a moment to acknowledge before tearing the socket down.
  await new Promise((r) => setTimeout(r, 250))
  try { state.ws?.close() } catch {}
  flushPlayback()
  state.node?.port && (state.node.port.onmessage = null)
  try { state.node?.disconnect() } catch {}
  state.stream?.getTracks().forEach((t) => t.stop())
  try { await state.ctx?.close() } catch {}
  state.sse?.close()
  if (state.roundId) {
    await fetch(`/api/round/${state.roundId}/end`, { method: 'POST' }).catch(() => {})
  }
  state.live = false
  state.closing = false
  if (!silent) setStatus('round ended', 'idle')
  finishUi()
}

function finishUi() {
  els.mic.dataset.active = 'false'
  els.micLabel.textContent = 'Start round'
  els.mic.disabled = false
  if (state.roundId) els.reportBtn.hidden = false
}

async function generateReport() {
  els.reportBtn.disabled = true
  els.reportBtn.textContent = 'Writing report…'
  try {
    const res = await fetch(`/api/round/${state.roundId}/report`)
    const data = await res.json()
    els.report.hidden = false
    els.report.textContent = data.ok ? data.markdown : `Report unavailable: ${data.error}\n\n${data.fallback ?? ''}`
  } catch (err) {
    els.report.hidden = false
    els.report.textContent = `Report failed: ${err}`
  } finally {
    els.reportBtn.disabled = false
    els.reportBtn.textContent = 'Regenerate report'
  }
}

// Follow mode: open ?follow=<round_id> to watch a round read-only, without a
// voice session. Used to exercise the UI without a published agent, and useful
// on its own — a supervisor can watch a round from the control room.
async function followRound(roundId) {
  state.roundId = roundId
  els.roundId.textContent = roundId
  document.querySelector('.control').hidden = true
  setStatus('following', 'live')

  try {
    const res = await fetch(`/api/round/${roundId}`)
    if (!res.ok) throw new Error(`round ${roundId} not found`)
    const { readings, notifications } = await res.json()
    for (const r of readings) {
      upsertReading({ asset: r.asset_tag, check: r.label, value: r.value, status: r.status, limit: r.limit })
    }
    for (const n of [...notifications].reverse()) {
      addTicket({ ticket_id: n.ticket_id, asset: n.asset_tag, severity: n.severity, summary: n.summary, dispatched: Boolean(n.delivered) })
    }
    state.sse = openEventStream(roundId)
    els.reportBtn.hidden = false
  } catch (err) {
    setStatus(err.message ?? String(err), 'error')
  }
}

const following = new URLSearchParams(location.search).get('follow')
if (following) followRound(following)

els.mic.addEventListener('click', () => (state.live ? stopRound() : startRound()))
els.reportBtn.addEventListener('click', generateReport)
window.addEventListener('beforeunload', () => {
  // Never leave a socket hanging: an abandoned session keeps billing.
  try { state.ws?.readyState === WebSocket.OPEN && state.ws.send(JSON.stringify({ type: 'session.end' })) } catch {}
})
