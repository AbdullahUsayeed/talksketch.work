import { loadConfig, type Config } from './config.js';
import { readFileSync } from 'node:fs';
import { createAgentSession } from './agent.js';
import { createLogger, type Logger } from './logger.js';
import { NotesStore, renderSummary } from './notes/NotesStore.js';
import { buildConclusion } from './notes/conclusion.js';
import { Gatekeeper } from './policy/Gatekeeper.js';
import { MockTranscriptSource, type MockScriptItem } from './transcript/MockTranscriptSource.js';
import { TranscriptBuffer } from './transcript/TranscriptBuffer.js';
import type { EndReason, TranscriptSource } from './transcript/TranscriptSource.js';
import { VexaTranscriptSource } from './transcript/VexaTranscriptSource.js';
import type { MeetingMeta, NoteRecord } from './types.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.logLevel);
  const meta = buildMeta(config);

  const store = new NotesStore(config.dataDir, meta);
  await store.init();

  const buffer = new TranscriptBuffer({ maxTokens: config.policy.contextMaxTokens });
  const gatekeeper = new Gatekeeper({
    noteMinIntervalMs: config.policy.noteMinIntervalMs,
    suggestionMinIntervalMs: config.policy.suggestionMinIntervalMs,
    maxSuggestions: config.policy.maxSuggestions,
    noteWarmupMs: config.policy.noteWarmupMs,
    suggestionMinMeetingAgeMs: config.policy.suggestionMinMeetingAgeMs,
    meetingStartAt: Date.parse(meta.startedAt),
  });

  const source = buildSource(config, logger);
  const session = await createAgentSession({ config, meta, store, gatekeeper, logger });

  if (!session.boardConnected) {
    logger.warn('running without a whiteboard; start the canvas with: npx -y mcp-excalidraw-server start');
  }

  let inFlight = false;
  let rerun = false;
  let ended = false;
  let timer: NodeJS.Timeout | undefined;

  const turn = async (kind: 'interval' | 'final'): Promise<string> => {
    if (ended && kind === 'interval') return '';
    if (inFlight) {
      rerun = true;
      return '';
    }
    if (kind === 'interval' && !buffer.hasPending()) return '';
    if (buffer.size() === 0) return '';

    inFlight = true;
    buffer.consumePending();
    try {
      const prompt =
        kind === 'final'
          ? finalPrompt(meta, buffer.render(), elapsed(meta))
          : intervalPrompt(meta, buffer.render(), elapsed(meta));

      const output =
        kind === 'final'
          ? await withTimeout(session.run(prompt, { maxTurns: 2 }), 45_000)
          : await session.run(prompt);
      logger.info('agent turn complete', { kind, output: output.slice(0, 300) });
      return output;
    } catch (error) {
      logger.error('agent turn failed', {
        kind,
        error: error instanceof Error ? error.message : String(error),
      });
      return '';
    } finally {
      inFlight = false;
      if (rerun && !ended) {
        rerun = false;
        void turn('interval');
      }
    }
  };

  const finish = async (reason: EndReason | 'manual'): Promise<void> => {
    if (ended) return;
    ended = true;
    logger.info('meeting ended', { reason });
    if (timer) clearInterval(timer);
    timer = undefined;

    try {
      await source.stop();
    } catch (error) {
      logger.warn('failed to stop transcript source', { error: messageOf(error) });
    }

    // Let a turn that was already calling the model finish before the final one.
    for (let i = 0; i < 450 && inFlight; i += 1) {
      await sleep(100);
    }
    if (inFlight) logger.warn('a turn was still running; summarizing anyway');

    const summary = (await turn('final')) || fallbackSummary(store.all());    if (!summary.trim()) logger.warn('no summary text available');
    await session.addConclusion(buildConclusion(store.all()));
    await store.saveSummary(renderSummary(meta, store.all(), summary));
    await session.close();

    const counts = countKinds(store.all());
    logger.info('artifacts written', {
      dir: store.path(),
      notes: counts.note,
      suggestions: counts.suggestion,
      actions: counts.action,
    });
    process.exit(0);
  };

  await source.start({
    onSegment: (segment) => {
      if (buffer.add(segment) && config.logLevel === 'debug') {
        logger.debug('segment', { speaker: segment.speaker, text: segment.text.slice(0, 80) });
      }
    },
    onEnd: (reason) => {
      void finish(reason);
    },
  });

  timer = setInterval(() => {
    void turn('interval');
  }, config.llm.runIntervalMs);
  timer.unref?.();

  logger.info('meeting partner running', {
    meeting: meta.id,
    source: source.name,
    model: config.llm.model,
    canvas: config.excalidraw.canvasUrl,
    intervalMs: config.llm.runIntervalMs,
  });

  const shutdown = (signal: string): void => {
    logger.info('shutting down', { signal });
    void finish('manual').finally(() => process.exit(0));
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

function buildMeta(config: Config): MeetingMeta {
  const nativeMeetingId =
    config.meeting.nativeMeetingId ??
    `mock-${new Date().toISOString().replace(/[:.]/g, '-')}`;

  return {
    id: `${config.meeting.platform}-${nativeMeetingId}`,
    platform: config.meeting.platform,
    nativeMeetingId,
    participants: config.meeting.participants,
    startedAt: new Date().toISOString(),
    botName: config.meeting.botName,
    ...(config.meeting.topic ? { topic: config.meeting.topic } : {}),
    ...(config.meeting.companyContext ? { companyContext: config.meeting.companyContext } : {}),
  };
}

function buildSource(config: Config, logger: Logger): TranscriptSource {
  if (config.transcript.source === 'mock') {
    if (config.transcript.mockScript) {
      const script = JSON.parse(readFileSync(config.transcript.mockScript, 'utf8')) as MockScriptItem[];
      logger.info('using mock script', { path: config.transcript.mockScript, segments: script.length });
      return new MockTranscriptSource({ script, speed: config.transcript.mockSpeed, logger });
    }
    return new MockTranscriptSource({ speed: config.transcript.mockSpeed, logger });
  }
  if (!config.transcript.vexaApiKey) {
    logger.warn('VEXA_API_KEY is not set; transcript requests will likely be rejected');
  }
  return new VexaTranscriptSource({
    baseUrl: config.transcript.vexaBaseUrl,
    ...(config.transcript.vexaApiKey ? { apiKey: config.transcript.vexaApiKey } : {}),
    platform: config.meeting.platform,
    nativeMeetingId: config.meeting.nativeMeetingId as string,
    pollIntervalMs: config.transcript.pollIntervalMs,
    endAfterSilenceMs: config.transcript.endAfterSilenceMs,
    logger,
  });
}

function intervalPrompt(meta: MeetingMeta, transcript: string, elapsedLabel: string): string {
  return [
    `Elapsed: ${elapsedLabel}.`,
    '',
    'Confirmed transcript window:',
    transcript,
    '',
    'Review the conversation. Act only where it adds value; otherwise reply "-".',
  ].join('\n');
}

function finalPrompt(meta: MeetingMeta, transcript: string, elapsedLabel: string): string {
  return [
    `The meeting has ended after ${elapsedLabel}.`,
    '',
    'Do not call any tools. Reply with plain text only.',
    '',
    'Write a 3-5 sentence summary for a colleague who missed the meeting.',
    'Cover the decisions, the owners and dates, and any open risk.',
    'Use only what is in the transcript and the recorded notes above.',
    '',
    'Final transcript window:',
    transcript,
  ].join('\n');
}

function fallbackSummary(records: readonly NoteRecord[]): string {
  const notes = records
    .filter((record) => record.kind === 'note')
    .slice(-4)
    .map((record) => record.content.trim());
  if (notes.length === 0) return 'No notes were captured for this meeting.';
  return notes.join(' ');
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function elapsed(meta: MeetingMeta): string {
  const ms = Math.max(0, Date.now() - Date.parse(meta.startedAt));
  const total = Math.floor(ms / 1000);
  return `${Math.floor(total / 60)}m ${String(total % 60).padStart(2, '0')}s`;
}

function countKinds(records: readonly { kind: string }[]): Record<string, number> {
  const counts: Record<string, number> = { note: 0, suggestion: 0, action: 0 };
  for (const record of records) counts[record.kind] = (counts[record.kind] ?? 0) + 1;
  return counts;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exit(1);
});
