import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { createAgentSession } from './agent.js';
import type { Config } from './config.js';
import type { Logger } from './logger.js';
import { NotesStore, renderSummary } from './notes/NotesStore.js';
import { buildConclusion } from './notes/conclusion.js';
import { Gatekeeper } from './policy/Gatekeeper.js';
import { TranscriptBuffer } from './transcript/TranscriptBuffer.js';
import type { MeetingMeta, NoteRecord, TranscriptSegment } from './types.js';

const run = promisify(execFile);

export interface AnalyzeInput {
  transcript: string;
  topic?: string;
  participants?: string[];
}

export interface AnalyzeResult {
  id: string;
  summary: string;
  notes: NoteRecord[];
  suggestions: NoteRecord[];
  actions: NoteRecord[];
  boardUrl?: string;
  elapsedMs: number;
}

/**
 * One-shot analysis for the public demo: a complete transcript in, the same
 * artifacts the live meeting produces out. No live source, no scheduler.
 */
export async function analyzeTranscript(
  input: AnalyzeInput,
  config: Config,
  logger: Logger,
): Promise<AnalyzeResult> {
  const startedAt = Date.now();
  const id = `demo-${randomUUID().slice(0, 8)}`;
  const meta: MeetingMeta = {
    id,
    platform: 'google_meet',
    nativeMeetingId: id,
    topic: input.topic?.trim() || 'Demo meeting',
    participants: input.participants ?? [],
    startedAt: new Date().toISOString(),
    botName: 'TalkSketch',
  };

  const segments = parseTranscript(input.transcript);
  if (segments.length === 0) throw new Error('The transcript is empty.');

  const store = new NotesStore(config.dataDir, meta);
  await store.init();

  const gatekeeper = new Gatekeeper({
    noteMinIntervalMs: 0,
    suggestionMinIntervalMs: 0,
    maxSuggestions: 3,
    noteWarmupMs: 0,
    suggestionMinMeetingAgeMs: 0,
    meetingStartAt: Date.now(),
  });

  const session = await createAgentSession({ config, meta, store, gatekeeper, logger });
  const buffer = new TranscriptBuffer({ maxTokens: 6000 });
  for (const segment of segments) buffer.add(segment);

  try {
    await session.run(
      [
        `This is the complete transcript of a finished meeting: "${meta.topic}".`,
        'It is not live. Capture the whole meeting now.',
        '',
        'Use the tools to:',
        '- record_note for every decision (prefix it with "Decision:"), important number and risk.',
        '- record_action_item for every explicit commitment, with owner and deadline.',
        '- record_suggestion only if it adds a real risk, tradeoff or missing stakeholder.',
        '- draw the agenda, key points, decisions, risks and conclusion on the board.',
        'Do not record small talk or the meeting goal.',
        '',
        'When the record is complete, reply with "done".',
        '',
        'Transcript:',
        buffer.render(),
      ].join('\n'),
      { maxTurns: 16 },
    );
  } catch (error) {
    logger.warn('demo analysis stopped early', {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  const records = store.all();
  await session.addConclusion(buildConclusion(records));
  await session.close();

  const summary =
    (await summarizeNotes(records, config, logger)) ||
    records
      .filter((record) => record.kind === 'note')
      .slice(-4)
      .map((record) => record.content)
      .join(' ');
  await store.saveSummary(renderSummary(meta, records, summary));

  const boardUrl = await snapshotBoard(store.path(), config.excalidraw.canvasUrl, logger);

  return {
    id,
    summary: summary.trim() || 'No summary could be generated.',
    notes: records.filter((record) => record.kind === 'note'),
    suggestions: records.filter((record) => record.kind === 'suggestion'),
    actions: records.filter((record) => record.kind === 'action'),
    ...(boardUrl ? { boardUrl } : {}),
    elapsedMs: Date.now() - startedAt,
  };
}

export function parseTranscript(text: string): TranscriptSegment[] {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 400);

  return lines.map((line, index) => {
    const match = line.match(/^([\p{L}][\p{L}\p{N} .'’-]{0,40}):\s*(.+)$/u);
    const speaker = match?.[1]?.trim() ?? 'Speaker';
    const body = match?.[2]?.trim() ?? line;
    return {
      id: `s${index}`,
      speaker,
      text: body,
      start: index * 6,
      end: index * 6 + 5,
      completed: true,
    };
  });
}

export async function summarizeNotes(
  records: readonly NoteRecord[],
  config: Config,
  logger: Logger,
): Promise<string> {
  const notes = records
    .map((record) => {
      const owner = record.assignee ? ` [${record.assignee}]` : '';
      const due = record.deadline ? ` (${record.deadline})` : '';
      return `- ${record.kind}${owner}: ${record.content}${due}`;
    })
    .join('\n');
  if (!notes) return '';

  try {
    const response = await fetch(`${config.llm.baseUrl?.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${config.llm.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: config.llm.model,
        temperature: 0.2,
        messages: [
          {
            role: 'system',
            content:
              'You write the permanent record of a meeting. Return 3-5 sentences of plain text, no markdown. Cover the decisions, owners and dates, and any open risk. Do not invent anything.',
          },
          { role: 'user', content: notes },
        ],
      }),
    });
    if (!response.ok) throw new Error(`model responded ${response.status}`);
    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    return (data.choices?.[0]?.message?.content ?? '').trim();
  } catch (error) {
    logger.warn('summary call failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return '';
  }
}

export async function snapshotBoard(
  dir: string,
  canvasUrl: string,
  logger: Logger,
): Promise<string | undefined> {
  try {
    const require = createRequire(import.meta.url);
    const pkg = require.resolve('mcp-excalidraw-server/package.json');
    const bin = join(dirname(pkg), 'dist', 'bin.js');
    const out = join(dir, 'board.png');
    await run(process.execPath, [bin, 'screenshot', '--format', 'png', '--out', out], {
      env: { ...process.env, EXPRESS_SERVER_URL: canvasUrl },
      timeout: 90_000,
    });
    return out;
  } catch (error) {
    logger.warn('demo board snapshot failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}
