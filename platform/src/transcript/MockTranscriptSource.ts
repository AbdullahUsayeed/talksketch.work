import type { Logger } from '../logger.js';
import type { TranscriptSegment } from '../types.js';
import type {
  EndReason,
  TranscriptSource,
  TranscriptSourceHandlers,
} from './TranscriptSource.js';

export interface MockScriptItem {
  atMs: number;
  speaker: string;
  text: string;
  /** Set false to simulate a live draft that is confirmed later. */
  completed?: boolean;
}

export interface MockTranscriptSourceOptions {
  script?: MockScriptItem[];
  speed?: number;
  logger?: Logger;
  /** Emit everything synchronously (tests). */
  immediate?: boolean;
}

export const DEFAULT_MOCK_SCRIPT: MockScriptItem[] = [
  { atMs: 1000, speaker: 'Maya', text: "Let's start. Goal for today is to decide the Q3 launch scope and who owns the migration." },
  { atMs: 7000, speaker: 'Jon', text: 'We have three candidates: SSO, the audit log, and the bulk importer.' },
  { atMs: 12000, speaker: 'Maya', text: 'SSO is the one enterprise deals keep asking for. The audit log is a security checkbox.' },
  { atMs: 18000, speaker: 'Priya', text: "I'd push the bulk importer to Q4. It's a nice onboarding win but nobody is blocked on it." },
  { atMs: 23000, speaker: 'Jon', text: 'Agreed. Bulk importer is out.', completed: false },
  { atMs: 26000, speaker: 'Jon', text: 'Agreed. Bulk importer is out.' },
  { atMs: 32000, speaker: 'Maya', text: 'So SSO and audit log ship in Q3. Decision: drop the importer for now.' },
  { atMs: 38000, speaker: 'Priya', text: 'SSO needs the Okta integration tested against a sandbox tenant. That is usually a week.' },
  { atMs: 44000, speaker: 'Jon', text: "I'll take the Okta sandbox setup and have it ready by Friday." },
  { atMs: 50000, speaker: 'Maya', text: 'Priya, can you own the audit log spec and get legal to sign off on retention?' },
  { atMs: 56000, speaker: 'Priya', text: "Yes. I'll send the spec to legal on Monday and target sign-off in two weeks." },
  { atMs: 62000, speaker: 'Jon', text: 'One risk: the audit log retention storage cost grows fast if we keep seven years of events.' },
  { atMs: 68000, speaker: 'Maya', text: "Good point. Let's cap default retention at two years and make it configurable for enterprise." },
  { atMs: 74000, speaker: 'Priya', text: 'That matches what the security questionnaire asked for, they wanted a configurable retention window.' },
  { atMs: 80000, speaker: 'Maya', text: 'Decision: default retention two years, configurable per tenant.' },
  { atMs: 86000, speaker: 'Jon', text: "Then I'm not blocked. I'll start on the Okta sandbox this afternoon." },
  { atMs: 92000, speaker: 'Maya', text: 'Great. Next step is a scope doc by Wednesday, and we review it in the Thursday sync.' },
];

export class MockTranscriptSource implements TranscriptSource {
  readonly name = 'mock';

  private readonly script: MockScriptItem[];
  private readonly speed: number;
  private readonly logger?: Logger;
  private readonly immediate: boolean;
  private timers: NodeJS.Timeout[] = [];
  private handlers?: TranscriptSourceHandlers;
  private stopped = false;

  constructor(options: MockTranscriptSourceOptions = {}) {
    this.script = options.script ?? DEFAULT_MOCK_SCRIPT;
    this.speed = Math.max(0.1, options.speed ?? 1);
    this.logger = options.logger;
    this.immediate = options.immediate ?? false;
  }

  async start(handlers: TranscriptSourceHandlers): Promise<void> {
    this.handlers = handlers;
    this.stopped = false;

    if (this.immediate) {
      for (const item of this.script) handlers.onSegment(toSegment(item));
      handlers.onEnd?.('source-finished');
      return;
    }

    for (const item of this.script) {
      const timer = setTimeout(() => {
        if (this.stopped) return;
        handlers.onSegment(toSegment(item));
      }, item.atMs / this.speed);
      timer.unref?.();
      this.timers.push(timer);
    }

    const last = this.script[this.script.length - 1];
    if (last) {
      const endTimer = setTimeout(() => {
        if (this.stopped) return;
        this.logger?.info('mock transcript finished');
        handlers.onEnd?.('source-finished');
      }, last.atMs / this.speed + 2000);
      endTimer.unref?.();
      this.timers.push(endTimer);
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers = [];
  }
}

function toSegment(item: MockScriptItem): TranscriptSegment {
  return {
    id: `${item.speaker}-${item.atMs}`,
    speaker: item.speaker,
    text: item.text,
    start: item.atMs / 1000,
    end: item.atMs / 1000 + 4,
    completed: item.completed !== false,
  };
}

export type { EndReason };
