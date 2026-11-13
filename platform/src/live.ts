import { join } from 'node:path';
import { createAgentSession, type AgentSession } from './agent.js';
import type { Config } from './config.js';
import type { Logger } from './logger.js';
import { NotesStore, renderSummary } from './notes/NotesStore.js';
import { buildConclusion } from './notes/conclusion.js';
import { summarizeNotes, snapshotBoard } from './oneshot.js';
import { Gatekeeper } from './policy/Gatekeeper.js';
import { TranscriptBuffer } from './transcript/TranscriptBuffer.js';
import type { MeetingMeta, NoteRecord } from './types.js';

export interface LiveLine {
  speaker?: string;
  text: string;
}

export interface LiveState {
  active: boolean;
  id?: string;
  topic?: string;
  elapsedMs: number;
  segments: number;
  notes: NoteRecord[];
  suggestions: NoteRecord[];
  actions: NoteRecord[];
  summary?: string;
}

/**
 * A single live meeting fed by browser captions. Analyses run on a debounce;
 * notes appear while the call is still happening.
 */
export class LiveSession {
  private readonly buffer = new TranscriptBuffer({ maxTokens: 3500 });
  private timer?: NodeJS.Timeout;
  private inFlight = false;
  private rerun = false;
  private ended = false;
  private count = 0;
  private summary = '';
  private lastActivityAt = Date.now();
  private readonly startedAt = Date.now();

  private constructor(
    private readonly meta: MeetingMeta,
    private readonly store: NotesStore,
    private readonly gatekeeper: Gatekeeper,
    private readonly session: AgentSession,
    private readonly config: Config,
    private readonly logger: Logger,
  ) {}

  static async create(
    config: Config,
    logger: Logger,
    topic: string,
    participants: string[],
    id: string,
  ): Promise<LiveSession> {
    const meta: MeetingMeta = {
      id,
      platform: 'google_meet',
      nativeMeetingId: id,
      topic,
      participants,
      startedAt: new Date().toISOString(),
      botName: 'TalkSketch',
    };
    const store = new NotesStore(join(config.dataDir, 'live'), meta);
    await store.init();

    const gatekeeper = new Gatekeeper({
      noteMinIntervalMs: 15_000,
      suggestionMinIntervalMs: 30_000,
      maxSuggestions: 3,
      noteWarmupMs: 0,
      suggestionMinMeetingAgeMs: 0,
      meetingStartAt: Date.now(),
    });

    const session = await createAgentSession({ config, meta, store, gatekeeper, logger });
    return new LiveSession(meta, store, gatekeeper, session, config, logger);
  }

  ingest(lines: LiveLine[]): void {
    if (this.ended) return;
    this.lastActivityAt = Date.now();
    for (const line of lines) {
      const text = line.text.trim();
      if (text.length < 2) continue;
      this.count += 1;
      const ok = this.buffer.add({
        id: `live-${this.count}`,
        speaker: line.speaker?.trim() || 'Participant',
        text,
        start: (Date.now() - this.startedAt) / 1000,
        end: (Date.now() - this.startedAt) / 1000 + 2,
        completed: true,
      });
      if (!ok) continue;
    }
    this.schedule();
  }

  idleMs(): number {
    return Date.now() - this.lastActivityAt;
  }

  state(): LiveState {
    const records = this.store.all();
    return {
      active: !this.ended,
      id: this.meta.id,
      topic: this.meta.topic,
      elapsedMs: Date.now() - this.startedAt,
      segments: this.count,
      notes: records.filter((record) => record.kind === 'note'),
      suggestions: records.filter((record) => record.kind === 'suggestion'),
      actions: records.filter((record) => record.kind === 'action'),
      ...(this.summary ? { summary: this.summary } : {}),
    };
  }

  private schedule(): void {
    if (this.ended || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.analyze();
    }, 8000);
    this.timer.unref?.();
  }

  private async analyze(): Promise<void> {
    if (this.ended) return;
    if (this.inFlight) {
      this.rerun = true;
      return;
    }
    if (!this.buffer.hasPending()) return;

    this.inFlight = true;
    this.buffer.consumePending();
    try {
      await this.session.run(
        [
          'Live meeting transcript window:',
          this.buffer.render(),
          '',
          'Record what matters with the tools. Skip small talk. Reply "-" if nothing qualifies.',
        ].join('\n'),
        { maxTurns: 6 },
      );
    } catch (error) {
      this.logger.warn('live analysis failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.inFlight = false;
      if (this.rerun && !this.ended) {
        this.rerun = false;
        void this.analyze();
      }
    }
  }

  /** Render the current board to a PNG for the panel. */
  async snapshotBoard(): Promise<string | undefined> {
    if (this.ended) return undefined;
    return snapshotBoard(this.store.path(), this.config.excalidraw.canvasUrl, this.logger);
  }

  async end(): Promise<LiveState> {    if (this.ended) return this.state();
    this.ended = true;
    if (this.timer) clearTimeout(this.timer);
    for (let i = 0; i < 300 && this.inFlight; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    const records = this.store.all();
    this.summary =
      (await summarizeNotes(records, this.config, this.logger)) ||
      records
        .filter((record) => record.kind === 'note')
        .slice(-4)
        .map((record) => record.content)
        .join(' ');

    await this.session.addConclusion(buildConclusion(records));
    await this.store.saveSummary(renderSummary(this.meta, records, this.summary));
    await this.session.close();
    this.logger.info('live meeting ended', { id: this.meta.id, segments: this.count });
    return this.state();
  }
}
