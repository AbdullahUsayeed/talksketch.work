import { z } from 'zod';
import type { Config } from './config.js';

const Segments = z.array(z.number().int().nonnegative()).default([]);

const NotesSchema = z.object({
  title: z.string().default(''),
  summary: z.string().default(''),
  topics: z
    .array(
      z.object({
        heading: z.string().min(1),
        points: z.array(z.object({ text: z.string().min(1), segments: Segments })).default([]),
      }),
    )
    .default([]),
  decisions: z.array(z.object({ text: z.string().min(1), segments: Segments })).default([]),
  action_items: z
    .array(
      z.object({
        task: z.string().min(1),
        owner: z.string().nullish(),
        deadline: z.string().nullish(),
        segments: Segments,
      }),
    )
    .default([]),
  open_questions: z.array(z.object({ text: z.string().min(1), segments: Segments })).default([]),
  uncertain: z.array(z.object({ text: z.string().min(1), segments: Segments })).default([]),
  board: z
    .array(
      z.object({
        text: z.string().min(1).max(160),
        kind: z.enum(['agenda', 'point', 'decision', 'risk', 'action']).default('point'),
      }),
    )
    .default([]),
});

export type SessionNotes = z.infer<typeof NotesSchema>;
export type AnalyzeWindowResult = SessionNotes;

export interface TranscriptSegment {
  seq: number;
  speaker: string;
  text: string;
}

export interface AnalyzeWindowInput {
  segments: TranscriptSegment[];
  currentNotes?: unknown;
  mode?: 'incremental' | 'final' | 'window';
  topic?: string;
  participants?: string[];
}

export interface Coverage {
  from: number;
  to: number;
  total: number;
  windows: number;
  dropped: boolean;
}

export interface SessionResult {
  notes: SessionNotes;
  coverage: Coverage;
}

/*
 * DeepSeek V4.1 Flash has a 1,048,576-token context. The real limits are:
 * - the 200k-token long-context price tier (input/output roughly doubles)
 * - latency and the risk of one huge call failing
 * So a single final pass gets 180k characters (~180k Bangla tokens), which
 * covers about three hours; beyond that we window and merge.
 */
const INCREMENTAL_SEGMENTS = 160;
const INCREMENTAL_CHARS = 20_000;
const SINGLE_SEGMENTS = 2500;
const SINGLE_CHARS = 180_000;
const WINDOW_SEGMENTS = 250;

const SYSTEM_PROMPT = `You are a note-taking assistant for live meetings and lectures. You receive an auto-generated speech-to-text transcript, possibly in any language or a mix of languages. Your job is to maintain clear, accurate, structured notes.

ABOUT THE INPUT
- The transcript comes from automatic speech recognition. It can contain misheard words, missing punctuation, wrong names, and broken sentences at chunk boundaries.
- Segments are numbered. A line like [MISSING CHUNK 7] means audio was lost there. Never guess what was said in a gap.
- A sentence may be split across two segments. Join them when it is obvious.

RULES
1. Only write what the transcript supports. Do not add facts, names, numbers, or context from your own knowledge.
2. Preserve numbers, dates, times, deadlines, amounts, names, and technical terms exactly as transcribed. Do not "correct" a name or number by guessing.
3. If something is unclear or looks like a transcription error, put it in "uncertain" with the segment number. Do not smooth it over.
4. Do not mention small talk, filler, repetition, or false starts.
5. Be concise. Use short phrases, not full paragraphs. Each point should be understandable on its own.
6. Attribute decisions and action items to a person only if the speaker clearly said who. Otherwise leave the owner null.
7. Do not treat suggestions, ideas, or maybes as decisions. A decision needs clear agreement or a clear statement.
8. Write the notes in the language most of the transcript uses. Do not translate. Keep names and technical terms in their original form.
9. "board" holds up to 4 very short labels (under 12 words) for new decisions, risks, actions or key points. Return an empty array on the final pass.

YOU ARE UPDATING EXISTING NOTES
- You get the current notes (JSON) and the new transcript segments.
- Return the complete updated notes, not just the changes.
- Keep everything still valid. Add new points, merge duplicates, and refine wording.
- Remove or edit an earlier point only if the new transcript clearly contradicts or corrects it.
- Put new content under an existing topic if it continues that topic. Create a new topic only for a real topic change.

OUTPUT
Return ONLY valid JSON. No markdown fences, no commentary.

{
  "title": "short title of the session",
  "summary": "2-3 sentences on what the session is about so far",
  "topics": [
    { "heading": "topic name", "points": [ { "text": "key point", "segments": [3, 4] } ] }
  ],
  "decisions": [ { "text": "what was decided", "segments": [9] } ],
  "action_items": [ { "task": "what needs doing", "owner": null, "deadline": null, "segments": [10] } ],
  "open_questions": [ { "text": "unresolved question", "segments": [12] } ],
  "uncertain": [ { "text": "what looks wrong or unclear and why", "segments": [5] } ],
  "board": [ { "text": "short label", "kind": "point" } ]
}

If a section has nothing, return an empty array. Never invent content to fill it.`;

function formatSegments(segments: TranscriptSegment[]): string {
  return segments
    .map((segment) => `[${segment.seq}] ${segment.speaker}: ${segment.text}`)
    .join('\n');
}

/** Keep the most recent segments that fit both limits. */
function trimToFit(segments: TranscriptSegment[], maxSegments: number, maxChars: number) {
  const kept: TranscriptSegment[] = [];
  let chars = 0;
  for (let i = segments.length - 1; i >= 0; i -= 1) {
    const segment = segments[i];
    if (!segment) continue;
    const line = `[${segment.seq}] ${segment.speaker}: ${segment.text}`;
    if (kept.length >= maxSegments || chars + line.length > maxChars) break;
    kept.unshift(segment);
    chars += line.length + 1;
  }
  return { segments: kept, chars };
}

async function callModel(config: Config, messages: Array<{ role: string; content: string }>): Promise<string> {
  const response = await fetch(`${config.llm.baseUrl?.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${config.llm.apiKey}`,
      'content-type': 'application/json',
    },
    signal: AbortSignal.timeout(240_000),
    body: JSON.stringify({
      model: config.llm.model,
      temperature: 0.25,
      response_format: { type: 'json_object' },
      messages,
    }),
  });
  if (!response.ok) throw new Error(`Model responded ${response.status}`);
  const data = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
  return data.choices?.[0]?.message?.content ?? '{}';
}

function readJson(raw: string): unknown {
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');
  return JSON.parse(cleaned);
}

async function callAndParse(
  config: Config,
  messages: Array<{ role: string; content: string }>,
): Promise<SessionNotes> {
  const first = await callModel(config, messages);
  try {
    const parsed = NotesSchema.safeParse(readJson(first));
    if (parsed.success) return parsed.data;
  } catch {
    /* retry below */
  }

  const second = await callModel(config, [
    ...messages,
    { role: 'assistant', content: first.slice(0, 20_000) },
    {
      role: 'user',
      content:
        'That response was not valid JSON for the required shape. Return only the corrected JSON object, with every required field present.',
    },
  ]);

  const parsed = NotesSchema.safeParse(readJson(second));
  if (!parsed.success) throw new Error('Model returned an unexpected shape.');
  return parsed.data;
}

async function runNotes(input: AnalyzeWindowInput, config: Config): Promise<SessionNotes> {
  const final = input.mode === 'final';
  const windowMode = input.mode === 'window';
  if (input.segments.length === 0) throw new Error('Transcript window is empty.');

  const transcript = formatSegments(input.segments);
  const context = [
    input.topic ? `Session topic: ${input.topic}` : '',
    input.participants?.length ? `Participants: ${input.participants.join(', ')}` : '',
  ]
    .filter(Boolean)
    .join('\n');

  const user = windowMode
    ? [
        context,
        `WINDOW TRANSCRIPT (segments ${input.segments[0]?.seq}-${input.segments[input.segments.length - 1]?.seq}):`,
        transcript,
        '',
        'This is one window of a longer session. Produce notes for this window only. Do not assume what happened outside it. Return the full JSON, with board as [].',
      ]
        .filter(Boolean)
        .join('\n')
    : final
    ? [
        context,
        'FULL TRANSCRIPT:',
        transcript,
        '',
        'This is the complete session. Produce clean, final notes from scratch. Merge repeated topics, order them logically, and double-check that every decision and action item is actually supported by the transcript. Return the full JSON.',
      ]
        .filter(Boolean)
        .join('\n')
    : [
        context,
        'CURRENT NOTES:',
        JSON.stringify(input.currentNotes ?? {}),
        '',
        `NEW TRANSCRIPT (segments ${input.segments[0]?.seq}-${input.segments[input.segments.length - 1]?.seq}):`,
        transcript,
        '',
        'Update the notes with the new transcript. Return the full JSON.',
      ]
        .filter(Boolean)
        .join('\n');

  return callAndParse(config, [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: user },
  ]);
}

async function mergeWindowNotes(
  windows: Array<{ from: number; to: number; notes: SessionNotes }>,
  config: Config,
): Promise<SessionNotes> {
  const user = [
    'You are given notes JSON from consecutive windows of ONE session, in time order.',
    'Merge them into a single set of final notes.',
    '',
    'RULES',
    '- Use only what appears in the window notes. Add nothing new.',
    '- Merge topics that continue across windows; keep the segment refs from all merged points.',
    '- Remove duplicate points, decisions, and action items. Keep the earliest and latest refs.',
    '- If a later window changes or reverses an earlier decision, keep the later version and mention the change.',
    '- Keep every item from "uncertain" and every missing-chunk flag. Do not resolve them.',
    '- Order topics in the order they were discussed.',
    '- Preserve numbers, names, dates, and deadlines exactly.',
    '- Return ONLY the full notes JSON in the same structure. Board stays empty.',
    '',
    'WINDOW NOTES:',
    ...windows.map(
      (window, index) =>
        `[Window ${index + 1}: segments ${window.from}-${window.to}]\n${JSON.stringify(window.notes)}`,
    ),
  ].join('\n');

  const merged = await callAndParse(config, [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: user },
  ]);
  return { ...merged, board: [] };
}

/**
 * Final notes for a whole session.
 * Up to 700 segments / 80k characters in one pass; longer sessions are
 * processed in 250-segment windows and merged, so nothing is silently dropped.
 */
export async function analyzeSession(input: AnalyzeWindowInput, config: Config): Promise<SessionResult> {
  const total = input.segments.length;
  const first = input.segments[0]?.seq ?? 0;
  const last = input.segments[input.segments.length - 1]?.seq ?? 0;

  if (input.mode !== 'final') {
    const trimmed = trimToFit(input.segments, INCREMENTAL_SEGMENTS, INCREMENTAL_CHARS);
    const notes = await runNotes({ ...input, segments: trimmed.segments }, config);
    return {
      notes,
      coverage: { from: first, to: last, total, windows: 1, dropped: false },
    };
  }

  const fullLength = formatSegments(input.segments).length;
  if (total <= SINGLE_SEGMENTS && fullLength <= SINGLE_CHARS) {
    const notes = await runNotes({ ...input, mode: 'final' }, config);
    return {
      notes,
      coverage: { from: first, to: last, total, windows: 1, dropped: false },
    };
  }

  const windows: Array<{ from: number; to: number; notes: SessionNotes }> = [];
  for (let index = 0; index < total; index += WINDOW_SEGMENTS) {
    const slice = input.segments.slice(index, index + WINDOW_SEGMENTS);
    if (slice.length === 0) continue;
    let notes: SessionNotes;
    try {
      const windowNotes = await runNotes({ ...input, segments: slice, mode: 'window' }, config);
      notes = { ...windowNotes, board: [] };
    } catch {
      notes = {
        title: '',
        summary: '',
        topics: [],
        decisions: [],
        action_items: [],
        open_questions: [],
        uncertain: [
          {
            text: `Window ${windows.length + 1} could not be processed`,
            segments: [slice[0]!.seq, slice[slice.length - 1]!.seq],
          },
        ],
        board: [],
      };
    }
    windows.push({ from: slice[0]!.seq, to: slice[slice.length - 1]!.seq, notes });
  }

  const merged = await mergeWindowNotes(windows, config);
  return {
    notes: merged,
    coverage: { from: first, to: last, total, windows: windows.length, dropped: false },
  };
}

/** Single-window entry point, kept for incremental calls and tests. */
export async function analyzeWindow(input: AnalyzeWindowInput, config: Config): Promise<AnalyzeWindowResult> {
  const trimmed = trimToFit(input.segments, INCREMENTAL_SEGMENTS, INCREMENTAL_CHARS);
  if (trimmed.segments.length === 0) throw new Error('Transcript window is empty.');
  return runNotes({ ...input, segments: trimmed.segments }, config);
}
