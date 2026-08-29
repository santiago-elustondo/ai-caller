# Call Construction, Event Flow & API Actions

## Two processes, one call

The system is intentionally split into two separate processes that never talk to each other directly. They are connected only through third-party APIs (Twilio and OpenAI).

```
┌─────────────────────────────┐       ┌──────────────────────────────────┐
│   npm run call              │       │   npm run dev                    │
│   (tsx src/cli.ts)          │       │   (tsx watch src/server.ts)      │
│                             │       │                                  │
│  One-shot script.           │       │  Long-running HTTP server.       │
│  Places the call and exits. │       │  Receives webhooks + callbacks.  │
└────────────┬────────────────┘       └──────────────┬───────────────────┘
             │                                       │
             │ Twilio REST API                       │ ← Twilio POSTs /status, /fallback
             │ (creates the call)                    │ ← OpenAI POSTs /webhook
             │                                       │
             └────────────── Twilio ─────────────────┘
                               │
                        Twilio POSTs
                        /status callbacks
                        to the server
```

### `npm run dev` — the webhook server

`tsx watch src/server.ts` starts an Express server on `$PORT` (default 3000) and restarts it on file changes.

**What it does:**
- Listens for `POST /webhook` from OpenAI (the `realtime.call.incoming` event)
- Listens for `POST /status` from Twilio (call lifecycle events)
- Listens for `POST /fallback` from Twilio (TwiML errors)
- Responds to `GET /` for health checks

**It does not place any calls.** It only reacts to events triggered by `npm run call` or by Twilio/OpenAI as a result of those calls.

The server must be publicly reachable for webhooks to arrive. In development this requires a tunnel:

```bash
ngrok http --domain=blast.ngrok.io 3000
```

and `PUBLIC_URL=https://blast.ngrok.io` in `.env`.

### `npm run call` — the outbound dialer

`tsx src/cli.ts +1XXXXXXXXXX` is a one-shot script that:

1. Reads `+1XXXXXXXXXX` from `process.argv[2]`
2. Validates E.164 format
3. Calls `placeCall(number)` → `twilioClient.calls.create(…)`
4. Prints the Twilio Call SID
5. Exits immediately (exit code 0)

The script has no HTTP server and receives no callbacks. After it exits, **all further activity happens inside the `dev` server** as Twilio and OpenAI post webhooks to it.

### How they connect — the shared contract

The two processes are coupled through exactly one thing: **`PUBLIC_URL`**.

- `npm run call` embeds `${PUBLIC_URL}/status` and `${PUBLIC_URL}/fallback` as callback URLs in the `calls.create()` request body sent to Twilio.
- `npm run dev` listens on those paths.
- OpenAI was separately configured (once, in the dashboard) to post `realtime.call.incoming` to `${PUBLIC_URL}/webhook`.

If `PUBLIC_URL` is wrong or the server is not running, calls still connect (the SIP bridge goes up) but no webhooks are delivered, so `accept()` is never called and the caller hears silence forever.

---



Every async event, outbound API call, and inbound callback that occurs during a single call.

```
OPERATOR (our server + CLI)          TWILIO                    OPENAI
─────────────────────────────────────────────────────────────────────────────────
[1] cli.ts: twilioClient.calls.create()
    ──── REST POST /2010-04-01/Accounts/{sid}/Calls ──────────►
                                     ◄─── 201 { sid: "CA…" } ──
[2] Twilio dials callee PSTN number
                                     ──── ring ───────────────► callee phone
[3] Twilio → POST /status  (CallStatus=initiated)
    ◄───────────────────────────────────────────────
    log: [twilio] call created
[4] Twilio → POST /status  (CallStatus=ringing)
    ◄───────────────────────────────────────────────
    log: [twilio] ringing

═══ CALLEE ANSWERS ═════════════════════════════════════════════════════════════

[5] Twilio executes inline TwiML: <Dial><Sip>
    Twilio → SIP INVITE ─────────────────────────────────────► sip.api.openai.com
[6] Twilio plays ringback to callee while waiting for SIP 200 OK
[7]                                                              OpenAI SIP → 100 Trying
                                                                 OpenAI SIP → 180 Ringing
                                                                 OpenAI SIP → 200 OK  ◄─ RTP bridge opens
[8] Twilio → POST /status  (CallStatus=in-progress)
    ◄───────────────────────────────────────────────
    log: [twilio] call answered

═══ OPENAI FIRES INCOMING-CALL WEBHOOK ═════════════════════════════════════════

[9] OpenAI → POST /webhook  (realtime.call.incoming, call_id=rtc_…)
    ◄────────────────────────────────────────────────────────────
    server verifies Svix HMAC-SHA256 signature
    server → 200 { received: true }  (immediate ack, before accept)
    log: [webhook] OpenAI call incoming

[10] server: openai.realtime.calls.accept(callId, sessionConfig)
     ──── REST POST /v1/realtime/calls/{call_id}/accept ──────►
          body: {
            type: "realtime",
            model: "gpt-realtime-2.1",
            instructions: "…",
            audio: {
              input: { turn_detection: { type: "semantic_vad", … } },
              output: { voice: "marin" }
            }
          }
     ◄─── 204 No Content ─────────────────────────────────────
     log: [realtime] call accepted — session active

═══ AI SESSION LIVE — AUDIO FLOWS OVER RTP ══════════════════════════════════════

[11] idle_timeout_ms fires (~1.5 s of silence) → OpenAI streams audio greeting
     RTP audio ◄──────────────────────────────────────────────
     Twilio relays audio to callee's earpiece

[12] (ongoing) callee speaks → RTP audio ──────────────────────►
     VAD detects speech end → model generates response → RTP audio ◄────────────
     (repeats for each turn)

═══ CALL ENDS (caller hangs up or AI ends call) ═════════════════════════════════

[13] SIP BYE ◄───────────────────────────────────────────────►  (either side)
     RTP terminated

[14] Twilio → POST /status  (CallStatus=completed)
     ◄───────────────────────────────────────────────
     log: [twilio] call ended

═══ ERROR PATHS ═════════════════════════════════════════════════════════════════

[E1] If Twilio TwiML execution fails:
     Twilio → POST /fallback  (ErrorCode, ErrorMessage)
     ◄───────────────────────────────────────────────
     log: [twilio] TwiML fallback
     server → 200 TwiML: <Response><Hangup/>

[E2] If status callback includes ErrorCode:
     Twilio → POST /status  (CallStatus=failed, ErrorCode=…)
     log: [twilio] ERROR …

[E3] If Svix signature invalid:
     server → 400 { error: "invalid signature" }
     OpenAI will retry per its retry policy

[E4] If openai.realtime.calls.accept() throws:
     log: [realtime] accept FAILED — status, message
     call continues but session is unconfigured (model uses defaults)
```

---

## Event-by-event detail

### [1] `twilioClient.calls.create()` — outbound REST call

**What**: `POST https://api.twilio.com/2010-04-01/Accounts/{AccountSid}/Calls.json`

**Auth**: Twilio API Key SID + Secret (not the master auth token).

**Key parameters sent**:

| Parameter | Value | Purpose |
|---|---|---|
| `To` | E.164 callee number | Who to dial |
| `From` | `TWILIO_PHONE_NUMBER` | Our caller ID |
| `Twiml` | `<Response><Dial><Sip>…</Sip></Dial></Response>` | Instructions Twilio runs when callee answers |
| `StatusCallback` | `PUBLIC_URL/status` | Where Twilio posts lifecycle events |
| `StatusCallbackEvent` | `initiated,ringing,answered,completed` | Which events to receive |
| `FallbackUrl` | `PUBLIC_URL/fallback` | Where Twilio posts TwiML execution errors |

**Response**: `{ sid: "CA…", status: "queued", … }` — the Call SID is logged and printed to the operator.

---

### [3][4][8][14] Twilio `POST /status` — call lifecycle callbacks

Twilio posts `application/x-www-form-urlencoded` to `/status` for each subscribed event.

Key fields used: `CallSid`, `CallStatus`, `From`, `To`, `ErrorCode`, `ErrorMessage`.

`CallStatus` values and what we log:

| Status | Log label |
|---|---|
| `queued` / `initiated` | call created |
| `ringing` | ringing |
| `in-progress` | call answered |
| `completed` | call ended |
| `busy` / `failed` / `no-answer` / `canceled` | call ended (reason) |

If `ErrorCode` is present the callback is logged as an error regardless of status.

---

### [5] Inline TwiML — `<Dial><Sip>`

Twilio fetches no URL. The TwiML was embedded in the `calls.create()` request body:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Dial>
    <Sip>sip:{OPENAI_PROJECT_ID}@sip.api.openai.com;transport=tls</Sip>
  </Dial>
</Response>
```

`<Dial><Sip>` instructs Twilio to bridge the answered PSTN call to OpenAI's SIP endpoint. Audio flows bidirectionally over RTP. The `<Dial>` verb holds the callee in the bridge for the duration of the call — it completes only when the SIP call hangs up.

---

### [6] Ringback tone

Twilio plays its built-in ringback to the callee while the SIP INVITE is in flight (between INVITE and 200 OK). This is the "dial-tone-like" sound the callee hears in the first ~0.5 s. See the **Ringback** section below for full detail.

---

### [9] OpenAI `POST /webhook` — `realtime.call.incoming`

OpenAI posts `application/json` (raw body, for signature verification) to `/webhook`.

**Signature verification**: Svix HMAC-SHA256 over the raw body. Headers checked: `svix-id`, `svix-timestamp`, `svix-signature`. Requires `OPENAI_WEBHOOK_SECRET`. If the secret is unset, verification is skipped with a warning.

**Payload shape**:
```json
{
  "type": "realtime.call.incoming",
  "data": {
    "call_id": "rtc_u0_…",
    "sip_headers": [
      { "name": "X-Twilio-CallSid", "value": "CA…" },
      { "name": "From",             "value": "sip:+16722020602@sip.twilio.com" },
      { "name": "To",               "value": "sip:proj_…@sip.api.openai.com" },
      …
    ]
  }
}
```

**Our response**: `200 { received: true }` — returned immediately, before the `accept()` REST call, so OpenAI's webhook delivery does not time out waiting for us.

---

### [10] `openai.realtime.calls.accept()` — configure the realtime session

**What**: `POST https://api.openai.com/v1/realtime/calls/{call_id}/accept`

**Auth**: `Authorization: Bearer {OPENAI_API_KEY}`

**Body sent**:

```json
{
  "type": "realtime",
  "model": "gpt-realtime-2.1",
  "instructions": "…full system prompt…",
  "audio": {
    "input": {
      "turn_detection": {
        "type": "server_vad",
        "idle_timeout_ms": 1500,
        "silence_duration_ms": 800,
        "create_response": true,
        "interrupt_response": true
      }
    },
    "output": {
      "voice": "marin"
    }
  }
}
```

**Response**: `204 No Content` on success.

**Critical note on `audio` sub-fields**: Many fields that are documented as valid (`threshold`, `prefix_padding_ms`, `interrupt_response` on its own) crash the SIP session when included in `calls.accept()` for `gpt-realtime-2.1`. Only the subset above is confirmed safe. Do not add fields without testing.

---

### [11][12] RTP audio — ongoing bidirectional stream

After `accept()` returns, the RTP path between Twilio and OpenAI carries:

- **Callee → OpenAI**: raw microphone audio from the callee's phone, via Twilio's SIP bridge
- **OpenAI → Callee**: model-generated speech audio, via the same bridge

Our server is **not** in the audio path. No audio touches our Node process.

**`idle_timeout_ms` trigger**: 1500 ms after the last model response (or call start, on first turn), the model is prompted to speak. This fires the opening greeting without the callee needing to say anything first.

**VAD turn detection** (`server_vad`): OpenAI detects when the callee starts and stops speaking. `silence_duration_ms: 800` means 800 ms of silence ends the callee's turn and triggers a model response. `interrupt_response: true` means if the callee speaks while the model is talking, the model stops and listens.

---

### [E1] Twilio `POST /fallback` — TwiML execution error

Twilio calls `/fallback` if our TwiML is syntactically invalid or returns a non-2xx status. We log the error and respond with `<Hangup/>` to cleanly end the call rather than leaving the callee in a broken state.

---

## Why the ringback exists

### What the callee hears, second by second

| Elapsed | Event | Audio |
|---|---|---|
| 0 s | Callee answers | Call connects |
| 0–~0.5 s | Twilio sends SIP INVITE; waiting for OpenAI's 200 OK | **Ringback** (Twilio default) |
| ~0.5 s | OpenAI answers SIP (200 OK); RTP opens | Ringback stops |
| 0.5–~1.5 s | OpenAI session initializing; idle_timeout_ms counting | Silence |
| ~1.5 s | idle_timeout_ms fires; model streams greeting | **AI speaks** |

The ringback is Twilio's built-in fallback played to the answered A-leg while `<Dial>` waits for the B-leg (SIP) to be answered. It is identical in sound to what you hear when you dial a regular phone number. It stops the instant OpenAI's SIP server sends `200 OK`.

### Why it cannot be suppressed

To suppress Twilio's ringback, OpenAI's SIP server would need to send a `183 Session Progress` response containing an SDP with early media (audio streamed before 200 OK). OpenAI's server does not currently do this — it goes straight from `100 Trying` to `200 OK`, leaving Twilio with no early media to play, so it falls back to generating its own ringback.

### Why the conference-room approach failed

We attempted to put the callee in a Twilio conference room (`<Conference waitUrl="/silence">`) so they heard silence instead of ringback, then separately dialed OpenAI's SIP and joined it to the conference once the realtime session was ready. This failed because:

1. When created as a standalone outbound call (`twilioClient.calls.create({ to: sipUri })`), OpenAI's SIP server terminates the call shortly after `accept()` is called.
2. OpenAI's SIP endpoint only remains alive when it is the destination of a live `<Dial><Sip>` bridge originating from an answered PSTN call. A standalone SIP call with no bridged user is treated as invalid and closed.
3. Attempts to redirect the SIP call into the conference via `twilioClient.calls(sipSid).update({ twiml: … })` failed with Twilio error 21220 ("Call is not in-progress. Cannot redirect.") because the SIP call had already been terminated by OpenAI.

The only architecture that keeps the SIP session alive is the direct bridge: `<Dial><Sip>` from an answered PSTN call.

