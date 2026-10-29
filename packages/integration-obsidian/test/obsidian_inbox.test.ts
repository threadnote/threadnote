import {Array as EffectArray} from 'effect';
import {describe, expect, it} from 'vitest';
import {parseObsidianInboxNote} from '../src/inbox.js';

describe('Obsidian Inbox contract', () => {
  it('parses explicitly marked durable candidates', () => {
    expect(
      parseObsidianInboxNote(
        EffectArray.join(
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
          ],
          '\n',
        ),
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
        EffectArray.join(['---', 'kind: durable', 'project: threadnote', 'topic: bridge', '---', 'Body'], '\n'),
      ),
    ).toThrow(/threadnote_candidate must be true/i);

    const parsed = parseObsidianInboxNote(
      EffectArray.join(
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
        ],
        '\n',
      ),
    );
    expect(parsed).not.toHaveProperty('authority');
    expect(parsed).not.toHaveProperty('trust');
  });
});
