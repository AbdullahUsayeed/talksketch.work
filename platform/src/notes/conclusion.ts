import type { NoteRecord } from '../types.js';

export function buildConclusion(records: readonly NoteRecord[]): string {
  const decisions = records
    .filter((record) => record.kind === 'note' && /^decision/i.test(record.content))
    .slice(-4)
    .map((record) => `• ${shorten(record.content.replace(/^decision:\s*/i, ''), 88)}`);
  const actions = records
    .filter((record) => record.kind === 'action')
    .slice(-4)
    .map((record) => {
      const owner = record.assignee ?? 'Owner';
      const due = record.deadline ? ` (${shorten(record.deadline, 18)})` : '';
      return `• ${owner}: ${shorten(record.content, 58)}${due}`;
    });

  return [
    'Decisions:',
    ...(decisions.length > 0 ? decisions : ['• None captured']),
    '',
    'Next:',
    ...(actions.length > 0 ? actions : ['• None captured']),
  ].join('\n');
}

export function shorten(value: string, max: number): string {
  const clean = value.replace(/\s+/g, ' ').trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 3).trimEnd()}...`;
}
