import {Array as EffectArray} from 'effect';
import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {
  renderSessionStartRecallQueue,
  threadnoteHooksAreCurrent,
  withThreadnoteHooks,
} from '@threadnote/threadnote/hooks';
import {codexHooksAreCurrent, withCodexHooks} from '@threadnote/threadnote/codex/hooks';
import {isJsonObject} from '@threadnote/platform/json';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

describe('session-start recall queue', () => {
  it('renders only actionable unread pointers and removes ranking diagnostics', () => {
    const output = EffectArray.join(
      [
        'Recall scope: threadnote://user/me/memories/handoffs/active/threadnote',
        'Recall confidence: medium (0.62) — useful match',
        '1. memory · rank 0.71 · score 0.83 · threadnote://user/me/memories/handoffs/active/threadnote/current.md',
        '   why: exact_term_match +0.16; lifecycle +0.05',
        '   warning: lexical-only result',
        '2. resource · rank 0.64 · threadnote://resources/repos/threadnote/AGENTS.md',
        '(+9 more — refine the query or read a URI above)',
      ],
      '\n',
    );

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
      EffectArray.join(
        [line(1, uris[0]), line(2, uris[0]), ...EffectArray.map(uris.slice(1), (uri, index) => line(index + 3, uri))],
        '\n',
      ),
    );

    expect(
      Effect.pipe(
        rendered,
        EffectString.match(/\[unread\]/g),
        Effect.Option.getOrElse(() => null),
      ),
    ).toHaveLength(5);
    expect(
      Effect.pipe(
        rendered,
        EffectString.indexOf(uris[0]),
        Effect.Option.getOrElse(() => -1),
      ),
    ).toBeLessThan(
      Effect.pipe(
        rendered,
        EffectString.indexOf(uris[1]),
        Effect.Option.getOrElse(() => -1),
      ),
    );
    expect(rendered).not.toContain(uris[5]);
  });

  it('does not tell the agent to read when recall returned no pointers', () => {
    const rendered = renderSessionStartRecallQueue('empty', 'Recall confidence: no answer (0.00)');

    expect(rendered).toContain('No unread context pointers were recalled');
    expect(rendered).toContain('there is no recalled memory to treat as context');
    expect(rendered).not.toContain('Required next action: call `read_context`');
  });

  it('preserves bounded operational warnings and does not report a clean no-answer after failed sync', () => {
    const output = EffectArray.join(
      [
        'Auto-sync warning: shared repository refresh failed; cached memory may be stale.',
        'Auto-sync warning: Obsidian source refresh failed: source is temporarily unavailable.',
        'Local AI recall warning: semantic retrieval failed (RecallIndexUnavailable); deterministic lexical recall continued.',
        'Recall index warning: the lexical generation is stale; retry after maintenance.',
        '   warning: lexical-only result; no semantic corroboration',
        'Recall confidence: no answer (0.00)',
      ],
      '\n',
    );

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
        const output = EffectArray.join(
          EffectArray.map(ids, (id, index) => `${index + 1}. memory · rank 0.70 · ${uriFor(id)}`),
          '\n',
        );
        const rendered = renderSessionStartRecallQueue('p', output);
        const emitted = EffectArray.map(
          [...Effect.pipe(rendered, EffectString.matchAll(/^- \[unread\] (threadnote:\/\/\S+)$/gm))],
          match => match[1],
        );
        const expected = EffectArray.map([...new Set(ids)].slice(0, 5), uriFor);

        expect(emitted).toEqual(expected);
      }),
      {numRuns: 100},
    );
  });

  it('deduplicates, truncates, and bounds arbitrary operational warning streams', () => {
    fc.assert(
      fc.property(fc.array(fc.integer({max: 12, min: 0}), {maxLength: 30}), ids => {
        const warningFor = (id: number) =>
          `Auto-sync warning: source-${id} ${Effect.pipe('detail', EffectString.repeat(80))}`;
        const output = EffectArray.join(EffectArray.map(ids, warningFor), '\n');
        const rendered = renderSessionStartRecallQueue('p', output);
        const emitted = EffectArray.map(
          [...Effect.pipe(rendered, EffectString.matchAll(/^- (Auto-sync warning:.*)$/gm))],
          match => match[1],
        );
        const expectedIds = [...new Set(ids)].slice(0, 4);

        expect(emitted).toHaveLength(expectedIds.length);
        expect(EffectArray.map(emitted, warning => Number(/source-(\d+)/.exec(warning)?.[1]))).toEqual(expectedIds);
        expect(EffectArray.every(emitted, warning => [...warning].length <= 320)).toBe(true);
        expect(EffectArray.every(emitted, warning => Effect.pipe(warning, EffectString.endsWith('…')))).toBe(true);
      }),
      {numRuns: 100},
    );
  });
});

describe('Claude code-brief hook install', () => {
  it('adds one selective pre-edit hook and preserves unrelated hooks across reinstall', () => {
    const input = {hooks: {PreToolUse: [{matcher: 'Bash', hooks: [{type: 'command', command: 'other'}]}]}};
    const installed = withThreadnoteHooks(input);
    const installedHooks = installed.hooks;
    if (!isJsonObject(installedHooks)) throw new Error('Expected installed hook settings.');
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
        const entries = EffectArray.map(suffixes, suffix => ({hooks: [{type: 'command', command: `other-${suffix}`}]}));
        const input = {hooks: {UserPromptSubmit: entries}};
        const installed = withCodexHooks(input);

        expect(withCodexHooks(installed)).toEqual(installed);
        expect(withCodexHooks(installed, true)).toEqual(input);
      }),
      {numRuns: 100},
    );
  });
});
