import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {
  createCodeMemoryLinkInvocationAttestationV1,
  parseCodeMemoryLinkInvocationAttestationV1,
  projectCodeMemoryLinkRuntimeIdentityV1,
} from '@threadnote/threadnote/evaluation/code-memory-link-attestation';
import type {DevelopmentRuntimeEvidence} from '../../../../scripts/development-runtime.js';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

const EXECUTABLE_SHA256 = Effect.pipe('a', EffectString.repeat(64));
const SOURCE_COMMIT = Effect.pipe('b', EffectString.repeat(40));

describe('Code Memory Link runtime attestation', () => {
  it('projects arbitrary verified development evidence to the exact attested identity', () => {
    fc.assert(
      fc.property(fc.dictionary(fc.string({maxLength: 32}), fc.jsonValue()), additionalEvidence => {
        const runtime = {
          ...additionalEvidence,
          dependencyInstallation: 'bun install --frozen-lockfile',
          executableSha256: EXECUTABLE_SHA256,
          payloadBytes: 1,
          payloadFileCount: 1,
          payloadManifestSha256: Effect.pipe('c', EffectString.repeat(64)),
          releaseMetadataSha256: Effect.pipe('d', EffectString.repeat(64)),
          runtime: 'bun-1.3.14',
          sourceCommit: SOURCE_COMMIT,
          sourceLockfileSha256: Effect.pipe('e', EffectString.repeat(64)),
          sourcePackageManifestSha256: Effect.pipe('f', EffectString.repeat(64)),
          target: 'bun-darwin-arm64',
          version: `4.6.0-local.g${SOURCE_COMMIT}`,
        } satisfies DevelopmentRuntimeEvidence;

        const identity = {
          executableSha256: EXECUTABLE_SHA256,
          sourceCommit: SOURCE_COMMIT,
        };
        expect(projectCodeMemoryLinkRuntimeIdentityV1(runtime)).toEqual(identity);
        const verificationInput = {
          candidate: {buildIdentityHash: EXECUTABLE_SHA256, commit: SOURCE_COMMIT, dirty: false as const},
          harnessCommit: Effect.pipe('c', EffectString.repeat(40)),
          invocation: {kind: 'test'},
          outputProjection: {passed: true},
          summary: {passed: true},
        };
        const attestation = createCodeMemoryLinkInvocationAttestationV1({
          ...verificationInput,
          invocationNonce: `inv_${Effect.pipe('d', EffectString.repeat(16))}`,
          postRuntime: runtime,
          preRuntime: runtime,
        });
        expect(attestation).toMatchObject({postRuntime: identity, preRuntime: identity});
        expect(() =>
          parseCodeMemoryLinkInvocationAttestationV1(
            {...attestation, postRuntime: {...attestation.postRuntime, runtime: 'bun-1.3.14'}},
            verificationInput,
          ),
        ).toThrow(/post-run runtime has unsupported or missing fields/);
      }),
      {numRuns: 60},
    );
  });
});
