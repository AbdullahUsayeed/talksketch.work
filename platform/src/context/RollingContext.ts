import type { TranscriptSegment } from '../types.js';

export interface RollingContextOptions {
  /** Approximate token budget for the transcript window. */
  maxTokens?: number;
  /** Never trim below this many segments. */
  minSegments?: number;
}

function estimateTokens(text: string): number {
  // Good enough for budgeting: ~4 characters per token for English.
  return Math.ceil(text.length / 4);
}

function formatTimestamp(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  return `${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}`;
}

/**
 * Holds the recent part of the meeting transcript that is sent to the model.
 *
 * Only confirmed (completed) segments are kept. A draft segment is replaced by
 * its confirmed version when it arrives, which is how Vexa publishes live
 * speech-to-text results.
 */
export class RollingContext {
  private readonly maxTokens: number;
  private readonly minSegments: number;
  private readonly segments = new Map<string, TranscriptSegment>();

  constructor(options: RollingContextOptions = {}) {
    this.maxTokens = options.maxTokens ?? 3000;
    this.minSegments = options.minSegments ?? 4;
  }

  /**
   * Adds a segment. Returns true when the window materially changed and the
   * orchestrator should consider running an analysis.
   */
  add(segment: TranscriptSegment): boolean {
    const text = segment.text.trim();
    if (!text) return false;
    if (!segment.completed) return false;

    const key = segment.id;
    const existing = this.segments.get(key);
    if (existing && existing.text === text) return false;

    // Map preserves insertion order; re-setting an existing key keeps its place.
    this.segments.set(key, { ...segment, text, id: key });
    this.trim();
    return true;
  }

  all(): TranscriptSegment[] {
    return [...this.segments.values()];
  }

  size(): number {
    return this.segments.size;
  }

  clear(): void {
    this.segments.clear();
  }

  estimateTokens(): number {
    return estimateTokens(this.render());
  }

  /** Prompt-ready transcript window. */
  render(): string {
    return this.all()
      .map((segment) => {
        const speaker = segment.speaker.trim() || 'Unknown speaker';
        const stamp = formatTimestamp(segment.start);
        return `[${stamp}] ${speaker}: ${segment.text}`;
      })
      .join('\n');
  }

  private trim(): void {
    while (this.segments.size > this.minSegments && estimateTokens(this.render()) > this.maxTokens) {
      const oldest = this.segments.keys().next();
      if (oldest.done) break;
      this.segments.delete(oldest.value);
    }
  }
}
