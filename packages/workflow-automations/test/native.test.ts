import {describe, expect, it} from 'vitest';
import fc from 'fast-check';
import {
  admitNativeAuthoringSave,
  nativeAuthoringSaveByteBudget,
  nativeAuthoringPrefixDigest,
  nativeWorkflowOperationLimit,
  nativeWorkflowIntentDigest,
  decodeNativeWorkflowRequest,
  decodeNativeWorkflowState,
} from '../src/native.js';
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
    for (const id of [
      '../escape',
      'foo..bar',
      'constructor',
      'prototype',
      '__proto__',
      'prn',
      'AUX.txt',
      'com1',
      'lpt9',
    ])
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
    expect(caught(() => decodeNativeWorkflowRequest({...validWriteRequest(), runId: 'CON'}))).toMatchObject({
      code: 'invalid-request',
    });
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

  it('keeps the v1 logical operation ID grammar for Windows device names in requests and persisted intents', () => {
    expect(caught(() => decodeNativeWorkflowState({...stateBase, runId: 'CON'}))).toMatchObject({
      code: 'invalid-state',
    });
    const request = decodeNativeWorkflowRequest({...validWriteRequest(), operationId: 'CON'});
    expect(request).toMatchObject({action: 'write', operationId: 'CON'});
    const persistedIntent = intent({operationId: 'CON'});
    const persisted = {
      ...stateBase,
      operations: [
        {
          status: 'prepared',
          intent: persistedIntent,
          intentDigest: nativeWorkflowIntentDigest(persistedIntent),
        },
      ],
    };
    expect(decodeNativeWorkflowState(persisted).operations[0]).toMatchObject({
      status: 'prepared',
      intent: {operationId: 'CON'},
      intentDigest: nativeWorkflowIntentDigest(persistedIntent),
    });
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

  it('holds a single exact reservation across completed prefixes at the operation and byte ceilings', () => {
    const byteLimit = 64 * 1024 * 1024;
    const startingOperations = [{intentDigest: 'b'.repeat(64)}];
    const prefixDigest = nativeAuthoringPrefixDigest(startingOperations);
    const plannedOperations = nativeWorkflowOperationLimit - startingOperations.length;
    const plannedBytes = 4096;
    const admission = {
      intentDigest: 'c'.repeat(64),
      rootUri: null,
      operationCount: startingOperations.length,
      plannedOperations,
      journalBytes: byteLimit - plannedBytes,
      stateBytes: byteLimit - plannedBytes,
      plannedBytes,
      prefixDigest,
      operationLimit: nativeWorkflowOperationLimit,
    };
    const reservation = admitNativeAuthoringSave(admission);
    expect(reservation.operationStart).toBe(1);
    expect(reservation.operationLimit).toBe(4096);
    expect(reservation.journalBytesAtStart + reservation.reservedBytes).toBe(byteLimit);

    fc.assert(
      fc.property(fc.integer({min: 0, max: plannedOperations}), completed => {
        const resumed = admitNativeAuthoringSave(
          {
            ...admission,
            operationCount: reservation.operationStart + completed,
            journalBytes: byteLimit,
            stateBytes: byteLimit,
          },
          reservation,
        );
        expect(resumed).toEqual(reservation);
      }),
      {numRuns: 64},
    );

    for (const changed of [
      {...admission, intentDigest: 'd'.repeat(64)},
      {
        ...admission,
        prefixDigest: nativeAuthoringPrefixDigest([...startingOperations, {intentDigest: 'e'.repeat(64)}]),
      },
      {...admission, plannedBytes: plannedBytes + 1},
      {...admission, plannedOperations: plannedOperations - 1},
    ])
      expect(caught(() => admitNativeAuthoringSave(changed, reservation))).toMatchObject({code: 'pending-operation'});

    expect(
      caught(() =>
        admitNativeAuthoringSave({
          ...admission,
          operationCount: nativeWorkflowOperationLimit,
          plannedOperations: 1,
        }),
      ),
    ).toMatchObject({code: 'authoring-capacity'});
    expect(
      caught(() =>
        admitNativeAuthoringSave({
          ...admission,
          journalBytes: byteLimit - plannedBytes + 1,
        }),
      ),
    ).toMatchObject({code: 'authoring-capacity'});
    expect(
      caught(() =>
        admitNativeAuthoringSave({
          ...admission,
          operationLimit: nativeWorkflowOperationLimit + 1,
          plannedOperations: nativeWorkflowOperationLimit,
        }),
      ),
    ).toMatchObject({code: 'authoring-capacity'});
  });

  it('budgets large scope inventories before admission and retains the original prefix budget on retry', () => {
    const byteLimit = 64 * 1024 * 1024;
    const inventory = Array.from({length: 2000}, (_, index) => {
      const prefix = 'threadnote://user/tester/memories/durable/projects/fixture/';
      const unique = `owned-${String(index).padStart(4, '0')}-`;
      return prefix + unique + 'x'.repeat(250 - prefix.length - unique.length);
    });
    expect(inventory.every(uri => new TextEncoder().encode(uri).byteLength === 250)).toBe(true);
    const scopeBytes = new TextEncoder().encode(JSON.stringify(inventory)).byteLength;
    const maximumScopeEntryBytes = Math.max(
      ...inventory.map(uri => new TextEncoder().encode(JSON.stringify(uri)).byteLength + 1),
    );
    const budgetInput = {
      contentBytes: 0,
      evidenceBytes: 0,
      plannedOperations: 48,
      scopeBytes,
      maximumScopeEntryBytes,
      requestMetadataBytes: 64 * 1024,
    };
    const plannedBytes = nativeAuthoringSaveByteBudget(budgetInput);
    expect(plannedBytes).toBeGreaterThan(59 * 1024 * 1024);
    expect(plannedBytes).toBeLessThan(61 * 1024 * 1024);

    const originalOperations = Array.from({length: 3}, (_, index) => ({intentDigest: `${index + 1}`.repeat(64)}));
    const prefixDigest = nativeAuthoringPrefixDigest(originalOperations);
    const admission = {
      intentDigest: 'f'.repeat(64),
      rootUri: null,
      operationCount: originalOperations.length,
      plannedOperations: budgetInput.plannedOperations,
      journalBytes: 4 * 1024 * 1024,
      stateBytes: 4 * 1024 * 1024,
      plannedBytes,
      prefixDigest,
      operationLimit: nativeWorkflowOperationLimit,
    };
    const reservation = admitNativeAuthoringSave(admission);
    expect(reservation.operationLimit).toBe(51);

    const candidateUris = Array.from({length: 16}, (_, index) => {
      const prefix = 'threadnote://user/tester/memories/durable/projects/fixture/';
      const unique = `candidate-${String(index).padStart(2, '0')}-`;
      return prefix + unique + 'y'.repeat(250 - prefix.length - unique.length);
    });
    const grownScopeBytes = new TextEncoder().encode(JSON.stringify([...inventory, ...candidateUris])).byteLength;
    const changedScopeBudget = nativeAuthoringSaveByteBudget({...budgetInput, scopeBytes: grownScopeBytes});
    expect(changedScopeBudget).toBeGreaterThan(plannedBytes);

    const retry = admitNativeAuthoringSave(
      {
        ...admission,
        operationCount: reservation.operationStart + 11,
        journalBytes: 50 * 1024 * 1024,
        stateBytes: 60 * 1024 * 1024,
        prefixDigest: nativeAuthoringPrefixDigest(originalOperations),
      },
      reservation,
    );
    expect(retry).toEqual(reservation);

    expect(
      caught(() =>
        admitNativeAuthoringSave({
          ...admission,
          journalBytes: 4_500_000,
          stateBytes: 4_500_000,
        }),
      ),
    ).toMatchObject({code: 'authoring-capacity'});
    expect(
      caught(() =>
        admitNativeAuthoringSave(
          {
            ...admission,
            prefixDigest: nativeAuthoringPrefixDigest([...originalOperations, {intentDigest: '9'.repeat(64)}]),
          },
          reservation,
        ),
      ),
    ).toMatchObject({code: 'pending-operation'});
    expect(byteLimit - (admission.journalBytes + plannedBytes)).toBeGreaterThan(0);
  });

  it('rejects invalid numeric byte-budget inputs', () => {
    const base = {
      contentBytes: 100,
      evidenceBytes: 50,
      plannedOperations: 2,
      scopeBytes: 30,
      maximumScopeEntryBytes: 250,
      requestMetadataBytes: 20,
    };
    const invalid = [
      {...base, contentBytes: Number.NaN},
      {...base, evidenceBytes: Number.POSITIVE_INFINITY},
      {...base, plannedOperations: 0},
      {...base, plannedOperations: nativeWorkflowOperationLimit + 1},
      {...base, scopeBytes: -1},
      {...base, maximumScopeEntryBytes: 1.5},
      {...base, requestMetadataBytes: Number.MAX_SAFE_INTEGER},
    ];
    for (const input of invalid)
      expect(caught(() => nativeAuthoringSaveByteBudget(input))).toMatchObject({code: 'authoring-capacity'});
  });
});
