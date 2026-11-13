export type Platform = 'google_meet' | 'zoom' | 'teams' | 'jitsi';

export interface TranscriptSegment {
  /** Stable id when the source provides one, otherwise derived from timing. */
  id: string;
  speaker: string;
  text: string;
  /** Seconds from meeting start. */
  start: number;
  end: number;
  language?: string;
  /** Drafts (completed === false) are never added to the context window. */
  completed: boolean;
  confidence?: number;
}

export interface MeetingMeta {
  id: string;
  platform: Platform;
  /** Platform-native meeting id, e.g. abc-defg-hij. */
  nativeMeetingId: string;
  topic?: string;
  participants: string[];
  /** Product/company background used to make suggestions relevant. */
  companyContext?: string;
  startedAt: string;
  botName: string;
}

export type NoteKind = 'note' | 'suggestion' | 'action';

export interface NoteRecord {
  id: string;
  meetingId: string;
  createdAt: string;
  kind: NoteKind;
  /** Note body, or the suggestion itself, or the task. */
  content: string;
  /** Suggestions only. */
  topic?: string;
  /** Suggestions only: why it was raised, grounded in the transcript. */
  rationale?: string;
  /** Actions only. */
  assignee?: string;
  deadline?: string;
}
