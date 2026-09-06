# Full-duplex voice — design

Status: **proposal, not implemented.** No code in this document has been
written to the repository. It exists to be argued with before Phase 1 starts.

The goal is addition, not replacement: the text path
(`user.message` → n8n → `assistant.message`) stays byte-for-byte as it is.
Voice becomes a second path that reuses the gateway's auth, `userId`,
`sessionId`, `connectionId` and n8n client, and never puts audio through n8n.

---

## 1. Engine selection

### What was compared

| Engine | Model | Browser-direct? | Audio in $/1M tok | Audio out $/1M tok | ≈ $/conversation-min |
| --- | --- | --- | --- | --- | --- |
| OpenAI Realtime | `gpt-realtime-2.1` | **Yes — WebRTC + ephemeral token** | 32 | 64 | ~0.05 |
| OpenAI Realtime | `gpt-realtime-2.1-mini` | Yes | 10 | 20 | ~0.016 |
| Google Gemini Live | Gemini Live | Token yes, **WebSocket only** | 3 | 12 | ~0.005–0.01 |
| Self-hosted | Moshi / Ultravox / Step-Audio | Via LiveKit or Pipecat | — | — | GPU rental, ~$0.4–1.5/hr idle-inclusive |

Certainty notes, because these numbers age badly:

- [Likely] The OpenAI and Gemini per-token rates above are current as of
  September 2026. They come from secondary sources — the vendor pricing pages
  (`developers.openai.com`, `ai.google.dev`) are blocked by this environment's
  egress proxy, so they were **not** verified at the source. Re-check both
  before committing to a budget.
- [Certain] OpenAI's Realtime API supports a browser opening a WebRTC peer
  connection directly to the model using a short-lived key minted by your
  server. This is the documented, first-class flow.
- [Likely] Gemini Live has ephemeral tokens but **no browser-direct WebRTC** —
  client-to-server is WebSocket, and WebRTC requires a proxy (Pipecat's
  `gemini-webrtc-web-simple` exists precisely because of this gap). There is an
  open request on `google-gemini/live-api-web-console` asking for it.
- [Guessing] Cached-input pricing (~$0.40/1M audio input on repeated context)
  materially changes long-session economics. One source claims this; treat the
  exact figure as unverified.
- [Guessing] One comparison article calls OpenAI Realtime "turn-based, not
  full-duplex." I think that is wrong as stated — the API emits
  `input_audio_buffer.speech_started` while the assistant is speaking and
  accepts `response.cancel`, which is barge-in. But I could not verify the
  event names against live docs this session, so §5 must be validated against
  real docs before it is implemented.

### Recommendation

**OpenAI Realtime (`gpt-realtime-2.1-mini`) behind a thin engine adapter.**

Reasoning, in order of weight:

1. It is the only mainstream engine where the browser talks WebRTC *directly to
   the model*. You chose browser⇄model-direct; with Gemini that choice would
   silently become "browser⇄WebSocket⇄model," or would require standing up a
   Pipecat/LiveKit proxy — which is the gateway-relay topology you rejected,
   wearing a different hat.
2. `-mini` at ~$0.016/min is ~3× cheaper than the flagship and, for a personal
   assistant driving tools, [Likely] indistinguishable in quality. Start there;
   the model name is one config value.
3. Ephemeral-token minting keeps the API key server-side. This is the security
   property that makes browser-direct acceptable at all.

**Where Gemini wins and why it still loses here:** ~5–10× cheaper input audio,
90+ languages, and video-in during conversation. If your volume ever makes
$0.016/min hurt, or you want Jarvis to see your screen while you talk, Gemini
becomes the right answer — which is exactly why the adapter boundary in §3
exists. Self-hosting (Moshi, Ultravox) replaces per-minute cost with a GPU you
must keep warm; [Likely] not worth it for single-user Jarvis until usage is
many hours per day.

**Cost sanity check** [Guessing, arithmetic on unverified rates]: 30 minutes of
real conversation per day on `-mini` ≈ $0.48/day ≈ **$15/month**, before
caching. On the flagship, ~$45/month. Context growth pushes this up over long
sessions; §7 caps session length partly for this reason.

---

## 2. Topology

```
  Browser / PWA
       │
       ├───── text WS ─────────────► Jarvis Gateway ──► n8n ──► tools
       │      (unchanged)                  ▲  │
       │                                   │  │ mints ephemeral key
       │            voice.tool.call ───────┘  │ (server-side API key)
       │            voice.tool.result ◄───────┤
       │                                      ▼
       └───── WebRTC (audio + data channel) ──► Realtime model
```

Two connections, one session. The text WebSocket is the **control plane**: it
carries `voice.*` events, ephemeral keys, transcripts and tool traffic. The
WebRTC peer connection is the **media plane**: microphone up, assistant audio
down, plus the model's own data channel for its events.

Audio touches neither the gateway nor n8n. The gateway keeps every property the
doc asks it to keep — it authenticates the user, owns the `sessionId`, decides
what tools voice may call, and runs the n8n path — it simply does not carry
PCM frames.

**The one deviation from your diagram.** Your doc draws audio as
browser → gateway → voice engine. This design routes it browser → engine, with
the gateway alongside rather than in the middle. The trade is explicit: you
lose the ability to record/inspect raw audio server-side and to enforce
per-frame policy; you gain ~100ms of round trip, no server-side WebRTC stack in
Node, and no scaling story for audio fan-out. §9 lists what would make me
reverse this.

**Trust boundary.** Tool calls arrive on the browser's data channel and are
relayed to the gateway, so a compromised client can forge a `voice.tool.call`.
It can already forge a `user.message`, so this is not a new capability — but it
does mean the gateway must validate voice tool calls exactly as it validates
text messages, and must never treat "came from the model" as authorization.
Approvals (§6) stay server-side for the same reason.

---

## 3. Gateway changes

New files, all additive:

```
gateway/src/
├── voice/
│   ├── index.js        # handleVoiceEvent(ctx, connection, event) — dispatch
│   ├── sessions.js     # VoiceSessionStore: lifecycle, TTL, per-user limits
│   ├── engine.js       # adapter interface (mintEphemeralKey, describeSession)
│   ├── engines/openai.js
│   └── tools.js        # voice tool call → n8n → voice.tool.result
```

Touched files, minimally:

- `src/handlers.js` — one added branch: `if (event.event.startsWith('voice.'))
  return voice.handle(...)`. The existing `switch` is untouched.
- `src/config.js` — a `voice` block (`enabled`, `apiKey`, `model`, `voice`,
  `maxSessionMs`, `maxConcurrentPerUser`), off unless `VOICE_ENABLED=true`.
  Warnings, not throws, matching the existing style.
- `src/server.js` — `/health` reports `voiceSessions`.

The engine adapter is one interface with one implementation. It exists so that
switching to Gemini later is a new file plus a topology change confined to the
browser transport, rather than a rewrite of the protocol.

`VoiceSessionStore` mirrors `ExecutionStore`: in-memory `Map`, `unref`'d
timers, dropped on connection close. A voice session holds `voiceSessionId`,
`connectionId`, `userId`, `sessionId`, `startedAt`, `expiresAt`, and the set of
in-flight tool calls.

---

## 4. Protocol

Same envelope as everything else (`id` / `type` / `event` / `timestamp` /
`sessionId` / `data`). No new frame shape, no second socket.

### Client → Gateway

| Event | `data` | Notes |
| --- | --- | --- |
| `voice.session.start` | `{ model?, voice?, instructions? }` | Gateway mints an ephemeral key. `model` and `voice` are validated against an allowlist; `instructions` is ignored unless explicitly enabled — a client must not be able to rewrite Jarvis's system prompt. |
| `voice.session.end` | `{ voiceSessionId }` | Idempotent. Also implied by disconnect. |
| `voice.tool.call` | `{ voiceSessionId, callId, name, arguments }` | Relayed from the model's data channel. `callId` is the model's own id. |
| `voice.interrupted` | `{ voiceSessionId, atMs? }` | Informational — the client already cancelled locally. Lets the gateway log and abandon in-flight tool work. |
| `voice.transcript` | `{ voiceSessionId, role, text, final }` | Client forwards transcripts so the gateway can mirror them into the text UI and (§7) into memory. |

### Gateway → Client

| Event | `data` |
| --- | --- |
| `voice.session.started` | `{ voiceSessionId, clientSecret, expiresAt, model, voice, iceServers?, toolSchemas }` |
| `voice.session.ended` | `{ voiceSessionId, reason }` |
| `voice.tool.result` | `{ voiceSessionId, callId, ok, output }` |
| `voice.tool.progress` | `{ voiceSessionId, callId, content }` — long n8n runs |
| `voice.error` | `{ code, message, voiceSessionId? }` |

`clientSecret` is short-lived (minutes) and single-use. It is the *only* secret
that ever leaves the gateway, and it cannot be exchanged for the account key.

Two error codes join `ERROR_CODES`: `VOICE_UNAVAILABLE` (not configured, or the
engine refused) and `VOICE_LIMIT` (concurrent-session cap).

---

## 5. Full duplex and barge-in

The realtime model does the hard parts — VAD, turn detection, streaming
generation. The browser must not undo them. Three rules:

1. **The microphone track is never muted while the assistant speaks.** This is
   the whole requirement. A half-duplex implementation is one `track.enabled =
   false` away, and it is the single easiest way to accidentally ship the thing
   your doc says not to ship.
2. **Playback is cancelled locally, immediately, on speech-start** — do not
   wait for the server to confirm the interruption. With WebRTC the assistant
   audio arrives as a remote track, so barge-in means stopping the sink and
   dropping buffered audio, not just telling the model to stop.
3. **Generation is cancelled server-side in the same tick** — send the model's
   cancel event over the data channel, and emit `voice.interrupted` to the
   gateway so any in-flight tool call for the abandoned turn is discarded
   rather than spoken later.

Conversation state survives interruption because the model owns it: the
truncated turn stays in its context as "assistant said this much." The gateway
must not attempt to reconstruct or replay it.

[Guessing] The exact event names for speech-start and cancellation, and whether
server-VAD or semantic-VAD is the better default for a tool-using assistant,
need to be read out of current OpenAI docs at implementation time. Semantic VAD
is [Likely] better here — it waits for a thought to finish rather than for
silence, which matters when you pause mid-sentence to think about a command.

**Echo.** Because the mic is live while the speaker plays, the browser must
enable `echoCancellation`, `noiseSuppression` and `autoGainControl` on
`getUserMedia`, and the user should be warned that speakerphone without a
headset will cause Jarvis to interrupt itself. [Likely] this is the #1 source
of "it barges in on itself" bug reports.

---

## 6. Tool bridge to n8n

```
model decides to call a tool
      │  data channel
      ▼
browser  ──voice.tool.call──►  gateway
                                 │  n8n.buildPayload + n8n.callWebhook
                                 ▼
                                n8n ──► existing Jarvis tools
                                 │
      ◄──voice.tool.result───────┘
      │  data channel
      ▼
model speaks the result
```

The gateway reuses `src/n8n.js` unchanged. A voice tool call becomes the same
webhook payload a text message makes, with `source: 'voice'` and the same
`sessionId` — so from n8n's side, voice is just another entry point into the
conversation it already knows.

Three things the gateway owns, not the model:

- **The tool allowlist.** `toolSchemas` is sent to the client in
  `voice.session.started` and configured into the realtime session. The gateway
  rejects any `voice.tool.call` whose `name` is not on that list, even though
  it just sent the list — the client is not trusted to have kept it.
- **Latency handling.** n8n runs can take tens of seconds; a realtime
  conversation cannot sit silent that long. The gateway returns
  `voice.tool.result` with `ok: true, output: { status: 'working' }` for slow
  calls and pushes the real answer as a follow-up, letting the model say "let
  me check" and speak the result when it lands. [Guessing] The exact threshold
  wants tuning; start around 2s.
- **Approvals.** A voice tool call that trips the existing human-in-the-loop
  path emits the ordinary `approval.request` on the text channel. The voice
  session speaks the question; the answer may come by voice *or* by tapping the
  existing UI. `handleApprovalRespond` is unchanged.

---

## 7. Session and memory

Voice and text share one `sessionId` — the connection's stable
`session_<userId>` default. A voice `voiceSessionId` is a *sub*-session: it
identifies one continuous audio conversation, not a new conversational thread.

Consequences:

- Transcripts relayed via `voice.transcript` are mirrored into the text UI as
  ordinary messages, so the conversation reads back as one history.
- [Guessing] Whether transcripts should also be written into Jarvis's n8n-side
  memory, and at what granularity, is genuinely undecided. Writing every final
  transcript is simple and probably right; writing partials is definitely
  wrong. This needs your call before Phase 5.
- Sessions are capped (`maxSessionMs`, default 30 min) and the model itself
  caps at [Likely] 60 minutes. The client must handle re-minting a key and
  resuming without the user noticing — plan for it in Phase 2, not Phase 6.

---

## 8. Browser

```
gateway/public/voice/
├── session.js      # voice.* over the existing WS; owns lifecycle + reconnect
├── transport.js    # RTCPeerConnection, SDP exchange, data channel
├── mic.js          # getUserMedia, constraints, device selection
├── playback.js     # remote track → sink, instant cancellation
└── ui.js           # push-to-talk / always-on toggle, level meter, state
```

`public/app.js` (847 lines, single-file) gains a small integration point and
nothing else. The voice layer is lazy-loaded on first use so the text PWA does
not pay for it. [Likely] the service worker (`public/sw.js`) needs its cache
list extended, and must not attempt to cache the SDP exchange.

---

## 9. What would make me reverse the topology decision

Concrete, so this is falsifiable rather than a hedge:

- You need server-side recording, transcription-of-record, or audit of raw
  audio for compliance.
- You want non-browser voice clients (a phone dialing in over SIP, an always-on
  desk device) — those cannot mint keys through a PWA and want a server-side
  media path.
- You switch to Gemini Live for cost or video, at which point the browser-direct
  WebRTC path does not exist and a proxy is required anyway.
- Ephemeral-key minting turns out to be rate-limited or slow enough to make
  session start feel laggy.

None of these are true today, as I understand the project.

---

## 10. Phases

| Phase | Deliverable | Done when |
| --- | --- | --- |
| 1 | `voice.session.start/started`, `VoiceSessionStore`, OpenAI adapter, browser `transport.js` + `mic.js` | The browser holds a live peer connection and the gateway shows the session in `/health`. No audio out yet. |
| 2 | Playback, `voice.session.end`, key re-mint on expiry | You can hold a real conversation. No tools. |
| 3 | Barge-in: local cancel, model cancel, `voice.interrupted` | You can interrupt mid-sentence and it stops inside ~200ms with context intact. |
| 4 | `voice.tool.call/result`, allowlist, slow-call handling, approvals | "Jarvis, check my calendar" runs the existing n8n workflow and is spoken back. |
| 5 | Transcript mirroring, memory write-back | Voice and text read as one conversation. |
| 6 | `VOICE_ENABLED` config, compose wiring, docs | Deployed with voice off by default; turning it off fully restores today's behaviour. |

Tests: `voice/sessions.js` lifecycle and TTL, allowlist rejection, tool-call →
n8n payload shape, and a protocol round-trip in the style of
`test/roundtrip.test.js`. The engine adapter is stubbed — no test should need
network or an API key.

---

## 11. Open questions for you

1. **Model tier** — start on `-mini` (~$15/mo at 30 min/day) or flagship
   (~$45/mo)? I'd start mini.
2. **Memory write-back** (§7) — every final transcript, or only turns that
   invoked a tool?
3. **Activation** — always-on listening, push-to-talk, or a wake word? This
   changes `ui.js` and the cost model substantially; always-on with server VAD
   bills for silence.
4. **Tool surface** — does voice get every tool the text agent has, or a
   reduced set? Anything destructive reached by voice should [Likely] require
   an approval even when the text path does not.
