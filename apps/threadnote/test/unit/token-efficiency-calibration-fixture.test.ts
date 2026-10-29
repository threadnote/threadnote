import {Array as EffectArray} from 'effect';
import {describe, expect, it} from 'vitest';
import fixture from '../evaluation/fixtures/token-efficiency-calibration-v1/fixture.json' with {type: 'json'};
import corpus from '../evaluation/corpora/token-efficiency-historical-v1/corpus.json' with {type: 'json'};
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';
import {Option as EffectOption} from 'effect';

describe('token-efficiency calibration fixture v1', () => {
  it('is a closed, public-corpus-linked, provider-free calibration contract', () => {
    expect(fixture).toMatchObject({id: 'token-efficiency-calibration-v1', version: 1});
    expect(fixture.publicCorpus).toEqual({
      corpusId: corpus.corpusId,
      corpusPath: 'apps/threadnote/test/evaluation/corpora/token-efficiency-historical-v1/corpus.json',
      provenancePath: 'apps/threadnote/test/evaluation/corpora/token-efficiency-historical-v1/provenance.json',
    });

    const ids = [
      ...EffectArray.map(fixture.contextUtilityLabels, label => label.id),
      ...EffectArray.map(fixture.negativeControls, control => control.controlId),
      ...EffectArray.map(fixture.evidenceScenarios, scenario => scenario.id),
      ...EffectArray.map(fixture.memoryNonInterferenceScenarios, scenario => scenario.id),
      ...EffectArray.map(fixture.resumeScenarios, scenario => scenario.id),
    ];
    expect(new Set(ids)).toHaveLength(ids.length);

    const corpusTasks = new Map(EffectArray.map(corpus.tasks, task => [task.taskId, task]));
    for (const label of fixture.contextUtilityLabels) {
      const task = corpusTasks.get(label.taskId);
      expect(task, label.id).toBeDefined();
      expect(fixture.schema.closedEnums.contextUtilityKind).toContain(label.kind);
      expect(
        EffectOption.getOrUndefined(
          EffectOption.map(EffectOption.fromNullishOr(task?.sourceGold), __effectArrayReceiver =>
            EffectArray.some(__effectArrayReceiver, source => source.path === label.required.path),
          ),
        ),
        label.id,
      ).toBe(true);
      expect(label.optionalSupport.length).toBeGreaterThan(0);
      expect(label.requiredInvariantClass).toMatch(/^[a-z][a-z0-9-]+$/u);
      expect(label.distractors.length).toBeGreaterThan(0);
      expect(label.observedOutput).toBe('not-captured');
    }
    expect(EffectArray.map(fixture.contextUtilityLabels, label => label.taskId)).toEqual([
      'tsk_1c391a7896906b29202da55b',
      'tsk_40aa8260ce35eb0588e0d85f',
    ]);

    for (const control of fixture.negativeControls) {
      const task = corpusTasks.get(control.taskId);
      expect(
        EffectOption.getOrUndefined(
          EffectOption.map(EffectOption.fromNullishOr(task?.negativeControls), __effectArrayReceiver =>
            EffectArray.some(__effectArrayReceiver, candidate => candidate.controlId === control.controlId),
          ),
        ),
        control.controlId,
      ).toBe(true);
      expect(fixture.schema.closedEnums.negativeControlPurpose).toContain(control.purpose);
    }
    expect(new Set(EffectArray.map(fixture.negativeControls, control => control.taskId))).toHaveLength(2);

    const labels = new Set(EffectArray.map(fixture.contextUtilityLabels, label => label.id));
    expect(EffectArray.map(fixture.evidenceScenarios, scenario => scenario.state).sort()).toEqual([
      'degraded',
      'no-match',
      'partial',
      'sufficient',
    ]);
    for (const scenario of fixture.evidenceScenarios) {
      expect(fixture.schema.closedEnums.evidenceState).toContain(scenario.state);
      expect(labels).toContain(scenario.requiredLabelId);
      expect(fixture.schema.closedEnums.evidenceDisposition).toContain(scenario.expectedDisposition);
      expect(fixture.schema.closedEnums.observedOutput).toContain(scenario.observedOutput);
    }

    expect(EffectArray.map(fixture.memoryNonInterferenceScenarios, scenario => scenario.memoryState).sort()).toEqual([
      'graph-only',
      'incomplete',
      'irrelevant',
      'stale',
      'useful',
    ]);
    for (const scenario of fixture.memoryNonInterferenceScenarios) {
      expect(fixture.schema.closedEnums.memoryState).toContain(scenario.memoryState);
      expect(labels).toContain(scenario.requiredLabelId);
      expect(fixture.schema.closedEnums.requiredEvidenceAuthority).toContain(
        scenario.expectedRequiredEvidenceAuthority,
      );
    }

    expect(EffectArray.map(fixture.resumeScenarios, scenario => scenario.resumeKind).sort()).toEqual([
      'legacy',
      'no-handoff',
      'structured',
    ]);
    for (const scenario of fixture.resumeScenarios) {
      expect(fixture.schema.closedEnums.resumeKind).toContain(scenario.resumeKind);
      expect(fixture.schema.closedEnums.resumeDisposition).toContain(scenario.expectedDisposition);
    }

    const {budgetTokens, edgeLimit, nodeLimit} = fixture.followUp.arguments;
    const bounds = fixture.schema.followUpBounds;
    expect({budgetTokens, edgeLimit, nodeLimit}).toEqual({budgetTokens: 800, edgeLimit: 12, nodeLimit: 8});
    expect(edgeLimit).toBeGreaterThanOrEqual(bounds.minimumEdgeLimit);
    expect(edgeLimit).toBeLessThanOrEqual(bounds.maximumEdgeLimit);
    expect(nodeLimit).toBeGreaterThanOrEqual(bounds.minimumNodeLimit);
    expect(nodeLimit).toBeLessThanOrEqual(bounds.maximumNodeLimit);
    expect(budgetTokens).toBeGreaterThanOrEqual(bounds.minimumTokenBudget);
    expect(budgetTokens).toBeLessThanOrEqual(bounds.maximumTokenBudget);
  });

  it('seals both privacy-safe retained pilots without a provider or ignored local evidence', () => {
    expect(EffectArray.map(fixture.retainedPilots, pilot => pilot.pilotId)).toEqual([
      'production-5.0.7-attrs-three-arm-v1',
      'production-5.0.7-werkzeug-three-arm-v1',
    ]);
    expect(EffectArray.map(fixture.retainedPilots, pilot => pilot.name)).toEqual([
      'attrs-1606-production-5.0.7-three-arm',
      'werkzeug-3295-production-5.0.7-three-arm',
    ]);
    const rowKeys = new Set<string>();
    for (const pilot of fixture.retainedPilots) {
      expect(fixture.schema.closedEnums.retainedAggregateAvailability).toContain(pilot.availability);
      expect(pilot).toMatchObject({
        availability: 'available',
        comparativeClaimsEligible: false,
        provenance: 'privacy-safe-retained-aggregate-v1',
        unavailableReason: null,
      });
      expect(
        EffectArray.some(corpus.tasks, task => task.taskId === pilot.taskId),
        pilot.pilotId,
      ).toBe(true);
      expect(EffectArray.map(pilot.rows, row => row.arm).sort(), pilot.pilotId).toEqual([
        'files',
        'threadnote-compact',
        'threadnote-graph',
      ]);
      for (const row of pilot.rows) {
        const key = `${pilot.pilotId}:${row.arm}`;
        expect(rowKeys.has(key), key).toBe(false);
        rowKeys.add(key);
        expect(fixture.schema.closedEnums.retainedAggregateArm).toContain(row.arm);
        expect(fixture.schema.closedEnums.retainedVerifierStatus).toContain(row.verifierStatus);
        expect(row.providerTokens.cachedInputTokens).toBeLessThanOrEqual(row.providerTokens.inputTokens);
        expect(row.providerTokens.reasoningOutputTokens).toBeLessThanOrEqual(row.providerTokens.outputTokens);
        expect(row.providerTokens.totalTokens).toBe(row.providerTokens.inputTokens + row.providerTokens.outputTokens);
        expect(row.derivedUsage.uncachedInputTokens).toBe(
          row.providerTokens.inputTokens - row.providerTokens.cachedInputTokens,
        );
        expect(row.derivedUsage).toMatchObject({
          cacheWriteTokens: null,
          newTokens: null,
          processedTokens: null,
          unavailableReason: 'provider-did-not-expose-cache-write-tokens',
        });
      }
    }
    expect(rowKeys).toHaveLength(6);
    expect(fixture.retainedPilots).toMatchObject([
      {
        taskId: 'tsk_1c391a7896906b29202da55b',
        rows: [
          {arm: 'files', completed: false, verifierStatus: 'task-failed', providerTokens: {totalTokens: 193953}},
          {
            arm: 'threadnote-graph',
            completed: false,
            verifierStatus: 'task-failed',
            providerTokens: {totalTokens: 371445},
          },
          {arm: 'threadnote-compact', completed: true, verifierStatus: 'passed', providerTokens: {totalTokens: 288262}},
        ],
      },
      {
        taskId: 'tsk_40aa8260ce35eb0588e0d85f',
        rows: [
          {arm: 'files', completed: true, verifierStatus: 'passed', providerTokens: {totalTokens: 210716}},
          {arm: 'threadnote-graph', completed: true, verifierStatus: 'passed', providerTokens: {totalTokens: 169190}},
          {
            arm: 'threadnote-compact',
            completed: false,
            verifierStatus: 'task-failed',
            providerTokens: {totalTokens: 224287},
          },
        ],
      },
    ]);
  });

  it('contains no absolute paths, managed-memory pointers, or likely secret material', () => {
    const strings = flattenStrings(fixture);
    expect(EffectArray.some(strings, value => Effect.pipe(value, EffectString.startsWith('/')))).toBe(false);
    expect(EffectArray.some(strings, value => Effect.pipe(value, EffectString.includes('threadnote://')))).toBe(false);
    expect(
      EffectArray.some(strings, value =>
        /(?:^|[^a-z0-9])(?:sk-|ghp_|github_pat_|AKIA|-----BEGIN(?: [A-Z]+)? PRIVATE KEY|bearer\s+[A-Za-z0-9._-]+)/iu.test(
          value,
        ),
      ),
    ).toBe(false);
  });
});

function flattenStrings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (EffectArray.isArray(value))
    return EffectArray.flatMap(value, (__effectFlatMapValue, __effectFlatMapIndex) =>
      __effectFlatMapIndex in value ? flattenStrings(__effectFlatMapValue) : [],
    );
  if (value !== null && typeof value === 'object')
    return EffectArray.flatMap(EffectRecord.values(value), flattenStrings);
  return [];
}
