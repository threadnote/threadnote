import {it as effectIt} from '@effect/vitest';
import {Effect, Schema} from 'effect';
import {describe, expect} from 'vitest';

import {prepareSharedInboundContentEffect} from '@threadnote/threadnote/share/core';

const shared = 'threadnote://user/tester/memories/shared/default/';

describe('shared inbound content', () => {
  effectIt.effect.prop(
    'preserves arbitrary artifact text without memory admission or transformations',
    {text: Schema.String},
    ({text}) =>
      Effect.gen(function* () {
        const content = `  MEMORY\r\nkind: durable\r\ntopic_maintenance: invalid\r\n\r\n${text}\n/tmp/pr<N>.patch\n`;
        for (const path of [
          'agent-artifacts/skills/claude/reviewer/SKILL.md',
          'agent-artifacts/skills/codex/reviewer/references/example.md',
          'agent-artifacts/commands/claude/review.md',
          'agent-artifacts/packs/claude/reviewer/files/example.md',
        ]) {
          expect(yield* prepareSharedInboundContentEffect(shared + path, content)).toBe(content);
        }
      }),
    {arbitrary: {runs: 32}},
  );

  effectIt.effect('keeps memory admission on durable files and similarly named directories', () =>
    Effect.gen(function* () {
      for (const path of ['durable/projects/test/example.md', 'agent-artifacts-other/skills/example.md']) {
        const error = yield* prepareSharedInboundContentEffect(shared + path, '# Example\n\n/tmp/pr<N>.patch').pipe(
          Effect.flip,
        );
        expect(String(error)).toContain('Refusing to ingest');
      }
    }),
  );
});
