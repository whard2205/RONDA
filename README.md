# RONDA — a voice copilot for operator rounds

Built on the [AssemblyAI Voice Agent API](https://www.assemblyai.com/docs/voice-agents/voice-agent-api)
for the AssemblyAI × lablab.ai challenge, September 2026.

---

## The problem

Every plant with rotating equipment runs **operator rounds**: someone walks the site
several times a shift, reads gauges on pumps, aerators, blowers and motors, and writes
the numbers on a clipboard. Those numbers are typed into a system hours later, if at all.

The operator is wearing gloves, their hands are dirty, it is loud, and they are holding a
torch. Typing is not an option. So the data arrives late, trends are spotted late, and a
reading that was already past its alarm limit gets noticed after the bearing has failed.

## What RONDA does

The operator talks. RONDA logs.

> **Operator:** Pump three A.
> **RONDA:** Pump three A, Raw Water Pump 3A at the Intake Bay. Drive end bearing temperature first.
> **Operator:** Seventy eight.
> **RONDA:** Seventy eight degrees. That is above the seventy five alarm limit, and it was
> sixty eight point four last shift. Do you want a work notification raised?
> **Operator:** Yes, and there is a rumble at the drive end.
> **RONDA:** Raised WN-1041 for Pump three A. Next check is non drive end bearing temperature.

At the end of the round it writes the shift report.

## The design decision that matters

**The model never decides whether a reading is safe.**

`log_reading` returns a `status` of `ok`, `warn` or `alarm` that the *server* computed against
that equipment's real limits. The agent reads the verdict out loud; it never does the
comparison and never invents a limit. Threshold arithmetic on live plant equipment is not
something to delegate to a language model, and keeping it server-side means the audit trail
in SQLite is authoritative regardless of what the model said.

Same reasoning behind `correct_last_reading`: operators misspeak numbers constantly. The
correction supersedes the original row rather than overwriting it, so both survive.

---

## Architecture

```
Browser (phone, in the field)
  │  mic → PCM16 mono 24 kHz → base64 → {"type":"input.audio","audio": …}
  │  ← {"type":"reply.audio","data": …}          ← note: in on `audio`, out on `data`
  ▼
wss://agents.assemblyai.com/v1/ws?token=<single-use>
  │   STT · LLM · TTS · turn detection · tool calling   (managed by AssemblyAI)
  │
  └─ HTTP tools ──► https://<your-host>/tools/*   (this server)
                       └─ node:sqlite — assets, limits, readings, notifications

server also:  GET /api/token         mint a single-use browser token
              GET /api/round/:id/events   SSE feed for the UI
              GET /api/round/:id/report   session timeline → LLM Gateway → markdown
```

Tools execute on **AssemblyAI's** servers, not in the browser, so the page never sees a tool
call. The readings table is driven by a server-sent-events feed instead.

Zero npm dependencies. `node:sqlite` ships with Node 22.5+.

---

## Running it

```bash
cp .env.example .env      # add your ASSEMBLYAI_API_KEY
npm run seed              # 6 assets, 26 check points, one historical shift
npm run publish:agent     # creates the agent, writes AGENT_ID back to .env
npm start                 # http://localhost:8787
```

`PUBLIC_URL` must be a **public HTTPS origin that already resolves in DNS** — AssemblyAI
validates the host at agent-create time and rejects private and loopback addresses:

```
422 validation_error — webhook URL host '…' does not resolve
```

So `localhost` cannot work for tool calls. Put the server behind a real domain with TLS
(Caddy does this in one line) before running `publish:agent`.

### Tests

```bash
npm test          # node:test, no dependencies, runs against a throwaway database
```

Forty tests over the parts where being wrong is expensive. On the logic: threshold
bands and their inclusive boundaries, how a spoken asset tag is matched, how an
ambiguous check name is refused, superseding on re-read and on correction, and what
happens when the model loses the round id. On the HTTP surface: the shared-secret
guard on every tool endpoint, the round lifecycle, malformed bodies, and that nothing
outside `web/` can be served — `.env` included.

### Seeing it work without a published agent

Publishing the agent needs a public HTTPS host, which is a deployment step. To exercise
the UI before that exists, run the simulator — it drives the tool endpoints on the same
pacing a real round has:

```bash
npm start                 # terminal 1
npm run demo              # terminal 2 — prints a URL, open it
```

The printed `/?follow=<round_id>` link opens the interface in **follow mode**: read-only,
no microphone, live over SSE. It is also useful on its own — a supervisor can watch a
round from the control room while the operator walks it.

---

## Things that cost time to find out

Collected here because they are not obvious from a first read of the docs.

| | |
|---|---|
| **Tool URLs must resolve at publish time** | Not merely HTTPS — the host is DNS-checked when the agent is created. |
| **Audio field names are asymmetric** | Input audio rides on `audio`; agent audio comes back on `data`. Copying the input handler silently produces silence. |
| **No noise suppression** | `getUserMedia` runs with `noiseSuppression: false` on purpose. AssemblyAI's guidance is that suppression artefacts hurt accuracy more than plant noise does. Echo cancellation stays on so the agent does not hear itself. |
| **`transcript.user.delta` supersedes** | Each delta replaces the previous one for that `item_id`. Concatenating duplicates the whole utterance. |
| **Tool responses are capped at 8 KiB** | Endpoints return pre-summarised JSON, never row dumps. |
| **Tool auth headers are write-only** | Read back as `last_set_at` with the value stripped. |
| **Ambiguity is never resolved by guessing** | "temperature" matches two check points on a pump. The tool refuses and asks, rather than silently logging against the first match. Same rule for a lost `round_id` when more than one round is open. |
| **Sessions must be closed** | `session.end` on teardown and on `beforeunload`; an abandoned socket keeps billing. |

### Passing the round id

HTTP tools are defined once on the stored agent, so they cannot carry a per-session id in
their URL. The round id is injected as a `conversation.message` with `role: "system"` right
after `session.ready`, and the system prompt requires it on every call. If it ever fails to
land, the server attaches the reading to the newest open round rather than dropping it —
losing an operator's reading is worse than attaching it to the obvious round.

---

## Language

The conversation is in **English**, and that is a platform constraint rather than a choice.
The Voice Agent API accepts 18 input languages and currently speaks 6 (English, Italian,
Spanish, German, Portuguese, French). Indonesian is in neither list; it is supported for
pre-recorded transcription through Universal-2 only.

English is the working language of most oil, gas and utilities operations, so the demo is
honest as it stands. Bahasa Indonesia becomes possible for the spoken loop the day
AssemblyAI ships an Indonesian voice.

---

## Data

The plant is invented — six assets with plausible limits (the vibration bands follow the
ISO 10816 zone boundaries). No real plant data is included.

## Licence

MIT.
