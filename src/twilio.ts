import twilio from 'twilio';
import { config } from './config.js';

export const twilioClient = twilio(
  config.twilio.apiKeySid,
  config.twilio.apiKeySecret,
  { accountSid: config.twilio.accountSid }
);

export async function placeCall(to: string): Promise<string> {
  if (!config.publicUrl) {
    throw new Error(
      'PUBLIC_URL is required so Twilio can reach your server.\n' +
        'Set it to your ngrok or Cloudflare Tunnel URL and restart.'
    );
  }

  const host = new URL(config.publicUrl).host;
  // <Connect><Stream> keeps the call alive and pipes audio bidirectionally through our server.
  const twiml =
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<Response><Connect><Stream url="wss://${host}/stream"/></Connect></Response>`;

  const call = await twilioClient.calls.create({
    to,
    from: config.twilio.phoneNumber,
    twiml,
    statusCallback: `${config.publicUrl}/status`,
    statusCallbackMethod: 'POST',
    statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
    fallbackUrl: `${config.publicUrl}/fallback`,
    fallbackMethod: 'POST',
  });

  return call.sid;
}
