import OpenAI from 'openai';
import { config } from './config.js';

const openai = new OpenAI({ apiKey: config.openai.apiKey });

const SYSTEM_PROMPT =
  'You are a conversational telephone assistant being used for a realtime voice proof of concept. ' +
  'Speak naturally and concisely. Do not behave like an IVR. ' +
  'Allow the caller to interrupt you at any time. ' +
  'Be patient with brief pauses and unfinished thoughts.';

const INITIAL_GREETING = "Hey, this is the realtime voice POC. How's it going?";

export async function acceptCall(callId: string): Promise<void> {
  console.log(`[realtime] accepting call ${callId}`);

  try {
    await openai.realtime.calls.accept(callId, {
      type: 'realtime',
      model: 'gpt-realtime-2.1',
      instructions:
        `${SYSTEM_PROMPT}\n\n` +
        `At the very start of this call—before the caller says anything—` +
        `immediately greet them by saying exactly: "${INITIAL_GREETING}"`,
    });
    console.log(`[realtime] call ${callId} accepted — session active`);
  } catch (err: unknown) {
    const e = err as { status?: number; message?: string; error?: unknown };
    console.error(
      `[realtime] accept FAILED for ${callId}:`,
      `status=${e.status}`,
      `message=${e.message}`,
      e.error ?? '',
    );
    throw err;
  }
}
