import {expect, it} from 'vitest';
import fc from 'fast-check';
import {
  decodeNativeCyclePlan,
  decodeNativeCycleState,
  initializeNativeCycle,
  reconcileNativeCyclePlan,
  recordNativeCycleDelivery,
  validateNativeCyclePhase,
} from '../src/cycle.js';

const digest = 'a'.repeat(64);
const head = 'b'.repeat(40);
const tree = 'c'.repeat(40);
const spec = {
  root: {uri: 'threadnote://user/me/spec', memoryId: 'tn_spec', revision: digest},
  binding: {bindingId: digest, runId: 'run', generation: 'gen', profile: 'desktop'},
  documentHash: digest,
  intentHash: digest,
};
const amended = {...spec, root: {...spec.root, revision: 'd'.repeat(64)}, intentHash: 'd'.repeat(64)};
const plan = (count = 2) =>
  decodeNativeCyclePlan({
    format: 'threadnote-native-cycle-plan',
    version: 1,
    featureId: 'feature',
    project: 'fixture',
    objective: 'Deliver selected support.',
    delivery: 'commit',
    source: {
      root: {uri: 'threadnote://user/me/plan', memoryId: 'tn_plan', revision: digest},
      binding: spec.binding,
      documentHash: digest,
    },
    spec,
    completion: {},
    phases: Array.from({length: count}, (_, index) => ({
      id: `p${index}`,
      title: `Phase ${index}`,
      definitionHash: digest,
      dependsOn: [],
      allowedPaths: ['src/'],
      acceptanceCriteria: ['works'],
      safeToMergeReason: 'Independent working slice.',
      branch: `phase-${index}`,
      baseBranch: 'main',
      status: 'pending',
      acceptanceRefs: [{id: `a${index}`, criterion: 'works', requirements: ['req'], specScenarios: []}],
    })),
  });
const validate = (state: ReturnType<typeof initializeNativeCycle>) =>
  validateNativeCyclePhase(
    state,
    'p0',
    {head, tree, files: ['src/a.ts']},
    {
      snapshotTree: tree,
      status: 'passed',
      productState: 'working',
      checks: [{command: 'check', result: 'passed', evidence: 'Verified fixture.'}],
      acceptance: [{criterion: 'works', result: 'passed', evidence: 'Verified fixture.'}],
    },
  );

it('requires explicit amendment authority and retains the original specification identity', () => {
  const state = initializeNativeCycle(plan());
  const before = JSON.stringify(state);
  for (const authority of [undefined, '', ' ', 'approval\u0000', 'a'.repeat(4097)])
    expect(() => reconcileNativeCyclePlan(state, {...state.plan, spec: amended}, 'Defer Kotlin.', authority)).toThrow(
      'user authority',
    );
  for (const other of [
    undefined,
    {},
    {...amended, root: {...amended.root, uri: 'threadnote://user/me/other'}},
    {...amended, root: {...amended.root, memoryId: 'tn_other'}},
    {...amended, binding: {...amended.binding, runId: 'other'}},
    {...amended, binding: {...amended.binding, generation: 'other'}},
    {...amended, binding: {...amended.binding, bindingId: 'e'.repeat(64)}},
  ])
    expect(() =>
      reconcileNativeCyclePlan(state, {...state.plan, spec: other}, 'Defer Kotlin.', 'Skip Kotlin for now.'),
    ).toThrow();
  const unlinked = initializeNativeCycle({...state.plan, spec: undefined});
  expect(() => reconcileNativeCyclePlan(unlinked, state.plan, 'Attach spec.', 'Approved.')).toThrow(
    'original linked specification',
  );
  expect(JSON.stringify(state)).toBe(before);
});

it('invalidates every spec-bound phase and retains prior acceptance and delivery evidence', () => {
  let state = validate(initializeNativeCycle(plan()));
  state = recordNativeCycleDelivery(state, 'p0', {
    phaseId: 'p0',
    phaseHash: state.phases.p0.phaseHash,
    delivery: 'commit',
    headSha: head,
    validatedTree: tree,
    commitEvidence: 'Verified checkpoint.',
  });
  const before = JSON.stringify(state);
  const result = reconcileNativeCyclePlan(
    state,
    {...state.plan, spec: amended},
    'Admit approved scope amendment.',
    'Skip Kotlin for now.',
  );
  expect(result.affected).toEqual(['p0', 'p1']);
  for (const phase of Object.values(result.state.phases)) {
    expect(phase.status).toBe('stale');
    expect(phase.validation).toBeUndefined();
    expect(phase.delivery).toBeUndefined();
    expect(phase.reason).toBe('Admit approved scope amendment.');
  }
  expect(result.state.specAmendments).toEqual([
    {before: spec, after: amended, reason: 'Admit approved scope amendment.', userAuthority: 'Skip Kotlin for now.'},
  ]);
  expect(result.state.phases.p0.history?.[0]).toMatchObject({
    phaseHash: state.phases.p0.phaseHash,
    validation: state.phases.p0.validation,
    delivery: state.phases.p0.delivery,
  });
  expect(decodeNativeCycleState(result.state)).toEqual(result.state);
  expect(JSON.stringify(state)).toBe(before);
});

it('preserves successive approval records and refuses to truncate exhausted history', () => {
  let state = initializeNativeCycle(plan(1));
  for (let index = 1; index <= 64; index++) {
    const next = {...spec, root: {...spec.root, revision: index.toString(16).padStart(64, '0')}};
    const prior = state;
    state = reconcileNativeCyclePlan(state, {...state.plan, spec: next}, `Amendment ${index}.`, 'Approved.').state;
    expect(state.specAmendments?.slice(0, -1)).toEqual(prior.specAmendments ?? []);
    expect(state.specAmendments?.at(-1)).toMatchObject({before: prior.plan.spec, after: next});
  }
  const before = JSON.stringify(state);
  expect(() => reconcileNativeCyclePlan(state, {...state.plan, spec: amended}, 'One more.', 'Approved.')).toThrow(
    'history capacity',
  );
  expect(JSON.stringify(state)).toBe(before);
});

it('does not authorize rewriting merged history', () => {
  let state = validate(initializeNativeCycle({...plan(1), delivery: 'pr'}));
  state = recordNativeCycleDelivery(state, 'p0', {
    phaseId: 'p0',
    phaseHash: state.phases.p0.phaseHash,
    delivery: 'pr',
    headSha: head,
    validatedTree: tree,
    commitEvidence: 'Verified merged fixture.',
    pr: {url: 'https://example.test/pull/1', headSha: head, branch: 'phase-0', baseBranch: 'main', state: 'merged'},
  });
  expect(() =>
    reconcileNativeCyclePlan(state, {...state.plan, spec: amended}, 'Approved scope amendment.', 'Approved.'),
  ).toThrow('Merged history');
});

it('never reuses acceptance hashes across generated specification revisions', () => {
  fc.assert(
    fc.property(fc.integer({min: 1, max: 12}), fc.integer({min: 1, max: 1_000_000}), (count, revision) => {
      const state = initializeNativeCycle(plan(count));
      const next = {...spec, root: {...spec.root, revision: revision.toString(16).padStart(64, '0')}};
      const result = reconcileNativeCyclePlan(state, {...state.plan, spec: next}, 'New ready pin.', 'Approved pin.');
      expect(result.affected).toHaveLength(count);
      for (const id of Object.keys(state.phases)) {
        expect(result.state.phases[id].phaseHash).not.toBe(state.phases[id].phaseHash);
        expect(result.state.phases[id].status).toBe('stale');
      }
    }),
    {numRuns: 40},
  );
});
