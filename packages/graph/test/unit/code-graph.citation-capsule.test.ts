import fc from 'fast-check';
import {describe, expect} from 'vitest';
import {
  createCodeGraphCitationEvidenceCapsule,
  parseCodeGraphCitationEvidenceCapsule,
  selectCodeGraphCitationCapsuleRetention,
} from '@threadnote/graph/citation/capsule';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {it as effectIt} from '@effect/vitest';
import {Effect, FileSystem, Path} from 'effect';
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
