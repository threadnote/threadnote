import {Array as EffectArray, Option as EffectOption} from 'effect';
import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {
  CODE_MEMORY_LINK_AGENT_AB_SCHEDULE_ALGORITHM_VERSION,
  assertCodeMemoryLinkAgentAbTrialLedgerPrefixV1,
  assertCodeMemoryLinkAgentAbRuntimeIdentity,
  codeMemoryLinkAgentAbAssignmentHash,
  codeMemoryLinkAgentAbExternalEvidenceHash,
  codeMemoryLinkAgentAbManifestHash,
  codeMemoryLinkAgentAbTrialReceiptDigest,
  createCodeMemoryLinkAgentAbTrialV1,
  deriveCodeMemoryLinkAgentAbScheduleV1,
  evaluateCodeMemoryLinkAgentAb,
  parseCodeMemoryLinkAgentAbAssignmentV1,
  parseCodeMemoryLinkAgentAbManifestV1,
  parseCodeMemoryLinkAgentAbTrialsJsonl,
  type CodeMemoryLinkAgentAbArm,
  type CodeMemoryLinkAgentAbAssignmentV1,
  type CodeMemoryLinkAgentAbBlindLabel,
  type CodeMemoryLinkAgentAbManifestTaskV1,
  type CodeMemoryLinkAgentAbManifestV1,
  type CodeMemoryLinkAgentAbTrialV1,
} from '@threadnote/threadnote/evaluation/code-memory-link-agent-ab';
import {
  codeMemoryLinkAgentAttemptEventDigest,
  createCodeMemoryLinkAgentAttemptFailedV1,
  createCodeMemoryLinkAgentAttemptStartedV1,
  type CodeMemoryLinkAgentAttemptEventV1,
} from '@threadnote/threadnote/evaluation/code-memory-link-agent-attempts';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

const FIXTURE_HASH = Effect.pipe('a', EffectString.repeat(64));
const APPROVAL_COMMIT = Effect.pipe('a', EffectString.repeat(40));
const LABELS = {X: 'anchored', Y: 'task-only', Z: 'no-memory'} as const;
const CLIENT_IDS = [
  `cli_${Effect.pipe('1', EffectString.repeat(16))}`,
  `cli_${Effect.pipe('2', EffectString.repeat(16))}`,
] as const;
const CONTROL_SCENARIO_FAMILIES = [
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
const CLIENTS = EffectArray.map(CLIENT_IDS, (clientId, index) => ({
  clientId,
  configurationProjectionHash: hash(880 + index),
  environmentPolicyHash: hash(890 + index),
  executionBundleHash: hash(895 + index),
  expectedClient: {
    appServerVersion: '0.149.0-alpha.4.1' as const,
    model: index === 0 ? 'gpt-5.6-luna' : 'gpt-5.6-terra',
    modelProvider: 'openai',
    reasoningEffort: 'medium',
  },
  implementationDescriptorHash: hash(900 + index),
}));
const ASSIGNMENT: CodeMemoryLinkAgentAbAssignmentV1 = {
  assignmentHash: codeMemoryLinkAgentAbAssignmentHash({fixtureHash: FIXTURE_HASH, labels: LABELS, version: 1}),
  fixtureHash: FIXTURE_HASH,
  labels: LABELS,
  version: 1,
};
const MANIFEST = manifestFor(CLIENT_IDS);
const RUNTIME = {
  executableSha256: MANIFEST.candidate.buildIdentityHash,
  sourceCommit: MANIFEST.candidate.commit,
};

describe('Code Memory Link agent A/B evidence', () => {
  it('keeps a complete favorable experiment insufficient until its exact manifest is code-approved', () => {
    const result = evaluateCodeMemoryLinkAgentAb({assignment: ASSIGNMENT, manifest: MANIFEST, trials: releaseTrials()});

    expect(result.gate).toEqual({
      failures: [
        'external evidence hash is not in the code-reviewed release allowlist',
        'manifest hash is not in the code-reviewed release allowlist',
      ],
      insufficiencies: [
        'external evidence hash is not in the code-reviewed release allowlist',
        'manifest hash is not in the code-reviewed release allowlist',
      ],
      qualityFailures: [],
      status: 'insufficient',
    });
    expect(result.evidence).toMatchObject({
      approvedEvidence: false,
      approvedManifest: false,
      distinctClients: 2,
      eligibleExternalTrials: 168,
      excludedMockTrials: 0,
      hiddenTasks: 12,
      manifestApprovalCommit: APPROVAL_COMMIT,
      negativeControlTasks: 16,
      pairedBlocks: 56,
    });
    expect(result.candidate).toEqual(MANIFEST.candidate);
    expect(result.evidence.externalEvidenceHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(result.metrics.adherence).toMatchObject({
      anchoredRate: 1,
      deltaPercentagePoints: 25,
      pairedTrials: 24,
      taskOnlyRate: 0.75,
    });
    expect(result.metrics.adherence.minimumScenarioFamilyDeltaPercentagePoints).toBeGreaterThan(0);
    expect(result.metrics.adherence.scenarioFamilies).toHaveLength(2);
    expect(result.metrics.hiddenTaskPass).toMatchObject({
      anchoredPassRate: 1,
      deltaPercentagePoints: 0,
      minimumScenarioFamilyDeltaPercentagePoints: 0,
      noMemoryPassRate: 1,
      pairedTrials: 24,
      taskOnlyPassRate: 1,
      taskOnlyVsNoMemoryDeltaPercentagePoints: 0,
      taskOnlyVsNoMemoryMinimumScenarioFamilyDeltaPercentagePoints: 0,
    });
    expect(result.metrics.firstUsefulMemoryUse.tokens.reductionPercent).toBe(60);
    expect(result.metrics.firstUsefulMemoryUse.steps.reductionPercent).toBe(60);
    expect(result.metrics.firstUsefulMemoryUse.tokens.minimumScenarioFamilyReductionPercent).toBe(60);
    expect(result.metrics.totalTaskUsage.tokens.reductionPercent).toBeGreaterThan(0);
    expect(result.metrics.negativeControl).toMatchObject({
      anchoredMaximumScenarioFamilyRegressionEventRate: 0,
      anchoredMinimumScenarioFamilyPassRate: 1,
      anchoredRegressionPercentagePoints: 0,
      anchoredRegressionEventRate: 0,
      noMemoryMinimumScenarioFamilyPassRate: 1,
      taskOnlyMaximumScenarioFamilyRegressionEventRate: 0,
      taskOnlyMinimumScenarioFamilyPassRate: 1,
      taskOnlyRegressionPercentagePoints: 0,
      taskOnlyRegressionEventRate: 0,
    });
    expect(result.metrics.perClient).toHaveLength(2);
    expect(result.metrics.staleOrHarmfulAcceptance.anchored).toEqual({acceptedTrials: 0, rate: 0, trials: 56});
  });

  it('uses observed task completion as a conservative censor for no-use observations', () => {
    const trials = EffectArray.map(releaseTrials(), trial =>
      trial.taskKind === 'hidden-constraint' && armFor(trial.blindLabel) === 'task-only'
        ? reseal({...trial, firstUsefulMemoryUse: null})
        : trial,
    );
    const result = evaluateCodeMemoryLinkAgentAb({assignment: ASSIGNMENT, manifest: MANIFEST, trials});

    expect(result.gate.status).toBe('insufficient');
    expect(result.gate.qualityFailures).toEqual([]);
    expect(result.metrics.firstUsefulMemoryUse.steps).toMatchObject({
      taskOnlyCensoredTrials: 24,
      taskOnlyMean: 6,
    });
    expect(result.metrics.firstUsefulMemoryUse.steps.reductionPercent).toBeCloseTo(66.667, 3);
    expect(result.metrics.firstUsefulMemoryUse.tokens).toMatchObject({
      taskOnlyCensoredTrials: 24,
      taskOnlyMean: 600,
    });
    expect(result.metrics.firstUsefulMemoryUse.tokens.reductionPercent).toBeCloseTo(66.667, 3);
  });

  it('keeps mock receipts out of release evidence and derives missing coverage from the manifest roster', () => {
    const trials = EffectArray.map(releaseTrials(), trial => reseal({...trial, evidenceKind: 'mock' as const}));
    const result = evaluateCodeMemoryLinkAgentAb({assignment: ASSIGNMENT, manifest: MANIFEST, trials});

    expect(result.evidence).toMatchObject({eligibleExternalTrials: 0, excludedMockTrials: 168});
    expect(result.gate.status).toBe('insufficient');
    expect(result.gate.qualityFailures).toEqual([]);
    expect(result.gate.insufficiencies).toContain(
      'no external-agent trials; mock receipts cannot support a release claim',
    );
    expect(result.gate.insufficiencies).toContain(
      `manifest paired block ${CLIENT_IDS[0]}/${MANIFEST.tasks[0].taskId} requires exactly one X, Y, and Z external-agent trial`,
    );
  });

  it('requires every rostered client and does not infer a narrower experiment from supplied trials', () => {
    const trials = EffectArray.filter(releaseTrials(), trial => trial.clientId === CLIENT_IDS[0]);
    const result = evaluateCodeMemoryLinkAgentAb({assignment: ASSIGNMENT, manifest: MANIFEST, trials});

    expect(result.evidence.distinctClients).toBe(2);
    expect(result.gate.status).toBe('insufficient');
    expect(result.gate.insufficiencies).toContain(
      `manifest paired block ${CLIENT_IDS[1]}/${MANIFEST.tasks[0].taskId} requires exactly one X, Y, and Z external-agent trial`,
    );
  });

  it('returns failed, not insufficient, for a complete experiment that misses quality gates', () => {
    const degraded = EffectArray.map(releaseTrials(), trial => {
      const arm = armFor(trial.blindLabel);
      if (trial.taskKind === 'negative-control' && arm === 'anchored') {
        return reseal({...trial, taskPassed: false});
      }
      if (trial.taskKind === 'hidden-constraint' && arm === 'anchored') {
        return reseal({
          ...trial,
          acceptedStaleOrHarmful: true,
          constraintAdherence: {satisfied: 0, total: 2},
          firstUsefulMemoryUse: {steps: 8, tokens: 800},
          taskPassed: false,
          totalTaskUsage: {steps: 8, tokens: 850},
        });
      }
      return trial;
    });
    const result = evaluateCodeMemoryLinkAgentAb({assignment: ASSIGNMENT, manifest: MANIFEST, trials: degraded});

    expect(result.gate.status).toBe('failed');
    expect(result.gate.insufficiencies).toEqual([
      'external evidence hash is not in the code-reviewed release allowlist',
      'manifest hash is not in the code-reviewed release allowlist',
    ]);
    expect(result.gate.qualityFailures).toEqual(
      expect.arrayContaining([
        expect.stringContaining('adherence delta'),
        expect.stringContaining('finite-corpus scenario-family'),
        expect.stringContaining('hidden-task pass delta'),
        expect.stringContaining('tokens-to-first-use reduction'),
        expect.stringContaining('steps-to-first-use reduction'),
        expect.stringContaining('negative-control regression'),
        expect.stringContaining('stale/harmful acceptance'),
      ]),
    );
  });

  it('gates hidden-task taskPassed even when constraint adherence remains favorable', () => {
    const trials = EffectArray.map(releaseTrials(), trial =>
      trial.taskKind === 'hidden-constraint' ? reseal({...trial, taskPassed: false}) : trial,
    );
    const result = evaluateCodeMemoryLinkAgentAb({assignment: ASSIGNMENT, manifest: MANIFEST, trials});

    expect(result.metrics.adherence.deltaPercentagePoints).toBe(25);
    expect(result.metrics.hiddenTaskPass).toMatchObject({anchoredPassRate: 0, deltaPercentagePoints: 0});
    expect(result.gate.status).toBe('failed');
    expect(result.gate.qualityFailures).toContain('anchored hidden-task failures 24; required 0');
  });

  it('applies finite-corpus scenario-family floors and per-client non-regression', () => {
    const uncertain = EffectArray.map(releaseTrials(), trial => {
      if (trial.taskKind !== 'hidden-constraint' || armFor(trial.blindLabel) !== 'task-only') return trial;
      const index = taskIndex(trial.taskId);
      const failed = index === 0 || (index === 1 && trial.clientId === CLIENT_IDS[0]);
      return reseal({...trial, constraintAdherence: {satisfied: failed ? 0 : 2, total: 2}});
    });
    const uncertainResult = evaluateCodeMemoryLinkAgentAb({
      assignment: ASSIGNMENT,
      manifest: MANIFEST,
      trials: uncertain,
    });
    expect(uncertainResult.metrics.adherence.deltaPercentagePoints).toBe(12.5);
    expect(uncertainResult.metrics.adherence.minimumScenarioFamilyDeltaPercentagePoints).toBe(0);
    expect(uncertainResult.gate.qualityFailures).toEqual(
      expect.arrayContaining([expect.stringContaining('anchored-only family anchored adherence delta')]),
    );

    const clientRegression = EffectArray.map(releaseTrials(), trial => {
      if (trial.taskKind !== 'hidden-constraint') return trial;
      const arm = armFor(trial.blindLabel);
      const index = taskIndex(trial.taskId);
      if (trial.clientId === CLIENT_IDS[0] && arm === 'anchored') {
        return reseal({...trial, constraintAdherence: {satisfied: index < 6 ? 0 : 2, total: 2}});
      }
      if (trial.clientId === CLIENT_IDS[1] && arm === 'task-only') {
        return reseal({...trial, constraintAdherence: {satisfied: 0, total: 2}});
      }
      return trial;
    });
    const clientResult = evaluateCodeMemoryLinkAgentAb({
      assignment: ASSIGNMENT,
      manifest: MANIFEST,
      trials: clientRegression,
    });
    expect(clientResult.metrics.adherence.deltaPercentagePoints).toBeGreaterThan(10);
    expect(clientResult.gate.qualityFailures).toContain(
      `client ${CLIENT_IDS[0]} anchored adherence regressed against task-only`,
    );
  });

  it('does not present replicated successes as a 95% population bound or let one family carry another', () => {
    const identicalReplicas = EffectArray.map(releaseTrials(), trial =>
      trial.taskKind === 'hidden-constraint' && armFor(trial.blindLabel) === 'task-only'
        ? reseal({...trial, constraintAdherence: {satisfied: 0, total: 2}})
        : trial,
    );
    const identicalResult = evaluateCodeMemoryLinkAgentAb({
      assignment: ASSIGNMENT,
      manifest: MANIFEST,
      trials: identicalReplicas,
    });

    expect(identicalResult.metrics.adherence.deltaPercentagePoints).toBe(100);
    expect(identicalResult.metrics.adherence.minimumScenarioFamilyDeltaPercentagePoints).toBe(100);
    expect(JSON.stringify(identicalResult.metrics)).not.toMatch(/(?:95%|confidence|bound)/iu);

    const oneFamilyOnly = EffectArray.map(releaseTrials(), trial => {
      if (trial.taskKind !== 'hidden-constraint' || armFor(trial.blindLabel) !== 'task-only') return trial;
      const scenarioFamily = EffectOption.getOrUndefined(
        EffectArray.findFirst(MANIFEST.tasks, task => task.taskId === trial.taskId),
      )!.scenarioFamily;
      return reseal({
        ...trial,
        constraintAdherence: {satisfied: scenarioFamily === 'hidden:anchored-only' ? 2 : 0, total: 2},
      });
    });
    const stratifiedResult = evaluateCodeMemoryLinkAgentAb({
      assignment: ASSIGNMENT,
      manifest: MANIFEST,
      trials: oneFamilyOnly,
    });

    expect(stratifiedResult.metrics.adherence.deltaPercentagePoints).toBeGreaterThan(10);
    expect(stratifiedResult.metrics.adherence.minimumScenarioFamilyDeltaPercentagePoints).toBe(0);
    expect(stratifiedResult.gate.qualityFailures).toContain(
      'anchored-only family anchored adherence delta 0.000 pp; minimum 10 pp',
    );
  });

  it('gates task-only usefulness against no-memory globally, by scenario family, and per client', () => {
    const noAdherenceGain = EffectArray.map(releaseTrials(), trial =>
      trial.taskKind === 'hidden-constraint' && armFor(trial.blindLabel) === 'task-only'
        ? reseal({...trial, constraintAdherence: {satisfied: 0, total: 2}})
        : trial,
    );
    const noGainResult = evaluateCodeMemoryLinkAgentAb({
      assignment: ASSIGNMENT,
      manifest: MANIFEST,
      trials: noAdherenceGain,
    });
    expect(noGainResult.gate.qualityFailures).toEqual(
      expect.arrayContaining([
        expect.stringContaining('task-only versus no-memory adherence delta'),
        expect.stringContaining('lexical family task-only adherence delta'),
      ]),
    );

    const passRegression = EffectArray.map(releaseTrials(), trial =>
      trial.taskKind === 'hidden-constraint' && armFor(trial.blindLabel) === 'task-only'
        ? reseal({...trial, taskPassed: false})
        : trial,
    );
    const passResult = evaluateCodeMemoryLinkAgentAb({
      assignment: ASSIGNMENT,
      manifest: MANIFEST,
      trials: passRegression,
    });
    expect(passResult.gate.qualityFailures).toEqual(
      expect.arrayContaining([
        expect.stringContaining('task-only versus no-memory hidden-task pass delta'),
        `client ${CLIENT_IDS[0]} task-only hidden-task pass regressed against no-memory`,
      ]),
    );

    const negativeRegression = EffectArray.map(releaseTrials(), trial =>
      trial.taskKind === 'negative-control' && armFor(trial.blindLabel) === 'task-only'
        ? reseal({...trial, taskPassed: false})
        : trial,
    );
    const negativeResult = evaluateCodeMemoryLinkAgentAb({
      assignment: ASSIGNMENT,
      manifest: MANIFEST,
      trials: negativeRegression,
    });
    expect(negativeResult.gate.qualityFailures).toEqual(
      expect.arrayContaining([
        expect.stringContaining('task-only versus no-memory negative-control regression'),
        `client ${CLIENT_IDS[0]} task-only negative-control pass regressed against no-memory`,
      ]),
    );
  });

  it('fails closed when every arm fails all negative controls', () => {
    const trials = EffectArray.map(releaseTrials(), trial =>
      trial.taskKind === 'negative-control' ? reseal({...trial, taskPassed: false}) : trial,
    );
    const result = evaluateCodeMemoryLinkAgentAb({assignment: ASSIGNMENT, manifest: MANIFEST, trials});

    expect(result.metrics.negativeControl).toMatchObject({
      anchoredPassRate: 0,
      noMemoryPassRate: 0,
      taskOnlyPassRate: 0,
    });
    expect(result.gate.status).toBe('failed');
    expect(result.gate.qualityFailures).toEqual(
      expect.arrayContaining([
        expect.stringContaining('anchored negative-control absolute pass rate'),
        expect.stringContaining('task-only negative-control absolute pass rate'),
        expect.stringContaining('no-memory negative-control absolute pass rate'),
        expect.stringContaining('negative-control minimum finite-corpus scenario-family pass rate'),
      ]),
    );
  });

  it('reports every negative-control scenario family as a finite-corpus safety stratum', () => {
    const result = evaluateCodeMemoryLinkAgentAb({assignment: ASSIGNMENT, manifest: MANIFEST, trials: releaseTrials()});

    expect(result.metrics.negativeControl.scenarioFamilies).toHaveLength(CONTROL_SCENARIO_FAMILIES.length);
    expect(result.metrics.negativeControl.scenarioFamilies).toEqual(
      expect.arrayContaining(
        EffectArray.map(CONTROL_SCENARIO_FAMILIES, scenarioFamily =>
          expect.objectContaining({
            anchoredPassRate: 1,
            anchoredRegressionEventRate: 0,
            noMemoryPassRate: 1,
            scenarioFamily,
            taskOnlyPassRate: 1,
            taskOnlyRegressionEventRate: 0,
          }),
        ),
      ),
    );
  });

  it('makes finite-corpus negative-control family minima monotone as regressions accumulate', () => {
    fc.assert(
      fc.property(fc.integer({min: 0, max: 15}), regressionTasks => {
        const current = evaluateCodeMemoryLinkAgentAb({
          assignment: ASSIGNMENT,
          manifest: MANIFEST,
          trials: trialsWithAnchoredNegativeControlRegressions(regressionTasks),
        }).metrics.negativeControl;
        const next = evaluateCodeMemoryLinkAgentAb({
          assignment: ASSIGNMENT,
          manifest: MANIFEST,
          trials: trialsWithAnchoredNegativeControlRegressions(regressionTasks + 1),
        }).metrics.negativeControl;

        expect(next.anchoredMinimumScenarioFamilyPassRate!).toBeLessThanOrEqual(
          current.anchoredMinimumScenarioFamilyPassRate!,
        );
        expect(next.anchoredMaximumScenarioFamilyRegressionEventRate!).toBeGreaterThanOrEqual(
          current.anchoredMaximumScenarioFamilyRegressionEventRate!,
        );
      }),
      {numRuns: 16},
    );
  });

  it('requires first-use reductions in every scenario family and prevents a pooled gain from hiding a client regression', () => {
    const variable = EffectArray.map(releaseTrials(), trial => {
      if (trial.taskKind !== 'hidden-constraint' || armFor(trial.blindLabel) !== 'anchored') return trial;
      return taskIndex(trial.taskId) < 2
        ? reseal({
            ...trial,
            firstUsefulMemoryUse: {steps: 9, tokens: 900},
            totalTaskUsage: {steps: 10, tokens: 950},
          })
        : trial;
    });
    const variableResult = evaluateCodeMemoryLinkAgentAb({
      assignment: ASSIGNMENT,
      manifest: MANIFEST,
      trials: variable,
    });
    expect(variableResult.metrics.firstUsefulMemoryUse.tokens.reductionPercent).toBeGreaterThan(20);
    expect(variableResult.metrics.firstUsefulMemoryUse.tokens.minimumScenarioFamilyReductionPercent).toBeLessThan(20);
    expect(variableResult.gate.qualityFailures).toEqual(
      expect.arrayContaining([
        expect.stringContaining('tokens-to-first-use minimum finite-corpus scenario-family reduction'),
      ]),
    );

    const pooled = EffectArray.map(releaseTrials(), trial => {
      if (trial.taskKind !== 'hidden-constraint' || armFor(trial.blindLabel) !== 'anchored') return trial;
      return trial.clientId === CLIENT_IDS[0]
        ? reseal({
            ...trial,
            firstUsefulMemoryUse: {steps: 6, tokens: 550},
            totalTaskUsage: {steps: 6, tokens: 600},
          })
        : reseal({...trial, firstUsefulMemoryUse: {steps: 1, tokens: 100}});
    });
    const pooledResult = evaluateCodeMemoryLinkAgentAb({assignment: ASSIGNMENT, manifest: MANIFEST, trials: pooled});
    expect(pooledResult.metrics.firstUsefulMemoryUse.tokens.minimumScenarioFamilyReductionPercent).toBeGreaterThan(20);
    expect(pooledResult.gate.qualityFailures).toEqual(
      expect.arrayContaining([
        `client ${CLIENT_IDS[0]} anchored tokens-to-first-use regressed against task-only`,
        `client ${CLIENT_IDS[0]} anchored steps-to-first-use regressed against task-only`,
      ]),
    );
  });

  it('makes absolute anchored safety failures monotone even when the paired matrix is incomplete', () => {
    const firstAnchored = EffectOption.getOrUndefined(
      EffectArray.findFirst(
        releaseTrials(),
        trial => trial.taskKind === 'hidden-constraint' && armFor(trial.blindLabel) === 'anchored',
      ),
    )!;
    const firstTaskOnly = EffectOption.getOrUndefined(
      EffectArray.findFirst(
        releaseTrials(),
        trial =>
          trial.taskKind === 'hidden-constraint' &&
          trial.taskId !== firstAnchored.taskId &&
          armFor(trial.blindLabel) === 'task-only',
      ),
    )!;
    const trials = EffectArray.map(
      EffectArray.filter(
        releaseTrials(),
        trial =>
          !(
            trial.clientId === firstAnchored.clientId &&
            trial.taskId === firstAnchored.taskId &&
            armFor(trial.blindLabel) === 'task-only'
          ),
      ),
      trial => {
        if (trial.trialId === firstAnchored.trialId) {
          return reseal({...trial, acceptedStaleOrHarmful: true, firstUsefulMemoryUse: null, taskPassed: false});
        }
        return trial.trialId === firstTaskOnly.trialId ? reseal({...trial, acceptedStaleOrHarmful: true}) : trial;
      },
    );
    const result = evaluateCodeMemoryLinkAgentAb({assignment: ASSIGNMENT, manifest: MANIFEST, trials});

    expect(result.gate.status).toBe('failed');
    expect(result.gate.insufficiencies).toEqual(
      expect.arrayContaining([expect.stringContaining('requires exactly one X, Y, and Z')]),
    );
    expect(result.gate.qualityFailures).toEqual(
      expect.arrayContaining([
        'anchored stale/harmful acceptance 1; required 0',
        'anchored hidden-task failures 1; required 0',
        'anchored hidden trials without adjudicated useful memory 1; required 0',
        'task-only stale/harmful acceptance 1; required 0',
      ]),
    );
  });

  it('hashes the canonical external outcome bundle independent of receipt order and sensitive to outcomes', () => {
    const trials = chainedReleaseTrials();
    const canonical = codeMemoryLinkAgentAbExternalEvidenceHash({
      manifestHash: MANIFEST.manifestHash,
      trials,
      version: 1,
    });
    const reversed = codeMemoryLinkAgentAbExternalEvidenceHash({
      manifestHash: MANIFEST.manifestHash,
      trials: [...trials].reverse(),
      version: 1,
    });
    const changed = codeMemoryLinkAgentAbExternalEvidenceHash({
      manifestHash: MANIFEST.manifestHash,
      trials: EffectArray.map(trials, (trial, index) =>
        index === 0 ? reseal({...trial, taskPassed: !trial.taskPassed}) : trial,
      ),
      version: 1,
    });

    expect(reversed).toBe(canonical);
    expect(changed).not.toBe(canonical);
  });

  it('binds the exact attempt journal into evidence and blocks failed or retried experiment runs', () => {
    const trials = chainedReleaseTrials();
    const attempts = attemptEventsForTrials(trials);
    const audited = evaluateCodeMemoryLinkAgentAb({assignment: ASSIGNMENT, attempts, manifest: MANIFEST, trials});
    const legacy = evaluateCodeMemoryLinkAgentAb({assignment: ASSIGNMENT, manifest: MANIFEST, trials});

    expect(audited.evidence.externalEvidenceHash).not.toBe(legacy.evidence.externalEvidenceHash);
    expect(audited.gate.insufficiencies).not.toContain(expect.stringContaining('attempt audit contains'));

    const attrited = evaluateCodeMemoryLinkAgentAb({
      assignment: ASSIGNMENT,
      attempts: attemptEventsForTrials(trials, true),
      manifest: MANIFEST,
      trials,
    });
    expect(attrited.gate.insufficiencies).toContain(
      'attempt audit contains failed, interrupted, or retried runs; a release experiment requires a fresh preregistered manifest',
    );
    expect(attrited.gate.status).toBe('insufficient');
  });

  it('strictly binds opaque roster ids, unique task contracts, assignment, manifest, and JSONL receipts', () => {
    expect(parseCodeMemoryLinkAgentAbAssignmentV1(ASSIGNMENT)).toEqual(ASSIGNMENT);
    expect(parseCodeMemoryLinkAgentAbManifestV1(MANIFEST)).toEqual(MANIFEST);
    const [first, second] = releaseTrials();
    expect(parseCodeMemoryLinkAgentAbTrialsJsonl(`${JSON.stringify(first)}\n${JSON.stringify(second)}\n`)).toEqual([
      first,
      second,
    ]);
    const {attestation: _attestation, previousReceiptDigest, trialId, ...clientSummary} = first;
    expect(() =>
      createCodeMemoryLinkAgentAbTrialV1({
        candidate: MANIFEST.candidate,
        invocationNonce: first.attestation.invocationNonce,
        postRuntime: RUNTIME,
        preRuntime: RUNTIME,
        previousReceiptDigest,
        trial: {...clientSummary, trialId},
        trialId,
      }),
    ).toThrow(/harness-controlled receipt identity/);

    expect(() =>
      parseCodeMemoryLinkAgentAbAssignmentV1({...ASSIGNMENT, labels: {X: 'anchored', Y: 'anchored', Z: 'no-memory'}}),
    ).toThrow(/bijectively/);
    expect(() => parseCodeMemoryLinkAgentAbManifestV1({...MANIFEST, clients: [CLIENTS[0], CLIENTS[0]]})).toThrow(
      /client ids must be unique/,
    );
    expect(() =>
      codeMemoryLinkAgentAbManifestHash({
        ...MANIFEST,
        clients: [CLIENTS[0], {...CLIENTS[1], implementationDescriptorHash: CLIENTS[0].implementationDescriptorHash}],
        version: 1,
      }),
    ).toThrow(/implementation descriptor hashes must be unique/);
    expect(() =>
      parseCodeMemoryLinkAgentAbManifestV1({...MANIFEST, candidate: {...MANIFEST.candidate, dirty: true}}),
    ).toThrow(/clean build/);
    expect(() =>
      parseCodeMemoryLinkAgentAbManifestV1({
        ...MANIFEST,
        tasks: [MANIFEST.tasks[0], {...MANIFEST.tasks[1], packetHash: MANIFEST.tasks[0].packetHash}],
      }),
    ).toThrow(/packet hashes must be unique/);
    const reassignedFamilies = EffectArray.map(MANIFEST.tasks, (task, index) =>
      index === 0 ? {...task, scenarioFamily: 'hidden:anchored-only' as const} : task,
    );
    expect(codeMemoryLinkAgentAbManifestHash({...MANIFEST, tasks: reassignedFamilies, version: 1})).not.toBe(
      MANIFEST.manifestHash,
    );
    expect(() =>
      codeMemoryLinkAgentAbManifestHash({
        ...MANIFEST,
        tasks: EffectArray.map(MANIFEST.tasks, (task, index) =>
          index === 0 ? {...task, scenarioFamily: 'control:no-backlink' as const} : task,
        ),
        version: 1,
      }),
    ).toThrow(/hidden scenario family/);
    expect(() => parseCodeMemoryLinkAgentAbManifestV1({...MANIFEST, suiteHash: hash(705)})).toThrow(
      /manifest hash does not match/,
    );
    expect(() =>
      evaluateCodeMemoryLinkAgentAb({
        assignment: ASSIGNMENT,
        manifest: MANIFEST,
        trials: [reseal({...first, clientId: `cli_${Effect.pipe('f', EffectString.repeat(16))}`})],
      }),
    ).toThrow(/outside the manifest roster/);
    expect(() =>
      evaluateCodeMemoryLinkAgentAb({
        assignment: ASSIGNMENT,
        manifest: MANIFEST,
        trials: [reseal({...first, packetHash: Effect.pipe('f', EffectString.repeat(64))})],
      }),
    ).toThrow(/task contract does not match/);
    expect(() =>
      evaluateCodeMemoryLinkAgentAb({
        assignment: ASSIGNMENT,
        manifest: MANIFEST,
        trials: [reseal({...first, runNonce: `run_${Effect.pipe('f', EffectString.repeat(16))}`})],
      }),
    ).toThrow(/preregistered run position and nonce/);
    expect(() =>
      parseCodeMemoryLinkAgentAbTrialsJsonl(JSON.stringify({...first, transcript: 'raw agent text'})),
    ).toThrow(/unsupported or missing fields/);
  });

  it('binds a protocol-v2 harness commit without invalidating legacy manifests', () => {
    const {manifestHash: _legacyHash, ...legacyInput} = MANIFEST;
    const input = {...legacyInput, harnessGovernanceCommit: Effect.pipe('d', EffectString.repeat(40))};
    const protocolV2 = {...input, manifestHash: codeMemoryLinkAgentAbManifestHash(input)};

    expect(parseCodeMemoryLinkAgentAbManifestV1(protocolV2)).toEqual(protocolV2);
    expect(parseCodeMemoryLinkAgentAbManifestV1(MANIFEST)).toEqual(MANIFEST);
    expect(() =>
      parseCodeMemoryLinkAgentAbManifestV1({
        ...protocolV2,
        harnessGovernanceCommit: Effect.pipe('e', EffectString.repeat(40)),
      }),
    ).toThrow(/manifest hash does not match/u);
  });

  it('binds the reviewed protocol, provider usage, common budgets, and counterbalanced run order', () => {
    const [first] = releaseTrials();
    const clientReported = EffectArray.map(releaseTrials(), (trial, index) =>
      index === 0 ? reseal({...trial, tokenAccounting: 'client-reported' as const}) : trial,
    );
    const accounting = evaluateCodeMemoryLinkAgentAb({
      assignment: ASSIGNMENT,
      manifest: MANIFEST,
      trials: clientReported,
    });
    expect(accounting.gate.insufficiencies).toContain(
      'provider-reported token accounting is required for every external-agent trial',
    );
    const mixedApprovals = evaluateCodeMemoryLinkAgentAb({
      assignment: ASSIGNMENT,
      manifest: MANIFEST,
      trials: EffectArray.map(releaseTrials(), (trial, index) =>
        index === 0 ? reseal({...trial, approvalCommit: Effect.pipe('f', EffectString.repeat(40))}) : trial,
      ),
    });
    expect(mixedApprovals.gate.insufficiencies).toContain(
      'external-agent trials must share one preregistered manifest approval commit',
    );
    expect(() =>
      parseCodeMemoryLinkAgentAbTrialsJsonl(
        JSON.stringify({...first, totalTaskUsage: {steps: 1, tokens: first.budget.tokens + 1}}),
      ),
    ).toThrow(/total task usage exceeds/);
    expect(() =>
      parseCodeMemoryLinkAgentAbTrialsJsonl(
        JSON.stringify({
          ...first,
          firstUsefulMemoryUse: {
            steps: first.totalTaskUsage.steps,
            tokens: first.totalTaskUsage.tokens + 1,
          },
        }),
      ),
    ).toThrow(/first useful memory use exceeds observed total task usage/);

    const unevenTasks = EffectArray.map(MANIFEST.tasks, (task, index) =>
      index === 1 ? {...task, budget: {steps: task.budget.steps, tokens: task.budget.tokens + 1}} : task,
    );
    expect(() => codeMemoryLinkAgentAbManifestHash({...MANIFEST, tasks: unevenTasks, version: 1})).toThrow(
      /share one token and step budget/,
    );

    const nextArmPosition = (position: 1 | 2 | 3): 1 | 2 | 3 => {
      switch (position) {
        case 1:
          return 2;
        case 2:
          return 3;
        case 3:
          return 1;
      }
    };
    const chronologicallyMisbound = EffectArray.map(MANIFEST.schedule, entry => ({
      ...entry,
      armPosition: nextArmPosition(entry.armPosition),
    }));
    expect(() =>
      codeMemoryLinkAgentAbManifestHash({...MANIFEST, schedule: chronologicallyMisbound, version: 1}),
    ).toThrow(/chronological order must match arm positions/);

    const unbalancedSchedule = EffectArray.map(MANIFEST.schedule, entry => {
      const armPosition = ({X: 1, Y: 2, Z: 3} as const)[entry.blindLabel];
      const clientIndex = EffectOption.getOrElse(
        EffectArray.findFirstIndex(MANIFEST.clients, client => client.clientId === entry.clientId),
        () => -1,
      );
      const taskIndex_ = EffectOption.getOrElse(
        EffectArray.findFirstIndex(MANIFEST.tasks, task => task.taskId === entry.taskId),
        () => -1,
      );
      return {
        ...entry,
        armPosition,
        runOrder: clientIndex * MANIFEST.tasks.length * 3 + taskIndex_ * 3 + armPosition - 1,
      };
    }).sort((left, right) => left.runOrder - right.runOrder);
    expect(() => codeMemoryLinkAgentAbManifestHash({...MANIFEST, schedule: unbalancedSchedule, version: 1})).toThrow(
      /not counterbalanced/,
    );
    expect(() => codeMemoryLinkAgentAbManifestHash({...MANIFEST, scheduleSeed: hash(9_999), version: 1})).toThrow(
      /frozen seeded derivation/,
    );
    expect(() => parseCodeMemoryLinkAgentAbManifestV1({...MANIFEST, scheduleAlgorithmVersion: 'manual-v0'})).toThrow(
      /schedule algorithm/,
    );
  });

  it('binds release evidence to the exact verified managed executable identity', () => {
    expect(() =>
      assertCodeMemoryLinkAgentAbRuntimeIdentity(MANIFEST.candidate, {
        executableSha256: MANIFEST.candidate.buildIdentityHash,
        sourceCommit: MANIFEST.candidate.commit,
      }),
    ).not.toThrow();
    expect(() =>
      assertCodeMemoryLinkAgentAbRuntimeIdentity(MANIFEST.candidate, {
        executableSha256: hash(123_456),
        sourceCommit: MANIFEST.candidate.commit,
      }),
    ).toThrow(/exact verified managed runtime/);
  });

  it('rejects tampered, another-runtime, and replayed harness receipts', () => {
    const [first, second] = releaseTrials();
    expect(() =>
      evaluateCodeMemoryLinkAgentAb({
        assignment: ASSIGNMENT,
        manifest: MANIFEST,
        trials: [{...first, taskPassed: !first.taskPassed}],
      }),
    ).toThrow(/output digest|summary digest/);

    const {attestation: _attestation, previousReceiptDigest, trialId, ...summary} = first;
    const otherCandidate = {
      buildIdentityHash: hash(999_001),
      commit: Effect.pipe('f', EffectString.repeat(40)),
      dirty: false as const,
    };
    const otherRuntime = {
      executableSha256: otherCandidate.buildIdentityHash,
      sourceCommit: otherCandidate.commit,
    };
    const otherRuntimeTrial = createCodeMemoryLinkAgentAbTrialV1({
      candidate: otherCandidate,
      invocationNonce: first.attestation.invocationNonce,
      postRuntime: otherRuntime,
      preRuntime: otherRuntime,
      previousReceiptDigest,
      trial: summary,
      trialId,
    });
    expect(() =>
      evaluateCodeMemoryLinkAgentAb({assignment: ASSIGNMENT, manifest: MANIFEST, trials: [otherRuntimeTrial]}),
    ).toThrow(/exact verified managed runtime/);

    expect(() =>
      evaluateCodeMemoryLinkAgentAb({
        assignment: ASSIGNMENT,
        manifest: MANIFEST,
        trials: [first, {...second, attestation: first.attestation}],
      }),
    ).toThrow(/invocation digest|replayed harness receipts/);

    expect(() =>
      evaluateCodeMemoryLinkAgentAb({
        assignment: ASSIGNMENT,
        manifest: MANIFEST,
        trials: [
          {
            ...first,
            attestation: {...first.attestation, outputDigest: hash(555_555)},
          },
        ],
      }),
    ).toThrow(/retained privacy-safe projection/);
    expect(() =>
      evaluateCodeMemoryLinkAgentAb({
        assignment: ASSIGNMENT,
        manifest: MANIFEST,
        trials: [
          {
            ...first,
            attestation: {...first.attestation, harnessCommit: Effect.pipe('f', EffectString.repeat(40))},
          },
        ],
      }),
    ).toThrow(/reviewed runner checkout/);
  });

  it('requires an append-only receipt chain in exact preregistered run order', () => {
    const trials = chainedReleaseTrials();
    expect(() =>
      assertCodeMemoryLinkAgentAbTrialLedgerPrefixV1({assignment: ASSIGNMENT, manifest: MANIFEST, trials}),
    ).not.toThrow();

    const reordered = [...trials];
    [reordered[0], reordered[1]] = [reordered[1], reordered[0]];
    expect(() =>
      assertCodeMemoryLinkAgentAbTrialLedgerPrefixV1({assignment: ASSIGNMENT, manifest: MANIFEST, trials: reordered}),
    ).toThrow(/next frozen schedule receipt/);

    const broken = [...trials];
    broken[1] = reseal(broken[1], hash(444_444));
    expect(() =>
      assertCodeMemoryLinkAgentAbTrialLedgerPrefixV1({assignment: ASSIGNMENT, manifest: MANIFEST, trials: broken}),
    ).toThrow(/extend the previous receipt digest/);
  });

  it('rejects replayed provider-usage and adjudication receipts', () => {
    const [first, second, ...remaining] = releaseTrials();
    expect(() =>
      evaluateCodeMemoryLinkAgentAb({
        assignment: ASSIGNMENT,
        manifest: MANIFEST,
        trials: [first, reseal({...second, providerUsageHash: first.providerUsageHash}), ...remaining],
      }),
    ).toThrow(/provider usage hashes must be unique/);
    expect(() =>
      evaluateCodeMemoryLinkAgentAb({
        assignment: ASSIGNMENT,
        manifest: MANIFEST,
        trials: [first, reseal({...second, adjudicationHash: first.adjudicationHash}), ...remaining],
      }),
    ).toThrow(/adjudication hashes must be unique/);
  });

  it('derives a deterministic, task-kind-stratified counterbalanced schedule', () => {
    fc.assert(
      fc.property(fc.nat({max: 10_000}), seed => {
        const input = {
          clients: MANIFEST.clients,
          scheduleAlgorithmVersion: CODE_MEMORY_LINK_AGENT_AB_SCHEDULE_ALGORITHM_VERSION,
          scheduleSeed: hash(seed),
          tasks: MANIFEST.tasks,
        } as const;
        const schedule = deriveCodeMemoryLinkAgentAbScheduleV1(input);
        expect(deriveCodeMemoryLinkAgentAbScheduleV1(input)).toEqual(schedule);
        expect(EffectArray.map(schedule, entry => entry.runOrder)).toEqual(
          EffectArray.map(schedule, (_, index) => index),
        );
        for (const {clientId} of MANIFEST.clients) {
          for (const taskKind of ['hidden-constraint', 'negative-control'] as const) {
            const taskIds = new Set(
              EffectArray.map(
                EffectArray.filter(MANIFEST.tasks, task => task.taskKind === taskKind),
                task => task.taskId,
              ),
            );
            for (const blindLabel of ['X', 'Y', 'Z'] as const) {
              const counts = EffectArray.map(
                [1, 2, 3],
                armPosition =>
                  EffectArray.filter(
                    schedule,
                    (entry, __effectArrayIndex) =>
                      __effectArrayIndex in schedule &&
                      entry.clientId === clientId &&
                      taskIds.has(entry.taskId) &&
                      entry.blindLabel === blindLabel &&
                      entry.armPosition === armPosition,
                  ).length,
              );
              expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(1);
            }
          }
        }
      }),
      {numRuns: 25},
    );
  });

  it('is invariant to imported JSONL receipt order', () => {
    const trials = releaseTrials();
    const expected = evaluateCodeMemoryLinkAgentAb({assignment: ASSIGNMENT, manifest: MANIFEST, trials});
    fc.assert(
      fc.property(fc.nat({max: trials.length - 1}), fc.boolean(), (offset, reverse) => {
        const rotated = [...trials.slice(offset), ...trials.slice(0, offset)];
        const reordered = reverse ? rotated.reverse() : rotated;
        expect(evaluateCodeMemoryLinkAgentAb({assignment: ASSIGNMENT, manifest: MANIFEST, trials: reordered})).toEqual(
          expected,
        );
      }),
      {numRuns: 25},
    );
  });
});

function manifestFor(clientIds: readonly string[]): CodeMemoryLinkAgentAbManifestV1 {
  const tasks = [
    ...Array.from({length: 12}, (_, index) => manifestTask(index, 'hidden-constraint')),
    ...Array.from({length: 16}, (_, index) => manifestTask(index + 12, 'negative-control')),
  ];
  const clients = EffectArray.map(clientIds, clientId =>
    EffectOption.getOrUndefined(EffectArray.findFirst(CLIENTS, client => client.clientId === clientId))!,
  );
  const scheduleSeed = hash(702);
  const schedule = deriveCodeMemoryLinkAgentAbScheduleV1({
    clients,
    scheduleAlgorithmVersion: CODE_MEMORY_LINK_AGENT_AB_SCHEDULE_ALGORITHM_VERSION,
    scheduleSeed,
    tasks,
  });
  const input = {
    adjudicationArtifactHash: hash(703),
    assignmentHash: ASSIGNMENT.assignmentHash,
    candidate: {buildIdentityHash: hash(700), commit: Effect.pipe('c', EffectString.repeat(40)), dirty: false as const},
    clients,
    evaluatorVersion: `ver_${Effect.pipe('e', EffectString.repeat(16))}`,
    experimentId: `exp_${Effect.pipe('0', EffectString.repeat(16))}`,
    fixtureHash: FIXTURE_HASH,
    judgeVersion: `ver_${Effect.pipe('d', EffectString.repeat(16))}`,
    schedule,
    scheduleAlgorithmVersion: CODE_MEMORY_LINK_AGENT_AB_SCHEDULE_ALGORITHM_VERSION,
    scheduleSeed,
    suiteHash: hash(704),
    tasks,
    version: 1 as const,
  };
  return {...input, manifestHash: codeMemoryLinkAgentAbManifestHash(input)};
}

function manifestTask(
  index: number,
  taskKind: CodeMemoryLinkAgentAbManifestTaskV1['taskKind'],
): CodeMemoryLinkAgentAbManifestTaskV1 {
  return {
    budget: {steps: 10, tokens: 1_000},
    constraintTotal: taskKind === 'hidden-constraint' ? 2 : 0,
    expectedResponseHashes: {
      anchored: hash(1_000 + index * 3),
      noMemory: hash(1_001 + index * 3),
      taskOnly: hash(1_002 + index * 3),
    },
    packetHash: hash(index + 1),
    rubricHash: hash(index + 101),
    scenarioFamily:
      taskKind === 'hidden-constraint'
        ? index < 5
          ? 'hidden:lexical'
          : 'hidden:anchored-only'
        : CONTROL_SCENARIO_FAMILIES[(index - 12) % CONTROL_SCENARIO_FAMILIES.length],
    taskId: opaqueId('tsk', index),
    taskKind,
  };
}

function releaseTrials(): readonly CodeMemoryLinkAgentAbTrialV1[] {
  return EffectArray.flatMap(CLIENT_IDS, (clientId, clientIndex) =>
    EffectArray.flatMap(MANIFEST.tasks, (task, taskIndex_) =>
      EffectArray.map(
        EffectRecord.toEntries(LABELS) as readonly [CodeMemoryLinkAgentAbBlindLabel, CodeMemoryLinkAgentAbArm][],
        ([blindLabel, arm], labelIndex) => {
          const scheduled = EffectOption.getOrUndefined(
            EffectArray.findFirst(
              MANIFEST.schedule,
              entry => entry.clientId === clientId && entry.taskId === task.taskId && entry.blindLabel === blindLabel,
            ),
          )!;
          return trial(clientId, clientIndex, task, taskIndex_, blindLabel, arm, labelIndex, scheduled);
        },
      ),
    ),
  );
}

function chainedReleaseTrials(): readonly CodeMemoryLinkAgentAbTrialV1[] {
  const chained: CodeMemoryLinkAgentAbTrialV1[] = [];
  for (const trial of [...releaseTrials()].sort((left, right) => left.runOrder - right.runOrder)) {
    const previousReceiptDigest =
      chained.length === 0 ? null : codeMemoryLinkAgentAbTrialReceiptDigest(chained[chained.length - 1]);
    chained.push(reseal(trial, previousReceiptDigest));
  }
  return chained;
}

function trialsWithAnchoredNegativeControlRegressions(taskCount: number): readonly CodeMemoryLinkAgentAbTrialV1[] {
  const regressedTaskIds = new Set(
    EffectArray.map(
      EffectArray.filter(MANIFEST.tasks, task => task.taskKind === 'negative-control').slice(0, taskCount),
      task => task.taskId,
    ),
  );
  return EffectArray.map(releaseTrials(), trial =>
    regressedTaskIds.has(trial.taskId) && armFor(trial.blindLabel) === 'anchored'
      ? reseal({...trial, taskPassed: false})
      : trial,
  );
}

function trial(
  clientId: string,
  clientIndex: number,
  task: CodeMemoryLinkAgentAbManifestTaskV1,
  taskIndex_: number,
  blindLabel: CodeMemoryLinkAgentAbBlindLabel,
  arm: CodeMemoryLinkAgentAbArm,
  labelIndex: number,
  scheduled: CodeMemoryLinkAgentAbManifestV1['schedule'][number],
): CodeMemoryLinkAgentAbTrialV1 {
  const hidden = task.taskKind === 'hidden-constraint';
  const satisfied = !hidden ? 0 : arm === 'anchored' || (arm === 'task-only' && taskIndex_ % 4 !== 0) ? 2 : 0;
  const trialId = opaqueId('trl', clientIndex * 100 + taskIndex_ * 3 + labelIndex);
  const summary = {
    acceptedStaleOrHarmful: false,
    adjudicationHash: hash(20_000 + scheduled.runOrder),
    approvalCommit: APPROVAL_COMMIT,
    armPosition: scheduled.armPosition,
    assignmentHash: ASSIGNMENT.assignmentHash,
    blindLabel,
    budget: task.budget,
    clientId,
    constraintAdherence: {satisfied, total: task.constraintTotal},
    evidenceKind: 'external-agent',
    firstUsefulMemoryUse:
      hidden && arm !== 'no-memory' ? (arm === 'anchored' ? {steps: 2, tokens: 200} : {steps: 5, tokens: 500}) : null,
    fixtureHash: FIXTURE_HASH,
    manifestHash: MANIFEST.manifestHash,
    packetHash: task.packetHash,
    providerUsageHash: hash(30_000 + scheduled.runOrder),
    rubricHash: task.rubricHash,
    runNonce: scheduled.runNonce,
    runOrder: scheduled.runOrder,
    taskId: task.taskId,
    taskKind: task.taskKind,
    taskPassed: true,
    tokenAccounting: 'provider-reported',
    totalTaskUsage:
      hidden && arm === 'task-only'
        ? {steps: 6, tokens: 600}
        : hidden && arm === 'no-memory'
          ? {steps: 9, tokens: 900}
          : hidden
            ? {steps: 5, tokens: 500}
            : {steps: 4, tokens: 400},
    version: 1,
  } as const;
  return createCodeMemoryLinkAgentAbTrialV1({
    candidate: MANIFEST.candidate,
    invocationNonce: opaqueId('inv', scheduled.runOrder),
    postRuntime: RUNTIME,
    preRuntime: RUNTIME,
    previousReceiptDigest: null,
    trial: summary,
    trialId,
  });
}

function reseal(
  input: CodeMemoryLinkAgentAbTrialV1,
  chainDigest: string | null = input.previousReceiptDigest,
): CodeMemoryLinkAgentAbTrialV1 {
  const {attestation, previousReceiptDigest: _previousReceiptDigest, trialId, ...summary} = input;
  return createCodeMemoryLinkAgentAbTrialV1({
    candidate: MANIFEST.candidate,
    invocationNonce: attestation.invocationNonce,
    postRuntime: RUNTIME,
    preRuntime: RUNTIME,
    previousReceiptDigest: chainDigest,
    trial: summary,
    trialId,
  });
}

function attemptEventsForTrials(
  trials: readonly CodeMemoryLinkAgentAbTrialV1[],
  failFirst = false,
): readonly CodeMemoryLinkAgentAttemptEventV1[] {
  const events: CodeMemoryLinkAgentAttemptEventV1[] = [];
  let retryOfAttemptId: string | null = null;
  let retryReason: 'client-execution' | null = null;
  if (failFirst) {
    const trial = trials[0];
    const failedStart = attemptStart(
      trial,
      'attempt_deadbeefdeadbeefdeadbeefdeadbeef',
      null,
      null,
      null,
      'inv_deadbeefdeadbeef',
    );
    events.push(failedStart);
    const failed = createCodeMemoryLinkAgentAttemptFailedV1({
      attemptId: failedStart.attemptId,
      failureKind: 'client-execution',
      previousEventDigest: codeMemoryLinkAgentAttemptEventDigest(failedStart),
    });
    events.push(failed);
    retryOfAttemptId = failedStart.attemptId;
    retryReason = 'client-execution';
  }
  for (const [index, trial] of trials.entries()) {
    const previousEventDigest =
      events.length === 0 ? null : codeMemoryLinkAgentAttemptEventDigest(events[events.length - 1]);
    const started = attemptStart(
      trial,
      `attempt_${Effect.pipe(index.toString(16), EffectString.padStart(32, '0'))}`,
      previousEventDigest,
      index === 0 ? retryOfAttemptId : null,
      index === 0 ? retryReason : null,
    );
    events.push(started);
  }
  return events;
}

function attemptStart(
  trial: CodeMemoryLinkAgentAbTrialV1,
  attemptId: string,
  previousEventDigest: string | null,
  retryOfAttemptId: string | null,
  retryReason: 'client-execution' | null,
  invocationNonce = trial.attestation.invocationNonce,
) {
  return createCodeMemoryLinkAgentAttemptStartedV1({
    approvalCommit: trial.approvalCommit,
    assignmentHash: trial.assignmentHash,
    attemptId,
    blindLabel: trial.blindLabel,
    clientDescriptorHash: EffectOption.getOrUndefined(
      EffectArray.findFirst(MANIFEST.clients, client => client.clientId === trial.clientId),
    )!.implementationDescriptorHash,
    clientId: trial.clientId,
    invocationNonce,
    manifestHash: trial.manifestHash,
    previousEventDigest,
    retryOfAttemptId,
    retryReason,
    runBindingHash: hash(40_000 + trial.runOrder),
    runNonce: trial.runNonce,
    runOrder: trial.runOrder,
    taskId: trial.taskId,
  });
}

function armFor(label: CodeMemoryLinkAgentAbBlindLabel): CodeMemoryLinkAgentAbArm {
  return LABELS[label];
}

function taskIndex(taskId: string): number {
  return Number.parseInt(Effect.pipe(taskId, EffectString.slice(-16)), 16);
}

function opaqueId(prefix: 'inv' | 'run' | 'trl' | 'tsk', value: number): string {
  return `${prefix}_${Effect.pipe(value.toString(16), EffectString.padStart(16, '0'))}`;
}

function hash(value: number): string {
  return Effect.pipe(value.toString(16), EffectString.padStart(64, '0'));
}
