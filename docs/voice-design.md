# Full-duplex voice — design

Status: **proposal, not implemented.** No code in this document has been
written to the repository. It exists to be argued with before Phase 1 starts.

The goal is addition, not replacement: the text path
(`user.message` → n8n → `assistant.message`) stays byte-for-byte as it is.
Voice becomes a second path that reuses the gateway's auth, `userId`,
`sessionId`, `connectionId` and n8n client, and never puts audio through n8n.

Revision note: an earlier draft of this file recommended OpenAI Realtime with a
browser-direct WebRTC connection. §1 explains why that was wrong for a research
project, and §11 explains how to migrate to it later if the free path runs out.

---

## 1. Engine selection

### The correction that drives everything below

The first draft rejected "audio through the gateway" on the grounds that it
means running a WebRTC stack in Node. **That reasoning conflated two different
things.** Server-relayed audio is only expensive when the *engine* speaks
WebRTC. Gemini Live's client protocol is a plain **WebSocket carrying PCM16
frames** — and `gateway/package.json` already depends on `ws`. A gateway relay
for that is a socket pump, not a media server. It is small, boring code.

So the earlier trade-off was overstated, and the choice reopens. That matters
because of the second finding:

### Gemini Live has a genuinely free tier — measured, not assumed

[Certain] **Verified on 2026-09-06** against a real free-tier key (project
`Voice Agent`, billing not enabled) with `scratch/live-api-probe.js`. Two
models returned native audio:

| Model | Result |
| --- | --- |
| `models/gemini-3.1-flash-live-preview` | **40,830 bytes of audio** |
| `models/gemini-2.5-flash-native-audio-preview-09-2025` | **34,560 bytes of audio** |
| `models/gemini-2.5-flash-preview-native-audio-dialog` | not found (stale name) |
| `models/gemini-2.0-flash-live-001` | not found (stale name) |

Use **`gemini-3.1-flash-live-preview`** as the default. It is a preview model,
so pin the name in config and expect to change it; the `2.5` native-audio model
is the fallback if the preview is withdrawn.

The probe also confirmed the wire protocol: `setup` → `setupComplete` →
`clientContent` → `serverContent.modelTurn.parts[].inlineData`, with audio
returned as base64 in `inlineData`. §4 and §5 rest on this rather than on
secondary sources.

Reported free-tier shape (still unverified — the probe measured access, not
quota):

- 5–15 requests/minute, 250k tokens/minute, 100–1,000 requests/day
- Audio-only sessions capped at ~15 minutes; a single connection ~10 minutes

For one person talking to their own assistant, a "request" is a *session*, not
an utterance. 100–1,000 sessions/day is not a constraint you will feel. The
10-minute connection cap is real and must be engineered around (§7), but it is
a reconnect loop, not a blocker.

### The full comparison

| Option | Cost | Transport to browser | Full duplex | Migration cost away |
| --- | --- | --- | --- | --- |
| **Gemini Live free tier** | **$0** | WS via gateway relay | Yes | Low — adapter swap |
| Gemini Live paid | ~$0.005–0.01/min | same | Yes | — |
| OpenAI `gpt-realtime-2.1-mini` | ~$0.016/min | **WebRTC browser-direct** | Yes | — |
| OpenAI `gpt-realtime-2.1` | ~$0.05/min | WebRTC browser-direct | Yes | — |
| Self-host Unmute/Moshi | $0 software, GPU required | WS or WebRTC, yours | Yes (Moshi is natively full-duplex) | High |

Certainty notes, because these age badly and I could not verify them at source:

- [Certain] Free-tier access to native audio is **measured** (see above). The
  *prices* and *quota numbers* are not — `developers.openai.com` and
  `ai.google.dev` are blocked by this environment's egress proxy, so those come
  from secondary sources.
- [Certain] The AI Studio **Rate Limit page cannot verify this** — it reports
  peak usage per model over 28 days, so it is empty until you have already made
  calls. The "All models" toggle does not change that. Do not treat an empty
  table as evidence of anything.
- [Certain] OpenAI Realtime supports browser-direct WebRTC with a server-minted
  ephemeral key. This is the documented flow.
- [Likely] Gemini Live has ephemeral tokens but **no browser-direct WebRTC** —
  client-to-server is WebSocket. There is an open request on
  `google-gemini/live-api-web-console` asking for WebRTC; Pipecat's
  `gemini-webrtc-web-simple` exists to bridge the gap.
- [Likely] Kyutai's Unmute needs **16 GB VRAM** (STT 2.5 + TTS 5.3 + LLM 6.1),
  CUDA, x86_64, Linux or WSL. Moshi hits ~200 ms on an L4.
- [Guessing] Free-tier RPM/RPD figures vary between sources. Treat the shape as
  right and the exact numbers as approximate.

### Recommendation

**Start on Gemini Live free tier, relayed through the gateway over WebSocket,
behind an engine adapter.**

Three reasons, in order of weight:

1. **It costs nothing.** For a research project, a $0 path that is genuinely
   full-duplex beats a $15/month path that is marginally better. You can run it
   for months and learn what you actually need before paying for anything.
2. **The relay is cheap now that the reasoning is corrected.** WS-in, WS-out,
   PCM16 both ways, using a dependency the gateway already has.
3. **It keeps the API key server-side with no ephemeral-token dance**, which is
   strictly simpler than the browser-direct flow and removes a whole class of
   key-expiry bugs from Phase 1.

**The honest cost of this choice**, stated plainly because it contradicts your
earlier answer:

- Audio transits your gateway. That is one extra network hop of latency versus
  browser-direct. [Guessing] on the order of 20–80 ms depending on where the
  gateway runs relative to you — noticeable in a barge-in benchmark, probably
  not noticeable in conversation.
- Your gateway now carries continuous audio, so its bandwidth and CPU profile
  changes from "occasional JSON" to "two audio streams per active session."
  [Likely] fine for one user on any VPS; it is the thing that would break first
  at ten users.
- If the gateway restarts, the voice session dies. Text messages survive
  because they are request/response; a relayed audio stream does not.

**When to move to OpenAI Realtime:** when free-tier limits bite, when you want
the browser-direct latency, or when Gemini's tool-calling behaviour proves
worse for your n8n workflows. §11 makes that a bounded change.

**When to self-host (Unmute/Moshi):** when you want zero external dependency
and already have a 16 GB CUDA GPU idle. Moshi is the only option here that is
*natively* full-duplex rather than full-duplex-by-cancellation, which is
academically the most interesting. [Likely] not worth it as a starting point —
it replaces a free API with an ops burden.

---

## 2. Topology

```
  Browser / PWA
       │
       ├───── text WS ──────────────► Jarvis Gateway ──► n8n ──► tools
       │      (unchanged)                   │
       │                                    │  holds API key
       └───── voice WS ─────────────────────┤  relays PCM16
              (same connection,             │
               voice.audio frames)          ▼
                                       Gemini Live
```

One WebSocket. The existing connection carries both the text protocol and the
voice protocol — `voice.audio` frames are just another event. This is the
strongest form of "reuse the existing gateway infrastructure": no second
socket, no second auth, no second session registry.

[Likely] binary frames should be used for audio rather than base64-in-JSON —
base64 costs ~33% bandwidth and a JSON parse per 20 ms chunk. The `ws` library
handles binary natively; the design is a small binary header (`voiceSessionId`
+ sequence) followed by raw PCM16. Control events stay JSON.

Audio still never touches n8n. The gateway authenticates, owns the `sessionId`,
decides what tools voice may call, and runs the n8n path.

**Trust boundary.** Because the gateway holds the model connection, tool calls
arrive from the *model* to the *gateway* directly — the browser never sees or
relays them. This is strictly better than the browser-direct design, where a
compromised client could forge tool calls. That is an unplanned security win
from the corrected reasoning, and worth noting.

---

## 3. Gateway changes

New files, all additive:

```
gateway/src/
├── voice/
│   ├── index.js        # handleVoiceEvent(ctx, connection, event) — dispatch
│   ├── sessions.js     # VoiceSessionStore: lifecycle, TTL, reconnect
│   ├── engine.js       # adapter interface — see §11
│   ├── engines/gemini.js
│   └── tools.js        # model tool call → n8n → result back to model
```

Touched files, minimally:

- `src/handlers.js` — one added branch: `if (event.event.startsWith('voice.'))
  return voice.handle(...)`. The existing `switch` is untouched.
- `src/server.js` — the `ws.on('message')` handler learns to route binary
  frames to the voice relay instead of `parseInbound`. One `if`.
- `src/config.js` — a `voice` block (`enabled`, `provider`, `apiKey`, `model`,
  `voice`, `maxSessionMs`), off unless `VOICE_ENABLED=true`. Warnings not
  throws, matching the existing style.
- `/health` reports `voiceSessions`.

`VoiceSessionStore` mirrors `ExecutionStore`: in-memory `Map`, `unref`'d
timers, dropped on connection close. A voice session holds `voiceSessionId`,
`connectionId`, `userId`, `sessionId`, the upstream engine socket, and the set
of in-flight tool calls.

---

## 4. Protocol

Same envelope as everything else (`id` / `type` / `event` / `timestamp` /
`sessionId` / `data`). Control frames are JSON; audio frames are binary.

### Client → Gateway

| Event | `data` | Notes |
| --- | --- | --- |
| `voice.session.start` | `{ voice?, model? }` | Validated against an allowlist. The client cannot supply instructions — it must not be able to rewrite Jarvis's prompt. |
| `voice.session.end` | `{ voiceSessionId }` | Idempotent; also implied by disconnect. |
| *(binary)* | header + PCM16 | Microphone audio, ~20 ms chunks. |
| `voice.interrupt` | `{ voiceSessionId }` | Optional explicit barge-in (e.g. a tap-to-stop button). Model VAD handles the normal case. |

### Gateway → Client

| Event | `data` |
| --- | --- |
| `voice.session.started` | `{ voiceSessionId, model, voice, sampleRate, expiresAt }` |
| `voice.session.ended` | `{ voiceSessionId, reason }` |
| *(binary)* | header + PCM16 — assistant audio |
| `voice.speech.started` | `{ voiceSessionId }` — user began speaking; **client must flush playback** |
| `voice.transcript` | `{ voiceSessionId, role, text, final }` |
| `voice.tool.started` / `voice.tool.finished` | `{ callId, name }` — for the UI status line |
| `voice.error` | `{ code, message, voiceSessionId? }` |

Two error codes join `ERROR_CODES`: `VOICE_UNAVAILABLE` (not configured, engine
refused, or free-tier quota exhausted) and `VOICE_LIMIT`.

Note there is no `voice.tool.call` client event and no `clientSecret` — both
existed only because of the browser-direct design. The protocol got smaller.

---

## 5. Full duplex and barge-in

The realtime model does the hard parts — VAD, turn detection, streaming
generation. The gateway and browser must not undo them. Four rules:

1. **The microphone track is never muted while the assistant speaks.** This is
   the whole requirement. A half-duplex implementation is one
   `track.enabled = false` away, and it is the easiest way to accidentally ship
   the thing your doc says not to ship.
2. **The gateway relays mic audio upstream unconditionally**, including while
   it is relaying assistant audio downstream. No half-open state machine.
3. **On speech-start the browser flushes its playback buffer immediately** —
   do not wait for the gateway. Whatever audio is already queued in the
   `AudioContext` must be dropped, not played out. [Likely] the #1 source of
   "it kept talking after I interrupted" bugs is buffered audio, not slow
   cancellation.
4. **The gateway cancels generation upstream in the same tick** and discards
   any in-flight tool call belonging to the abandoned turn, so a stale result
   is never spoken.

Conversation state survives interruption because the model owns it: the
truncated turn stays in its context as "assistant said this much." The gateway
must not attempt to reconstruct or replay it.

**Echo.** Because the mic is live while the speaker plays, `getUserMedia` must
set `echoCancellation`, `noiseSuppression` and `autoGainControl`, and the user
should be warned that speakerphone without a headset will make Jarvis interrupt
itself. [Likely] the #1 source of "it barges in on itself" reports.

[Guessing] Exact Gemini Live event names for speech-start and cancellation need
reading out of current docs at implementation time — they could not be fetched
this session.

---

## 6. Tool bridge to n8n

```
model emits a tool call
      │  (engine WebSocket)
      ▼
   gateway  ──► n8n.buildPayload + n8n.callWebhook ──► existing Jarvis tools
      │                                                        │
      └──────────────── tool result back upstream ◄────────────┘
                                │
                                ▼
                       model speaks the result
```

`src/n8n.js` is reused unchanged. A voice tool call becomes the same webhook
payload a text message makes, with `source: 'voice'` and the same `sessionId` —
so from n8n's side, voice is just another entry point into the conversation it
already knows.

Three things the gateway owns:

- **The tool allowlist**, configured into the engine session at start. The
  browser is not involved at all.
- **Latency handling.** n8n runs can take tens of seconds; a realtime
  conversation cannot sit silent that long. Return a `{ status: 'working' }`
  result for slow calls and push the real answer as a follow-up, letting the
  model say "let me check" and speak the result when it lands. [Guessing]
  threshold around 2s, wants tuning.
- **Approvals.** A voice tool call that trips the existing human-in-the-loop
  path emits the ordinary `approval.request` on the text channel. The voice
  session speaks the question; the answer may come by voice *or* by tapping the
  existing UI. `handleApprovalRespond` is unchanged.

---

## 7. Session, reconnect, and memory

Voice and text share one `sessionId` — the connection's stable
`session_<userId>` default. `voiceSessionId` is a *sub*-session: one continuous
audio conversation, not a new conversational thread.

**The 10-minute connection cap is a first-class design constraint, not a
footnote.** [Likely] Gemini Live caps a single connection around 10 minutes and
an audio session around 15. The gateway must transparently re-establish the
upstream socket and replay conversation context so the user hears nothing. This
belongs in **Phase 2**, not Phase 6 — a voice assistant that dies mid-sentence
every ten minutes is not usable, and discovering this late means rewriting the
session store.

Other consequences:

- Transcripts are mirrored into the text UI as ordinary messages, so the
  conversation reads back as one history.
- [Guessing] Whether transcripts should also be written into Jarvis's n8n-side
  memory, and at what granularity, is undecided. Every *final* transcript is
  simple and probably right; partials are definitely wrong. Your call before
  Phase 5.

---

## 8. Browser

```
gateway/public/voice/
├── session.js      # voice.* over the existing WS; owns lifecycle
├── capture.js      # getUserMedia → AudioWorklet → PCM16 → binary frames
├── playback.js     # PCM16 → AudioWorklet → speaker, instant flush
└── ui.js           # push-to-talk / always-on toggle, level meter, state
```

[Likely] `AudioWorklet` rather than the deprecated `ScriptProcessorNode`, and
resampling to whatever rate the engine wants (commonly 16 kHz up, 24 kHz down)
in the worklet. This is the fiddliest code in the project and deserves its own
spike before Phase 1 is estimated.

`public/app.js` (847 lines, single-file) gains a small integration point and
nothing else. The voice layer is lazy-loaded on first use so the text PWA does
not pay for it. [Likely] `public/sw.js` needs its cache list extended.

---

## 9. Phases

| Phase | Deliverable | Status |
| --- | --- | --- |
| 1 | Binary audio frames end to end, echo engine, AudioWorklet capture/playback | **Done.** Verified by ear locally. |
| 2 | Gemini adapter, session store, transparent reconnect across the ~10 min cap | **Done.** Verified locally; reconnect proven against a fake upstream, not yet observed in a real 10-minute session. |
| 3 | Barge-in: always-on mode, engine VAD, playback flush | **Done.** Verified in production. |
| 4 | Tool bridge to n8n, allowlist, slow-call handling, approvals | Not started. |
| 5 | Transcript mirroring into the text UI, memory write-back | Partial — `voice.transcript` reaches the client and renders on the voice panel, but is not mirrored into the chat transcript or written to memory. |
| 6 | `VOICE_ENABLED` config, compose wiring, docs | **Done.** Deployed to the VPS on 2026-09-06 with the text path intact. |

Tests: 49 pass. `gateway/test/roundtrip.test.js` — the text-path contract — has
passed **unmodified** at every phase. That is the gate: if a voice change ever
requires editing a text test, the promise has been broken.

The engine tests run against a fake upstream. They prove the reconnect and
mode logic, not that the provider accepts our message shapes — production use
proves the latter.

## 10. Cost model

| Scenario | Monthly |
| --- | --- |
| Gemini Live free tier, within quota | **$0** |
| Gemini Live paid, 30 min/day | ~$5–9 |
| OpenAI `-mini`, 30 min/day | ~$15 |
| OpenAI flagship, 30 min/day | ~$45 |
| Self-hosted Unmute on a rented 16 GB GPU | ~$100–300 if always on |

[Guessing] All arithmetic on unverified rates. Self-hosting is the *most*
expensive option unless the GPU already exists and is otherwise idle — the
"free software" framing hides the hardware.

---

## 11. Designing for migration

You asked whether this can be upgraded later. It can, if the boundary is drawn
now. Three rules make an engine swap a bounded change:

1. **The `voice.*` protocol is transport-agnostic.** Nothing in §4 mentions
   Gemini, WebSocket, or PCM sample rates as protocol constants — the client
   learns `sampleRate` from `voice.session.started`. A browser written against
   this protocol survives the swap.
2. **The adapter interface is narrow.** An engine implements: `open(session)`,
   `sendAudio(chunk)`, `cancel()`, `close()`, and emits `audio`, `transcript`,
   `speechStarted`, `toolCall`. Everything else — n8n, approvals, sessions,
   auth — lives outside it.
3. **The one thing that does *not* survive is the topology.** Moving to OpenAI
   Realtime means moving audio out of the gateway and into a browser-direct
   WebRTC peer connection. The adapter cannot hide that. Concretely the change
   is: add `voice.session.start` → ephemeral key minting; replace `capture.js`
   and `playback.js` with `transport.js` (RTCPeerConnection + data channel);
   move tool-call relay to the client. [Guessing] a few days, not a rewrite —
   the gateway, protocol semantics, n8n bridge and UI all survive.

So: **the migration is real but bounded, and the free path is worth taking
first.** The failure mode to avoid is letting Gemini-specific frame shapes leak
into `handlers.js` or `app.js`. If they stay inside `voice/engines/gemini.js`,
you keep the option.

---

## 12. Open questions

1. ~~Free-tier verification~~ — **closed 2026-09-06.** Native audio returns on
   a free key; see §1. The remaining unknown is where the *quota* ceiling sits,
   which only sustained use will reveal.
2. ~~Activation~~ — **closed 2026-09-06.** Both modes shipped: push-to-talk
   (engine VAD off, no silence on the wire) and always-listening (engine VAD on,
   genuine barge-in). Chosen per session by the client.
3. **Memory write-back** — every final transcript, or only turns that invoked a
   tool? Blocks Phase 5. Partials are definitely wrong; beyond that, undecided.
4. **Tool surface** — does voice get every tool the text agent has, or a reduced
   set? Blocks Phase 4. Anything destructive reached by voice should [Likely]
   require an approval even when the text path does not — a misheard word is a
   failure mode typing does not have.
