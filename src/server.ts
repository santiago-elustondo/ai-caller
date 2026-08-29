import 'dotenv/config';
import express, { Request, Response } from 'express';
import { Webhook } from 'svix';
import { config } from './config.js';
import { acceptCall } from './realtime.js';

const app = express();

app.use(express.raw({ type: 'application/json', limit: '1mb' }));
app.use(express.urlencoded({ extended: false }));

// ─── Health check ─────────────────────────────────────────────────────────────

app.get('/', (_req: Request, res: Response) => {
  res.json({ status: 'ok', service: 'ai-caller' });
});

// ─── OpenAI realtime webhook ──────────────────────────────────────────────────

app.post('/webhook', async (req: Request, res: Response) => {
  const rawBody = req.body as Buffer;

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

  if (event.type === 'realtime.call.incoming') {
    const callId = (event.data?.call_id ?? event.data?.id) as string | undefined;
    if (!callId) {
      res.status(400).json({ error: 'missing call_id' });
      return;
    }

    console.log(`[webhook] OpenAI call incoming — call_id=${callId}`);
    res.status(200).json({ received: true });

    void acceptCall(callId).catch((err) => {
      console.error(`[realtime] failed to accept call ${callId}:`, err);
    });
    return;
  }

  res.status(200).json({ received: true });
});

// ─── Twilio status + error callbacks ─────────────────────────────────────────

app.post('/status', (req: Request, res: Response) => {
  const { CallSid, CallStatus, To, From, ErrorCode, ErrorMessage } =
    req.body as Record<string, string>;
  const labels: Record<string, string> = {
    queued: 'call created', initiated: 'call created', ringing: 'ringing',
    'in-progress': 'call answered', completed: 'call ended',
    busy: 'call ended (busy)', failed: 'call ended (failed)',
    'no-answer': 'call ended (no-answer)', canceled: 'call ended (canceled)',
  };
  const label = labels[CallStatus] ?? CallStatus;
  if (ErrorCode) {
    console.error(`[twilio] ERROR ${ErrorCode}: ${ErrorMessage} — sid=${CallSid}`);
  } else {
    console.log(`[twilio] ${label} — sid=${CallSid} from=${From} to=${To}`);
  }
  res.sendStatus(204);
});

// Twilio calls this when TwiML execution fails.
app.post('/fallback', (req: Request, res: Response) => {
  const { CallSid, ErrorCode, ErrorMessage } = req.body as Record<string, string>;
  console.error(`[twilio] TwiML fallback — sid=${CallSid} error=${ErrorCode}: ${ErrorMessage}`);
  res.type('text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>');
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
