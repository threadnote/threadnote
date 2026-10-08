import {describe, expect, it} from 'vitest';
import {parseObsidianInboxNote} from '@threadnote/threadnote/integrations/obsidian/inbox';

describe('Obsidian Inbox contract', () => {
  it('parses explicitly marked durable candidates', () => {
    expect(
      parseObsidianInboxNote(
        [
          '---',
          'threadnote_candidate: true',
          'kind: durable',
          'project: threadnote',
          'topic: obsidian-bridge',
          'category: invariant',
          'evidence:',
          '  - commit:abc123',
          '---',
          '',
          'External notes never override canonical repository guidance.',
        ].join('\n'),
      ),
    ).toEqual({
      body: 'External notes never override canonical repository guidance.',
      category: 'invariant',
      evidence: ['commit:abc123'],
      kind: 'durable',
      project: 'threadnote',
      topic: 'obsidian-bridge',
    });
  });

  it('rejects ordinary notes and unsupported authority fields by omission', () => {
    expect(() =>
      parseObsidianInboxNote(
        ['---', 'kind: durable', 'project: threadnote', 'topic: bridge', '---', 'Body'].join('\n'),
      ),
    ).toThrow(/threadnote_candidate must be true/i);

    const parsed = parseObsidianInboxNote(
      [
        '---',
        'threadnote_candidate: true',
        'kind: handoff',
        'project: threadnote',
        'topic: bridge',
        'authority: canonical_repo',
        'trust: approved',
        '---',
        'Continue with projection tests.',
      ].join('\n'),
    );
    expect(parsed).not.toHaveProperty('authority');
    expect(parsed).not.toHaveProperty('trust');
  });
});
