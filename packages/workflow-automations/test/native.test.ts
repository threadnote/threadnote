import {describe, expect, it} from 'vitest';
import fc from 'fast-check';
import {nativeWorkflowIntentDigest, decodeNativeWorkflowRequest, decodeNativeWorkflowState} from '../src/native.js';
import type {NativeWorkflowState} from '../src/native.js';
import type {WorkflowWriteIntent} from '../src/contracts.js';

const hash = 'a'.repeat(64);
const stateBase: NativeWorkflowState = {
  format: 'threadnote-native-workflow',
  stateVersion: 1,
  executorVersion: 1,
  runId: 'run-1',
  project: 'repo',
  featureId: 'feature-1',
  generation: 'generation-1',
  profile: 'desktop',
  bindingId: hash,
  operations: [],
};

function intent(overrides: Partial<WorkflowWriteIntent> = {}): WorkflowWriteIntent {
  return {
    bindingId: hash,
    operationId: 'write-1',
    artifactKey: 'plan-root',
    sourceRunId: 'run-1',
    role: 'root',
    body: 'Plan body.\n',
    expectedRevision: null,
    ...overrides,
  };
}

const validWriteRequest = (overrides: Record<string, unknown> = {}) => ({
  protocolVersion: 1,
  executorVersion: 1,
  action: 'write',
  runId: 'run-1',
  generation: 'generation-1',
  operationId: 'write-1',
  artifactKey: 'plan-root',
  role: 'root',
  body: 'café 🧭',
  expectedRevision: null,
  uri: 'threadnote://user/tester/memories/durable/projects/repo/plan.md',
  storageKind: 'durable',
  codeRefs: ['src/index.ts'],
  relations: [{type: 'references', uri: 'threadnote://memory/tn_1234567890'}],
  evidenceRefs: [
    {
      uri: 'threadnote://user/tester/memories/durable/projects/repo/prior.md',
      memoryId: 'tn_1234567890',
      revision: hash,
    },
  ],
  ...overrides,
});

const caught = (run: () => unknown): unknown => {
  try {
    run();
    return undefined;
  } catch (error) {
    return error;
  }
};

describe('native workflow request protocol', () => {
  it('decodes strict versioned capability, init, and bound requests', () => {
    expect(decodeNativeWorkflowRequest({protocolVersion: 1, executorVersion: 1, action: 'capabilities'})).toMatchObject(
      {
        action: 'capabilities',
      },
    );
    expect(
      decodeNativeWorkflowRequest({
        protocolVersion: 1,
        executorVersion: 1,
        action: 'init',
        runId: 'run-1',
        project: 'repo',
        featureId: 'feature-1',
        generation: 'generation-1',
        profile: 'desktop',
      }),
    ).toMatchObject({action: 'init', profile: 'desktop'});
    expect(decodeNativeWorkflowRequest(validWriteRequest())).toMatchObject({action: 'write', body: 'café 🧭'});
    expect(
      decodeNativeWorkflowRequest({
        protocolVersion: 1,
        executorVersion: 1,
        action: 'read',
        runId: 'run-1',
        generation: 'generation-1',
        uri: 'threadnote://memory/tn_1234567890',
      }),
    ).toMatchObject({action: 'read'});
  });

  it('rejects unknown versions, extra fields, Python-style commands, and path authority', () => {
    for (const input of [
      {...validWriteRequest(), version: 1},
      {...validWriteRequest(), command: 'python scripts/workflow.py'},
      {...validWriteRequest(), path: '/private/state.json'},
      {...validWriteRequest(), sourceRunId: 'caller-controlled'},
      {...validWriteRequest(), bindingId: hash},
      {...validWriteRequest(), profile: 'desktop'},
      {...validWriteRequest(), team: 'personal'},
      {...validWriteRequest(), protocolVersion: 2},
      {...validWriteRequest(), action: 'run-python'},
      {
        protocolVersion: 1,
        executorVersion: 1,
        action: 'read',
        runId: 'run-1',
        generation: 'generation-1',
        uri: '/etc/passwd',
      },
    ])
      expect(caught(() => decodeNativeWorkflowRequest(input))).toMatchObject({code: 'invalid-request'});
  });

  it('enforces portable identifiers, bounded generation, and UTF-8 body bytes', () => {
    for (const id of ['../escape', 'foo..bar', 'constructor', 'prototype', '__proto__'])
      expect(
        caught(() =>
          decodeNativeWorkflowRequest({
            protocolVersion: 1,
            executorVersion: 1,
            action: 'init',
            runId: id,
            project: 'repo',
            featureId: 'feature',
            generation: 'g1',
          }),
        ),
      ).toMatchObject({code: 'invalid-request'});
    expect(caught(() => decodeNativeWorkflowRequest({...validWriteRequest(), generation: 'g\n1'}))).toMatchObject({
      code: 'invalid-request',
    });
    expect(
      caught(() => decodeNativeWorkflowRequest({...validWriteRequest(), generation: 'g'.repeat(4097)})),
    ).toMatchObject({
      code: 'invalid-request',
    });
    expect(decodeNativeWorkflowRequest({...validWriteRequest(), body: '🧭'.repeat(15_000)})).toMatchObject({
      body: '🧭'.repeat(15_000),
    });
    expect(
      caught(() => decodeNativeWorkflowRequest({...validWriteRequest(), body: `🧭`.repeat(15_001)})),
    ).toMatchObject({
      code: 'invalid-request',
    });
    expect(caught(() => decodeNativeWorkflowRequest({...validWriteRequest(), body: '   '}))).toMatchObject({
      code: 'invalid-request',
    });
  });

  it('hashes intent independently of object key order', () => {
    const left = intent({relations: [{type: 'references', uri: 'threadnote://memory/tn_a'}], codeRefs: ['src/a.ts']});
    const right: WorkflowWriteIntent = {
      codeRefs: ['src/a.ts'],
      relations: [{uri: 'threadnote://memory/tn_a', type: 'references'}],
      expectedRevision: null,
      body: 'Plan body.\n',
      role: 'root',
      sourceRunId: 'run-1',
      artifactKey: 'plan-root',
      operationId: 'write-1',
      bindingId: hash,
    };
    expect(nativeWorkflowIntentDigest(left)).toBe(nativeWorkflowIntentDigest(right));
    expect(nativeWorkflowIntentDigest(left)).toMatch(/^[a-f0-9]{64}$/u);
  });

  it('keeps semantic intent digests stable across recursive key order for bounded Unicode inputs', () => {
    fc.assert(
      fc.property(fc.string({maxLength: 48}), fc.integer({min: 1, max: 9999}), (generatedBody, suffix) => {
        const body = `${generatedBody} — 日本語 🧭 ${suffix}\n`;
        const referenceUri = `threadnote://memory/tn_${String(suffix).padStart(10, '0')}`;
        const left: WorkflowWriteIntent = {
          ...intent(),
          body,
          uri: undefined,
          codeRefs: [`src/generated-${suffix}.ts`],
          relations: [{type: 'evidence_for', uri: referenceUri}],
          evidenceRefs: [{uri: referenceUri, memoryId: `tn_${String(suffix).padStart(10, '0')}`, revision: hash}],
        };
        const right: WorkflowWriteIntent = {
          evidenceRefs: [{revision: hash, memoryId: `tn_${String(suffix).padStart(10, '0')}`, uri: referenceUri}],
          relations: [{uri: referenceUri, type: 'evidence_for'}],
          codeRefs: [`src/generated-${suffix}.ts`],
          uri: undefined,
          expectedRevision: null,
          body,
          role: 'root',
          sourceRunId: 'run-1',
          artifactKey: 'plan-root',
          operationId: 'write-1',
          bindingId: hash,
        };
        const digest = nativeWorkflowIntentDigest(left);
        expect(nativeWorkflowIntentDigest(right)).toBe(digest);
        expect(digest).toMatch(/^[a-f0-9]{64}$/u);
        expect(nativeWorkflowIntentDigest({...right, body: `${body}!`})).not.toBe(digest);
      }),
      {numRuns: 100},
    );
  });
});

describe('native workflow state', () => {
  it('accepts an empty native state and consistent prepared or verified operations', () => {
    expect(decodeNativeWorkflowState(stateBase)).toEqual(stateBase);
    const preparedIntent = intent();
    const prepared = {
      ...stateBase,
      operations: [
        {status: 'prepared', intent: preparedIntent, intentDigest: nativeWorkflowIntentDigest(preparedIntent)},
      ],
    };
    expect(decodeNativeWorkflowState(prepared).operations[0]).toMatchObject({status: 'prepared'});
    const verifiedIntent = intent({operationId: 'write-2', artifactKey: 'plan-summary'});
    const artifact = {
      uri: 'threadnote://user/tester/memories/durable/projects/repo/plan-summary.md',
      memoryId: 'tn_1234567890',
      revision: hash,
      body: verifiedIntent.body,
      storageKind: 'durable',
      state: 'active',
    } as const;
    const verified = {
      ...stateBase,
      operations: [
        {
          status: 'verified',
          intent: verifiedIntent,
          intentDigest: nativeWorkflowIntentDigest(verifiedIntent),
          artifact,
        },
      ],
    };
    expect(decodeNativeWorkflowState(verified).operations[0]).toMatchObject({status: 'verified', artifact});
  });

  it('rejects unknown and Python state markers or versions with fresh-run guidance', () => {
    for (const input of [
      {format: 'python-workflow-state', stateVersion: 1, executorVersion: 1},
      {...stateBase, format: 'unknown-native-format'},
      {...stateBase, stateVersion: 2},
      {...stateBase, executorVersion: 2},
    ])
      expect(caught(() => decodeNativeWorkflowState(input))).toMatchObject({
        code: 'unsupported-state',
        message: expect.stringContaining('fresh native workflow run'),
      });
  });

  it('detects tampered intents, digests, bindings, source runs, duplicate IDs, and status artifacts', () => {
    const writeIntent = intent();
    const operation = {status: 'prepared', intent: writeIntent, intentDigest: nativeWorkflowIntentDigest(writeIntent)};
    const wrongDigest = {...operation, intentDigest: '0'.repeat(64)};
    const changedBody = {...operation, intent: {...writeIntent, body: 'Tampered.'}};
    const wrongBinding = {...operation, intent: {...writeIntent, bindingId: 'b'.repeat(64)}};
    const wrongSource = {...operation, intent: {...writeIntent, sourceRunId: 'other-run'}};
    const duplicate = {...stateBase, operations: [operation, operation]};
    const preparedWithArtifact = {
      ...operation,
      artifact: {
        uri: 'threadnote://user/tester/memories/durable/projects/repo/plan.md',
        memoryId: 'tn_1234567890',
        revision: hash,
        body: writeIntent.body,
        storageKind: 'durable',
        state: 'active',
      },
    };
    const verifiedWithoutArtifact = {...operation, status: 'verified'};
    for (const invalidOperation of [
      wrongDigest,
      changedBody,
      wrongBinding,
      wrongSource,
      preparedWithArtifact,
      verifiedWithoutArtifact,
    ])
      expect(caught(() => decodeNativeWorkflowState({...stateBase, operations: [invalidOperation]}))).toMatchObject({
        code: 'invalid-state',
      });
    expect(caught(() => decodeNativeWorkflowState(duplicate))).toMatchObject({code: 'invalid-state'});
    expect(caught(() => decodeNativeWorkflowState({...stateBase, unexpected: 'extra'}))).toMatchObject({
      code: 'invalid-state',
    });
  });
});
