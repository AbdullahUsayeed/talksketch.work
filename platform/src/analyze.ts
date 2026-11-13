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
  mode?: 'incremental' | 'final';
  topic?: string;
  participants?: string[];
}

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

async function callModel(config: Config, messages: Array<{ role: string; content: string }>): Promise<string> {
  const response = await fetch(`${config.llm.baseUrl?.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${config.llm.apiKey}`,
      'content-type': 'application/json',
    },
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

/**
 * Stateless: transcript segments in, structured notes out.
 * Incremental calls receive the current notes and the new segments.
 */
export async function analyzeWindow(input: AnalyzeWindowInput, config: Config): Promise<AnalyzeWindowResult> {
  const final = input.mode === 'final';
  const segments = input.segments.slice(-400);
  if (segments.length === 0) throw new Error('Transcript window is empty.');

  const transcript = formatSegments(segments).slice(-45_000);
  const context = [
    input.topic ? `Session topic: ${input.topic}` : '',
    input.participants?.length ? `Participants: ${input.participants.join(', ')}` : '',
  ]
    .filter(Boolean)
    .join('\n');

  const user = final
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
        `NEW TRANSCRIPT (segments ${segments[0]?.seq}-${segments[segments.length - 1]?.seq}):`,
        transcript,
        '',
        'Update the notes with the new transcript. Return the full JSON.',
      ]
        .filter(Boolean)
        .join('\n');

  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: user },
  ];

  const first = await callModel(config, messages);
  try {
    const parsed = NotesSchema.safeParse(readJson(first));
    if (parsed.success) return parsed.data;
  } catch {
    /* retry once below */
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
