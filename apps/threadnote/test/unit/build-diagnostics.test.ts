import {Array as EffectArray} from 'effect';
import {it as effectIt} from '@effect/vitest';
import {Effect} from 'effect';
import {describe, expect} from 'vitest';
import {runBunBuild} from '../../../../scripts/effect/bun-build.js';
import {ScriptError} from '../../../../scripts/effect/errors.js';

describe('Bun build diagnostics', () => {
  effectIt.effect('preserves rejected child diagnostics and the original cause', () =>
    Effect.gen(function* () {
      const diagnostic = Object.assign(new Error('Browser build cannot import Bun builtin: "bun:sqlite".'), {
        position: {
          column: 3,
          file: '/workspace/src/fixture.ts',
          line: 7,
          lineText: "import {Database} from 'bun:sqlite';",
        },
      });
      const cause = new AggregateError([diagnostic], 'Bundle failed');

      const failure = yield* runBunBuild({entrypoints: ['/workspace/src/fixture.ts']}, () =>
        Promise.reject(cause),
      ).pipe(Effect.flip);

      expect(failure).toBeInstanceOf(ScriptError);
      expect(failure.cause).toBe(cause);
      expect(failure.message).toBe(
        EffectArray.join(
          [
            'Bun could not build the standalone artifact.',
            'Build diagnostics:',
            '/workspace/src/fixture.ts:7:3: Browser build cannot import Bun builtin: "bun:sqlite".',
            "  import {Database} from 'bun:sqlite';",
          ],
          '\n',
        ),
      );
    }),
  );
});
