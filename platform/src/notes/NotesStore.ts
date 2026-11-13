import { appendFile, mkdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { MeetingMeta, NoteRecord } from '../types.js';

/**
 * Meeting artifacts on disk. Deliberately plain Markdown + JSONL: the notes can
 * be committed, diffed, pushed to Notion/Slack, or read by another agent.
 */
export class NotesStore {
  private readonly dir: string;
  private readonly records: NoteRecord[] = [];

  constructor(
    dataDir: string,
    private readonly meta: MeetingMeta,
  ) {
    this.dir = join(dataDir, sanitize(meta.id));
  }

  async init(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
  }

  async add(record: NoteRecord): Promise<void> {
    this.records.push(record);
    await appendFile(join(this.dir, 'records.jsonl'), `${JSON.stringify(record)}\n`, 'utf8');
    await this.writeAtomic('notes.md', renderNotes(this.meta, this.records));
  }

  all(): readonly NoteRecord[] {
    return this.records;
  }

  path(): string {
    return this.dir;
  }

  async saveSummary(markdown: string): Promise<void> {
    await this.writeAtomic('summary.md', markdown);
  }

  private async writeAtomic(name: string, content: string): Promise<void> {
    const target = join(this.dir, name);
    const tmp = `${target}.tmp`;
    await writeFile(tmp, content, 'utf8');
    await rename(tmp, target);
  }
}

export function renderNotes(meta: MeetingMeta, records: readonly NoteRecord[]): string {
  const notes = records.filter((record) => record.kind === 'note');
  const suggestions = records.filter((record) => record.kind === 'suggestion');
  const actions = records.filter((record) => record.kind === 'action');

  const lines = [
    `# ${meta.topic ?? `Meeting ${meta.nativeMeetingId}`}`,
    '',
    `- **Platform:** ${meta.platform} (${meta.nativeMeetingId})`,
    `- **Started:** ${meta.startedAt}`,
    `- **Participants:** ${meta.participants.join(', ') || 'not stated'}`,
    '',
    '## Notes',
    '',
    ...(notes.length > 0
      ? notes.map((note) => `- **${clock(note.createdAt)}** ${note.content.replace(/\n/g, ' ')}`)
      : ['_No notes yet._']),
    '',
    '## Suggestions',
    '',
  ];

  if (suggestions.length === 0) {
    lines.push('_No suggestions yet._');
  } else {
    for (const suggestion of suggestions) {
      lines.push(
        `### ${suggestion.topic ?? 'Suggestion'}`,
        '',
        `> ${suggestion.rationale ?? ''}`,
        '',
        suggestion.content,
        '',
      );
    }
  }

  lines.push('## Action items', '');
  if (actions.length === 0) {
    lines.push('_No action items yet._');
  } else {
    for (const action of actions) {
      const owner = action.assignee ? ` - **${action.assignee}**` : '';
      const due = action.deadline ? ` (due ${action.deadline})` : '';
      lines.push(`- [ ] ${action.content}${owner}${due}`);
    }
  }

  lines.push('', '---', '', '_Notes by meeting-partner. May contain errors._', '');
  return lines.join('\n');
}

export function renderSummary(
  meta: MeetingMeta,
  records: readonly NoteRecord[],
  agentSummary: string,
): string {
  const actions = records.filter((record) => record.kind === 'action');
  return [
    `# ${meta.topic ?? `Meeting ${meta.nativeMeetingId}`} - summary`,
    '',
    `_${meta.platform} | ${meta.startedAt} | ${meta.participants.join(', ') || 'participants not stated'}_`,
    '',
    '## Summary',
    '',
    agentSummary.trim() || '_The agent did not produce a summary._',
    '',
    '## Action items',
    '',
    ...(actions.length > 0
      ? actions.map((action) => {
          const owner = action.assignee ? ` - ${action.assignee}` : '';
          const due = action.deadline ? ` (due ${action.deadline})` : '';
          return `- [ ] ${action.content}${owner}${due}`;
        })
      : ['- None captured']),
    '',
    '---',
    '',
    'Full notes: notes.md | Raw records: records.jsonl',
    '',
  ].join('\n');
}

function clock(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? '--:--'
    : `${String(date.getUTCHours()).padStart(2, '0')}:${String(date.getUTCMinutes()).padStart(2, '0')}Z`;
}

function sanitize(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, '_');
}
