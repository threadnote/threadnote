import {Array as EffectArray} from 'effect';
import {TestSystemInfoLayer} from '../helpers/system-layer.js';
import * as BunServices from '@effect/platform-bun/BunServices';
import {it as effectIt} from '@effect/vitest';
import {Effect, FileSystem, Layer, Path} from 'effect';
import fc from 'fast-check';
import {describe, expect} from 'vitest';
import {collectActivationImportPreview} from '@threadnote/threadnote/activation/imports';
import {readBoundedContainedStableRegularFile} from '@threadnote/graph/inventory/contained_file';

import {provideTestLayer} from '../helpers/effect-layer.js';
import {fcEffectProp} from '@threadnote/testing/fast-check-property';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

describe('guided activation imports', () => {
  effectIt.effect('collects selected catalog guidance and ADRs as deterministic review candidates', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture();
        yield* fixture.fs.writeFileString(fixture.path.join(fixture.root, 'AGENTS.md'), 'Retain exact evidence.\n');
        yield* fixture.fs.makeDirectory(fixture.path.join(fixture.root, 'docs/adr'), {recursive: true});
        yield* fixture.fs.writeFileString(
          fixture.path.join(fixture.root, 'docs/adr/0001-evidence.md'),
          'Retain exact evidence.\n',
        );

        const preview = yield* collectActivationImportPreview({
          adrPaths: ['docs/adr/0001-evidence.md'],
          repositoryRoot: fixture.root,
          surfaceIds: ['codex-cli', 'amp-cli'],
        });

        expect(preview).toMatchObject({mode: 'preview', version: 1});
        expect(preview.sourceSetHash).toMatch(/^[a-f0-9]{64}$/u);
        expect(preview.sources).toHaveLength(2);
        expect(preview.candidates).toEqual([
          expect.objectContaining({
            contentHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
            proposedText: 'Retain exact evidence.',
            sourceIds: EffectArray.map(preview.sources, source => source.sourceId),
          }),
        ]);
        expect(preview.sources).toEqual([
          expect.objectContaining({
            kinds: ['guidance'],
            relativePath: 'AGENTS.md',
            surfaceIds: ['amp-cli', 'codex-cli'],
          }),
          expect.objectContaining({
            kinds: ['adr'],
            relativePath: 'docs/adr/0001-evidence.md',
            surfaceIds: [],
          }),
        ]);
        expect((yield* fixture.fs.readDirectory(fixture.root)).sort()).toEqual(['AGENTS.md', 'docs']);
      }),
    ).pipe(provideTestLayer(stableReadLayer)),
  );

  fcEffectProp(
    effectIt,
    'is invariant to selected surface and ADR ordering',
    {reverseAdrs: fc.boolean(), reverseSurfaces: fc.boolean()},
    ({reverseAdrs, reverseSurfaces}) =>
      Effect.scoped(
        Effect.gen(function* () {
          const fixture = yield* makeFixture();
          yield* fixture.fs.writeFileString(fixture.path.join(fixture.root, 'AGENTS.md'), 'Shared guidance.\n');
          yield* fixture.fs.makeDirectory(fixture.path.join(fixture.root, 'docs/adr'), {recursive: true});
          yield* fixture.fs.writeFileString(fixture.path.join(fixture.root, 'docs/adr/0001.md'), 'First decision.\n');
          yield* fixture.fs.writeFileString(fixture.path.join(fixture.root, 'docs/adr/0002.md'), 'Second decision.\n');
          const expected = yield* collectActivationImportPreview({
            adrPaths: ['docs/adr/0001.md', 'docs/adr/0002.md'],
            repositoryRoot: fixture.root,
            surfaceIds: ['amp-cli', 'codex-cli'],
          });
          const actual = yield* collectActivationImportPreview({
            adrPaths: reverseAdrs ? ['docs/adr/0002.md', 'docs/adr/0001.md'] : ['docs/adr/0001.md', 'docs/adr/0002.md'],
            repositoryRoot: fixture.root,
            surfaceIds: reverseSurfaces ? ['codex-cli', 'amp-cli'] : ['amp-cli', 'codex-cli'],
          });
          expect(actual).toEqual(expected);
        }),
      ).pipe(provideTestLayer(stableReadLayer)),
    {fastCheck: {numRuns: 20}},
  );

  effectIt.effect('rejects ambiguous selectors and non-canonical ADR paths', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture();
        yield* fixture.fs.writeFileString(fixture.path.join(fixture.root, 'AGENTS.md'), 'Rules.\n');
        for (const input of [
          {adrPaths: ['../outside.md'], surfaceIds: ['codex-cli']},
          {adrPaths: ['./ADR.md'], surfaceIds: ['codex-cli']},
          {adrPaths: ['ADR.md', 'ADR.md'], surfaceIds: ['codex-cli']},
          {adrPaths: [], surfaceIds: ['codex-cli', 'codex']},
        ]) {
          const failure = yield* collectActivationImportPreview({...input, repositoryRoot: fixture.root}).pipe(
            Effect.flip,
          );
          expect(failure).toMatchObject({message: expect.any(String)});
        }
      }),
    ).pipe(provideTestLayer(stableReadLayer)),
  );

  effectIt.effect('keeps ADR imports for managed MCP surfaces without project guidance', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture();
        yield* fixture.fs.writeFileString(fixture.path.join(fixture.root, 'AGENTS.md'), 'User-level guidance.\n');
        yield* fixture.fs.writeFileString(fixture.path.join(fixture.root, 'decision.md'), 'Portable decision.\n');
        const preview = yield* collectActivationImportPreview({
          adrPaths: ['decision.md'],
          repositoryRoot: fixture.root,
          surfaceIds: ['junie-cli'],
        });
        expect(preview.sources).toEqual([
          expect.objectContaining({kinds: ['adr'], relativePath: 'decision.md', surfaceIds: []}),
        ]);
        expect(preview.candidates).toEqual([expect.objectContaining({proposedText: 'Portable decision.'})]);
      }),
    ).pipe(provideTestLayer(stableReadLayer)),
  );

  effectIt.effect('rejects symlinked, binary, and oversized ADR inputs', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture();
        const outside = fixture.path.join(fixture.outerRoot, 'outside.md');
        yield* fixture.fs.writeFileString(outside, 'Outside.\n');
        yield* fixture.fs.symlink(outside, fixture.path.join(fixture.root, 'linked.md'));
        yield* fixture.fs.writeFile(fixture.path.join(fixture.root, 'binary.md'), new Uint8Array([0xff, 0xfe]));
        yield* fixture.fs.writeFileString(fixture.path.join(fixture.root, 'nul.md'), 'before\u0000after');
        yield* fixture.fs.writeFileString(
          fixture.path.join(fixture.root, 'large.md'),
          Effect2.pipe('x', EffectString.repeat(60 * 1024 + 1)),
        );

        for (const [path, message] of [
          ['linked.md', 'safely read'],
          ['binary.md', 'strict UTF-8'],
          ['nul.md', 'NUL-free'],
          ['large.md', 'safely read'],
        ] as const) {
          const failure = yield* collectActivationImportPreview({
            adrPaths: [path],
            repositoryRoot: fixture.root,
            surfaceIds: [],
          }).pipe(Effect.flip);
          expect(failure).toMatchObject({message: expect.stringContaining(message)});
        }
      }),
    ).pipe(provideTestLayer(stableReadLayer)),
  );

  effectIt.effect('rejects binary catalog guidance before emitting a candidate', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture();
        yield* fixture.fs.writeFile(fixture.path.join(fixture.root, 'AGENTS.md'), new Uint8Array([0xff, 0xfe]));
        const failure = yield* collectActivationImportPreview({
          adrPaths: [],
          repositoryRoot: fixture.root,
          surfaceIds: ['codex-cli'],
        }).pipe(Effect.flip);
        expect(failure).toMatchObject({message: expect.stringContaining('strict UTF-8')});
      }),
    ).pipe(provideTestLayer(stableReadLayer)),
  );

  effectIt.effect('rejects a target swapped to an external symlink between validation and open', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture();
        const relative = 'decision.md';
        const target = fixture.path.join(fixture.root, relative);
        const displaced = fixture.path.join(fixture.root, 'decision.original.md');
        const outside = fixture.path.join(fixture.outerRoot, 'outside.md');
        yield* fixture.fs.writeFileString(target, 'Original.\n');
        yield* fixture.fs.writeFileString(outside, 'External secret.\n');
        const failure = yield* readBoundedContainedStableRegularFile(
          fixture.fs,
          fixture.path,
          fixture.root,
          relative,
          1_024,
          {
            afterOpen: fixture.fs
              .remove(target)
              .pipe(Effect.andThen(fixture.fs.rename(displaced, target)), Effect.orDie),
            beforeOpen: fixture.fs
              .rename(target, displaced)
              .pipe(Effect.andThen(fixture.fs.symlink(outside, target)), Effect.orDie),
          },
        ).pipe(Effect.flip);
        expect(String(failure)).toContain('Could not safely read');
        expect(yield* fixture.fs.readFileString(target)).toBe('Original.\n');
      }),
    ).pipe(provideTestLayer(stableReadLayer)),
  );

  effectIt.effect('rejects an ancestor swapped to an external directory between validation and open', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture();
        const relative = 'docs/decision.md';
        const directory = fixture.path.join(fixture.root, 'docs');
        const displaced = fixture.path.join(fixture.root, 'docs-original');
        const outside = fixture.path.join(fixture.outerRoot, 'outside-docs');
        yield* fixture.fs.makeDirectory(directory, {recursive: true});
        yield* fixture.fs.makeDirectory(outside, {recursive: true});
        yield* fixture.fs.writeFileString(fixture.path.join(directory, 'decision.md'), 'Original.\n');
        yield* fixture.fs.writeFileString(fixture.path.join(outside, 'decision.md'), 'External secret.\n');
        const failure = yield* readBoundedContainedStableRegularFile(
          fixture.fs,
          fixture.path,
          fixture.root,
          relative,
          1_024,
          {
            afterOpen: fixture.fs
              .remove(directory)
              .pipe(Effect.andThen(fixture.fs.rename(displaced, directory)), Effect.orDie),
            beforeOpen: fixture.fs
              .rename(directory, displaced)
              .pipe(Effect.andThen(fixture.fs.symlink(outside, directory)), Effect.orDie),
          },
        ).pipe(Effect.flip);
        expect(String(failure)).toContain('Could not safely read');
        expect(yield* fixture.fs.readFileString(fixture.path.join(directory, 'decision.md'))).toBe('Original.\n');
      }),
    ).pipe(provideTestLayer(stableReadLayer)),
  );

  effectIt.effect('rejects an in-place mutation after opening the selected source', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture();
        const relative = 'decision.md';
        const target = fixture.path.join(fixture.root, relative);
        yield* fixture.fs.writeFileString(target, 'Original.\n');
        const failure = yield* readBoundedContainedStableRegularFile(
          fixture.fs,
          fixture.path,
          fixture.root,
          relative,
          1_024,
          {afterOpen: fixture.fs.writeFileString(target, 'Mutated after open.\n').pipe(Effect.orDie)},
        ).pipe(Effect.flip);
        expect(String(failure)).toContain('Could not safely read');
      }),
    ).pipe(provideTestLayer(stableReadLayer)),
  );
});

const stableReadLayer = Layer.merge(BunServices.layer, TestSystemInfoLayer);

const makeFixture = Effect.fn('test.activationImports.fixture')(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const outerRoot = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-activation-imports-'});
  const selectedRoot = path.join(outerRoot, 'repository');
  yield* fs.makeDirectory(selectedRoot, {recursive: true});
  const root = yield* fs.realPath(selectedRoot);
  return {fs, outerRoot, path, root};
});
