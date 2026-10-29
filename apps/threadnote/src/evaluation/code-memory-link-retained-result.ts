import type {CodeMemoryLinkAgentAbResultV1} from './code-memory-link-agent-ab.js';
import type {CodeMemoryLinkDogfoodResultV1} from './code-memory-link-dogfood.js';
import {Array as EffectArray} from 'effect';

export const CODE_MEMORY_LINK_RETAINED_RESULT_VERSION = 1 as const;

const AGENT_ALLOWLIST_INSUFFICIENCIES = new Set([
  'external evidence hash is not in the code-reviewed release allowlist',
  'manifest hash is not in the code-reviewed release allowlist',
]);
const DOGFOOD_ALLOWLIST_INSUFFICIENCY = 'practical dogfood evidence hash is not in the code-reviewed release allowlist';

export function codeMemoryLinkRetentionBlockers(input: {
  readonly agentAb: CodeMemoryLinkAgentAbResultV1;
  readonly dogfood: CodeMemoryLinkDogfoodResultV1;
}): readonly string[] {
  return [
    ...input.agentAb.gate.qualityFailures,
    ...EffectArray.filter(input.agentAb.gate.insufficiencies, value => !AGENT_ALLOWLIST_INSUFFICIENCIES.has(value)),
    ...input.dogfood.gate.qualityFailures,
    ...EffectArray.filter(input.dogfood.gate.insufficiencies, value => value !== DOGFOOD_ALLOWLIST_INSUFFICIENCY),
  ].sort();
}

/** Outcome-stable projection: source allowlist state is verified only by the later governance transition. */
export function createCodeMemoryLinkRetainedResultV1(input: {
  readonly agentAb: CodeMemoryLinkAgentAbResultV1;
  readonly dogfood: CodeMemoryLinkDogfoodResultV1;
}) {
  const {agentAb, dogfood} = input;
  return {
    agentAb: {
      assignmentHash: agentAb.assignmentHash,
      candidate: agentAb.candidate,
      evidence: {
        distinctClients: agentAb.evidence.distinctClients,
        eligibleExternalTrials: agentAb.evidence.eligibleExternalTrials,
        excludedMockTrials: agentAb.evidence.excludedMockTrials,
        externalEvidenceHash: agentAb.evidence.externalEvidenceHash,
        hiddenTasks: agentAb.evidence.hiddenTasks,
        manifestApprovalCommit: agentAb.evidence.manifestApprovalCommit,
        negativeControlTasks: agentAb.evidence.negativeControlTasks,
        pairedBlocks: agentAb.evidence.pairedBlocks,
        retainedEvidenceReceipts: agentAb.evidence.retainedEvidenceReceipts,
      },
      fixtureHash: agentAb.fixtureHash,
      manifestHash: agentAb.manifestHash,
      metrics: agentAb.metrics,
      qualityGate: {
        failures: agentAb.gate.qualityFailures,
        status: agentAb.gate.qualityFailures.length === 0 ? ('passed' as const) : ('failed' as const),
      },
      suiteHash: agentAb.suiteHash,
      version: agentAb.version,
    },
    dogfood: {
      artifactHash: dogfood.artifactHash,
      candidate: dogfood.candidate,
      deferredAnchorLifecycle: dogfood.deferredAnchorLifecycle,
      harnessCommit: dogfood.harnessCommit,
      observations: dogfood.observations,
      qualityGate: {
        failures: dogfood.gate.qualityFailures,
        status: dogfood.gate.qualityFailures.length === 0 ? ('passed' as const) : ('failed' as const),
      },
      version: dogfood.version,
    },
    type: 'code-memory-link-retained-scored-result' as const,
    version: CODE_MEMORY_LINK_RETAINED_RESULT_VERSION,
  };
}
