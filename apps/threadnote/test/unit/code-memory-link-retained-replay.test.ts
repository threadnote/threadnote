import {Array as EffectArray, Option as EffectOption} from 'effect';
import {describe, expect, it} from 'vitest';
import {assertRetainedBundleBindings} from '../../../../scripts/verify-code-memory-link-release.js';
import {
  assembleCodeMemoryLinkSealedSuiteV1,
  codeMemoryLinkAgentPreparedMemoryDirectory,
  type CodeMemoryLinkPreparedTaskV1,
} from '../../../../scripts/prepare-code-memory-link-agent-ab.js';
import {
  parseCodeMemoryLinkCodexJudgeCommandV1,
  parseCodeMemoryLinkCodexSuiteLayoutV1,
} from '../../../../scripts/code-memory-link-codex-suite.js';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {createCodeMemoryLinkAgentSuiteCorpusV1} from '@threadnote/threadnote/evaluation/code-memory-link-agent-suite';
import {
  CODE_MEMORY_LINK_CANONICAL_EMPTY_CONTEXT_BRIEF_V1,
  canonicalizeCodeMemoryLinkContextBriefResultV1,
  type CodeMemoryLinkCodexTraceCheckpointV1,
} from '@threadnote/threadnote/evaluation/code-memory-link-agent-protocol';
import {
  codeMemoryLinkClientImplementationDescriptorHash,
  codeMemoryLinkClientProjectionHash,
  parseCodeMemoryLinkClientImplementationDescriptorV1,
} from '@threadnote/threadnote/evaluation/code-memory-link-client-descriptor';
import {createCodeMemoryLinkRetainedResultV1} from '@threadnote/threadnote/evaluation/code-memory-link-retained-result';
import type {CodeMemoryLinkAgentAbMetricsV1} from '@threadnote/threadnote/evaluation/code-memory-link-agent-ab-metrics';
import type {CodeMemoryLinkAgentAbResultV1} from '@threadnote/threadnote/evaluation/code-memory-link-agent-ab';
import {
  CODE_MEMORY_LINK_DOGFOOD_VERSION,
  createCodeMemoryLinkDeferredAnchorObservationV2,
  type CodeMemoryLinkDogfoodResultV1,
} from '@threadnote/threadnote/evaluation/code-memory-link-dogfood';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

describe('Code Memory Link retained release replay', () => {
  it('replays sealed layout, client identity, judge, and per-arm response bindings', () => {
    const fixture = replayFixture();
    expect(() => assertRetainedBundleBindings(fixture.input)).not.toThrow();

    const responseTamper = replayFixture();
    responseTamper.evidence[0].rawEvidence.appServer.checkpoints[0].proxyReceipt.responseHash = Effect.pipe(
      'f',
      EffectString.repeat(64),
    );
    expect(() => assertRetainedBundleBindings(responseTamper.input)).toThrow(/response.*preregistration/u);

    const projectionTamper = replayFixture();
    projectionTamper.evidence[0].rawEvidence.clientProtocol.configurationProjectionHash = Effect.pipe(
      'e',
      EffectString.repeat(64),
    );
    expect(() => assertRetainedBundleBindings(projectionTamper.input)).toThrow(/client protocol/u);

    const judgeTamper = replayFixture();
    judgeTamper.evidence[0].rawEvidence.judge.programSha256 = Effect.pipe('d', EffectString.repeat(64));
    expect(() => assertRetainedBundleBindings(judgeTamper.input)).toThrow(/judge execution/u);
  });
});

function replayFixture() {
  const corpus = createCodeMemoryLinkAgentSuiteCorpusV1();
  const definition = corpus.releaseTasks[0];
  const sealed = assembleCodeMemoryLinkSealedSuiteV1({
    corpusHash: corpus.corpusHash,
    judgeProgram: 'export const judge = true;\n',
    tasks: EffectArray.map(corpus.releaseTasks, preparedTask),
  });
  const layout = parseCodeMemoryLinkCodexSuiteLayoutV1(sealed.adapter);
  const commandMapping = EffectOption.getOrUndefined(
    EffectArray.findFirst(layout.judge.files, file => file.artifactId === layout.judge.commandArtifactId),
  )!;
  const command = parseCodeMemoryLinkCodexJudgeCommandV1(JSON.parse(sealed.files.get(commandMapping.source)!));
  const commandDescriptor = EffectOption.getOrUndefined(
    EffectArray.findFirst(
      sealed.suite.judge.artifacts,
      artifact => artifact.artifactId === layout.judge.commandArtifactId,
    ),
  )!;
  const programDescriptor = EffectOption.getOrUndefined(
    EffectArray.findFirst(sealed.suite.judge.artifacts, artifact => artifact.artifactId === command.programArtifactId),
  )!;
  const clientFixtures = EffectArray.map(['gpt-5.6-luna', 'gpt-5.6-terra'], (model, index) =>
    clientFixture(model, index),
  );
  const manifest = {
    adjudicationArtifactHash: sealed.suite.judge.judgeHash,
    clients: EffectArray.map(clientFixtures, client => client.manifest),
    suiteHash: sealed.suite.suiteHash,
    tasks: sealed.manifestTasks,
  };
  const responseHash = sealed.manifestTasks[0].expectedResponseHashes.anchored;
  const evidence = EffectArray.map(clientFixtures, client => ({
    rawEvidence: {
      appServer: {
        checkpoints: [
          {
            itemIdDigest: Effect.pipe('a', EffectString.repeat(64)),
            itemType: 'mcpToolCall',
            method: 'item/completed',
            ordinal: 1,
            proxyReceipt: {
              armPacketHash: Effect.pipe('b', EffectString.repeat(64)),
              proxyDecisionHash: Effect.pipe('c', EffectString.repeat(64)),
              rawRequestHash: Effect.pipe('d', EffectString.repeat(64)),
              responseHash,
              runBindingHash: Effect.pipe('e', EffectString.repeat(64)),
              version: 1,
            },
            requestDigest: Effect.pipe('f', EffectString.repeat(64)),
            response: null,
            status: 'completed',
            succeeded: true,
          } satisfies CodeMemoryLinkCodexTraceCheckpointV1,
        ],
      },
      bindings: {arm: 'anchored' as const, clientId: client.manifest.clientId, taskId: definition.taskId},
      clientProtocol: {
        configurationProjectionHash: client.manifest.configurationProjectionHash,
        environmentPolicyHash: client.manifest.environmentPolicyHash,
        executionBundleHash: client.manifest.executionBundleHash,
        expectedClient: client.manifest.expectedClient,
        expectedClientProjectionHash: client.descriptor.expectedClientProjectionHash,
        proxyTool: client.proxyTool,
      },
      judge: {
        commandArtifactId: commandDescriptor.artifactId,
        commandSha256: commandDescriptor.sha256,
        programArtifactId: programDescriptor.artifactId,
        programSha256: programDescriptor.sha256,
      },
    },
  }));
  const candidate: CodeMemoryLinkAgentAbResultV1['candidate'] = {
    buildIdentityHash: Effect.pipe('1', EffectString.repeat(64)),
    commit: Effect.pipe('2', EffectString.repeat(40)),
    dirty: false,
  };
  const agentAb: CodeMemoryLinkAgentAbResultV1 = {
    assignmentHash: Effect.pipe('3', EffectString.repeat(64)),
    candidate,
    evidence: {
      approvedEvidence: false,
      approvedManifest: false,
      distinctClients: 2,
      eligibleExternalTrials: 2,
      excludedMockTrials: 0,
      externalEvidenceHash: Effect.pipe('4', EffectString.repeat(64)),
      hiddenTasks: 1,
      manifestApprovalCommit: null,
      negativeControlTasks: 0,
      pairedBlocks: 1,
      retainedEvidenceReceipts: 2,
    },
    fixtureHash: sealed.fixture.fixtureHash,
    gate: {failures: [], insufficiencies: [], qualityFailures: [], status: 'passed'},
    manifestHash: Effect.pipe('6', EffectString.repeat(64)),
    metrics: emptyAgentAbMetrics(),
    suiteHash: sealed.suite.suiteHash,
    version: 1,
  };
  const dogfood: CodeMemoryLinkDogfoodResultV1 = {
    artifactHash: Effect.pipe('7', EffectString.repeat(64)),
    candidate,
    deferredAnchorLifecycle: deferredAnchorFixture(candidate),
    evidenceApproved: false,
    gate: {failures: [], insufficiencies: [], qualityFailures: [], status: 'passed'},
    harnessCommit: Effect.pipe('5', EffectString.repeat(40)),
    observations: [],
    version: CODE_MEMORY_LINK_DOGFOOD_VERSION,
  };
  const retained = {
    artifacts: {
      assignment: '{}\n',
      attempts: '{}\n',
      dogfood: '{}\n',
      evidence: '{}\n',
      manifest: '{}\n',
      result: `${JSON.stringify(createCodeMemoryLinkRetainedResultV1({agentAb, dogfood}), undefined, 2)}\n`,
      sealedLayout: sealed.files.get('adapter.json')!,
      sealedSuite: sealed.files.get('suite.json')!,
      trials: '{}\n',
    },
    clients: EffectArray.map(clientFixtures, client => ({
      clientId: client.manifest.clientId,
      configProjection: client.configProjection,
      descriptor: `${JSON.stringify(client.descriptor)}\n`,
    })),
    sealedFiles: EffectArray.map(
      EffectArray.filter([...sealed.files], ([path]) => path !== 'adapter.json' && path !== 'suite.json'),
      ([path, content]) => ({content, path}),
    ),
  };
  const input = {
    agentAb,
    dogfood,
    evidence,
    manifest,
    retained,
  };
  return {evidence, input};
}

function clientFixture(model: string, index: number) {
  const clientId = `cli_${Effect.pipe(String(index + 1), EffectString.repeat(16))}`;
  const expectedClient = {
    appServerVersion: '0.149.0-alpha.4.1' as const,
    model,
    modelProvider: 'openai',
    reasoningEffort: 'medium',
  };
  const proxyTool = {server: 'context_brief_gate', tool: 'context_brief'};
  const configProjection = `${JSON.stringify({model, version: 1})}\n`;
  const configurationProjectionHash = sha256HexSync(configProjection);
  const environmentPolicyHash = Effect.pipe(String(index + 3), EffectString.repeat(64));
  const executionBundleHash = Effect.pipe(String(index + 5), EffectString.repeat(64));
  const descriptor = parseCodeMemoryLinkClientImplementationDescriptorV1({
    argumentVectorHash: Effect.pipe(String(index + 7), EffectString.repeat(64)),
    artifactBindings: [
      {
        pathDigest: Effect.pipe('1', EffectString.repeat(63)) + index,
        role: 'client-bundle',
        sha256: executionBundleHash,
      },
      {
        pathDigest: Effect.pipe('2', EffectString.repeat(63)) + index,
        role: 'client-entrypoint',
        sha256: Effect.pipe(String(index + 6), EffectString.repeat(64)),
      },
      {
        pathDigest: Effect.pipe('3', EffectString.repeat(63)) + index,
        role: 'proxy-bundle',
        sha256: Effect.pipe(String(index + 7), EffectString.repeat(64)),
      },
    ],
    binaryBindings: [
      {
        pathDigest: Effect.pipe('4', EffectString.repeat(63)) + index,
        role: 'client-runtime',
        sha256: Effect.pipe('8', EffectString.repeat(64)),
      },
      {
        pathDigest: Effect.pipe('5', EffectString.repeat(63)) + index,
        role: 'codex-app-server',
        sha256: Effect.pipe('9', EffectString.repeat(64)),
      },
      {
        pathDigest: Effect.pipe('6', EffectString.repeat(63)) + index,
        role: 'git',
        sha256: Effect.pipe('a', EffectString.repeat(64)),
      },
    ],
    configurationHash: Effect.pipe('b', EffectString.repeat(64)),
    configurationProjectionHash,
    dependenciesLockHash: Effect.pipe('c', EffectString.repeat(64)),
    entrypointHash: Effect.pipe(String(index + 6), EffectString.repeat(64)),
    environmentPolicyHash,
    executionBundleHash,
    expectedClientProjectionHash: codeMemoryLinkClientProjectionHash('expected-client', {
      ...expectedClient,
      proxyTool,
    }),
    version: 2,
  });
  return {
    configProjection,
    descriptor,
    manifest: {
      clientId,
      configurationProjectionHash,
      environmentPolicyHash,
      executionBundleHash,
      expectedClient,
      implementationDescriptorHash: codeMemoryLinkClientImplementationDescriptorHash(descriptor),
    },
    proxyTool,
  };
}

function preparedTask(
  definition: ReturnType<typeof createCodeMemoryLinkAgentSuiteCorpusV1>['releaseTasks'][number],
): CodeMemoryLinkPreparedTaskV1 {
  const citationDigests = [
    ...new Set(
      EffectArray.map(
        EffectArray.filter(definition.memorySeeds, seed => seed.citationPath !== null),
        seed => sha256HexSync(`${definition.taskId}:citation:${seed.citationPath}`),
      ),
    ),
  ].sort();
  const response = (version: 2 | 3) =>
    canonicalizeCodeMemoryLinkContextBriefResultV1({
      activeHandoffs: [],
      durableDecisions: [],
      type: 'context-brief',
      version,
    }).receipt;
  return {
    citationDigests,
    definition,
    homeFiles: EffectArray.map(definition.memorySeeds, (seed, index) => ({
      content:
        definition.controlScenario === 'malformed-citation'
          ? `task=${definition.taskId}_${index}\ncode_citation: {not-canonical-json\n`
          : `task=${definition.taskId}_${index}\n`,
      destination: `${codeMemoryLinkAgentPreparedMemoryDirectory(seed.status)}/${definition.taskId}-${index}.md`,
    })),
    preflightExpectedCitationDigests:
      definition.taskKind === 'hidden-constraint' ||
      definition.controlScenario === 'ambiguous' ||
      definition.controlScenario === 'instruction-injection-direct'
        ? citationDigests
        : [],
    preflightExpectedResponses: {
      anchored: response(3),
      noMemory: canonicalizeCodeMemoryLinkContextBriefResultV1(
        CODE_MEMORY_LINK_CANONICAL_EMPTY_CONTEXT_BRIEF_V1.structuredContent,
      ).receipt,
      taskOnly: response(2),
    },
    preflightExpectedSelectedMemories: [],
  };
}

function emptyAgentAbMetrics(): CodeMemoryLinkAgentAbMetricsV1 {
  const adherence = {
    anchoredRate: 0,
    deltaPercentagePoints: 0,
    minimumScenarioFamilyDeltaPercentagePoints: null,
    noMemoryRate: 0,
    pairedTrials: 0,
    scenarioFamilies: [],
    taskOnlyRate: 0,
    taskOnlyVsNoMemoryDeltaPercentagePoints: 0,
    taskOnlyVsNoMemoryMinimumScenarioFamilyDeltaPercentagePoints: null,
  };
  const hiddenTaskPass = {
    anchoredPassRate: 0,
    deltaPercentagePoints: 0,
    minimumScenarioFamilyDeltaPercentagePoints: null,
    noMemoryPassRate: 0,
    pairedTrials: 0,
    scenarioFamilies: [],
    taskOnlyPassRate: 0,
    taskOnlyVsNoMemoryDeltaPercentagePoints: 0,
    taskOnlyVsNoMemoryMinimumScenarioFamilyDeltaPercentagePoints: null,
  };
  const firstUse = {
    anchoredCensoredTrials: 0,
    anchoredMean: 0,
    minimumScenarioFamilyReductionPercent: null,
    reductionPercent: 0,
    scenarioFamilies: [],
    taskOnlyCensoredTrials: 0,
    taskOnlyMean: 0,
  };
  const totalUsage = {
    minimumScenarioFamilyReductionPercent: null,
    noMemoryMean: 0,
    reductionPercent: 0,
    scenarioFamilies: [],
    taskOnlyMean: 0,
  };
  const negativeControl = {
    anchoredMaximumScenarioFamilyRegressionEventRate: null,
    anchoredMinimumScenarioFamilyPassRate: null,
    anchoredPassRate: 0,
    anchoredRegressionEventRate: 0,
    anchoredRegressionPercentagePoints: 0,
    noMemoryMinimumScenarioFamilyPassRate: null,
    noMemoryPassRate: 0,
    pairedTrials: 0,
    scenarioFamilies: [],
    taskOnlyMaximumScenarioFamilyRegressionEventRate: null,
    taskOnlyMinimumScenarioFamilyPassRate: null,
    taskOnlyPassRate: 0,
    taskOnlyRegressionEventRate: 0,
    taskOnlyRegressionPercentagePoints: 0,
  };
  const accepted = {acceptedTrials: 0, rate: 0, trials: 0};
  return {
    adherence,
    firstUsefulMemoryUse: {steps: firstUse, tokens: firstUse},
    hiddenTaskPass,
    negativeControl,
    perClient: [],
    staleOrHarmfulAcceptance: {anchored: accepted, 'no-memory': accepted, 'task-only': accepted},
    totalTaskUsage: {steps: totalUsage, tokens: totalUsage},
  };
}

function deferredAnchorFixture(candidate: CodeMemoryLinkDogfoodResultV1['candidate']) {
  const commit = candidate.commit;
  const runtime = {executableSha256: candidate.buildIdentityHash, sourceCommit: commit};
  return createCodeMemoryLinkDeferredAnchorObservationV2({
    candidate,
    harnessCommit: commit,
    invocationNonce: 'inv_0123456789abcdef',
    observation: {
      canonicalBodyPreserved: true,
      canonicalIdentityPreserved: true,
      canonicalLifecyclePreserved: true,
      canonicalTimestampsPreserved: true,
      citationsFinalizedAfterPrepare: true,
      directMatchesAfterFinalize: 1,
      directMatchesBeforeFinalize: 0,
      deferredReceiptGuidanceObserved: true,
      durableReceiptMilliseconds: 1,
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
        readySnapshotCommit: commit,
        readySnapshotDirty: false,
        readySnapshotId: `cgsn_${Effect.pipe('a', EffectString.repeat(40))}`,
        stale: false,
      },
      indexingStartedByWrite: false,
      memoryStored: true,
      pendingIntentCountAfterFinalize: 0,
      pendingIntentCountAfterStore: 1,
      pendingMemoryRecallableByTask: true,
      restartBoundary: true,
      strictIndexingStartedByWrite: false,
      strictMemoryStored: false,
      strictReceiptMilliseconds: 1,
      strictRecoveryGuidanceObserved: true,
      strictWriteRejected: true,
    },
    postRuntime: runtime,
    preRuntime: runtime,
    runId: 'run_0123456789abcdef',
  });
}
