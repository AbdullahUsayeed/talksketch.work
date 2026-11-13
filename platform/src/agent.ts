import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { Agent, MCPServerStdio, OpenAIChatCompletionsModel, run, setTracingDisabled, tool } from '@openai/agents';
import OpenAI from 'openai';
import { z } from 'zod';
import type { Config } from './config.js';
import type { Logger } from './logger.js';
import type { NotesStore } from './notes/NotesStore.js';
import type { Gatekeeper } from './policy/Gatekeeper.js';
import type { MeetingMeta, NoteKind, NoteRecord } from './types.js';

export interface AgentSession {
  run(prompt: string, options?: { maxTurns?: number }): Promise<string>;
  /** Deterministic conclusion block, written by code rather than the model. */
  addConclusion(text: string): Promise<void>;
  close(): Promise<void>;
  readonly boardConnected: boolean;
}

export interface AgentDeps {
  config: Config;
  meta: MeetingMeta;
  store: NotesStore;
  gatekeeper: Gatekeeper;
  logger: Logger;
}

/**
 * Builds the meeting agent from reusable parts:
 * - OpenAI Agents SDK: model loop, turn limit, tracing
 * - mcp-excalidraw-server: the shared canvas and its drawing tools
 * - three local tools for the written record
 */
export async function createAgentSession(deps: AgentDeps): Promise<AgentSession> {
  const { config, meta, store, gatekeeper, logger } = deps;

  // The SDK defaults to exporting traces to OpenAI. We use DeepSeek (or another
  // OpenAI-compatible endpoint), so tracing would 401 on every turn and ship
  // data to a provider we are not using.
  setTracingDisabled(true);

  const board = await connectBoard(config, logger);
  const boardConnected = board !== undefined;
  if (board) {
    if (config.excalidraw.resetBoard) {
      try {
        await board.callTool('clear_canvas', {});
        logger.info('board cleared for a new meeting');
      } catch (error) {
        logger.warn('could not clear the board', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    await ensureAgenda(board, meta, logger);
  }

  const write = async (
    kind: NoteKind,
    fields: Omit<NoteRecord, 'id' | 'meetingId' | 'createdAt' | 'kind'>,
  ): Promise<string> => {
    const record: NoteRecord = {
      id: randomUUID(),
      meetingId: meta.id,
      createdAt: new Date().toISOString(),
      kind,
      ...fields,
    };
    await store.add(record);
    logger.info('recorded', { kind, content: record.content.slice(0, 120) });
    return JSON.stringify({ ok: true, id: record.id });
  };

  const recordNote = tool({
    name: 'record_note',
    description:
      'Append one note to the meeting record. Use it for decisions, numbers, commitments, definitions, blockers and risks that a participant would want to read later.',
    parameters: z.object({
      content: z.string().min(1).max(2000).describe('One to three sentences, or a short bullet list.'),
    }),
    execute: async ({ content }) => {
      // A decision is the one thing a meeting cannot afford to lose, so it may
      // bypass the cadence gate. Duplicate detection still applies.
      const isDecision = /\b(decision|decided|approved|agreed|we will|we'll)\b/i.test(content);
      const decision = gatekeeper.canPostNote(Date.now(), content, {
        bypassCooldown: isDecision,
      });
      if (!decision.allowed) return JSON.stringify({ ok: false, reason: decision.reason });
      gatekeeper.markNote(Date.now(), content);
      return write('note', { content });
    },
  });

  const recordSuggestion = tool({
    name: 'record_suggestion',
    description:
      'Record one proactive suggestion, risk or missing consideration the room has not raised. Only when it changes the outcome; never restate what was just said.',
    parameters: z.object({
      topic: z.string().min(1).max(160).describe('Short label, at most 8 words.'),
      rationale: z
        .string()
        .min(1)
        .max(1200)
        .describe('Why now, quoting the transcript line that triggered it.'),
      suggestion: z.string().min(1).max(1200).describe('The concrete suggestion, 1-2 sentences.'),
    }),
    execute: async ({ topic, rationale, suggestion }) => {
      const decision = gatekeeper.canSuggest(Date.now(), topic, suggestion);
      if (!decision.allowed) return JSON.stringify({ ok: false, reason: decision.reason });
      gatekeeper.markSuggestion(Date.now(), topic, suggestion);
      return write('suggestion', { topic, rationale, content: suggestion });
    },
  });

  const recordAction = tool({
    name: 'record_action_item',
    description:
      'Record a concrete task someone explicitly committed to ("I will", "can you own"). Do not invent tasks from vague discussion.',
    parameters: z.object({
      assignee: z.string().max(120).nullable().describe('Owner, or null when not named.'),
      task: z.string().min(1).max(600).describe('Imperative description of the task.'),
      deadline: z.string().max(120).nullable().describe('Deadline as stated, or null.'),
    }),
    execute: async ({ assignee, task, deadline }) => {
      const decision = gatekeeper.canExtractAction(task);
      if (!decision.allowed) return JSON.stringify({ ok: false, reason: decision.reason });
      gatekeeper.markAction(task);
      return write('action', {
        content: task,
        ...(assignee ? { assignee } : {}),
        ...(deadline ? { deadline } : {}),
      });
    },
  });

  const agent = new Agent({
    name: meta.botName,
    instructions: buildInstructions(meta, config, boardConnected),
    model: buildModel(config),
    tools: [recordNote, recordSuggestion, recordAction],
    ...(board ? { mcpServers: [board] } : {}),
  });

  return {
    boardConnected,
    async run(prompt, options) {
      const input = board
        ? await withBoardContext(board, prompt, logger, recordedDigest(store))
        : `${recordedDigest(store)}\n\n${prompt}`;
      const result = await run(agent, input, {
        maxTurns: options?.maxTurns ?? config.llm.maxTurns,
      });
      const output = result.finalOutput;
      if (typeof output === 'string') return output;
      if (output === undefined || output === null) return '';
      return JSON.stringify(output);
    },
    async close() {
      if (board) {
        try {
          await board.close();
        } catch (error) {
          logger.warn('failed to close board MCP server', {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    },
    async addConclusion(text) {
      if (!board) return;
      try {
        const scene = textOf(await board.callTool('describe_scene', {}));
        if (/conclusion/i.test(scene)) return;
        const body = wrapText(text.trim(), 42);
        const lines = body.split('\n').length + 1;
        await board.callTool('create_element', {
          type: 'text',
          x: 40,
          y: 2600,
          width: 520,
          height: 40 + lines * 24,
          text: `Conclusion - ${meta.topic ?? 'meeting'}\n${body}`,
          fontSize: 18,
          strokeColor: '#2f9e44',
        });
      } catch (error) {
        logger.warn('could not write the conclusion element', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  };
}

function buildModel(config: Config): string | OpenAIChatCompletionsModel {
  if (!config.llm.baseUrl) return config.llm.model;
  // Local / OpenAI-compatible endpoints (Ollama, vLLM, LiteLLM) speak Chat
  // Completions, not the Responses API.
  const client = new OpenAI({ apiKey: config.llm.apiKey, baseURL: config.llm.baseUrl });
  return new OpenAIChatCompletionsModel(client, config.llm.model);
}

async function connectBoard(
  config: Config,
  logger: Logger,
): Promise<MCPServerStdio | undefined> {
  try {
    const entry = resolveExcalidrawEntry();
    const server = new MCPServerStdio({
      name: 'excalidraw',
      command: process.execPath,
      args: [entry, '--stdio'],
      env: cleanEnv({ EXPRESS_SERVER_URL: config.excalidraw.canvasUrl }),
      cacheToolsList: true,
    });
    await server.connect();
    logger.info('excalidraw MCP connected', { canvas: config.excalidraw.canvasUrl });
    return server;
  } catch (error) {
    logger.warn('excalidraw MCP unavailable; notes will still be recorded', {
      error: error instanceof Error ? error.message : String(error),
      canvas: config.excalidraw.canvasUrl,
    });
    return undefined;
  }
}

function resolveExcalidrawEntry(): string {
  const require = createRequire(import.meta.url);
  const pkg = require.resolve('mcp-excalidraw-server/package.json');
  return join(dirname(pkg), 'dist', 'index.js');
}

/**
 * The agenda is deterministic, not model-generated: one element, created once,
 * only when the canvas is empty. This removes the duplicate-agenda failure mode
 * without giving the model a chance to re-create it every turn.
 */
async function ensureAgenda(board: MCPServerStdio, meta: MeetingMeta, logger: Logger): Promise<void> {
  if (!meta.topic) return;
  try {
    const scene = await board.callTool('describe_scene', {});
    if (!/Total elements:\s*0\b|canvas is empty/i.test(textOf(scene))) return;
    await board.callTool('create_element', {
      type: 'text',
      x: 40,
      y: 40,
      width: 520,
      height: 60,
      text: `Agenda: ${meta.topic}`,
      fontSize: 24,
      strokeColor: '#1971c2',
    });
    logger.info('agenda created on board');
  } catch (error) {
    logger.warn('could not create the agenda element', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === 'string') return item;
        if (item && typeof item === 'object' && 'text' in item) {
          return String((item as { text: unknown }).text);
        }
        return '';
      })
      .join('\n');
  }
  return JSON.stringify(content ?? '');
}

/**
 * The model gets a compact inventory of the board every turn. It no longer has
 * to remember (or reliably call describe_scene) to avoid drawing duplicates.
 */
async function withBoardContext(
  board: MCPServerStdio,
  prompt: string,
  logger: Logger,
  records: string,
): Promise<string> {
  try {
    const scene = textOf(await board.callTool('describe_scene', {}));
    if (/canvas is empty|Total elements:\s*0\b/i.test(scene)) {
      return `${records}\n\nCurrent board: empty.\n\n${prompt}`;
    }
    const items = scene
      .split('\n')
      .filter((line) => /^\s*\[[^\]]+\]/.test(line))
      .map((line) => `- ${line.trim().slice(0, 160)}`);
    const inventory = items.length > 0 ? items.slice(0, 30).join('\n') : scene.slice(0, 1500);
    return `${records}\n\nCurrent board (${items.length} elements):\n${inventory}\n\n${prompt}`;
  } catch (error) {
    logger.debug('could not read the board for context', {
      error: error instanceof Error ? error.message : String(error),
    });
    return `${records}\n\n${prompt}`;
  }
}

/**
 * Every turn is a fresh model call, so the model has no memory of its own
 * output. The written record is replayed instead of relying on the model to
 * remember, which is what caused duplicate action items.
 */
function recordedDigest(store: NotesStore): string {
  const records = store.all();
  if (records.length === 0) return 'Already recorded: nothing yet.';
  const lines = records.slice(-15).map((record) => {
    const owner = record.assignee ? ` [${record.assignee}]` : '';
    return `- ${record.kind}${owner}: ${record.content.replace(/\s+/g, ' ').slice(0, 180)}`;
  });
  return ['Already recorded (do not repeat any of these):', ...lines].join('\n');
}

function wrapText(text: string, width: number): string {
  return text
    .split('\n')
    .map((source) => {
      const words = source.split(/\s+/).filter(Boolean);
      const lines: string[] = [];
      let line = '';
      for (const word of words) {
        if (line.length + word.length + 1 > width && line.length > 0) {
          lines.push(line);
          line = word;
        } else {
          line = line ? `${line} ${word}` : word;
        }
      }
      if (line) lines.push(line);
      return lines.join('\n');
    })
    .join('\n');
}

function cleanEnv(extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string') env[key] = value;
  }
  return { ...env, ...extra };
}

function buildInstructions(meta: MeetingMeta, config: Config, boardConnected: boolean): string {
  const boardRules = boardConnected
    ? [
        '',
        'The shared Excalidraw canvas is available through these tools:',
        'describe_scene, create_element, batch_create_elements, update_element, set_viewport.',
        '',
        'Board layout (coordinates are pixels, 24px gaps):',
        '- Agenda: x 40-540, y 40-200. It is already there. Never add another agenda.',
        '- Key points: x 620-1120, y 40 downwards',
        '- Decisions: x 1200-1700, y 40 downwards',
        '- Open questions / risks: x 1780-2280, y 40 downwards',
        '- Conclusion: x 40-540, y 2600 downwards',
        '',
        'Call describe_scene before drawing. If an element with the same meaning already',
        'exists in Current board, do not create it again. Add at most two elements per turn,',
        'and at most one decision element. Text elements use type "text" with a "text" field,',
        'width 520 and fontSize 18. Keep every line under 42 characters (about 6 words);',
        'insert a \\n before a line gets longer than that. Never let text overflow its column.',
        'Colors: decision #2f9e44, risk #e03131, action #f08c00.',
      ]
    : ['', 'The whiteboard is unavailable this session. Record everything in notes instead.'];

  return [
    `You are ${meta.botName}, an AI meeting partner observing a live ${meta.platform} call.`,
    'You are not a participant and you never narrate. You act only through tools.',
    '',
    'Meeting',
    `- Topic: ${meta.topic ?? 'not stated'}`,
    `- Participants: ${meta.participants.join(', ') || 'not stated'}`,
    meta.companyContext ? `- Organization context: ${meta.companyContext}` : '',
    '',
    'Written record tools',
    '- record_note: decisions, numbers, commitments, risks, definitions. One per turn at most.',
    '- record_suggestion: a risk or option the room has missed. At most 3 per meeting.',
    '- record_action_item: explicit commitments only.',
    ...boardRules,
    '',
    'Rules',
    '1. Silence is the default. If nothing qualifies, call no tools and reply with "-".',
    '2. The "Already recorded" list and Current board are authoritative. Never repeat a note,',
    '   suggestion or action item that appears there. Never record the meeting goal, the agenda,',
    '   introductions, or small talk. A note needs a decision, a number, a commitment, a risk,',
    '   or a definition that is new.',
    '3. A suggestion must name a risk, tradeoff, missing stakeholder, or alternative the room',
    '   has not mentioned. If it only endorses a direction, it is not a suggestion. Do not send it.',
    '4. Never repeat a note or suggestion that already exists. Rejected calls include a reason.',
    `5. Notes are rate limited to one every ${Math.round(config.policy.noteMinIntervalMs / 1000)}s after`,
    `   the first ${Math.round(config.policy.noteWarmupMs / 1000)}s; start a decision note with`,
    '   "Decision:" so it bypasses the cadence. Suggestions start after',
    `   ${Math.round(config.policy.suggestionMinMeetingAgeMs / 1000)}s and are capped at`,
    `   ${config.policy.maxSuggestions} per meeting.`,
    '6. Do not put the transcript on the board. Put conclusions on the board.',
    '7. Use 2-4 tool calls per turn, maximum 6.',
  ]
    .filter(Boolean)
    .join('\n');
}
