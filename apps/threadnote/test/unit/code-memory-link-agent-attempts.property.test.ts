import {sha256HexSync} from '@threadnote/platform/sha256';
import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {
  CODE_MEMORY_LINK_AGENT_AB_SCHEDULE_ALGORITHM_VERSION,
  codeMemoryLinkAgentAbManifestHash,
  deriveCodeMemoryLinkAgentAbScheduleV1,
  type CodeMemoryLinkAgentAbManifestClientV1,
  type CodeMemoryLinkAgentAbManifestTaskV1,
  type CodeMemoryLinkAgentAbManifestV1,
} from '@threadnote/threadnote/evaluation/code-memory-link-agent-ab';
import {
  assertCodeMemoryLinkAgentAttemptLedgerV1,
  CODE_MEMORY_LINK_AGENT_RETRY_REASONS,
  codeMemoryLinkAgentAttemptEventDigest,
  createCodeMemoryLinkAgentAttemptFailedV1,
  createCodeMemoryLinkAgentAttemptStartedV1,
  parseCodeMemoryLinkAgentAttemptsJsonl,
  serializeCodeMemoryLinkAgentAttemptsJsonl,
} from '@threadnote/threadnote/evaluation/code-memory-link-agent-attempts';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';
import {Array as EffectArray, Option as EffectOption} from 'effect';

const HASH = Effect.pipe('a', EffectString.repeat(64));
const COMMIT = Effect.pipe('b', EffectString.repeat(40));
const CLIENTS: readonly CodeMemoryLinkAgentAbManifestClientV1[] = EffectArray.map([1, 2], index => ({
  clientId: 'cli_' + Effect.pipe(index.toString(16), EffectString.padStart(16, '0')),
  configurationProjectionHash: HASH,
  environmentPolicyHash: HASH,
  executionBundleHash: HASH,
  expectedClient: {
    appServerVersion: '0.149.0-alpha.4.1',
    model: 'gpt-5.6-luna',
    modelProvider: 'openai',
    reasoningEffort: 'medium',
  },
  implementationDescriptorHash: Effect.pipe(index.toString(16), EffectString.repeat(64)),
}));
const CONTROL_FAMILIES = [
  'control:ambiguous',
  'control:archived',
  'control:cross-repository',
  'control:deleted',
  'control:harmful-lexical-decoy',
  'control:malformed-citation',
  'control:no-backlink',
  'control:stale-changed',
  'control:superseded',
] as const;
const TASKS: readonly CodeMemoryLinkAgentAbManifestTaskV1[] = EffectArray.makeBy(28, index => ({
  budget: {steps: 10, tokens: 1_000},
  constraintTotal: index < 12 ? 2 : 0,
  expectedResponseHashes: {anchored: HASH, noMemory: HASH, taskOnly: HASH},
  packetHash: sha256HexSync(`fixture-packet-${index}`),
  rubricHash: HASH,
  scenarioFamily:
    index < 12
      ? index < 6
        ? 'hidden:lexical'
        : 'hidden:anchored-only'
      : CONTROL_FAMILIES[(index - 12) % CONTROL_FAMILIES.length],
  taskId: 'tsk_' + Effect.pipe(index.toString(16), EffectString.padStart(16, '0')),
  taskKind: index < 12 ? 'hidden-constraint' : 'negative-control',
}));
const SCHEDULE_SEED = Effect.pipe('f', EffectString.repeat(64));
const manifestInput = {
  adjudicationArtifactHash: HASH,
  assignmentHash: Effect.pipe('d', EffectString.repeat(64)),
  candidate: {buildIdentityHash: HASH, commit: Effect.pipe('1', EffectString.repeat(40)), dirty: false as const},
  clients: CLIENTS,
  evaluatorVersion: 'ver_' + Effect.pipe('2', EffectString.repeat(16)),
  experimentId: 'exp_' + Effect.pipe('3', EffectString.repeat(16)),
  fixtureHash: HASH,
  judgeVersion: 'ver_' + Effect.pipe('4', EffectString.repeat(16)),
  schedule: deriveCodeMemoryLinkAgentAbScheduleV1({
    clients: CLIENTS,
    scheduleAlgorithmVersion: CODE_MEMORY_LINK_AGENT_AB_SCHEDULE_ALGORITHM_VERSION,
    scheduleSeed: SCHEDULE_SEED,
    tasks: TASKS,
  }),
  scheduleAlgorithmVersion: CODE_MEMORY_LINK_AGENT_AB_SCHEDULE_ALGORITHM_VERSION,
  scheduleSeed: SCHEDULE_SEED,
  suiteHash: HASH,
  tasks: TASKS,
  version: 1 as const,
};
const MANIFEST: CodeMemoryLinkAgentAbManifestV1 = {
  ...manifestInput,
  manifestHash: codeMemoryLinkAgentAbManifestHash(manifestInput),
};

describe('Code Memory Link agent attempt ledger', () => {
  it('round-trips every categorical observed failure and detects chain tampering', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(
          ...EffectArray.filter(CODE_MEMORY_LINK_AGENT_RETRY_REASONS, reason => reason !== 'interrupted-attempt'),
        ),
        fc.boolean(),
        (failureKind, includeDiagnostic) => {
          const started = createCodeMemoryLinkAgentAttemptStartedV1({
            approvalCommit: COMMIT,
            assignmentHash: MANIFEST.assignmentHash,
            attemptId: 'attempt_00000000000000000000000000000001',
            blindLabel: MANIFEST.schedule[0].blindLabel,
            clientDescriptorHash: EffectOption.getOrUndefined(
              EffectArray.findFirst(CLIENTS, client => client.clientId === MANIFEST.schedule[0].clientId),
            )!.implementationDescriptorHash,
            clientId: MANIFEST.schedule[0].clientId,
            invocationNonce: 'inv_0000000000000001',
            manifestHash: MANIFEST.manifestHash,
            previousEventDigest: null,
            retryOfAttemptId: null,
            retryReason: null,
            runBindingHash: Effect.pipe('f', EffectString.repeat(64)),
            runNonce: MANIFEST.schedule[0].runNonce,
            runOrder: MANIFEST.schedule[0].runOrder,
            taskId: MANIFEST.schedule[0].taskId,
          });
          const failed = createCodeMemoryLinkAgentAttemptFailedV1({
            attemptId: started.attemptId,
            ...(includeDiagnostic ? {diagnosticHash: HASH} : {}),
            failureKind,
            previousEventDigest: codeMemoryLinkAgentAttemptEventDigest(started),
          });
          const events = [started, failed];
          expect(parseCodeMemoryLinkAgentAttemptsJsonl(serializeCodeMemoryLinkAgentAttemptsJsonl(events))).toEqual(
            events,
          );
          expect(
            assertCodeMemoryLinkAgentAttemptLedgerV1({
              approvalCommit: COMMIT,
              events,
              manifest: MANIFEST,
              trials: [],
            }).requiredRetry,
          ).toEqual({attemptId: started.attemptId, reason: failureKind, runOrder: 0});
          expect(() =>
            assertCodeMemoryLinkAgentAttemptLedgerV1({
              approvalCommit: COMMIT,
              events: [{...started, assignmentHash: HASH}, failed],
              manifest: MANIFEST,
              trials: [],
            }),
          ).toThrow(/frozen schedule/u);
        },
      ),
      {numRuns: 20},
    );
  });
});
