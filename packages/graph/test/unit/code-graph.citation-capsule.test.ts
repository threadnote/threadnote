import fc from 'fast-check';
import {describe, expect} from 'vitest';
import {
  CODE_GRAPH_CITATION_CAPSULE_RETENTION,
  createCodeGraphCitationEvidenceCapsule,
  parseCodeGraphCitationEvidenceCapsule,
  selectCodeGraphCitationCapsuleRetention,
} from '@threadnote/graph/citation/capsule';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {it as effectIt} from '@effect/vitest';
import {DateTime, Effect, FileSystem, Path, Schema} from 'effect';
import {TestClock} from 'effect/testing';
import {
  readRetainedCodeGraphCitationEvidence,
  retainCodeGraphCitationEvidence,
} from '@threadnote/graph/citation/capsule';
import {citationPlatformLayer} from '../helpers/citation-platform.js';

const bytes = new TextEncoder().encode('export const original = true;\n');
const source = {
  extractorSet: 'test',
  fileContentHash: sha256HexSync(bytes),
  path: 'src/source.ts',
  repositoryId: 'a'.repeat(64),
  sourceCommit: 'b'.repeat(40),
  sourceDirty: false,
  sourceSnapshotId: `cgsn_${'c'.repeat(40)}`,
};

describe('bounded historical citation capsules', () => {
  effectIt.layer(citationPlatformLayer)(it => {
    it.effect('admits a new fixed reservation beside expired physical history without renewing or retiring it', () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'expired-neighbor-capsule-'});
        const checkoutId = 'e'.repeat(64);
        const directory = path.join(
          home,
          'indexes/code-graph/repositories',
          checkoutId,
          'local-context/citation-evidence',
        );
        const expiredSource = {...source, path: 'src/expired.ts'};
        const oldTime = DateTime.formatIso(yield* DateTime.now);
        const old = createCodeGraphCitationEvidenceCapsule(expiredSource, 'sha1', bytes, oldTime, ['d'.repeat(64)])!;
        yield* fs.makeDirectory(directory, {recursive: true});
        const oldFile = path.join(directory, `${old.id}.json`);
        const oldBytes = JSON.stringify(old) + '\n';
        yield* fs.writeFileString(oldFile, oldBytes);
        yield* fs.utimes(oldFile, 0, 0);
        yield* TestClock.adjust('91 days');
        const input = {
          bytes,
          checkoutId,
          objectFormat: 'sha1' as const,
          referenceId: 'f'.repeat(64),
          source,
          threadnoteHome: home,
          retainedAt: DateTime.formatIso(yield* DateTime.now),
        };
        expect(yield* retainCodeGraphCitationEvidence(input)).toBe(true);
        expect(yield* fs.readDirectory(directory)).toHaveLength(2);
        expect(yield* fs.readFileString(oldFile)).toBe(oldBytes);
        expect(yield* retainCodeGraphCitationEvidence({...input, source: expiredSource})).toBe(false);
        expect(yield* fs.readFileString(oldFile)).toBe(oldBytes);
        expect(yield* fs.readDirectory(directory)).toHaveLength(2);
      }),
    );
    it.effect('counts expired and corrupt physical bytes against reserved capacity without deleting them', () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'reserved-byte-capacity-'});
        const checkoutId = 'e'.repeat(64);
        const directory = path.join(
          home,
          'indexes/code-graph/repositories',
          checkoutId,
          'local-context/citation-evidence',
        );
        yield* fs.makeDirectory(directory, {recursive: true});
        const file = path.join(directory, `${'0'.repeat(64)}.json`);
        const physicalBytes = ' '.repeat(CODE_GRAPH_CITATION_CAPSULE_RETENTION.maximumBytes);
        yield* fs.writeFileString(file, physicalBytes);
        yield* fs.utimes(file, 0, 0);
        yield* TestClock.adjust('91 days');
        const retained = yield* retainCodeGraphCitationEvidence({
          bytes,
          checkoutId,
          objectFormat: 'sha1',
          referenceId: 'f'.repeat(64),
          source,
          threadnoteHome: home,
          retainedAt: DateTime.formatIso(yield* DateTime.now),
        });
        expect(retained).toBe(false);
        expect(yield* fs.readDirectory(directory)).toEqual([`${'0'.repeat(64)}.json`]);
        expect(yield* fs.readFileString(file)).toBe(physicalBytes);
      }),
    );
    it.effect('refuses reserved capture at capacity without retiring possibly referenced historical capsules', () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'reserved-capacity-capsule-'});
        const checkoutId = 'e'.repeat(64);
        const directory = path.join(
          home,
          'indexes/code-graph/repositories',
          checkoutId,
          'local-context/citation-evidence',
        );
        yield* fs.makeDirectory(directory, {recursive: true});
        const originalTime = DateTime.formatIso(yield* DateTime.now);
        const originals = new Map<string, string>();
        for (let ordinal = 0; ordinal < 256; ordinal++) {
          const original = createCodeGraphCitationEvidenceCapsule(
            {...source, path: `src/retained-${ordinal}.ts`},
            'sha1',
            bytes,
            originalTime,
            ['d'.repeat(64)],
          )!;
          const name = `${original.id}.json`;
          const content = JSON.stringify(original) + '\n';
          originals.set(name, content);
          yield* fs.writeFileString(path.join(directory, name), content, {mode: 0o600});
          yield* fs.utimes(path.join(directory, name), 0, 0);
        }
        yield* TestClock.adjust('1 day');
        const input = {
          bytes,
          checkoutId,
          objectFormat: 'sha1' as const,
          referenceId: 'f'.repeat(64),
          source,
          threadnoteHome: home,
          retainedAt: DateTime.formatIso(yield* DateTime.now),
        };
        for (let retry = 0; retry < 2; retry++) {
          const retained = yield* retainCodeGraphCitationEvidence(input);
          const names = yield* fs.readDirectory(directory);
          const current = new Set(names);
          expect({
            retained,
            retired: [...originals.keys()].filter(name => !current.has(name)),
            added: names.filter(name => !originals.has(name)).length,
          }).toEqual({retained: false, retired: [], added: 0});
          for (const [name, content] of originals)
            expect(yield* fs.readFileString(path.join(directory, name))).toBe(content);
          yield* TestClock.adjust('1 day');
        }
      }),
    );
    it.effect('preserves an earlier retained origin time when a new fixed reference shares its exact capsule', () =>
      Effect.gen(function* () {
        const home = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped({prefix: 'fixed-origin-capsule-'});
        const checkoutId = 'e'.repeat(64);
        const retainedAt = DateTime.formatIso(yield* DateTime.now);
        const first = {
          bytes,
          checkoutId,
          objectFormat: 'sha1' as const,
          referenceId: 'd'.repeat(64),
          source,
          threadnoteHome: home,
          retainedAt,
        };
        expect(yield* retainCodeGraphCitationEvidence(first)).toBe(true);
        yield* TestClock.adjust('2 days');
        const approved = {...first, referenceId: 'f'.repeat(64), retainedAt: DateTime.formatIso(yield* DateTime.now)};
        expect(yield* retainCodeGraphCitationEvidence(approved)).toBe(true);
        const result = yield* readRetainedCodeGraphCitationEvidence(home, checkoutId, source);
        expect(result?.capsule.retainedAt).toBe(retainedAt);
        expect(result?.capsule.referenceIds).toEqual(['d'.repeat(64), 'f'.repeat(64)]);
        expect(result?.bytes).toEqual(bytes);
        yield* TestClock.adjust('2 days');
        expect(yield* retainCodeGraphCitationEvidence(approved)).toBe(true);
        expect((yield* readRetainedCodeGraphCitationEvidence(home, checkoutId, source))?.capsule).toEqual(
          result?.capsule,
        );
      }),
    );
    it.effect(
      'does not renew a fixed reservation on delayed retry, rejects corruption and expires without mutation',
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const home = yield* fs.makeTempDirectoryScoped({prefix: 'fixed-capsule-'});
          const checkoutId = 'e'.repeat(64);
          const retainedAt = DateTime.formatIso(yield* DateTime.now);
          const input = {
            bytes,
            checkoutId,
            objectFormat: 'sha1' as const,
            referenceId: 'd'.repeat(64),
            source,
            threadnoteHome: home,
            retainedAt,
          };
          expect(yield* retainCodeGraphCitationEvidence(input)).toBe(true);
          const capsule = createCodeGraphCitationEvidenceCapsule(source, 'sha1', bytes, retainedAt, [])!;
          const file = path.join(
            home,
            'indexes/code-graph/repositories',
            checkoutId,
            'local-context/citation-evidence',
            `${capsule.id}.json`,
          );
          const before = yield* fs.readFileString(file);
          yield* TestClock.adjust('2 days');
          expect(yield* retainCodeGraphCitationEvidence(input)).toBe(true);
          expect(yield* fs.readFileString(file)).toBe(before);
          yield* fs.writeFileString(file, '{}');
          expect(yield* retainCodeGraphCitationEvidence(input)).toBe(false);
          expect(yield* fs.readFileString(file)).toBe('{}');
          yield* fs.writeFileString(file, before);
          yield* TestClock.adjust('90 days');
          expect(yield* retainCodeGraphCitationEvidence(input)).toBe(false);
          expect(yield* fs.readFileString(file)).toBe(before);
          expect(yield* readRetainedCodeGraphCitationEvidence(home, checkoutId, source)).toBeUndefined();
        }),
    );
    it.effect.prop(
      'fixed capture retries preserve capsule bytes and count for bounded delayed schedules',
      {
        delays: Schema.Array(Schema.Int.check(Schema.isBetween({minimum: 1, maximum: 5}))).check(
          Schema.isMinLength(1),
          Schema.isMaxLength(3),
        ),
      },
      ({delays}) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const home = yield* fs.makeTempDirectoryScoped({prefix: 'fixed-capsule-property-'});
          const checkoutId = 'e'.repeat(64);
          const retainedAt = DateTime.formatIso(yield* DateTime.now);
          const input = {
            bytes,
            checkoutId,
            objectFormat: 'sha1' as const,
            referenceId: 'd'.repeat(64),
            source,
            threadnoteHome: home,
            retainedAt,
          };
          expect(yield* retainCodeGraphCitationEvidence(input)).toBe(true);
          const capsule = createCodeGraphCitationEvidenceCapsule(source, 'sha1', bytes, retainedAt, [])!;
          const directory = path.join(
            home,
            'indexes/code-graph/repositories',
            checkoutId,
            'local-context/citation-evidence',
          );
          const file = path.join(directory, `${capsule.id}.json`);
          const before = yield* fs.readFileString(file);
          for (const days of delays) {
            yield* TestClock.adjust(`${days} days`);
            expect(yield* retainCodeGraphCitationEvidence(input)).toBe(true);
            expect(yield* fs.readFileString(file)).toBe(before);
            expect(yield* fs.readDirectory(directory)).toEqual([`${capsule.id}.json`]);
          }
        }),
      {arbitrary: {runs: 8}},
    );
    it.effect('survives source removal and rejects tampered or oversized evidence without graph pins', () =>
      TestClock.withLive(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-citation-capsule-'});
          const checkoutId = 'e'.repeat(64);
          const retained = yield* retainCodeGraphCitationEvidence({
            bytes,
            checkoutId,
            objectFormat: 'sha1',
            referenceId: 'd'.repeat(64),
            source,
            threadnoteHome: home,
          });
          expect(retained).toBe(true);
          expect((yield* readRetainedCodeGraphCitationEvidence(home, checkoutId, source))?.bytes).toEqual(bytes);
          const capsule = createCodeGraphCitationEvidenceCapsule(
            source,
            'sha1',
            bytes,
            '2026-10-03T00:00:00.000Z',
            [],
          )!;
          const file = path.join(
            home,
            'indexes',
            'code-graph',
            'repositories',
            checkoutId,
            'local-context',
            'citation-evidence',
            `${capsule.id}.json`,
          );
          yield* fs.writeFileString(file, '{}');
          expect(yield* readRetainedCodeGraphCitationEvidence(home, checkoutId, source)).toBeUndefined();
          expect(
            yield* retainCodeGraphCitationEvidence({
              bytes: new Uint8Array(256 * 1_024 + 1),
              checkoutId,
              objectFormat: 'sha1',
              referenceId: 'd'.repeat(64),
              source,
              threadnoteHome: home,
            }),
          ).toBe(false);
        }),
      ),
    );

    it('preserves exact original source provenance and rejects changed bytes or metadata', () => {
      const capsule = createCodeGraphCitationEvidenceCapsule(source, 'sha1', bytes, '2026-10-03T00:00:00.000Z', [
        'd'.repeat(64),
      ]);
      expect(capsule).toBeDefined();
      const parsed = parseCodeGraphCitationEvidenceCapsule(JSON.stringify(capsule), source);
      expect(parsed?.bytes).toEqual(bytes);
      expect(parsed?.capsule.source).toEqual(source);
      expect(
        parseCodeGraphCitationEvidenceCapsule(
          JSON.stringify({...capsule, payload: Buffer.from('changed').toString('base64')}),
          source,
        ),
      ).toBeUndefined();
      expect(
        parseCodeGraphCitationEvidenceCapsule(JSON.stringify(capsule), {...source, repositoryId: 'f'.repeat(64)}),
      ).toBeUndefined();
      expect(
        createCodeGraphCitationEvidenceCapsule(
          source,
          'sha1',
          new TextEncoder().encode('changed'),
          '2026-10-03T00:00:00.000Z',
          [],
        ),
      ).toBeUndefined();
    });

    it('is deterministic, bounded by bytes/count/age, and converges under repeated retention', () => {
      fc.assert(
        fc.property(
          fc.array(
            fc.record({id: fc.uuid(), bytes: fc.integer({min: 1, max: 1_000}), age: fc.integer({min: 0, max: 200})}),
            {maxLength: 100},
          ),
          values => {
            const now = Date.parse('2026-10-03T00:00:00.000Z');
            const entries = values.map(value => ({
              id: value.id,
              bytes: value.bytes,
              retainedAt: new Date(now - value.age * 86_400_000).toISOString(),
            }));
            const limits = {maximumBytes: 4_000, maximumCount: 8, maximumAgeMilliseconds: 90 * 86_400_000};
            const selected = selectCodeGraphCitationCapsuleRetention(entries, now, limits);
            expect(selectCodeGraphCitationCapsuleRetention([...entries].reverse(), now, limits)).toEqual(selected);
            expect(selected.retain.length).toBeLessThanOrEqual(8);
            expect(selected.retain.reduce((total, value) => total + value.bytes, 0)).toBeLessThanOrEqual(4_000);
            expect(
              selected.retain.every(value => now - Date.parse(value.retainedAt) <= limits.maximumAgeMilliseconds),
            ).toBe(true);
            expect(selectCodeGraphCitationCapsuleRetention(selected.retain, now, limits).retire).toEqual([]);
            expect([...selected.retain, ...selected.retire].map(value => value.id).sort()).toEqual(
              entries.map(value => value.id).sort(),
            );
          },
        ),
        {numRuns: 100},
      );
    });
  });
});
