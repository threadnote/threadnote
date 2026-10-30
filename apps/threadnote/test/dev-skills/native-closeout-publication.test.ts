import {it as effectIt} from '@effect/vitest';

import {Effect, Result} from 'effect';

import {describe, expect} from 'vitest';

import {nativeCloseoutFixture} from './native-closeout-fixture.js';

import {runCloseout} from './native-closeout-diagnostics.js';

import * as EffectRecord from 'effect/Record';

import {
  assertOwnedState,
  commandResult,
  journalImage,
  object,
  proposalFor,
  readArtifact,
  windowsCloseoutTimeout,
} from './native-closeout-lifecycle-fixture.js';

describe('native closeout lifecycle', () => {
  for (const profile of ['codex-cloud-personal', 'cursor-cloud-personal'] as const)
    // prettier-ignore
    effectIt.effect(`${profile} preserves drafts until native publication approval`, () =>
      Effect.gen(function* () {
        const f = yield* nativeCloseoutFixture(false, profile);
        const loaded = yield* f.load();
        const validation = yield* f.closeout('validation-input');
        const proposal = proposalFor(validation);
        yield* f.closeout('prepare', {proposal});
        const beforePreview = yield* f.fs.readFileString(f.statePath('plan-run'));
        const preview = object(yield* f.closeout('publication-preview'));
        expect(object(preview.publication).approvalDigest).toMatch(/^[a-f0-9]{64}$/u);
        expect(yield* f.fs.readFileString(f.statePath('plan-run'))).toBe(beforePreview);
        const pendingFinish = yield* commandResult(f.closeout('finish'));
        expect(Result.isFailure(pendingFinish)).toBe(true);
        yield* assertOwnedState(f, loaded.owned, 'active');
        const image = yield* journalImage(f);
        expect(EffectRecord.keys(image.archives)).toHaveLength(0);
        expect((yield* readArtifact(f, f.unrelated.uri, 'plan-run')).state).toBe('active');
      }).pipe(runCloseout),
      windowsCloseoutTimeout,
    );
});
