import {Array as EffectArray} from 'effect';
import * as BunServices from '@effect/platform-bun/BunServices';
import {it as effectIt} from '@effect/vitest';
import {Effect, FileSystem, Path} from 'effect';
import fc from 'fast-check';
import {describe, expect} from 'vitest';
import {
  codeGraphSnapshotAdmissionCurrent,
  codeGraphSnapshotAdmissionReceiptPath,
  recordCodeGraphSnapshotAdmission,
  type CodeGraphScopeAdmissionEvidence,
} from '@threadnote/graph/admission_freshness';
import {codeGraphInventoryReuseContract} from '@threadnote/graph/inventory/reuse';
import {BUILTIN_LANGUAGE_PACK_REGISTRY} from '@threadnote/graph/languages/registry';
import {codeGraphLayout} from '@threadnote/graph/layout';
import type {CodeGraphSnapshot} from '@threadnote/graph/types';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {fcEffectProp} from '@threadnote/testing/fast-check-property';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

const packs = BUILTIN_LANGUAGE_PACK_REGISTRY;
const environment = Effect2.pipe('f', EffectString.repeat(64));
const snapshot: CodeGraphSnapshot = {
  commit: Effect2.pipe('a', EffectString.repeat(40)),
  dirty: false,
  edgeCount: 0,
  extractorSet: Effect2.pipe('b', EffectString.repeat(64)),
  fileCount: 0,
  id: `cgsn_${Effect2.pipe('c', EffectString.repeat(40))}`,
  repositoryId: Effect2.pipe('d', EffectString.repeat(64)),
  state: 'ready',
  symbolCount: 0,
  worktreeId: Effect2.pipe('e', EffectString.repeat(64)),
};
const scope: CodeGraphScopeAdmissionEvidence = {
  scopeKey: `code-graph-scope:${Effect2.pipe('1', EffectString.repeat(64))}`,
  closureDigest: Effect2.pipe('2', EffectString.repeat(64)),
  definitionDigest: Effect2.pipe('3', EffectString.repeat(64)),
  inventoryFingerprint: Effect2.pipe('4', EffectString.repeat(64)),
  observedCommit: Effect2.pipe('5', EffectString.repeat(40)),
};
const setup = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-scope-admission-'});
  const layout = codeGraphLayout(path, home, Effect2.pipe('a', EffectString.repeat(64)), snapshot.worktreeId);
  const target = (key?: string) => codeGraphSnapshotAdmissionReceiptPath(path, layout, layout.worktreeId, false, key);
  const current = (evidence?: CodeGraphScopeAdmissionEvidence) =>
    codeGraphSnapshotAdmissionCurrent(layout, snapshot, environment, packs, false, evidence);
  return {current, fs, layout, path, target};
});

describe('scope-bound snapshot admission', () => {
  fcEffectProp(
    effectIt,
    'keeps sibling and full receipts independent under promotions and current-receipt removal',
    {seeds: fc.uniqueArray(fc.string({maxLength: 20}), {minLength: 2, maxLength: 6})},
    ({seeds}) =>
      Effect.gen(function* () {
        const {current, fs, layout, target} = yield* setup;
        const scopes = EffectArray.map(seeds, seed => ({
          ...scope,
          scopeKey: `code-graph-scope:${sha256HexSync(seed)}`,
        }));
        yield* recordCodeGraphSnapshotAdmission(layout, snapshot, environment, packs, false);
        for (const selection of scopes) {
          yield* recordCodeGraphSnapshotAdmission(layout, snapshot, environment, packs, false, {scope: selection});
        }
        for (const selection of scopes) expect(yield* current(selection)).toBe(true);
        expect(yield* current()).toBe(true);
        const changed = {...scopes[0], inventoryFingerprint: Effect2.pipe('6', EffectString.repeat(64))};
        yield* recordCodeGraphSnapshotAdmission(layout, snapshot, environment, packs, false, {scope: changed});
        expect(yield* current(scopes[0])).toBe(false);
        expect(yield* current(changed)).toBe(true);
        yield* fs.remove(target(changed.scopeKey));
        expect(yield* current(changed)).toBe(false);
        for (const selection of scopes.slice(1)) expect(yield* current(selection)).toBe(true);
        expect(yield* current()).toBe(true);
      }).pipe(provideTestLayer(BunServices.layer)),
    {fastCheck: {numRuns: 20}},
  );

  effectIt.effect('rejects cross-scope replay and every changed applicability or policy dimension', () =>
    Effect.gen(function* () {
      const {current, fs, layout, target} = yield* setup;
      yield* recordCodeGraphSnapshotAdmission(layout, snapshot, environment, packs, false, {scope});
      expect(yield* current(scope)).toBe(true);
      for (const changed of [
        {...scope, closureDigest: Effect2.pipe('9', EffectString.repeat(64))},
        {...scope, definitionDigest: Effect2.pipe('9', EffectString.repeat(64))},
        {...scope, inventoryFingerprint: Effect2.pipe('9', EffectString.repeat(64))},
        {...scope, observedCommit: Effect2.pipe('9', EffectString.repeat(40))},
        {...scope, scopedOverlayFingerprint: Effect2.pipe('9', EffectString.repeat(64))},
      ])
        expect(yield* current(changed)).toBe(false);
      expect(
        yield* codeGraphSnapshotAdmissionCurrent(
          layout,
          snapshot,
          Effect2.pipe('9', EffectString.repeat(64)),
          packs,
          false,
          scope,
        ),
      ).toBe(false);
      expect(
        yield* codeGraphSnapshotAdmissionCurrent(
          layout,
          {...snapshot, extractorSet: Effect2.pipe('9', EffectString.repeat(64))},
          environment,
          packs,
          false,
          scope,
        ),
      ).toBe(false);
      const sibling = {...scope, scopeKey: `code-graph-scope:${Effect2.pipe('7', EffectString.repeat(64))}`};
      const contents = yield* fs.readFileString(target(scope.scopeKey));
      yield* fs.writeFileString(target(sibling.scopeKey), contents);
      expect(yield* current(sibling)).toBe(false);
      yield* fs.writeFileString(target(), contents);
      expect(yield* current()).toBe(false);
      yield* fs.writeFileString(target(), JSON.stringify({...JSON.parse(contents), version: 1}));
      expect(yield* current()).toBe(false);
      const other = {...layout, worktreeId: Effect2.pipe('0', EffectString.repeat(64))};
      yield* fs.writeFileString(
        codeGraphSnapshotAdmissionReceiptPath(yield* Path.Path, other, other.worktreeId, false, scope.scopeKey),
        contents,
      );
      expect(yield* codeGraphSnapshotAdmissionCurrent(other, snapshot, environment, packs, false, scope)).toBe(false);
    }).pipe(provideTestLayer(BunServices.layer)),
  );

  effectIt.effect('accepts legacy evidence only as full scope and rewrites it on successful publication', () =>
    Effect.gen(function* () {
      const {current, fs, layout, path, target} = yield* setup;
      yield* fs.makeDirectory(path.dirname(target()), {recursive: true});
      const legacy = JSON.stringify({
        contract: codeGraphInventoryReuseContract(packs, false),
        environmentFingerprint: environment,
        includeOpaqueCorpusAssets: false,
        repositoryId: snapshot.repositoryId,
        snapshotId: snapshot.id,
        version: 1,
        worktreeId: layout.worktreeId,
      });
      yield* fs.writeFileString(target(), legacy);
      expect(yield* current()).toBe(true);
      expect(yield* current(scope)).toBe(false);
      yield* fs.writeFileString(target(scope.scopeKey), legacy);
      expect(yield* current(scope)).toBe(false);
      yield* recordCodeGraphSnapshotAdmission(layout, snapshot, environment, packs, false);
      expect(JSON.parse(yield* fs.readFileString(target()))).toMatchObject({version: 2, scopeKey: 'full-repository'});
      expect(yield* current()).toBe(true);
    }).pipe(provideTestLayer(BunServices.layer)),
  );

  effectIt.effect('rejects malformed, oversized, and symlinked evidence without disturbing sibling receipts', () =>
    Effect.gen(function* () {
      const {current, fs, layout, target} = yield* setup;
      yield* recordCodeGraphSnapshotAdmission(layout, snapshot, environment, packs, false);
      yield* recordCodeGraphSnapshotAdmission(layout, snapshot, environment, packs, false, {scope});
      const contents = yield* fs.readFileString(target(scope.scopeKey));
      for (const malformed of [
        '{',
        Effect2.pipe(' ', EffectString.repeat(4_097)),
        Effect2.pipe(contents, EffectString.replace('"version":2', '"version":3')),
        JSON.stringify({...JSON.parse(contents), contract: Effect2.pipe('0', EffectString.repeat(64))}),
        JSON.stringify({...JSON.parse(contents), scope: {...scope, closureDigest: 'malformed'}}),
      ]) {
        yield* fs.writeFileString(target(scope.scopeKey), malformed);
        expect(yield* current(scope)).toBe(false);
        expect(yield* current()).toBe(true);
      }
      yield* fs.remove(target(scope.scopeKey));
      yield* fs.symlink(target(), target(scope.scopeKey));
      expect(yield* current(scope)).toBe(false);
      expect(yield* current()).toBe(true);
    }).pipe(provideTestLayer(BunServices.layer)),
  );

  effectIt.effect('rejects invalid writes and symbolic-link admission directories', () =>
    Effect.gen(function* () {
      const {current, fs, layout, path, target} = yield* setup;
      yield* recordCodeGraphSnapshotAdmission(layout, snapshot, environment, packs, false, {scope});
      for (const invalid of [
        {...scope, scopeKey: '../escape'},
        {...scope, definitionDigest: ''},
        {...scope, observedCommit: 'not-a-commit'},
      ]) {
        expect(
          yield* recordCodeGraphSnapshotAdmission(layout, snapshot, environment, packs, false, {scope: invalid}).pipe(
            Effect.flip,
          ),
        ).toMatchObject({_tag: 'CodeGraphAdmissionError'});
        expect(yield* current(scope)).toBe(true);
      }
      expect(
        yield* recordCodeGraphSnapshotAdmission(
          layout,
          {...snapshot, id: Effect2.pipe('x', EffectString.repeat(4_097))},
          environment,
          packs,
          false,
          {scope},
        ).pipe(Effect.flip),
      ).toMatchObject({_tag: 'CodeGraphAdmissionError'});
      const originalDirectory = path.dirname(target());
      const movedDirectory = `${originalDirectory}-original`;
      yield* fs.rename(originalDirectory, movedDirectory);
      yield* fs.symlink(movedDirectory, originalDirectory);
      expect(yield* current(scope)).toBe(false);
      expect(
        yield* recordCodeGraphSnapshotAdmission(layout, snapshot, environment, packs, false, {scope}).pipe(Effect.flip),
      ).toMatchObject({_tag: 'CodeGraphAdmissionError'});
    }).pipe(provideTestLayer(BunServices.layer)),
  );
});
