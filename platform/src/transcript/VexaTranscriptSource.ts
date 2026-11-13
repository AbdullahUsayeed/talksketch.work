import type { Logger } from '../logger.js';
import type { Platform, TranscriptSegment } from '../types.js';
import type {
  EndReason,
  TranscriptSource,
  TranscriptSourceHandlers,
} from './TranscriptSource.js';

export interface VexaTranscriptSourceOptions {
  baseUrl: string;
  apiKey?: string;
  platform: Platform;
  nativeMeetingId: string;
  pollIntervalMs?: number;
  endAfterSilenceMs?: number;
  fetchImpl?: typeof fetch;
  logger: Logger;
  now?: () => number;
}

type Json = Record<string, unknown>;

/**
 * Polls Vexa's documented transcript endpoint.
 *
 * Vexa 0.12 does not expose WebSocket transcript streaming in the open-core
 * stack (it returns 404), so polling `GET /transcripts/{platform}/{id}` is the
 * supported integration. Draft segments (completed: false) are ignored by the
 * rolling context until they are confirmed.
 */
export class VexaTranscriptSource implements TranscriptSource {
  readonly name = 'vexa';

  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly platform: Platform;
  private readonly nativeMeetingId: string;
  private readonly pollIntervalMs: number;
  private readonly endAfterSilenceMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly logger: Logger;
  private readonly now: () => number;

  private handlers?: TranscriptSourceHandlers;
  private timer?: NodeJS.Timeout;
  private running = false;
  private ended = false;
  private lastNewSegmentAt = 0;
  private sawSegment = false;
  private readonly emitted = new Map<string, string>();

  constructor(options: VexaTranscriptSourceOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.apiKey = options.apiKey;
    this.platform = options.platform;
    this.nativeMeetingId = options.nativeMeetingId;
    this.pollIntervalMs = options.pollIntervalMs ?? 2000;
    this.endAfterSilenceMs = options.endAfterSilenceMs ?? 180_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.logger = options.logger;
    this.now = options.now ?? Date.now;
  }

  async start(handlers: TranscriptSourceHandlers): Promise<void> {
    if (this.running) return;
    this.handlers = handlers;
    this.running = true;
    this.lastNewSegmentAt = this.now();
    void this.tick();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private schedule(delayMs: number): void {
    if (!this.running) return;
    this.timer = setTimeout(() => void this.tick(), delayMs);
    this.timer.unref?.();
  }

  private async tick(): Promise<void> {
    if (!this.running) return;
    try {
      const payload = await this.fetchTranscript();
      this.consume(payload);
    } catch (error) {
      this.logger.warn('transcript poll failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      if (this.running) this.schedule(this.pollIntervalMs);
    }
  }

  private async fetchTranscript(): Promise<Json> {
    const url = `${this.baseUrl}/transcripts/${this.platform}/${encodeURIComponent(this.nativeMeetingId)}`;
    const response = await this.fetchImpl(url, {
      headers: {
        accept: 'application/json',
        ...(this.apiKey ? { 'X-API-Key': this.apiKey } : {}),
      },
    });
    if (!response.ok) {
      throw new Error(`Vexa responded ${response.status} ${response.statusText}`);
    }
    const body: unknown = await response.json();
    return isRecord(body) ? body : {};
  }

  private consume(payload: Json): void {
    const rawSegments = extractSegments(payload);
    let fresh = 0;

    for (const raw of rawSegments) {
      const segment = normalizeSegment(raw);
      if (!segment) continue;

      const signature = `${segment.text}|${segment.completed}`;
      if (this.emitted.get(segment.id) === signature) continue;
      this.emitted.set(segment.id, signature);

      if (segment.completed) {
        fresh += 1;
        this.sawSegment = true;
      }
      this.handlers?.onSegment(segment);
    }

    if (fresh > 0) this.lastNewSegmentAt = this.now();

    const status = typeof payload.status === 'string' ? payload.status.toLowerCase() : '';
    if (this.sawSegment && isFinalStatus(status)) {
      this.finish('meeting-ended');
      return;
    }
    if (this.sawSegment && this.now() - this.lastNewSegmentAt >= this.endAfterSilenceMs) {
      this.finish('silence');
    }
  }

  private finish(reason: EndReason): void {
    if (this.ended) return;
    this.ended = true;
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.logger.info('transcript source ended', { reason });
    this.handlers?.onEnd?.(reason);
  }
}

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function extractSegments(payload: Json): Json[] {
  const candidates: unknown[] = [
    payload.segments,
    isRecord(payload.data) ? payload.data.segments : undefined,
    isRecord(payload.transcript) ? payload.transcript.segments : undefined,
  ];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return candidate.filter(isRecord);
  }
  return [];
}

function pickString(source: Json, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

function pickNumber(source: Json, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return undefined;
}

export function normalizeSegment(raw: Json): TranscriptSegment | null {
  const text = pickString(raw, ['text', 'content', 'transcript'])?.trim();
  if (!text) return null;

  const speaker = pickString(raw, ['speaker', 'speaker_name', 'speakerName', 'name']) ?? 'Unknown speaker';
  const start = pickNumber(raw, ['start', 'start_time', 'startTime', 'start_seconds']) ?? 0;
  const end = pickNumber(raw, ['end', 'end_time', 'endTime', 'end_seconds']) ?? start;
  const id =
    pickString(raw, ['segment_id', 'segmentId', 'id']) ?? `${speaker}:${start.toFixed(2)}`;
  const completed = raw.completed !== false;
  const confidence = pickNumber(raw, ['confidence', 'probability']);

  return {
    id,
    speaker,
    text,
    start,
    end,
    completed,
    ...(pickString(raw, ['language']) ? { language: pickString(raw, ['language']) as string } : {}),
    ...(confidence !== undefined ? { confidence } : {}),
  };
}

function isFinalStatus(status: string): boolean {
  return ['completed', 'ended', 'finished', 'stopped', 'done'].includes(status);
}
