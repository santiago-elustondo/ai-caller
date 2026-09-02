import WebSocket from 'ws';
import { config } from './config.js';

const OPENAI_WS_URL = `wss://api.openai.com/v1/realtime?model=gpt-realtime-2.1`;

const SYSTEM_PROMPT = `\
You are a friendly, professional outreach agent calling on behalf of Info-Reach. \
Info-Reach contacts people to make them aware of government subsidies and benefits they may qualify for, \
and helps them access those programs if they need assistance.

Today's call is specifically about the Ontario Trillium Renter Subsidy — a new government program \
that can pay up to 30% of a qualifying renter's monthly rent. The exact amount depends on the person's \
specific situation (income, household size, dwelling type, location, etc.).

STYLE:
- Speak loudly, clearly, and with confident projection — this is a phone call.
- Warm, conversational, and unhurried. You are a helpful human, not an IVR.
- Keep individual turns short — 1-3 sentences. Let the caller talk.
- Be patient with pauses, partial sentences, and topic changes.
- Allow the caller to interrupt you at any time.
- Never read out a list of questions all at once. Ask one question, listen, then move to the next naturally.
- If the caller seems skeptical or asks whether this is a scam, reassure them calmly — this is a legitimate \
  government subsidy program and there is no cost or obligation involved.

GOAL: Have a natural conversation. When the moment feels right (not rushed), ask whether the caller \
would be open to answering a few quick questions to see if they'd likely qualify for the subsidy. \
If they agree, work through the following qualification questions conversationally, one at a time:

1. Do you currently rent your home?
2. What type of place do you rent — apartment, house, room, basement unit, something else?
3. Is your rental located in the City of Toronto?
4. Is your rent already subsidized by any government program (e.g. Toronto Community Housing, rent-geared-to-income)?
5. Do you have any dependents living with you — children, elderly parents, anyone like that?
6. Roughly what is your combined annual household income — under $50,000, between $50,000 and $100,000, or above $100,000?

After the qualifying questions, summarize what you heard and let the caller know that based on their \
answers it sounds like they may / may not qualify, and offer to connect them with a benefits advisor \
who can walk them through the actual application — no cost, no obligation.

If the caller declines to answer questions or wants to end the call, thank them politely and let them go.`;

const INITIAL_GREETING =
  "Hi there, this is Jamie calling from Info-Reach. How are you doing today?";

// Qualification tool — model calls this when it has gathered all answers
const TOOLS = [
  {
    type: 'function',
    name: 'save_qualification',
    description: 'Save the caller\'s qualification answers once all questions are answered.',
    parameters: {
      type: 'object',
      properties: {
        rents_home:      { type: 'boolean', description: 'Caller currently rents their home' },
        dwelling_type:   { type: 'string', enum: ['apartment','house','room','basement','other'] },
        in_toronto:      { type: 'boolean', description: 'Rental is in the City of Toronto' },
        rent_subsidized: { type: 'boolean', description: 'Rent is already subsidized' },
        has_dependents:  { type: 'boolean', description: 'Caller has dependents' },
        income_bracket:  { type: 'string', enum: ['<50k','50k-100k','100k+'] },
      },
      required: ['rents_home','dwelling_type','in_toronto','rent_subsidized','has_dependents','income_bracket'],
    },
  },
];

type OpenAIEvent = { type: string } & Record<string, unknown>;

export class RealtimeSession {
  private openaiWs: WebSocket | null = null;
  private readonly twilioWs: WebSocket;
  private streamSid = '';
  private callSid = '';
  private responseActive = false;
  private greeted = false;
  private openaiConfigured = false;
  private pendingAudio: string[] = [];
  private pendingInputAudio: string[] = [];
  private inputAudioFrames = 0;
  private outputAudioFrames = 0;

  constructor(twilioWs: WebSocket) {
    this.twilioWs = twilioWs;
    this.connectToOpenAI();
  }

  // ─── OpenAI WebSocket ─────────────────────────────────────────────────────

  private connectToOpenAI() {
    console.log('[openai] connecting to Realtime WebSocket...');
    this.openaiWs = new WebSocket(OPENAI_WS_URL, {
      headers: {
        Authorization: `Bearer ${config.openai.apiKey}`,
      },
    });

    this.openaiWs.on('open', () => {
      console.log('[openai] WebSocket open');
      this.flushPendingInputAudio();
    });

    this.openaiWs.on('message', (raw) => {
      const event = JSON.parse(raw.toString()) as OpenAIEvent;
      this.handleOpenAIEvent(event);
    });

    this.openaiWs.on('error', (err) => {
      console.error('[openai] WebSocket error:', err.message);
    });

    this.openaiWs.on('close', (code, reason) => {
      console.log(`[openai] WebSocket closed — code=${code} reason=${reason.toString()}`);
    });
  }

  private handleOpenAIEvent(event: OpenAIEvent) {
    switch (event.type) {

      case 'session.created': {
        const sess = event.session as { id?: string } | undefined;
        console.log(`[openai] session created — id=${sess?.id}`);
        this.configureSession();
        break;
      }

      case 'session.updated':
        console.log('[openai] session configured');
        this.openaiConfigured = true;
        this.maybeStartGreeting();
        break;

      case 'input_audio_buffer.speech_started':
        console.log('[openai] caller speech started');
        if (this.responseActive) {
          console.log('[openai] barge-in detected — clearing Twilio audio buffer');
          this.clearTwilioAudio();
        }
        break;

      case 'input_audio_buffer.speech_stopped':
        console.log('[openai] caller speech stopped');
        break;

      case 'response.created':
        console.log('[openai] assistant response started');
        this.responseActive = true;
        break;

      case 'response.output_audio.delta':
        this.sendAudioToTwilio(event.delta as string);
        break;

      case 'response.output_audio.done':
        console.log('[openai] assistant audio complete');
        break;

      case 'response.output_audio_transcript.done': {
        const t = event.transcript as string | undefined;
        if (t) console.log(`[transcript] assistant: "${t}"`);
        break;
      }

      case 'conversation.item.input_audio_transcription.completed': {
        const t = event.transcript as string | undefined;
        if (t) console.log(`[transcript] caller: "${t}"`);
        break;
      }

      case 'response.function_call_arguments.done': {
        const { call_id, name, arguments: argsStr } = event as unknown as {
          call_id: string; name: string; arguments: string;
        };
        console.log(`[openai] tool call — ${name}(${argsStr})`);
        this.handleToolCall(call_id, name, argsStr);
        break;
      }

      case 'response.done': {
        const r = event.response as { status?: string } | undefined;
        console.log(
          `[openai] response done — status=${r?.status} outputFrames=${this.outputAudioFrames}`,
        );
        this.responseActive = false;
        break;
      }

      case 'error': {
        const err = event.error as { code?: string; message?: string } | undefined;
        console.error(`[openai] API error — ${err?.code}: ${err?.message}`);
        break;
      }

      // Suppress high-frequency delta events
      case 'response.output_audio_transcript.delta':
      case 'response.content_part.added':
      case 'response.content_part.done':
      case 'response.output_item.added':
      case 'response.output_item.done':
      case 'conversation.item.created':
      case 'conversation.item.done':
      case 'rate_limits.updated':
      case 'output_audio_buffer.started':
        console.log('[openai] output audio buffer started');
        break;

      case 'output_audio_buffer.stopped':
        console.log('[openai] output audio buffer stopped');
        break;

      default:
        console.log(`[openai] unhandled event: ${event.type}`);
    }
  }

  private configureSession() {
    this.sendToOpenAI({
      type: 'session.update',
      session: {
        type: 'realtime',
        instructions: SYSTEM_PROMPT,
        audio: {
          input: {
            format: { type: 'audio/pcmu' },
            turn_detection: {
              type: 'semantic_vad',
              eagerness: 'low',
              create_response: true,
              interrupt_response: true,
            },
          },
          output: {
            format: { type: 'audio/pcmu' },
            voice: 'marin',
          },
        },
        tools: TOOLS,
        tool_choice: 'auto',
      },
    });
  }

  private maybeStartGreeting() {
    if (!this.greeted && this.openaiConfigured && this.streamSid) {
      this.greeted = true;
      this.flushPendingAudio();
      this.triggerGreeting();
    }
  }

  private triggerGreeting() {
    console.log('[openai] triggering opening greeting');
    this.sendToOpenAI({
      type: 'response.create',
      response: {
        instructions: `Open the call by saying exactly: "${INITIAL_GREETING}"`,
        output_modalities: ['audio'],
      },
    });
  }

  private handleToolCall(callId: string, name: string, argsStr: string) {
    let output = '{"success":true}';

    if (name === 'save_qualification') {
      try {
        const data = JSON.parse(argsStr) as Record<string, unknown>;
        console.log('[qualification] captured:', JSON.stringify(data, null, 2));
        // TODO: persist to database
      } catch {
        console.error('[qualification] failed to parse args:', argsStr);
        output = '{"success":false}';
      }
    } else {
      console.warn(`[openai] unknown tool: ${name}`);
    }

    // Return tool result so the model can continue the conversation
    this.sendToOpenAI({
      type: 'conversation.item.create',
      item: { type: 'function_call_output', call_id: callId, output },
    });
    this.sendToOpenAI({ type: 'response.create' });
  }

  private clearTwilioAudio() {
    if (this.streamSid) {
      this.sendToTwilio({ event: 'clear', streamSid: this.streamSid });
    }
  }

  // ─── Twilio Media Stream ──────────────────────────────────────────────────

  handleTwilioMessage(raw: string) {
    let msg: {
      event: string;
      start?: { callSid: string; streamSid: string; tracks: string[] };
      media?: { payload: string; track: string };
      stop?: { callSid: string };
    };

    try {
      msg = JSON.parse(raw) as typeof msg;
    } catch {
      console.error('[stream] invalid Twilio message');
      return;
    }

    switch (msg.event) {
      case 'connected':
        console.log('[stream] Twilio WebSocket connected');
        break;

      case 'start':
        this.streamSid = msg.start!.streamSid;
        this.callSid = msg.start!.callSid;
        console.log(
          `[stream] started — callSid=${this.callSid} streamSid=${this.streamSid}`,
        );
        this.maybeStartGreeting();
        break;

      case 'media':
        // Only forward inbound (caller) audio to OpenAI
        if (
          msg.media?.track !== 'outbound' &&
          msg.media?.payload
        ) {
          this.inputAudioFrames += 1;
          if (this.openaiWs?.readyState === WebSocket.OPEN) {
            this.sendInputAudio(msg.media.payload);
          } else {
            this.pendingInputAudio.push(msg.media.payload);
          }
        }
        break;

      case 'stop':
        console.log(`[stream] stopped — callSid=${msg.stop?.callSid ?? this.callSid}`);
        this.cleanup();
        break;

      default:
        console.log(`[stream] unknown event: ${msg.event}`);
    }
  }

  private sendAudioToTwilio(base64Audio: string) {
    this.outputAudioFrames += 1;
    if (!this.streamSid) {
      this.pendingAudio.push(base64Audio);
      return;
    }

    if (this.streamSid) {
      this.sendToTwilio({
        event: 'media',
        streamSid: this.streamSid,
        media: { payload: base64Audio },
      });
    }
  }

  private flushPendingAudio() {
    for (const audio of this.pendingAudio) {
      this.sendAudioToTwilio(audio);
    }
    this.pendingAudio = [];
  }

  private sendInputAudio(audio: string) {
    this.sendToOpenAI({ type: 'input_audio_buffer.append', audio });
  }

  private flushPendingInputAudio() {
    for (const audio of this.pendingInputAudio) {
      this.sendInputAudio(audio);
    }
    if (this.pendingInputAudio.length) {
      console.log(`[stream] flushed ${this.pendingInputAudio.length} buffered audio frames`);
    }
    this.pendingInputAudio = [];
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  private sendToOpenAI(event: unknown) {
    if (this.openaiWs?.readyState === WebSocket.OPEN) {
      this.openaiWs.send(JSON.stringify(event));
    } else {
      console.warn('[openai] send skipped — WebSocket not open');
    }
  }

  private sendToTwilio(event: unknown) {
    if (this.twilioWs.readyState === WebSocket.OPEN) {
      this.twilioWs.send(JSON.stringify(event));
    }
  }

  cleanup() {
    console.log(
      `[session] cleanup — callSid=${this.callSid} inputFrames=${this.inputAudioFrames} outputFrames=${this.outputAudioFrames}`,
    );
    if (this.openaiWs && this.openaiWs.readyState === WebSocket.OPEN) {
      this.openaiWs.close();
    }
  }
}

