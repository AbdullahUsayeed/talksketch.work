import { z } from 'zod';
import type { Config } from './config.js';

const ResultSchema = z.object({
  summary: z.string().default(''),
  notes: z.array(z.object({ content: z.string().min(1) })).default([]),
  actions: z
    .array(
      z.object({
        task: z.string().min(1),
        assignee: z.string().nullish(),
        deadline: z.string().nullish(),
      }),
    )
    .default([]),
  suggestions: z
    .array(
      z.object({
        topic: z.string().min(1),
        rationale: z.string().min(1),
        suggestion: z.string().min(1),
      }),
    )
    .default([]),
  board: z
    .array(
      z.object({
        text: z.string().min(1).max(160),
        kind: z.enum(['agenda', 'point', 'decision', 'risk', 'action']).default('point'),
      }),
    )
    .default([]),
});

export type AnalyzeWindowResult = z.infer<typeof ResultSchema>;

export interface AnalyzeWindowInput {
  transcript: string;
  topic?: string;
  participants?: string[];
  existingNotes?: string[];
}

/**
 * Stateless: transcript window in, notes/actions/suggestions/board ops out.
 * No meetings, no sessions, no canvas on the server.
 */
export async function analyzeWindow(input: AnalyzeWindowInput, config: Config): Promise<AnalyzeWindowResult> {
  const transcript = input.transcript.trim().slice(-30_000);
  if (transcript.length < 40) throw new Error('Transcript window is too small.');

  const response = await fetch(`${config.llm.baseUrl?.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${config.llm.apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: config.llm.model,
      temperature: 0.2,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: [
            'You are TalkSketch, an AI meeting partner. Read a window of a live meeting transcript and return JSON only.',
            '',
            'Shape:',
            '{"summary":string,"notes":[{"content":string}],"actions":[{"task":string,"assignee":string|null,"deadline":string|null}],"suggestions":[{"topic":string,"rationale":string,"suggestion":string}],"board":[{"text":string,"kind":"agenda"|"point"|"decision"|"risk"|"action"}]}',
            '',
            'Rules:',
            '- At most 3 notes per call. Capture decisions, numbers, commitments, risks, definitions. No small talk, no restating the agenda.',
            '- At most 2 actions. Only explicit commitments with an owner when named.',
            '- At most 1 suggestion, and only if it adds a risk, tradeoff, missing stakeholder or alternative. Otherwise an empty array.',
            '- At most 4 board items, each under 12 words.',
            '- Do not repeat anything in the existing notes.',
            '- summary is 1-2 sentences describing this window; empty if nothing happened.',
            '',
            'Language:',
            '- The transcript may be English, Bangla (Bengali script), Banglish (Bangla in Latin letters), or a mix. Understand it as spoken.',
            '- Write summary, notes, actions, suggestions and board text in the language most of the transcript uses. If the meeting is in Bangla, write in Bangla with proper Bengali script.',
            '- Keep people names, company names, numbers and established English technical terms as they were said. Do not translate proper nouns.',
          ].join('\n'),
        },
        {
          role: 'user',
          content: [
            `Topic: ${input.topic ?? 'not stated'}`,
            `Participants: ${input.participants?.join(', ') || 'not stated'}`,
            `Existing notes:\n${input.existingNotes?.slice(-20).join('\n') || '(none)'}`,
            '',
            'Transcript window:',
            transcript,
          ].join('\n'),
        },
      ],
    }),
  });

  if (!response.ok) {
    throw new Error(`Model responded ${response.status}`);
  }
  const data = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const raw = data.choices?.[0]?.message?.content ?? '{}';
  const parsed = ResultSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) throw new Error('Model returned an unexpected shape.');
  return parsed.data;
}
