import 'dotenv/config';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

export const config = {
  openai: {
    apiKey: required('OPENAI_API_KEY'),
    projectId: required('OPENAI_PROJECT_ID'),
    webhookSecret: process.env.OPENAI_WEBHOOK_SECRET ?? '',
  },
  twilio: {
    accountSid: required('TWILIO_ACCOUNT_SID'),
    apiKeySid: required('TWILIO_API_KEY_SID'),
    apiKeySecret: required('TWILIO_API_KEY_SECRET'),
    phoneNumber: required('TWILIO_PHONE_NUMBER'),
  },
  port: parseInt(process.env.PORT ?? '3000', 10),
  publicUrl: (process.env.PUBLIC_URL ?? '').replace(/\/$/, ''),
};
