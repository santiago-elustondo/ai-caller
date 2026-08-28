import twilio from 'twilio';
import { config } from './config.js';

// Authenticate with API key (recommended over AccountSid + AuthToken)
export const twilioClient = twilio(
  config.twilio.apiKeySid,
  config.twilio.apiKeySecret,
  { accountSid: config.twilio.accountSid }
);

export async function placeCall(to: string): Promise<string> {
  if (!config.publicUrl) {
    throw new Error(
      'PUBLIC_URL is required so Twilio can reach your server for status callbacks.\n' +
        'Set it to your ngrok or Cloudflare Tunnel URL and restart.'
    );
  }

  // Inline TwiML: when answered, bridge the PSTN call directly to OpenAI via SIP.
  // OpenAI will fire a realtime.call.incoming webhook to our server.
  const sipUri = `sip:${config.openai.projectId}@sip.api.openai.com;transport=tls`;
  const twiml = `<?xml version="1.0" encoding="UTF-8"?><Response><Dial><Sip>${sipUri}</Sip></Dial></Response>`;

  const call = await twilioClient.calls.create({
    to,
    from: config.twilio.phoneNumber,
    twiml,
    statusCallback: `${config.publicUrl}/status`,
    statusCallbackMethod: 'POST',
    statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
  });

  return call.sid;
}
