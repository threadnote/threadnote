import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {sha256HexSync as portableSha256HexSync} from '@threadnote/platform/sha256';
import {
  decodeNativeWorkflowState,
  nativeWorkflowIntentDigest,
  type NativeWorkflowState,
} from '@threadnote/workflow-automations/native';
import type {WorkflowWriteIntent} from '@threadnote/workflow-automations/contracts';
import {sha256HexSync} from '../../src/workflow_memory/native_digest.js';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

const bindingHash = Effect.pipe('a', EffectString.repeat(64));
const workflowState: NativeWorkflowState = {
  format: 'threadnote-native-workflow',
  stateVersion: 1,
  executorVersion: 1,
  runId: 'run-1',
  project: 'repo',
  featureId: 'feature-1',
  generation: 'generation-1',
  profile: 'desktop',
  bindingId: bindingHash,
  operations: [],
};

function intent(overrides: Partial<WorkflowWriteIntent> = {}): WorkflowWriteIntent {
  return {
    bindingId: bindingHash,
    operationId: 'write-1',
    artifactKey: 'plan-root',
    sourceRunId: 'run-1',
    role: 'root',
    body: 'Plan body.\n',
    expectedRevision: null,
    ...overrides,
  };
}

function errorCode(error: unknown): unknown {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  return error.code;
}

function outcome(input: unknown, hash: (value: string) => string): unknown {
  try {
    return {accepted: true, value: decodeNativeWorkflowState(input, hash)};
  } catch (error) {
    return {accepted: false, code: errorCode(error)};
  }
}

describe('native SHA-256 adapter', () => {
  it('matches independent known vectors for strings and raw bytes', () => {
    expect(sha256HexSync('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256HexSync('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(sha256HexSync(new Uint8Array([0x61, 0x62, 0x63]))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    const unicode = 'Snow ☃ — 雪 🌊';
    const unicodeBytes = new TextEncoder().encode(unicode);
    expect(sha256HexSync(unicode)).toBe('38d57f0252f9b87c02d1d428f28a5435c09c6d2e14e583d964fb32ceac19ec5b');
    expect(sha256HexSync(unicodeBytes)).toBe('38d57f0252f9b87c02d1d428f28a5435c09c6d2e14e583d964fb32ceac19ec5b');
  });

  it('remains bit-identical to the portable implementation across bounded text and byte inputs', () => {
    fc.assert(
      fc.property(fc.oneof(fc.string({maxLength: 2_048}), fc.uint8Array({maxLength: 4_096})), input => {
        expect(sha256HexSync(input)).toBe(portableSha256HexSync(input));
      }),
      {numRuns: 80},
    );
  });

  it('keeps Unicode and optional-field intent digests identical across portable and native hash backends', () => {
    fc.assert(
      fc.property(
        fc.string({maxLength: 48}),
        fc.boolean(),
        fc.boolean(),
        fc.boolean(),
        fc.integer({min: 1, max: 9999}),
        (generated, includeLocation, includeRelations, includeEvidence, suffix) => {
          const referenceUri = `threadnote://memory/tn_${Effect.pipe(String(suffix), EffectString.padStart(10, '0'))}`;
          const writeIntent = intent({
            operationId: `write-${suffix}`,
            body: `${generated} — 日本語 🧭 ${suffix}\n`,
            ...(includeLocation
              ? {
                  uri: referenceUri,
                  storageKind: 'durable' as const,
                  codeRefs: ['src/雪.ts'],
                }
              : {}),
            ...(includeRelations ? {relations: [{type: 'references', uri: referenceUri}]} : {}),
            ...(includeEvidence
              ? {
                  evidenceRefs: [
                    {
                      uri: referenceUri,
                      memoryId: `tn_${Effect.pipe(String(suffix), EffectString.padStart(10, '0'))}`,
                      revision: bindingHash,
                    },
                  ],
                }
              : {}),
          });

          expect(nativeWorkflowIntentDigest(writeIntent, sha256HexSync)).toBe(
            nativeWorkflowIntentDigest(writeIntent, portableSha256HexSync),
          );
        },
      ),
      {numRuns: 80},
    );
  });

  it('validates prepared and verified history identically and rejects tampering or invalid status artifacts', () => {
    const preparedIntent = intent();
    const prepared = {
      status: 'prepared' as const,
      intent: preparedIntent,
      intentDigest: nativeWorkflowIntentDigest(preparedIntent, portableSha256HexSync),
    };
    const verifiedIntent = intent({
      operationId: 'write-2',
      artifactKey: 'plan-summary',
    });
    const artifact = {
      uri: 'threadnote://user/tester/memories/durable/projects/repo/plan-summary.md',
      memoryId: 'tn_1234567890',
      revision: bindingHash,
      body: verifiedIntent.body,
      storageKind: 'durable' as const,
      state: 'active' as const,
    };
    const verified = {
      status: 'verified' as const,
      intent: verifiedIntent,
      intentDigest: nativeWorkflowIntentDigest(verifiedIntent, portableSha256HexSync),
      artifact,
    };
    const validState = {...workflowState, operations: [prepared, verified]};

    expect(decodeNativeWorkflowState(validState, sha256HexSync)).toEqual(
      decodeNativeWorkflowState(validState, portableSha256HexSync),
    );

    const tamperedHistory = {
      ...workflowState,
      operations: [
        {
          ...prepared,
          intent: {...preparedIntent, body: 'Changed after preparation.'},
        },
      ],
    };
    const unknownField = {...validState, unexpected: true};
    const preparedWithArtifact = {
      ...workflowState,
      operations: [{...prepared, artifact}],
    };
    const verifiedWithoutArtifact = {
      ...workflowState,
      operations: [{...verified, artifact: undefined}],
    };

    for (const invalidState of [tamperedHistory, unknownField, preparedWithArtifact, verifiedWithoutArtifact]) {
      const nativeResult = outcome(invalidState, sha256HexSync);
      const portableResult = outcome(invalidState, portableSha256HexSync);
      expect(nativeResult).toEqual(portableResult);
      expect(nativeResult).toMatchObject({
        accepted: false,
        code: 'invalid-state',
      });
    }
  });
});
