import 'dotenv/config';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { Platform } from './types.js';

const PlatformSchema = z.enum(['google_meet', 'zoom', 'teams', 'jitsi']);

const EnvSchema = z.object({
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  // Meeting
  MEETING_PLATFORM: PlatformSchema.default('google_meet'),
  MEETING_ID: z.string().min(1).optional(),
  MEETING_TOPIC: z.string().optional(),
  MEETING_PARTICIPANTS: z.string().optional(),
  COMPANY_CONTEXT: z.string().optional(),
  BOT_NAME: z.string().default('Scribe'),

  // Transcript source (Vexa's documented REST endpoint)
  TRANSCRIPT_SOURCE: z.enum(['vexa', 'mock']).default('mock'),
  MOCK_SCRIPT: z.string().optional(),
  VEXA_BASE_URL: z.string().url().default('http://localhost:18056'),
  VEXA_API_KEY: z.string().optional(),
  POLL_INTERVAL_MS: z.coerce.number().int().positive().default(2000),
  END_AFTER_SILENCE_MS: z.coerce.number().int().positive().default(180_000),
  MOCK_SPEED: z.coerce.number().positive().default(3),

  // Agent
  OPENAI_API_KEY: z.string().min(1, 'OPENAI_API_KEY is required'),
  OPENAI_BASE_URL: z.string().url().default('https://api.deepseek.com'),
  OPENAI_MODEL: z.string().default('deepseek-flash'),
  RUN_INTERVAL_MS: z.coerce.number().int().positive().default(20_000),
  MAX_TURNS: z.coerce.number().int().min(1).max(20).default(6),

  // Excalidraw canvas (mcp-excalidraw-server)
  EXPRESS_SERVER_URL: z.string().url().default('http://127.0.0.1:3000'),
  RESET_BOARD: z
    .string()
    .default('true')
    .transform((value) => value !== 'false'),

  // Policy
  NOTE_MIN_INTERVAL_MS: z.coerce.number().int().positive().default(60_000),
  SUGGESTION_MIN_INTERVAL_MS: z.coerce.number().int().positive().default(120_000),
  MAX_SUGGESTIONS: z.coerce.number().int().min(0).default(3),
  NOTE_WARMUP_MS: z.coerce.number().int().min(0).default(45_000),
  SUGGESTION_MIN_MEETING_MS: z.coerce.number().int().min(0).default(120_000),
  CONTEXT_MAX_TOKENS: z.coerce.number().int().positive().default(2000),

  DATA_DIR: z.string().default('./data'),
  DEMO_PORT: z.coerce.number().int().positive().default(8788),
  DEMO_CODE: z.string().min(1).default('TALKSKETCH'),
  /** Comma-separated pilot keys. Each client gets one; revoke by removing it. */
  ACCESS_KEYS: z.string().optional(),
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  PUBLIC_BASE_URL: z.string().url().default('https://54.255.181.218.sslip.io'),
  ALLOWED_EMAILS: z.string().optional(),
  SESSION_SECRET: z.string().optional(),
  TRIAL_DAYS: z.coerce.number().int().min(1).max(30).default(3),
  PAYPAL_PLAN_ID: z.string().default('P-0ET25800HC594571SNL3ONGY'),
  PAYPAL_CLIENT_ID: z.string().optional(),
  PAYPAL_CLIENT_SECRET: z.string().optional(),
  PAYPAL_WEBHOOK_ID: z.string().optional(),
  PAYPAL_API_BASE: z.string().url().default('https://api-m.paypal.com'),

  // Speech-to-text for native audio capture (OpenAI-compatible)
  STT_API_KEY: z.string().optional(),
  STT_BASE_URL: z.string().url().default('https://api.openai.com/v1'),
  STT_MODEL: z.string().default('whisper-1'),
});

export interface Config {
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  meeting: {
    platform: Platform;
    nativeMeetingId?: string;
    topic?: string;
    participants: string[];
    companyContext?: string;
    botName: string;
  };
  transcript: {
    source: 'vexa' | 'mock';
    mockScript?: string;
    vexaBaseUrl: string;
    vexaApiKey?: string;
    pollIntervalMs: number;
    endAfterSilenceMs: number;
    mockSpeed: number;
  };
  llm: {
    apiKey: string;
    baseUrl?: string;
    model: string;
    runIntervalMs: number;
    maxTurns: number;
  };
  excalidraw: {
    canvasUrl: string;
    resetBoard: boolean;
  };
  policy: {
    noteMinIntervalMs: number;
    suggestionMinIntervalMs: number;
    maxSuggestions: number;
    noteWarmupMs: number;
    suggestionMinMeetingAgeMs: number;
    contextMaxTokens: number;
  };
  dataDir: string;
  demo: {
    port: number;
    code: string;
    keys: string[];
  };
  auth: {
    googleClientId?: string;
    googleClientSecret?: string;
    allowedEmails: string[];
    sessionSecret: string;
  };
  publicBaseUrl: string;
  trialDays: number;
  billing: {
    planId: string;
    clientId?: string;
    clientSecret?: string;
    webhookId?: string;
    apiBase: string;
  };
  stt: {
    apiKey?: string;
    baseUrl: string;
    model: string;
  };
}

function splitList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${details}`);
  }
  const value = parsed.data;

  if (value.TRANSCRIPT_SOURCE === 'vexa' && !value.MEETING_ID) {
    throw new Error('MEETING_ID is required when TRANSCRIPT_SOURCE=vexa');
  }

  return {
    logLevel: value.LOG_LEVEL,
    meeting: {
      platform: value.MEETING_PLATFORM,
      nativeMeetingId: value.MEETING_ID,
      topic: value.MEETING_TOPIC,
      participants: splitList(value.MEETING_PARTICIPANTS),
      companyContext: value.COMPANY_CONTEXT,
      botName: value.BOT_NAME,
    },
    transcript: {
      source: value.TRANSCRIPT_SOURCE,
      mockScript: value.MOCK_SCRIPT,
      vexaBaseUrl: value.VEXA_BASE_URL.replace(/\/$/, ''),
      vexaApiKey: value.VEXA_API_KEY,
      pollIntervalMs: value.POLL_INTERVAL_MS,
      endAfterSilenceMs: value.END_AFTER_SILENCE_MS,
      mockSpeed: value.MOCK_SPEED,
    },
    llm: {
      apiKey: value.OPENAI_API_KEY,
      baseUrl: value.OPENAI_BASE_URL,
      model: value.OPENAI_MODEL,
      runIntervalMs: value.RUN_INTERVAL_MS,
      maxTurns: value.MAX_TURNS,
    },
    excalidraw: {
      canvasUrl: value.EXPRESS_SERVER_URL.replace(/\/$/, ''),
      resetBoard: value.RESET_BOARD,
    },
    policy: {
      noteMinIntervalMs: value.NOTE_MIN_INTERVAL_MS,
      suggestionMinIntervalMs: value.SUGGESTION_MIN_INTERVAL_MS,
      maxSuggestions: value.MAX_SUGGESTIONS,
      noteWarmupMs: value.NOTE_WARMUP_MS,
      suggestionMinMeetingAgeMs: value.SUGGESTION_MIN_MEETING_MS,
      contextMaxTokens: value.CONTEXT_MAX_TOKENS,
    },
    dataDir: value.DATA_DIR,
    demo: {
      port: value.DEMO_PORT,
      code: value.DEMO_CODE,
      keys: splitList(value.ACCESS_KEYS),
    },
    auth: {
      ...(value.GOOGLE_CLIENT_ID ? { googleClientId: value.GOOGLE_CLIENT_ID } : {}),
      ...(value.GOOGLE_CLIENT_SECRET ? { googleClientSecret: value.GOOGLE_CLIENT_SECRET } : {}),
      allowedEmails: splitList(value.ALLOWED_EMAILS).map((email) => email.toLowerCase()),
      sessionSecret: value.SESSION_SECRET ?? randomBytes(32).toString('hex'),
    },
    publicBaseUrl: value.PUBLIC_BASE_URL.replace(/\/$/, ''),
    trialDays: value.TRIAL_DAYS,
    billing: {
      planId: value.PAYPAL_PLAN_ID,
      ...(value.PAYPAL_CLIENT_ID ? { clientId: value.PAYPAL_CLIENT_ID } : {}),
      ...(value.PAYPAL_CLIENT_SECRET ? { clientSecret: value.PAYPAL_CLIENT_SECRET } : {}),
      ...(value.PAYPAL_WEBHOOK_ID ? { webhookId: value.PAYPAL_WEBHOOK_ID } : {}),
      apiBase: value.PAYPAL_API_BASE.replace(/\/$/, ''),
    },
    stt: {
      ...(value.STT_API_KEY ? { apiKey: value.STT_API_KEY } : {}),
      baseUrl: value.STT_BASE_URL.replace(/\/$/, ''),
      model: value.STT_MODEL,
    },
  };
}
