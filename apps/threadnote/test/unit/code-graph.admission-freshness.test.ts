import {fcEffectProp, fcProp} from '@threadnote/testing/fast-check-property';
import * as BunServices from '@effect/platform-bun/BunServices';
import {describe, expect, it} from '@effect/vitest';
import {Effect, FileSystem, Path} from 'effect';
import * as FC from 'fast-check';
import {
  codeGraphSnapshotAdmissionCurrent,
  recordCodeGraphSnapshotAdmission,
} from '@threadnote/graph/admission_freshness';
import {codeGraphBuildRequestKey} from '@threadnote/graph/indexer/build';
import {BUILTIN_LANGUAGE_PACK_REGISTRY} from '@threadnote/graph/languages/registry';
import {codeGraphLayout} from '@threadnote/graph/layout';
import type {CodeGraphSnapshot} from '@threadnote/graph/types';
import {provideTestLayer} from '../helpers/effect-layer.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

describe('snapshot admission cache', () => {
  fcEffectProp(
    it,
    'binds current evidence to exactly one snapshot and environment per worktree',
    {
      dirty: FC.boolean(),
      layered: FC.boolean(),
      suffix: FC.integer({min: 1, max: 100_000}),
    },
    ({dirty, layered, suffix}) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-admission-cache-'});
        const layout = codeGraphLayout(
          path,
          home,
          Effect2.pipe('c', EffectString.repeat(64)),
          Effect2.pipe('d', EffectString.repeat(64)),
        );
        const snapshot: CodeGraphSnapshot = {
          ...(layered ? {baseSnapshotId: `cgsn_${Effect2.pipe('0', EffectString.repeat(40))}`} : {}),
          commit: Effect2.pipe('e', EffectString.repeat(40)),
          dirty,
          edgeCount: 0,
          extractorSet: Effect2.pipe('f', EffectString.repeat(64)),
          fileCount: 1,
          id: `cgsn_${Effect2.pipe(suffix.toString(16), EffectString.padStart(40, '0'))}`,
          repositoryId: Effect2.pipe('a', EffectString.repeat(64)),
          state: 'ready',
          symbolCount: 1,
          worktreeId: layout.worktreeId,
        };
        const packs = BUILTIN_LANGUAGE_PACK_REGISTRY;
        const first = Effect2.pipe('1', EffectString.repeat(64)),
          second = Effect2.pipe('2', EffectString.repeat(64));
        expect(yield* codeGraphSnapshotAdmissionCurrent(layout, snapshot, first, packs)).toBe(false);
        yield* recordCodeGraphSnapshotAdmission(layout, snapshot, first, packs, false);
        expect(yield* codeGraphSnapshotAdmissionCurrent(layout, snapshot, first, packs)).toBe(true);
        expect(yield* codeGraphSnapshotAdmissionCurrent(layout, snapshot, second, packs)).toBe(false);
        if (!dirty) {
          const overlay = {...snapshot, dirty: true, id: `${snapshot.id}-dirty`};
          yield* recordCodeGraphSnapshotAdmission(layout, overlay, first, packs, false);
          expect(yield* codeGraphSnapshotAdmissionCurrent(layout, snapshot, first, packs)).toBe(false);
          expect(yield* codeGraphSnapshotAdmissionCurrent(layout, snapshot, first, packs, true)).toBe(true);
          expect(yield* codeGraphSnapshotAdmissionCurrent(layout, snapshot, second, packs, true)).toBe(false);
          yield* recordCodeGraphSnapshotAdmission(layout, snapshot, first, packs, false, {cleanOnly: true});
          expect(yield* codeGraphSnapshotAdmissionCurrent(layout, overlay, first, packs)).toBe(true);
          expect(yield* codeGraphSnapshotAdmissionCurrent(layout, snapshot, first, packs)).toBe(false);
          const rejected = yield* recordCodeGraphSnapshotAdmission(layout, overlay, first, packs, false, {
            cleanOnly: true,
          }).pipe(Effect.flip);
          expect(rejected).toMatchObject({_tag: 'CodeGraphAdmissionError'});
          expect(yield* codeGraphSnapshotAdmissionCurrent(layout, overlay, first, packs)).toBe(true);
          yield* recordCodeGraphSnapshotAdmission(layout, snapshot, first, packs, false);
        }
        const replacement = {...snapshot, id: `${snapshot.id}-next`};
        expect(yield* codeGraphSnapshotAdmissionCurrent(layout, replacement, first, packs)).toBe(false);
        expect(
          yield* codeGraphSnapshotAdmissionCurrent(
            layout,
            {...snapshot, repositoryId: Effect2.pipe('b', EffectString.repeat(64))},
            first,
            packs,
          ),
        ).toBe(false);
        yield* recordCodeGraphSnapshotAdmission(layout, replacement, second, packs, true);
        expect(yield* codeGraphSnapshotAdmissionCurrent(layout, snapshot, first, packs)).toBe(false);
        expect(yield* codeGraphSnapshotAdmissionCurrent(layout, replacement, second, packs)).toBe(true);
        const target = path.join(layout.repositoryRoot, 'admission', `${layout.worktreeId}.json`);
        for (const broken of ['{"version":', Effect2.pipe(' ', EffectString.repeat(4_097))]) {
          yield* fs.writeFileString(target, broken);
          expect(yield* codeGraphSnapshotAdmissionCurrent(layout, replacement, second, packs)).toBe(false);
        }
      }).pipe(provideTestLayer(BunServices.layer)),
    {fastCheck: {numRuns: 20}},
  );

  fcProp(
    it,
    'deduplicates only build requests with the same policy environment',
    {
      suffix: FC.integer({min: 0, max: 1_000_000}),
      dirty: FC.boolean(),
    },
    ({suffix, dirty}) => {
      const identity = {
        checkoutId: Effect2.pipe('c', EffectString.repeat(64)),
        headCommit: Effect2.pipe('e', EffectString.repeat(40)),
        repositoryId: Effect2.pipe('a', EffectString.repeat(64)),
        worktreeId: Effect2.pipe('d', EffectString.repeat(64)),
      };
      const environment = Effect2.pipe(suffix.toString(16), EffectString.padStart(64, '0'));
      const changed = Effect2.pipe((suffix + 1).toString(16), EffectString.padStart(64, '0'));
      const key = (value: string) =>
        codeGraphBuildRequestKey(
          identity,
          {dirty, fingerprint: 'overlay'},
          BUILTIN_LANGUAGE_PACK_REGISTRY,
          undefined,
          false,
          value,
        );
      expect(key(environment)).toBe(key(environment));
      expect(key(environment)).not.toBe(key(changed));
    },
    {fastCheck: {numRuns: 100}},
  );
});
