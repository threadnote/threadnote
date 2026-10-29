import {Array as EffectArray, Option as EffectOption} from 'effect';
import {fcProp} from '@threadnote/testing/fast-check-property';
import {describe, expect, it} from '@effect/vitest';
import * as FC from 'fast-check';
import {
  CODE_GRAPH_CHECKPOINT_GIT_PATHSPEC_BYTES_MAXIMUM,
  CodeGraphCheckpointProjectionError,
  codeGraphCheckpointCoverage,
  codeGraphCheckpointGitPathBatches,
  parseGitTreeEntries,
} from '@threadnote/graph/checkpoint/projection';
import {CODE_GRAPH_INVENTORY_ADMISSION_POLICY_VERSION} from '@threadnote/graph/inventory/policy';
import {isSafeCodeGraphCheckpointPath} from '@threadnote/graph/checkpoint/schema';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

const safePathSegment = FC.string({
  maxLength: 64,
  minLength: 1,
  unit: FC.constantFrom(...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-'),
}).filter(segment => segment !== '.' && segment !== '..');

const safePath = FC.array(safePathSegment, {maxLength: 8, minLength: 1}).map(segments =>
  EffectArray.join(segments, '/'),
);

describe('code graph checkpoint projection', () => {
  fcProp(
    it,
    'rejects only control-bearing checkpoint paths within the bounded safe alphabet',
    {
      characters: FC.array(FC.constantFrom('a', 'Z', '0', '-', '_', '\u0000', '\t', '\n', '\u001f', '\u007f'), {
        maxLength: 128,
        minLength: 1,
      }),
    },
    ({characters}) => {
      const value = EffectArray.join(characters, '');
      const expectedSafe = EffectArray.every(characters, character => character > '\u001f' && character !== '\u007f');
      expect(isSafeCodeGraphCheckpointPath(value)).toBe(expectedSafe);
    },
    {fastCheck: {numRuns: 500}},
  );

  fcProp(
    it,
    'partitions Git pathspecs without loss, reordering, empty pages, or byte-budget overruns',
    {paths: FC.uniqueArray(safePath, {maxLength: 500})},
    ({paths}) => {
      const files = EffectArray.map(paths, (path, ordinal) => ({ordinal, path}));
      const batches = codeGraphCheckpointGitPathBatches(files);

      expect(batches.flat()).toEqual(files);
      expect(EffectArray.every(batches, batch => batch.length > 0)).toBe(true);
      for (const batch of batches) {
        expect(argvPathBytes(EffectArray.map(batch, file => file.path))).toBeLessThanOrEqual(
          CODE_GRAPH_CHECKPOINT_GIT_PATHSPEC_BYTES_MAXIMUM,
        );
      }
    },
    {fastCheck: {numRuns: 150}},
  );

  it('keeps the normal 1,000-file page within two bounded Git processes', () => {
    const files = Array.from({length: 1_000}, (_, index) => ({
      path: `packages/example/src/generated/module-${Effect.pipe(index.toString(), EffectString.padStart(4, '0'))}.ts`,
    }));
    const batches = codeGraphCheckpointGitPathBatches(files);

    expect(batches.length).toBeLessThanOrEqual(2);
    expect(batches.flat()).toEqual(files);
  });

  fcProp(
    it,
    'accounts for every skipped file while preserving unknown non-policy bytes explicitly',
    {
      eligibleFiles: FC.integer({max: 1_000_000, min: 0}),
      policyBytes: FC.integer({max: 1_000_000_000, min: 0}),
      policyFiles: FC.integer({max: 100_000, min: 0}),
      residualFiles: FC.integer({max: 100_000, min: 0}),
    },
    ({eligibleFiles, policyBytes, policyFiles, residualFiles}) => {
      const coverage = codeGraphCheckpointCoverage(eligibleFiles, {
        policyExclusions: {
          bytes: policyBytes,
          files: policyFiles,
          policyVersion: CODE_GRAPH_INVENTORY_ADMISSION_POLICY_VERSION,
          reasons: [{bytes: policyBytes, files: policyFiles, reason: 'svg'}],
        },
        skipped: policyFiles + residualFiles,
      });

      expect(coverage.eligibleFiles).toBe(eligibleFiles);
      expect(coverage.excludedFiles).toBe(policyFiles + residualFiles);
      expect(EffectArray.reduce(coverage.reasons, 0, (total, reason) => total + reason.files)).toBe(
        coverage.excludedFiles,
      );
      expect(coverage.state).toBe(coverage.excludedFiles === 0 ? 'complete' : 'partial');
      expect(
        EffectOption.getOrUndefined(
          EffectArray.findFirst(coverage.reasons, reason => reason.code === 'inventory-other'),
        )?.bytes ?? 0,
      ).toBe(0);
    },
    {fastCheck: {numRuns: 200}},
  );

  it('parses exact NUL-framed Git tree metadata for both object formats', () => {
    const sha1 = Effect.pipe('a', EffectString.repeat(40));
    const sha256 = Effect.pipe('b', EffectString.repeat(64));
    expect(
      parseGitTreeEntries(new TextEncoder().encode(`100644 blob ${sha1}      12\tsrc/a file.ts\0`), 'sha1'),
    ).toEqual(new Map([['src/a file.ts', {blobId: sha1, mode: '100644', path: 'src/a file.ts', size: 12}]]));
    expect(
      parseGitTreeEntries(new TextEncoder().encode(`100755 blob ${sha256}       7\tbin/tool\0`), 'sha256'),
    ).toEqual(new Map([['bin/tool', {blobId: sha256, mode: '100755', path: 'bin/tool', size: 7}]]));
  });

  it('rejects missing terminators, non-blobs, unsafe paths, and wrong object widths', () => {
    const cases = [
      `100644 blob ${Effect.pipe('a', EffectString.repeat(40))}       1\tsrc/a.ts`,
      `100644 tree ${Effect.pipe('a', EffectString.repeat(40))}       1\tsrc/a.ts\0`,
      `100644 blob ${Effect.pipe('a', EffectString.repeat(40))}       1\t../escape.ts\0`,
      `100644 blob ${Effect.pipe('a', EffectString.repeat(64))}       1\tsrc/a.ts\0`,
      `100644 blob ${Effect.pipe('a', EffectString.repeat(40))}     1e2\tsrc/a.ts\0`,
      `100644 blob ${Effect.pipe('a', EffectString.repeat(40))}      0x1\tsrc/a.ts\0`,
    ];
    for (const value of cases) {
      expect(() => parseGitTreeEntries(new TextEncoder().encode(value), 'sha1')).toThrow(
        CodeGraphCheckpointProjectionError,
      );
    }
  });

  fcProp(
    it,
    'preserves raw Unicode, quote and space characters in native Git tree paths',
    {
      names: FC.uniqueArray(
        FC.array(FC.constantFrom('a', 'Z', '文', 'é', ' ', '"', "'"), {minLength: 1, maxLength: 20}).map(
          chars => `src/${EffectArray.join(chars, '')}.ts`,
        ),
        {minLength: 1, maxLength: 20},
      ),
      size: FC.integer({min: 0, max: 1_000_000}),
    },
    ({names, size}) => {
      const blobId = Effect.pipe('a', EffectString.repeat(40));
      const bytes = new TextEncoder().encode(
        EffectArray.join(
          EffectArray.map(
            names,
            name => `100644 blob ${blobId} ${Effect.pipe(String(size), EffectString.padStart(7))}\t${name}\0`,
          ),
          '',
        ),
      );
      const before = bytes.slice();
      const entries = parseGitTreeEntries(bytes, 'sha1');
      expect([...entries]).toEqual(EffectArray.map(names, path => [path, {blobId, mode: '100644', path, size}]));
      expect(parseGitTreeEntries(bytes, 'sha1')).toEqual(entries);
      expect(bytes).toEqual(before);
    },
    {fastCheck: {numRuns: 50}},
  );
});

function argvPathBytes(paths: readonly string[]): number {
  const encoder = new TextEncoder();
  return EffectArray.reduce(paths, 0, (total, path) => total + encoder.encode(path).byteLength + 1);
}
