import 'dotenv/config';
import express, { Request, Response } from 'express';
import { Webhook } from 'svix';
import { config } from './config.js';
import { acceptCall } from './realtime.js';

const app = express();

// Parse raw body for webhook signature verification
app.use(express.raw({ type: 'application/json', limit: '1mb' }));
// Also parse urlencoded for Twilio status callbacks
app.use(express.urlencoded({ extended: false }));

// ─── Health check ────────────────────────────────────────────────────────────

app.get('/', (_req: Request, res: Response) => {
  res.json({ status: 'ok', service: 'ai-caller' });
});

// ─── OpenAI realtime webhook ─────────────────────────────────────────────────
//
// OpenAI calls this endpoint when an inbound SIP call arrives.
// We verify the signature (if OPENAI_WEBHOOK_SECRET is set),
// then accept the call and configure the realtime session.

app.post('/webhook', async (req: Request, res: Response) => {
  const rawBody = req.body as Buffer;

  // Verify Svix signature when a secret is configured
  if (config.openai.webhookSecret) {
    const wh = new Webhook(config.openai.webhookSecret);
    try {
      wh.verify(rawBody, req.headers as Record<string, string>);
    } catch (err) {
      console.error('[webhook] signature verification failed:', err);
      res.status(400).json({ error: 'invalid signature' });
      return;
    }
  } else {
    console.warn('[webhook] OPENAI_WEBHOOK_SECRET not set — skipping verification');
  }

  let event: { type: string; data?: Record<string, unknown> };
  try {
    event = JSON.parse(rawBody.toString('utf8'));
  } catch {
    res.status(400).json({ error: 'invalid json' });
    return;
  }

  console.log(`[webhook] received event: ${event.type}`);
  if (event.type !== 'realtime.call.incoming') {
    console.log('[webhook] payload:', JSON.stringify(event, null, 2));
  }

  if (event.type === 'realtime.call.incoming') {
    const callId = (event.data?.call_id ?? event.data?.id) as string | undefined;

    if (!callId) {
      console.error('[webhook] realtime.call.incoming missing call_id', event.data);
      res.status(400).json({ error: 'missing call_id' });
      return;
    }

    console.log(`[webhook] OpenAI call incoming — call_id: ${callId}`);
    console.log('[webhook] full payload:', JSON.stringify(event.data, null, 2));

    // Acknowledge immediately so OpenAI doesn't time out waiting
    res.status(200).json({ received: true });

    // Accept the call asynchronously
    acceptCall(callId).catch((err) => {
      console.error(`[realtime] failed to accept call ${callId}:`, err);
    });
    return;
  }

  // Acknowledge unknown event types
  res.status(200).json({ received: true });
});

// ─── Twilio status callbacks ─────────────────────────────────────────────────

app.post('/status', (req: Request, res: Response) => {
  const { CallSid, CallStatus, To, From } = req.body as Record<string, string>;

  const statusMap: Record<string, string> = {
    queued: 'call created',
    initiated: 'call created',
    ringing: 'ringing',
    'in-progress': 'call answered',
    completed: 'call ended',
    busy: 'call ended (busy)',
    failed: 'call ended (failed)',
    'no-answer': 'call ended (no-answer)',
    canceled: 'call ended (canceled)',
  };

  const label = statusMap[CallStatus] ?? CallStatus;
  console.log(`[twilio] ${label} — sid=${CallSid} from=${From} to=${To}`);

  res.sendStatus(204);
});

// ─── Start ────────────────────────────────────────────────────────────────────

app.listen(config.port, () => {
  console.log(`[server] listening on port ${config.port}`);
  if (config.publicUrl) {
    console.log(`[server] public URL: ${config.publicUrl}`);
    console.log(`[server] OpenAI webhook endpoint: ${config.publicUrl}/webhook`);
  } else {
    console.warn('[server] PUBLIC_URL is not set — set it to receive OpenAI webhooks');
  }
});
