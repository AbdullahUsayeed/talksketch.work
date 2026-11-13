import type { TranscriptSegment } from '../types.js';

export type EndReason = 'silence' | 'meeting-ended' | 'stopped' | 'source-finished';

export interface TranscriptSourceHandlers {
  onSegment(segment: TranscriptSegment): void;
  onEnd?(reason: EndReason): void;
}

/**
 * A source of confirmed transcript segments. Vexa is the production source;
 * mock sources make the orchestrator testable without a live call.
 */
export interface TranscriptSource {
  readonly name: string;
  start(handlers: TranscriptSourceHandlers): Promise<void>;
  stop(): Promise<void>;
}
