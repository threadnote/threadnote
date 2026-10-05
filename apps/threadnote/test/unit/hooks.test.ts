import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {
  renderSessionStartRecallQueue,
  threadnoteHooksAreCurrent,
  withThreadnoteHooks,
} from '@threadnote/threadnote/hooks';
import {codexHooksAreCurrent, withCodexHooks} from '@threadnote/threadnote/codex/hooks';

describe('session-start recall queue', () => {
  it('renders only actionable unread pointers and removes ranking diagnostics', () => {
    const output = [
      'Recall scope: threadnote://user/me/memories/handoffs/active/threadnote',
      'Recall confidence: medium (0.62) — useful match',
      '1. memory · rank 0.71 · score 0.83 · threadnote://user/me/memories/handoffs/active/threadnote/current.md',
      '   why: exact_term_match +0.16; lifecycle +0.05',
      '   warning: lexical-only result',
      '2. resource · rank 0.64 · threadnote://resources/repos/threadnote/AGENTS.md',
      '(+9 more — refine the query or read a URI above)',
    ].join('\n');

    const rendered = renderSessionStartRecallQueue('threadnote', output);

    expect(rendered).toContain('## Threadnote — unread context queue for threadnote');
    expect(rendered).toContain('- [unread] threadnote://user/me/memories/handoffs/active/threadnote/current.md');
    expect(rendered).toContain('- [unread] threadnote://resources/repos/threadnote/AGENTS.md');
    expect(rendered).toContain('Required next action: call `read_context`');
    expect(rendered).toContain('not evidence until its content has been read');
    expect(rendered).not.toContain('Recall confidence');
    expect(rendered).not.toContain('rank 0.71');
    expect(rendered).not.toContain('why:');
    expect(rendered).not.toContain('warning:');
    expect(rendered).not.toContain('Recall scope:');
  });

  it('deduplicates pointers, keeps the first five, and preserves rank order', () => {
    const line = (rank: number, uri: string) => `${rank}. memory · rank 0.70 · ${uri}`;
    const uris = Array.from({length: 6}, (_, index) => `threadnote://resources/repos/p/${index}.md`);
    const rendered = renderSessionStartRecallQueue(
      'p',
      [line(1, uris[0]), line(2, uris[0]), ...uris.slice(1).map((uri, index) => line(index + 3, uri))].join('\n'),
    );

    expect(rendered.match(/\[unread\]/g)).toHaveLength(5);
    expect(rendered.indexOf(uris[0])).toBeLessThan(rendered.indexOf(uris[1]));
    expect(rendered).not.toContain(uris[5]);
  });

  it('does not tell the agent to read when recall returned no pointers', () => {
    const rendered = renderSessionStartRecallQueue('empty', 'Recall confidence: no answer (0.00)');

    expect(rendered).toContain('No unread context pointers were recalled');
    expect(rendered).toContain('there is no recalled memory to treat as context');
    expect(rendered).not.toContain('Required next action: call `read_context`');
  });

  it('preserves bounded operational warnings and does not report a clean no-answer after failed sync', () => {
    const output = [
      'Auto-sync warning: shared repository refresh failed; cached memory may be stale.',
      'Auto-sync warning: Obsidian source refresh failed: source is temporarily unavailable.',
      'Local AI recall warning: semantic retrieval failed (RecallIndexUnavailable); deterministic lexical recall continued.',
      'Recall index warning: the lexical generation is stale; retry after maintenance.',
      '   warning: lexical-only result; no semantic corroboration',
      'Recall confidence: no answer (0.00)',
    ].join('\n');

    const rendered = renderSessionStartRecallQueue('degraded', output);

    expect(rendered).toContain('No unread context pointers were returned, but recall ran in degraded mode.');
    expect(rendered).toContain('Recall warnings (bounded):');
    expect(rendered).toContain('- Auto-sync warning: shared repository refresh failed');
    expect(rendered).toContain('- Auto-sync warning: Obsidian source refresh failed');
    expect(rendered).toContain('- Local AI recall warning: semantic retrieval failed');
    expect(rendered).toContain('- Recall index warning: the lexical generation is stale');
    expect(rendered).toContain('retry recall when healthy');
    expect(rendered).toContain('Do not treat this empty queue as proof that no memory exists.');
    expect(rendered).not.toContain('there is no recalled memory to treat as context');
    expect(rendered).not.toContain('lexical-only result');
    expect(rendered).not.toContain('Recall confidence');
  });

  it('preserves first-seen order while bounding arbitrary queues', () => {
    fc.assert(
      fc.property(fc.array(fc.integer({max: 20, min: 0}), {maxLength: 40}), ids => {
        const uriFor = (id: number) => `threadnote://resources/repos/p/${id}.md`;
        const output = ids.map((id, index) => `${index + 1}. memory · rank 0.70 · ${uriFor(id)}`).join('\n');
        const rendered = renderSessionStartRecallQueue('p', output);
        const emitted = [...rendered.matchAll(/^- \[unread\] (threadnote:\/\/\S+)$/gm)].map(match => match[1]);
        const expected = [...new Set(ids)].slice(0, 5).map(uriFor);

        expect(emitted).toEqual(expected);
      }),
      {numRuns: 100},
    );
  });

  it('deduplicates, truncates, and bounds arbitrary operational warning streams', () => {
    fc.assert(
      fc.property(fc.array(fc.integer({max: 12, min: 0}), {maxLength: 30}), ids => {
        const warningFor = (id: number) => `Auto-sync warning: source-${id} ${'detail'.repeat(80)}`;
        const output = ids.map(warningFor).join('\n');
        const rendered = renderSessionStartRecallQueue('p', output);
        const emitted = [...rendered.matchAll(/^- (Auto-sync warning:.*)$/gm)].map(match => match[1]);
        const expectedIds = [...new Set(ids)].slice(0, 4);

        expect(emitted).toHaveLength(expectedIds.length);
        expect(emitted.map(warning => Number(/source-(\d+)/.exec(warning)?.[1]))).toEqual(expectedIds);
        expect(emitted.every(warning => [...warning].length <= 320)).toBe(true);
        expect(emitted.every(warning => warning.endsWith('…'))).toBe(true);
      }),
      {numRuns: 100},
    );
  });
});

describe('Claude code-brief hook install', () => {
  it('adds one selective pre-edit hook and preserves unrelated hooks across reinstall', () => {
    const input = {hooks: {PreToolUse: [{matcher: 'Bash', hooks: [{type: 'command', command: 'other'}]}]}};
    const installed = withThreadnoteHooks(input);
    const installedHooks = installed.hooks as Record<string, unknown>;
    expect(withThreadnoteHooks(installed)).toEqual(installed);
    expect(threadnoteHooksAreCurrent(installed)).toBe(true);
    expect(threadnoteHooksAreCurrent({hooks: {PreToolUse: installedHooks.PreToolUse}})).toBe(false);
    expect(installed).toMatchObject({
      hooks: {
        PreToolUse: [
          input.hooks.PreToolUse[0],
          {matcher: 'Edit|Write', hooks: [{type: 'command', command: 'threadnote code-brief-hook'}]},
        ],
      },
    });
  });
});

describe('Codex resume hook install', () => {
  it('adds one bounded UserPromptSubmit command and removes only that exact command', () => {
    const other = {hooks: [{type: 'command', command: 'other-hook', timeout: 3}], matcher: 'preserve-me'};
    const input = {
      custom: true,
      hooks: {Stop: [{hooks: [{type: 'command', command: 'stop-hook'}]}], UserPromptSubmit: [other]},
    };
    const installed = withCodexHooks(input);

    expect(withCodexHooks(installed)).toEqual(installed);
    expect(codexHooksAreCurrent(installed)).toBe(true);
    expect(installed).toMatchObject({
      custom: true,
      hooks: {
        Stop: input.hooks.Stop,
        UserPromptSubmit: [
          other,
          {
            hooks: [
              {
                command: 'threadnote codex-resume-hook',
                statusMessage: 'Loading Threadnote continuation context',
                timeout: 15,
                type: 'command',
              },
            ],
          },
        ],
      },
    });
    expect(withCodexHooks(installed, true)).toEqual(input);
  });

  it('preserves arbitrary unrelated command order across install and removal', () => {
    fc.assert(
      fc.property(fc.array(fc.string({maxLength: 24}), {minLength: 1, maxLength: 30}), suffixes => {
        const entries = suffixes.map(suffix => ({hooks: [{type: 'command', command: `other-${suffix}`}]}));
        const input = {hooks: {UserPromptSubmit: entries}};
        const installed = withCodexHooks(input);

        expect(withCodexHooks(installed)).toEqual(installed);
        expect(withCodexHooks(installed, true)).toEqual(input);
      }),
      {numRuns: 100},
    );
  });
});
