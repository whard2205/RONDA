# Submission pack

Draft copy and shot list for the lablab.ai submission form. Everything here is
editable — it is a starting point, not a finished script.

---

## Basic information

**Project title**

> RONDA — a voice copilot for operator rounds

**Short description** (one line)

> Plant operators walk their inspection rounds and just talk. RONDA logs every
> reading, checks it against the equipment's limits, and raises the work
> notification before the shift ends.

**Long description**

> Every plant with rotating equipment runs operator rounds: someone walks the site
> several times a shift, reads gauges on pumps, aerators and blowers, and writes the
> numbers on a clipboard. Those numbers reach a system hours later, if at all. The
> operator is wearing gloves, their hands are dirty, it is loud, and they are holding
> a torch — typing was never an option. So trends are spotted late, and a reading
> that was already past its alarm limit gets noticed after the bearing has failed.
>
> RONDA replaces the clipboard with a conversation. The operator names an asset, the
> agent loads its check points, and then they simply speak the numbers. Each reading
> is logged, compared against that equipment's real limits, and read back out loud.
> When something breaches a limit the agent says so, quotes the limit, recalls what
> the same point read last shift, and offers to raise a work notification. At the end
> of the round it writes the shift report.
>
> The design decision we care most about: **the model never decides whether a reading
> is safe.** The `log_reading` tool returns a status the server computed against the
> equipment's limits, and the agent only reads that verdict out. Threshold arithmetic
> on live plant equipment is not something to delegate to a language model, and
> keeping it server-side means the audit trail is authoritative regardless of what
> the model said. The same principle shapes the shift report: exceptions are
> pre-filtered server-side before the summarising model ever sees them.
>
> Built on the AssemblyAI Voice Agent API — one WebSocket carrying speech in and
> speech out, with turn detection tuned for dictation rather than conversation
> (operators pause while they read a gauge), keyterms biased toward asset tags and
> rotating-equipment vocabulary, and four server-side HTTP tools that AssemblyAI
> invokes directly. The end-of-round report is generated from the session timeline
> through the AssemblyAI LLM Gateway.
>
> Zero npm dependencies. The whole thing is plain Node.js.

**Technology tags**

> AssemblyAI, Voice Agent API, Universal-3.5 Pro, LLM Gateway, Node.js, SQLite,
> WebSockets, Speech-to-Text, Voice AI

**Category tags**

> Voice agents, Industrial / Manufacturing, Operations, Safety, Productivity

---

## Video — 90 seconds

Open on the problem. Never open on architecture: judges watch dozens of these and
the first ten seconds decide whether they lean in.

| Time | Shot | Voiceover / audio |
|---|---|---|
| 0:00–0:12 | Plant footage: pump or aerator running, loud. Gloved hand holding a clipboard, pen hovering. | "Every plant runs operator rounds. Someone walks the site, reads the gauges, and writes it on paper." |
| 0:12–0:20 | Same hand, gloves on, failing to use a phone keyboard. | "The data gets typed in hours later. Sometimes never." |
| 0:20–0:30 | Phone in hand, thumb taps **Start round**. Agent greets. | Let the agent's own voice carry it. No voiceover. |
| 0:30–1:00 | **The core demo, unedited.** Speak three readings. The vibration reading hits alarm. Agent quotes the limit and last shift's value, offers a notification, you say yes. | Real audio, ambient plant noise left in. This is the moment that sells it. |
| 1:00–1:12 | Cut to a second screen in follow mode, filling in live — supervisor's view. | "Anyone can watch the round as it happens." |
| 1:12–1:25 | End the round. Shift report renders. Scroll it. | "And the shift report writes itself." |
| 1:25–1:35 | Simple diagram or on-screen text. | "One thing we insisted on: the model never decides if a reading is safe. The server checks the limits. The agent just reads the verdict." |
| 1:35–1:40 | Logo, URL. | — |

Notes for recording:
- **Leave the plant noise in.** It is the whole point, and Universal-3.5 Pro handles it.
  A clean studio recording actively undersells the product.
- Do the correction bit if there is room: say a wrong number, correct yourself, watch the
  row update and the status flip. It reads as a product someone actually thought about.
- You already have usable industrial footage in this workspace — `JunkfiLE/KenapaButuhAerator.mp4`,
  `Dewa File/AnimasiThrustBearing.mp4`, `JunkfiLE/Animasi_Thurst_Real.mp4` and the aerator
  storyboard panels in `aset-video/`. Check the licensing on anything from the internship
  before reusing it publicly.

---

## Cover image

Split composition. Left: a gloved hand holding a phone showing RONDA mid-round, one
row glowing red. Right: the pump it is standing in front of, slightly out of focus.
Title bottom-left. Resist putting an architecture diagram on the cover.

---

## Checklist

- [x] Public GitHub repository with MIT licence
- [ ] Repository pushed and made public
- [ ] Application URL live with seed data for judges
- [ ] Video presentation
- [ ] Slide presentation — include one slide on why English first, Bahasa Indonesia on the roadmap
- [ ] Cover image
- [x] Short description, long description, tags (drafted above)

## Known gaps to be honest about

- The conversation is English-only. The Voice Agent API accepts 18 input languages and
  speaks 6; Indonesian is in neither. Put it on the roadmap slide rather than hiding it.
- The shift report currently runs on `qwen3.5-4b-32k-fast`, the only LLM Gateway model
  this account can reach. Quality improves noticeably once hackathon credits unlock the
  larger models — set `LLM_MODEL` in `.env`.
