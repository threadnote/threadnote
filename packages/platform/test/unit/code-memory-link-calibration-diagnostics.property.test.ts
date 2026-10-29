import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {classifyCodeMemoryLinkCalibrationMutationV1} from '../../../../scripts/run-code-memory-link-calibration-client.js';
import {sha256HexSync} from '@threadnote/platform/sha256';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

const pathDigest = (path: string): string => sha256HexSync(`threadnote-code-memory-link-public-path-v1\0${path}`);

describe('Code Memory Link calibration diagnostics', () => {
  it('classifies only the privacy-safe mutation family regardless of artifact order', () => {
    fc.assert(
      fc.property(
        fc.boolean(),
        fc.boolean(),
        fc.boolean(),
        fc.nat(),
        (resultChanged, auditChanged, otherChanged, rotation) => {
          const initialFiles = [
            {path: 'policy.json', sha256: Effect.pipe('1', EffectString.repeat(64))},
            {path: 'result.json', sha256: Effect.pipe('2', EffectString.repeat(64))},
          ];
          const artifacts = [
            {
              contentSha256: otherChanged
                ? Effect.pipe('3', EffectString.repeat(64))
                : Effect.pipe('1', EffectString.repeat(64)),
              pathDigest: pathDigest('policy.json'),
            },
            {
              contentSha256: resultChanged
                ? Effect.pipe('4', EffectString.repeat(64))
                : Effect.pipe('2', EffectString.repeat(64)),
              pathDigest: pathDigest('result.json'),
            },
            ...(auditChanged
              ? [{contentSha256: Effect.pipe('5', EffectString.repeat(64)), pathDigest: pathDigest('audit.json')}]
              : []),
          ];
          const offset = rotation % artifacts.length;
          const finalArtifacts = [...artifacts.slice(offset), ...artifacts.slice(0, offset)];
          const expected = otherChanged
            ? 'other'
            : resultChanged && auditChanged
              ? 'result-and-audit'
              : resultChanged
                ? 'result-only'
                : auditChanged
                  ? 'audit-only'
                  : 'none';
          expect(classifyCodeMemoryLinkCalibrationMutationV1({finalArtifacts, initialFiles})).toBe(expected);
        },
      ),
      {numRuns: 80},
    );
  });
});
