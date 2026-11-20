import * as Schema from 'effect/Schema';
import * as EffectString from 'effect/String';
import {it as effectIt} from '@effect/vitest';
import {Effect} from 'effect';
import {TestClock} from 'effect/testing';
import {expect} from 'vitest';
import {runCommandEffect} from '@threadnote/platform/command';
import {decodeNativeAuthoringDocument} from '@threadnote/workflow-automations/authoring';
import {nativeFixture, provideNative} from './native-automation-fixture.js';
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object') throw new Error('Expected object response.');
  return Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown))(value);
};
const common = {
  format: 'threadnote-native-authoring',
  schemaVersion: 1,
  id: 'feature',
  project: 'fixture',
  title: 'Approved specification amendment fixture',
  objective: 'Support the selected languages.',
  context: {codeRefs: [], evidenceRefs: [], note: 'Isolated source-free protocol fixture.'},
  source: null,
  sourceFreeReason: 'Exercise native approval and reconciliation using a private synthetic project.',
  review: {required: false, reason: 'Synthetic fixture with independently asserted protocol outcomes.'},
};
effectIt.effect('admits a verified approved spec revision without replacing cycle identity or its baseline', () =>
  Effect.gen(function* () {
    const f = yield* nativeFixture();
    const git = (args: readonly string[]) => runCommandEffect('git', ['-C', f.repo, ...args]);
    yield* git(['config', 'user.name', 'Private fixture']);
    yield* git(['config', 'user.email', 'fixture@example.invalid']);
    yield* git(['add', 'source.ts']);
    yield* git(['commit', '-m', 'Private baseline']);
    yield* git(['checkout', '-b', 'feature/amendment']);
    yield* f.init();
    const authoring = (command: string, fields: Record<string, unknown>) =>
      f.call({...f.base('authoring'), command, ...fields}).pipe(Effect.map(value => object(object(value).authoring)));
    const cycle = (command: string, fields: Record<string, unknown> = {}) =>
      f.call({...f.base('cycle'), command, ...fields}).pipe(Effect.map(value => object(object(value).cycle)));
    const mutate = (command: string, fields: Record<string, unknown>) =>
      Effect.gen(function* () {
        const inspected = yield* cycle('inspect');
        return yield* cycle(command, {expectedRevision: inspected.revision, ...fields});
      });
    let specRevision: unknown = null;
    let planRevision: unknown = null;
    const savePlan = (languages: string) =>
      Effect.gen(function* () {
        const spec = decodeNativeAuthoringDocument({
          ...common,
          kind: 'spec',
          requirements: [{id: 'languages', behavior: `Support ${languages}.`}],
          actors: ['developer'],
          inScope: [languages],
          outOfScope: [],
          constraints: ['Preserve existing source.'],
          observations: [],
          scenarios: [
            {
              id: 'selected',
              requirementIds: ['languages'],
              given: 'A selected language project.',
              when: 'Analysis is requested.',
              then: 'The selected language is supported.',
            },
          ],
          assumptions: [],
          questions: [],
          artifacts: [],
        });
        const confirmation = yield* authoring('confirm', {
          document: spec,
          userDecision: 'approve',
          userResponse: `Approve ${languages} for this fixture.`,
        });
        const savedSpec = yield* authoring('save', {
          document: spec,
          expectedRevision: specRevision,
          ready: true,
          confirmation: confirmation.confirmation,
        });
        expect(savedSpec.readiness).toBe('ready');
        specRevision = object(savedSpec.root).revision;
        const packet = yield* authoring('export-plan', {uri: object(savedSpec.root).uri});
        const plan = decodeNativeAuthoringDocument({
          ...common,
          kind: 'plan',
          requirements: spec.requirements,
          spec: packet.spec,
          current: {
            summary: 'Analysis is pending.',
            components: ['Project'],
            contracts: [],
            diagram: 'flowchart TD\n  Project --> Pending',
          },
          target: {
            summary: 'Selected analysis works.',
            components: ['Project', 'Analysis'],
            contracts: ['Only selected languages.'],
            diagram: 'flowchart TD\n  Project --> Analysis',
          },
          phases: [
            {
              id: 'foundation',
              title: 'Establish analysis',
              outcome: 'Analysis works.',
              dependsOn: [],
              affectedPaths: ['source.ts'],
              newPaths: [],
              contracts: ['Preserve existing source.'],
              acceptance: [
                {
                  id: 'supported',
                  criterion: 'The selected languages are supported.',
                  verification: 'Exercise private fixture.',
                  requirementIds: ['languages'],
                  scenarioIds: ['selected'],
                },
              ],
              safeBoundary: 'Private synthetic project.',
            },
          ],
          decisions: [
            {
              id: 'retain-cycle',
              question: 'How should an approved language deferral continue?',
              selection: 'no-better-alternative',
              selected: 'Reconcile the existing cycle against the new approved specification.',
              alternatives: [],
              rationale: 'Retain identity, baseline and prior evidence while invalidating stale acceptance.',
              affectedPhases: ['foundation'],
              authority: 'orchestrator',
            },
          ],
          openQuestions: [],
        });
        const planPacket = yield* authoring('review-packet', {document: plan});
        const saved = yield* authoring('save', {
          document: plan,
          ready: true,
          expectedRevision: planRevision,
          confirmation: {
            intentHash: planPacket.documentHash,
            decision: 'approved',
            response: `Approve the plan for ${languages}.`,
          },
        });
        expect(saved.readinessBlockers).toEqual([]);
        expect(saved.readiness).toBe('ready');
        planRevision = object(saved.root).revision;
        return yield* authoring('export-dev-cycle', {
          uri: object(saved.root).uri,
          delivery: 'commit',
          bindings: {foundation: {branch: 'feature/amendment', baseBranch: 'main'}},
        });
      });
    const original = yield* savePlan('Java and Kotlin');
    yield* mutate('init', {plan: original});
    const baseline = object(yield* mutate('begin-phase', {phaseId: 'foundation'})).baseline;
    const amended = yield* savePlan('Java');
    const before = yield* f.fs.readFileString(f.statePath());
    const reason = 'User deferred Kotlin; Java remains mandatory.';
    const missingAuthority = yield* mutate('reconcile', {plan: amended, reason}).pipe(Effect.flip);
    expect(missingAuthority).toMatchObject({code: 'invalid-cycle', message: expect.stringContaining('user authority')});
    expect(yield* f.fs.readFileString(f.statePath())).toBe(before);
    const forged = {...amended, spec: {...object(amended.spec), intentHash: EffectString.repeat(64)('0')}};
    const drift = yield* mutate('reconcile', {plan: forged, reason, userAuthority: 'Approved.'}).pipe(Effect.flip);
    expect(drift).toMatchObject({code: 'plan-drift'});
    expect(yield* f.fs.readFileString(f.statePath())).toBe(before);
    const reconciled = yield* mutate('reconcile', {plan: amended, reason, userAuthority: 'Skip Kotlin for now.'});
    expect(reconciled.affected).toEqual(['foundation']);
    const state = JSON.parse(yield* f.fs.readFileString(f.statePath()));
    expect(state.cycle.plans).toHaveLength(2);
    expect(state.cycle.baselines.foundation).toEqual(baseline);
    expect(state.cycle.state.phases.foundation).toMatchObject({
      status: 'stale',
      reason,
    });
    const pin = (value: unknown) => {
      const {root, binding, documentHash, intentHash} = object(value);
      return {root, binding, documentHash, intentHash};
    };
    const approvals = [
      {before: pin(original.spec), after: pin(amended.spec), reason, userAuthority: 'Skip Kotlin for now.'},
    ];
    expect(state.cycle.state.specAmendments).toEqual(approvals);
    yield* mutate('resume-phase', {phaseId: 'foundation', reason: 'Approved revised acceptance is current.'});
    expect((yield* mutate('begin-phase', {phaseId: 'foundation'})).baseline).toEqual(baseline);
    const resumed = JSON.parse(yield* f.fs.readFileString(f.statePath()));
    expect(resumed.cycle.state.specAmendments).toEqual(approvals);
  }).pipe(TestClock.withLive, provideNative),
);
