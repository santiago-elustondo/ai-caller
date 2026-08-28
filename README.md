# ai-caller

Minimal proof-of-concept realtime AI phone caller.

```
phone ──► Twilio ──► SIP ──► OpenAI Realtime (gpt-realtime-2.1)
```

## How it works

1. `npm run call -- +1XXXXXXXXXX` uses the Twilio REST API to place an outbound PSTN call.
2. When answered, Twilio executes inline TwiML that bridges the call to OpenAI's SIP endpoint via `<Dial><Sip>`.
3. OpenAI fires a `realtime.call.incoming` webhook to your server.
4. The server accepts the call, configuring the realtime session (model, voice, turn detection, system prompt).
5. The AI greets the caller ~1.5 s after connection and the conversation proceeds in realtime.

## Prerequisites

- Node.js ≥ 20
- A Twilio account with a voice-capable phone number
- An OpenAI account with access to `gpt-realtime-2.1`
- A public HTTPS URL for your server (ngrok, Cloudflare Tunnel, etc.)

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
```

Fill in every variable:

| Variable | Where to find it |
|---|---|
| `OPENAI_API_KEY` | platform.openai.com → API Keys |
| `OPENAI_PROJECT_ID` | platform.openai.com → Settings → General (looks like `proj_…`) |
| `OPENAI_WEBHOOK_SECRET` | platform.openai.com → Webhooks → your endpoint secret |
| `TWILIO_ACCOUNT_SID` | console.twilio.com → Account Info |
| `TWILIO_API_KEY_SID` | Twilio Console → API Keys → create a key (starts with `SK`) |
| `TWILIO_API_KEY_SECRET` | shown once when you create the API key |
| `TWILIO_PHONE_NUMBER` | your Twilio number in E.164 format, e.g. `+15005550006` |
| `PORT` | local port to listen on (default `3000`) |
| `PUBLIC_URL` | your public HTTPS URL, e.g. `https://xxxx.ngrok.io` |

### 3. Expose the server publicly (local dev)

**ngrok:**
```bash
ngrok http 3000
# Copy the https:// URL → set PUBLIC_URL in .env
```

**Cloudflare Tunnel:**
```bash
cloudflared tunnel --url http://localhost:3000
# Copy the https:// URL → set PUBLIC_URL in .env
```

### 4. Register the OpenAI webhook

In [platform.openai.com → Webhooks](https://platform.openai.com/webhooks), add an endpoint:

- **URL**: `https://your-public-url/webhook`
- **Events**: `realtime.call.incoming`

Copy the signing secret and set `OPENAI_WEBHOOK_SECRET` in `.env`.

### 5. Start the server

```bash
npm run dev
```

The server logs its webhook URL on startup.

### 6. Place a call

```bash
npm run call -- +14165551234
```

Replace with any E.164 number. The server logs will trace the full call lifecycle.

## Logs you'll see

```
[twilio] call created — sid=CA…
[twilio] ringing — sid=CA…
[twilio] call answered — sid=CA…
[webhook] received event: realtime.call.incoming
[webhook] OpenAI call incoming — call_id: call_…
[realtime] accepting call call_…
[realtime] call call_… accepted — session active
[twilio] call ended — sid=CA…
```

## Turn detection

The session uses **`server_vad`** with these settings:

| Setting | Value | Effect |
|---|---|---|
| `idle_timeout_ms` | 1500 | Triggers the opening greeting ~1.5 s after call connects |
| `silence_duration_ms` | 1000 | User's turn ends after 1 s of silence (patient) |
| `interrupt_response` | true | Caller can barge in while the AI is speaking |

### Switching to semantic VAD

If you want the AI to use semantic turn detection (better for natural pauses) after the initial greeting, you need a server-side WebSocket connection to the session so you can (a) trigger the first `response.create` immediately and (b) send a `session.update` to switch to `semantic_vad`. That's out of scope for this POC but straightforward to add.

## Architecture notes

- The Node server **never touches audio**. All media flows directly between Twilio and OpenAI over SIP/TLS.
- Authentication uses Twilio API Keys (`SK…`) rather than the master auth token.
- The OpenAI webhook is verified with Svix HMAC-SHA256 when `OPENAI_WEBHOOK_SECRET` is set.
