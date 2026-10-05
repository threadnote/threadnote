#!/usr/bin/env bun

/* oxlint-disable threadnote/no-node-runtime, effecttsgo/node-builtin-import -- This evaluation runner owns pinned local executable, artifact, and process-group boundaries. */

import * as BunRuntime from '@effect/platform-bun/BunRuntime';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {createHash} from 'node:crypto';
import {cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, extname, isAbsolute, join, relative, resolve, sep} from 'node:path';
import {Effect} from 'effect';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import {
  matchedEvaluationReferenceEnvironmentPolicyV1,
  matchedEvaluationPromptHashV1,
  parseMatchedEvaluationCorpusV1,
  parseMatchedEvaluationManifestV1,
  type MatchedEvaluationManifestV1,
  type MatchedEvaluationArm,
  type MatchedEvaluationArmDefinitionV1,
  MATCHED_EVALUATION_ARMS,
} from '@threadnote/threadnote/evaluation/matched-evaluation';
import {
  parseMatchedEvaluationObservationV1,
  parseMatchedEvaluationOutcomesJsonlV1,
  runMatchedEvaluationV1,
  summarizeMatchedEvaluationV1,
  type MatchedEvaluationRunRequestV1,
  type MatchedEvaluationUnavailableReason,
} from '@threadnote/threadnote/evaluation/matched-evaluation-runner';
import {
  createMatchedContinuationPhaseTwoVerificationCheckReceiptV1,
  createMatchedContinuationPhaseTwoVerificationPlanV1,
  createMatchedContinuationPhaseTwoVerificationReceiptV1,
  parseMatchedContinuationFailureIdsV1,
  parseMatchedContinuationPhaseTwoVerificationReceiptV1,
  parseMatchedContinuationPhaseTwoVerificationPlanV1,
  type MatchedContinuationPhaseTwoDiagnosticParser,
  type MatchedContinuationPhaseTwoVerificationCheckReceiptV1,
  type MatchedContinuationPhaseTwoVerificationPlanV1,
  type MatchedContinuationPhaseTwoVerificationReceiptV1,
  type MatchedEvaluationVerificationCalibrationV1,
} from '@threadnote/threadnote/evaluation/matched-verification';
import {
  assertMatchedTokenEfficiencyObservationContextV1,
  assertMatchedTokenEfficiencyStudyMatchesV1,
  createMatchedTokenEfficiencyTaskContextV1,
  evaluateMatchedTokenEfficiencyV1,
  matchedTokenEfficiencyCitationHashV1,
  matchedTokenEfficiencyGraphContentHashV1,
  matchedTokenEfficiencyGraphSnapshotHashV1,
  parseMatchedTokenEfficiencyStudyV1,
  renderMatchedTokenEfficiencyArticleEvidenceV1,
  type MatchedTokenEfficiencyStudyV1,
} from '@threadnote/threadnote/evaluation/matched-token-efficiency';
import {captureCodeMemoryLinkProcessGroup} from './code-memory-link-process-boundary.js';
import {tokenizeCodeMemoryLinkCommandV1} from './code-memory-link-app-server-policy.js';
import {
  matchedEvaluationDependencyProjectionFixtureHashV1,
  materializeMatchedEvaluationDependencyProjectionV1,
  matchedEvaluationPreparedHomeFixtureHashV1,
  parseMatchedEvaluationCodexAdapterConfigV1,
  type MatchedEvaluationDependencyProjectionV1,
} from './matched-evaluation-codex-adapter.js';
import {provideScriptLayer, ScriptError} from './effect/errors.js';
import {scriptArguments} from './effect/script.js';
import {
  assertMatchedEvaluationPinnedFileV1,
  assertMatchedEvaluationRepositoryV1,
  compareAndSwapMatchedEvaluationLedgerV1,
  observeMatchedEvaluationRepositoryV1,
  type MatchedEvaluationRepositoryObservationV1,
  stageMatchedEvaluationPinnedFileV1,
  withMatchedEvaluationArtifactLockV1,
} from './matched-evaluation-runtime-integrity.js';

export const MATCHED_EVALUATION_RUNTIME_VERSION = 4 as const;

export interface MatchedEvaluationRuntimeV1 {
  readonly arms: readonly MatchedEvaluationRuntimeArmV1[];
  readonly artifactDirectory: string;
  readonly repositories: readonly MatchedEvaluationRuntimeRepositoryV1[];
  readonly timeoutMilliseconds: number;
  readonly verificationPlanHash: string | null;
  readonly version: typeof MATCHED_EVALUATION_RUNTIME_VERSION;
}

export interface MatchedEvaluationRuntimeArmV1 {
  readonly adapterArguments: readonly string[];
  readonly adapterConfigFile: string;
  readonly adapterExecutable: string;
  readonly arm: MatchedEvaluationArm;
  readonly environmentKeys: readonly string[];
  readonly toolExecutable: string | null;
  readonly toolLockFile: string | null;
}

export interface MatchedEvaluationRuntimeRepositoryV1 {
  readonly clusterId: string | null;
  readonly repositoryDirectory: string;
  readonly repositoryIdentityHash: string;
}

export function projectMatchedEvaluationAdapterTaskV1(
  request: Pick<MatchedEvaluationRunRequestV1, 'arm' | 'task'>,
  study: MatchedTokenEfficiencyStudyV1 | null,
) {
  const taskContext = study?.taskContexts.find(context => context.taskId === request.task.taskId) ?? null;
  if (study !== null && taskContext === null) {
    throw new Error(`Token-efficiency study has no prepared context for ${request.task.taskId}.`);
  }
  return {
    agentTask: {
      category: request.task.category,
      /** Memory contents must be discovered through the pinned arm, never injected into an adapter request. */
      memoryFixtures: [] as const,
      prompt: request.task.prompt,
      repositoryFixtureHash: request.task.repositoryFixtureHash,
      taskId: request.task.taskId,
      variant: request.task.variant,
    },
    preparedContext:
      request.arm === 'threadnote-compact' || request.arm === 'threadnote-source'
        ? {memoryAccess: 'linked' as const, studyHash: study?.studyHash ?? null, taskContext}
        : request.arm === 'threadnote-graph'
          ? {
              graphContext:
                taskContext === null
                  ? null
                  : {
                      clusterId: taskContext.clusterId,
                      graphContentHash: taskContext.graphContentHash,
                      graphSnapshotHash: taskContext.graphSnapshotHash,
                      repositoryFixtureHash: taskContext.repositoryFixtureHash,
                      taskId: taskContext.taskId,
                    },
              memoryAccess: 'disabled' as const,
              studyHash: study?.studyHash ?? null,
            }
          : null,
  };
}

export function projectMatchedEvaluationContinuationAdapterTaskV2(
  request: Pick<MatchedEvaluationRunRequestV1, 'arm' | 'task'>,
  study: MatchedTokenEfficiencyStudyV1,
  plan: MatchedEvaluationContinuationPilotPlanCurrent,
) {
  const sourceContext = study.taskContexts.find(context => context.taskId === request.task.taskId);
  if (sourceContext === undefined) {
    throw new Error(`Token-efficiency study has no prepared context for ${request.task.taskId}.`);
  }
  const prepared = plan.checkpoint.preparedContext;
  return {
    agentTask: {
      category: request.task.category,
      memoryFixtures: [] as const,
      prompt: plan.phaseTwoPrompt,
      repositoryFixtureHash: plan.checkpoint.repositoryFixtureHash,
      taskId: request.task.taskId,
      variant: request.task.variant,
    },
    preparedContext:
      request.arm === 'threadnote-compact'
        ? {
            memoryAccess: 'linked' as const,
            studyHash: study.studyHash,
            taskContext: {
              ...sourceContext,
              graphContentHash: prepared.graphContentHash,
              graphSnapshotHash: prepared.graphSnapshotHash,
              linkReceiptsHash: prepared.linkReceiptsHash,
              repositoryFixtureHash: plan.checkpoint.repositoryFixtureHash,
              taskContextHash: prepared.taskContextHash,
            },
          }
        : request.arm === 'threadnote-graph'
          ? {
              graphContext: {
                clusterId: sourceContext.clusterId,
                graphContentHash: prepared.graphContentHash,
                graphSnapshotHash: prepared.graphSnapshotHash,
                repositoryFixtureHash: plan.checkpoint.repositoryFixtureHash,
                taskId: request.task.taskId,
              },
              memoryAccess: 'disabled' as const,
              studyHash: study.studyHash,
            }
          : null,
  };
}

type MatchedEvaluationProjectedAdapterTask = ReturnType<typeof projectMatchedEvaluationAdapterTaskV1>;

export interface MatchedEvaluationContinuationPhaseOneTaskPacketV1 {
  readonly phaseOneAllowedPaths: readonly string[];
  readonly phaseOneDirective: string;
  readonly phaseOneFocusedChecks: readonly string[];
  readonly phaseTwoFocusedChecks: readonly string[];
  readonly phaseTwoPrompt: string;
  readonly repositoryName: string;
  readonly sourceRevision: string;
  readonly sourceTaskPrompt: string;
  readonly status: 'draft-unsealed';
  readonly taskKey: string;
  readonly version: 1;
}

export interface MatchedEvaluationContinuationPhaseOneTaskPacketV2 extends Omit<
  MatchedEvaluationContinuationPhaseOneTaskPacketV1,
  'version'
> {
  readonly phaseTwoProtectedPaths: readonly string[];
  readonly treatmentSet: 'matched-context-v1';
  readonly version: 2;
}

export interface MatchedEvaluationContinuationPhaseOneTaskPacketV3 extends Omit<
  MatchedEvaluationContinuationPhaseOneTaskPacketV1,
  'version'
> {
  readonly phaseTwoProtectedPaths: readonly string[];
  readonly treatmentSet: 'automated-context-v1';
  readonly version: 3;
}

export interface MatchedEvaluationContinuationPhaseOneTaskPacketV4 extends Omit<
  MatchedEvaluationContinuationPhaseOneTaskPacketV1,
  'version'
> {
  readonly phaseTwoProtectedPaths: readonly string[];
  readonly treatmentSet: 'automated-context-graph-v1';
  readonly version: 4;
}

export type MatchedEvaluationContinuationPhaseOneTaskPacket =
  | MatchedEvaluationContinuationPhaseOneTaskPacketV1
  | MatchedEvaluationContinuationPhaseOneTaskPacketV2
  | MatchedEvaluationContinuationPhaseOneTaskPacketV3
  | MatchedEvaluationContinuationPhaseOneTaskPacketV4;

export interface MatchedEvaluationContinuationPhaseOneSelectionV1 {
  readonly continuationAttempts: MatchedEvaluationContinuationPilotPlanV2['attempts'];
  readonly phaseOnePrompt: string;
  readonly phaseOnePromptSha256: string;
  readonly phaseOneRunNonce: string;
  readonly sourceTask: MatchedEvaluationContinuationPilotPlanV2['sourceTask'];
  readonly taskPacket: MatchedEvaluationContinuationPhaseOneTaskPacket;
  readonly taskPacketSha256: string;
  readonly version: 1;
}

export interface MatchedEvaluationContinuationPhaseOneReceiptV1 {
  readonly continuationAttempts: MatchedEvaluationContinuationPhaseOneSelectionV1['continuationAttempts'];
  readonly evidenceSha256: {
    readonly adapterArtifactHash: string;
    readonly adapterConfigurationFileSha256: string;
    readonly artifactSha256: string;
    readonly requestSha256: string;
    readonly responseSha256: string;
    readonly transcriptSha256: string;
  };
  readonly metrics: ReturnType<typeof parseMatchedEvaluationObservationV1>['metrics'];
  readonly phaseOnePromptSha256: string;
  readonly phaseOneRunNonce: string;
  readonly selectionSha256: string;
  readonly taskId: string;
  readonly taskPacketSha256: string;
  readonly transcriptHash: string;
  readonly version: 1;
}

export interface ResolvedRuntimeArm {
  readonly config: MatchedEvaluationRuntimeArmV1;
  readonly adapterConfigFile: string;
  readonly definition: MatchedEvaluationArmDefinitionV1;
  readonly toolExecutable: string | null;
  readonly toolPayload?: {readonly root: string; readonly hash: string};
}

export interface MatchedEvaluationContinuationAdapterConfigOverrideV2 {
  readonly adapterConfigFile: string;
  readonly adapterConfigurationHash: string;
}

export function matchedEvaluationContinuationAdapterConfigurationPathsV2(planPath: string) {
  const root = join(dirname(planPath), 'checkpoint-adapter-config');
  return {
    'threadnote-compact': join(root, 'threadnote-compact.json'),
    'threadnote-graph': join(root, 'threadnote-graph.json'),
  } as const;
}

export async function assertMatchedEvaluationContinuationAdapterConfigurationsV2(input: {
  readonly manifest: MatchedEvaluationManifestV1;
  readonly plan: MatchedEvaluationContinuationPilotPlanCurrent;
  readonly planPath: string;
  readonly requiredArms: ReadonlySet<'threadnote-compact' | 'threadnote-graph'>;
  readonly runtime: MatchedEvaluationRuntimeV1;
}): Promise<
  ReadonlyMap<'threadnote-compact' | 'threadnote-graph', MatchedEvaluationContinuationAdapterConfigOverrideV2>
> {
  const paths = matchedEvaluationContinuationAdapterConfigurationPathsV2(input.planPath);
  const specifications = [
    {
      arm: 'threadnote-graph' as const,
      expectedContext: {
        graphContentHash: input.plan.checkpoint.preparedContext.graphContentHash,
        graphSnapshotHash: input.plan.checkpoint.preparedContext.graphSnapshotHash,
        linkReceiptsHash: null,
        memoryAccess: 'disabled' as const,
        taskContextHash: null,
      },
      expectedHash: input.plan.checkpoint.adapterConfigurations.threadnoteGraphSha256,
      preparedHome: input.plan.checkpoint.preparedGraphHome,
    },
    {
      arm: 'threadnote-compact' as const,
      expectedContext: {
        graphContentHash: input.plan.checkpoint.preparedContext.graphContentHash,
        graphSnapshotHash: input.plan.checkpoint.preparedContext.graphSnapshotHash,
        linkReceiptsHash: input.plan.checkpoint.preparedContext.linkReceiptsHash,
        memoryAccess: 'linked' as const,
        taskContextHash: input.plan.checkpoint.preparedContext.taskContextHash,
      },
      expectedHash: input.plan.checkpoint.adapterConfigurations.threadnoteCompactSha256,
      preparedHome: input.plan.checkpoint.preparedHome,
    },
  ];
  const overrides = await Promise.all(
    specifications
      .filter(specification => input.requiredArms.has(specification.arm))
      .map(async specification => {
        const definition = input.manifest.arms.find(candidate => candidate.arm === specification.arm);
        if (definition === undefined) throw new Error(`Continuation manifest lacks ${specification.arm}.`);
        const runtimeArm = input.runtime.arms.find(candidate => candidate.arm === specification.arm);
        if (runtimeArm === undefined) throw new Error(`Continuation runtime lacks ${specification.arm}.`);
        const [sourceConfigFile, checkpointConfigFile] = await Promise.all([
          canonicalRegularFile(runtimeArm.adapterConfigFile, `${specification.arm} source adapter configuration`),
          canonicalRegularFile(paths[specification.arm], `${specification.arm} checkpoint adapter configuration`),
        ]);
        const [sourceHash, checkpointHash, sourceInput, checkpointInput] = await Promise.all([
          sha256File(sourceConfigFile),
          sha256File(checkpointConfigFile),
          readJson(sourceConfigFile),
          readJson(checkpointConfigFile),
        ]);
        if (sourceHash !== definition.adapterConfigurationHash) {
          throw new Error(`${specification.arm} source adapter configuration differs from its manifest identity.`);
        }
        if (checkpointHash !== specification.expectedHash) {
          throw new Error(`${specification.arm} checkpoint adapter configuration differs from the sealed plan.`);
        }
        const source = parseMatchedEvaluationCodexAdapterConfigV1(sourceInput);
        const checkpoint = parseMatchedEvaluationCodexAdapterConfigV1(checkpointInput);
        const {contextHomes: _sourceHomes, ...sourcePolicy} = source;
        const {contextHomes, ...checkpointPolicy} = checkpoint;
        if (JSON.stringify(sourcePolicy) !== JSON.stringify(checkpointPolicy)) {
          throw new Error(`${specification.arm} checkpoint adapter configuration changes the frozen execution policy.`);
        }
        if (contextHomes.length !== 1 || contextHomes[0]?.taskId !== input.plan.taskId) {
          throw new Error(`${specification.arm} checkpoint adapter configuration must contain only its task home.`);
        }
        const home = contextHomes[0];
        if (
          JSON.stringify(home.expectedContext) !== JSON.stringify(specification.expectedContext) ||
          home.homeFixtureHash !== specification.preparedHome.fixtureHash ||
          matchedEvaluationContinuationPreparedHomeIdentityHashV2(home) !== specification.preparedHome.identitySha256
        ) {
          throw new Error(`${specification.arm} checkpoint prepared home differs from the sealed plan.`);
        }
        await canonicalDirectory(home.homeDirectory, `${specification.arm} checkpoint prepared home`);
        if ((await matchedEvaluationPreparedHomeFixtureHashV1(home.homeDirectory)) !== home.homeFixtureHash) {
          throw new Error(`${specification.arm} checkpoint prepared home differs from its fixture hash.`);
        }
        return [
          specification.arm,
          {adapterConfigFile: checkpointConfigFile, adapterConfigurationHash: checkpointHash},
        ] as const;
      }),
  );
  return new Map(overrides);
}

export async function prepareMatchedEvaluationContinuationAdapterRuntimeOverridesV1(input: {
  readonly arms: readonly ('files' | 'threadnote-compact' | 'threadnote-graph')[];
  readonly checkpointOverrides: ReadonlyMap<
    'threadnote-compact' | 'threadnote-graph',
    MatchedEvaluationContinuationAdapterConfigOverrideV2
  >;
  readonly checkpointRepository: string;
  readonly manifest: MatchedEvaluationManifestV1;
  readonly outputDirectory: string;
  readonly plan: MatchedEvaluationContinuationPilotPlanCurrent;
  readonly runtime: MatchedEvaluationRuntimeV1;
}): Promise<ReadonlyMap<MatchedEvaluationArm, MatchedEvaluationContinuationAdapterConfigOverrideV2>> {
  const checkpointRepository = await realpath(input.checkpointRepository);
  const observedCheckpoint = await observeMatchedEvaluationRepositoryV1(checkpointRepository);
  if (
    observedCheckpoint.dirty ||
    observedCheckpoint.fixtureHash !== input.plan.checkpoint.repositoryFixtureHash ||
    observedCheckpoint.revision !== input.plan.checkpoint.repositoryRevision
  ) {
    throw new Error('Continuation adapter runtime projection differs from the sealed checkpoint.');
  }
  const outputDirectory = resolve(input.outputDirectory, 'continuation-runtime-config');
  await mkdir(outputDirectory, {recursive: true, mode: 0o700});
  const overrides = await Promise.all(
    input.arms.map(async arm => {
      const definition = input.manifest.arms.find(candidate => candidate.arm === arm);
      const runtimeArm = input.runtime.arms.find(candidate => candidate.arm === arm);
      if (definition === undefined || runtimeArm === undefined) {
        throw new Error(`Continuation runtime lacks ${arm}.`);
      }
      const sourceConfigFile = await canonicalRegularFile(
        runtimeArm.adapterConfigFile,
        `${arm} source adapter configuration`,
      );
      if ((await sha256File(sourceConfigFile)) !== definition.adapterConfigurationHash) {
        throw new Error(`${arm} source adapter configuration differs from its manifest identity.`);
      }
      const baseConfigFile =
        input.checkpointOverrides.get(arm as 'threadnote-compact' | 'threadnote-graph')?.adapterConfigFile ??
        sourceConfigFile;
      const baseConfig = parseMatchedEvaluationCodexAdapterConfigV1(await readJson(baseConfigFile));
      const dependencyProjection = dependencyProjectionForTaskV1(baseConfig, input.plan.taskId);
      let runtimeConfig = baseConfig;
      if (dependencyProjection !== null) {
        await ensureMatchedEvaluationDependencyProjectionV1({
          projection: dependencyProjection,
          repositoryDirectory: checkpointRepository,
        });
        const checkpointDependencyDirectory = await realpath(
          resolve(checkpointRepository, dependencyProjection.targetRelativePath),
        );
        if (
          (await matchedEvaluationDependencyProjectionFixtureHashV1(
            checkpointDependencyDirectory,
            checkpointRepository,
          )) !== dependencyProjection.fixtureHash
        ) {
          throw new Error(`${arm} checkpoint dependency projection differs from its pinned fixture hash.`);
        }
        runtimeConfig = {
          ...baseConfig,
          dependencyProjections: baseConfig.dependencyProjections.map(projection =>
            projection.taskId === input.plan.taskId
              ? {
                  ...projection,
                  sourceDirectory: checkpointDependencyDirectory,
                  sourceRepositoryDirectory: checkpointRepository,
                }
              : projection,
          ),
        };
      }
      const runtimeConfigText = `${JSON.stringify(runtimeConfig, undefined, 2)}\n`;
      const runtimeConfigPath = resolve(outputDirectory, `${arm}.json`);
      const existing = await readOptionalTextOrNull(runtimeConfigPath, MAXIMUM_JSON_BYTES);
      if (existing === null) {
        await writeFile(runtimeConfigPath, runtimeConfigText, {encoding: 'utf8', flag: 'wx', mode: 0o600});
      } else if (existing !== runtimeConfigText) {
        throw new Error(`${arm} continuation runtime configuration changed across recovery.`);
      }
      parseMatchedEvaluationCodexAdapterConfigV1(JSON.parse(runtimeConfigText) as unknown);
      return [
        arm,
        {
          adapterConfigFile: runtimeConfigPath,
          adapterConfigurationHash: sha256Bytes(Buffer.from(runtimeConfigText)),
        },
      ] as const;
    }),
  );
  return new Map(overrides);
}

export interface ResolvedRuntimeRepository {
  readonly clusterId: string | null;
  readonly expected: MatchedEvaluationRepositoryObservationV1;
  readonly repositoryDirectory: string;
}

export function selectMatchedEvaluationPilotRowsV1(
  manifest: Pick<MatchedEvaluationManifestV1, 'activeArms' | 'blindAssignment' | 'schedule'>,
  taskId: string,
) {
  const expectedArms = ['files', 'threadnote-graph', 'threadnote-compact'] as const;
  if (manifest.activeArms === undefined || JSON.stringify([...manifest.activeArms]) !== JSON.stringify(expectedArms)) {
    throw new Error('Pilot requires manifest.activeArms to be exactly files, threadnote-graph, threadnote-compact.');
  }
  const rows = manifest.schedule.filter(row => row.taskId === taskId);
  if (rows.length === 0) throw new Error(`Pilot task ${taskId} is not in the manifest schedule.`);
  const firstRepetition = Math.min(...rows.map(row => row.repetition));
  const selected = rows.filter(row => row.repetition === firstRepetition);
  if (
    selected.length !== 3 ||
    new Set(selected.map(row => manifest.blindAssignment[row.blindLabel])).size !== 3 ||
    selected.some(
      row => !expectedArms.includes(manifest.blindAssignment[row.blindLabel] as (typeof expectedArms)[number]),
    )
  ) {
    throw new Error('Pilot could not select exactly one first-repetition row per active arm.');
  }
  return [...selected].sort((left, right) => left.runOrder - right.runOrder);
}

const BASE_CONTINUATION_VARIANTS = ['files-bare', 'manual-handoff', 'threadnote-graph', 'threadnote-resume'] as const;
const CONTINUATION_VARIANTS = [...BASE_CONTINUATION_VARIANTS, 'threadnote-preloaded-resume'] as const;
const AUTOMATED_CONTEXT_CONTINUATION_VARIANTS = ['files-bare', 'threadnote-preloaded-resume'] as const;
const MATCHED_CONTEXT_CONTINUATION_VARIANTS = ['files-bare', 'manual-handoff', 'threadnote-preloaded-resume'] as const;

type MatchedEvaluationContinuationVariantV1 = (typeof CONTINUATION_VARIANTS)[number];

export interface MatchedEvaluationContinuationTreatmentV1 {
  readonly automaticHandoffUri: string | null;
  readonly contextMode: 'brief' | 'resume' | null;
  readonly manualHandoff: string | null;
  readonly manualHandoffSha256: string | null;
  readonly requiredGraphQuery: string | null;
  readonly resumeEvidenceMarker: string | null;
  readonly variant: MatchedEvaluationContinuationVariantV1;
}

export interface MatchedEvaluationContinuationDiagnosticEvidenceV1 {
  readonly diagnosticConclusion: string;
  readonly graphQuery: string;
  readonly graphQuestion: string;
  readonly rejectedHypothesis: string;
  readonly sourceCitations: readonly {
    readonly endLine: number;
    readonly path: string;
    readonly startLine: number;
  }[];
  readonly unresolvedGap: string;
  readonly untestedInvariant: string;
  readonly verifiedInvariant: string;
}

export interface MatchedEvaluationContinuationPilotPlanV1 {
  readonly attempts: readonly {
    readonly blindLabel: 'A' | 'B' | 'C' | 'D' | 'E';
    readonly runNonce: string;
    readonly runOrder: number;
    readonly variant: MatchedEvaluationContinuationVariantV1;
  }[];
  readonly baseTaskPromptSha256: string;
  readonly candidate: {readonly toolArtifactHash: string; readonly toolVersion: string};
  readonly checkpoint: {
    readonly automaticHandoffUri: string;
    readonly handoff: string;
    readonly handoffSha256: string;
    readonly phaseOneAccounting: {
      readonly elapsedMilliseconds: number;
      readonly providerTokens: {
        readonly cachedInputTokens: number;
        readonly inputTokens: number;
        readonly outputTokens: number;
        readonly reasoningOutputTokens: number;
        readonly totalTokens: number;
      } | null;
      readonly providerTokensMeasured: boolean;
    };
    readonly repositoryFixtureHash: string;
    readonly repositoryRevision: string;
    readonly resumeEvidenceMarker: string;
    readonly automaticHandoffReadSha256: string;
  };
  readonly retries: 0;
  readonly taskId: string;
  readonly version: 1;
}

export interface MatchedEvaluationContinuationPilotPlanV2 {
  readonly attempts: MatchedEvaluationContinuationPilotPlanV1['attempts'];
  readonly candidate: MatchedEvaluationContinuationPilotPlanV1['candidate'];
  readonly checkpoint: MatchedEvaluationContinuationPilotPlanV1['checkpoint'] & {
    readonly adapterConfigurations: {
      readonly threadnoteCompactSha256: string;
      readonly threadnoteGraphSha256: string;
    };
    readonly phaseOnePatchSha256: string;
    readonly phaseOnePrompt: string;
    readonly phaseOnePromptSha256: string;
    readonly phaseOneExecution: {
      readonly adapterArtifactHash: string;
      readonly adapterConfigurationFileSha256: string;
      readonly adapterConfigurationHash: string;
      readonly adapterProtocol: string;
      readonly appServerExecutableSha256: string;
      readonly appServerVersion: string;
      readonly artifactSha256: string;
      readonly environmentPolicyHash: string;
      readonly model: {
        readonly id: string;
        readonly parametersHash: string;
        readonly provider: string;
        readonly reasoningEffort: string;
      };
      readonly requestSha256: string;
      readonly responseSha256: string;
      readonly runNonce: string;
      readonly transcriptHash: string;
      readonly transcriptSha256: string;
    };
    readonly preparedHome: {
      readonly fixtureHash: string;
      readonly identitySha256: string;
    };
    readonly preparedGraphHome: {
      readonly fixtureHash: string;
      readonly identitySha256: string;
    };
    readonly preparedContext: {
      readonly graphContentHash: string;
      readonly graphSnapshotHash: string;
      readonly linkReceiptsHash: string;
      readonly taskContextHash: string;
    };
  };
  readonly phaseTwoPrompt: string;
  readonly phaseTwoPromptSha256: string;
  readonly retries: 0;
  readonly sourceTask: {
    readonly prompt: string;
    readonly promptSha256: string;
    readonly repositoryFixtureHash: string;
    readonly repositoryRevision: string;
    readonly taskId: string;
  };
  readonly taskId: string;
  readonly version: 2;
}

export interface MatchedEvaluationContinuationPilotPlanV3 extends Omit<
  MatchedEvaluationContinuationPilotPlanV2,
  'version'
> {
  readonly phaseTwoVerification: MatchedContinuationPhaseTwoVerificationPlanV1;
  readonly version: 3;
}

export interface MatchedEvaluationContinuationPilotPlanV4 extends Omit<
  MatchedEvaluationContinuationPilotPlanV3,
  'checkpoint' | 'version'
> {
  readonly checkpoint: MatchedEvaluationContinuationPilotPlanV3['checkpoint'] & {
    readonly diagnosticEvidence: MatchedEvaluationContinuationDiagnosticEvidenceV1;
  };
  readonly version: 4;
}

type MatchedEvaluationContinuationVerifiedPilotPlan =
  MatchedEvaluationContinuationPilotPlanV3 | MatchedEvaluationContinuationPilotPlanV4;

export type MatchedEvaluationContinuationPilotPlanCurrent =
  | MatchedEvaluationContinuationPilotPlanV2
  | MatchedEvaluationContinuationPilotPlanV3
  | MatchedEvaluationContinuationPilotPlanV4;

export type MatchedEvaluationContinuationPilotPlan =
  MatchedEvaluationContinuationPilotPlanV1 | MatchedEvaluationContinuationPilotPlanCurrent;

export function parseMatchedEvaluationContinuationPhaseOneTaskPacketV1(
  value: unknown,
): MatchedEvaluationContinuationPhaseOneTaskPacket {
  const packet = object(value, 'continuation phase-one task packet');
  const version = packet.version;
  exactKeys(
    packet,
    [
      'phaseOneAllowedPaths',
      ...(version === 2 || version === 3 || version === 4 ? ['phaseTwoProtectedPaths'] : []),
      'phaseOneDirective',
      'phaseOneFocusedChecks',
      'phaseTwoFocusedChecks',
      'phaseTwoPrompt',
      'repositoryName',
      'sourceRevision',
      'sourceTaskPrompt',
      'status',
      'taskKey',
      ...(version === 2 || version === 3 || version === 4 ? ['treatmentSet'] : []),
      'version',
    ],
    'continuation phase-one task packet',
  );
  if ((version !== 1 && version !== 2 && version !== 3 && version !== 4) || packet.status !== 'draft-unsealed') {
    invalid('continuation phase-one task packet version or status is invalid');
  }
  const paths = stringArray(packet.phaseOneAllowedPaths, 1, 16, 4_096, 'phase-one allowed paths');
  if (new Set(paths).size !== paths.length || paths.some(path => !isSafeContinuationRepositoryPath(path))) {
    invalid('continuation phase-one allowed paths are invalid');
  }
  const phaseTwoProtectedPaths =
    version === 2 || version === 3 || version === 4
      ? stringArray(packet.phaseTwoProtectedPaths, 1, 64, 4_096, 'phase-two protected paths')
      : undefined;
  if (
    phaseTwoProtectedPaths &&
    (new Set(phaseTwoProtectedPaths).size !== phaseTwoProtectedPaths.length ||
      phaseTwoProtectedPaths.some(path => !isSafeContinuationRepositoryPath(path)))
  ) {
    invalid('continuation phase-two protected paths are invalid');
  }
  const common = {
    phaseOneAllowedPaths: paths,
    phaseOneDirective: boundedString(packet.phaseOneDirective, 1, 8_000, 'phase-one directive'),
    phaseOneFocusedChecks: stringArray(packet.phaseOneFocusedChecks, 1, 8, 4_096, 'phase-one focused checks'),
    phaseTwoFocusedChecks: stringArray(packet.phaseTwoFocusedChecks, 1, 8, 4_096, 'phase-two focused checks'),
    phaseTwoPrompt: boundedString(packet.phaseTwoPrompt, 1, 12_000, 'phase-two prompt'),
    repositoryName: matchingString(packet.repositoryName, /^[a-z0-9][a-z0-9._-]{1,127}$/u, 'repository name'),
    sourceRevision: matchingString(packet.sourceRevision, /^[0-9a-f]{40}$/u, 'source revision'),
    sourceTaskPrompt: boundedString(packet.sourceTaskPrompt, 1, 12_000, 'source task prompt'),
    status: 'draft-unsealed' as const,
    taskKey: matchingString(packet.taskKey, /^[a-z][a-z0-9-]{2,127}$/u, 'task key'),
  };
  if (version === 1) return {...common, version};
  if (version === 2) {
    return {
      ...common,
      phaseTwoProtectedPaths: phaseTwoProtectedPaths!,
      treatmentSet: literal(packet.treatmentSet, ['matched-context-v1'] as const, 'continuation treatment set'),
      version,
    };
  }
  if (version === 3) {
    return {
      ...common,
      phaseTwoProtectedPaths: phaseTwoProtectedPaths!,
      treatmentSet: literal(packet.treatmentSet, ['automated-context-v1'] as const, 'continuation treatment set'),
      version,
    };
  }
  return {
    ...common,
    phaseTwoProtectedPaths: phaseTwoProtectedPaths!,
    treatmentSet: literal(packet.treatmentSet, ['automated-context-graph-v1'] as const, 'continuation treatment set'),
    version,
  };
}

function isSafeContinuationRepositoryPath(path: string): boolean {
  return (
    !isAbsolute(path) &&
    !path.startsWith('.') &&
    !path.includes('\\') &&
    path.split('/').every(segment => segment.length > 0 && segment !== '.' && segment !== '..')
  );
}

const CONTINUATION_PRODUCTION_SOURCE_EXTENSIONS = new Set([
  '.c',
  '.cc',
  '.cpp',
  '.cs',
  '.go',
  '.h',
  '.hpp',
  '.java',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.php',
  '.py',
  '.rb',
  '.rs',
  '.sh',
  '.swift',
  '.ts',
  '.tsx',
  '.vue',
]);

function isContinuationProductionSourcePath(path: string): boolean {
  const segments = path.toLowerCase().split('/');
  if (
    segments.some(segment =>
      /^(?:test|tests|__tests__|testdata|docs?|examples?|samples?|fixture|fixtures|__fixtures__|mock|mocks|__mocks__|generated|__generated__|dist|build|coverage)$/u.test(
        segment,
      ),
    )
  ) {
    return false;
  }
  const filename = segments.at(-1) ?? '';
  if (
    /(?:^|[._-])(?:test|spec|fixture|fixtures|mock|mocks|generated)(?:[._-]|$)/u.test(filename) ||
    /__generated__/u.test(filename)
  )
    return false;
  return CONTINUATION_PRODUCTION_SOURCE_EXTENSIONS.has(extname(path).toLowerCase());
}

/** Validate v4 anchors against a bounded view of regular tracked checkpoint files. */
export function assertMatchedEvaluationContinuationDiagnosticSourceCitationsV1(input: {
  readonly changedPaths: readonly string[];
  readonly phaseOneAllowedPaths: readonly string[];
  readonly sourceCitations: MatchedEvaluationContinuationDiagnosticEvidenceV1['sourceCitations'];
  readonly trackedRegularFiles: ReadonlyMap<string, string>;
}): void {
  assertMatchedEvaluationContinuationDiagnosticSourceCitationPathsV1(input);
  for (const citation of input.sourceCitations) {
    const content = input.trackedRegularFiles.get(citation.path)!;
    const lineCount = matchedEvaluationContinuationLineCountV1(content);
    if (citation.endLine > lineCount) {
      throw new Error(
        `Continuation diagnostic citation is out of bounds: ${citation.path}:${citation.startLine}-${citation.endLine}.`,
      );
    }
  }
}

/** Reject forbidden or untracked paths before bounds-invalid extra citations can be discarded. */
export function assertMatchedEvaluationContinuationDiagnosticSourceCitationPathsV1(input: {
  readonly changedPaths: readonly string[];
  readonly phaseOneAllowedPaths: readonly string[];
  readonly sourceCitations: MatchedEvaluationContinuationDiagnosticEvidenceV1['sourceCitations'];
  readonly trackedRegularFiles: ReadonlyMap<string, string>;
}): void {
  const changed = new Set(input.changedPaths);
  const phaseOneAllowed = new Set(input.phaseOneAllowedPaths);
  for (const citation of input.sourceCitations) {
    const content = input.trackedRegularFiles.get(citation.path);
    if (content === undefined)
      throw new Error(`Continuation diagnostic citation is not a tracked regular file: ${citation.path}.`);
    if (
      changed.has(citation.path) ||
      phaseOneAllowed.has(citation.path) ||
      !isContinuationProductionSourcePath(citation.path)
    ) {
      throw new Error(`Continuation diagnostic citation is not production source: ${citation.path}.`);
    }
  }
}

/** Keep only in-bounds source ranges without rewriting the model's raw transcript evidence. */
export function selectMatchedEvaluationContinuationInBoundsSourceCitationsV1(input: {
  readonly sourceCitations: MatchedEvaluationContinuationDiagnosticEvidenceV1['sourceCitations'];
  readonly trackedRegularFiles: ReadonlyMap<string, string>;
}): MatchedEvaluationContinuationDiagnosticEvidenceV1['sourceCitations'] {
  return input.sourceCitations.filter(citation => {
    const content = input.trackedRegularFiles.get(citation.path);
    if (content === undefined) return true;
    const lineCount = matchedEvaluationContinuationLineCountV1(content);
    return citation.endLine <= lineCount;
  });
}

function matchedEvaluationContinuationLineCountV1(content: string): number {
  return content.length === 0 ? 0 : content.split(/\r\n|\n|\r/u).length - (/(?:\r\n|\n|\r)$/u.test(content) ? 1 : 0);
}

/** Pure checkpoint/handoff projection shared by the v3 and diagnostic v4 finalizer paths. */
export function buildMatchedEvaluationContinuationDiagnosticHandoffV1(input: {
  readonly changedPaths: readonly string[];
  readonly diagnosticEvidence: MatchedEvaluationContinuationDiagnosticEvidenceV1 | null;
  readonly legacyEvidence: {readonly anchors: string; readonly observations: string} | null;
  readonly phaseTwoPrompt: string;
  readonly resumeEvidenceMarker: string;
  readonly verification: string;
}): {
  readonly codeRefs: readonly string[];
  readonly handoff: string;
  readonly planVersion: 3 | 4;
  readonly sourceAnchors: string | null;
} {
  const diagnostic = input.diagnosticEvidence;
  const graphQuery =
    diagnostic === null ? null : normalizeMatchedEvaluationContinuationGraphQueryV1(diagnostic.graphQuery);
  const sourceAnchors =
    diagnostic === null
      ? null
      : diagnostic.sourceCitations
          .map(citation => `${citation.path}:${citation.startLine}-${citation.endLine}`)
          .join(', ');
  const handoff = [
    diagnostic === null ? `Task: ${input.phaseTwoPrompt}` : `Task: ${input.resumeEvidenceMarker}. ${graphQuery!}`,
    `Decisions: Phase 1 added only the committed regression in ${input.changedPaths.join(', ')}; production code is unchanged.${diagnostic === null ? ` ${input.resumeEvidenceMarker}` : ''}`,
    ...(diagnostic === null
      ? [
          `Observed: ${input.legacyEvidence!.observations}`,
          `Anchors: ${input.legacyEvidence!.anchors}`,
          'Attempted: Phase 1 changed only the cited regression and ran the required focused check.',
        ]
      : [
          `Observed: ${diagnostic.diagnosticConclusion}`,
          `Rejected hypothesis: ${diagnostic.rejectedHypothesis}`,
          `Verified invariant: ${diagnostic.verifiedInvariant}`,
          `Untested invariant: ${diagnostic.untestedInvariant}`,
          `Unresolved: ${diagnostic.unresolvedGap}`,
          `Graph question: ${diagnostic.graphQuestion}`,
          `Graph query: ${graphQuery!}`,
          `Anchors: regression ${input.legacyEvidence!.anchors}; source ${sourceAnchors}`,
          'Attempted: Phase 1 added the regression, inspected the cited production path, narrowed the diagnosis, and stopped before the production fix.',
        ]),
    'Constraints: Keep the committed regression unchanged, preserve public behavior, use no network access, and implement the smallest general production correction.',
    'Rationale: The direct-child checkpoint isolates cross-session continuation from initial test discovery and makes every treatment start from the same failing regression.',
    `Verification: ${input.verification}`,
    'Blockers: none.',
    ...(diagnostic === null
      ? [
          'Unresolved: Root cause and broader production invariants were not established in Phase 1.',
          'Avoid repeat: Do not reread the cited regression unless current source differs; trace the production path behind the observed failure.',
        ]
      : [
          'Avoid repeat: The sealed baseline failure is already established; do not rerun it before changing production code. Do not reread unchanged cited anchors. First run exactly one inspect_code_graph query using the Graph query above, then inspect only the source needed to resolve the named gap.',
        ]),
    'Risks: Adjacent compatibility behavior may encode the old implementation and must remain covered by the sealed Phase 2 checks.',
    diagnostic === null
      ? `Next step: ${input.phaseTwoPrompt}`
      : `Next step: First inspect_code_graph query: ${graphQuery!}. Then resolve the named gap, implement the smallest general correction, and run the sealed check.`,
  ].join('\n');
  return {
    codeRefs: [
      ...new Set([...input.changedPaths, ...(diagnostic?.sourceCitations.map(citation => citation.path) ?? [])]),
    ],
    handoff,
    planVersion: diagnostic === null ? 3 : 4,
    sourceAnchors,
  };
}

/** Accept a model's invocation-like spelling while sealing only the semantic graph query argument. */
export function normalizeMatchedEvaluationContinuationGraphQueryV1(value: string): string {
  const trimmed = value.trim();
  const invocation = /^inspect_code_graph\s*\(\s*("(?:[^"\\]|\\.)*")\s*\)$/u.exec(trimmed);
  if (invocation === null) return trimmed;
  try {
    const parsed = JSON.parse(invocation[1]) as unknown;
    return typeof parsed === 'string' && parsed.trim() !== '' ? parsed.trim() : trimmed;
  } catch {
    return trimmed;
  }
}

/** Ground the model's identifier-rich graph query in its first attested production-source citation. */
export function buildMatchedEvaluationContinuationAnchoredGraphQueryV1(input: {
  readonly fallbackQuery: string;
  readonly graphQuestion: string;
  readonly sourceCitations: readonly {readonly path: string}[];
}): string {
  const normalized = normalizeMatchedEvaluationContinuationGraphQueryV1(input.fallbackQuery)
    .replace(/\s+/gu, ' ')
    .trim();
  const semanticQuery = normalized.replace(/^inspect_code_graph(?:\s+query)?(?:\s+for|\s*:)?\s*/iu, '').trim();
  const fallback = semanticQuery || normalized || input.graphQuestion.replace(/\s+/gu, ' ').trim();
  return matchedEvaluationUtf8Prefix(fallback, 256).trim();
}

function matchedEvaluationUtf8Prefix(value: string, maximumBytes: number): string {
  let bytes = 0;
  let output = '';
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, 'utf8');
    if (bytes + characterBytes > maximumBytes) break;
    bytes += characterBytes;
    output += character;
  }
  return output;
}

/** Attest every citation emitted by a stored continuation handoff and select its regression link. */
export function parseMatchedEvaluationContinuationAutomaticHandoffReadV1(input: {
  readonly expectedCodeRefs: readonly string[];
  readonly graphContentId: string;
  readonly regressionPath: string;
  readonly repositoryRevision: string;
  readonly snapshotId: string;
  readonly stdout: string;
}): {readonly citationId: string; readonly managedMemoryId: string} {
  const managedMemoryId = matchingString(
    uniquePrefixedLine(input.stdout, 'memory_id: ', 'continuation automatic handoff memory id'),
    /^tn_[A-Za-z0-9_-]{1,128}$/u,
    'continuation automatic handoff memory id',
  );
  const expectedPaths = [...new Set(input.expectedCodeRefs)].sort((left, right) => left.localeCompare(right));
  const citations = prefixedLines(input.stdout, 'code_citation: ', 'continuation automatic handoff citations').map(
    (line, index) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line) as unknown;
      } catch (cause) {
        throw new Error(`Continuation automatic handoff citation ${index} is invalid JSON.`, {cause});
      }
      const citation = object(parsed, `continuation automatic handoff citation ${index}`);
      const target = object(citation.target, `continuation automatic handoff citation ${index} target`);
      const path = boundedString(citation.path, 1, 4_096, `continuation automatic handoff citation ${index} path`);
      const citationId = matchingString(
        citation.id,
        /^tncc_[0-9a-f]{40}$/u,
        `continuation automatic handoff citation ${index} id`,
      );
      if (
        citation.sourceCommit !== input.repositoryRevision ||
        citation.sourceDirty !== false ||
        citation.sourceSnapshotId !== input.snapshotId ||
        citation.sourceGraphContentId !== input.graphContentId ||
        target.kind !== 'file'
      ) {
        throw new Error(`Continuation automatic handoff citation ${index} is not exact-current.`);
      }
      return {citationId, path};
    },
  );
  const actualPaths = citations.map(citation => citation.path).sort((left, right) => left.localeCompare(right));
  if (JSON.stringify(actualPaths) !== JSON.stringify(expectedPaths)) {
    throw new Error('Continuation automatic handoff citations differ from the requested code references.');
  }
  const regression = citations.filter(citation => citation.path === input.regressionPath);
  if (regression.length !== 1) {
    throw new Error('Continuation automatic handoff citation is missing or ambiguous for the regression.');
  }
  return {citationId: regression[0].citationId, managedMemoryId};
}

function renderMatchedEvaluationContinuationPhaseOnePromptV1(
  packet: MatchedEvaluationContinuationPhaseOneTaskPacket,
): string {
  const focusedCheck = packet.phaseOneFocusedChecks[0].replaceAll('{python}', 'python');
  const diagnosticContract =
    packet.version === 4
      ? [
          '',
          'CONTINUATION DIAGNOSIS/1',
          'Add the failing regression and inspect the production source deeply enough to leave a decision-grade diagnosis, but do not edit production code or implement the fix.',
          'Your citations must include both the changed regression and at least one unchanged production-source anchor.',
          'Write the summary as exactly these seven nonempty lines:',
          'Diagnosis: <source-grounded conclusion>',
          'Rejected hypothesis: <attempted explanation that evidence ruled out or narrowed>',
          'Verified invariant: <behavior established by source or the focused check>',
          'Untested invariant: <important behavior still requiring verification>',
          'Unresolved gap: <one exact decision still blocking the production fix>',
          'Graph question: <one bounded source-relationship question whose answer advances that decision>',
          'Graph query: <one concise inspect_code_graph query for that question>',
        ].join('\n')
      : '';
  return `${packet.sourceTaskPrompt}\n\n${packet.phaseOneDirective}${diagnosticContract}\n\nRequired focused check (run exactly as written; do not change its flags or selector):\n${focusedCheck}`;
}

export function createMatchedEvaluationContinuationPhaseOneSelectionV1(input: {
  readonly packet: MatchedEvaluationContinuationPhaseOneTaskPacket;
  readonly taskPacketSha256: string;
  readonly task: MatchedEvaluationManifestV1['tasks'][number];
  readonly taskPrompt: string;
  readonly repositoryRevision: string;
}): MatchedEvaluationContinuationPhaseOneSelectionV1 {
  if (input.packet.sourceTaskPrompt !== input.taskPrompt) {
    throw new Error('Continuation phase-one task packet differs from the frozen source prompt.');
  }
  if (input.packet.sourceRevision !== input.repositoryRevision) {
    throw new Error('Continuation phase-one task packet differs from the frozen source revision.');
  }
  const packetHash = matchingString(input.taskPacketSha256, HASH, 'phase-one task packet hash');
  const phaseOnePrompt = renderMatchedEvaluationContinuationPhaseOnePromptV1(input.packet);
  const treatmentVariants =
    input.packet.version === 3 || input.packet.version === 4
      ? AUTOMATED_CONTEXT_CONTINUATION_VARIANTS
      : input.packet.version === 2
        ? MATCHED_CONTEXT_CONTINUATION_VARIANTS
        : CONTINUATION_VARIANTS;
  const variants = treatmentVariants
    .map(variant => ({
      score: sha256Bytes(
        Buffer.from(`matched-continuation-treatment-order-v1\0${packetHash}\0${input.task.taskId}\0${variant}`),
      ),
      variant,
    }))
    .sort((left, right) => left.score.localeCompare(right.score));
  const labels = ['A', 'B', 'C', 'D', 'E'] as const;
  return {
    continuationAttempts: variants.map(({variant}, index) => ({
      blindLabel: labels[index],
      runNonce: `run_${sha256Bytes(
        Buffer.from(`matched-continuation-phase-two-run-v1\0${packetHash}\0${input.task.taskId}\0${variant}`),
      ).slice(0, 32)}`,
      runOrder: index + 1,
      variant,
    })),
    phaseOnePrompt,
    phaseOnePromptSha256: sha256Bytes(Buffer.from(phaseOnePrompt)),
    phaseOneRunNonce: `run_${sha256Bytes(
      Buffer.from(`matched-continuation-phase-one-run-v1\0${packetHash}\0${input.task.taskId}`),
    ).slice(0, 32)}`,
    sourceTask: {
      prompt: input.taskPrompt,
      promptSha256: input.task.promptHash,
      repositoryFixtureHash: input.task.repositoryFixtureHash,
      repositoryRevision: input.repositoryRevision,
      taskId: input.task.taskId,
    },
    taskPacket: input.packet,
    taskPacketSha256: packetHash,
    version: 1,
  };
}

export function assertMatchedEvaluationContinuationPhaseOnePreregistrationV1(
  expectedInput: unknown,
  actual: MatchedEvaluationContinuationPhaseOneSelectionV1,
): void {
  const expected = parseMatchedEvaluationContinuationPhaseOneSelectionV1(expectedInput);
  if (JSON.stringify(expected) !== JSON.stringify(actual)) {
    throw new Error('Continuation phase-one selection differs from the sealed preregistration.');
  }
}

export function parseMatchedEvaluationContinuationPhaseOneSelectionV1(
  value: unknown,
): MatchedEvaluationContinuationPhaseOneSelectionV1 {
  const selection = object(value, 'continuation phase-one selection');
  exactKeys(
    selection,
    [
      'continuationAttempts',
      'phaseOnePrompt',
      'phaseOnePromptSha256',
      'phaseOneRunNonce',
      'sourceTask',
      'taskPacket',
      'taskPacketSha256',
      'version',
    ],
    'continuation phase-one selection',
  );
  if (selection.version !== 1) invalid('continuation phase-one selection version is invalid');
  const taskPacket = parseMatchedEvaluationContinuationPhaseOneTaskPacketV1(selection.taskPacket);
  const phaseOnePrompt = boundedString(selection.phaseOnePrompt, 1, 28_000, 'continuation phase-one prompt');
  const legacyPhaseOnePrompt = `${taskPacket.sourceTaskPrompt}\n\n${taskPacket.phaseOneDirective}`;
  const expectedPhaseOnePrompt = renderMatchedEvaluationContinuationPhaseOnePromptV1(taskPacket);
  if (phaseOnePrompt !== expectedPhaseOnePrompt && phaseOnePrompt !== legacyPhaseOnePrompt) {
    invalid('continuation phase-one prompt differs from its packet');
  }
  const phaseOnePromptSha256 = matchingString(
    selection.phaseOnePromptSha256,
    HASH,
    'continuation phase-one prompt hash',
  );
  if (phaseOnePromptSha256 !== sha256Bytes(Buffer.from(phaseOnePrompt))) {
    invalid('continuation phase-one prompt hash differs');
  }
  const sourceTask = object(selection.sourceTask, 'continuation phase-one source task');
  exactKeys(
    sourceTask,
    ['prompt', 'promptSha256', 'repositoryFixtureHash', 'repositoryRevision', 'taskId'],
    'continuation phase-one source task',
  );
  const sourcePrompt = boundedString(sourceTask.prompt, 1, 12_000, 'continuation phase-one source prompt');
  const parsedSourceTask = {
    prompt: sourcePrompt,
    promptSha256: matchingString(sourceTask.promptSha256, HASH, 'continuation phase-one source prompt hash'),
    repositoryFixtureHash: matchingString(
      sourceTask.repositoryFixtureHash,
      HASH,
      'continuation phase-one source fixture hash',
    ),
    repositoryRevision: matchingString(
      sourceTask.repositoryRevision,
      /^[0-9a-f]{40}$/u,
      'continuation phase-one source revision',
    ),
    taskId: matchingString(sourceTask.taskId, /^tsk_[0-9a-f]{16,64}$/u, 'continuation phase-one task id'),
  };
  if (
    parsedSourceTask.prompt !== taskPacket.sourceTaskPrompt ||
    parsedSourceTask.promptSha256 !== matchedEvaluationPromptHashV1(parsedSourceTask.prompt) ||
    parsedSourceTask.repositoryRevision !== taskPacket.sourceRevision
  ) {
    invalid('continuation phase-one source task differs from its packet');
  }
  const attempts = parseContinuationPhaseOneAttemptsV1(
    selection.continuationAttempts,
    'continuation phase-one attempts',
  );
  const expectedAttemptCount =
    taskPacket.version === 3 || taskPacket.version === 4
      ? AUTOMATED_CONTEXT_CONTINUATION_VARIANTS.length
      : taskPacket.version === 2
        ? 3
        : null;
  if (
    (expectedAttemptCount !== null && attempts.length !== expectedAttemptCount) ||
    (taskPacket.version === 1 &&
      (attempts.length === AUTOMATED_CONTEXT_CONTINUATION_VARIANTS.length ||
        attempts.length === MATCHED_CONTEXT_CONTINUATION_VARIANTS.length))
  ) {
    invalid('continuation phase-one treatment set differs from its task packet');
  }
  return {
    continuationAttempts: [...attempts].sort((left, right) => left.runOrder - right.runOrder),
    phaseOnePrompt,
    phaseOnePromptSha256,
    phaseOneRunNonce: matchingString(
      selection.phaseOneRunNonce,
      /^run_[0-9a-f]{32}$/u,
      'continuation phase-one run nonce',
    ),
    sourceTask: parsedSourceTask,
    taskPacket,
    taskPacketSha256: matchingString(selection.taskPacketSha256, HASH, 'continuation phase-one packet hash'),
    version: 1,
  };
}

export function parseMatchedEvaluationContinuationPhaseOneReceiptV1(
  value: unknown,
): MatchedEvaluationContinuationPhaseOneReceiptV1 {
  const receipt = object(value, 'continuation phase-one receipt');
  exactKeys(
    receipt,
    [
      'continuationAttempts',
      'evidenceSha256',
      'metrics',
      'phaseOnePromptSha256',
      'phaseOneRunNonce',
      'selectionSha256',
      'taskId',
      'taskPacketSha256',
      'transcriptHash',
      'version',
    ],
    'continuation phase-one receipt',
  );
  if (receipt.version !== 1) invalid('continuation phase-one receipt version is invalid');
  const evidence = object(receipt.evidenceSha256, 'continuation phase-one receipt evidence');
  exactKeys(
    evidence,
    [
      'adapterArtifactHash',
      'adapterConfigurationFileSha256',
      'artifactSha256',
      'requestSha256',
      'responseSha256',
      'transcriptSha256',
    ],
    'continuation phase-one receipt evidence',
  );
  const evidenceSha256 = {
    adapterArtifactHash: matchingString(evidence.adapterArtifactHash, HASH, 'phase-one receipt adapter hash'),
    adapterConfigurationFileSha256: matchingString(
      evidence.adapterConfigurationFileSha256,
      HASH,
      'phase-one receipt adapter config hash',
    ),
    artifactSha256: matchingString(evidence.artifactSha256, HASH, 'phase-one receipt artifact hash'),
    requestSha256: matchingString(evidence.requestSha256, HASH, 'phase-one receipt request hash'),
    responseSha256: matchingString(evidence.responseSha256, HASH, 'phase-one receipt response hash'),
    transcriptSha256: matchingString(evidence.transcriptSha256, HASH, 'phase-one receipt transcript hash'),
  };
  const transcriptHash = matchingString(receipt.transcriptHash, HASH, 'phase-one receipt transcript hash');
  const observation = parseMatchedEvaluationObservationV1({
    artifactHash: evidenceSha256.artifactSha256,
    metrics: receipt.metrics,
    transcriptHash,
    version: 5,
  });
  return {
    continuationAttempts: parseContinuationPhaseOneAttemptsV1(
      receipt.continuationAttempts,
      'continuation phase-one receipt attempts',
    ),
    evidenceSha256,
    metrics: observation.metrics,
    phaseOnePromptSha256: matchingString(receipt.phaseOnePromptSha256, HASH, 'phase-one receipt prompt hash'),
    phaseOneRunNonce: matchingString(receipt.phaseOneRunNonce, /^run_[0-9a-f]{32}$/u, 'phase-one receipt run nonce'),
    selectionSha256: matchingString(receipt.selectionSha256, HASH, 'phase-one receipt selection hash'),
    taskId: matchingString(receipt.taskId, /^tsk_[0-9a-f]{16,64}$/u, 'phase-one receipt task id'),
    taskPacketSha256: matchingString(receipt.taskPacketSha256, HASH, 'phase-one receipt task packet hash'),
    transcriptHash,
    version: 1,
  };
}

export function assertMatchedEvaluationContinuationPhaseOneReceiptV1(input: {
  readonly evidenceSha256: MatchedEvaluationContinuationPhaseOneReceiptV1['evidenceSha256'];
  readonly receipt: MatchedEvaluationContinuationPhaseOneReceiptV1;
  readonly responseObservation: ReturnType<typeof parseMatchedEvaluationObservationV1>;
  readonly selection: MatchedEvaluationContinuationPhaseOneSelectionV1;
  readonly selectionSha256: string;
}): void {
  if (
    JSON.stringify(input.receipt.continuationAttempts) !== JSON.stringify(input.selection.continuationAttempts) ||
    JSON.stringify(input.receipt.evidenceSha256) !== JSON.stringify(input.evidenceSha256) ||
    JSON.stringify(input.receipt.metrics) !== JSON.stringify(input.responseObservation.metrics) ||
    input.receipt.phaseOnePromptSha256 !== input.selection.phaseOnePromptSha256 ||
    input.receipt.phaseOneRunNonce !== input.selection.phaseOneRunNonce ||
    input.receipt.selectionSha256 !== input.selectionSha256 ||
    input.receipt.taskId !== input.selection.sourceTask.taskId ||
    input.receipt.taskPacketSha256 !== input.selection.taskPacketSha256 ||
    input.receipt.transcriptHash !== input.responseObservation.transcriptHash ||
    input.responseObservation.artifactHash !== input.receipt.evidenceSha256.artifactSha256 ||
    input.responseObservation.transcriptHash !== input.receipt.evidenceSha256.transcriptSha256
  ) {
    throw new Error('Continuation phase-one receipt differs from the sealed selection or preserved evidence.');
  }
}

function parseContinuationPhaseOneAttemptsV1(
  value: unknown,
  label: string,
): MatchedEvaluationContinuationPhaseOneSelectionV1['continuationAttempts'] {
  const attempts = array(value, label).map((entry, index) => {
    const attempt = object(entry, `${label} entry ${index}`);
    exactKeys(attempt, ['blindLabel', 'runNonce', 'runOrder', 'variant'], `${label} entry ${index}`);
    return {
      blindLabel: literal(attempt.blindLabel, ['A', 'B', 'C', 'D', 'E'] as const, `${label} entry ${index} label`),
      runNonce: matchingString(attempt.runNonce, /^run_[0-9a-f]{32}$/u, `${label} entry ${index} nonce`),
      runOrder: boundedPositiveInteger(attempt.runOrder, 1, 5, `${label} entry ${index} order`),
      variant: literal(attempt.variant, CONTINUATION_VARIANTS, `${label} entry ${index} variant`),
    };
  });
  const expectedVariants =
    attempts.length === AUTOMATED_CONTEXT_CONTINUATION_VARIANTS.length
      ? AUTOMATED_CONTEXT_CONTINUATION_VARIANTS
      : attempts.length === MATCHED_CONTEXT_CONTINUATION_VARIANTS.length
        ? MATCHED_CONTEXT_CONTINUATION_VARIANTS
        : attempts.length === BASE_CONTINUATION_VARIANTS.length
          ? BASE_CONTINUATION_VARIANTS
          : attempts.length === CONTINUATION_VARIANTS.length
            ? CONTINUATION_VARIANTS
            : null;
  if (
    expectedVariants === null ||
    new Set(attempts.map(attempt => attempt.blindLabel)).size !== expectedVariants.length ||
    new Set(attempts.map(attempt => attempt.runNonce)).size !== expectedVariants.length ||
    new Set(attempts.map(attempt => attempt.runOrder)).size !== expectedVariants.length ||
    new Set(attempts.map(attempt => attempt.variant)).size !== expectedVariants.length ||
    expectedVariants.some(variant => !attempts.some(attempt => attempt.variant === variant))
  ) {
    invalid(`${label} must contain a complete supported two-, three-, four-, or five-treatment set`);
  }
  return [...attempts].sort((left, right) => left.runOrder - right.runOrder);
}

export interface MatchedEvaluationContinuationSupplementV1 {
  readonly adapterArtifactSha256: string;
  readonly parentReportSha256: string;
  readonly parentSelectionSha256: string;
  readonly parentVariants: readonly (typeof BASE_CONTINUATION_VARIANTS)[number][];
  readonly variant: 'threadnote-preloaded-resume';
  readonly version: 1;
}

export function parseMatchedEvaluationContinuationPilotPlanV1(value: unknown): MatchedEvaluationContinuationPilotPlan {
  const plan = object(value, 'continuation pilot plan');
  const version = plan.version;
  if (version !== 1 && version !== 2 && version !== 3 && version !== 4) {
    invalid('continuation pilot plan version is invalid');
  }
  exactKeys(
    plan,
    version === 1
      ? ['attempts', 'baseTaskPromptSha256', 'candidate', 'checkpoint', 'retries', 'taskId', 'version']
      : [
          'attempts',
          'candidate',
          'checkpoint',
          'phaseTwoPrompt',
          'phaseTwoPromptSha256',
          ...(version === 3 || version === 4 ? ['phaseTwoVerification'] : []),
          'retries',
          'sourceTask',
          'taskId',
          'version',
        ],
    'continuation pilot plan',
  );
  if (plan.retries !== 0) invalid('continuation pilot retries must be zero');
  const candidate = object(plan.candidate, 'continuation pilot candidate');
  exactKeys(candidate, ['toolArtifactHash', 'toolVersion'], 'continuation pilot candidate');
  const checkpoint = object(plan.checkpoint, 'continuation pilot checkpoint');
  exactKeys(
    checkpoint,
    [
      'automaticHandoffReadSha256',
      'automaticHandoffUri',
      'handoff',
      'handoffSha256',
      'phaseOneAccounting',
      ...(version !== 1
        ? [
            'adapterConfigurations',
            ...(version === 4 ? ['diagnosticEvidence'] : []),
            'phaseOneExecution',
            'phaseOnePatchSha256',
            'phaseOnePrompt',
            'phaseOnePromptSha256',
            'preparedContext',
            'preparedGraphHome',
            'preparedHome',
          ]
        : []),
      'repositoryFixtureHash',
      'repositoryRevision',
      'resumeEvidenceMarker',
    ],
    'continuation pilot checkpoint',
  );
  const handoff = boundedString(checkpoint.handoff, 1, 16 * 1_024, 'continuation pilot handoff');
  const handoffSha256 = matchingString(checkpoint.handoffSha256, HASH, 'continuation pilot handoff hash');
  if (sha256Bytes(Buffer.from(handoff)) !== handoffSha256) invalid('continuation pilot handoff hash differs');
  for (const heading of ['Task:', 'Decisions:', 'Constraints:', 'Rationale:', 'Verification:', 'Next step:']) {
    if (!handoff.includes(heading)) invalid(`continuation pilot handoff lacks ${heading}`);
  }
  const resumeEvidenceMarker = boundedString(
    checkpoint.resumeEvidenceMarker,
    8,
    256,
    'continuation pilot resume evidence marker',
  );
  if (!handoff.includes(resumeEvidenceMarker)) invalid('continuation pilot handoff lacks its resume evidence marker');
  const phaseOneAccounting = object(checkpoint.phaseOneAccounting, 'continuation pilot phase-one accounting');
  exactKeys(
    phaseOneAccounting,
    ['elapsedMilliseconds', 'providerTokens', 'providerTokensMeasured'],
    'continuation pilot phase-one accounting',
  );
  if (typeof phaseOneAccounting.providerTokensMeasured !== 'boolean') {
    invalid('continuation pilot phase-one provider-token measurement flag is invalid');
  }
  const parsedProviderTokens = (() => {
    if (phaseOneAccounting.providerTokens === null) {
      if (phaseOneAccounting.providerTokensMeasured) {
        invalid('continuation pilot measured phase-one provider tokens are missing');
      }
      return null;
    }
    if (!phaseOneAccounting.providerTokensMeasured) {
      invalid('continuation pilot unmeasured phase-one provider tokens must be null');
    }
    const providerTokens = object(phaseOneAccounting.providerTokens, 'continuation pilot phase-one provider tokens');
    exactKeys(
      providerTokens,
      ['cachedInputTokens', 'inputTokens', 'outputTokens', 'reasoningOutputTokens', 'totalTokens'],
      'continuation pilot phase-one provider tokens',
    );
    const parsed = {
      cachedInputTokens: boundedNonnegativeInteger(
        providerTokens.cachedInputTokens,
        10_000_000,
        'phase-one cached input tokens',
      ),
      inputTokens: boundedNonnegativeInteger(providerTokens.inputTokens, 10_000_000, 'phase-one input tokens'),
      outputTokens: boundedNonnegativeInteger(providerTokens.outputTokens, 10_000_000, 'phase-one output tokens'),
      reasoningOutputTokens: boundedNonnegativeInteger(
        providerTokens.reasoningOutputTokens,
        10_000_000,
        'phase-one reasoning output tokens',
      ),
      totalTokens: boundedNonnegativeInteger(providerTokens.totalTokens, 10_000_000, 'phase-one total tokens'),
    };
    if (
      parsed.cachedInputTokens > parsed.inputTokens ||
      parsed.reasoningOutputTokens > parsed.outputTokens ||
      parsed.totalTokens !== parsed.inputTokens + parsed.outputTokens
    ) {
      invalid('continuation pilot phase-one token components are inconsistent');
    }
    return parsed;
  })();
  const attempts = array(plan.attempts, 'continuation pilot attempts').map((entry, index) => {
    const attempt = object(entry, `continuation pilot attempt ${index}`);
    exactKeys(attempt, ['blindLabel', 'runNonce', 'runOrder', 'variant'], `continuation pilot attempt ${index}`);
    return {
      blindLabel: literal(
        attempt.blindLabel,
        ['A', 'B', 'C', 'D', 'E'] as const,
        `continuation pilot attempt ${index} blind label`,
      ),
      runNonce: matchingString(attempt.runNonce, /^run_[0-9a-f]{32}$/u, `continuation pilot attempt ${index} nonce`),
      runOrder: boundedPositiveInteger(attempt.runOrder, 1, 5, `continuation pilot attempt ${index} order`),
      variant: literal(attempt.variant, CONTINUATION_VARIANTS, `continuation pilot attempt ${index} variant`),
    };
  });
  const expectedVariants =
    attempts.length === AUTOMATED_CONTEXT_CONTINUATION_VARIANTS.length
      ? AUTOMATED_CONTEXT_CONTINUATION_VARIANTS
      : attempts.length === MATCHED_CONTEXT_CONTINUATION_VARIANTS.length
        ? MATCHED_CONTEXT_CONTINUATION_VARIANTS
        : attempts.length === BASE_CONTINUATION_VARIANTS.length
          ? BASE_CONTINUATION_VARIANTS
          : attempts.length === CONTINUATION_VARIANTS.length
            ? CONTINUATION_VARIANTS
            : null;
  const versionedExpectedVariants = version === 4 ? AUTOMATED_CONTEXT_CONTINUATION_VARIANTS : expectedVariants;
  if (
    versionedExpectedVariants === null ||
    attempts.length !== versionedExpectedVariants.length ||
    new Set(attempts.map(attempt => attempt.variant)).size !== versionedExpectedVariants.length ||
    versionedExpectedVariants.some(variant => !attempts.some(attempt => attempt.variant === variant)) ||
    new Set(attempts.map(attempt => attempt.runNonce)).size !== attempts.length ||
    new Set(attempts.map(attempt => attempt.blindLabel)).size !== attempts.length ||
    new Set(attempts.map(attempt => attempt.runOrder)).size !== attempts.length
  ) {
    invalid('continuation pilot must contain one unique attempt per variant');
  }
  const common = {
    attempts: [...attempts].sort((left, right) => left.runOrder - right.runOrder),
    candidate: {
      toolArtifactHash: matchingString(candidate.toolArtifactHash, HASH, 'continuation pilot tool artifact hash'),
      toolVersion: boundedString(candidate.toolVersion, 1, 128, 'continuation pilot tool version'),
    },
    checkpoint: {
      automaticHandoffUri: boundedString(
        checkpoint.automaticHandoffUri,
        1,
        2_048,
        'continuation pilot automatic handoff URI',
      ),
      handoff,
      handoffSha256,
      phaseOneAccounting: {
        elapsedMilliseconds: boundedNonnegativeInteger(
          phaseOneAccounting.elapsedMilliseconds,
          86_400_000,
          'phase-one elapsed milliseconds',
        ),
        providerTokens: parsedProviderTokens,
        providerTokensMeasured: phaseOneAccounting.providerTokensMeasured,
      },
      repositoryFixtureHash: matchingString(
        checkpoint.repositoryFixtureHash,
        HASH,
        'continuation pilot repository fixture hash',
      ),
      repositoryRevision: matchingString(
        checkpoint.repositoryRevision,
        /^[0-9a-f]{40}$/u,
        'continuation pilot repository revision',
      ),
      resumeEvidenceMarker,
      automaticHandoffReadSha256: matchingString(
        checkpoint.automaticHandoffReadSha256,
        HASH,
        'continuation pilot automatic handoff read hash',
      ),
    },
    retries: 0 as const,
    taskId: matchingString(plan.taskId, /^tsk_[0-9a-f]{16,64}$/u, 'continuation pilot task id'),
  };
  if (version === 1) {
    return {
      ...common,
      baseTaskPromptSha256: matchingString(plan.baseTaskPromptSha256, HASH, 'continuation pilot task prompt hash'),
      version,
    };
  }
  if (!common.checkpoint.phaseOneAccounting.providerTokensMeasured) {
    invalid('continuation pilot v2 requires measured phase-one provider tokens');
  }
  const phaseOnePrompt = boundedString(checkpoint.phaseOnePrompt, 1, 28_000, 'continuation pilot phase-one prompt');
  const phaseOnePromptSha256 = matchingString(
    checkpoint.phaseOnePromptSha256,
    HASH,
    'continuation pilot phase-one prompt hash',
  );
  if (sha256Bytes(Buffer.from(phaseOnePrompt)) !== phaseOnePromptSha256) {
    invalid('continuation pilot phase-one prompt hash differs');
  }
  const phaseTwoPrompt = boundedString(plan.phaseTwoPrompt, 1, 12_000, 'continuation pilot phase-two prompt');
  const phaseTwoPromptSha256 = matchingString(
    plan.phaseTwoPromptSha256,
    HASH,
    'continuation pilot phase-two prompt hash',
  );
  if (sha256Bytes(Buffer.from(phaseTwoPrompt)) !== phaseTwoPromptSha256) {
    invalid('continuation pilot phase-two prompt hash differs');
  }
  const sourceTask = object(plan.sourceTask, 'continuation pilot source task');
  exactKeys(
    sourceTask,
    ['prompt', 'promptSha256', 'repositoryFixtureHash', 'repositoryRevision', 'taskId'],
    'continuation pilot source task',
  );
  const sourcePrompt = boundedString(sourceTask.prompt, 1, 12_000, 'continuation pilot source task prompt');
  const sourcePromptSha256 = matchingString(
    sourceTask.promptSha256,
    HASH,
    'continuation pilot source task prompt hash',
  );
  if (matchedEvaluationPromptHashV1(sourcePrompt) !== sourcePromptSha256) {
    invalid('continuation pilot source task prompt hash differs');
  }
  const parsedSourceTask = {
    prompt: sourcePrompt,
    promptSha256: sourcePromptSha256,
    repositoryFixtureHash: matchingString(
      sourceTask.repositoryFixtureHash,
      HASH,
      'continuation pilot source repository fixture hash',
    ),
    repositoryRevision: matchingString(
      sourceTask.repositoryRevision,
      /^[0-9a-f]{40}$/u,
      'continuation pilot source repository revision',
    ),
    taskId: matchingString(sourceTask.taskId, /^tsk_[0-9a-f]{16,64}$/u, 'continuation pilot source task id'),
  };
  if (parsedSourceTask.taskId !== common.taskId) invalid('continuation pilot source task id differs');
  if (parsedSourceTask.repositoryRevision === common.checkpoint.repositoryRevision) {
    invalid('continuation pilot v2 checkpoint must differ from the source revision');
  }
  if (parsedSourceTask.repositoryFixtureHash === common.checkpoint.repositoryFixtureHash) {
    invalid('continuation pilot v2 checkpoint fixture must differ from the source fixture');
  }
  if (phaseOnePrompt === phaseTwoPrompt || parsedSourceTask.prompt === phaseTwoPrompt) {
    invalid('continuation pilot phase prompts must be distinct');
  }
  if (!phaseOnePrompt.includes(parsedSourceTask.prompt)) {
    invalid('continuation pilot phase-one prompt must include the exact source task prompt');
  }
  const diagnosticEvidence =
    version === 4 ? parseMatchedEvaluationContinuationDiagnosticEvidenceV1(checkpoint.diagnosticEvidence) : null;
  const current = {
    ...common,
    checkpoint: {
      ...common.checkpoint,
      adapterConfigurations: parseContinuationAdapterConfigurationsV2(checkpoint.adapterConfigurations),
      phaseOnePatchSha256: matchingString(
        checkpoint.phaseOnePatchSha256,
        HASH,
        'continuation pilot phase-one patch hash',
      ),
      phaseOneExecution: parseContinuationPhaseOneExecutionV2(checkpoint.phaseOneExecution),
      phaseOnePrompt,
      phaseOnePromptSha256,
      preparedContext: parseContinuationPreparedContextV2(checkpoint.preparedContext),
      ...(diagnosticEvidence === null ? {} : {diagnosticEvidence}),
      preparedGraphHome: parseContinuationPreparedHomeV2(
        checkpoint.preparedGraphHome,
        'continuation pilot prepared graph home',
      ),
      preparedHome: parseContinuationPreparedHomeV2(checkpoint.preparedHome, 'continuation pilot prepared home'),
    },
    phaseTwoPrompt,
    phaseTwoPromptSha256,
    sourceTask: parsedSourceTask,
  };
  if (version === 2) {
    return {...current, version};
  }
  const phaseTwoVerification = parseMatchedContinuationPhaseTwoVerificationPlanV1(plan.phaseTwoVerification);
  if (phaseTwoVerification.taskId !== common.taskId) {
    invalid('continuation pilot phase-two verification task id differs');
  }
  if (version === 3) {
    return {
      ...current,
      phaseTwoVerification,
      version,
    };
  }
  return {
    ...current,
    checkpoint: {...current.checkpoint, diagnosticEvidence: diagnosticEvidence!},
    phaseTwoVerification,
    version,
  };
}

function parseMatchedEvaluationContinuationDiagnosticEvidenceV1(
  value: unknown,
): MatchedEvaluationContinuationDiagnosticEvidenceV1 {
  const evidence = object(value, 'continuation diagnostic evidence');
  exactKeys(
    evidence,
    [
      'diagnosticConclusion',
      'graphQuery',
      'graphQuestion',
      'rejectedHypothesis',
      'sourceCitations',
      'unresolvedGap',
      'untestedInvariant',
      'verifiedInvariant',
    ],
    'continuation diagnostic evidence',
  );
  const sourceCitations = array(evidence.sourceCitations, 'continuation diagnostic source citations').map(
    (entry, index) => {
      const citation = object(entry, `continuation diagnostic source citation ${index}`);
      exactKeys(citation, ['endLine', 'path', 'startLine'], `continuation diagnostic source citation ${index}`);
      const path = boundedString(citation.path, 1, 1_024, `continuation diagnostic source citation ${index} path`);
      if (!isSafeContinuationRepositoryPath(path)) {
        invalid('continuation diagnostic source citation path is invalid');
      }
      const startLine = boundedPositiveInteger(
        citation.startLine,
        1,
        10_000_000,
        `continuation diagnostic source citation ${index} start line`,
      );
      return {
        endLine: boundedPositiveInteger(
          citation.endLine,
          startLine,
          10_000_000,
          `continuation diagnostic source citation ${index} end line`,
        ),
        path,
        startLine,
      };
    },
  );
  if (sourceCitations.length === 0 || sourceCitations.length > 16) {
    invalid('continuation diagnostic evidence requires one to sixteen production-source citations');
  }
  const graphQuery = boundedString(evidence.graphQuery, 8, 256, 'continuation diagnostic graph query');
  if (/\r|\n/u.test(graphQuery)) invalid('continuation diagnostic graph query must be a single line');
  return {
    diagnosticConclusion: boundedString(evidence.diagnosticConclusion, 8, 384, 'continuation diagnostic conclusion'),
    graphQuery,
    graphQuestion: boundedString(evidence.graphQuestion, 8, 384, 'continuation diagnostic graph question'),
    rejectedHypothesis: boundedString(
      evidence.rejectedHypothesis,
      8,
      384,
      'continuation diagnostic rejected hypothesis',
    ),
    sourceCitations,
    unresolvedGap: boundedString(evidence.unresolvedGap, 8, 384, 'continuation diagnostic unresolved gap'),
    untestedInvariant: boundedString(evidence.untestedInvariant, 8, 384, 'continuation diagnostic untested invariant'),
    verifiedInvariant: boundedString(evidence.verifiedInvariant, 8, 384, 'continuation diagnostic verified invariant'),
  };
}

/** Verify that a fifth treatment extends, rather than reruns, one completed four-arm pilot. */
export function assertMatchedEvaluationContinuationSupplementV1(input: {
  readonly adapterArtifactSha256: string;
  readonly parentReport: unknown;
  readonly parentReportSha256: string;
  readonly parentSelection: unknown;
  readonly parentSelectionSha256: string;
  readonly plan: MatchedEvaluationContinuationPilotPlan;
}): MatchedEvaluationContinuationSupplementV1 {
  if (input.plan.attempts.length !== CONTINUATION_VARIANTS.length) {
    throw new Error('Continuation supplement requires a five-treatment sealed plan.');
  }
  const supplement = input.plan.attempts.find(attempt => attempt.variant === 'threadnote-preloaded-resume');
  if (supplement === undefined || supplement.blindLabel !== 'E' || supplement.runOrder !== 5) {
    throw new Error('Continuation supplement must reserve label E and order 5 for preloaded resume.');
  }
  const selection = object(input.parentSelection, 'continuation supplement parent selection');
  const report = object(input.parentReport, 'continuation supplement parent report');
  const selectionRows = array(selection.rows, 'continuation supplement parent rows');
  const reportRows = array(report.rows, 'continuation supplement report rows');
  const reportAttempts = array(report.attempts, 'continuation supplement parent attempts');
  if (
    report.completed !== true ||
    selection.comparativeClaimsEligible !== false ||
    report.comparativeClaimsEligible !== false ||
    selection.version !== 1 ||
    report.version !== 1 ||
    selection.taskId !== input.plan.taskId ||
    report.taskId !== input.plan.taskId
  ) {
    throw new Error('Continuation supplement parent is not one completed non-comparative pilot.');
  }
  for (const field of ['candidate', 'checkpoint'] as const) {
    const expected =
      field === 'candidate'
        ? input.plan.candidate
        : projectMatchedEvaluationContinuationSelectionCheckpointV1(input.plan);
    if (!sameJson(selection[field], expected) || !sameJson(report[field], expected)) {
      throw new Error(`Continuation supplement parent ${field} differs from the sealed plan.`);
    }
  }
  if (
    !sameJson(report.identities, selection.identities) ||
    !sameJson(reportRows, selectionRows) ||
    selectionRows.length !== BASE_CONTINUATION_VARIANTS.length ||
    reportAttempts.length !== BASE_CONTINUATION_VARIANTS.length
  ) {
    throw new Error('Continuation supplement parent selection and report differ.');
  }
  const parentVariants = selectionRows.map((entry, index) => {
    const row = object(entry, `continuation supplement parent row ${index}`);
    const attempt = object(reportAttempts[index], `continuation supplement parent attempt ${index}`);
    const variant = literal(
      row.variant,
      BASE_CONTINUATION_VARIANTS,
      `continuation supplement parent row ${index} variant`,
    );
    const planned = input.plan.attempts.find(candidate => candidate.variant === variant);
    if (
      planned === undefined ||
      row.taskId !== input.plan.taskId ||
      row.blindLabel !== planned.blindLabel ||
      row.runNonce !== planned.runNonce ||
      row.runOrder !== planned.runOrder ||
      attempt.status !== 'completed' ||
      attempt.variant !== variant ||
      attempt.runNonce !== planned.runNonce ||
      attempt.runOrder !== planned.runOrder ||
      attempt.arm !== row.arm
    ) {
      throw new Error('Continuation supplement parent attempt differs from its sealed completed row.');
    }
    return variant;
  });
  if (
    new Set(parentVariants).size !== BASE_CONTINUATION_VARIANTS.length ||
    BASE_CONTINUATION_VARIANTS.some(variant => !parentVariants.includes(variant))
  ) {
    throw new Error('Continuation supplement parent does not contain the four baseline variants.');
  }
  return {
    adapterArtifactSha256: matchingString(
      input.adapterArtifactSha256,
      HASH,
      'continuation supplement adapter artifact hash',
    ),
    parentReportSha256: matchingString(input.parentReportSha256, HASH, 'continuation supplement parent report hash'),
    parentSelectionSha256: matchingString(
      input.parentSelectionSha256,
      HASH,
      'continuation supplement parent selection hash',
    ),
    parentVariants,
    variant: 'threadnote-preloaded-resume',
    version: 1,
  };
}

function parseContinuationPhaseOneExecutionV2(
  value: unknown,
): MatchedEvaluationContinuationPilotPlanV2['checkpoint']['phaseOneExecution'] {
  const execution = object(value, 'continuation pilot phase-one execution');
  exactKeys(
    execution,
    [
      'adapterArtifactHash',
      'adapterConfigurationFileSha256',
      'adapterConfigurationHash',
      'adapterProtocol',
      'appServerExecutableSha256',
      'appServerVersion',
      'artifactSha256',
      'environmentPolicyHash',
      'model',
      'requestSha256',
      'responseSha256',
      'runNonce',
      'transcriptHash',
      'transcriptSha256',
    ],
    'continuation pilot phase-one execution',
  );
  const model = object(execution.model, 'continuation pilot phase-one model');
  exactKeys(model, ['id', 'parametersHash', 'provider', 'reasoningEffort'], 'continuation pilot phase-one model');
  return {
    adapterArtifactHash: matchingString(
      execution.adapterArtifactHash,
      HASH,
      'continuation pilot phase-one adapter artifact hash',
    ),
    adapterConfigurationFileSha256: matchingString(
      execution.adapterConfigurationFileSha256,
      HASH,
      'continuation pilot phase-one adapter configuration file hash',
    ),
    adapterConfigurationHash: matchingString(
      execution.adapterConfigurationHash,
      HASH,
      'continuation pilot phase-one adapter configuration hash',
    ),
    adapterProtocol: boundedString(execution.adapterProtocol, 1, 128, 'continuation pilot phase-one adapter protocol'),
    appServerExecutableSha256: matchingString(
      execution.appServerExecutableSha256,
      HASH,
      'continuation pilot phase-one app-server executable hash',
    ),
    appServerVersion: boundedString(
      execution.appServerVersion,
      1,
      128,
      'continuation pilot phase-one app-server version',
    ),
    artifactSha256: matchingString(execution.artifactSha256, HASH, 'continuation pilot phase-one artifact hash'),
    environmentPolicyHash: matchingString(
      execution.environmentPolicyHash,
      HASH,
      'continuation pilot phase-one environment policy hash',
    ),
    model: {
      id: boundedString(model.id, 1, 128, 'continuation pilot phase-one model id'),
      parametersHash: matchingString(model.parametersHash, HASH, 'continuation pilot phase-one model parameters hash'),
      provider: boundedString(model.provider, 1, 128, 'continuation pilot phase-one model provider'),
      reasoningEffort: boundedString(model.reasoningEffort, 1, 64, 'continuation pilot phase-one reasoning effort'),
    },
    requestSha256: matchingString(execution.requestSha256, HASH, 'continuation pilot phase-one request hash'),
    responseSha256: matchingString(execution.responseSha256, HASH, 'continuation pilot phase-one response hash'),
    runNonce: matchingString(execution.runNonce, /^run_[0-9a-f]{32}$/u, 'continuation pilot phase-one run nonce'),
    transcriptHash: matchingString(execution.transcriptHash, HASH, 'continuation pilot phase-one transcript hash'),
    transcriptSha256: matchingString(execution.transcriptSha256, HASH, 'continuation pilot phase-one transcript hash'),
  };
}

function parseContinuationPreparedContextV2(
  value: unknown,
): MatchedEvaluationContinuationPilotPlanV2['checkpoint']['preparedContext'] {
  const context = object(value, 'continuation pilot prepared context');
  exactKeys(
    context,
    ['graphContentHash', 'graphSnapshotHash', 'linkReceiptsHash', 'taskContextHash'],
    'continuation pilot prepared context',
  );
  return {
    graphContentHash: matchingString(context.graphContentHash, HASH, 'continuation pilot graph content hash'),
    graphSnapshotHash: matchingString(context.graphSnapshotHash, HASH, 'continuation pilot graph snapshot hash'),
    linkReceiptsHash: matchingString(context.linkReceiptsHash, HASH, 'continuation pilot link receipts hash'),
    taskContextHash: matchingString(context.taskContextHash, HASH, 'continuation pilot task context hash'),
  };
}

function parseContinuationAdapterConfigurationsV2(
  value: unknown,
): MatchedEvaluationContinuationPilotPlanV2['checkpoint']['adapterConfigurations'] {
  const configurations = object(value, 'continuation pilot checkpoint adapter configurations');
  exactKeys(
    configurations,
    ['threadnoteCompactSha256', 'threadnoteGraphSha256'],
    'continuation pilot checkpoint adapter configurations',
  );
  return {
    threadnoteCompactSha256: matchingString(
      configurations.threadnoteCompactSha256,
      HASH,
      'continuation pilot compact adapter configuration hash',
    ),
    threadnoteGraphSha256: matchingString(
      configurations.threadnoteGraphSha256,
      HASH,
      'continuation pilot graph adapter configuration hash',
    ),
  };
}

function parseContinuationPreparedHomeV2(
  value: unknown,
  label: string,
): MatchedEvaluationContinuationPilotPlanV2['checkpoint']['preparedHome'] {
  const home = object(value, label);
  exactKeys(home, ['fixtureHash', 'identitySha256'], label);
  return {
    fixtureHash: matchingString(home.fixtureHash, HASH, `${label} fixture hash`),
    identitySha256: matchingString(home.identitySha256, HASH, `${label} identity hash`),
  };
}

/** Bind the v2 phase-one claims to immutable sibling evidence before any phase-two attempt starts. */
export async function assertMatchedEvaluationContinuationPhaseOneEvidenceV2(input: {
  readonly plan: {
    readonly checkpoint: Pick<
      MatchedEvaluationContinuationPilotPlanV2['checkpoint'],
      'phaseOneAccounting' | 'phaseOneExecution' | 'phaseOnePatchSha256' | 'phaseOnePrompt'
    >;
    readonly sourceTask: Pick<
      MatchedEvaluationContinuationPilotPlanV2['sourceTask'],
      'repositoryFixtureHash' | 'repositoryRevision'
    >;
    readonly taskId: string;
  };
  readonly planPath: string;
}): Promise<{readonly checkpointPatch: string}> {
  const evidenceDirectory = join(dirname(input.planPath), 'phase-one');
  const paths = {
    adapter: join(evidenceDirectory, 'adapter'),
    adapterConfig: join(evidenceDirectory, 'adapter-config.json'),
    artifact: join(evidenceDirectory, 'artifact.json'),
    request: join(evidenceDirectory, 'request.json'),
    response: join(evidenceDirectory, 'response.json'),
    checkpointPatch: join(evidenceDirectory, 'checkpoint.patch'),
    transcript: join(evidenceDirectory, 'transcript.jsonl'),
  };
  const execution = input.plan.checkpoint.phaseOneExecution;
  const [
    adapterArtifactHash,
    adapterConfigurationFileSha256,
    artifactSha256,
    requestSha256,
    responseSha256,
    checkpointPatchSha256,
    transcriptSha256,
    configInput,
    artifactInput,
    requestInput,
    responseInput,
  ] = await Promise.all([
    boundedRegularFileHash(paths.adapter, 128 * 1_024 * 1_024, 'continuation phase-one adapter'),
    boundedRegularFileHash(paths.adapterConfig, MAXIMUM_JSON_BYTES, 'continuation phase-one adapter config'),
    boundedRegularFileHash(paths.artifact, MAXIMUM_JSON_BYTES, 'continuation phase-one artifact'),
    boundedRegularFileHash(paths.request, MAXIMUM_JSON_BYTES, 'continuation phase-one request'),
    boundedRegularFileHash(paths.response, MAXIMUM_JSON_BYTES, 'continuation phase-one response'),
    boundedRegularFileHash(paths.checkpointPatch, 8 * 1_024 * 1_024, 'continuation phase-one checkpoint patch'),
    boundedRegularFileHash(paths.transcript, MAXIMUM_TRANSCRIPT_BYTES, 'continuation phase-one transcript'),
    readJson(paths.adapterConfig),
    readJson(paths.artifact),
    readJson(paths.request),
    readJson(paths.response),
  ]);
  const observedHashes = {
    adapterArtifactHash,
    adapterConfigurationFileSha256,
    artifactSha256,
    requestSha256,
    responseSha256,
    transcriptSha256,
  };
  for (const [field, value] of Object.entries(observedHashes)) {
    if (execution[field as keyof typeof observedHashes] !== value) {
      throw new Error(`Continuation phase-one evidence differs: ${field}.`);
    }
  }
  const config = object(configInput, 'continuation phase-one adapter config');
  const appServer = object(config.appServer, 'continuation phase-one app server');
  const configModel = object(config.model, 'continuation phase-one config model');
  if (
    appServer.executableSha256 !== execution.appServerExecutableSha256 ||
    appServer.version !== execution.appServerVersion ||
    execution.adapterConfigurationFileSha256 !== execution.adapterConfigurationHash ||
    config.environmentPolicyHash !== execution.environmentPolicyHash ||
    configModel.id !== execution.model.id ||
    configModel.parametersHash !== execution.model.parametersHash ||
    configModel.provider !== execution.model.provider ||
    configModel.reasoningEffort !== execution.model.reasoningEffort
  ) {
    throw new Error('Continuation phase-one adapter config differs from the sealed execution identity.');
  }
  const request = object(requestInput, 'continuation phase-one request');
  const agentTask = object(request.agentTask, 'continuation phase-one agent task');
  const requestModel = object(request.model, 'continuation phase-one request model');
  if (
    request.adapterArtifactHash !== execution.adapterArtifactHash ||
    request.adapterConfigurationHash !== execution.adapterConfigurationHash ||
    request.adapterProtocol !== execution.adapterProtocol ||
    request.environmentPolicyHash !== execution.environmentPolicyHash ||
    request.runNonce !== execution.runNonce ||
    agentTask.prompt !== input.plan.checkpoint.phaseOnePrompt ||
    agentTask.repositoryFixtureHash !== input.plan.sourceTask.repositoryFixtureHash ||
    agentTask.taskId !== input.plan.taskId ||
    requestModel.model !== execution.model.id ||
    requestModel.parametersHash !== execution.model.parametersHash ||
    requestModel.provider !== execution.model.provider
  ) {
    throw new Error('Continuation phase-one request differs from the sealed execution identity.');
  }
  const artifact = object(artifactInput, 'continuation phase-one artifact');
  const agentResult = object(artifact.agentResult, 'continuation phase-one agent result');
  const artifactRepository = object(artifact.repository, 'continuation phase-one artifact repository');
  if (
    artifact.runNonce !== execution.runNonce ||
    artifact.taskId !== input.plan.taskId ||
    artifactRepository.fixtureHash !== input.plan.sourceTask.repositoryFixtureHash ||
    artifactRepository.revision !== input.plan.sourceTask.repositoryRevision ||
    typeof artifact.patch !== 'string' ||
    artifact.patch.length === 0
  ) {
    throw new Error('Continuation phase-one artifact differs from the sealed source task or contains no patch.');
  }
  const response = object(responseInput, 'continuation phase-one response');
  const metrics = object(response.metrics, 'continuation phase-one response metrics');
  const safety = object(metrics.safety, 'continuation phase-one response safety');
  const timing = object(metrics.timing, 'continuation phase-one response timing');
  const usage = object(metrics.usage, 'continuation phase-one response usage');
  const providerTokens = object(usage.providerTokens, 'continuation phase-one provider tokens');
  let independentlyAttestedExpectedFailure = false;
  if (agentResult.completed === false) {
    const completion = object(metrics.completion, 'continuation phase-one response completion');
    const validity = object(metrics.validity, 'continuation phase-one response validity');
    const verification = object(metrics.verification, 'continuation phase-one response verification');
    independentlyAttestedExpectedFailure =
      completion.completed === false &&
      validity.valid === true &&
      verification.taskId === input.plan.taskId &&
      verification.status === 'task-failed' &&
      verification.exitCode === 1;
  }
  if (agentResult.completed !== true && !independentlyAttestedExpectedFailure) {
    throw new Error('Continuation phase-one agent result lacks an independently attested expected failure.');
  }
  if (
    safety.authorizationLeaks !== 0 ||
    safety.harmfulActions !== 0 ||
    response.transcriptHash !== execution.transcriptHash ||
    timing.endToEndMilliseconds !== input.plan.checkpoint.phaseOneAccounting.elapsedMilliseconds ||
    providerTokens.cachedInputTokens !== input.plan.checkpoint.phaseOneAccounting.providerTokens?.cachedInputTokens ||
    providerTokens.inputTokens !== input.plan.checkpoint.phaseOneAccounting.providerTokens?.inputTokens ||
    providerTokens.outputTokens !== input.plan.checkpoint.phaseOneAccounting.providerTokens?.outputTokens ||
    providerTokens.reasoningOutputTokens !==
      input.plan.checkpoint.phaseOneAccounting.providerTokens?.reasoningOutputTokens ||
    providerTokens.totalTokens !== input.plan.checkpoint.phaseOneAccounting.providerTokens?.totalTokens
  ) {
    throw new Error('Continuation phase-one accounting differs from the sealed response.');
  }
  if (checkpointPatchSha256 !== input.plan.checkpoint.phaseOnePatchSha256) {
    throw new Error('Continuation checkpoint patch differs from the sealed plan.');
  }
  return {checkpointPatch: await readFile(paths.checkpointPatch, 'utf8')};
}

function continuationTreatment(
  variant: MatchedEvaluationContinuationVariantV1,
  checkpoint: MatchedEvaluationContinuationPilotPlan['checkpoint'],
): {readonly arm: MatchedEvaluationArm; readonly treatment: MatchedEvaluationContinuationTreatmentV1} {
  const requiredGraphQuery = 'diagnosticEvidence' in checkpoint ? checkpoint.diagnosticEvidence.graphQuery : null;
  switch (variant) {
    case 'files-bare':
      return {
        arm: 'files',
        treatment: {
          automaticHandoffUri: null,
          contextMode: null,
          manualHandoff: null,
          manualHandoffSha256: null,
          requiredGraphQuery: null,
          resumeEvidenceMarker: null,
          variant,
        },
      };
    case 'manual-handoff':
      return {
        arm: 'files',
        treatment: {
          automaticHandoffUri: null,
          contextMode: null,
          manualHandoff: checkpoint.handoff,
          manualHandoffSha256: checkpoint.handoffSha256,
          requiredGraphQuery: null,
          resumeEvidenceMarker: null,
          variant,
        },
      };
    case 'threadnote-graph':
      return {
        arm: 'threadnote-graph',
        treatment: {
          automaticHandoffUri: null,
          contextMode: 'brief',
          manualHandoff: null,
          manualHandoffSha256: null,
          requiredGraphQuery: null,
          resumeEvidenceMarker: null,
          variant,
        },
      };
    case 'threadnote-resume':
      return {
        arm: 'threadnote-compact',
        treatment: {
          automaticHandoffUri: checkpoint.automaticHandoffUri,
          contextMode: 'resume',
          manualHandoff: null,
          manualHandoffSha256: null,
          requiredGraphQuery: null,
          resumeEvidenceMarker: checkpoint.resumeEvidenceMarker,
          variant,
        },
      };
    case 'threadnote-preloaded-resume':
      return {
        arm: 'threadnote-compact',
        treatment: {
          automaticHandoffUri: checkpoint.automaticHandoffUri,
          contextMode: 'resume',
          manualHandoff: null,
          manualHandoffSha256: null,
          requiredGraphQuery,
          resumeEvidenceMarker: checkpoint.resumeEvidenceMarker,
          variant,
        },
      };
  }
}

export function projectMatchedEvaluationContinuationSelectionCheckpointV1(
  plan: MatchedEvaluationContinuationPilotPlan,
) {
  return {
    automaticHandoffUri: plan.checkpoint.automaticHandoffUri,
    handoffSha256: plan.checkpoint.handoffSha256,
    ...(plan.version !== 1
      ? {
          adapterConfigurations: plan.checkpoint.adapterConfigurations,
          ...('diagnosticEvidence' in plan.checkpoint ? {diagnosticEvidence: plan.checkpoint.diagnosticEvidence} : {}),
          phaseOneExecution: plan.checkpoint.phaseOneExecution,
          phaseOnePatchSha256: plan.checkpoint.phaseOnePatchSha256,
          phaseOnePromptSha256: plan.checkpoint.phaseOnePromptSha256,
          preparedContext: plan.checkpoint.preparedContext,
          preparedGraphHome: plan.checkpoint.preparedGraphHome,
          preparedHome: plan.checkpoint.preparedHome,
        }
      : {}),
    phaseOneAccounting: plan.checkpoint.phaseOneAccounting,
    repositoryFixtureHash: plan.checkpoint.repositoryFixtureHash,
    repositoryRevision: plan.checkpoint.repositoryRevision,
    resumeEvidenceMarker: plan.checkpoint.resumeEvidenceMarker,
    automaticHandoffReadSha256: plan.checkpoint.automaticHandoffReadSha256,
  };
}

function continuationPosition(index: number): 1 | 2 | 3 | 4 | 5 {
  switch (index) {
    case 0:
      return 1;
    case 1:
      return 2;
    case 2:
      return 3;
    case 3:
      return 4;
    case 4:
      return 5;
    default:
      throw new Error('Continuation pilot has an impossible attempt position.');
  }
}

const HASH = /^[0-9a-f]{64}$/u;
const CLUSTER_ID = /^cluster_[0-9a-f]{16,64}$/u;
const ENVIRONMENT_KEY = /^[A-Z][A-Z0-9_]{0,63}$/u;
const BLOCKED_ENVIRONMENT_KEYS = new Set([
  'DO_NOT_TRACK',
  'HOME',
  'LANG',
  'LC_ALL',
  'MATCHED_EVALUATION_ADAPTER_CONFIG',
  'MATCHED_EVALUATION_ADAPTER_EXECUTABLE',
  'MATCHED_EVALUATION_TOOL',
  'PATH',
  'THREADNOTE_TELEMETRY',
  'TMPDIR',
]);
const MAXIMUM_JSON_BYTES = 8 * 1_024 * 1_024;
const MAXIMUM_TRANSCRIPT_BYTES = 64 * 1_024 * 1_024;
const PRODUCTION_RELEASE_ARCHIVE_HASH = 'c234c12d56807fdd94ad0ffbfceafb45140ee73304fc6399da65051a35670fb1';
const PRODUCTION_RELEASE_EXECUTABLE_HASH = 'e8cef51bc029705614928c7ea69a5cb39e1b05f43f272ca495a947f5d5e32c15';

const program = Effect.gen(function* () {
  const options = parseArguments(yield* scriptArguments());
  yield* Effect.tryPromise({
    try: () => {
      if (options.continuationFinalizeDirectory !== null) {
        return finalizeMatchedEvaluationContinuationCheckpointFromFilesV1({
          corpusPath: options.corpusPath,
          manifestPath: options.manifestPath,
          outputDirectory: options.continuationFinalizeDirectory,
          runtimePath: options.runtimePath,
          studyPath: options.studyPath!,
        });
      }
      if (options.continuationPhaseOneTaskPacketPath !== null) {
        return runMatchedEvaluationContinuationPhaseOneFromFilesV1({
          corpusPath: options.corpusPath,
          expectedSelectionPath: options.continuationPhaseOneExpectedSelectionPath!,
          manifestPath: options.manifestPath,
          outputDirectory: options.continuationPhaseOneDirectory!,
          runtimePath: options.runtimePath,
          studyPath: options.studyPath!,
          taskPacketPath: options.continuationPhaseOneTaskPacketPath,
        });
      }
      if (options.continuationPilotPlanPath !== null) {
        return runMatchedEvaluationContinuationPilotFromFilesV1({
          corpusPath: options.corpusPath,
          manifestPath: options.manifestPath,
          parentPilotDirectory: options.continuationParentPilotDirectory,
          pilotDirectory: options.pilotDirectory!,
          planPath: options.continuationPilotPlanPath,
          resume: options.continuationPilotResume,
          runtimePath: options.runtimePath,
          studyPath: options.studyPath!,
        });
      }
      return options.pilotTaskId === null
        ? runMatchedEvaluationFromFilesV1(options)
        : runMatchedEvaluationPilotFromFilesV1({
            corpusPath: options.corpusPath,
            manifestPath: options.manifestPath,
            runtimePath: options.runtimePath,
            studyPath: options.studyPath!,
            taskId: options.pilotTaskId,
            pilotDirectory: options.pilotDirectory!,
          });
    },
    catch: cause => ScriptError.make({message: 'Matched evaluation stopped.', cause}),
  });
});

export async function runMatchedEvaluationFromFilesV1(options: {
  readonly corpusPath: string;
  readonly manifestPath: string;
  readonly runtimePath: string;
  readonly studyPath?: string | null;
}): Promise<void> {
  const [corpus, manifest, runtime, study] = await Promise.all([
    readJson(options.corpusPath).then(parseMatchedEvaluationCorpusV1),
    readJson(options.manifestPath).then(parseMatchedEvaluationManifestV1),
    readJson(options.runtimePath).then(parseMatchedEvaluationRuntimeV1),
    options.studyPath === null || options.studyPath === undefined
      ? Promise.resolve(null)
      : readJson(options.studyPath).then(parseMatchedTokenEfficiencyStudyV1),
  ]);
  if (study !== null) assertMatchedTokenEfficiencyStudyMatchesV1(study, corpus, manifest);
  if (runtime.verificationPlanHash !== (study?.verificationPlanHash ?? null)) {
    throw new Error('Runtime and study disagree on the sealed verification plan.');
  }
  const repositories = await resolveMatchedEvaluationRuntimeRepositoriesV1(runtime, study, manifest.repository);
  await assertLocalArtifactDirectory(runtime.artifactDirectory);
  await withMatchedEvaluationArtifactLockV1(runtime.artifactDirectory, async () => {
    await assertResolvedRuntimeRepositories(repositories);
    const outcomesPath = resolve(runtime.artifactDirectory, 'outcomes.jsonl');
    const summaryPath = resolve(runtime.artifactDirectory, 'summary.json');
    let expectedLedgerText = await readOptionalText(outcomesPath, 16 * 1_024 * 1_024);
    const existing = parseMatchedEvaluationOutcomesJsonlV1(expectedLedgerText);
    const ledgerOutcomes = [...existing];
    const resolved = new Map<MatchedEvaluationArm, ResolvedRuntimeArm>();
    const unavailable = new Map<
      MatchedEvaluationArm,
      {readonly detail: string; readonly reason: MatchedEvaluationUnavailableReason}
    >();
    const outcomes = await runMatchedEvaluationV1({
      availability: async (arm, definition) => {
        const resolution = await resolveRuntimeArm(runtime, arm, definition);
        if ('reason' in resolution) {
          unavailable.set(arm, resolution);
          return {available: false, ...resolution};
        }
        resolved.set(arm, resolution);
        return {available: true};
      },
      corpus,
      execute: async request => {
        const repository = requiredRuntimeRepository(repositories, request.task.taskId, study);
        await assertMatchedEvaluationRepositoryV1(repository.repositoryDirectory, repository.expected);
        const result = await executeArm(
          runtime,
          requiredResolvedArm(resolved, request.arm),
          repository,
          request,
          study,
        );
        await assertMatchedEvaluationRepositoryV1(repository.repositoryDirectory, repository.expected);
        return result;
      },
      manifest,
      onOutcome: async outcome => {
        if (ledgerOutcomes.length !== outcome.runOrder) {
          throw new Error('Outcome ledger prefix differs from the in-memory run prefix.');
        }
        const replacement = `${[...ledgerOutcomes, outcome].map(value => JSON.stringify(value)).join('\n')}\n`;
        await compareAndSwapMatchedEvaluationLedgerV1(outcomesPath, expectedLedgerText, replacement);
        expectedLedgerText = replacement;
        ledgerOutcomes.push(outcome);
      },
      outcomes: existing,
    });
    await assertResolvedRuntimeRepositories(repositories);
    const summary = summarizeMatchedEvaluationV1(manifest, outcomes);
    await atomicWrite(summaryPath, `${JSON.stringify(summary, undefined, 2)}\n`);
    const tokenEfficiencyReport =
      study === null ? null : evaluateMatchedTokenEfficiencyV1({corpus, manifest, outcomes, study});
    if (tokenEfficiencyReport !== null) {
      await Promise.all([
        atomicWrite(
          resolve(runtime.artifactDirectory, 'token-efficiency-report.json'),
          `${JSON.stringify(tokenEfficiencyReport, undefined, 2)}\n`,
        ),
        atomicWrite(
          resolve(runtime.artifactDirectory, 'article-evidence.md'),
          renderMatchedTokenEfficiencyArticleEvidenceV1(tokenEfficiencyReport),
        ),
      ]);
    }
    process.stdout.write(
      `${JSON.stringify({
        artifactDirectory: runtime.artifactDirectory,
        completed: outcomes.filter(outcome => outcome.status === 'completed').length,
        comparativeClaimsEligible: summary.comparativeClaimsEligible,
        manifestHash: manifest.manifestHash,
        tokenEfficiencyReportHash: tokenEfficiencyReport?.reportHash ?? null,
        unavailable: Object.fromEntries(unavailable),
        version: MATCHED_EVALUATION_RUNTIME_VERSION,
      })}\n`,
    );
  });
}

/** Execute exactly one frozen first-repetition row for each of the three pilot arms. */
export async function runMatchedEvaluationPilotFromFilesV1(options: {
  readonly corpusPath: string;
  readonly manifestPath: string;
  readonly runtimePath: string;
  readonly studyPath: string;
  readonly taskId: string;
  readonly pilotDirectory: string;
}): Promise<void> {
  const [corpus, manifest, runtime, study] = await Promise.all([
    readJson(options.corpusPath).then(parseMatchedEvaluationCorpusV1),
    readJson(options.manifestPath).then(parseMatchedEvaluationManifestV1),
    readJson(options.runtimePath).then(parseMatchedEvaluationRuntimeV1),
    readJson(options.studyPath).then(parseMatchedTokenEfficiencyStudyV1),
  ]);
  assertMatchedTokenEfficiencyStudyMatchesV1(study, corpus, manifest);
  if (runtime.verificationPlanHash !== study.verificationPlanHash) {
    throw new Error('Runtime and study disagree on the sealed verification plan.');
  }
  if (!manifest.tasks.some(task => task.taskId === options.taskId))
    throw new Error(`Pilot task ${options.taskId} is not in the manifest.`);
  const pilotDirectory = absolutePath(options.pilotDirectory, 'pilot directory');
  if (pilotDirectory === runtime.artifactDirectory)
    throw new Error('Pilot directory must be separate from the full-study artifact directory.');
  await mkdir(pilotDirectory, {recursive: true, mode: 0o700});
  if ((await realpath(pilotDirectory)) !== pilotDirectory)
    throw new Error('Pilot directory must use its canonical path.');
  const markerPath = resolve(pilotDirectory, 'pilot-selection.json');
  const selected = selectMatchedEvaluationPilotRowsV1(manifest, options.taskId);
  const selection = {
    completionMeaning:
      'completed is true only when all three adapter attempts completed; finished means the pilot loop stopped without retry.',
    comparativeClaimsEligible: false,
    identities: {
      manifestHash: manifest.manifestHash,
      runtimeVersion: runtime.version,
      studyHash: study.studyHash,
      verificationPlanHash: study.verificationPlanHash,
    },
    limitations: [
      'One task, one repetition, no CI, non-generalizable exploratory pilot.',
      'No full-study ledger or report is produced.',
    ],
    rows: selected.map(row => ({...row, arm: manifest.blindAssignment[row.blindLabel]})),
    taskId: options.taskId,
    version: 1,
  };
  try {
    await writeFile(markerPath, `${JSON.stringify(selection, undefined, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
  } catch (cause) {
    if ((cause as {code?: string}).code === 'EEXIST')
      throw new Error('Pilot selection already exists; resume/retry is not supported.', {cause});
    throw cause;
  }
  const pilotRuntime = {...runtime, artifactDirectory: pilotDirectory};
  const repositories = await resolveMatchedEvaluationRuntimeRepositoriesV1(pilotRuntime, study, manifest.repository);
  await assertResolvedRuntimeRepositories(repositories);
  const preflight = await Promise.all(
    selected.map(async row => {
      const arm = manifest.blindAssignment[row.blindLabel];
      const definition = manifest.arms.find(candidate => candidate.arm === arm);
      if (definition === undefined) throw new Error(`Pilot schedule arm ${arm} is not defined.`);
      const resolution = await resolveRuntimeArm(pilotRuntime, arm, definition);
      if ('reason' in resolution) throw new Error(`Pilot runtime unavailable for ${arm}: ${resolution.detail}`);
      return [arm, resolution] as const;
    }),
  );
  const resolved = new Map(preflight);
  const reportPath = resolve(pilotDirectory, 'pilot-report.json');
  const attempts: Array<Record<string, unknown>> = [];
  const writeReport = async (completed: boolean) =>
    atomicWrite(reportPath, `${JSON.stringify({...selection, attempts, completed}, undefined, 2)}\n`);
  await writeReport(false);
  for (const row of selected) {
    const arm = manifest.blindAssignment[row.blindLabel];
    const definition = manifest.arms.find(candidate => candidate.arm === arm);
    if (definition === undefined) throw new Error(`Pilot schedule arm ${arm} is not defined.`);
    const rawArtifactPath = resolve(pilotDirectory, 'runs', row.runNonce, 'artifact.json');
    const requestPath = resolve(pilotDirectory, 'runs', row.runNonce, 'request.json');
    const responsePath = resolve(pilotDirectory, 'runs', row.runNonce, 'response.json');
    const transcriptPath = resolve(pilotDirectory, 'transcripts', `${row.runNonce}.jsonl`);
    const checkpointPath = `${transcriptPath}.agent.jsonl`;
    const request = {
      arm,
      armDefinition: definition,
      manifest,
      schedule: row,
      task: corpus.tasks.find(task => task.taskId === options.taskId)!,
    };
    await assertMatchedEvaluationRepositoryV1(
      repositories.get(study.taskContexts.find(context => context.taskId === options.taskId)?.clusterId ?? null)!
        .repositoryDirectory,
      repositories.get(study.taskContexts.find(context => context.taskId === options.taskId)?.clusterId ?? null)!
        .expected,
    );
    try {
      const observation = await executeArm(
        pilotRuntime,
        requiredResolvedArm(resolved, arm),
        requiredRuntimeRepository(repositories, options.taskId, study),
        request,
        study,
      );
      attempts.push({
        arm,
        metrics: observation.metrics,
        rawArtifactPath,
        requestPath,
        responsePath,
        checkpointPath,
        runNonce: row.runNonce,
        runOrder: row.runOrder,
        status: 'completed',
        taskId: options.taskId,
        transcriptHash: observation.transcriptHash,
        transcriptPath,
      });
    } catch (cause) {
      if (!(cause instanceof Error) || !cause.message.includes('adapter failed with exit code')) throw cause;
      attempts.push({
        arm,
        diagnostics: cause.message.slice(-2_048),
        metrics: null,
        providerUsage: null,
        rawArtifactPath,
        requestPath,
        responsePath,
        checkpointPath,
        runNonce: row.runNonce,
        runOrder: row.runOrder,
        status: 'failed',
        taskId: options.taskId,
        transcriptPath,
      });
    } finally {
      await assertMatchedEvaluationRepositoryV1(
        requiredRuntimeRepository(repositories, options.taskId, study).repositoryDirectory,
        requiredRuntimeRepository(repositories, options.taskId, study).expected,
      );
    }
    await writeReport(false);
  }
  await assertResolvedRuntimeRepositories(repositories);
  const allCompleted = attempts.every(attempt => attempt.status === 'completed');
  await writeReport(allCompleted);
  process.stdout.write(
    `${JSON.stringify({artifactDirectory: pilotDirectory, attemptCount: attempts.length, comparativeClaimsEligible: false, completed: allCompleted, finished: true, version: 1})}\n`,
  );
}

/** Execute one common test-only Phase 1 after sealing its prompt and later treatment order. */
export async function runMatchedEvaluationContinuationPhaseOneFromFilesV1(options: {
  readonly corpusPath: string;
  readonly expectedSelectionPath: string;
  readonly manifestPath: string;
  readonly outputDirectory: string;
  readonly runtimePath: string;
  readonly studyPath: string;
  readonly taskPacketPath: string;
}): Promise<void> {
  const [corpus, expectedSelection, manifest, runtime, study, taskPacketBytes] = await Promise.all([
    readJson(options.corpusPath).then(parseMatchedEvaluationCorpusV1),
    readJson(options.expectedSelectionPath),
    readJson(options.manifestPath).then(parseMatchedEvaluationManifestV1),
    readJson(options.runtimePath).then(parseMatchedEvaluationRuntimeV1),
    readJson(options.studyPath).then(parseMatchedTokenEfficiencyStudyV1),
    readFile(options.taskPacketPath),
  ]);
  assertMatchedTokenEfficiencyStudyMatchesV1(study, corpus, manifest);
  if (runtime.verificationPlanHash !== study.verificationPlanHash) {
    throw new Error('Runtime and study disagree on the sealed verification plan.');
  }
  const packet = parseMatchedEvaluationContinuationPhaseOneTaskPacketV1(
    JSON.parse(taskPacketBytes.toString('utf8')) as unknown,
  );
  const matchingTasks = corpus.tasks.filter(task => task.prompt === packet.sourceTaskPrompt);
  if (matchingTasks.length !== 1) {
    throw new Error('Continuation phase-one packet must match exactly one frozen corpus task.');
  }
  const corpusTask = matchingTasks[0];
  const manifestTask = manifest.tasks.find(task => task.taskId === corpusTask.taskId);
  if (manifestTask === undefined) throw new Error(`Manifest lacks task ${corpusTask.taskId}.`);
  const taskContext = study.taskContexts.find(context => context.taskId === corpusTask.taskId);
  if (taskContext === undefined) throw new Error(`Study lacks task context ${corpusTask.taskId}.`);
  const cluster = study.clusters.find(candidate => candidate.clusterId === taskContext.clusterId);
  if (cluster === undefined) throw new Error(`Study lacks cluster ${taskContext.clusterId}.`);
  if (
    cluster.revision !== packet.sourceRevision ||
    cluster.repositoryFixtureHash !== corpusTask.repositoryFixtureHash ||
    manifestTask.promptHash !== matchedEvaluationPromptHashV1(packet.sourceTaskPrompt)
  ) {
    throw new Error('Continuation phase-one packet differs from the frozen task identity.');
  }
  const outputDirectory = absolutePath(options.outputDirectory, 'continuation phase-one output directory');
  if (outputDirectory === runtime.artifactDirectory) {
    throw new Error('Continuation phase-one output must differ from the full-study artifact directory.');
  }
  await mkdir(outputDirectory, {recursive: true, mode: 0o700});
  if ((await realpath(outputDirectory)) !== outputDirectory) {
    throw new Error('Continuation phase-one output directory must use its canonical path.');
  }
  const selection = createMatchedEvaluationContinuationPhaseOneSelectionV1({
    packet,
    repositoryRevision: cluster.revision,
    task: manifestTask,
    taskPacketSha256: sha256Bytes(taskPacketBytes),
    taskPrompt: corpusTask.prompt,
  });
  assertMatchedEvaluationContinuationPhaseOnePreregistrationV1(expectedSelection, selection);
  await writeFile(resolve(outputDirectory, 'phase-one-task-packet.json'), taskPacketBytes, {flag: 'wx', mode: 0o600});
  const selectionPath = resolve(outputDirectory, 'phase-one-selection.json');
  try {
    await writeFile(selectionPath, `${JSON.stringify(selection, undefined, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
  } catch (cause) {
    if ((cause as {code?: string}).code === 'EEXIST') {
      throw new Error('Continuation phase-one selection already exists; retry is not supported.', {cause});
    }
    throw cause;
  }
  const filesDefinition = manifest.arms.find(definition => definition.arm === 'files');
  if (filesDefinition === undefined) throw new Error('Manifest lacks the files arm definition.');
  const executionDirectory = resolve(outputDirectory, 'phase-one-execution');
  const phaseOneRuntime = {...runtime, artifactDirectory: executionDirectory};
  const repositories = await resolveMatchedEvaluationRuntimeRepositoriesV1(phaseOneRuntime, study, manifest.repository);
  await assertResolvedRuntimeRepositories(repositories);
  const resolution = await resolveRuntimeArm(phaseOneRuntime, 'files', filesDefinition);
  if ('reason' in resolution) {
    throw new Error(`Continuation phase-one files runtime unavailable: ${resolution.detail}`);
  }
  const blindLabel = Object.entries(manifest.blindAssignment).find(([, arm]) => arm === 'files')?.[0] as
    MatchedEvaluationRunRequestV1['schedule']['blindLabel'] | undefined;
  if (blindLabel === undefined) throw new Error('Manifest blind assignment lacks the files arm.');
  const request: MatchedEvaluationRunRequestV1 = {
    arm: 'files',
    armDefinition: filesDefinition,
    manifest,
    schedule: {
      blindLabel,
      position: 1,
      repetition: 0,
      runNonce: selection.phaseOneRunNonce,
      runOrder: 0,
      taskId: corpusTask.taskId,
    },
    task: {...corpusTask, prompt: selection.phaseOnePrompt},
  };
  const repository = requiredRuntimeRepository(repositories, corpusTask.taskId, study);
  await executeArm(phaseOneRuntime, resolution, repository, request, study);
  await assertMatchedEvaluationRepositoryV1(repository.repositoryDirectory, repository.expected);
  const runDirectory = resolve(executionDirectory, 'runs', selection.phaseOneRunNonce);
  const transcriptPath = resolve(executionDirectory, 'transcripts', `${selection.phaseOneRunNonce}.jsonl`);
  const evidenceDirectory = resolve(outputDirectory, 'phase-one');
  await mkdir(evidenceDirectory, {mode: 0o700});
  const evidence = [
    [resolve(runDirectory, 'runtime', 'adapter'), resolve(evidenceDirectory, 'adapter')],
    [resolve(runDirectory, 'runtime', 'adapter-config.json'), resolve(evidenceDirectory, 'adapter-config.json')],
    [resolve(runDirectory, 'artifact.json'), resolve(evidenceDirectory, 'artifact.json')],
    [resolve(runDirectory, 'request.json'), resolve(evidenceDirectory, 'request.json')],
    [resolve(runDirectory, 'response.json'), resolve(evidenceDirectory, 'response.json')],
    [transcriptPath, resolve(evidenceDirectory, 'transcript.jsonl')],
  ] as const;
  await Promise.all(
    evidence.map(async ([source, destination]) =>
      writeFile(destination, await readFile(source), {
        flag: 'wx',
        mode: destination.endsWith('/adapter') ? 0o700 : 0o600,
      }),
    ),
  );
  await sealMatchedEvaluationContinuationPhaseOneEvidenceV1({outputDirectory});
  process.stdout.write(`${JSON.stringify({outputDirectory, taskId: corpusTask.taskId, version: 1})}\n`);
}

/** Seal preserved Phase-1 evidence without repeating the provider call. */
export async function sealMatchedEvaluationContinuationPhaseOneEvidenceV1(options: {
  readonly outputDirectory: string;
}): Promise<MatchedEvaluationContinuationPhaseOneReceiptV1> {
  const outputDirectory = await canonicalDirectory(options.outputDirectory, 'continuation phase-one output directory');
  const evidenceDirectory = resolve(outputDirectory, 'phase-one');
  const selectionPath = resolve(outputDirectory, 'phase-one-selection.json');
  const [selectionInput, taskPacketBytes, artifactInput, observationInput] = await Promise.all([
    readJson(selectionPath),
    readFile(resolve(outputDirectory, 'phase-one-task-packet.json')),
    readJson(resolve(evidenceDirectory, 'artifact.json')),
    readJson(resolve(evidenceDirectory, 'response.json')),
  ]);
  const selection = parseMatchedEvaluationContinuationPhaseOneSelectionV1(selectionInput);
  if (sha256Bytes(taskPacketBytes) !== selection.taskPacketSha256) {
    throw new Error('Continuation phase-one task packet bytes differ from the sealed selection.');
  }
  const observation = parseMatchedEvaluationObservationV1(observationInput);
  assertMatchedEvaluationContinuationPhaseOneResultV1(artifactInput, observation, selection.sourceTask.taskId);
  const [
    adapterArtifactHash,
    adapterConfigurationFileSha256,
    artifactSha256,
    requestSha256,
    responseSha256,
    transcriptSha256,
  ] = await Promise.all([
    boundedRegularFileHash(resolve(evidenceDirectory, 'adapter'), 128 * 1_024 * 1_024, 'phase-one adapter'),
    boundedRegularFileHash(
      resolve(evidenceDirectory, 'adapter-config.json'),
      MAXIMUM_JSON_BYTES,
      'phase-one adapter config',
    ),
    boundedRegularFileHash(resolve(evidenceDirectory, 'artifact.json'), MAXIMUM_JSON_BYTES, 'phase-one artifact'),
    boundedRegularFileHash(resolve(evidenceDirectory, 'request.json'), MAXIMUM_JSON_BYTES, 'phase-one request'),
    boundedRegularFileHash(resolve(evidenceDirectory, 'response.json'), MAXIMUM_JSON_BYTES, 'phase-one response'),
    boundedRegularFileHash(
      resolve(evidenceDirectory, 'transcript.jsonl'),
      MAXIMUM_TRANSCRIPT_BYTES,
      'phase-one transcript',
    ),
  ]);
  const receipt: MatchedEvaluationContinuationPhaseOneReceiptV1 = {
    continuationAttempts: selection.continuationAttempts,
    evidenceSha256: {
      adapterArtifactHash,
      adapterConfigurationFileSha256,
      artifactSha256,
      requestSha256,
      responseSha256,
      transcriptSha256,
    },
    metrics: observation.metrics,
    phaseOnePromptSha256: selection.phaseOnePromptSha256,
    phaseOneRunNonce: selection.phaseOneRunNonce,
    selectionSha256: await boundedRegularFileHash(
      selectionPath,
      MAXIMUM_JSON_BYTES,
      'continuation phase-one selection',
    ),
    taskId: selection.sourceTask.taskId,
    taskPacketSha256: selection.taskPacketSha256,
    transcriptHash: observation.transcriptHash,
    version: 1,
  } as const;
  await atomicWrite(resolve(outputDirectory, 'phase-one-receipt.json'), `${JSON.stringify(receipt, undefined, 2)}\n`);
  return receipt;
}

export function assertMatchedEvaluationContinuationPhaseOneResultV1(
  artifactInput: unknown,
  observationInput: unknown,
  taskId: string,
): void {
  const artifact = object(artifactInput, 'continuation phase-one artifact');
  const agentResult = object(artifact.agentResult, 'continuation phase-one agent result');
  if (typeof artifact.patch !== 'string' || artifact.patch.length === 0) {
    throw new Error('Continuation phase-one agent did not return a nonempty test patch.');
  }
  const observation = parseMatchedEvaluationObservationV1(observationInput);
  const verification = observation.metrics.verification;
  if (
    observation.metrics.validity.valid !== true ||
    verification === null ||
    verification.taskId !== taskId ||
    verification.status !== 'task-failed' ||
    verification.exitCode === 0
  ) {
    throw new Error('Continuation phase-one deterministic verifier did not attest the expected failing regression.');
  }
  // Phase 1 deliberately asks the agent to complete a regression-only assignment while
  // the phase-two verifier must still fail. Those two completion signals describe
  // different contracts and are therefore not expected to agree.
  if (typeof agentResult.completed !== 'boolean') {
    throw new Error('Continuation phase-one agent completion evidence is invalid.');
  }
}

export function extractMatchedEvaluationContinuationPhaseOneEvidenceV1(
  transcript: string,
  changedPaths: readonly string[],
): {readonly anchors: string; readonly observations: string} {
  const finalAnswer = matchedEvaluationContinuationPhaseOneFinalAnswer(transcript);
  exactKeys(finalAnswer, ['citations', 'completed', 'summary'], 'continuation phase-one structured final answer');
  if (finalAnswer.completed !== true) {
    throw new Error('Continuation phase-one structured final answer is not completed.');
  }
  const observations = boundedString(finalAnswer.summary, 1, 2_048, 'continuation phase-one observed summary')
    .replace(/\s+/gu, ' ')
    .trim();
  if (observations.length === 0) {
    throw new Error('Continuation phase-one observed summary must contain non-whitespace evidence.');
  }
  const allowedPaths = new Set(changedPaths);
  const anchors = array(finalAnswer.citations, 'continuation phase-one final citations').map((citation, index) => {
    const value = object(citation, `continuation phase-one final citation ${index}`);
    exactKeys(value, ['endLine', 'path', 'startLine'], `continuation phase-one final citation ${index}`);
    const path = boundedString(value.path, 1, 1_024, `continuation phase-one final citation ${index} path`);
    if (isAbsolute(path) || path.split('/').some(segment => segment === '..') || !allowedPaths.has(path)) {
      throw new Error('Continuation phase-one final citation must name a changed regression path.');
    }
    const startLine = boundedPositiveInteger(
      value.startLine,
      1,
      10_000_000,
      `continuation phase-one final citation ${index} start line`,
    );
    const endLine = boundedPositiveInteger(
      value.endLine,
      startLine,
      10_000_000,
      `continuation phase-one final citation ${index} end line`,
    );
    return `${path}:${startLine}-${endLine}`;
  });
  if (anchors.length === 0) throw new Error('Continuation phase-one final answer lacks a changed regression citation.');
  return {anchors: [...new Set(anchors)].join(', '), observations};
}

export function extractMatchedEvaluationContinuationPhaseOneEvidenceV2(
  transcript: string,
  changedPaths: readonly string[],
): {
  readonly diagnosticEvidence: MatchedEvaluationContinuationDiagnosticEvidenceV1;
  readonly regressionAnchors: string;
} {
  const finalAnswer = matchedEvaluationContinuationPhaseOneFinalAnswer(transcript);
  exactKeys(finalAnswer, ['citations', 'completed', 'summary'], 'continuation phase-one structured final answer');
  if (finalAnswer.completed !== true) {
    throw new Error('Continuation phase-one structured final answer is not completed.');
  }
  const summary = boundedString(finalAnswer.summary, 1, 8_192, 'continuation phase-one diagnostic summary');
  const summaryLines = summary.split(/\r?\n/u).map(line => line.trim());
  const expectedPrefixes = [
    'Diagnosis: ',
    'Rejected hypothesis: ',
    'Verified invariant: ',
    'Untested invariant: ',
    'Unresolved gap: ',
    'Graph question: ',
    'Graph query: ',
  ] as const;
  if (
    summaryLines.length !== expectedPrefixes.length ||
    summaryLines.some((line, index) => !line.startsWith(expectedPrefixes[index]) || line === expectedPrefixes[index])
  ) {
    throw new Error('Continuation diagnostic summary must contain exactly the seven ordered contract lines.');
  }
  const fields = {
    diagnosticConclusion: uniquePrefixedLine(summary, 'Diagnosis: ', 'continuation diagnostic conclusion'),
    graphQuery: uniquePrefixedLine(summary, 'Graph query: ', 'continuation diagnostic graph query'),
    graphQuestion: uniquePrefixedLine(summary, 'Graph question: ', 'continuation diagnostic graph question'),
    rejectedHypothesis: uniquePrefixedLine(
      summary,
      'Rejected hypothesis: ',
      'continuation diagnostic rejected hypothesis',
    ),
    unresolvedGap: uniquePrefixedLine(summary, 'Unresolved gap: ', 'continuation diagnostic unresolved gap'),
    untestedInvariant: uniquePrefixedLine(
      summary,
      'Untested invariant: ',
      'continuation diagnostic untested invariant',
    ),
    verifiedInvariant: uniquePrefixedLine(
      summary,
      'Verified invariant: ',
      'continuation diagnostic verified invariant',
    ),
  };
  const changed = new Set(changedPaths);
  const regressionAnchors: string[] = [];
  const sourceCitations: MatchedEvaluationContinuationDiagnosticEvidenceV1['sourceCitations'][number][] = [];
  for (const [index, entry] of array(finalAnswer.citations, 'continuation phase-one diagnostic citations').entries()) {
    const citation = object(entry, `continuation phase-one diagnostic citation ${index}`);
    exactKeys(citation, ['endLine', 'path', 'startLine'], `continuation phase-one diagnostic citation ${index}`);
    const path = boundedString(citation.path, 1, 1_024, `continuation phase-one diagnostic citation ${index} path`);
    if (!isSafeContinuationRepositoryPath(path)) {
      throw new Error('Continuation phase-one diagnostic citation path is invalid.');
    }
    const startLine = boundedPositiveInteger(
      citation.startLine,
      1,
      10_000_000,
      `continuation phase-one diagnostic citation ${index} start line`,
    );
    const endLine = boundedPositiveInteger(
      citation.endLine,
      startLine,
      10_000_000,
      `continuation phase-one diagnostic citation ${index} end line`,
    );
    if (changed.has(path)) regressionAnchors.push(`${path}:${startLine}-${endLine}`);
    else sourceCitations.push({endLine, path, startLine});
  }
  if (regressionAnchors.length === 0) {
    throw new Error('Continuation diagnostic evidence lacks a changed regression citation.');
  }
  const graphQuery = buildMatchedEvaluationContinuationAnchoredGraphQueryV1({
    fallbackQuery: fields.graphQuery,
    graphQuestion: fields.graphQuestion,
    sourceCitations,
  });
  const diagnosticEvidence = parseMatchedEvaluationContinuationDiagnosticEvidenceV1({
    ...fields,
    graphQuery,
    sourceCitations,
  });
  return {diagnosticEvidence, regressionAnchors: [...new Set(regressionAnchors)].join(', ')};
}

function matchedEvaluationContinuationPhaseOneFinalAnswer(transcript: string): Record<string, unknown> {
  const envelopes = transcript
    .split(/\r?\n/gu)
    .map(line => line.trim())
    .filter(Boolean)
    .map((line, index) => object(JSON.parse(line) as unknown, `continuation phase-one transcript line ${index + 1}`));
  const agentEnvelopes = envelopes.filter(envelope => envelope.kind === 'agent');
  if (agentEnvelopes.length !== 1) {
    throw new Error('Continuation phase-one transcript must contain exactly one agent envelope.');
  }
  const events = array(agentEnvelopes[0].events, 'continuation phase-one agent events');
  const finalMessages = events.flatMap((event, index) => {
    const envelope = object(event, `continuation phase-one agent event ${index}`);
    if (envelope.method !== 'item/completed') return [];
    const params = object(envelope.params, `continuation phase-one agent event ${index} params`);
    const item = object(params.item, `continuation phase-one agent event ${index} item`);
    return item.type === 'agentMessage' && item.phase === 'final_answer' ? [item] : [];
  });
  if (finalMessages.length !== 1) {
    throw new Error('Continuation phase-one transcript must contain exactly one completed final answer.');
  }
  const finalText = boundedString(finalMessages[0].text, 1, 16 * 1_024, 'continuation phase-one final answer text');
  return object(JSON.parse(finalText) as unknown, 'continuation phase-one structured final answer');
}

/** Turn preserved Phase-1 evidence into one direct-child checkpoint and sealed v2 continuation plan. */
export async function finalizeMatchedEvaluationContinuationCheckpointFromFilesV1(options: {
  readonly corpusPath: string;
  readonly manifestPath: string;
  readonly outputDirectory: string;
  readonly runtimePath: string;
  readonly studyPath: string;
}): Promise<void> {
  const outputDirectory = await canonicalDirectory(options.outputDirectory, 'continuation checkpoint output directory');
  const selectionPath = resolve(outputDirectory, 'phase-one-selection.json');
  const [
    corpus,
    manifest,
    runtime,
    study,
    taskPacketBytes,
    selectionInput,
    receiptInput,
    artifactInput,
    requestInput,
    responseInput,
  ] = await Promise.all([
    readJson(options.corpusPath).then(parseMatchedEvaluationCorpusV1),
    readJson(options.manifestPath).then(parseMatchedEvaluationManifestV1),
    readJson(options.runtimePath).then(parseMatchedEvaluationRuntimeV1),
    readJson(options.studyPath).then(parseMatchedTokenEfficiencyStudyV1),
    readFile(resolve(outputDirectory, 'phase-one-task-packet.json')),
    readJson(selectionPath),
    readJson(resolve(outputDirectory, 'phase-one-receipt.json')),
    readJson(resolve(outputDirectory, 'phase-one', 'artifact.json')),
    readJson(resolve(outputDirectory, 'phase-one', 'request.json')),
    readJson(resolve(outputDirectory, 'phase-one', 'response.json')),
  ]);
  assertMatchedTokenEfficiencyStudyMatchesV1(study, corpus, manifest);
  const selection = parseMatchedEvaluationContinuationPhaseOneSelectionV1(selectionInput);
  const phaseOneReceipt = parseMatchedEvaluationContinuationPhaseOneReceiptV1(receiptInput);
  if (sha256Bytes(taskPacketBytes) !== selection.taskPacketSha256) {
    throw new Error('Continuation phase-one task packet bytes differ from the sealed selection.');
  }
  const corpusTask = corpus.tasks.find(task => task.taskId === selection.sourceTask.taskId);
  if (corpusTask === undefined || corpusTask.prompt !== selection.sourceTask.prompt) {
    throw new Error('Continuation checkpoint selection differs from the frozen corpus task.');
  }
  const taskContext = study.taskContexts.find(context => context.taskId === corpusTask.taskId);
  if (taskContext === undefined) throw new Error(`Study lacks task context ${corpusTask.taskId}.`);
  const cluster = study.clusters.find(candidate => candidate.clusterId === taskContext.clusterId);
  if (cluster === undefined) throw new Error(`Study lacks cluster ${taskContext.clusterId}.`);
  const runtimeRepository = runtime.repositories.find(repository => repository.clusterId === cluster.clusterId);
  if (runtimeRepository === undefined) throw new Error(`Runtime lacks cluster ${cluster.clusterId}.`);
  await assertMatchedEvaluationRepositoryV1(runtimeRepository.repositoryDirectory, {
    dirty: false,
    fixtureHash: cluster.repositoryFixtureHash,
    identityHash: cluster.repositoryIdentityHash,
    revision: cluster.revision,
  });
  const artifact = object(artifactInput, 'continuation phase-one artifact');
  const request = object(requestInput, 'continuation phase-one request');
  const response = object(responseInput, 'continuation phase-one response');
  const responseObservation = parseMatchedEvaluationObservationV1(responseInput);
  const [
    adapterArtifactHash,
    adapterConfigurationFileSha256,
    artifactSha256,
    requestSha256,
    responseSha256,
    transcriptSha256,
    selectionSha256,
  ] = await Promise.all([
    boundedRegularFileHash(resolve(outputDirectory, 'phase-one', 'adapter'), 128 * 1_024 * 1_024, 'phase-one adapter'),
    boundedRegularFileHash(
      resolve(outputDirectory, 'phase-one', 'adapter-config.json'),
      MAXIMUM_JSON_BYTES,
      'phase-one adapter config',
    ),
    boundedRegularFileHash(
      resolve(outputDirectory, 'phase-one', 'artifact.json'),
      MAXIMUM_JSON_BYTES,
      'phase-one artifact',
    ),
    boundedRegularFileHash(
      resolve(outputDirectory, 'phase-one', 'request.json'),
      MAXIMUM_JSON_BYTES,
      'phase-one request',
    ),
    boundedRegularFileHash(
      resolve(outputDirectory, 'phase-one', 'response.json'),
      MAXIMUM_JSON_BYTES,
      'phase-one response',
    ),
    boundedRegularFileHash(
      resolve(outputDirectory, 'phase-one', 'transcript.jsonl'),
      MAXIMUM_TRANSCRIPT_BYTES,
      'phase-one transcript',
    ),
    boundedRegularFileHash(selectionPath, MAXIMUM_JSON_BYTES, 'continuation phase-one selection'),
  ]);
  assertMatchedEvaluationContinuationPhaseOneReceiptV1({
    evidenceSha256: {
      adapterArtifactHash,
      adapterConfigurationFileSha256,
      artifactSha256,
      requestSha256,
      responseSha256,
      transcriptSha256,
    },
    receipt: phaseOneReceipt,
    responseObservation,
    selection,
    selectionSha256,
  });
  assertMatchedEvaluationContinuationPhaseOneResultV1(artifactInput, responseObservation, corpusTask.taskId);
  const agentPatch = boundedString(artifact.patch, 1, 8 * 1_024 * 1_024, 'continuation phase-one agent patch');
  if (request.runNonce !== selection.phaseOneRunNonce || artifact.runNonce !== selection.phaseOneRunNonce) {
    throw new Error('Continuation phase-one evidence differs from its sealed selection.');
  }
  const checkpointRepository = resolve(outputDirectory, 'checkpoint-repository');
  const checkpointAlreadyExists = await lstat(checkpointRepository).then(
    entry => {
      if (!entry.isDirectory()) throw new Error('Continuation checkpoint path exists but is not a directory.');
      return true;
    },
    cause => {
      if (isMissing(cause)) return false;
      throw cause;
    },
  );
  if (!checkpointAlreadyExists) {
    await captureContinuationGit(runtimeRepository.repositoryDirectory, [
      'worktree',
      'add',
      '--detach',
      checkpointRepository,
      selection.sourceTask.repositoryRevision,
    ]);
  }
  const agentPatchPath = resolve(outputDirectory, 'phase-one', 'agent.patch');
  const preservedAgentPatch = await readFile(agentPatchPath, 'utf8').catch(cause => {
    if (isMissing(cause)) return null;
    throw cause;
  });
  if (preservedAgentPatch === null) {
    await writeFile(agentPatchPath, agentPatch, {encoding: 'utf8', flag: 'wx', mode: 0o600});
  } else if (preservedAgentPatch !== agentPatch) {
    throw new Error('Continuation checkpoint preserved patch differs from the phase-one artifact.');
  }
  const checkpointPatchPath = resolve(outputDirectory, 'phase-one', 'checkpoint.patch');
  const {changedPaths, checkpointPatch, needsCommit} = await prepareMatchedEvaluationContinuationPhaseOnePatchV1({
    agentPatchPath,
    allowedPaths: selection.taskPacket.phaseOneAllowedPaths,
    baseRevision: selection.sourceTask.repositoryRevision,
    checkpointPatchPath,
    repositoryDirectory: checkpointRepository,
  });
  const filesConfig = parseMatchedEvaluationCodexAdapterConfigV1(
    await readJson(resolve(outputDirectory, 'phase-one', 'adapter-config.json')),
  );
  const phaseTwoCommands = matchContinuationPhaseTwoCommandsV1({
    approvedCommands: filesConfig.approvedCommands,
    commandTexts: selection.taskPacket.phaseTwoFocusedChecks,
    taskId: corpusTask.taskId,
  });
  const dependencyProjection = dependencyProjectionForTaskV1(filesConfig, corpusTask.taskId);
  const focusedCommand = phaseTwoCommands[0];
  const verificationTask = filesConfig.verificationPlan?.tasks.find(task => task.taskId === corpusTask.taskId);
  if (verificationTask === undefined) {
    throw new Error('Continuation phase-one checkpoint lacks a calibrated accepted correction.');
  }
  await assertMatchedEvaluationContinuationAcceptedFixCompatibilityV1({
    allowedPaths: selection.taskPacket.phaseOneAllowedPaths,
    calibration: verificationTask.calibration,
    checkpointRepositoryDirectory: checkpointRepository,
    commandTokens: focusedCommand.tokens,
    dependencyProjection,
    repositoryDirectory: runtimeRepository.repositoryDirectory,
    repositoryIdentityHash: cluster.repositoryIdentityHash,
    safeExecutablePath: filesConfig.safeExecutablePath,
  });
  await ensureMatchedEvaluationDependencyProjectionV1({
    projection: dependencyProjection,
    repositoryDirectory: checkpointRepository,
  });
  const focusedCheck = await runMatchedEvaluationContinuationFocusedCheckV1({
    commandTokens: focusedCommand.tokens,
    repositoryDirectory: checkpointRepository,
    safeExecutablePath: filesConfig.safeExecutablePath,
    temporaryDirectory: resolve(outputDirectory, 'phase-one-check-tmp'),
  });
  if (focusedCheck.exitCode !== 1) {
    throw new Error(
      `Continuation phase-one focused check must fail with exit code 1, received ${focusedCheck.exitCode}.`,
    );
  }
  if (needsCommit) {
    await captureContinuationGit(checkpointRepository, [
      '-c',
      'user.name=Threadnote Evaluation',
      '-c',
      'user.email=evaluation@threadnote.invalid',
      'commit',
      '-m',
      `test: add ${selection.taskPacket.taskKey} regression checkpoint`,
    ]);
  }
  const checkpoint = await observeMatchedEvaluationRepositoryV1(checkpointRepository);
  if (checkpoint.dirty || checkpoint.identityHash !== cluster.repositoryIdentityHash) {
    throw new Error('Continuation checkpoint repository is dirty or has a different identity.');
  }
  const phaseOnePatchSha256 = sha256Bytes(Buffer.from(checkpointPatch));
  await assertMatchedEvaluationContinuationCheckpointV2({
    agentPatch: checkpointPatch,
    baseFixtureHash: selection.sourceTask.repositoryFixtureHash,
    baseRevision: selection.sourceTask.repositoryRevision,
    checkpoint,
    patchSha256: phaseOnePatchSha256,
    repositoryDirectory: checkpointRepository,
  });
  const phaseTwoVerification = await prepareMatchedEvaluationContinuationPhaseTwoVerificationPlanV1({
    checkpointRevision: checkpoint.revision,
    commands: phaseTwoCommands,
    dependencyProjection,
    protectedPaths: [
      ...new Set([
        ...selection.taskPacket.phaseOneAllowedPaths,
        ...(selection.taskPacket.version === 1 ? [] : selection.taskPacket.phaseTwoProtectedPaths),
      ]),
    ].sort(),
    repositoryDirectory: checkpointRepository,
    safeExecutablePath: filesConfig.safeExecutablePath,
    taskId: corpusTask.taskId,
    temporaryRoot: resolve(outputDirectory, 'phase-two-verification-baseline-tmp'),
  });

  const graphArm = runtime.arms.find(arm => arm.arm === 'threadnote-graph');
  const compactArm = runtime.arms.find(arm => arm.arm === 'threadnote-compact');
  const graphDefinition = manifest.arms.find(arm => arm.arm === 'threadnote-graph');
  const compactDefinition = manifest.arms.find(arm => arm.arm === 'threadnote-compact');
  if (
    graphArm?.toolExecutable === null ||
    graphArm?.toolExecutable === undefined ||
    compactArm?.toolExecutable !== graphArm.toolExecutable ||
    graphDefinition?.tool.artifactHash === null ||
    graphDefinition === undefined ||
    compactDefinition === undefined
  ) {
    throw new Error('Continuation checkpoint runtime lacks one shared pinned Threadnote candidate.');
  }
  const sourceGraphConfig = parseMatchedEvaluationCodexAdapterConfigV1(await readJson(graphArm.adapterConfigFile));
  const sourceCompactConfig = parseMatchedEvaluationCodexAdapterConfigV1(await readJson(compactArm.adapterConfigFile));
  const sourceGraphHome = sourceGraphConfig.contextHomes.find(home => home.taskId === corpusTask.taskId);
  const sourceCompactHome = sourceCompactConfig.contextHomes.find(home => home.taskId === corpusTask.taskId);
  if (
    sourceGraphHome === undefined ||
    sourceCompactHome === undefined ||
    sourceGraphHome.project !== sourceCompactHome.project ||
    JSON.stringify(sourceGraphHome.identity) !== JSON.stringify(sourceCompactHome.identity)
  ) {
    throw new Error('Continuation checkpoint source homes do not share one task identity.');
  }
  const graphHome = resolve(outputDirectory, 'checkpoint-homes', 'graph');
  const compactHome = resolve(outputDirectory, 'checkpoint-homes', 'compact');
  await mkdir(resolve(outputDirectory, 'checkpoint-homes'), {mode: 0o700});
  const threadnoteEnvironment = {
    HOME: '/nonexistent',
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    PATH: sourceGraphConfig.safeExecutablePath,
    THREADNOTE_ACCOUNT: sourceGraphHome.identity.account,
    THREADNOTE_TELEMETRY: '0',
    THREADNOTE_USER: sourceGraphHome.identity.user,
  } as const;
  await captureCodeMemoryLinkProcessGroup({
    arguments: [
      'project',
      'create',
      sourceGraphHome.project,
      '--home',
      graphHome,
      '--path',
      checkpointRepository,
      '--json',
    ],
    command: graphArm.toolExecutable,
    cwd: checkpointRepository,
    environment: threadnoteEnvironment,
    label: 'Continuation checkpoint project registration',
    maxOutputBytes: 512 * 1_024,
    timeoutMilliseconds: 120_000,
  });
  const graphIndex = await captureCodeMemoryLinkProcessGroup({
    arguments: [
      'graph',
      'index',
      '--home',
      graphHome,
      '--cwd',
      checkpointRepository,
      '--project',
      sourceGraphHome.project,
      '--full',
      '--no-vectors',
      '--json',
    ],
    command: graphArm.toolExecutable,
    cwd: checkpointRepository,
    environment: threadnoteEnvironment,
    label: 'Continuation checkpoint graph index',
    maxOutputBytes: 2 * 1_024 * 1_024,
    timeoutMilliseconds: 30 * 60_000,
  });
  const graphIndexResult = parseLastJsonLine(graphIndex.stdout, 'continuation checkpoint graph index');
  const indexSnapshot = object(graphIndexResult.snapshot, 'continuation checkpoint graph snapshot');
  if (graphIndexResult.type !== 'code-graph-index' || indexSnapshot.commit !== checkpoint.revision) {
    throw new Error('Continuation checkpoint graph index differs from the checkpoint revision.');
  }
  const graphStatus = await captureCodeMemoryLinkProcessGroup({
    arguments: [
      'graph',
      'status',
      '--home',
      graphHome,
      '--cwd',
      checkpointRepository,
      '--project',
      sourceGraphHome.project,
      '--json',
    ],
    command: graphArm.toolExecutable,
    cwd: checkpointRepository,
    environment: threadnoteEnvironment,
    label: 'Continuation checkpoint graph status',
    maxOutputBytes: 512 * 1_024,
    timeoutMilliseconds: 120_000,
  });
  const graphStatusResult = object(JSON.parse(graphStatus.stdout) as unknown, 'continuation checkpoint graph status');
  const statusSnapshot = object(graphStatusResult.readySnapshot, 'continuation checkpoint graph status snapshot');
  if (statusSnapshot.commit !== checkpoint.revision || statusSnapshot.state !== 'ready') {
    throw new Error('Continuation checkpoint graph is not exact-current and ready.');
  }
  const graphContentHash = matchedTokenEfficiencyGraphContentHashV1(
    boundedString(statusSnapshot.graphContentId, 1, 256, 'checkpoint graph content id'),
  );
  const graphSnapshotHash = matchedTokenEfficiencyGraphSnapshotHashV1(
    boundedString(statusSnapshot.id, 1, 256, 'checkpoint graph snapshot id'),
  );
  if (graphSnapshotHash === taskContext.graphSnapshotHash) {
    throw new Error('Continuation checkpoint graph snapshot unexpectedly equals the source snapshot.');
  }
  await cp(graphHome, compactHome, {errorOnExist: true, force: false, recursive: true});
  const resumeEvidenceMarker = `threadnote-resume-${phaseOnePatchSha256.slice(0, 20)}`;
  const phaseOneTranscript = await readFile(resolve(outputDirectory, 'phase-one', 'transcript.jsonl'), 'utf8');
  const diagnosticPhaseOneEvidence =
    selection.taskPacket.version === 4
      ? extractMatchedEvaluationContinuationPhaseOneEvidenceV2(phaseOneTranscript, changedPaths)
      : null;
  const legacyPhaseOneEvidence =
    diagnosticPhaseOneEvidence === null
      ? extractMatchedEvaluationContinuationPhaseOneEvidenceV1(phaseOneTranscript, changedPaths)
      : null;
  let diagnostic = diagnosticPhaseOneEvidence?.diagnosticEvidence ?? null;
  if (diagnostic !== null) {
    const trackedPaths = new Set(
      (await captureContinuationGit(checkpointRepository, ['ls-files', '-z'], 8 * 1_024 * 1_024))
        .split('\0')
        .filter(Boolean),
    );
    const trackedRegularFiles = new Map<string, string>();
    const canonicalCheckpointRepository = await realpath(checkpointRepository);
    for (const citation of diagnostic.sourceCitations) {
      if (!trackedPaths.has(citation.path)) continue;
      const citationPath = resolve(checkpointRepository, citation.path);
      const pathFromRepository = relative(
        canonicalCheckpointRepository,
        await realpath(citationPath).catch(cause => {
          if (isMissing(cause)) return citationPath;
          throw cause;
        }),
      );
      if (pathFromRepository.startsWith('..') || isAbsolute(pathFromRepository)) continue;
      const metadata = await lstat(citationPath).catch(cause => (isMissing(cause) ? null : Promise.reject(cause)));
      if (
        metadata?.isFile() &&
        !metadata.isSymbolicLink() &&
        metadata.nlink === 1 &&
        metadata.size <= 4 * 1_024 * 1_024
      ) {
        trackedRegularFiles.set(citation.path, await readFile(citationPath, 'utf8'));
      }
    }
    assertMatchedEvaluationContinuationDiagnosticSourceCitationPathsV1({
      changedPaths,
      phaseOneAllowedPaths: selection.taskPacket.phaseOneAllowedPaths,
      sourceCitations: diagnostic.sourceCitations,
      trackedRegularFiles,
    });
    diagnostic = {
      ...diagnostic,
      sourceCitations: selectMatchedEvaluationContinuationInBoundsSourceCitationsV1({
        sourceCitations: diagnostic.sourceCitations,
        trackedRegularFiles,
      }),
    };
    if (diagnostic.sourceCitations.length === 0) {
      throw new Error('Continuation diagnostic has no in-bounds production-source citation.');
    }
    assertMatchedEvaluationContinuationDiagnosticSourceCitationsV1({
      changedPaths,
      phaseOneAllowedPaths: selection.taskPacket.phaseOneAllowedPaths,
      sourceCitations: diagnostic.sourceCitations,
      trackedRegularFiles,
    });
    await assertMatchedEvaluationContinuationGraphEvidenceV1({
      executable: graphArm.toolExecutable,
      graphHome,
      project: sourceGraphHome.project,
      query: diagnostic.graphQuery,
      repositoryDirectory: checkpointRepository,
      sourceCitations: diagnostic.sourceCitations,
      threadnoteEnvironment,
    });
  }
  const finalizedHandoff = buildMatchedEvaluationContinuationDiagnosticHandoffV1({
    changedPaths,
    diagnosticEvidence: diagnostic,
    legacyEvidence:
      diagnostic === null
        ? legacyPhaseOneEvidence!
        : {anchors: diagnosticPhaseOneEvidence!.regressionAnchors, observations: ''},
    phaseTwoPrompt: selection.taskPacket.phaseTwoPrompt,
    resumeEvidenceMarker,
    verification: `${focusedCommand.tokens.join(' ')} fails with exit code 1 at this checkpoint, as required before the production fix.`,
  });
  const {handoff} = finalizedHandoff;
  const memory = await captureCodeMemoryLinkProcessGroup({
    arguments: [
      'remember',
      '--home',
      compactHome,
      '--kind',
      'handoff',
      '--status',
      'active',
      '--project',
      sourceCompactHome.project,
      '--topic',
      `continuation-${corpusTask.taskId}`,
      ...finalizedHandoff.codeRefs.flatMap(path => ['--code-ref', path]),
      '--require-current-code-refs',
      '--text',
      handoff,
    ],
    command: graphArm.toolExecutable,
    cwd: checkpointRepository,
    environment: threadnoteEnvironment,
    label: 'Continuation checkpoint automatic handoff',
    maxOutputBytes: 64 * 1_024,
    timeoutMilliseconds: 120_000,
  });
  const automaticHandoffUri = matchingString(
    memory.stdout.trim().replace(/^Stored memory:\s*/u, ''),
    /^threadnote:\/\/[^\s]+$/u,
    'continuation automatic handoff URI',
  );
  const automaticHandoffRead = await captureCodeMemoryLinkProcessGroup({
    arguments: ['read', '--home', compactHome, automaticHandoffUri],
    command: graphArm.toolExecutable,
    cwd: checkpointRepository,
    environment: threadnoteEnvironment,
    label: 'Continuation checkpoint automatic handoff read',
    maxOutputBytes: 1 * 1_024 * 1_024,
    timeoutMilliseconds: 120_000,
  });
  if (!automaticHandoffRead.stdout.includes(handoff) || !automaticHandoffRead.stdout.includes(resumeEvidenceMarker)) {
    throw new Error('Continuation checkpoint automatic handoff cannot be read back exactly.');
  }
  const {citationId, managedMemoryId} = parseMatchedEvaluationContinuationAutomaticHandoffReadV1({
    expectedCodeRefs: finalizedHandoff.codeRefs,
    graphContentId: boundedString(statusSnapshot.graphContentId, 1, 256, 'checkpoint graph content id'),
    regressionPath: changedPaths[0],
    repositoryRevision: checkpoint.revision,
    snapshotId: boundedString(statusSnapshot.id, 1, 256, 'checkpoint graph snapshot id'),
    stdout: automaticHandoffRead.stdout,
  });
  const fixtureMemoryId = `mem_${sha256Bytes(
    Buffer.from(`matched-continuation-automatic-handoff-v1\0${corpusTask.taskId}`),
  ).slice(0, 32)}`;
  const linkReceipts = [
    {
      citationHash: matchedTokenEfficiencyCitationHashV1({citationId, fixtureMemoryId, managedMemoryId}),
      memoryId: fixtureMemoryId,
      status: 'exact' as const,
    },
  ];
  const resumeBrief = await captureMatchedEvaluationContinuationAgentBriefV1({
    budgetTokens: sourceCompactConfig.contextBudgetTokens,
    executable: graphArm.toolExecutable,
    home: compactHome,
    project: sourceCompactHome.project,
    repositoryDirectory: checkpointRepository,
    task: selection.taskPacket.phaseTwoPrompt,
    threadnoteEnvironment,
  });
  assertMatchedEvaluationContinuationAgentBriefV1({
    automaticHandoffUri,
    requiredGraphQuery: diagnostic?.graphQuery ?? null,
    resumeEvidenceMarker,
    text: resumeBrief,
  });
  const checkpointContext = createMatchedTokenEfficiencyTaskContextV1({
    asIssuedContext: taskContext.asIssuedContext,
    clusterId: taskContext.clusterId,
    graphContentHash,
    graphSnapshotHash,
    linkReceipts,
    memoryFixtureHash: sha256Bytes(
      Buffer.from(
        `matched-continuation-memory-fixture-v1\0${automaticHandoffUri}\0${managedMemoryId}\0${citationId}\0${sha256Bytes(Buffer.from(handoff))}`,
      ),
    ),
    repositoryFixtureHash: checkpoint.fixtureHash,
    taskId: taskContext.taskId,
  });
  const [graphHomeFixtureHash, compactHomeFixtureHash] = await Promise.all([
    matchedEvaluationPreparedHomeFixtureHashV1(graphHome),
    matchedEvaluationPreparedHomeFixtureHashV1(compactHome),
  ]);
  const preparedGraphHome = {
    expectedContext: {
      graphContentHash,
      graphSnapshotHash,
      linkReceiptsHash: null,
      memoryAccess: 'disabled' as const,
      taskContextHash: null,
    },
    homeDirectory: graphHome,
    homeFixtureHash: graphHomeFixtureHash,
    identity: sourceGraphHome.identity,
    project: sourceGraphHome.project,
    taskId: corpusTask.taskId,
  };
  const preparedCompactHome = {
    expectedContext: {
      graphContentHash,
      graphSnapshotHash,
      linkReceiptsHash: checkpointContext.linkReceiptsHash,
      memoryAccess: 'linked' as const,
      taskContextHash: checkpointContext.taskContextHash,
    },
    homeDirectory: compactHome,
    homeFixtureHash: compactHomeFixtureHash,
    identity: sourceCompactHome.identity,
    project: sourceCompactHome.project,
    taskId: corpusTask.taskId,
  };
  const adapterConfigDirectory = resolve(outputDirectory, 'checkpoint-adapter-config');
  await mkdir(adapterConfigDirectory, {mode: 0o700});
  const graphConfigPath = resolve(adapterConfigDirectory, 'threadnote-graph.json');
  const compactConfigPath = resolve(adapterConfigDirectory, 'threadnote-compact.json');
  const graphConfigBytes = Buffer.from(
    `${JSON.stringify({...sourceGraphConfig, contextHomes: [preparedGraphHome]}, undefined, 2)}\n`,
  );
  const compactConfigBytes = Buffer.from(
    `${JSON.stringify({...sourceCompactConfig, contextHomes: [preparedCompactHome]}, undefined, 2)}\n`,
  );
  await Promise.all([
    writeFile(graphConfigPath, graphConfigBytes, {flag: 'wx', mode: 0o600}),
    writeFile(compactConfigPath, compactConfigBytes, {flag: 'wx', mode: 0o600}),
  ]);
  const metrics = object(response.metrics, 'continuation phase-one response metrics');
  const timing = object(metrics.timing, 'continuation phase-one response timing');
  const usage = object(metrics.usage, 'continuation phase-one response usage');
  const providerTokens = object(usage.providerTokens, 'continuation phase-one provider tokens');
  const phaseOneConfig = object(
    await readJson(resolve(outputDirectory, 'phase-one', 'adapter-config.json')),
    'continuation phase-one config',
  );
  const phaseOneAppServer = object(phaseOneConfig.appServer, 'continuation phase-one app server');
  const phaseOneModel = object(phaseOneConfig.model, 'continuation phase-one model');
  const phaseOneResponseTranscriptHash = matchingString(response.transcriptHash, HASH, 'phase-one transcript hash');
  const plan = parseMatchedEvaluationContinuationPilotPlanV1({
    attempts: selection.continuationAttempts,
    candidate: {
      toolArtifactHash: compactDefinition.tool.artifactHash,
      toolVersion: compactDefinition.tool.version,
    },
    checkpoint: {
      adapterConfigurations: {
        threadnoteCompactSha256: sha256Bytes(compactConfigBytes),
        threadnoteGraphSha256: sha256Bytes(graphConfigBytes),
      },
      automaticHandoffReadSha256: sha256Bytes(Buffer.from(automaticHandoffRead.stdout)),
      automaticHandoffUri,
      ...(diagnostic === null ? {} : {diagnosticEvidence: diagnostic}),
      handoff,
      handoffSha256: sha256Bytes(Buffer.from(handoff)),
      phaseOneAccounting: {
        elapsedMilliseconds: timing.endToEndMilliseconds,
        providerTokens,
        providerTokensMeasured: true,
      },
      phaseOneExecution: {
        adapterArtifactHash: await boundedRegularFileHash(
          resolve(outputDirectory, 'phase-one', 'adapter'),
          128 * 1_024 * 1_024,
          'phase-one adapter',
        ),
        adapterConfigurationFileSha256: await boundedRegularFileHash(
          resolve(outputDirectory, 'phase-one', 'adapter-config.json'),
          MAXIMUM_JSON_BYTES,
          'phase-one adapter config',
        ),
        adapterConfigurationHash: request.adapterConfigurationHash,
        adapterProtocol: request.adapterProtocol,
        appServerExecutableSha256: phaseOneAppServer.executableSha256,
        appServerVersion: phaseOneAppServer.version,
        artifactSha256: await boundedRegularFileHash(
          resolve(outputDirectory, 'phase-one', 'artifact.json'),
          MAXIMUM_JSON_BYTES,
          'phase-one artifact',
        ),
        environmentPolicyHash: request.environmentPolicyHash,
        model: {
          id: phaseOneModel.id,
          parametersHash: phaseOneModel.parametersHash,
          provider: phaseOneModel.provider,
          reasoningEffort: phaseOneModel.reasoningEffort,
        },
        requestSha256: await boundedRegularFileHash(
          resolve(outputDirectory, 'phase-one', 'request.json'),
          MAXIMUM_JSON_BYTES,
          'phase-one request',
        ),
        responseSha256: await boundedRegularFileHash(
          resolve(outputDirectory, 'phase-one', 'response.json'),
          MAXIMUM_JSON_BYTES,
          'phase-one response',
        ),
        runNonce: selection.phaseOneRunNonce,
        transcriptHash: phaseOneResponseTranscriptHash,
        transcriptSha256: await boundedRegularFileHash(
          resolve(outputDirectory, 'phase-one', 'transcript.jsonl'),
          MAXIMUM_TRANSCRIPT_BYTES,
          'phase-one transcript',
        ),
      },
      phaseOnePatchSha256,
      phaseOnePrompt: selection.phaseOnePrompt,
      phaseOnePromptSha256: selection.phaseOnePromptSha256,
      preparedContext: {
        graphContentHash,
        graphSnapshotHash,
        linkReceiptsHash: checkpointContext.linkReceiptsHash,
        taskContextHash: checkpointContext.taskContextHash,
      },
      preparedGraphHome: {
        fixtureHash: graphHomeFixtureHash,
        identitySha256: matchedEvaluationContinuationPreparedHomeIdentityHashV2(preparedGraphHome),
      },
      preparedHome: {
        fixtureHash: compactHomeFixtureHash,
        identitySha256: matchedEvaluationContinuationPreparedHomeIdentityHashV2(preparedCompactHome),
      },
      repositoryFixtureHash: checkpoint.fixtureHash,
      repositoryRevision: checkpoint.revision,
      resumeEvidenceMarker,
    },
    phaseTwoPrompt: selection.taskPacket.phaseTwoPrompt,
    phaseTwoPromptSha256: sha256Bytes(Buffer.from(selection.taskPacket.phaseTwoPrompt)),
    retries: 0,
    sourceTask: selection.sourceTask,
    taskId: corpusTask.taskId,
    phaseTwoVerification,
    version: finalizedHandoff.planVersion,
  });
  if (plan.version !== 3 && plan.version !== 4) {
    throw new Error('Continuation checkpoint finalizer produced a legacy plan.');
  }
  const planPath = resolve(outputDirectory, 'continuation-plan.json');
  await writeFile(planPath, `${JSON.stringify(plan, undefined, 2)}\n`, {flag: 'wx', mode: 0o600});
  const continuationRuntime = {
    ...runtime,
    artifactDirectory: resolve(outputDirectory, 'pilot'),
    repositories: runtime.repositories.map(repository =>
      repository.clusterId === cluster.clusterId
        ? {...repository, repositoryDirectory: checkpointRepository}
        : repository,
    ),
  };
  const continuationRuntimePath = resolve(outputDirectory, 'continuation-runtime.json');
  await writeFile(continuationRuntimePath, `${JSON.stringify(continuationRuntime, undefined, 2)}\n`, {
    flag: 'wx',
    mode: 0o600,
  });
  await Promise.all([
    assertMatchedEvaluationContinuationPhaseOneEvidenceV2({plan, planPath}),
    assertMatchedEvaluationContinuationAdapterConfigurationsV2({
      manifest,
      plan,
      planPath,
      requiredArms: new Set(['threadnote-compact', 'threadnote-graph']),
      runtime,
    }),
  ]);
  const receipt = {
    checkpoint,
    focusedCheck: {
      diagnosticSha256: sha256Bytes(Buffer.from(`${focusedCheck.stdout}\0${focusedCheck.stderr}`)),
      exitCode: focusedCheck.exitCode,
    },
    graphContentHash,
    graphSnapshotHash,
    phaseOneReceiptSha256: await boundedRegularFileHash(
      resolve(outputDirectory, 'phase-one-receipt.json'),
      MAXIMUM_JSON_BYTES,
      'continuation phase-one receipt',
    ),
    planSha256: await boundedRegularFileHash(planPath, MAXIMUM_JSON_BYTES, 'continuation plan'),
    runtimeSha256: await boundedRegularFileHash(continuationRuntimePath, MAXIMUM_JSON_BYTES, 'continuation runtime'),
    taskId: corpusTask.taskId,
    version: 1,
  } as const;
  await atomicWrite(
    resolve(outputDirectory, 'continuation-checkpoint-receipt.json'),
    `${JSON.stringify(receipt, undefined, 2)}\n`,
  );
  process.stdout.write(`${JSON.stringify({checkpoint, outputDirectory, taskId: corpusTask.taskId, version: 1})}\n`);
}

/** Execute one sealed fresh phase-two attempt for each continuation treatment. */
export async function runMatchedEvaluationContinuationPilotFromFilesV1(options: {
  readonly corpusPath: string;
  readonly manifestPath: string;
  readonly parentPilotDirectory?: string | null;
  readonly pilotDirectory: string;
  readonly planPath: string;
  readonly runtimePath: string;
  readonly studyPath: string;
  readonly resume?: boolean;
}): Promise<void> {
  const planText = await readRequiredText(options.planPath, MAXIMUM_JSON_BYTES);
  let planInput: unknown;
  try {
    planInput = JSON.parse(planText) as unknown;
  } catch (cause) {
    throw new Error(`${options.planPath} is not valid JSON.`, {cause});
  }
  const plan = parseMatchedEvaluationContinuationPilotPlanV1(planInput);
  if (plan.version !== 3 && plan.version !== 4) {
    throw new Error('Continuation pilot execution requires a version 3 or 4 plan with full Phase-2 verification.');
  }
  const planFileHash = sha256Bytes(Buffer.from(planText));
  const phaseOneEvidence = await assertMatchedEvaluationContinuationPhaseOneEvidenceV2({
    plan,
    planPath: options.planPath,
  });
  const [corpus, manifest, runtime, study] = await Promise.all([
    readJson(options.corpusPath).then(parseMatchedEvaluationCorpusV1),
    readJson(options.manifestPath).then(parseMatchedEvaluationManifestV1),
    readJson(options.runtimePath).then(parseMatchedEvaluationRuntimeV1),
    readJson(options.studyPath).then(parseMatchedTokenEfficiencyStudyV1),
  ]);
  const supplement =
    options.parentPilotDirectory === null || options.parentPilotDirectory === undefined
      ? null
      : await readContinuationSupplementV1(
          options.parentPilotDirectory,
          plan,
          await runtimeAdapterArtifactHashV1(runtime, 'threadnote-compact'),
        );
  assertMatchedTokenEfficiencyStudyMatchesV1(study, corpus, manifest);
  if (runtime.verificationPlanHash !== study.verificationPlanHash) {
    throw new Error('Runtime and study disagree on the sealed verification plan.');
  }
  const checkpointAdapterConfigOverrides = await assertMatchedEvaluationContinuationAdapterConfigurationsV2({
    manifest,
    plan,
    planPath: options.planPath,
    requiredArms: new Set(
      plan.attempts
        .map(attempt => continuationTreatment(attempt.variant, plan.checkpoint).arm)
        .filter(
          (arm): arm is 'threadnote-compact' | 'threadnote-graph' =>
            arm === 'threadnote-compact' || arm === 'threadnote-graph',
        ),
    ),
    runtime,
  });
  const task = corpus.tasks.find(candidate => candidate.taskId === plan.taskId);
  if (task === undefined) throw new Error(`Continuation pilot task ${plan.taskId} is not in the corpus.`);
  if (
    task.prompt !== plan.sourceTask.prompt ||
    matchedEvaluationPromptHashV1(task.prompt) !== plan.sourceTask.promptSha256 ||
    task.repositoryFixtureHash !== plan.sourceTask.repositoryFixtureHash
  ) {
    throw new Error('Continuation pilot source task differs from the frozen corpus.');
  }
  const repositoryStudy = continuationCheckpointStudyV2(study, plan.sourceTask, plan.checkpoint);
  for (const arm of ['threadnote-graph', 'threadnote-compact'] as const) {
    const definition = manifest.arms.find(candidate => candidate.arm === arm);
    if (
      definition === undefined ||
      definition.tool.artifactHash !== plan.candidate.toolArtifactHash ||
      definition.tool.version !== plan.candidate.toolVersion
    ) {
      throw new Error(`Continuation pilot ${arm} runtime differs from the sealed candidate.`);
    }
  }
  const pilotDirectory = absolutePath(options.pilotDirectory, 'continuation pilot directory');
  if (pilotDirectory === runtime.artifactDirectory) {
    throw new Error('Continuation pilot directory must be separate from the full-study artifact directory.');
  }
  await mkdir(pilotDirectory, {recursive: true, mode: 0o700});
  if ((await realpath(pilotDirectory)) !== pilotDirectory) {
    throw new Error('Continuation pilot directory must use its canonical path.');
  }
  const plannedAttempts =
    supplement === null
      ? plan.attempts
      : plan.attempts.filter(attempt => attempt.variant === 'threadnote-preloaded-resume');
  const selected = plannedAttempts.map(attempt => {
    const {arm, treatment} = continuationTreatment(attempt.variant, plan.checkpoint);
    return {
      arm,
      row: {
        blindLabel: attempt.blindLabel,
        position: continuationPosition(attempt.runOrder - 1),
        repetition: 1,
        runNonce: attempt.runNonce,
        runOrder: attempt.runOrder,
        taskId: plan.taskId,
      },
      treatment,
      variant: attempt.variant,
    };
  });
  const selection = {
    candidate: plan.candidate,
    checkpoint: projectMatchedEvaluationContinuationSelectionCheckpointV1(plan),
    completionMeaning: `completed is true only when all ${selected.length} fresh phase-two adapter attempts completed; verified completion is verifier-authoritative per attempt.`,
    comparativeClaimsEligible: false,
    identities: {
      manifestHash: manifest.manifestHash,
      planFileHash,
      runtimeVersion: runtime.version,
      studyHash: study.studyHash,
      verificationPlanHash: study.verificationPlanHash,
    },
    limitations: [
      'One development-calibration task, one attempt per treatment, no confidence interval or general product claim.',
      'The common phase-one checkpoint cost is reported separately and is not duplicated into each phase-two attempt.',
      ...(plan.checkpoint.phaseOneAccounting.providerTokensMeasured
        ? []
        : ['The common phase-one provider-token cost is unavailable and excluded from whole-workflow totals.']),
      'No retries are allowed; failed attempts remain in failure-inclusive completion accounting.',
      ...(supplement === null
        ? []
        : [
            'This is a non-blinded supplementary fifth treatment selected after the four-arm parent pilot; it estimates the preloading mechanism only and is not a randomized five-way comparison.',
          ]),
    ],
    phaseTwoPromptSha256: plan.phaseTwoPromptSha256,
    phaseTwoVerificationPlanHash: plan.phaseTwoVerification.planHash,
    planVersion: plan.version,
    sourceTask: {
      promptSha256: plan.sourceTask.promptSha256,
      repositoryFixtureHash: plan.sourceTask.repositoryFixtureHash,
      repositoryRevision: plan.sourceTask.repositoryRevision,
      taskId: plan.sourceTask.taskId,
    },
    rows: selected.map(({arm, row, variant}) => ({...row, arm, variant})),
    ...(supplement === null ? {} : {supplementaryTo: supplement}),
    taskId: plan.taskId,
    version: 2,
  };
  const markerPath = resolve(pilotDirectory, 'continuation-pilot-selection.json');
  if (options.resume === true) {
    const existingSelection = await readJson(markerPath);
    if (!sameJson(existingSelection, selection)) {
      throw new Error('Continuation pilot resume selection differs from the immutable sealed selection.');
    }
  } else {
    try {
      await writeFile(markerPath, `${JSON.stringify(selection, undefined, 2)}\n`, {
        encoding: 'utf8',
        flag: 'wx',
        mode: 0o600,
      });
    } catch (cause) {
      if ((cause as {code?: string}).code === 'EEXIST') {
        throw new Error('Continuation pilot selection already exists; use explicit resume recovery.', {cause});
      }
      throw cause;
    }
    await initializeMatchedEvaluationContinuationNonceStatesV1({
      pilotDirectory,
      plan,
      selected,
    });
  }
  const pilotRuntime = {...runtime, artifactDirectory: pilotDirectory};
  const repositories = await resolveMatchedEvaluationRuntimeRepositoriesV1(
    pilotRuntime,
    repositoryStudy,
    manifest.repository,
  );
  await assertResolvedRuntimeRepositories(repositories);
  const checkpointRepository = requiredRuntimeRepository(repositories, plan.taskId, study);
  if (
    checkpointRepository.expected.fixtureHash !== plan.checkpoint.repositoryFixtureHash ||
    checkpointRepository.expected.revision !== plan.checkpoint.repositoryRevision
  ) {
    throw new Error('Continuation pilot runtime repository differs from the frozen checkpoint.');
  }
  await assertMatchedEvaluationContinuationCheckpointV2({
    baseFixtureHash: plan.sourceTask.repositoryFixtureHash,
    baseRevision: plan.sourceTask.repositoryRevision,
    checkpoint: checkpointRepository.expected,
    agentPatch: phaseOneEvidence.checkpointPatch,
    patchSha256: plan.checkpoint.phaseOnePatchSha256,
    repositoryDirectory: checkpointRepository.repositoryDirectory,
  });
  const requiredArms = [...new Set([...selected.map(attempt => attempt.arm), 'files' as const])];
  const adapterConfigOverrides = await prepareMatchedEvaluationContinuationAdapterRuntimeOverridesV1({
    arms: requiredArms.filter(
      (arm): arm is 'files' | 'threadnote-compact' | 'threadnote-graph' =>
        arm === 'files' || arm === 'threadnote-compact' || arm === 'threadnote-graph',
    ),
    checkpointOverrides: checkpointAdapterConfigOverrides,
    checkpointRepository: checkpointRepository.repositoryDirectory,
    manifest,
    outputDirectory: pilotDirectory,
    plan,
    runtime,
  });
  const preflight = await Promise.all(
    requiredArms.map(async arm => {
      const definition = manifest.arms.find(candidate => candidate.arm === arm);
      if (definition === undefined) throw new Error(`Continuation pilot arm ${arm} is not defined.`);
      const resolution = await resolveRuntimeArm(
        pilotRuntime,
        arm,
        definition,
        supplement?.adapterArtifactSha256 ?? null,
        adapterConfigOverrides.get(arm) ?? null,
      );
      if ('reason' in resolution)
        throw new Error(`Continuation pilot runtime unavailable for ${arm}: ${resolution.detail}`);
      return [arm, resolution] as const;
    }),
  );
  const resolved = new Map(preflight);
  const verificationAdapterConfig = parseMatchedEvaluationCodexAdapterConfigV1(
    await readJson(requiredResolvedArm(resolved, 'files').config.adapterConfigFile),
  );
  for (const check of plan.phaseTwoVerification.checks) {
    if (
      !verificationAdapterConfig.approvedCommands.some(
        command => command.taskId === plan.taskId && sameJson(command.tokens, check.commandTokens),
      )
    ) {
      throw new Error('Continuation phase-two verification plan contains a command outside the approved policy.');
    }
  }
  await assertContinuationAutomaticHandoffV1({
    plan,
    resolvedCompactArm: requiredResolvedArm(resolved, 'threadnote-compact'),
  });
  const reportPath = resolve(pilotDirectory, 'continuation-pilot-report.json');
  const attempts: Array<Record<string, unknown>> =
    options.resume === true
      ? await recoverMatchedEvaluationContinuationAttemptsV1({
          pilotDirectory,
          plan,
          reportPath,
          selected,
          selection,
        })
      : [];
  const writeReport = async (completed: boolean) =>
    atomicWrite(reportPath, `${JSON.stringify({...selection, attempts, completed}, undefined, 2)}\n`);
  const persistTerminalAttempt = async (attempt: Record<string, unknown>) => {
    const runNonce = matchingString(attempt.runNonce, /^run_[0-9a-f]{32}$/u, 'terminal attempt nonce');
    const terminalPath = resolve(pilotDirectory, 'runs', runNonce, 'terminal-attempt.json');
    await writeFile(terminalPath, `${JSON.stringify(attempt, undefined, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    attempts.push(attempt);
    await writeReport(false);
  };
  await writeReport(false);
  for (const selectedAttempt of selected) {
    const {arm, row, treatment, variant} = selectedAttempt;
    if (attempts.some(attempt => attempt.runNonce === row.runNonce)) continue;
    const definition = manifest.arms.find(candidate => candidate.arm === arm);
    if (definition === undefined) throw new Error(`Continuation pilot arm ${arm} is not defined.`);
    const rawArtifactPath = resolve(pilotDirectory, 'runs', row.runNonce, 'artifact.json');
    const requestPath = resolve(pilotDirectory, 'runs', row.runNonce, 'request.json');
    const responsePath = resolve(pilotDirectory, 'runs', row.runNonce, 'response.json');
    const transcriptPath = resolve(pilotDirectory, 'transcripts', `${row.runNonce}.jsonl`);
    const checkpointPath = `${transcriptPath}.agent.jsonl`;
    const request: MatchedEvaluationRunRequestV1 = {arm, armDefinition: definition, manifest, schedule: row, task};
    const repository = requiredRuntimeRepository(repositories, plan.taskId, study);
    const projectedTaskOverride = projectMatchedEvaluationContinuationAdapterTaskV2(request, study, plan);
    await assertMatchedEvaluationRepositoryV1(repository.repositoryDirectory, repository.expected);
    await markMatchedEvaluationContinuationNonceStartedV1({
      pilotDirectory,
      plan,
      row,
    });
    try {
      const observation = await executeArm(
        pilotRuntime,
        requiredResolvedArm(resolved, arm),
        repository,
        request,
        study,
        treatment,
        projectedTaskOverride,
      );
      const [requestSha256, responseSha256, artifactSha256] = await Promise.all([
        boundedRegularFileHash(requestPath, MAXIMUM_JSON_BYTES, 'continuation pilot request'),
        boundedRegularFileHash(responsePath, MAXIMUM_JSON_BYTES, 'continuation pilot response'),
        boundedRegularFileHash(rawArtifactPath, MAXIMUM_JSON_BYTES, 'continuation pilot artifact'),
      ]);
      if (artifactSha256 !== observation.artifactHash) {
        throw new Error('Continuation pilot report artifact hash differs from the adapter observation.');
      }
      let phaseTwoVerification: MatchedContinuationPhaseTwoVerificationReceiptV1;
      try {
        phaseTwoVerification = await verifyMatchedEvaluationContinuationArtifactV1({
          artifactHash: artifactSha256,
          artifactPath: rawArtifactPath,
          checkpointRepository: repository.repositoryDirectory,
          checkpointRevision: plan.checkpoint.repositoryRevision,
          dependencyProjection: dependencyProjectionForTaskV1(verificationAdapterConfig, plan.taskId),
          plan: plan.phaseTwoVerification,
          safeExecutablePath: verificationAdapterConfig.safeExecutablePath,
        });
      } catch (verificationCause) {
        await persistTerminalAttempt({
          accountingStatus: 'retained-observation',
          arm,
          artifactSha256,
          checkpointPath,
          diagnostics: boundedFailureDiagnostic(verificationCause),
          metrics: observation.metrics,
          phaseTwoVerification: null,
          rawArtifactPath,
          requestPath,
          responsePath,
          responseSha256,
          runNonce: row.runNonce,
          runOrder: row.runOrder,
          requestSha256,
          status: 'verification-unavailable',
          taskId: plan.taskId,
          transcriptHash: observation.transcriptHash,
          transcriptPath,
          variant,
        });
        throw new Error('Continuation pilot stopped after retaining a provider-complete verification failure.', {
          cause: verificationCause,
        });
      }
      await persistTerminalAttempt({
        arm,
        artifactSha256,
        checkpointPath,
        metrics: observation.metrics,
        phaseTwoVerification,
        rawArtifactPath,
        requestPath,
        responsePath,
        responseSha256,
        runNonce: row.runNonce,
        runOrder: row.runOrder,
        requestSha256,
        status: 'completed',
        taskId: plan.taskId,
        transcriptHash: observation.transcriptHash,
        transcriptPath,
        variant,
      });
    } catch (cause) {
      if (!(cause instanceof Error) || !cause.message.includes('adapter failed with exit code')) throw cause;
      const [failureAccounting, requestSha256, responseSha256, artifactSha256] = await Promise.all([
        readContinuationFailureAccounting(checkpointPath),
        optionalBoundedRegularFileHash(requestPath, MAXIMUM_JSON_BYTES, 'continuation pilot failed request'),
        optionalBoundedRegularFileHash(responsePath, MAXIMUM_JSON_BYTES, 'continuation pilot failed response'),
        optionalBoundedRegularFileHash(rawArtifactPath, MAXIMUM_JSON_BYTES, 'continuation pilot failed artifact'),
      ]);
      await persistTerminalAttempt({
        accountingStatus: failureAccounting === null ? 'unavailable-before-checkpoint' : 'retained-agent-checkpoint',
        arm,
        artifactSha256,
        checkpointPath,
        diagnostics: cause.message.slice(-2_048),
        metrics: null,
        providerUsage: failureAccounting?.providerUsage ?? null,
        rawArtifactPath,
        requestPath,
        responsePath,
        responseSha256,
        runNonce: row.runNonce,
        runOrder: row.runOrder,
        requestSha256,
        status: 'failed',
        taskId: plan.taskId,
        timing: failureAccounting?.timing ?? null,
        transcriptPath,
        variant,
      });
    } finally {
      await assertMatchedEvaluationRepositoryV1(repository.repositoryDirectory, repository.expected);
    }
  }
  await assertResolvedRuntimeRepositories(repositories);
  const allCompleted = attempts.every(attempt => attempt.status === 'completed');
  await writeReport(allCompleted);
  process.stdout.write(
    `${JSON.stringify({artifactDirectory: pilotDirectory, attemptCount: attempts.length, comparativeClaimsEligible: false, completed: allCompleted, finished: true, version: 2})}\n`,
  );
}

export async function initializeMatchedEvaluationContinuationNonceStatesV1(input: {
  readonly pilotDirectory: string;
  readonly plan: MatchedEvaluationContinuationVerifiedPilotPlan;
  readonly selected: readonly {readonly row: {readonly runNonce: string; readonly runOrder: number}}[];
}): Promise<void> {
  const directory = resolve(input.pilotDirectory, 'nonce-state');
  await mkdir(directory, {mode: 0o700});
  await Promise.all(
    input.selected.map(({row}) =>
      writeFile(
        continuationNonceStatePath(input.pilotDirectory, row.runNonce, 'unstarted'),
        continuationNonceStateContent(input.plan, row),
        {encoding: 'utf8', flag: 'wx', mode: 0o600},
      ),
    ),
  );
}

export async function markMatchedEvaluationContinuationNonceStartedV1(input: {
  readonly pilotDirectory: string;
  readonly plan: MatchedEvaluationContinuationVerifiedPilotPlan;
  readonly row: {readonly runNonce: string; readonly runOrder: number};
}): Promise<void> {
  const expected = continuationNonceStateContent(input.plan, input.row);
  const unstartedPath = continuationNonceStatePath(input.pilotDirectory, input.row.runNonce, 'unstarted');
  const startedPath = continuationNonceStatePath(input.pilotDirectory, input.row.runNonce, 'started');
  if ((await readOptionalTextOrNull(unstartedPath, 4 * 1_024)) !== expected) {
    throw new Error(`Continuation nonce ${input.row.runNonce} lacks its exact unstarted capability.`);
  }
  await writeFile(startedPath, expected, {encoding: 'utf8', flag: 'wx', mode: 0o600});
  await rm(unstartedPath);
}

function continuationNonceStatePath(pilotDirectory: string, runNonce: string, state: 'started' | 'unstarted'): string {
  return resolve(pilotDirectory, 'nonce-state', `${runNonce}.${state}.json`);
}

function continuationNonceStateContent(
  plan: MatchedEvaluationContinuationVerifiedPilotPlan,
  row: {readonly runNonce: string; readonly runOrder: number},
): string {
  return `${JSON.stringify({
    planIdentityHash: sha256Bytes(Buffer.from(`matched-continuation-plan-identity-v1\0${JSON.stringify(plan)}`)),
    runNonce: row.runNonce,
    runOrder: row.runOrder,
    taskId: plan.taskId,
    version: 1,
  })}\n`;
}

export async function recoverMatchedEvaluationContinuationAttemptsV1(input: {
  readonly pilotDirectory: string;
  readonly plan: MatchedEvaluationContinuationVerifiedPilotPlan;
  readonly reportPath: string;
  readonly selected: readonly {
    readonly arm: MatchedEvaluationArm;
    readonly row: {readonly runNonce: string; readonly runOrder: number};
    readonly variant: MatchedEvaluationContinuationVariantV1;
  }[];
  readonly selection: Record<string, unknown>;
}): Promise<Array<Record<string, unknown>>> {
  const attempts: Array<Record<string, unknown>> = [];
  let encounteredUntouchedNonce = false;
  for (const selected of input.selected) {
    const runDirectory = resolve(input.pilotDirectory, 'runs', selected.row.runNonce);
    const terminalPath = resolve(runDirectory, 'terminal-attempt.json');
    const expectedNonceState = continuationNonceStateContent(input.plan, selected.row);
    const [terminal, startedState, unstartedState] = await Promise.all([
      readOptionalJson(terminalPath, MAXIMUM_JSON_BYTES),
      readOptionalTextOrNull(
        continuationNonceStatePath(input.pilotDirectory, selected.row.runNonce, 'started'),
        4 * 1_024,
      ),
      readOptionalTextOrNull(
        continuationNonceStatePath(input.pilotDirectory, selected.row.runNonce, 'unstarted'),
        4 * 1_024,
      ),
    ]);
    if (
      (startedState !== null && startedState !== expectedNonceState) ||
      (unstartedState !== null && unstartedState !== expectedNonceState) ||
      (startedState !== null && unstartedState !== null)
    ) {
      throw new Error(`Continuation nonce ${selected.row.runNonce} has invalid or conflicting state capabilities.`);
    }
    if (terminal === null) {
      if (startedState !== null) {
        throw new Error(
          `Continuation pilot nonce ${selected.row.runNonce} started without a terminal journal; replay is forbidden.`,
        );
      }
      if (unstartedState === null) {
        throw new Error(`Continuation pilot nonce ${selected.row.runNonce} lost its unstarted capability.`);
      }
      const runEntries = await readdir(runDirectory).catch(cause => {
        if (isMissing(cause)) return [];
        throw cause;
      });
      const transcriptPath = resolve(input.pilotDirectory, 'transcripts', `${selected.row.runNonce}.jsonl`);
      const transcriptEvidence = await Promise.all(
        [transcriptPath, `${transcriptPath}.agent.jsonl`, `${transcriptPath}.preflight.json`].map(path =>
          lstat(path).then(
            () => true,
            cause => {
              if (isMissing(cause)) return false;
              throw cause;
            },
          ),
        ),
      );
      if (runEntries.length > 0 || transcriptEvidence.some(Boolean)) {
        throw new Error(
          `Continuation pilot nonce ${selected.row.runNonce} has provider-ambiguous evidence without a terminal journal.`,
        );
      }
      encounteredUntouchedNonce = true;
      continue;
    }
    if (startedState === null || unstartedState !== null) {
      throw new Error(`Continuation terminal attempt ${selected.row.runNonce} lacks its started capability.`);
    }
    if (encounteredUntouchedNonce) {
      throw new Error('Continuation terminal journals must form one prefix of the sealed attempt order.');
    }
    attempts.push(
      await validateRecoveredContinuationAttemptV1({
        arm: selected.arm,
        pilotDirectory: input.pilotDirectory,
        plan: input.plan,
        row: selected.row,
        value: terminal,
        variant: selected.variant,
      }),
    );
  }
  const existingReport = await readOptionalJson(input.reportPath, MAXIMUM_JSON_BYTES);
  if (existingReport !== null) {
    const report = object(existingReport, 'continuation resume report');
    const reportAttempts = array(report.attempts, 'continuation resume report attempts');
    const reportCompleted = report.completed;
    const {attempts: _attempts, completed: _completed, ...reportSelection} = report;
    if (!sameJson(reportSelection, input.selection)) {
      throw new Error('Continuation pilot resume report differs from the immutable selection.');
    }
    if (
      reportAttempts.length > attempts.length ||
      !sameJson(reportAttempts, attempts.slice(0, reportAttempts.length)) ||
      reportCompleted !==
        (attempts.length === input.selected.length && attempts.every(attempt => attempt.status === 'completed'))
    ) {
      throw new Error('Continuation pilot resume report differs from its terminal journals.');
    }
  }
  return attempts;
}

async function validateRecoveredContinuationAttemptV1(input: {
  readonly arm: MatchedEvaluationArm;
  readonly pilotDirectory: string;
  readonly plan: MatchedEvaluationContinuationVerifiedPilotPlan;
  readonly row: {readonly runNonce: string; readonly runOrder: number};
  readonly value: unknown;
  readonly variant: MatchedEvaluationContinuationVariantV1;
}): Promise<Record<string, unknown>> {
  const attempt = object(input.value, `terminal attempt ${input.row.runNonce}`);
  const status = literal(
    attempt.status,
    ['completed', 'failed', 'verification-unavailable'] as const,
    'terminal attempt status',
  );
  exactKeys(
    attempt,
    status === 'completed'
      ? [
          'arm',
          'artifactSha256',
          'checkpointPath',
          'metrics',
          'phaseTwoVerification',
          'rawArtifactPath',
          'requestPath',
          'requestSha256',
          'responsePath',
          'responseSha256',
          'runNonce',
          'runOrder',
          'status',
          'taskId',
          'transcriptHash',
          'transcriptPath',
          'variant',
        ]
      : status === 'verification-unavailable'
        ? [
            'accountingStatus',
            'arm',
            'artifactSha256',
            'checkpointPath',
            'diagnostics',
            'metrics',
            'phaseTwoVerification',
            'rawArtifactPath',
            'requestPath',
            'requestSha256',
            'responsePath',
            'responseSha256',
            'runNonce',
            'runOrder',
            'status',
            'taskId',
            'transcriptHash',
            'transcriptPath',
            'variant',
          ]
        : [
            'accountingStatus',
            'arm',
            'artifactSha256',
            'checkpointPath',
            'diagnostics',
            'metrics',
            'providerUsage',
            'rawArtifactPath',
            'requestPath',
            'requestSha256',
            'responsePath',
            'responseSha256',
            'runNonce',
            'runOrder',
            'status',
            'taskId',
            'timing',
            'transcriptPath',
            'variant',
          ],
    `terminal attempt ${input.row.runNonce}`,
  );
  const expectedPaths = {
    checkpointPath: resolve(input.pilotDirectory, 'transcripts', `${input.row.runNonce}.jsonl.agent.jsonl`),
    rawArtifactPath: resolve(input.pilotDirectory, 'runs', input.row.runNonce, 'artifact.json'),
    requestPath: resolve(input.pilotDirectory, 'runs', input.row.runNonce, 'request.json'),
    responsePath: resolve(input.pilotDirectory, 'runs', input.row.runNonce, 'response.json'),
    transcriptPath: resolve(input.pilotDirectory, 'transcripts', `${input.row.runNonce}.jsonl`),
  } as const;
  if (
    attempt.arm !== input.arm ||
    attempt.runNonce !== input.row.runNonce ||
    attempt.runOrder !== input.row.runOrder ||
    attempt.taskId !== input.plan.taskId ||
    attempt.variant !== input.variant ||
    Object.entries(expectedPaths).some(([key, path]) => attempt[key] !== path)
  ) {
    throw new Error(`Continuation terminal attempt ${input.row.runNonce} differs from its sealed row.`);
  }
  const validateEvidenceHash = async (
    path: string,
    hash: unknown,
    maximumBytes: number,
    label: string,
    nullable = false,
  ) => {
    if (hash === null && nullable) return;
    const expectedHash = matchingString(hash, HASH, label);
    if ((await boundedRegularFileHash(path, maximumBytes, label)) !== expectedHash) {
      throw new Error(`${label} differs from its terminal journal hash.`);
    }
  };
  await Promise.all([
    validateEvidenceHash(
      expectedPaths.requestPath,
      attempt.requestSha256,
      MAXIMUM_JSON_BYTES,
      'terminal request',
      true,
    ),
    validateEvidenceHash(
      expectedPaths.responsePath,
      attempt.responseSha256,
      MAXIMUM_JSON_BYTES,
      'terminal response',
      true,
    ),
    validateEvidenceHash(
      expectedPaths.rawArtifactPath,
      attempt.artifactSha256,
      MAXIMUM_JSON_BYTES,
      'terminal artifact',
      true,
    ),
  ]);
  if (status === 'failed') {
    if (attempt.metrics !== null) {
      throw new Error('Failed continuation terminal attempt contains unsupported verification evidence.');
    }
    boundedString(attempt.diagnostics, 1, 2_048, 'failed terminal diagnostic');
    parseRecoveredFailureAccountingV1(attempt);
    return attempt;
  }
  const artifactSha256 = matchingString(attempt.artifactSha256, HASH, 'terminal artifact hash');
  const transcriptHash = matchingString(attempt.transcriptHash, HASH, 'terminal transcript hash');
  await validateEvidenceHash(
    expectedPaths.transcriptPath,
    transcriptHash,
    MAXIMUM_TRANSCRIPT_BYTES,
    'terminal transcript',
  );
  const observation = parseMatchedEvaluationObservationV1({
    artifactHash: artifactSha256,
    metrics: attempt.metrics,
    transcriptHash,
    version: 5,
  });
  if (status === 'completed') {
    parseMatchedContinuationPhaseTwoVerificationReceiptV1({
      artifactHash: artifactSha256,
      plan: input.plan.phaseTwoVerification,
      receipt: attempt.phaseTwoVerification,
    });
  } else {
    if (attempt.accountingStatus !== 'retained-observation' || attempt.phaseTwoVerification !== null) {
      throw new Error('Verification-unavailable terminal attempt lacks retained observation accounting.');
    }
    boundedString(attempt.diagnostics, 1, 2_048, 'verification-unavailable terminal diagnostic');
    if (observation.metrics.usage.providerTokens === null) {
      throw new Error('Verification-unavailable terminal attempt lacks measured provider usage.');
    }
  }
  return attempt;
}

function parseRecoveredFailureAccountingV1(attempt: Record<string, unknown>): void {
  const accountingStatus = literal(
    attempt.accountingStatus,
    ['retained-agent-checkpoint', 'unavailable-before-checkpoint'] as const,
    'failed terminal accounting status',
  );
  if (accountingStatus === 'unavailable-before-checkpoint') {
    if (attempt.providerUsage !== null || attempt.timing !== null) {
      throw new Error('Failed terminal attempt invents unavailable accounting.');
    }
    return;
  }
  const usage = object(attempt.providerUsage, 'failed terminal provider usage');
  exactKeys(
    usage,
    ['cachedInputTokens', 'inputTokens', 'outputTokens', 'reasoningOutputTokens', 'totalTokens'],
    'failed terminal provider usage',
  );
  const cachedInputTokens = boundedNonnegativeInteger(
    usage.cachedInputTokens,
    Number.MAX_SAFE_INTEGER,
    'failed terminal cached-input tokens',
  );
  const inputTokens = boundedNonnegativeInteger(
    usage.inputTokens,
    Number.MAX_SAFE_INTEGER,
    'failed terminal input tokens',
  );
  const outputTokens = boundedNonnegativeInteger(
    usage.outputTokens,
    Number.MAX_SAFE_INTEGER,
    'failed terminal output tokens',
  );
  const reasoningOutputTokens = boundedNonnegativeInteger(
    usage.reasoningOutputTokens,
    Number.MAX_SAFE_INTEGER,
    'failed terminal reasoning-output tokens',
  );
  const totalTokens = boundedNonnegativeInteger(
    usage.totalTokens,
    Number.MAX_SAFE_INTEGER,
    'failed terminal total tokens',
  );
  if (
    cachedInputTokens > inputTokens ||
    reasoningOutputTokens > outputTokens ||
    totalTokens !== inputTokens + outputTokens
  ) {
    throw new Error('Failed terminal provider usage is inconsistent.');
  }
  const timing = object(attempt.timing, 'failed terminal timing');
  exactKeys(timing, ['agentTaskMilliseconds', 'preparationMilliseconds'], 'failed terminal timing');
  boundedNonnegativeInteger(timing.agentTaskMilliseconds, 86_400_000, 'failed terminal agent time');
  boundedNonnegativeInteger(timing.preparationMilliseconds, 86_400_000, 'failed terminal preparation time');
}

async function readOptionalJson(path: string, maximumBytes: number): Promise<unknown | null> {
  const text = await readOptionalTextOrNull(path, maximumBytes);
  if (text === null) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch (cause) {
    throw new Error(`${path} is not valid JSON.`, {cause});
  }
}

export function parseMatchedEvaluationRuntimeV1(value: unknown): MatchedEvaluationRuntimeV1 {
  const runtime = object(value, 'runtime');
  exactKeys(
    runtime,
    ['arms', 'artifactDirectory', 'repositories', 'timeoutMilliseconds', 'verificationPlanHash', 'version'],
    'runtime',
  );
  if (runtime.version !== MATCHED_EVALUATION_RUNTIME_VERSION) invalid('runtime version must be 4');
  const arms = array(runtime.arms, 'runtime arms').map((entry, index) => parseRuntimeArm(entry, index));
  const repositories = array(runtime.repositories, 'runtime repositories').map((entry, index) =>
    parseRuntimeRepository(entry, index),
  );
  if (repositories.length === 0 || repositories.length > 64) invalid('runtime repositories must contain 1-64 entries');
  unique(
    arms.map(arm => arm.arm),
    'runtime arm ids',
  );
  unique(
    repositories.map(repository => repository.clusterId ?? 'single-repository'),
    'runtime repository cluster ids',
  );
  unique(
    repositories.map(repository => repository.repositoryDirectory),
    'runtime repository directories',
  );
  return {
    arms,
    artifactDirectory: absolutePath(runtime.artifactDirectory, 'runtime artifact directory'),
    repositories,
    timeoutMilliseconds: boundedPositiveInteger(runtime.timeoutMilliseconds, 60_000, 7_200_000, 'runtime timeout'),
    verificationPlanHash:
      runtime.verificationPlanHash === null
        ? null
        : matchingString(runtime.verificationPlanHash, HASH, 'runtime verification plan hash'),
    version: MATCHED_EVALUATION_RUNTIME_VERSION,
  };
}

export async function resolveMatchedEvaluationRuntimeRepositoriesV1(
  runtime: MatchedEvaluationRuntimeV1,
  study: MatchedTokenEfficiencyStudyV1 | null,
  manifestRepository: MatchedEvaluationRepositoryObservationV1,
): Promise<ReadonlyMap<string | null, ResolvedRuntimeRepository>> {
  const resolved = new Map<string | null, ResolvedRuntimeRepository>();
  if (study === null) {
    if (runtime.repositories.length !== 1 || runtime.repositories[0]?.clusterId !== null) {
      throw new Error('A non-study matched evaluation requires one unclustered runtime repository.');
    }
    const repository = runtime.repositories[0];
    if (repository.repositoryIdentityHash !== manifestRepository.identityHash) {
      throw new Error('Runtime repository identity differs from the content-addressed manifest.');
    }
    await canonicalDirectory(repository.repositoryDirectory, 'runtime repository directory');
    await assertMatchedEvaluationRepositoryV1(repository.repositoryDirectory, manifestRepository);
    resolved.set(null, {
      clusterId: null,
      expected: manifestRepository,
      repositoryDirectory: repository.repositoryDirectory,
    });
    return resolved;
  }
  if (
    runtime.repositories.length !== study.clusters.length ||
    runtime.repositories.some(entry => entry.clusterId === null)
  ) {
    throw new Error('Token-efficiency runtime repositories do not exactly cover the held-out clusters.');
  }
  await Promise.all(
    study.clusters.map(async cluster => {
      const repository = runtime.repositories.find(candidate => candidate.clusterId === cluster.clusterId);
      if (repository === undefined) throw new Error(`Runtime repository is missing cluster ${cluster.clusterId}.`);
      if (repository.repositoryIdentityHash !== cluster.repositoryIdentityHash) {
        throw new Error(`Runtime repository identity differs for cluster ${cluster.clusterId}.`);
      }
      const expected = {
        dirty: false,
        fixtureHash: cluster.repositoryFixtureHash,
        identityHash: cluster.repositoryIdentityHash,
        revision: cluster.revision,
      } satisfies MatchedEvaluationRepositoryObservationV1;
      await canonicalDirectory(repository.repositoryDirectory, `runtime repository ${cluster.clusterId}`);
      await assertMatchedEvaluationRepositoryV1(repository.repositoryDirectory, expected);
      resolved.set(cluster.clusterId, {
        clusterId: cluster.clusterId,
        expected,
        repositoryDirectory: repository.repositoryDirectory,
      });
    }),
  );
  return resolved;
}

export function continuationCheckpointStudyV2(
  study: MatchedTokenEfficiencyStudyV1,
  sourceTask: MatchedEvaluationContinuationPilotPlanCurrent['sourceTask'],
  checkpoint: MatchedEvaluationContinuationPilotPlanCurrent['checkpoint'],
): MatchedTokenEfficiencyStudyV1 {
  const taskContext = study.taskContexts.find(candidate => candidate.taskId === sourceTask.taskId);
  if (taskContext === undefined) throw new Error('Continuation source task lacks a study context.');
  const cluster = study.clusters.find(candidate => candidate.clusterId === taskContext.clusterId);
  if (
    cluster === undefined ||
    cluster.repositoryFixtureHash !== sourceTask.repositoryFixtureHash ||
    cluster.revision !== sourceTask.repositoryRevision
  ) {
    throw new Error('Continuation source repository differs from the frozen study cluster.');
  }
  if (checkpoint.preparedContext.graphSnapshotHash === taskContext.graphSnapshotHash) {
    throw new Error('Continuation checkpoint must use a checkpoint-specific prepared graph snapshot.');
  }
  return {
    ...study,
    clusters: study.clusters.map(candidate =>
      candidate.clusterId === cluster.clusterId
        ? {
            ...candidate,
            repositoryFixtureHash: checkpoint.repositoryFixtureHash,
            revision: checkpoint.repositoryRevision,
          }
        : candidate,
    ),
  };
}

async function assertResolvedRuntimeRepositories(
  repositories: ReadonlyMap<string | null, ResolvedRuntimeRepository>,
): Promise<void> {
  await Promise.all(
    [...repositories.values()].map(repository =>
      assertMatchedEvaluationRepositoryV1(repository.repositoryDirectory, repository.expected),
    ),
  );
}

export async function assertMatchedEvaluationContinuationCheckpointV2(input: {
  readonly agentPatch?: string;
  readonly baseFixtureHash: string;
  readonly baseRevision: string;
  readonly checkpoint: MatchedEvaluationRepositoryObservationV1;
  readonly patchSha256: string;
  readonly repositoryDirectory: string;
}): Promise<void> {
  if (input.checkpoint.dirty) throw new Error('Continuation checkpoint must be clean.');
  await assertMatchedEvaluationRepositoryV1(input.repositoryDirectory, input.checkpoint);
  const baseDirectory = await realpath(await mkdtemp(join(tmpdir(), 'threadnote-continuation-base-')));
  const patchDirectory = await realpath(await mkdtemp(join(tmpdir(), 'threadnote-continuation-patch-')));
  let baseWorktreeCreated = false;
  try {
    await captureContinuationGit(input.repositoryDirectory, [
      'worktree',
      'add',
      '--detach',
      baseDirectory,
      input.baseRevision,
    ]);
    baseWorktreeCreated = true;
    const base = await observeMatchedEvaluationRepositoryV1(baseDirectory);
    if (
      base.dirty ||
      base.fixtureHash !== input.baseFixtureHash ||
      base.identityHash !== input.checkpoint.identityHash ||
      base.revision !== input.baseRevision
    ) {
      throw new Error('Continuation source repository differs from the sealed base fixture.');
    }
    if (input.agentPatch !== undefined) {
      if (input.agentPatch.length === 0 || Buffer.byteLength(input.agentPatch) > 8 * 1_024 * 1_024) {
        throw new Error('Continuation phase-one agent patch is empty or oversized.');
      }
      const patchPath = join(patchDirectory, 'agent.patch');
      await writeFile(patchPath, input.agentPatch, {encoding: 'utf8', flag: 'wx', mode: 0o600});
      await captureContinuationGit(baseDirectory, ['apply', '--index', '--whitespace=nowarn', patchPath]);
      const [agentTree, checkpointTree] = await Promise.all([
        captureContinuationGit(baseDirectory, ['write-tree']),
        captureContinuationGit(input.repositoryDirectory, ['rev-parse', `${input.checkpoint.revision}^{tree}`]),
      ]);
      if (agentTree.trim() !== checkpointTree.trim()) {
        throw new Error('Continuation checkpoint differs from the preserved phase-one agent patch.');
      }
    }
  } finally {
    if (baseWorktreeCreated) {
      await captureContinuationGit(input.repositoryDirectory, ['worktree', 'remove', '--force', baseDirectory]);
    }
    await rm(baseDirectory, {force: true, recursive: true});
    await rm(patchDirectory, {force: true, recursive: true});
  }
  const parent = await captureContinuationGit(input.repositoryDirectory, [
    'rev-list',
    '--parents',
    '--max-count=1',
    input.checkpoint.revision,
  ]);
  const lineage = parent.trim().split(/\s+/u);
  if (lineage.length !== 2 || lineage[0] !== input.checkpoint.revision || lineage[1] !== input.baseRevision) {
    throw new Error('Continuation checkpoint must be one direct non-merge commit after the frozen source revision.');
  }
  const patch = await captureContinuationGit(
    input.repositoryDirectory,
    [
      'diff',
      '--binary',
      '--full-index',
      '--no-color',
      '--no-ext-diff',
      '--src-prefix=a/',
      '--dst-prefix=b/',
      input.baseRevision,
      input.checkpoint.revision,
      '--',
      '.',
      ':(exclude).context/**',
      ':(exclude)**/.context/**',
    ],
    8 * 1_024 * 1_024,
  );
  if (patch.length === 0) throw new Error('Continuation checkpoint phase-one patch must be nonempty.');
  const sealedPatch = input.agentPatch ?? patch;
  if (sha256Bytes(Buffer.from(sealedPatch)) !== input.patchSha256) {
    throw new Error('Continuation checkpoint phase-one patch differs from the sealed hash.');
  }
}

async function captureContinuationGit(
  repositoryDirectory: string,
  arguments_: readonly string[],
  maxOutputBytes = 64 * 1_024,
  environmentOverrides: Readonly<Record<string, string>> = {},
): Promise<string> {
  const result = await captureCodeMemoryLinkProcessGroup({
    arguments: ['-C', repositoryDirectory, ...arguments_],
    command: 'git',
    cwd: repositoryDirectory,
    environment: {
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_NO_REPLACE_OBJECTS: '1',
      HOME: '/nonexistent',
      LANG: 'C.UTF-8',
      LC_ALL: 'C.UTF-8',
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      ...environmentOverrides,
    },
    label: 'Continuation checkpoint provenance',
    maxOutputBytes,
    timeoutMilliseconds: 30_000,
  });
  return result.stdout;
}

export async function applyMatchedEvaluationContinuationPhaseOnePatchV1(input: {
  readonly agentPatchPath: string;
  readonly allowedPaths: readonly string[];
  readonly repositoryDirectory: string;
}): Promise<void> {
  await captureContinuationGit(input.repositoryDirectory, [
    'apply',
    '--index',
    '--whitespace=nowarn',
    ...input.allowedPaths.map(path => `--include=${path}`),
    input.agentPatchPath,
  ]);
}

export async function prepareMatchedEvaluationContinuationPhaseOnePatchV1(input: {
  readonly agentPatchPath: string;
  readonly allowedPaths: readonly string[];
  readonly baseRevision: string;
  readonly checkpointPatchPath: string;
  readonly repositoryDirectory: string;
}): Promise<{
  readonly changedPaths: readonly string[];
  readonly checkpointPatch: string;
  readonly needsCommit: boolean;
}> {
  const expectedProjectionRoot = await realpath(await mkdtemp(join(tmpdir(), 'threadnote-continuation-patch-')));
  let expectedPatch: string;
  let expectedChangedPaths: readonly string[];
  try {
    const expectedIndex = join(expectedProjectionRoot, 'index');
    const indexEnvironment = {GIT_INDEX_FILE: expectedIndex};
    await captureContinuationGit(
      input.repositoryDirectory,
      ['read-tree', input.baseRevision],
      64 * 1_024,
      indexEnvironment,
    );
    await captureContinuationGit(
      input.repositoryDirectory,
      [
        'apply',
        '--cached',
        '--whitespace=nowarn',
        ...input.allowedPaths.map(path => `--include=${path}`),
        input.agentPatchPath,
      ],
      64 * 1_024,
      indexEnvironment,
    );
    expectedChangedPaths = continuationGitPaths(
      await captureContinuationGit(
        input.repositoryDirectory,
        ['diff', '--cached', '--name-only', '-z', input.baseRevision, '--'],
        64 * 1_024,
        indexEnvironment,
      ),
    );
    expectedPatch = await captureContinuationGit(
      input.repositoryDirectory,
      continuationCheckpointPatchDiffArguments(input.baseRevision, true),
      8 * 1_024 * 1_024,
      indexEnvironment,
    );
  } finally {
    await rm(expectedProjectionRoot, {force: true, recursive: true});
  }
  const allowedPaths = [...input.allowedPaths].sort();
  if (
    expectedChangedPaths.length !== allowedPaths.length ||
    expectedChangedPaths.some((path, index) => path !== allowedPaths[index])
  ) {
    throw new Error('Continuation phase-one patch changes a path outside the sealed test-only boundary.');
  }

  const headRevision = (await captureContinuationGit(input.repositoryDirectory, ['rev-parse', 'HEAD'])).trim();
  const needsCommit = headRevision === input.baseRevision;
  if (needsCommit) {
    const unstagedPaths = continuationGitPaths(
      await captureContinuationGit(input.repositoryDirectory, ['diff', '--name-only', '-z', '--']),
    );
    if (unstagedPaths.length > 0) {
      throw new Error('Continuation checkpoint has unstaged tracked changes and cannot be resumed safely.');
    }
    const stagedPaths = continuationGitPaths(
      await captureContinuationGit(input.repositoryDirectory, ['diff', '--cached', '--name-only', '-z', '--']),
    );
    if (stagedPaths.length === 0) {
      await applyMatchedEvaluationContinuationPhaseOnePatchV1(input);
    }
  }
  const actualDiffArguments = continuationCheckpointPatchDiffArguments(input.baseRevision, needsCommit);
  const [actualChangedPaths, actualPatch] = await Promise.all([
    captureContinuationGit(
      input.repositoryDirectory,
      needsCommit
        ? ['diff', '--cached', '--name-only', '-z', input.baseRevision, '--']
        : ['diff', '--name-only', '-z', input.baseRevision, 'HEAD', '--'],
    ).then(continuationGitPaths),
    captureContinuationGit(input.repositoryDirectory, actualDiffArguments, 8 * 1_024 * 1_024),
  ]);
  if (actualPatch !== expectedPatch || JSON.stringify(actualChangedPaths) !== JSON.stringify(expectedChangedPaths)) {
    throw new Error('Continuation checkpoint differs from the sealed filtered phase-one patch.');
  }
  const preservedCheckpointPatch = await readFile(input.checkpointPatchPath, 'utf8').catch(cause => {
    if (isMissing(cause)) return null;
    throw cause;
  });
  if (preservedCheckpointPatch === null) {
    await writeFile(input.checkpointPatchPath, expectedPatch, {encoding: 'utf8', flag: 'wx', mode: 0o600});
  } else if (preservedCheckpointPatch !== expectedPatch) {
    throw new Error('Continuation checkpoint patch differs from the sealed filtered phase-one patch.');
  }
  return {changedPaths: expectedChangedPaths, checkpointPatch: expectedPatch, needsCommit};
}

function continuationCheckpointPatchDiffArguments(baseRevision: string, cached: boolean): readonly string[] {
  return [
    'diff',
    ...(cached ? ['--cached'] : []),
    '--binary',
    '--full-index',
    '--no-color',
    '--no-ext-diff',
    '--src-prefix=a/',
    '--dst-prefix=b/',
    baseRevision,
    ...(cached ? [] : ['HEAD']),
    '--',
    '.',
  ];
}

function continuationGitPaths(output: string): readonly string[] {
  return output.split('\0').filter(Boolean).sort();
}

async function runMatchedEvaluationContinuationFocusedCheckV1(input: {
  readonly commandTokens: readonly string[];
  readonly repositoryDirectory: string;
  readonly safeExecutablePath: string;
  readonly temporaryDirectory: string;
}) {
  let executableIndex = 0;
  const environmentAssignments: Record<string, string> = {};
  while (
    executableIndex < input.commandTokens.length &&
    /^[A-Z][A-Z0-9_]*=/u.test(input.commandTokens[executableIndex])
  ) {
    const token = input.commandTokens[executableIndex];
    const separator = token.indexOf('=');
    environmentAssignments[token.slice(0, separator)] = token.slice(separator + 1);
    executableIndex += 1;
  }
  const command = input.commandTokens[executableIndex];
  if (command === undefined) throw new Error('Continuation focused check lacks an executable.');
  await mkdir(input.temporaryDirectory, {recursive: true, mode: 0o700});
  return captureCodeMemoryLinkProcessGroup({
    allowFailure: true,
    arguments: input.commandTokens.slice(executableIndex + 1),
    command,
    cwd: input.repositoryDirectory,
    environment: {
      ...environmentAssignments,
      HOME: input.temporaryDirectory,
      LANG: 'C.UTF-8',
      LC_ALL: 'C.UTF-8',
      PATH: input.safeExecutablePath,
      PYTHONDONTWRITEBYTECODE: '1',
      PYTHONNOUSERSITE: '1',
      TMPDIR: input.temporaryDirectory,
    },
    label: 'Continuation phase-one focused check',
    maxOutputBytes: 1 * 1_024 * 1_024,
    timeoutMilliseconds: 15 * 60_000,
  });
}

export async function assertMatchedEvaluationContinuationAcceptedFixCompatibilityV1(input: {
  readonly allowedPaths: readonly string[];
  readonly calibration: MatchedEvaluationVerificationCalibrationV1;
  readonly checkpointRepositoryDirectory: string;
  readonly commandTokens: readonly string[];
  readonly dependencyProjection: MatchedEvaluationDependencyProjectionV1 | null;
  readonly repositoryDirectory: string;
  readonly repositoryIdentityHash: string;
  readonly safeExecutablePath: string;
}): Promise<void> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'threadnote-continuation-accepted-fix-')));
  const repositoryDirectory = resolve(root, 'repository');
  let worktreeCreated = false;
  try {
    await captureContinuationGit(input.repositoryDirectory, [
      'worktree',
      'add',
      '--detach',
      repositoryDirectory,
      input.calibration.fixRevision,
    ]);
    worktreeCreated = true;
    await assertMatchedEvaluationRepositoryV1(repositoryDirectory, {
      dirty: false,
      fixtureHash: input.calibration.fixRepositoryFixtureHash,
      identityHash: input.repositoryIdentityHash,
      revision: input.calibration.fixRevision,
    });
    for (const path of input.allowedPaths) {
      if (!isSafeContinuationRepositoryPath(path)) {
        throw new Error('Continuation phase-one accepted-fix replay path is invalid.');
      }
      const source = resolve(input.checkpointRepositoryDirectory, path);
      const destination = resolve(repositoryDirectory, path);
      const sourceMetadata = await lstat(source);
      const destinationMetadata = await lstat(destination).catch(cause => {
        if (isMissing(cause)) return null;
        throw cause;
      });
      if (
        !sourceMetadata.isFile() ||
        sourceMetadata.isSymbolicLink() ||
        sourceMetadata.nlink !== 1 ||
        destinationMetadata?.isSymbolicLink()
      ) {
        throw new Error('Continuation phase-one accepted-fix replay requires regular test files.');
      }
      await mkdir(dirname(destination), {recursive: true});
      await writeFile(destination, await readFile(source), {mode: sourceMetadata.mode & 0o777});
    }
    await ensureMatchedEvaluationDependencyProjectionV1({
      projection: input.dependencyProjection,
      repositoryDirectory,
    });
    const focusedCheck = await runMatchedEvaluationContinuationFocusedCheckV1({
      commandTokens: input.commandTokens,
      repositoryDirectory,
      safeExecutablePath: input.safeExecutablePath,
      temporaryDirectory: resolve(root, 'check-tmp'),
    });
    if (focusedCheck.exitCode !== 0) {
      throw new Error(
        `Continuation phase-one regression is incompatible with the calibrated accepted correction: focused check exited ${focusedCheck.exitCode}.`,
      );
    }
  } finally {
    if (worktreeCreated) {
      await captureContinuationGit(input.repositoryDirectory, ['worktree', 'remove', '--force', repositoryDirectory]);
    }
    await rm(root, {force: true, recursive: true});
  }
}

async function ensureMatchedEvaluationDependencyProjectionV1(input: {
  readonly projection: MatchedEvaluationDependencyProjectionV1 | null;
  readonly repositoryDirectory: string;
}): Promise<void> {
  if (input.projection === null) return;
  const targetDirectory = resolve(input.repositoryDirectory, input.projection.targetRelativePath);
  const exists = await lstat(targetDirectory).then(
    metadata => {
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
        throw new Error('Dependency projection target exists but is not one directory.');
      }
      return true;
    },
    cause => {
      if (isMissing(cause)) return false;
      throw cause;
    },
  );
  if (!exists) {
    await materializeMatchedEvaluationDependencyProjectionV1({
      projection: input.projection,
      repositoryRoot: input.repositoryDirectory,
    });
    return;
  }
  if (
    (await matchedEvaluationDependencyProjectionFixtureHashV1(targetDirectory, input.repositoryDirectory)) !==
    input.projection.fixtureHash
  ) {
    throw new Error('Existing dependency projection differs from its pinned fixture hash.');
  }
  const lockFile = await realpath(resolve(input.repositoryDirectory, input.projection.lockFileRelativePath));
  const lockFromRepository = relative(input.repositoryDirectory, lockFile);
  if (
    lockFromRepository === '..' ||
    lockFromRepository.startsWith(`..${sep}`) ||
    isAbsolute(lockFromRepository) ||
    sha256Bytes(await readFile(lockFile)) !== input.projection.lockFileSha256
  ) {
    throw new Error('Existing dependency projection lock file differs from its pinned hash.');
  }
}

function dependencyProjectionForTaskV1(
  config: ReturnType<typeof parseMatchedEvaluationCodexAdapterConfigV1>,
  taskId: string,
): MatchedEvaluationDependencyProjectionV1 | null {
  return config.dependencyProjections.find(projection => projection.taskId === taskId) ?? null;
}

export function matchContinuationPhaseTwoCommandsV1(input: {
  readonly approvedCommands: ReturnType<typeof parseMatchedEvaluationCodexAdapterConfigV1>['approvedCommands'];
  readonly commandTexts: readonly string[];
  readonly taskId: string;
}) {
  if (input.commandTexts.length === 0 || input.commandTexts.length > 8) {
    throw new Error('Continuation phase-two verification must contain 1-8 commands.');
  }
  const matched = input.commandTexts.map((commandText, index) => {
    const canonicalTokens = tokenizeCodeMemoryLinkCommandV1(commandText.replaceAll('{python}', 'python').trim());
    const candidates = input.approvedCommands.filter(
      command =>
        command.taskId === input.taskId &&
        command.tokens.length === canonicalTokens.length &&
        command.tokens.every((token, tokenIndex) => token === canonicalTokens[tokenIndex]),
    );
    if (candidates.length !== 1) {
      throw new Error(`Continuation phase-two command ${index} is not one unique sealed approved command.`);
    }
    return candidates[0];
  });
  if (new Set(matched.map(command => JSON.stringify(command.tokens))).size !== matched.length) {
    throw new Error('Continuation phase-two verification commands must be unique.');
  }
  return matched;
}

async function prepareMatchedEvaluationContinuationPhaseTwoVerificationPlanV1(input: {
  readonly checkpointRevision: string;
  readonly commands: ReturnType<typeof matchContinuationPhaseTwoCommandsV1>;
  readonly dependencyProjection: MatchedEvaluationDependencyProjectionV1 | null;
  readonly protectedPaths: readonly string[];
  readonly repositoryDirectory: string;
  readonly safeExecutablePath: string;
  readonly taskId: string;
  readonly temporaryRoot: string;
}): Promise<MatchedContinuationPhaseTwoVerificationPlanV1> {
  const checks: Array<{
    readonly allowedBaselineFailureIds: readonly string[];
    readonly commandTokens: readonly string[];
    readonly diagnosticParser: MatchedContinuationPhaseTwoDiagnosticParser;
    readonly policy: 'must-pass' | 'no-new-failures';
  }> = [];
  const repositoryDirectory = resolve(input.temporaryRoot, 'repository');
  let worktreeCreated = false;
  try {
    await mkdir(input.temporaryRoot, {mode: 0o700});
    await captureContinuationGit(input.repositoryDirectory, [
      'worktree',
      'add',
      '--detach',
      repositoryDirectory,
      input.checkpointRevision,
    ]);
    worktreeCreated = true;
    await ensureMatchedEvaluationDependencyProjectionV1({
      projection: input.dependencyProjection,
      repositoryDirectory,
    });
    for (const [index, command] of input.commands.entries()) {
      const result = await runMatchedEvaluationContinuationFocusedCheckV1({
        commandTokens: command.tokens,
        repositoryDirectory,
        safeExecutablePath: input.safeExecutablePath,
        temporaryDirectory: resolve(input.temporaryRoot, `check-${index + 1}`),
      });
      const diagnosticParser = matchedContinuationDiagnosticParserForCommandV1(command.tokens, {
        stderr: result.stderr,
        stdout: result.stdout,
      });
      const failureIds = parseMatchedContinuationFailureIdsV1(diagnosticParser, result.stdout, result.stderr);
      assertMatchedContinuationPhaseTwoBaselineResultV1({
        checkIndex: index,
        exitCode: result.exitCode,
        failureIds,
      });
      if (index === 0) {
        checks.push({
          allowedBaselineFailureIds: [],
          commandTokens: command.tokens,
          diagnosticParser,
          policy: 'must-pass',
        });
      } else {
        checks.push({
          allowedBaselineFailureIds: failureIds,
          commandTokens: command.tokens,
          diagnosticParser,
          policy: 'no-new-failures',
        });
      }
    }
  } finally {
    if (worktreeCreated) {
      await captureContinuationGit(input.repositoryDirectory, ['worktree', 'remove', '--force', repositoryDirectory]);
    }
    await rm(input.temporaryRoot, {force: true, recursive: true});
  }
  return createMatchedContinuationPhaseTwoVerificationPlanV1({
    checks,
    protectedPaths: input.protectedPaths,
    taskId: input.taskId,
  });
}

export function assertMatchedContinuationPhaseTwoBaselineResultV1(input: {
  readonly checkIndex: number;
  readonly exitCode: number | null;
  readonly failureIds: readonly string[];
}): void {
  if (input.exitCode !== 0 && input.exitCode !== 1) {
    throw new Error(`Continuation phase-two baseline command ${input.checkIndex} failed as infrastructure.`);
  }
  if (input.checkIndex === 0) {
    if (input.exitCode !== 1 || input.failureIds.length === 0) {
      throw new Error('Continuation phase-two target check must fail at the Phase-1 checkpoint.');
    }
    return;
  }
  if (input.exitCode === 1 && input.failureIds.length === 0) {
    throw new Error(`Continuation phase-two baseline command ${input.checkIndex} has unparseable failures.`);
  }
}

export function matchedContinuationDiagnosticParserForCommandV1(
  commandTokens: readonly string[],
  diagnosticOutput?: {readonly stderr: string; readonly stdout: string},
): MatchedContinuationPhaseTwoDiagnosticParser {
  const executableName = commandTokens[0]?.split('/').at(-1) ?? '';
  if (executableName === 'v19-verifier.py') return 'threadnote-verifier-v1';
  const usesPytest = commandTokens.includes('pytest') || /^pytest(?:$|-)/u.test(executableName);
  const usesVitest = commandTokens.includes('vitest') || /^vitest(?:$|-)/u.test(executableName);
  if (usesPytest !== usesVitest) {
    return usesPytest ? 'pytest-summary-v1' : 'vitest-summary-v1';
  }
  if (!usesPytest && diagnosticOutput !== undefined) {
    const inferred = (['pytest-summary-v1', 'threadnote-verifier-v1', 'vitest-summary-v1'] as const).filter(
      parser =>
        parseMatchedContinuationFailureIdsV1(parser, diagnosticOutput.stdout, diagnosticOutput.stderr).length > 0,
    );
    if (inferred.length === 1) return inferred[0];
  }
  throw new Error('Continuation phase-two command must select exactly one supported diagnostic parser.');
}

export async function verifyMatchedEvaluationContinuationArtifactV1(input: {
  readonly artifactHash: string;
  readonly artifactPath: string;
  readonly checkpointRepository: string;
  readonly checkpointRevision: string;
  readonly dependencyProjection: MatchedEvaluationDependencyProjectionV1 | null;
  readonly plan: MatchedContinuationPhaseTwoVerificationPlanV1;
  readonly safeExecutablePath: string;
}): Promise<MatchedContinuationPhaseTwoVerificationReceiptV1> {
  const artifact = object(await readJson(input.artifactPath), 'continuation phase-two artifact');
  const patch = boundedString(artifact.patch, 1, 8 * 1_024 * 1_024, 'continuation phase-two patch');
  const startedAt = Date.now();
  const root = await realpath(await mkdtemp(join(tmpdir(), 'threadnote-continuation-phase-two-verification-')));
  const repositoryDirectory = resolve(root, 'repository');
  const patchPath = resolve(root, 'agent.patch');
  let worktreeCreated = false;
  let protectedPathViolations: readonly string[] = [];
  const receipts: MatchedContinuationPhaseTwoVerificationCheckReceiptV1[] = [];
  try {
    await captureContinuationGit(input.checkpointRepository, [
      'worktree',
      'add',
      '--detach',
      repositoryDirectory,
      input.checkpointRevision,
    ]);
    worktreeCreated = true;
    await ensureMatchedEvaluationDependencyProjectionV1({
      projection: input.dependencyProjection,
      repositoryDirectory,
    });
    await writeFile(patchPath, patch, {encoding: 'utf8', flag: 'wx', mode: 0o600});
    await captureContinuationGit(repositoryDirectory, ['apply', '--index', '--whitespace=nowarn', patchPath]);
    const changedPaths = (
      await captureContinuationGit(repositoryDirectory, ['diff', '--cached', '--name-only', '-z', '--'])
    )
      .split('\0')
      .filter(Boolean);
    protectedPathViolations = changedPaths.filter(path =>
      input.plan.protectedPaths.some(protectedPath => path === protectedPath || path.startsWith(`${protectedPath}/`)),
    );
    for (const [index, check] of input.plan.checks.entries()) {
      const startedAt = Date.now();
      const result = await runMatchedEvaluationContinuationFocusedCheckV1({
        commandTokens: check.commandTokens,
        repositoryDirectory,
        safeExecutablePath: input.safeExecutablePath,
        temporaryDirectory: resolve(root, `check-${index + 1}`),
      });
      if (result.exitCode !== 0 && result.exitCode !== 1) {
        throw new Error(`Continuation phase-two verification command ${index} failed as infrastructure.`);
      }
      const failureIds = parseMatchedContinuationFailureIdsV1(check.diagnosticParser, result.stdout, result.stderr);
      receipts.push(
        createMatchedContinuationPhaseTwoVerificationCheckReceiptV1({
          artifactHash: input.artifactHash,
          check,
          diagnosticHash: sha256Bytes(
            Buffer.from(
              `matched-continuation-phase-two-diagnostic-v1\0${JSON.stringify({
                exitCode: result.exitCode,
                stderr: result.stderr,
                stdout: result.stdout,
              })}`,
            ),
          ),
          durationMilliseconds: Math.max(0, Date.now() - startedAt),
          exitCode: result.exitCode,
          failureIds,
          planHash: input.plan.planHash,
        }),
      );
    }
  } finally {
    if (worktreeCreated) {
      await captureContinuationGit(input.checkpointRepository, ['worktree', 'remove', '--force', repositoryDirectory]);
    }
    await rm(root, {force: true, recursive: true});
  }
  return createMatchedContinuationPhaseTwoVerificationReceiptV1({
    artifactHash: input.artifactHash,
    checks: receipts,
    durationMilliseconds: Math.max(0, Date.now() - startedAt),
    plan: input.plan,
    protectedPathViolations,
  });
}

async function captureMatchedEvaluationContinuationAgentBriefV1(input: {
  readonly budgetTokens: number;
  readonly executable: string;
  readonly home: string;
  readonly project: string;
  readonly repositoryDirectory: string;
  readonly task: string;
  readonly threadnoteEnvironment: Readonly<Record<string, string>>;
}): Promise<string> {
  const client = new Client({name: 'matched-evaluation-checkpoint-finalizer', version: '1'});
  const transport = new StdioClientTransport({
    args: ['mcp-server'],
    command: input.executable,
    cwd: input.repositoryDirectory,
    env: {
      ...input.threadnoteEnvironment,
      CI: '1',
      HOME: input.home,
      LOGNAME: input.threadnoteEnvironment.THREADNOTE_USER ?? 'evaluation-user',
      SHELL: '/bin/sh',
      TERM: 'dumb',
      THREADNOTE_HOME: input.home,
      THREADNOTE_NO_SPINNER: '1',
      THREADNOTE_NO_UPDATE_CHECK: '1',
      USER: input.threadnoteEnvironment.THREADNOTE_USER ?? 'evaluation-user',
    },
    maxBufferSize: 2 * 1_024 * 1_024,
    stderr: 'pipe',
  });
  transport.stderr?.on('data', () => undefined);
  await client.connect(transport, {timeout: 30_000});
  try {
    const result = await client.callTool(
      {
        arguments: {
          budgetTokens: input.budgetTokens,
          callerCwd: input.repositoryDirectory,
          detail: 'compact',
          mode: 'resume',
          project: input.project,
          responseFormat: 'agent',
          task: input.task,
        },
        name: 'context_brief',
      },
      undefined,
      {timeout: 120_000},
    );
    return parseMatchedEvaluationContinuationAgentBriefResultV1(result);
  } finally {
    await client.close();
    await transport.close();
  }
}

export function parseMatchedEvaluationContinuationAgentBriefResultV1(value: unknown): string {
  const result = object(value, 'continuation checkpoint agent Context Brief result');
  if (result.isError === true) throw new Error('Continuation checkpoint agent Context Brief returned an error.');
  if (result.structuredContent !== undefined) {
    throw new Error('Continuation checkpoint agent Context Brief must not include dual structured content.');
  }
  const texts = array(result.content, 'continuation checkpoint agent Context Brief content').flatMap(
    (candidate, index) => {
      const content = object(candidate, `continuation checkpoint agent Context Brief content ${index}`);
      return content.type === 'text' && typeof content.text === 'string' ? [content.text] : [];
    },
  );
  if (texts.length !== 1) {
    throw new Error('Continuation checkpoint agent Context Brief must return exactly one text payload.');
  }
  return texts[0];
}

export function assertMatchedEvaluationContinuationAgentBriefV1(input: {
  readonly automaticHandoffUri: string;
  readonly requiredGraphQuery?: string | null;
  readonly resumeEvidenceMarker: string;
  readonly text: string;
}): void {
  const memoriesIndex = input.automaticHandoffUri.indexOf('/memories/');
  const compactHandoffUri = memoriesIndex === -1 ? null : input.automaticHandoffUri.slice(memoriesIndex + 1);
  const referencesHandoff =
    input.text.includes(input.automaticHandoffUri) ||
    (compactHandoffUri !== null && input.text.includes(compactHandoffUri));
  const trimmed = input.text.trimStart();
  let evidenceState: 'partial' | 'sufficient' | null = /^State: sufficient(?:\s|\|)/mu.test(input.text)
    ? 'sufficient'
    : /^State: partial(?:\s|\|)/mu.test(input.text)
      ? 'partial'
      : null;
  let jsonReferencesHandoff = false;
  let jsonHandoffEvidence: string | null = null;
  if (trimmed.startsWith('{')) {
    let parsed: Record<string, unknown>;
    try {
      parsed = object(JSON.parse(input.text) as unknown, 'continuation checkpoint agent brief');
    } catch (cause) {
      throw new Error('Continuation checkpoint agent Context Brief returned invalid JSON.', {cause});
    }
    evidenceState =
      parsed.evidenceState === 'sufficient' || parsed.evidenceState === 'partial' ? parsed.evidenceState : null;
    const matchingHandoffs = array(parsed.activeHandoffs, 'continuation checkpoint active handoffs').flatMap(
      candidate => {
        const handoffEvidence = object(candidate, 'continuation checkpoint active handoff');
        return handoffEvidence.uri === input.automaticHandoffUri || handoffEvidence.uri === compactHandoffUri
          ? [handoffEvidence]
          : [];
      },
    );
    jsonReferencesHandoff = matchingHandoffs.length === 1;
    jsonHandoffEvidence =
      matchingHandoffs.length === 1 && typeof matchingHandoffs[0].excerpt === 'string'
        ? matchingHandoffs[0].excerpt
        : null;
  }
  const evidenceText = jsonHandoffEvidence ?? input.text;
  const markerCount = evidenceText.split(input.resumeEvidenceMarker).length - 1;
  const referencesRequiredGraphQuery =
    input.requiredGraphQuery === undefined ||
    input.requiredGraphQuery === null ||
    evidenceText.includes(`Graph query: ${input.requiredGraphQuery}`);
  if (
    evidenceState !== 'sufficient' ||
    (!referencesHandoff && !jsonReferencesHandoff) ||
    markerCount !== 1 ||
    !referencesRequiredGraphQuery
  ) {
    throw new Error(
      `Continuation checkpoint agent resume brief does not surface the exact automatic handoff (state=${evidenceState ?? 'missing'}, handoff=${referencesHandoff || jsonReferencesHandoff}, markerCount=${markerCount}, graphQuery=${referencesRequiredGraphQuery}).`,
    );
  }
}

function uniquePrefixedLine(value: string, prefix: string, label: string): string {
  const matches = prefixedLines(value, prefix, label);
  if (matches.length !== 1) throw new Error(`${label} is missing or ambiguous.`);
  return matches[0];
}

function prefixedLines(value: string, prefix: string, label: string): readonly string[] {
  const matches = value
    .split(/\r?\n/u)
    .filter(line => line.startsWith(prefix))
    .map(line => line.slice(prefix.length));
  if (matches.length === 0 || matches.some(match => match.length === 0)) {
    throw new Error(`${label} is missing or ambiguous.`);
  }
  return matches;
}

function parseLastJsonLine(value: string, label: string): Record<string, unknown> {
  const lines = value
    .split(/\r?\n/u)
    .map(line => line.trim())
    .filter(Boolean);
  if (lines.length === 0) throw new Error(`${label} returned no JSON output.`);
  try {
    return object(JSON.parse(lines.at(-1)!) as unknown, label);
  } catch (cause) {
    throw new Error(`${label} returned invalid terminal JSON.`, {cause});
  }
}

async function assertMatchedEvaluationContinuationGraphEvidenceV1(input: {
  readonly executable: string;
  readonly graphHome: string;
  readonly project: string;
  readonly query: string;
  readonly repositoryDirectory: string;
  readonly sourceCitations: readonly {readonly path: string}[];
  readonly threadnoteEnvironment: Readonly<Record<string, string>>;
}): Promise<void> {
  const result = await captureCodeMemoryLinkProcessGroup({
    arguments: [
      'graph',
      'query',
      '--home',
      input.graphHome,
      '--cwd',
      input.repositoryDirectory,
      '--project',
      input.project,
      '--freshness',
      'ready',
      '--node-limit',
      '8',
      '--edge-limit',
      '24',
      '--query',
      input.query,
      '--json',
    ],
    command: input.executable,
    cwd: input.repositoryDirectory,
    environment: input.threadnoteEnvironment,
    label: 'Continuation checkpoint required graph evidence',
    maxOutputBytes: 2 * 1_024 * 1_024,
    timeoutMilliseconds: 120_000,
  });
  assertMatchedEvaluationContinuationGraphEvidenceResultV1(JSON.parse(result.stdout) as unknown, input.sourceCitations);
}

export function assertMatchedEvaluationContinuationGraphEvidenceResultV1(
  value: unknown,
  sourceCitations: readonly {readonly path: string}[],
): void {
  const response = object(value, 'continuation checkpoint graph query');
  const nodes = array(response.nodes, 'continuation checkpoint graph query nodes').map((value, index) =>
    object(value, `continuation checkpoint graph query node ${index}`),
  );
  const edges = array(response.edges, 'continuation checkpoint graph query edges').map((value, index) =>
    object(value, `continuation checkpoint graph query edge ${index}`),
  );
  const sourcePaths = new Set(sourceCitations.map(citation => citation.path));
  const evidenceNodeIds = new Set(
    nodes
      .filter(
        node =>
          typeof node.path === 'string' &&
          sourcePaths.has(node.path) &&
          typeof node.resolutionDomain === 'string' &&
          node.resolutionDomain !== 'degraded' &&
          typeof node.id === 'string',
      )
      .map(node => node.id as string),
  );
  if (
    response.operation !== 'query' ||
    evidenceNodeIds.size === 0 ||
    !edges.some(edge => evidenceNodeIds.has(String(edge.sourceId)) || evidenceNodeIds.has(String(edge.targetId)))
  ) {
    throw new Error(
      'Continuation checkpoint required graph query did not return relationship evidence on a cited source path.',
    );
  }
}

function requiredRuntimeRepository(
  repositories: ReadonlyMap<string | null, ResolvedRuntimeRepository>,
  taskId: string,
  study: MatchedTokenEfficiencyStudyV1 | null,
): ResolvedRuntimeRepository {
  const clusterId = study?.taskContexts.find(context => context.taskId === taskId)?.clusterId ?? null;
  const repository = repositories.get(clusterId);
  if (repository === undefined) throw new Error(`No runtime repository is bound to task ${taskId}.`);
  return repository;
}

async function assertContinuationAutomaticHandoffV1(input: {
  readonly plan: MatchedEvaluationContinuationPilotPlan;
  readonly resolvedCompactArm: ResolvedRuntimeArm;
}): Promise<void> {
  if (input.resolvedCompactArm.toolExecutable === null) {
    throw new Error('Continuation pilot compact arm lacks Threadnote.');
  }
  const config = parseMatchedEvaluationCodexAdapterConfigV1(await readJson(input.resolvedCompactArm.adapterConfigFile));
  const prepared = config.contextHomes.find(home => home.taskId === input.plan.taskId);
  if (prepared === undefined) throw new Error('Continuation pilot compact arm lacks the task prepared home.');
  if (
    input.plan.version !== 1 &&
    (prepared.homeFixtureHash !== input.plan.checkpoint.preparedHome.fixtureHash ||
      matchedEvaluationContinuationPreparedHomeIdentityHashV2(prepared) !==
        input.plan.checkpoint.preparedHome.identitySha256)
  ) {
    throw new Error('Continuation pilot checkpoint prepared home differs from the sealed plan.');
  }
  if ((await matchedEvaluationPreparedHomeFixtureHashV1(prepared.homeDirectory)) !== prepared.homeFixtureHash) {
    throw new Error('Continuation pilot compact prepared home differs from its pinned fixture hash.');
  }
  const read = await captureCodeMemoryLinkProcessGroup({
    arguments: ['read', '--home', prepared.homeDirectory, input.plan.checkpoint.automaticHandoffUri],
    command: input.resolvedCompactArm.toolExecutable,
    cwd: process.cwd(),
    environment: {
      HOME: '/nonexistent',
      LANG: 'C.UTF-8',
      LC_ALL: 'C.UTF-8',
      PATH: '/usr/bin:/bin',
      THREADNOTE_ACCOUNT: prepared.identity.account,
      THREADNOTE_USER: prepared.identity.user,
    },
    label: 'Continuation pilot automatic handoff preflight',
    maxOutputBytes: 1 * 1_024 * 1_024,
    timeoutMilliseconds: 120_000,
  });
  if (
    sha256Bytes(Buffer.from(read.stdout)) !== input.plan.checkpoint.automaticHandoffReadSha256 ||
    !read.stdout.includes(input.plan.checkpoint.resumeEvidenceMarker) ||
    !read.stdout.includes(input.plan.checkpoint.handoff)
  ) {
    throw new Error('Continuation pilot automatic handoff differs from the sealed checkpoint.');
  }
}

export function matchedEvaluationContinuationPreparedHomeIdentityHashV2(
  prepared: Pick<
    ReturnType<typeof parseMatchedEvaluationCodexAdapterConfigV1>['contextHomes'][number],
    'identity' | 'project' | 'taskId'
  >,
): string {
  return sha256Bytes(
    Buffer.from(
      JSON.stringify({
        account: prepared.identity.account,
        project: prepared.project,
        taskId: prepared.taskId,
        user: prepared.identity.user,
      }),
    ),
  );
}

export async function resolveRuntimeArm(
  runtime: MatchedEvaluationRuntimeV1,
  arm: MatchedEvaluationArm,
  definition: MatchedEvaluationArmDefinitionV1,
  adapterArtifactHashOverride: string | null = null,
  adapterConfigOverride: MatchedEvaluationContinuationAdapterConfigOverrideV2 | null = null,
): Promise<ResolvedRuntimeArm | {readonly detail: string; readonly reason: MatchedEvaluationUnavailableReason}> {
  const config = runtime.arms.find(candidate => candidate.arm === arm);
  if (config === undefined) return {detail: `${arm} has no local runtime mapping`, reason: 'runtime-not-configured'};
  const [adapter, adapterConfigFile] = await Promise.all([
    optionalCanonicalRegularFile(config.adapterExecutable, true),
    optionalCanonicalRegularFile(adapterConfigOverride?.adapterConfigFile ?? config.adapterConfigFile, false),
  ]);
  if (adapter === null) return {detail: `${arm} adapter executable is missing`, reason: 'adapter-missing'};
  if (adapterConfigFile === null) {
    return {detail: `${arm} adapter configuration is missing`, reason: 'adapter-config-missing'};
  }
  const adapterArtifactHash = adapterArtifactHashOverride ?? definition.adapterArtifactHash;
  if ((await sha256File(adapter)) !== adapterArtifactHash) {
    throw new Error(`${arm} adapter executable differs from its pinned manifest identity.`);
  }
  const resolvedDefinition = {
    ...definition,
    adapterArtifactHash,
    adapterConfigurationHash: adapterConfigOverride?.adapterConfigurationHash ?? definition.adapterConfigurationHash,
  };
  if (
    (await sha256File(adapterConfigFile)) !==
    (adapterConfigOverride?.adapterConfigurationHash ?? definition.adapterConfigurationHash)
  ) {
    throw new Error(`${arm} adapter configuration differs from its pinned manifest identity.`);
  }
  if (definition.tool.artifactHash === null) {
    if (config.toolExecutable !== null || config.toolLockFile !== null) {
      throw new Error(`${arm} runtime unexpectedly configures a separate tool executable or lock.`);
    }
    return {
      adapterConfigFile,
      config: {...config, adapterConfigFile, adapterExecutable: adapter},
      definition: resolvedDefinition,
      toolExecutable: null,
    };
  }
  if (config.toolExecutable === null || config.toolLockFile === null) {
    return {detail: `${arm} tool executable or lock identity is not configured`, reason: 'tool-missing'};
  }
  const [tool, lock] = await Promise.all([
    optionalCanonicalRegularFile(config.toolExecutable, true),
    optionalCanonicalRegularFile(config.toolLockFile, false),
  ]);
  if (tool === null || lock === null) {
    return {detail: `${arm} pinned tool executable or lock identity is missing`, reason: 'tool-missing'};
  }
  const [toolHash, lockHash] = await Promise.all([sha256File(tool), sha256File(lock)]);
  if (toolHash !== definition.tool.artifactHash || lockHash !== definition.tool.lockIdentityHash) {
    throw new Error(`${arm} tool executable or lock differs from its pinned manifest identity.`);
  }
  return {
    adapterConfigFile,
    config: {...config, adapterExecutable: adapter, toolExecutable: tool, toolLockFile: lock},
    definition: resolvedDefinition,
    toolExecutable: tool,
  };
}

async function executeArm(
  runtime: MatchedEvaluationRuntimeV1,
  resolvedArm: ResolvedRuntimeArm,
  repository: ResolvedRuntimeRepository,
  request: MatchedEvaluationRunRequestV1,
  study: MatchedTokenEfficiencyStudyV1 | null,
  continuationTreatment: MatchedEvaluationContinuationTreatmentV1 | null = null,
  projectedTaskOverride: MatchedEvaluationProjectedAdapterTask | null = null,
) {
  const runDirectory = resolve(runtime.artifactDirectory, 'runs', request.schedule.runNonce);
  const transcriptDirectory = resolve(runtime.artifactDirectory, 'transcripts');
  const requestPath = resolve(runDirectory, 'request.json');
  const responsePath = resolve(runDirectory, 'response.json');
  const artifactPath = resolve(runDirectory, 'artifact.json');
  const transcriptPath = resolve(transcriptDirectory, `${request.schedule.runNonce}.jsonl`);
  const stagedDirectory = resolve(runDirectory, 'runtime');
  await rm(stagedDirectory, {force: true, recursive: true});
  await Promise.all([
    mkdir(runDirectory, {recursive: true, mode: 0o700}),
    mkdir(transcriptDirectory, {recursive: true, mode: 0o700}),
    mkdir(stagedDirectory, {recursive: true, mode: 0o700}),
  ]);
  const stagedArm = await stageResolvedRuntimeArmV1(resolvedArm, stagedDirectory);
  if (request.arm === 'reference-scope')
    await mkdir(resolve(runDirectory, 'reference-home'), {recursive: true, mode: 0o700});
  const projectedTask = projectedTaskOverride ?? projectMatchedEvaluationAdapterTaskV1(request, study);
  await atomicWrite(
    requestPath,
    `${JSON.stringify(
      {
        adapterArtifactHash: stagedArm.definition.adapterArtifactHash,
        adapterProtocol: stagedArm.definition.adapterProtocol,
        adapterConfigurationHash: stagedArm.definition.adapterConfigurationHash,
        arm: request.arm,
        environmentPolicyHash: stagedArm.definition.environmentPolicyHash,
        agentTask: projectedTask.agentTask,
        artifactPath,
        blindLabel: request.schedule.blindLabel,
        continuationTreatment,
        judgeTask: {
          negativeControls: request.task.negativeControls,
          rubric: request.task.rubric,
          sourceGold: request.task.sourceGold,
        },
        manifestHash: request.manifest.manifestHash,
        model: request.manifest.model,
        repository: repository.expected,
        preparedContext: projectedTask.preparedContext,
        runNonce: request.schedule.runNonce,
        runOrder: request.schedule.runOrder,
        tool: {
          artifactHash: stagedArm.definition.tool.artifactHash,
          detail:
            request.arm === 'threadnote-source'
              ? 'source'
              : request.arm === 'threadnote-compact'
                ? 'compact'
                : request.arm === 'threadnote-graph'
                  ? 'graph-only'
                  : null,
          executable: stagedArm.toolExecutable,
          lockIdentityHash: stagedArm.definition.tool.lockIdentityHash,
          name: stagedArm.definition.tool.name,
          version: stagedArm.definition.tool.version,
        },
        transcriptPath,
        verificationPlanHash: study?.verificationPlanHash ?? null,
        version: MATCHED_EVALUATION_RUNTIME_VERSION,
      },
      undefined,
      2,
    )}\n`,
  );
  await assertResolvedRuntimeArmArtifactsV1(stagedArm);
  let result;
  try {
    result = await captureCodeMemoryLinkProcessGroup({
      allowFailure: true,
      arguments: [...stagedArm.config.adapterArguments, '--request', requestPath, '--response', responsePath],
      command: stagedArm.config.adapterExecutable,
      cwd: repository.repositoryDirectory,
      environment: runtimeEnvironment(stagedArm, runDirectory),
      label: `Matched evaluation ${request.arm}`,
      maxOutputBytes: 1 * 1_024 * 1_024,
      timeoutMilliseconds: runtime.timeoutMilliseconds,
    });
  } finally {
    await assertResolvedRuntimeArmArtifactsV1(stagedArm);
  }
  if (result.exitCode !== 0) {
    throw new Error(`${request.arm} adapter failed with exit code ${result.exitCode}: ${boundedDiagnostic(result)}`);
  }
  const observation = parseMatchedEvaluationObservationV1(await readJson(responsePath));
  if (study !== null) {
    if (projectedTaskOverride === null) {
      assertMatchedTokenEfficiencyObservationContextV1({
        arm: request.arm,
        metrics: observation.metrics,
        study,
        taskId: request.task.taskId,
      });
    } else {
      assertProjectedObservationContext(projectedTask, observation.metrics.context);
    }
  }
  const [artifactHash, transcriptHash] = await Promise.all([
    boundedRegularFileHash(artifactPath, MAXIMUM_JSON_BYTES, 'adapter artifact'),
    boundedRegularFileHash(transcriptPath, MAXIMUM_TRANSCRIPT_BYTES, 'local transcript'),
  ]);
  if (artifactHash !== observation.artifactHash || transcriptHash !== observation.transcriptHash) {
    throw new Error(`${request.arm} adapter observation does not bind its local artifact and transcript bytes.`);
  }
  return observation;
}

function assertProjectedObservationContext(
  projectedTask: MatchedEvaluationProjectedAdapterTask,
  observationContext: unknown,
): void {
  if (projectedTask.preparedContext === null) {
    if (observationContext !== null) throw new Error('Continuation files arm unexpectedly reported context.');
    return;
  }
  const expected = object(projectedTask.preparedContext, 'continuation projected context');
  const memoryAccess = matchingString(
    expected.memoryAccess,
    /^(?:disabled|linked)$/u,
    'continuation projected memory access',
  );
  const expectedEvidence = object(
    memoryAccess === 'disabled' ? expected.graphContext : expected.taskContext,
    'continuation projected evidence',
  );
  const actual = object(observationContext, 'continuation observation context');
  const wanted = {
    graphReady: true,
    graphSnapshotHash: expectedEvidence.graphSnapshotHash,
    linkReceiptsHash: memoryAccess === 'disabled' ? null : expectedEvidence.linkReceiptsHash,
    memoryAccess,
    studyHash: expected.studyHash,
    taskContextHash: memoryAccess === 'disabled' ? null : expectedEvidence.taskContextHash,
  } as const;
  for (const [key, value] of Object.entries(wanted)) {
    if (actual[key] !== value) throw new Error(`Continuation observation context mismatch: ${key}.`);
  }
}

export async function stageResolvedRuntimeArmV1(
  resolvedArm: ResolvedRuntimeArm,
  stagedDirectory: string,
): Promise<ResolvedRuntimeArm> {
  const [adapterExecutable, adapterConfigFile] = await Promise.all([
    stageMatchedEvaluationPinnedFileV1(
      resolvedArm.config.adapterExecutable,
      resolve(stagedDirectory, 'adapter'),
      resolvedArm.definition.adapterArtifactHash,
      true,
      `${resolvedArm.definition.arm} adapter executable`,
    ),
    stageMatchedEvaluationPinnedFileV1(
      resolvedArm.adapterConfigFile,
      resolve(stagedDirectory, 'adapter-config.json'),
      resolvedArm.definition.adapterConfigurationHash,
      false,
      `${resolvedArm.definition.arm} adapter configuration`,
    ),
  ]);
  if (resolvedArm.definition.tool.artifactHash === null) {
    return {
      adapterConfigFile,
      config: {...resolvedArm.config, adapterConfigFile, adapterExecutable},
      definition: resolvedArm.definition,
      toolExecutable: null,
    };
  }
  if (
    resolvedArm.config.toolExecutable === null ||
    resolvedArm.config.toolLockFile === null ||
    resolvedArm.definition.tool.lockIdentityHash === null
  ) {
    throw new Error(`${resolvedArm.definition.arm} lost its pinned tool configuration.`);
  }
  if (resolvedArm.definition.tool.name === 'threadnote' && resolvedArm.definition.tool.version === '5.0.7') {
    if (
      resolvedArm.definition.tool.lockIdentityHash !== PRODUCTION_RELEASE_ARCHIVE_HASH ||
      resolvedArm.definition.tool.artifactHash !== PRODUCTION_RELEASE_EXECUTABLE_HASH
    ) {
      throw new Error('Production release manifest identities do not match the pinned 5.0.7 release.');
    }
    const payload = await stageMatchedEvaluationProductionPayloadV1({
      archivePath: resolvedArm.config.toolLockFile,
      archiveHash: PRODUCTION_RELEASE_ARCHIVE_HASH,
      directory: resolve(stagedDirectory, 'subject-release'),
      executableHash: PRODUCTION_RELEASE_EXECUTABLE_HASH,
    });
    return {
      adapterConfigFile,
      config: {
        ...resolvedArm.config,
        adapterConfigFile,
        adapterExecutable,
        toolExecutable: payload.executable,
        toolLockFile: payload.stagedArchive,
      },
      definition: resolvedArm.definition,
      toolExecutable: payload.executable,
      toolPayload: {hash: payload.payloadHash, root: payload.root},
    };
  }
  const [toolExecutable, toolLockFile] = await Promise.all([
    stageMatchedEvaluationPinnedFileV1(
      resolvedArm.config.toolExecutable,
      resolve(stagedDirectory, 'tool'),
      resolvedArm.definition.tool.artifactHash,
      true,
      `${resolvedArm.definition.arm} tool executable`,
    ),
    stageMatchedEvaluationPinnedFileV1(
      resolvedArm.config.toolLockFile,
      resolve(stagedDirectory, 'tool.lock'),
      resolvedArm.definition.tool.lockIdentityHash,
      false,
      `${resolvedArm.definition.arm} tool lock`,
    ),
  ]);
  return {
    adapterConfigFile,
    config: {...resolvedArm.config, adapterConfigFile, adapterExecutable, toolExecutable, toolLockFile},
    definition: resolvedArm.definition,
    toolExecutable,
  };
}

export async function stageMatchedEvaluationProductionPayloadV1(input: {
  readonly archivePath: string;
  readonly archiveHash: string;
  readonly directory: string;
  readonly executableHash: string;
}): Promise<{
  readonly executable: string;
  readonly payloadHash: string;
  readonly root: string;
  readonly stagedArchive: string;
}> {
  if (
    input.archiveHash !== PRODUCTION_RELEASE_ARCHIVE_HASH ||
    input.executableHash !== PRODUCTION_RELEASE_EXECUTABLE_HASH
  ) {
    throw new Error('Production release identities are not the pinned 5.0.7 identities.');
  }
  if ((await sha256File(input.archivePath)) !== input.archiveHash)
    throw new Error('Production release archive differs from its pinned identity.');
  await mkdir(input.directory, {mode: 0o700});
  const canonicalDirectory = await realpath(input.directory);
  const stagedArchive = resolve(canonicalDirectory, '..', 'subject-release.tar.gz');
  await stageMatchedEvaluationPinnedFileV1(
    input.archivePath,
    stagedArchive,
    input.archiveHash,
    false,
    'production release archive',
  );
  const listing = await captureCodeMemoryLinkProcessGroup({
    arguments: ['-tzf', stagedArchive],
    command: '/usr/bin/tar',
    cwd: canonicalDirectory,
    environment: {HOME: '/nonexistent', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', PATH: '/usr/bin:/bin', TMPDIR: '/tmp'},
    label: 'Matched evaluation production release archive inspection',
    maxOutputBytes: 4 * 1_024 * 1_024,
    timeoutMilliseconds: 30_000,
  });
  for (const name of listing.stdout
    .split(/\r?\n/u)
    .map(line => line.trim())
    .filter(Boolean)) {
    if (name.startsWith('/') || name.split('/').includes('..') || name.includes('\\0')) {
      throw new Error('Production release archive contains an unsafe path.');
    }
  }
  await captureCodeMemoryLinkProcessGroup({
    arguments: ['-xzf', stagedArchive, '-C', canonicalDirectory],
    command: '/usr/bin/tar',
    cwd: input.directory,
    environment: {HOME: '/nonexistent', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', PATH: '/usr/bin:/bin', TMPDIR: '/tmp'},
    label: 'Matched evaluation production release extraction',
    maxOutputBytes: 64 * 1_024,
    timeoutMilliseconds: 30_000,
  });
  const root = canonicalDirectory;
  const executable = resolve(root, 'threadnote');
  await assertPayloadTreeV1(root);
  if ((await sha256File(executable)) !== input.executableHash)
    throw new Error('Extracted production executable differs from its pinned identity.');
  return {executable, payloadHash: await hashMatchedEvaluationPayloadV1(root), root, stagedArchive};
}

async function assertPayloadTreeV1(root: string): Promise<void> {
  const metadata = await lstat(root);
  if (!metadata.isDirectory() || metadata.isSymbolicLink())
    throw new Error('Production payload root must be a real directory.');
  for (const entry of await readdir(root)) {
    const path = resolve(root, entry);
    const child = await lstat(path);
    if (child.isSymbolicLink()) throw new Error(`Production payload contains symbolic link: ${entry}`);
    if (child.isDirectory()) await assertPayloadTreeV1(path);
    else if (!child.isFile() || child.nlink !== 1)
      throw new Error(`Production payload contains unsupported file: ${entry}`);
  }
}

export async function hashMatchedEvaluationPayloadV1(root: string): Promise<string> {
  const files: Array<{readonly mode: number; readonly path: string; readonly relative: string}> = [];
  const visit = async (directory: string, relativeDirectory: string): Promise<void> => {
    for (const entry of await readdir(directory)) {
      const path = resolve(directory, entry);
      const relative = relativeDirectory ? `${relativeDirectory}/${entry}` : entry;
      const metadata = await lstat(path);
      if (metadata.isSymbolicLink()) throw new Error(`Production payload contains symbolic link: ${relative}`);
      if (metadata.isDirectory()) await visit(path, relative);
      else if (!metadata.isFile() || metadata.nlink !== 1)
        throw new Error(`Production payload contains unsupported file: ${relative}`);
      else files.push({mode: metadata.mode & 0o7777, path, relative});
    }
  };
  await visit(root, '');
  files.sort((left, right) => left.relative.localeCompare(right.relative));
  const hash = createHash('sha256');
  for (const file of files)
    hash.update(`${file.relative}\0${file.mode.toString(8)}\0${sha256Bytes(await readFile(file.path))}\n`);
  return hash.digest('hex');
}

async function assertResolvedRuntimeArmArtifactsV1(resolvedArm: ResolvedRuntimeArm): Promise<void> {
  await Promise.all([
    assertMatchedEvaluationPinnedFileV1(
      resolvedArm.config.adapterExecutable,
      resolvedArm.definition.adapterArtifactHash,
      true,
      `${resolvedArm.definition.arm} adapter executable`,
    ),
    assertMatchedEvaluationPinnedFileV1(
      resolvedArm.adapterConfigFile,
      resolvedArm.definition.adapterConfigurationHash,
      false,
      `${resolvedArm.definition.arm} adapter configuration`,
    ),
  ]);
  if (resolvedArm.definition.tool.artifactHash === null) return;
  if (
    resolvedArm.config.toolExecutable === null ||
    resolvedArm.config.toolLockFile === null ||
    resolvedArm.definition.tool.lockIdentityHash === null
  ) {
    throw new Error(`${resolvedArm.definition.arm} lost its pinned tool configuration.`);
  }
  await Promise.all([
    assertMatchedEvaluationPinnedFileV1(
      resolvedArm.config.toolExecutable,
      resolvedArm.definition.tool.artifactHash,
      true,
      `${resolvedArm.definition.arm} tool executable`,
    ),
    assertMatchedEvaluationPinnedFileV1(
      resolvedArm.config.toolLockFile,
      resolvedArm.definition.tool.lockIdentityHash,
      false,
      `${resolvedArm.definition.arm} tool lock`,
    ),
  ]);
  if (resolvedArm.toolPayload !== undefined) {
    if ((await hashMatchedEvaluationPayloadV1(resolvedArm.toolPayload.root)) !== resolvedArm.toolPayload.hash) {
      throw new Error(`${resolvedArm.definition.arm} staged production payload changed.`);
    }
  }
}

function runtimeEnvironment(resolvedArm: ResolvedRuntimeArm, runDirectory: string): Readonly<NodeJS.ProcessEnv> {
  const environment: NodeJS.ProcessEnv = {
    HOME: '/nonexistent',
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    PATH: '/usr/bin:/bin',
    TMPDIR: '/tmp',
  };
  environment.MATCHED_EVALUATION_ADAPTER_CONFIG = resolvedArm.adapterConfigFile;
  environment.MATCHED_EVALUATION_ADAPTER_EXECUTABLE = resolvedArm.config.adapterExecutable;
  for (const key of resolvedArm.config.environmentKeys) {
    const value = process.env[key];
    if (value !== undefined) environment[key] = value;
  }
  if (resolvedArm.definition.arm === 'reference-scope') {
    Object.assign(environment, matchedEvaluationReferenceEnvironmentPolicyV1(), {
      HOME: resolve(runDirectory, 'reference-home'),
    });
  }
  if (resolvedArm.toolExecutable !== null) environment.MATCHED_EVALUATION_TOOL = resolvedArm.toolExecutable;
  return environment;
}

function parseRuntimeArm(value: unknown, index: number): MatchedEvaluationRuntimeArmV1 {
  const arm = object(value, `runtime arm ${index}`);
  exactKeys(
    arm,
    [
      'adapterArguments',
      'adapterConfigFile',
      'adapterExecutable',
      'arm',
      'environmentKeys',
      'toolExecutable',
      'toolLockFile',
    ],
    `runtime arm ${index}`,
  );
  const environmentKeys = stringArray(arm.environmentKeys, 0, 32, 64, `runtime arm ${index} environment keys`);
  unique(environmentKeys, `runtime arm ${index} environment keys`);
  if (environmentKeys.some(key => !ENVIRONMENT_KEY.test(key) || BLOCKED_ENVIRONMENT_KEYS.has(key))) {
    invalid(`runtime arm ${index} contains a reserved or invalid environment key`);
  }
  return {
    adapterArguments: stringArray(arm.adapterArguments, 0, 64, 4_096, `runtime arm ${index} adapter arguments`),
    adapterConfigFile: absolutePath(arm.adapterConfigFile, `runtime arm ${index} adapter configuration`),
    adapterExecutable: absolutePath(arm.adapterExecutable, `runtime arm ${index} adapter executable`),
    arm: literal(arm.arm, MATCHED_EVALUATION_ARMS, `runtime arm ${index} id`),
    environmentKeys,
    toolExecutable:
      arm.toolExecutable === null ? null : absolutePath(arm.toolExecutable, `runtime arm ${index} tool executable`),
    toolLockFile:
      arm.toolLockFile === null ? null : absolutePath(arm.toolLockFile, `runtime arm ${index} tool lock file`),
  };
}

function parseRuntimeRepository(value: unknown, index: number): MatchedEvaluationRuntimeRepositoryV1 {
  const repository = object(value, `runtime repository ${index}`);
  exactKeys(repository, ['clusterId', 'repositoryDirectory', 'repositoryIdentityHash'], `runtime repository ${index}`);
  return {
    clusterId:
      repository.clusterId === null
        ? null
        : matchingString(repository.clusterId, CLUSTER_ID, `runtime repository ${index} cluster id`),
    repositoryDirectory: absolutePath(repository.repositoryDirectory, `runtime repository ${index} directory`),
    repositoryIdentityHash: matchingString(
      repository.repositoryIdentityHash,
      HASH,
      `runtime repository ${index} identity hash`,
    ),
  };
}

function parseArguments(args: readonly string[]): {
  readonly continuationFinalizeDirectory: string | null;
  readonly continuationPhaseOneDirectory: string | null;
  readonly continuationPhaseOneExpectedSelectionPath: string | null;
  readonly continuationPhaseOneTaskPacketPath: string | null;
  readonly continuationPilotPlanPath: string | null;
  readonly continuationPilotResume: boolean;
  readonly continuationParentPilotDirectory: string | null;
  readonly corpusPath: string;
  readonly manifestPath: string;
  readonly runtimePath: string;
  readonly studyPath: string | null;
  readonly pilotTaskId: string | null;
  readonly pilotDirectory: string | null;
} {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    if (
      ![
        '--continuation-finalize-directory',
        '--continuation-phase-one-directory',
        '--continuation-phase-one-expected-selection',
        '--continuation-phase-one-packet',
        '--continuation-pilot-plan',
        '--continuation-pilot-resume',
        '--continuation-parent-pilot-directory',
        '--corpus',
        '--manifest',
        '--runtime',
        '--study',
        '--pilot-task',
        '--pilot-directory',
      ].includes(option) ||
      values.has(option)
    ) {
      throw ScriptError.make({message: `Unknown or repeated matched evaluation option: ${option}`});
    }
    values.set(option, required(args[++index], option));
  }
  const pilotTaskId = values.get('--pilot-task') ?? null;
  const pilotDirectory = values.get('--pilot-directory') ?? null;
  const continuationFinalizeDirectory = values.get('--continuation-finalize-directory') ?? null;
  const continuationPhaseOneTaskPacket = values.get('--continuation-phase-one-packet') ?? null;
  const continuationPhaseOneDirectory = values.get('--continuation-phase-one-directory') ?? null;
  const continuationPhaseOneExpectedSelection = values.get('--continuation-phase-one-expected-selection') ?? null;
  const continuationPilotPlan = values.get('--continuation-pilot-plan') ?? null;
  const continuationPilotResumeValue = values.get('--continuation-pilot-resume') ?? null;
  if (continuationPilotResumeValue !== null && continuationPilotResumeValue !== 'true') {
    throw ScriptError.make({message: '--continuation-pilot-resume accepts only the literal value true'});
  }
  const continuationPilotResume = continuationPilotResumeValue === 'true';
  const continuationParentPilotDirectory = values.get('--continuation-parent-pilot-directory') ?? null;
  if (
    [
      pilotTaskId !== null,
      continuationPilotPlan !== null,
      continuationPhaseOneTaskPacket !== null,
      continuationFinalizeDirectory !== null,
    ].filter(Boolean).length > 1
  ) {
    throw ScriptError.make({message: 'Matched evaluation pilot selectors are mutually exclusive'});
  }
  if ((pilotTaskId !== null || continuationPilotPlan !== null) !== (pilotDirectory !== null)) {
    throw ScriptError.make({
      message: 'Pilot mode requires exactly one pilot selector together with --pilot-directory',
    });
  }
  if (continuationParentPilotDirectory !== null && continuationPilotPlan === null) {
    throw ScriptError.make({message: '--continuation-parent-pilot-directory requires --continuation-pilot-plan'});
  }
  if (continuationPilotResume && continuationPilotPlan === null) {
    throw ScriptError.make({message: '--continuation-pilot-resume requires --continuation-pilot-plan'});
  }
  if (
    new Set([
      continuationPhaseOneTaskPacket !== null,
      continuationPhaseOneDirectory !== null,
      continuationPhaseOneExpectedSelection !== null,
    ]).size !== 1
  ) {
    throw ScriptError.make({
      message:
        'Continuation Phase 1 requires --continuation-phase-one-packet, --continuation-phase-one-directory, and --continuation-phase-one-expected-selection together',
    });
  }
  if (
    (pilotTaskId !== null ||
      continuationPilotPlan !== null ||
      continuationPhaseOneTaskPacket !== null ||
      continuationFinalizeDirectory !== null) &&
    values.get('--study') === undefined
  )
    throw ScriptError.make({message: 'Pilot mode requires --study'});
  return {
    continuationFinalizeDirectory:
      continuationFinalizeDirectory === null
        ? null
        : absolutePath(continuationFinalizeDirectory, '--continuation-finalize-directory'),
    continuationPhaseOneDirectory:
      continuationPhaseOneDirectory === null
        ? null
        : absolutePath(continuationPhaseOneDirectory, '--continuation-phase-one-directory'),
    continuationPhaseOneExpectedSelectionPath:
      continuationPhaseOneExpectedSelection === null
        ? null
        : absolutePath(continuationPhaseOneExpectedSelection, '--continuation-phase-one-expected-selection'),
    continuationPhaseOneTaskPacketPath:
      continuationPhaseOneTaskPacket === null
        ? null
        : absolutePath(continuationPhaseOneTaskPacket, '--continuation-phase-one-packet'),
    continuationPilotPlanPath:
      continuationPilotPlan === null ? null : absolutePath(continuationPilotPlan, '--continuation-pilot-plan'),
    continuationPilotResume,
    continuationParentPilotDirectory:
      continuationParentPilotDirectory === null
        ? null
        : absolutePath(continuationParentPilotDirectory, '--continuation-parent-pilot-directory'),
    corpusPath: absolutePath(required(values.get('--corpus'), '--corpus'), '--corpus'),
    manifestPath: absolutePath(required(values.get('--manifest'), '--manifest'), '--manifest'),
    runtimePath: absolutePath(required(values.get('--runtime'), '--runtime'), '--runtime'),
    studyPath:
      values.get('--study') === undefined ? null : absolutePath(required(values.get('--study'), '--study'), '--study'),
    pilotTaskId,
    pilotDirectory: pilotDirectory === null ? null : absolutePath(pilotDirectory, '--pilot-directory'),
  };
}

async function assertLocalArtifactDirectory(path: string): Promise<void> {
  if (!path.split(sep).includes('.context')) {
    throw new Error('Runtime artifact directory must be inside a local .context directory.');
  }
  await mkdir(path, {recursive: true, mode: 0o700});
  const canonical = await realpath(path);
  if (canonical !== path) throw new Error('Runtime artifact directory must use its canonical path.');
}

async function canonicalDirectory(path: string, label: string): Promise<string> {
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error(`${label} must be a real directory.`);
  const canonical = await realpath(path);
  if (canonical !== path) throw new Error(`${label} must use its canonical path.`);
  return canonical;
}

async function canonicalRegularFile(path: string, label: string): Promise<string> {
  const canonical = await optionalCanonicalRegularFile(path, false);
  if (canonical === null) throw new Error(`${label} is missing.`);
  return canonical;
}

async function optionalCanonicalRegularFile(path: string, executable: boolean): Promise<string | null> {
  let metadata;
  try {
    metadata = await lstat(path);
  } catch (cause) {
    if (isMissing(cause)) return null;
    throw cause;
  }
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) {
    throw new Error(`${path} must be one regular non-linked file.`);
  }
  if (executable && (metadata.mode & 0o111) === 0) throw new Error(`${path} must be executable.`);
  const canonical = await realpath(path);
  const current = await stat(canonical);
  if (canonical !== path || current.dev !== metadata.dev || current.ino !== metadata.ino) {
    throw new Error(`${path} changed or is not canonical.`);
  }
  return canonical;
}

async function boundedRegularFileHash(path: string, maximumBytes: number, label: string): Promise<string> {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || metadata.size > maximumBytes) {
    throw new Error(`${label} is not one bounded regular file.`);
  }
  return sha256Bytes(await readFile(path));
}

async function optionalBoundedRegularFileHash(
  path: string,
  maximumBytes: number,
  label: string,
): Promise<string | null> {
  try {
    return await boundedRegularFileHash(path, maximumBytes, label);
  } catch (cause) {
    if (isMissing(cause)) return null;
    throw cause;
  }
}

async function readContinuationSupplementV1(
  parentPilotDirectory: string,
  plan: MatchedEvaluationContinuationPilotPlan,
  adapterArtifactSha256: string,
): Promise<MatchedEvaluationContinuationSupplementV1> {
  const canonicalParent = await canonicalDirectory(parentPilotDirectory, 'continuation supplement parent directory');
  const selectionPath = resolve(canonicalParent, 'continuation-pilot-selection.json');
  const reportPath = resolve(canonicalParent, 'continuation-pilot-report.json');
  const [selectionText, reportText] = await Promise.all([
    readRequiredText(selectionPath, MAXIMUM_JSON_BYTES),
    readRequiredText(reportPath, MAXIMUM_JSON_BYTES),
  ]);
  let parentSelection: unknown;
  let parentReport: unknown;
  try {
    parentSelection = JSON.parse(selectionText) as unknown;
    parentReport = JSON.parse(reportText) as unknown;
  } catch (cause) {
    throw new Error('Continuation supplement parent evidence is not valid JSON.', {cause});
  }
  return assertMatchedEvaluationContinuationSupplementV1({
    adapterArtifactSha256,
    parentReport,
    parentReportSha256: sha256Bytes(Buffer.from(reportText)),
    parentSelection,
    parentSelectionSha256: sha256Bytes(Buffer.from(selectionText)),
    plan,
  });
}

async function runtimeAdapterArtifactHashV1(
  runtime: MatchedEvaluationRuntimeV1,
  arm: MatchedEvaluationArm,
): Promise<string> {
  const config = runtime.arms.find(candidate => candidate.arm === arm);
  if (config === undefined) throw new Error(`Continuation supplement has no runtime mapping for ${arm}.`);
  const adapter = await optionalCanonicalRegularFile(config.adapterExecutable, true);
  if (adapter === null) throw new Error(`Continuation supplement ${arm} adapter executable is missing.`);
  return sha256File(adapter);
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(sortJson(left)) === JSON.stringify(sortJson(right));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, entry]) => [key, sortJson(entry)]),
    );
  }
  return value;
}

async function readContinuationFailureAccounting(path: string): Promise<{
  readonly providerUsage: {
    readonly cachedInputTokens: number;
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly reasoningOutputTokens: number;
    readonly totalTokens: number;
  };
  readonly timing: {readonly agentTaskMilliseconds: number; readonly preparationMilliseconds: number};
} | null> {
  const text = await readOptionalTextOrNull(path, MAXIMUM_TRANSCRIPT_BYTES);
  if (text === null) return null;
  let input: unknown;
  try {
    input = JSON.parse(text.trim()) as unknown;
  } catch (cause) {
    throw new Error('Continuation pilot agent checkpoint is not valid JSON.', {cause});
  }
  const checkpoint = object(input, 'continuation pilot agent checkpoint');
  const usage = object(checkpoint.usage, 'continuation pilot agent checkpoint usage');
  const timing = object(checkpoint.timing, 'continuation pilot agent checkpoint timing');
  const providerUsage = {
    cachedInputTokens: boundedNonnegativeInteger(usage.cachedInputTokens, 10_000_000, 'checkpoint cached input tokens'),
    inputTokens: boundedNonnegativeInteger(usage.inputTokens, 10_000_000, 'checkpoint input tokens'),
    outputTokens: boundedNonnegativeInteger(usage.outputTokens, 10_000_000, 'checkpoint output tokens'),
    reasoningOutputTokens: boundedNonnegativeInteger(
      usage.reasoningOutputTokens,
      10_000_000,
      'checkpoint reasoning output tokens',
    ),
    totalTokens: boundedNonnegativeInteger(usage.totalTokens, 10_000_000, 'checkpoint total tokens'),
  };
  if (
    providerUsage.cachedInputTokens > providerUsage.inputTokens ||
    providerUsage.reasoningOutputTokens > providerUsage.outputTokens ||
    providerUsage.totalTokens !== providerUsage.inputTokens + providerUsage.outputTokens
  ) {
    throw new Error('Continuation pilot agent checkpoint token components are inconsistent.');
  }
  return {
    providerUsage,
    timing: {
      agentTaskMilliseconds: boundedNonnegativeInteger(
        timing.agentTaskMilliseconds,
        86_400_000,
        'checkpoint agent task milliseconds',
      ),
      preparationMilliseconds: boundedNonnegativeInteger(
        timing.preparationMilliseconds,
        86_400_000,
        'checkpoint preparation milliseconds',
      ),
    },
  };
}

async function readJson(path: string): Promise<unknown> {
  const text = await readRequiredText(path, MAXIMUM_JSON_BYTES);
  try {
    return JSON.parse(text) as unknown;
  } catch (cause) {
    throw new Error(`${path} is not valid JSON.`, {cause});
  }
}

async function readRequiredText(path: string, maximumBytes: number): Promise<string> {
  const text = await readOptionalTextOrNull(path, maximumBytes);
  if (text === null) throw new Error(`${path} does not exist.`);
  return text;
}

async function readOptionalText(path: string, maximumBytes: number): Promise<string> {
  return (await readOptionalTextOrNull(path, maximumBytes)) ?? '';
}

async function readOptionalTextOrNull(path: string, maximumBytes: number): Promise<string | null> {
  let metadata;
  try {
    metadata = await lstat(path);
  } catch (cause) {
    if (isMissing(cause)) return null;
    throw cause;
  }
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || metadata.size > maximumBytes) {
    throw new Error(`${path} is not one bounded regular file.`);
  }
  const bytes = await readFile(path);
  if (bytes.byteLength !== metadata.size) throw new Error(`${path} changed while it was read.`);
  return new TextDecoder('utf-8', {fatal: true}).decode(bytes);
}

async function atomicWrite(path: string, content: string): Promise<void> {
  const temporary = `${path}.tmp-${process.pid}`;
  await mkdir(resolve(path, '..'), {recursive: true, mode: 0o700});
  try {
    await rm(temporary, {force: true});
    await writeFile(temporary, content, {encoding: 'utf8', flag: 'wx', mode: 0o600});
    await rename(temporary, path);
  } finally {
    await rm(temporary, {force: true});
  }
}

async function sha256File(path: string): Promise<string> {
  return sha256Bytes(await readFile(path));
}

function sha256Bytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function boundedDiagnostic(result: {readonly stderr: string; readonly stdout: string}): string {
  const diagnostic = [result.stderr && `stderr: ${result.stderr}`, result.stdout && `stdout: ${result.stdout}`]
    .filter(Boolean)
    .join('\n');
  return diagnostic.slice(-2_048) || '(no output)';
}

function boundedFailureDiagnostic(cause: unknown): string {
  const diagnostic = cause instanceof Error ? cause.message : 'Unknown continuation verification failure.';
  return diagnostic.slice(-2_048) || 'Continuation verification failed without a diagnostic.';
}

function requiredResolvedArm(
  resolved: ReadonlyMap<MatchedEvaluationArm, ResolvedRuntimeArm>,
  arm: MatchedEvaluationArm,
): ResolvedRuntimeArm {
  const value = resolved.get(arm);
  if (value === undefined) throw new Error(`${arm} runtime was not resolved before execution.`);
  return value;
}

function absolutePath(value: unknown, label: string): string {
  if (typeof value !== 'string' || !isAbsolute(value) || resolve(value) !== value || value.includes('\0')) {
    invalid(`${label} must be a normalized absolute path`);
  }
  return value;
}

function boundedPositiveInteger(value: unknown, minimum: number, maximum: number, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    invalid(`${label} is outside its allowed range`);
  }
  return value;
}

function boundedNonnegativeInteger(value: unknown, maximum: number, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > maximum) {
    invalid(`${label} is outside its allowed range`);
  }
  return value;
}

function boundedString(value: unknown, minimum: number, maximum: number, label: string): string {
  if (typeof value !== 'string' || value.length < minimum || value.length > maximum || value.includes('\0')) {
    invalid(`${label} is invalid`);
  }
  return value;
}

function stringArray(
  value: unknown,
  minimum: number,
  maximum: number,
  maximumLength: number,
  label: string,
): readonly string[] {
  const values = array(value, label);
  if (values.length < minimum || values.length > maximum) invalid(`${label} has invalid bounds`);
  return values.map((entry, index) => {
    if (typeof entry !== 'string' || entry.length === 0 || entry.length > maximumLength || entry.includes('\0')) {
      invalid(`${label} ${index} is invalid`);
    }
    return entry;
  });
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) invalid(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function array(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) invalid(`${label} must be an array`);
  return value;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    invalid(`${label} has unsupported or missing fields`);
  }
}

function matchingString(value: unknown, pattern: RegExp, label: string): string {
  if (typeof value !== 'string' || !pattern.test(value)) invalid(`${label} is invalid`);
  return value;
}

function literal<const Values extends readonly string[]>(
  value: unknown,
  values: Values,
  label: string,
): Values[number] {
  if (typeof value !== 'string' || !(values as readonly string[]).includes(value)) invalid(`${label} is invalid`);
  return value;
}

function unique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) invalid(`${label} must be unique`);
}

function required(value: string | undefined, option: string): string {
  if (!value?.trim()) throw ScriptError.make({message: `${option} requires a value`});
  return value;
}

function isMissing(cause: unknown): boolean {
  return typeof cause === 'object' && cause !== null && 'code' in cause && cause.code === 'ENOENT';
}

function invalid(message: string): never {
  throw new Error(`Invalid matched evaluation runtime: ${message}.`);
}

if (import.meta.main) BunRuntime.runMain(provideScriptLayer(program, ApplicationLayer));
