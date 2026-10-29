import {Array as EffectArray} from 'effect';
import {describe, expect, it} from 'vitest';
import {
  CODE_MEMORY_LINK_DOGFOOD_CASE_IDS,
  codeMemoryLinkDogfoodArtifactHash,
  createCodeMemoryLinkDeferredAnchorObservationV2,
  createCodeMemoryLinkDogfoodObservationV1,
  evaluateCodeMemoryLinkDogfood,
  parseCodeMemoryLinkDogfoodArtifactV1,
  type CodeMemoryLinkDogfoodArtifactV1,
  type CodeMemoryLinkDogfoodObservationSummaryV1,
} from '@threadnote/threadnote/evaluation/code-memory-link-dogfood';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

const CANDIDATE = {
  buildIdentityHash: Effect.pipe('b', EffectString.repeat(64)),
  commit: Effect.pipe('c', EffectString.repeat(40)),
  dirty: false as const,
};
const RUNTIME = {executableSha256: CANDIDATE.buildIdentityHash, sourceCommit: CANDIDATE.commit};
const HARNESS_COMMIT = Effect.pipe('a', EffectString.repeat(40));
const RUN_ID = `run_${Effect.pipe('d', EffectString.repeat(16))}`;

describe('Code Memory Link practical dogfood evidence', () => {
  it('keeps a complete practical matrix insufficient until its exact evidence hash is reviewed', () => {
    const artifact = validArtifact();
    const result = evaluateCodeMemoryLinkDogfood(artifact);

    expect(result).toMatchObject({
      artifactHash: artifact.artifactHash,
      candidate: artifact.candidate,
      evidenceApproved: false,
      gate: {
        failures: ['practical dogfood evidence hash is not in the code-reviewed release allowlist'],
        insufficiencies: ['practical dogfood evidence hash is not in the code-reviewed release allowlist'],
        qualityFailures: [],
        status: 'insufficient',
      },
      version: 2,
    });
  });

  it('fails unsafe, duplicate, unbounded, and semantically wrong practical observations', () => {
    const artifact = validArtifact();
    const observations = EffectArray.map(artifact.observations, observation => {
      if (observation.id === 'file-backlink') return reseal({...observation, duplicateMemoryCount: 1});
      if (observation.id === 'symbol-backlink') return reseal({...observation, estimatedTokens: 1_251});
      if (observation.id === 'no-backlink') {
        return reseal({...observation, directCodeCitationMatches: 1, falseCurrentCount: 1});
      }
      return observation;
    });
    const degraded = withHash({...artifact, observations});
    const result = evaluateCodeMemoryLinkDogfood(degraded);

    expect(result.gate.status).toBe('failed');
    expect(result.gate.qualityFailures).toEqual(
      expect.arrayContaining([
        'file-backlink returned duplicate memories',
        'no-backlink did not satisfy its practical retrieval contract',
        'no-backlink made a false-current claim',
        'symbol-backlink exceeded token budget',
      ]),
    );
  });

  it('hashes every practical outcome and rejects tampering or a noncanonical matrix', () => {
    const artifact = validArtifact();
    expect(() =>
      parseCodeMemoryLinkDogfoodArtifactV1({...artifact, artifactHash: Effect.pipe('f', EffectString.repeat(64))}),
    ).toThrow(/hash does not match/);
    expect(() =>
      codeMemoryLinkDogfoodArtifactHash({
        candidate: artifact.candidate,
        deferredAnchorLifecycle: artifact.deferredAnchorLifecycle,
        harnessCommit: artifact.harnessCommit,
        observations: EffectArray.map(artifact.observations, (observation, index) =>
          index === 0 ? {...observation, responseBytes: observation.responseBytes + 1} : observation,
        ),
        runId: artifact.runId,
        version: 2,
      }),
    ).toThrow(/output digest|summary digest/);
    expect(() =>
      parseCodeMemoryLinkDogfoodArtifactV1(withHash({...artifact, observations: [...artifact.observations].reverse()})),
    ).toThrow(/invocation digest|canonical required case order/);
  });

  it('rejects another-runtime attestations and replayed case summaries', () => {
    const artifact = validArtifact();
    const [first, second] = artifact.observations;
    expect(() =>
      parseCodeMemoryLinkDogfoodArtifactV1({
        ...artifact,
        observations: EffectArray.map(artifact.observations, (entry, index) =>
          index === 0
            ? {
                ...entry,
                attestation: {
                  ...entry.attestation,
                  postRuntime: {
                    ...entry.attestation.postRuntime,
                    executableSha256: Effect.pipe('e', EffectString.repeat(64)),
                  },
                },
              }
            : entry,
        ),
      }),
    ).toThrow(/runtime identities differ|exact candidate executable/);
    expect(() =>
      parseCodeMemoryLinkDogfoodArtifactV1({
        ...artifact,
        observations: EffectArray.map(artifact.observations, (entry, index) =>
          index === 1 ? {...second, attestation: first.attestation} : entry,
        ),
      }),
    ).toThrow(/invocation digest|replayed harness receipts/);
  });

  it('requires the stale-abstention case to retain an independently observed clean snapshot status', () => {
    const artifact = validArtifact();
    const staleIndex = CODE_MEMORY_LINK_DOGFOOD_CASE_IDS.indexOf('stale-graph-abstention');
    const stale = artifact.observations[staleIndex];
    const notStale = reseal({...stale, graphStatus: {...stale.graphStatus!, stale: false}});
    const wrongSnapshot = reseal({
      ...stale,
      graphStatus: {...stale.graphStatus!, readySnapshotCommit: Effect.pipe('e', EffectString.repeat(40))},
    });

    expect(
      evaluateCodeMemoryLinkDogfood(
        withHash({
          ...artifact,
          observations: EffectArray.map(artifact.observations, (entry, index) =>
            index === staleIndex ? notStale : entry,
          ),
        }),
      ).gate.qualityFailures,
    ).toContain('stale-graph-abstention did not independently observe a stale graph');
    expect(
      evaluateCodeMemoryLinkDogfood(
        withHash({
          ...artifact,
          observations: EffectArray.map(artifact.observations, (entry, index) =>
            index === staleIndex ? wrongSnapshot : entry,
          ),
        }),
      ).gate.qualityFailures,
    ).toContain('stale-graph-abstention graph snapshot does not match the reviewed harness checkout');
  });

  it('fails when store-now exposes a backlink or does not finalize after restart', () => {
    const artifact = validArtifact();
    const deferredAnchorLifecycle = createCodeMemoryLinkDeferredAnchorObservationV2({
      candidate: CANDIDATE,
      harnessCommit: HARNESS_COMMIT,
      invocationNonce: artifact.deferredAnchorLifecycle.attestation.invocationNonce,
      observation: {
        ...deferredObservation(),
        citationsFinalizedAfterPrepare: false,
        directMatchesBeforeFinalize: 1,
        finalizedBacklinkTargetsStoredMemory: false,
        finalization: {...deferredObservation().finalization, finalizedCount: 0, pendingCount: 1},
        pendingIntentCountAfterFinalize: 1,
        pendingMemoryRecallableByTask: false,
      },
      postRuntime: RUNTIME,
      preRuntime: RUNTIME,
      runId: RUN_ID,
    });
    expect(
      evaluateCodeMemoryLinkDogfood(withHash({...artifact, deferredAnchorLifecycle})).gate.qualityFailures,
    ).toEqual(
      expect.arrayContaining([
        'deferred-anchor lifecycle did not finalize exactly one private pending intent',
        'deferred-anchor lifecycle exposed a pending backlink or failed to expose its finalized backlink',
      ]),
    );
  });

  it('retains strict-write and deferred-write failures as quality evidence', () => {
    const artifact = validArtifact();
    const deferredAnchorLifecycle = createCodeMemoryLinkDeferredAnchorObservationV2({
      candidate: CANDIDATE,
      harnessCommit: HARNESS_COMMIT,
      invocationNonce: artifact.deferredAnchorLifecycle.attestation.invocationNonce,
      observation: {
        ...deferredObservation(),
        indexingStartedByWrite: true,
        strictIndexingStartedByWrite: true,
        strictMemoryStored: true,
        strictWriteRejected: false,
      },
      postRuntime: RUNTIME,
      preRuntime: RUNTIME,
      runId: RUN_ID,
    });

    expect(
      evaluateCodeMemoryLinkDogfood(withHash({...artifact, deferredAnchorLifecycle})).gate.qualityFailures,
    ).toEqual(
      expect.arrayContaining([
        'strict cited write did not reject atomically while exact-current graph evidence was unavailable',
        'strict or deferred memory write started graph indexing',
      ]),
    );
  });
});

function validArtifact(): CodeMemoryLinkDogfoodArtifactV1 {
  const observations = EffectArray.map(CODE_MEMORY_LINK_DOGFOOD_CASE_IDS, (id, index) => {
    const summary = observation(id);
    return createCodeMemoryLinkDogfoodObservationV1({
      candidate: CANDIDATE,
      harnessCommit: HARNESS_COMMIT,
      invocationNonce: opaqueInvocation(index),
      observation: summary,
      postRuntime: RUNTIME,
      preRuntime: RUNTIME,
      runId: RUN_ID,
    });
  });
  const deferredAnchorLifecycle = createCodeMemoryLinkDeferredAnchorObservationV2({
    candidate: CANDIDATE,
    harnessCommit: HARNESS_COMMIT,
    invocationNonce: opaqueInvocation(CODE_MEMORY_LINK_DOGFOOD_CASE_IDS.length),
    observation: deferredObservation(),
    postRuntime: RUNTIME,
    preRuntime: RUNTIME,
    runId: RUN_ID,
  });
  return withHash({
    candidate: CANDIDATE,
    deferredAnchorLifecycle,
    harnessCommit: HARNESS_COMMIT,
    observations,
    runId: RUN_ID,
    version: 2,
  });
}

function deferredObservation() {
  return {
    canonicalBodyPreserved: true,
    canonicalIdentityPreserved: true,
    canonicalLifecyclePreserved: true,
    canonicalTimestampsPreserved: true,
    citationsFinalizedAfterPrepare: true,
    directMatchesAfterFinalize: 1,
    directMatchesBeforeFinalize: 0,
    deferredReceiptGuidanceObserved: true,
    durableReceiptMilliseconds: 500,
    falseCurrentCount: 0,
    finalizedBacklinkTargetsStoredMemory: true,
    finalization: {
      citationCount: 1,
      conflictCount: 0,
      failedCount: 0,
      finalizedCount: 1,
      pendingCount: 0,
      scannedCount: 1,
    },
    graphStatusAfterStore: {
      readySnapshotCommit: HARNESS_COMMIT,
      readySnapshotDirty: false,
      readySnapshotId: `cgsn_${Effect.pipe('f', EffectString.repeat(40))}`,
      stale: true,
    },
    indexingStartedByWrite: false,
    memoryStored: true,
    pendingIntentCountAfterFinalize: 0,
    pendingIntentCountAfterStore: 1,
    pendingMemoryRecallableByTask: true,
    restartBoundary: true,
    strictIndexingStartedByWrite: false,
    strictMemoryStored: false,
    strictReceiptMilliseconds: 100,
    strictRecoveryGuidanceObserved: true,
    strictWriteRejected: true,
  };
}

function observation(
  id: (typeof CODE_MEMORY_LINK_DOGFOOD_CASE_IDS)[number],
): CodeMemoryLinkDogfoodObservationSummaryV1 {
  const base = {
    budgetTokens: 1_250,
    directCodeCitationMatches: 0,
    duplicateMemoryCount: 0,
    estimatedTokens: 500,
    falseCurrentCount: 0,
    graphStatus: null,
    id,
    memoryMatches: 0,
    responseBytes: 1_000,
  } as const;
  if (id === 'task-only-memory') {
    return {
      ...base,
      codeAnchorCoverageComplete: null,
      memoryMatches: 1,
      outputVersion: 2,
      requestedAnchors: 0,
      resolvedAnchors: 0,
    };
  }
  if (id === 'stale-graph-abstention') {
    return {
      ...base,
      codeAnchorCoverageComplete: false,
      graphStatus: {
        readySnapshotCommit: HARNESS_COMMIT,
        readySnapshotDirty: false,
        readySnapshotId: `cgsn_${Effect.pipe('f', EffectString.repeat(40))}`,
        stale: true,
      },
      outputVersion: 3,
      requestedAnchors: 1,
      resolvedAnchors: 0,
    };
  }
  const anchors = id === 'multi-anchor' ? 2 : 1;
  return {
    ...base,
    codeAnchorCoverageComplete: true,
    directCodeCitationMatches: id === 'no-backlink' ? 0 : 1,
    memoryMatches: id === 'no-backlink' ? 0 : 1,
    outputVersion: 3,
    requestedAnchors: anchors,
    resolvedAnchors: anchors,
  };
}

function reseal(input: ReturnType<typeof validArtifact>['observations'][number]) {
  const {attestation, ...summary} = input;
  return createCodeMemoryLinkDogfoodObservationV1({
    candidate: CANDIDATE,
    harnessCommit: HARNESS_COMMIT,
    invocationNonce: attestation.invocationNonce,
    observation: summary,
    postRuntime: RUNTIME,
    preRuntime: RUNTIME,
    runId: RUN_ID,
  });
}

function opaqueInvocation(index: number): string {
  return `inv_${Effect.pipe(index.toString(16), EffectString.padStart(16, '0'))}`;
}

function withHash(
  artifact: Omit<CodeMemoryLinkDogfoodArtifactV1, 'artifactHash'> & {readonly artifactHash?: string},
): CodeMemoryLinkDogfoodArtifactV1 {
  const normalized = {
    candidate: artifact.candidate,
    deferredAnchorLifecycle: artifact.deferredAnchorLifecycle,
    harnessCommit: artifact.harnessCommit,
    observations: artifact.observations,
    runId: artifact.runId,
    version: artifact.version,
  } as const;
  return {...normalized, artifactHash: codeMemoryLinkDogfoodArtifactHash(normalized)};
}
