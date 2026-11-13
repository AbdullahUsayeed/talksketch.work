import { RollingContext } from '../context/RollingContext.js';
import type { TranscriptSegment } from '../types.js';

/**
 * Holds the transcript window and tracks whether new confirmed speech arrived
 * since the last agent turn, so an idle meeting costs no model calls.
 */
export class TranscriptBuffer {
  private readonly context: RollingContext;
  private pending = 0;
  private total = 0;

  constructor(options: { maxTokens?: number } = {}) {
    this.context = new RollingContext({ maxTokens: options.maxTokens ?? 2000 });
  }

  add(segment: TranscriptSegment): boolean {
    if (!this.context.add(segment)) return false;
    this.total += 1;
    this.pending += 1;
    return true;
  }

  hasPending(): boolean {
    return this.pending > 0;
  }

  consumePending(): number {
    const value = this.pending;
    this.pending = 0;
    return value;
  }

  render(): string {
    return this.context.render();
  }

  size(): number {
    return this.total;
  }
}
