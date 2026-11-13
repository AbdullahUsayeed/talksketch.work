export interface GateDecision {
  allowed: boolean;
  reason?: string;
}

export interface GatekeeperOptions {
  noteMinIntervalMs?: number;
  suggestionMinIntervalMs?: number;
  maxSuggestions?: number;
  /** Jaccard similarity above which two items are considered duplicates. */
  duplicateThreshold?: number;
  /** No notes during the first N ms of a meeting (agenda and intros are noise). */
  noteWarmupMs?: number;
  /** No proactive suggestions before the discussion has substance. */
  suggestionMinMeetingAgeMs?: number;
  /** Epoch ms when the meeting started. */
  meetingStartAt?: number;
}

function normalize(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const SYNONYMS: Record<string, string> = {
  specification: 'spec',
  specifications: 'spec',
  specs: 'spec',
  sending: 'send',
  sent: 'send',
  owns: 'own',
  owned: 'own',
  owning: 'own',
  setup: 'set',
};

function tokensOf(value: string): Set<string> {
  const tokens = normalize(value)
    .split(' ')
    .filter(Boolean)
    .map((token) => SYNONYMS[token] ?? token);
  return new Set(tokens);
}

export function similarity(a: string, b: string): number {
  const left = tokensOf(a);
  const right = tokensOf(b);
  if (left.size === 0 || right.size === 0) return 0;
  let intersection = 0;
  for (const token of left) {
    if (right.has(token)) intersection += 1;
  }
  const union = left.size + right.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * How much of the shorter text is covered by the longer one. Two sentences can
 * describe the same action with different wording and still score low on
 * Jaccard, so dedupe uses both measures.
 */
export function containment(a: string, b: string): number {
  const left = tokensOf(a);
  const right = tokensOf(b);
  if (left.size === 0 || right.size === 0) return 0;
  let intersection = 0;
  for (const token of left) {
    if (right.has(token)) intersection += 1;
  }
  return intersection / Math.min(left.size, right.size);
}

export function nearDuplicate(a: string, b: string, threshold = 0.6): boolean {
  return similarity(a, b) >= 0.75 || containment(a, b) >= threshold;
}

/**
 * Keeps the assistant from being noisy. Every rule here exists because a
 * model with tool access will otherwise happily produce a note per sentence.
 */
export class Gatekeeper {
  private readonly noteMinIntervalMs: number;
  private readonly suggestionMinIntervalMs: number;
  private readonly maxSuggestions: number;
  private readonly duplicateThreshold: number;
  private readonly noteWarmupMs: number;
  private readonly suggestionMinMeetingAgeMs: number;
  private readonly meetingStartAt: number;

  private lastNoteAt = 0;
  private lastSuggestionAt = 0;
  private suggestionCount = 0;
  private readonly noteHistory: string[] = [];
  private readonly suggestionHistory: Array<{ topic: string; suggestion: string }> = [];
  private readonly actionHistory: string[] = [];

  constructor(options: GatekeeperOptions = {}) {
    this.noteMinIntervalMs = options.noteMinIntervalMs ?? 60_000;
    this.suggestionMinIntervalMs = options.suggestionMinIntervalMs ?? 120_000;
    this.maxSuggestions = options.maxSuggestions ?? 3;
    this.duplicateThreshold = options.duplicateThreshold ?? 0.75;
    this.noteWarmupMs = options.noteWarmupMs ?? 0;
    this.suggestionMinMeetingAgeMs = options.suggestionMinMeetingAgeMs ?? 0;
    this.meetingStartAt = options.meetingStartAt ?? 0;
  }

  canPostNote(now: number, content: string, options: { bypassCooldown?: boolean } = {}): GateDecision {
    if (this.meetingStartAt > 0 && now - this.meetingStartAt < this.noteWarmupMs) {
      return {
        allowed: false,
        reason: `too early: wait ${Math.ceil(
          (this.noteWarmupMs - (now - this.meetingStartAt)) / 1000,
        )}s; opening remarks and the agenda are not notes`,
      };
    }
    if (this.noteHistory.some((note) => nearDuplicate(note, content, 0.6))) {
      return { allowed: false, reason: 'duplicate: this note is substantially the same as an earlier note' };
    }
    const elapsed = now - this.lastNoteAt;
    if (!options.bypassCooldown && this.lastNoteAt > 0 && elapsed < this.noteMinIntervalMs) {
      return {
        allowed: false,
        reason: `too soon: wait ${Math.ceil((this.noteMinIntervalMs - elapsed) / 1000)}s before the next note`,
      };
    }
    return { allowed: true };
  }

  markNote(now: number, content: string): void {
    this.lastNoteAt = now;
    this.noteHistory.push(content);
  }

  canSuggest(now: number, topic: string, suggestion: string): GateDecision {
    if (this.meetingStartAt > 0 && now - this.meetingStartAt < this.suggestionMinMeetingAgeMs) {
      return {
        allowed: false,
        reason: `too early: suggestions need more discussion first (${Math.ceil(
          (this.suggestionMinMeetingAgeMs - (now - this.meetingStartAt)) / 1000,
        )}s)`,
      };
    }
    if (this.suggestionCount >= this.maxSuggestions) {
      return {
        allowed: false,
        reason: `suggestion budget exhausted (${this.maxSuggestions} per meeting)`,
      };
    }
    const elapsed = now - this.lastSuggestionAt;
    if (this.lastSuggestionAt > 0 && elapsed < this.suggestionMinIntervalMs) {
      return {
        allowed: false,
        reason: `too soon: wait ${Math.ceil((this.suggestionMinIntervalMs - elapsed) / 1000)}s before the next suggestion`,
      };
    }
    if (
      this.suggestionHistory.some(
        (previous) =>
          similarity(previous.topic, topic) >= this.duplicateThreshold ||
          similarity(previous.suggestion, suggestion) >= 0.9,
      )
    ) {
      return { allowed: false, reason: 'duplicate: a similar suggestion was already made' };
    }
    return { allowed: true };
  }

  markSuggestion(now: number, topic: string, suggestion: string): void {
    this.lastSuggestionAt = now;
    this.suggestionCount += 1;
    this.suggestionHistory.push({ topic, suggestion });
  }

  canExtractAction(task: string): GateDecision {
    if (this.actionHistory.some((previous) => nearDuplicate(previous, task, 0.65))) {
      return { allowed: false, reason: 'duplicate: this action item already exists' };
    }
    return { allowed: true };
  }

  markAction(task: string): void {
    this.actionHistory.push(task);
  }

  stats(): { suggestions: number; notes: number; actions: number } {
    return {
      suggestions: this.suggestionCount,
      notes: this.noteHistory.length,
      actions: this.actionHistory.length,
    };
  }
}
