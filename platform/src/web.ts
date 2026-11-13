import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile, readdir, rm, stat } from 'node:fs/promises';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { extname, join, normalize, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { analyzeTranscript, type AnalyzeResult } from './oneshot.js';
import { LiveSession, type LiveLine } from './live.js';
import { analyzeWindow } from './analyze.js';
import { signSession, verifyGoogleCredential, verifySession } from './auth.js';
import {
  getSubscription,
  loadEntitlements,
  saveEntitlements,
  verifyWebhook,
  type PaidEntitlement,
} from './billing.js';

const config = loadConfig();
const logger = createLogger(config.logLevel);
const demoDir = join(process.cwd(), 'demo');

/** Demo transcripts and boards are deleted after 24 hours. */
async function purgeOldArtifacts(): Promise<void> {
  const roots = [config.dataDir, join(config.dataDir, 'live')];
  for (const root of roots) {
    try {
      for (const name of await readdir(root)) {
        if (!name.startsWith('demo-') && !name.startsWith('live-')) continue;
        const target = join(root, name);
        const info = await stat(target).catch(() => undefined);
        if (info && Date.now() - info.mtimeMs > 24 * 60 * 60 * 1000) {
          await rm(target, { recursive: true, force: true });
        }
      }
    } catch {
      // directory may not exist yet
    }
  }
}

void purgeOldArtifacts();
setInterval(() => void purgeOldArtifacts(), 60 * 60 * 1000).unref();

interface Job {
  id: string;
  status: 'queued' | 'running' | 'done' | 'error';
  createdAt: number;
  result?: AnalyzeResult;
  boardPath?: string;
  error?: string;
}

const jobs = new Map<string, Job>();
let live: LiveSession | undefined;
let queue: Promise<unknown> = Promise.resolve();
const bootedAt = Date.now();
const liveUsage = new Map<string, { count: number; resetAt: number }>();
const analyzeUsage = new Map<string, { count: number; resetAt: number }>();
const pendingLogins = new Map<string, { token: string; email: string; exp: number }>();

/* ---------- trials ---------- */
const trialFile = join(config.dataDir, 'trials.json');
const trials = new Map<string, number>();
const paid: Map<string, PaidEntitlement> = loadEntitlements(config);
try {
  const raw = JSON.parse(readFileSync(trialFile, 'utf8')) as Record<string, number>;
  for (const [email, startedAt] of Object.entries(raw)) trials.set(email, startedAt);
} catch {
  // first run
}

function saveTrials(): void {
  mkdirSync(config.dataDir, { recursive: true });
  writeFileSync(trialFile, JSON.stringify(Object.fromEntries(trials), null, 2));
}

function startTrial(email: string): void {
  if (trials.has(email)) return;
  trials.set(email, Date.now());
  saveTrials();
}

function entitlement(email: string): { status: 'pilot' | 'active' | 'trial' | 'expired'; daysLeft: number } {
  if (config.auth.allowedEmails.includes(email.toLowerCase())) {
    return { status: 'pilot', daysLeft: 999 };
  }
  if (paid.get(email)?.status === 'active') {
    return { status: 'active', daysLeft: 999 };
  }
  if (!trials.has(email)) startTrial(email);
  const startedAt = trials.get(email) ?? Date.now();
  const daysLeft = Math.max(
    0,
    config.trialDays - Math.floor((Date.now() - startedAt) / (24 * 60 * 60 * 1000)),
  );
  return { status: daysLeft > 0 ? 'trial' : 'expired', daysLeft };
}
const transcribeUsage = new Map<string, { count: number; resetAt: number }>();

function allowTranscribe(ip: string, limit = 2000): boolean {
  const now = Date.now();
  const entry = transcribeUsage.get(ip);
  if (!entry || now > entry.resetAt) {
    transcribeUsage.set(ip, { count: 1, resetAt: now + 60 * 60 * 1000 });
    return true;
  }
  if (entry.count >= limit) return false;
  entry.count += 1;
  return true;
}

function allowAnalyze(ip: string, limit = 120): boolean {
  const now = Date.now();
  const entry = analyzeUsage.get(ip);
  if (!entry || now > entry.resetAt) {
    analyzeUsage.set(ip, { count: 1, resetAt: now + 60 * 60 * 1000 });
    return true;
  }
  if (entry.count >= limit) return false;
  entry.count += 1;
  return true;
}

function allowLive(ip: string, limit = 20): boolean {
  const now = Date.now();
  const entry = liveUsage.get(ip);
  if (!entry || now > entry.resetAt) {
    liveUsage.set(ip, { count: 1, resetAt: now + 60 * 60 * 1000 });
    return true;
  }
  if (entry.count >= limit) return false;
  entry.count += 1;
  return true;
}

function clientIp(req: IncomingMessage): string {
  return (
    (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim() ??
    req.socket.remoteAddress ??
    'unknown'
  );
}

function authorized(code: string | undefined): boolean {
  const value = (code ?? '').trim().toUpperCase();
  if (!value) return false;
  if (value === config.demo.code.toUpperCase()) return true;
  return config.demo.keys.some((key) => key.toUpperCase() === value);
}

/** Pilot/admin keys only — the public demo code must never unlock paid audio. */
function authorizedKey(code: string | undefined): boolean {
  const value = (code ?? '').trim().toUpperCase();
  if (!value) return false;
  return config.demo.keys.some((key) => key.toUpperCase() === value);
}
const ipUsage = new Map<string, { count: number; resetAt: number }>();

function allowIp(ip: string): boolean {
  const now = Date.now();
  const entry = ipUsage.get(ip);
  if (!entry || now > entry.resetAt) {
    ipUsage.set(ip, { count: 1, resetAt: now + 60 * 60 * 1000 });
    return true;
  }
  if (entry.count >= 5) return false;
  entry.count += 1;
  return true;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage, limit = 400_000): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('Transcript is too large. Keep it under 400 KB.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function serveStatic(res: ServerResponse, path: string): Promise<void> {
  const target = normalize(join(demoDir, path));
  if (!target.startsWith(demoDir + sep) && target !== demoDir) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  try {
    const data = await readFile(target);
    res.writeHead(200, {
      'content-type': MIME[extname(target)] ?? 'application/octet-stream',
      'cache-control': 'no-cache',
    });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end('Not found');
  }
}

function publicResult(job: Job): unknown {
  if (!job.result) return { id: job.id, status: job.status, error: job.error };
  return {
    status: job.status,
    ...job.result,
    boardUrl: job.boardPath ? `/api/board/${job.id}.png` : undefined,
  };
}

const server = createServer(async (req, res) => {
  try {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'content-type');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      return res.end();
    }

    const url = new URL(req.url ?? '/', 'http://localhost');

    if (req.method === 'GET' && url.pathname === '/v1/config') {
      return json(res, 200, {
        googleClientId: config.auth.googleClientId ?? null,
        googleEnabled: Boolean(config.auth.googleClientId),
        planId: config.billing.planId,
        paypalClientId: config.billing.clientId ?? null,
        trialDays: config.trialDays,
      });
    }

    if (req.method === 'POST' && url.pathname === '/v1/billing/activate') {
      const authHeader = req.headers.authorization;
      const bearer =
        typeof authHeader === 'string' && authHeader.startsWith('Bearer ')
          ? authHeader.slice(7)
          : undefined;
      const session = bearer ? verifySession(bearer, config.auth.sessionSecret) : null;
      if (!session) return json(res, 401, { error: 'Sign in first.' });
      const body = JSON.parse(await readBody(req)) as { subscriptionId?: string };
      if (!body.subscriptionId) return json(res, 400, { error: 'Missing subscription id.' });

      try {
        const subscription = await getSubscription(config, body.subscriptionId);
        if (!['ACTIVE', 'APPROVED'].includes(subscription.status)) {
          return json(res, 400, { error: `Subscription is ${subscription.status}.` });
        }
        if (subscription.plan_id && subscription.plan_id !== config.billing.planId) {
          return json(res, 400, { error: 'Subscription is for a different plan.' });
        }
        if (
          subscription.custom_id &&
          subscription.custom_id.toLowerCase() !== session.email.toLowerCase()
        ) {
          return json(res, 403, { error: 'Subscription belongs to another account.' });
        }
        paid.set(session.email, {
          email: session.email,
          subscriptionId: subscription.id,
          status: 'active',
          updatedAt: new Date().toISOString(),
        });
        saveEntitlements(config, paid);
        return json(res, 200, { status: 'active', planId: config.billing.planId });
      } catch (error) {
        return json(res, 400, {
          error: error instanceof Error ? error.message : 'Activation failed.',
        });
      }
    }

    if (req.method === 'POST' && url.pathname === '/v1/paypal/webhook') {
      const raw = await readBody(req, 1_000_000);
      let event: { event_type?: string; resource?: Record<string, unknown> };
      try {
        event = JSON.parse(raw) as typeof event;
      } catch {
        return json(res, 400, { error: 'Invalid JSON.' });
      }
      if (!config.billing.webhookId) {
        return json(res, 503, { error: 'PayPal webhook is not configured.' });
      }
      try {
        const valid = await verifyWebhook(config, req.headers, event);
        if (!valid) return json(res, 400, { error: 'Invalid webhook signature.' });
      } catch (error) {
        return json(res, 502, {
          error: error instanceof Error ? error.message : 'Webhook verification failed.',
        });
      }

      const type = event.event_type ?? '';
      const resource = event.resource ?? {};
      let email = typeof resource.custom_id === 'string' ? resource.custom_id : undefined;
      const subscriptionId = typeof resource.id === 'string' ? resource.id : '';

      if (!email && subscriptionId) {
        for (const [candidate, entry] of paid) {
          if (entry.subscriptionId === subscriptionId) {
            email = candidate;
            break;
          }
        }
      }

      const activating = [
        'BILLING.SUBSCRIPTION.ACTIVATED',
        'BILLING.SUBSCRIPTION.RE-ACTIVATED',
      ].includes(type);
      const deactivating = [
        'BILLING.SUBSCRIPTION.CANCELLED',
        'BILLING.SUBSCRIPTION.SUSPENDED',
        'BILLING.SUBSCRIPTION.EXPIRED',
      ].includes(type);

      if (email && (activating || deactivating)) {
        paid.set(email, {
          email,
          subscriptionId,
          status: activating ? 'active' : 'inactive',
          updatedAt: new Date().toISOString(),
        });
        saveEntitlements(config, paid);
      }
      return json(res, 200, { ok: true });
    }

    if (req.method === 'GET' && url.pathname === '/v1/entitlement') {
      const authHeader = req.headers.authorization;
      const bearer =
        typeof authHeader === 'string' && authHeader.startsWith('Bearer ')
          ? authHeader.slice(7)
          : undefined;
      const session = bearer ? verifySession(bearer, config.auth.sessionSecret) : null;
      if (!session) return json(res, 401, { error: 'Sign in first.' });
      return json(res, 200, {
        email: session.email,
        ...entitlement(session.email),
        planId: config.billing.planId,
        trialDays: config.trialDays,
      });
    }

    if (req.method === 'GET' && url.pathname === '/v1/auth/google/start') {
      if (!config.auth.googleClientId || !config.auth.googleClientSecret) {
        return json(res, 400, { error: 'Google sign-in is not configured.' });
      }
      const state = url.searchParams.get('state') ?? '';
      if (!/^[\w-]{8,80}$/.test(state)) {
        return json(res, 400, { error: 'Invalid state.' });
      }
      const params = new URLSearchParams({
        client_id: config.auth.googleClientId,
        redirect_uri: `${config.publicBaseUrl}/v1/auth/google/callback`,
        response_type: 'code',
        scope: 'openid email profile',
        state,
        prompt: 'select_account',
      });
      res.writeHead(302, {
        location: `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`,
      });
      return res.end();
    }

    if (req.method === 'GET' && url.pathname === '/v1/auth/google/callback') {
      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state') ?? '';
      const fail = (message: string): void => {
        res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' });
        res.end(`<!doctype html><meta charset="utf-8"><title>TalkSketch</title><body style="font-family:system-ui;padding:40px"><h1>Sign-in failed</h1><p>${message}</p><p>Return to TalkSketch and try again.</p></body>`);
      };
      if (!code || !state) return fail('Google did not return a code.');
      if (!config.auth.googleClientId || !config.auth.googleClientSecret) {
        return fail('Google sign-in is not configured on this server.');
      }

      try {
        const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            code,
            client_id: config.auth.googleClientId,
            client_secret: config.auth.googleClientSecret,
            redirect_uri: `${config.publicBaseUrl}/v1/auth/google/callback`,
            grant_type: 'authorization_code',
          }),
        });
        const tokens = (await tokenResponse.json()) as { id_token?: string; error?: string };
        if (!tokenResponse.ok || !tokens.id_token) {
          return fail(tokens.error ?? 'Could not exchange the Google code.');
        }
        const account = await verifyGoogleCredential(tokens.id_token, config.auth.googleClientId);
        if (
          config.auth.allowedEmails.length > 0 &&
          !config.auth.allowedEmails.includes(account.email.toLowerCase())
        ) {
          return fail('This Google account is not on the pilot list.');
        }
        startTrial(account.email);
        pendingLogins.set(state, {
          token: signSession(account.email, config.auth.sessionSecret),
          email: account.email,
          exp: Date.now() + 10 * 60 * 1000,
        });
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        return res.end(`<!doctype html><meta charset="utf-8"><title>TalkSketch</title><body style="font-family:system-ui;padding:40px"><h1>Signed in</h1><p>${account.email}</p><p>Return to the TalkSketch app. It will finish signing in automatically.</p></body>`);
      } catch (error) {
        return fail(error instanceof Error ? error.message : 'Sign-in failed.');
      }
    }

    if (req.method === 'GET' && url.pathname === '/v1/auth/google/poll') {
      const state = url.searchParams.get('state') ?? '';
      const entry = pendingLogins.get(state);
      if (!entry || entry.exp < Date.now()) {
        pendingLogins.delete(state);
        return json(res, 202, { status: 'pending' });
      }
      pendingLogins.delete(state);
      return json(res, 200, { status: 'ok', token: entry.token, email: entry.email });
    }

    if (req.method === 'POST' && url.pathname === '/v1/auth/google') {
      if (!config.auth.googleClientId) {
        return json(res, 400, { error: 'Google sign-in is not configured on this server.' });
      }
      const body = JSON.parse(await readBody(req)) as { credential?: string };
      if (!body.credential) return json(res, 400, { error: 'Missing Google credential.' });
      try {
        const account = await verifyGoogleCredential(body.credential, config.auth.googleClientId);
        if (
          config.auth.allowedEmails.length > 0 &&
          !config.auth.allowedEmails.includes(account.email.toLowerCase())
        ) {
          return json(res, 403, { error: 'This Google account is not on the pilot list.' });
        }
        startTrial(account.email);
        return json(res, 200, {
          token: signSession(account.email, config.auth.sessionSecret),
          email: account.email,
          ...(account.name ? { name: account.name } : {}),
        });
      } catch (error) {
        return json(res, 401, {
          error: error instanceof Error ? error.message : 'Google sign-in failed.',
        });
      }
    }

    if (req.method === 'POST' && url.pathname === '/v1/analyze') {
      const body = JSON.parse(await readBody(req, 200_000)) as {
        transcript?: string;
        topic?: string;
        participants?: string[];
        existingNotes?: string[];
        code?: string;
      };
      const authHeader = req.headers.authorization;
      const bearer =
        typeof authHeader === 'string' && authHeader.startsWith('Bearer ')
          ? authHeader.slice(7)
          : undefined;
      const session = bearer ? verifySession(bearer, config.auth.sessionSecret) : null;
      if (!session && !authorized(body.code)) {
        return json(res, 401, { error: 'Sign in with Google or provide an access key.' });
      }
      if (session) {
        const ent = entitlement(session.email);
        if (ent.status === 'expired') {
          return json(res, 402, {
            error: `Your ${config.trialDays}-day trial has ended. Subscribe to continue.`,
            planId: config.billing.planId,
          });
        }
      }
      if (!allowAnalyze(clientIp(req))) {
        return json(res, 429, { error: 'Too many analyses. Try again in a while.' });
      }
      try {
        const result = await analyzeWindow(
          {
            transcript: body.transcript ?? '',
            ...(body.topic ? { topic: body.topic } : {}),
            participants: Array.isArray(body.participants) ? body.participants : [],
            existingNotes: Array.isArray(body.existingNotes) ? body.existingNotes : [],
          },
          config,
        );
        return json(res, 200, result);
      } catch (error) {
        return json(res, 400, {
          error: error instanceof Error ? error.message : 'Analysis failed.',
        });
      }
    }

    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      return serveStatic(res, 'index.html');
    }

    if (req.method === 'GET' && url.pathname === '/live') {
      return serveStatic(res, 'live.html');
    }

    if (req.method === 'GET' && ['/app.js', '/live.js', '/styles.css', '/assets/logo.svg', '/assets/favicon.svg'].includes(url.pathname)) {
      return serveStatic(res, url.pathname.slice(1));
    }

    if (req.method === 'POST' && url.pathname === '/v1/transcribe') {
      const body = JSON.parse(await readBody(req, 12_000_000)) as {
        audio?: string;
        mime?: string;
        code?: string;
        language?: string;
      };
      const authHeader = req.headers.authorization;
      const bearer =
        typeof authHeader === 'string' && authHeader.startsWith('Bearer ')
          ? authHeader.slice(7)
          : undefined;
      const session = bearer ? verifySession(bearer, config.auth.sessionSecret) : null;
      if (!session && !authorizedKey(body.code)) {
        return json(res, 401, { error: 'Sign in with Google or provide an access key.' });
      }
      if (session) {
        const ent = entitlement(session.email);
        if (ent.status === 'expired') {
          return json(res, 402, {
            error: `Your ${config.trialDays}-day trial has ended. Subscribe to continue.`,
            planId: config.billing.planId,
          });
        }
      }
      if (!config.stt.apiKey) {
        return json(res, 503, { error: 'Transcription is not configured on this server.' });
      }
      if (!allowTranscribe(clientIp(req))) {
        return json(res, 429, { error: 'Too many audio chunks. Try again later.' });
      }
      const audio = Buffer.from(body.audio ?? '', 'base64');
      if (audio.length < 1000) return json(res, 400, { error: 'Audio chunk is too small.' });
      if (audio.length > 8_000_000) return json(res, 413, { error: 'Audio chunk is too large.' });

      try {
        const form = new FormData();
        form.append(
          'file',
          new Blob([new Uint8Array(audio)], { type: body.mime || 'audio/webm' }),
          'chunk.webm',
        );
        const language = body.language && body.language !== 'auto' ? body.language : undefined;

        if (config.stt.provider === 'xai') {
          if (language) form.append('language', language);
          const response = await fetch(`${config.stt.baseUrl}/stt`, {
            method: 'POST',
            headers: { authorization: `Bearer ${config.stt.apiKey}` },
            body: form,
          });
          if (!response.ok) {
            return json(res, 502, {
              error: `Transcription provider responded ${response.status}`,
            });
          }
          const data = (await response.json()) as { text?: string; language?: string };
          return json(res, 200, {
            text: (data.text ?? '').trim(),
            language: data.language ?? null,
          });
        }

        form.append('model', config.stt.model);
        form.append('response_format', 'json');
        if (language) form.append('language', language);
        const response = await fetch(`${config.stt.baseUrl}/audio/transcriptions`, {
          method: 'POST',
          headers: { authorization: `Bearer ${config.stt.apiKey}` },
          body: form,
        });
        if (!response.ok) {
          return json(res, 502, { error: `Transcription provider responded ${response.status}` });
        }
        const data = (await response.json()) as { text?: string };
        return json(res, 200, { text: (data.text ?? '').trim() });
      } catch (error) {
        return json(res, 502, {
          error: error instanceof Error ? error.message : 'Transcription failed.',
        });
      }
    }

    if (req.method === 'GET' && url.pathname === '/healthz') {
      return json(res, 200, {
        ok: true,
        uptimeSeconds: Math.round((Date.now() - bootedAt) / 1000),
        live: Boolean(live),
        jobs: jobs.size,
        rssMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
      });
    }

    if (req.method === 'POST' && url.pathname === '/api/live/start') {
      const body = JSON.parse(await readBody(req)) as {
        code?: string;
        topic?: string;
        participants?: string;
      };
      if (!authorized(body.code)) {
        return json(res, 401, { error: 'That access key is not valid.' });
      }
      if (!allowLive(clientIp(req))) {
        return json(res, 429, { error: 'Too many sessions from this address. Try again later.' });
      }
      if (live) {
        if (live.state().active && live.idleMs() < 30 * 60 * 1000) {
          return json(res, 409, {
            error: 'Another meeting is live right now. Try again when it ends.',
          });
        }
        await live.end();
        live = undefined;
      }
      live = await LiveSession.create(
        config,
        logger,
        body.topic?.trim() || 'Live meeting',
        (body.participants ?? '')
          .split(',')
          .map((name) => name.trim())
          .filter(Boolean),
        `live-${Date.now()}`,
      );
      return json(res, 200, { ok: true });
    }

    if (req.method === 'POST' && url.pathname === '/api/live/ingest') {
      const body = JSON.parse(await readBody(req)) as {
        code?: string;
        lines?: LiveLine[];
        text?: string;
        topic?: string;
      };
      if (!authorized(body.code)) {
        return json(res, 401, { error: 'That access key is not valid.' });
      }
      if (!allowLive(clientIp(req), 400)) {
        return json(res, 429, { error: 'Too many caption lines from this address.' });
      }
      if (!live) {
        live = await LiveSession.create(
          config,
          logger,
          body.topic?.trim() || 'Live meeting',
          [],
          `live-${Date.now()}`,
        );
      }
      const lines: LiveLine[] = Array.isArray(body.lines)
        ? body.lines
        : (body.text ?? '')
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter(Boolean)
            .map((line) => {
              const match = line.match(/^([\p{L}][\p{L}\p{N} .'’-]{0,40}):\s*(.+)$/u);
              return { speaker: match?.[1] ?? 'Participant', text: match?.[2] ?? line };
            });
      live.ingest(lines);
      return json(res, 200, { ok: true, received: lines.length });
    }

    if (req.method === 'GET' && url.pathname === '/api/live/board.png') {
      if (!authorized(url.searchParams.get('code') ?? (req.headers['x-access-key'] as string | undefined))) {
        return json(res, 401, { error: 'Access key required.' });
      }
      if (!live) return json(res, 404, { error: 'No live meeting.' });
      const file = await live.snapshotBoard();
      if (!file) return json(res, 404, { error: 'Board not available.' });
      try {
        const image = await readFile(file);
        res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' });
        return res.end(image);
      } catch {
        return json(res, 404, { error: 'Board not available.' });
      }
    }

    if (req.method === 'GET' && url.pathname === '/api/live/state') {
      if (!authorized(url.searchParams.get('code') ?? (req.headers['x-access-key'] as string | undefined))) {
        return json(res, 401, { error: 'Access key required.' });
      }
      return json(res, 200, live ? live.state() : { active: false, elapsedMs: 0, segments: 0, notes: [], suggestions: [], actions: [] });
    }

    if (req.method === 'POST' && url.pathname === '/api/live/end') {
      if (!live) return json(res, 404, { error: 'No live meeting.' });
      const state = await live.end();
      live = undefined;
      return json(res, 200, state);
    }

    if (req.method === 'GET' && url.pathname === '/api/sample') {
      const raw = await readFile(join(process.cwd(), 'fixtures', 'company-meeting.json'), 'utf8');
      const script = JSON.parse(raw) as Array<{ speaker: string; text: string }>;
      const text = script.map((line) => `${line.speaker}: ${line.text}`).join('\n');
      return json(res, 200, { transcript: text });
    }

    if (req.method === 'POST' && url.pathname === '/api/analyze') {
      const body = JSON.parse(await readBody(req)) as {
        code?: string;
        transcript?: string;
        topic?: string;
        participants?: string;
      };

      if (!authorized(body.code)) {
        return json(res, 401, { error: 'That access key is not valid.' });
      }
      const ip =
        (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim() ??
        req.socket.remoteAddress ??
        'unknown';
      if (!allowIp(ip)) {
        return json(res, 429, { error: 'Demo limit reached (5 analyses per hour). Try again later.' });
      }
      const transcript = (body.transcript ?? '').trim();
      if (transcript.length < 80) {
        return json(res, 400, { error: 'Paste a longer transcript (at least a few lines).' });
      }

      const job: Job = { id: randomUUID().slice(0, 12), status: 'queued', createdAt: Date.now() };
      jobs.set(job.id, job);

      queue = queue
        .then(async () => {
          job.status = 'running';
          logger.info('demo job started', { id: job.id, chars: transcript.length });
          try {
            const result = await analyzeTranscript(
              {
                transcript,
                ...(body.topic ? { topic: body.topic } : {}),
                participants: (body.participants ?? '')
                  .split(',')
                  .map((name) => name.trim())
                  .filter(Boolean),
              },
              config,
              logger,
            );
            job.result = result;
            job.boardPath = result.boardUrl;
            job.status = 'done';
            logger.info('demo job finished', { id: job.id, ms: result.elapsedMs });
          } catch (error) {
            job.status = 'error';
            job.error = error instanceof Error ? error.message : String(error);
            logger.error('demo job failed', { id: job.id, error: job.error });
          }
        })
        .catch(() => undefined);

      return json(res, 202, { id: job.id, status: job.status });
    }

    const jobMatch = url.pathname.match(/^\/api\/jobs\/([\w-]+)$/);
    if (req.method === 'GET' && jobMatch?.[1]) {
      const job = jobs.get(jobMatch[1]);
      if (!job) return json(res, 404, { error: 'Unknown job.' });
      return json(res, 200, publicResult(job));
    }

    const boardMatch = url.pathname.match(/^\/api\/board\/([\w-]+)\.png$/);
    if (req.method === 'GET' && boardMatch?.[1]) {
      const job = jobs.get(boardMatch[1]);
      if (!job?.boardPath) return json(res, 404, { error: 'No board for this job.' });
      try {
        const image = await readFile(job.boardPath);
        res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' });
        return res.end(image);
      } catch {
        return json(res, 404, { error: 'Board image expired.' });
      }
    }

    res.writeHead(404);
    res.end('Not found');
  } catch (error) {
    logger.error('request failed', { error: error instanceof Error ? error.message : String(error) });
    json(res, 500, { error: 'Something went wrong.' });
  }
});

server.listen(config.demo.port, '0.0.0.0', () => {
  logger.info('demo server ready', { port: config.demo.port, codeRequired: true });
});
