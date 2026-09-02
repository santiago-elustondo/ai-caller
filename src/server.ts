import 'dotenv/config';
import http from 'http';
import express, { Request, Response } from 'express';
import { WebSocketServer } from 'ws';
import { config } from './config.js';
import { RealtimeSession } from './realtime.js';

const app = express();
app.use(express.urlencoded({ extended: false }));

// ─── Health check ─────────────────────────────────────────────────────────────

app.get('/', (_req: Request, res: Response) => {
  res.json({ status: 'ok', service: 'ai-caller' });
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
  if (ErrorCode) {
    console.error(`[twilio] ERROR ${ErrorCode}: ${ErrorMessage} — sid=${CallSid}`);
  } else {
    console.log(`[twilio] ${labels[CallStatus] ?? CallStatus} — sid=${CallSid} from=${From} to=${To}`);
  }
  res.sendStatus(204);
});

app.post('/fallback', (req: Request, res: Response) => {
  const { CallSid, ErrorCode, ErrorMessage } = req.body as Record<string, string>;
  console.error(`[twilio] TwiML error — sid=${CallSid} code=${ErrorCode}: ${ErrorMessage}`);
  res.type('text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>');
});

// ─── HTTP + WebSocket server ──────────────────────────────────────────────────
// The WebSocket server shares the same port as Express.

const httpServer = http.createServer(app);

const wss = new WebSocketServer({ server: httpServer, path: '/stream' });

wss.on('connection', (ws, req) => {
  console.log(`[stream] new connection from ${req.socket.remoteAddress}`);

  const session = new RealtimeSession(ws);

  ws.on('message', (data) => {
    session.handleTwilioMessage(data.toString());
  });

  ws.on('close', (code) => {
    console.log(`[stream] connection closed — code=${code}`);
    session.cleanup();
  });

  ws.on('error', (err) => {
    console.error('[stream] WebSocket error:', err.message);
  });
});

httpServer.listen(config.port, () => {
  console.log(`[server] listening on port ${config.port}`);
  if (config.publicUrl) {
    const host = new URL(config.publicUrl).host;
    console.log(`[server] public URL: ${config.publicUrl}`);
    console.log(`[server] Media Stream endpoint: wss://${host}/stream`);
  } else {
    console.warn('[server] PUBLIC_URL is not set');
  }
});

