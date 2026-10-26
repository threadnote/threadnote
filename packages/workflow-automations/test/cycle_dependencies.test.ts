import {expect, it} from 'vitest';
import fc from 'fast-check';
import {
  decodeNativeCyclePlan,
  initializeNativeCycle,
  invalidateNativeCycle,
  nativeCycleEffectiveParents,
  nativeCycleParentsReady,
  nativeCyclePhaseHash,
  nextNativeCycle,
  reconcileNativeCyclePlan,
  recordNativeCycleDelivery,
  validateNativeCyclePhase,
  type NativeCycleState,
} from '../src/cycle.js';
const head = 'a'.repeat(40),
  tree = 'b'.repeat(40),
  digest = 'c'.repeat(64);
const phase = (id: string, baseBranch = 'main', dependsOn: string[] = []) => ({
  id,
  title: id,
  definitionHash: digest,
  dependsOn,
  allowedPaths: ['src/'],
  acceptanceCriteria: ['works'],
  safeToMergeReason: 'Safe',
  branch: id,
  baseBranch,
  status: 'pending' as const,
  acceptanceRefs: [{id: 'accept-' + id, criterion: 'works', requirements: ['req'], specScenarios: []}],
});
const plan = (phases = [phase('a'), phase('b', 'a'), phase('c')], delivery: 'local' | 'commit' | 'pr' = 'local') =>
  decodeNativeCyclePlan({
    format: 'threadnote-native-cycle-plan',
    version: 1,
    featureId: 'feature',
    project: 'fixture',
    objective: 'Work',
    delivery,
    source: {
      root: {uri: 'threadnote://user/me/plan', memoryId: 'tn_123', revision: digest},
      binding: {bindingId: digest, runId: 'run', generation: 'gen', profile: 'desktop'},
      documentHash: digest,
    },
    completion: {},
    phases,
  });
const validate = (s: NativeCycleState, id: string) =>
  validateNativeCyclePhase(
    s,
    id,
    {head, tree, files: ['src/a.ts']},
    {
      snapshotTree: tree,
      status: 'passed',
      productState: 'working',
      checks: [{command: 'check', result: 'passed', evidence: 'ok'}],
      acceptance: [{criterion: 'works', result: 'passed', evidence: 'ok'}],
    },
  );
const receipt = (s: NativeCycleState, id: string, merged = false) => {
  const p = s.plan.phases.find(p => p.id === id)!;
  return {
    phaseId: id,
    phaseHash: s.phases[id].phaseHash,
    delivery: s.plan.delivery,
    headSha: head,
    validatedTree: tree,
    ...(s.plan.delivery === 'local' ? {} : {commitEvidence: 'Exact commit'}),
    ...(s.plan.delivery === 'pr'
      ? {
          pr: {
            url: 'https://example.test/pr/' + id,
            headSha: head,
            branch: p.branch,
            baseBranch: p.baseBranch,
            state: merged ? 'merged' : 'open',
          },
          ...(merged
            ? {}
            : {
                watch: {
                  prUrl: 'https://example.test/pr/' + id,
                  headSha: head,
                  state: 'active',
                  stateDir: '/private/watch',
                  consumerKind: 'worker',
                  consumerId: 'fixture',
                  evidence: 'Owned watch',
                },
              }),
        }
      : {}),
  };
};
it('uses all exact branch parents, suppresses self/shared-base inference and rejects combined cycles', () => {
  const p = plan([phase('a'), {...phase('duplicate'), branch: 'a'}, phase('b', 'a')]);
  expect(nativeCycleEffectiveParents(p, 'b')).toEqual(['a', 'duplicate']);
  expect(
    nativeCycleEffectiveParents(
      plan([
        {...phase('a'), branch: 'main'},
        {...phase('b'), branch: 'main'},
      ]),
      'b',
    ),
  ).toEqual([]);
  expect(() => plan([phase('a', 'main', ['b']), phase('b', 'a')])).toThrow('Dependency cycle');
});
it.each(['commit', 'pr'] as const)(
  'does not return or directly deliver retained child proof until its %s parent is delivered',
  mode => {
    let s = initializeNativeCycle(plan([phase('a'), phase('b')], mode));
    s = validate(s, 'b');
    const bHash = s.phases.b.phaseHash;
    s = reconcileNativeCyclePlan(s, {...s.plan, phases: [phase('a'), phase('b', 'a')]}, 'Stack binding').state;
    expect(s.phases.b.phaseHash).toBe(bHash);
    expect(nextNativeCycle(s)).toEqual({action: 'implement', phaseId: 'a'});
    expect(() => recordNativeCycleDelivery(s, 'b', receipt(s, 'b'))).toThrow('effective parents');
    s = validate(s, 'a');
    expect(nextNativeCycle(s)).toEqual({action: 'deliver', phaseId: 'a'});
    expect(nativeCycleParentsReady(s, 'b')).toBe(false);
    expect(() => recordNativeCycleDelivery(s, 'b', receipt(s, 'b'))).toThrow('effective parents');
    s = recordNativeCycleDelivery(s, 'a', receipt(s, 'a'));
    expect(nextNativeCycle(s)).toEqual({action: 'deliver', phaseId: 'b'});
    expect(recordNativeCycleDelivery(s, 'b', receipt(s, 'b')).phases.b.status).toBe('published');
  },
);
it('invalidates inferred descendants and retains unrelated eligibility and complete history', () => {
  let s = initializeNativeCycle(plan());
  s = validate(s, 'a');
  s = validate(s, 'b');
  const updated = invalidateNativeCycle(s, 'a', 'Parent changed');
  expect(updated.phases.b.status).toBe('stale');
  expect(updated.phases.b.history).toHaveLength(1);
  expect(updated.phases.b.history?.[0].validation).toEqual(s.phases.b.validation);
  expect(nextNativeCycle(updated)).toEqual({action: 'implement', phaseId: 'c'});
});
it('propagates material changes through the fixed point of alternating old and new edges', () => {
  const old = plan([phase('a'), phase('b', 'a'), phase('c'), phase('d', 'c')]);
  let s = initializeNativeCycle(old);
  for (const id of ['a', 'b', 'c', 'd']) s = validate(s, id);
  const updated = {...old, phases: [{...phase('a'), title: 'Changed'}, phase('b'), phase('c', 'b'), phase('d')]};
  const result = reconcileNativeCyclePlan(s, updated, 'Material parent and stack retarget');
  expect(new Set(result.affected)).toEqual(new Set(['a', 'b', 'c', 'd']));
  for (const id of ['a', 'b', 'c', 'd']) {
    expect(result.state.phases[id].status).toBe('stale');
    expect(result.state.phases[id].history).toHaveLength(1);
  }
  expect(s.phases.d.history).toBeUndefined();
});
it('keeps retargeted material validation while requiring a fresh delivery and preserving exact merged replay', () => {
  let s = initializeNativeCycle(plan([phase('a'), phase('b', 'a')], 'pr'));
  s = recordNativeCycleDelivery(validate(s, 'a'), 'a', receipt(validate(s, 'a'), 'a'));
  s = validate(s, 'b');
  s = recordNativeCycleDelivery(s, 'b', receipt(s, 'b'));
  const updated = reconcileNativeCyclePlan(s, {...s.plan, phases: [phase('a'), phase('b')]}, 'Retarget main').state;
  expect(nativeCyclePhaseHash(updated.plan, 'b')).toBe(s.phases.b.phaseHash);
  expect(updated.phases.b.validation).toEqual(s.phases.b.validation);
  expect(updated.phases.b.delivery).toBeUndefined();
  expect(updated.phases.b.history?.[0].delivery).toEqual(s.phases.b.delivery);
  const merged = recordNativeCycleDelivery(updated, 'b', receipt(updated, 'b', true));
  expect(recordNativeCycleDelivery(merged, 'b', receipt(merged, 'b', true))).toEqual(merged);
  expect(() => invalidateNativeCycle(merged, 'b', 'No rewrite')).toThrow('Merged');
});
it('rejects a merged descendant affected through old/new alternating edges without rewriting evidence', () => {
  let s = initializeNativeCycle(plan([phase('a'), phase('b', 'a'), phase('c'), phase('d', 'c')], 'pr'));
  for (const id of ['a', 'b', 'c', 'd']) {
    s = validate(s, id);
    s = recordNativeCycleDelivery(s, id, receipt(s, id, id === 'd'));
  }
  const before = JSON.stringify(s);
  expect(() =>
    reconcileNativeCyclePlan(
      s,
      {...s.plan, phases: [{...phase('a'), title: 'Changed'}, phase('b'), phase('c', 'b'), phase('d', 'c')]},
      'Changed',
    ),
  ).toThrow('Merged');
  expect(JSON.stringify(s)).toBe(before);
});
it('matches an independent branch-chain descendant model', () => {
  fc.assert(
    fc.property(fc.integer({min: 2, max: 12}), fc.integer({min: 0, max: 11}), (count, position) => {
      const phases = Array.from({length: count}, (_, i) => phase('p' + i, i ? 'p' + (i - 1) : 'main'));
      let s = initializeNativeCycle(plan(phases));
      for (const p of phases) s = validate(s, p.id);
      const from = position % count,
        result = invalidateNativeCycle(s, 'p' + from, 'Changed');
      for (let i = 0; i < count; i++) expect(result.phases['p' + i].status).toBe(i >= from ? 'stale' : 'validated');
    }),
    {numRuns: 40},
  );
});

it('seeds removed pending parents and newly added parents before projecting survivors', () => {
  let s = initializeNativeCycle(plan([phase('a'), phase('b')]));
  s = validate(s, 'b');
  s = reconcileNativeCyclePlan(s, {...s.plan, phases: [phase('a'), phase('b', 'a')]}, 'Bind pending parent').state;
  const removed = reconcileNativeCyclePlan(s, {...s.plan, phases: [phase('b')]}, 'Remove pending parent');
  expect(removed.state.phases.b.status).toBe('stale');
  expect(removed.state.phases.b.history).toHaveLength(1);
  const added = reconcileNativeCyclePlan(
    initializeNativeCycle(plan([phase('b', 'new')])),
    plan([phase('new'), phase('b', 'new')]),
    'Add missing parent',
  );
  expect(new Set(added.affected)).toEqual(new Set(['new', 'b']));
});

it('replays an exact merged receipt before unrelated new delivery gates', () => {
  let s = initializeNativeCycle(plan([phase('a'), phase('b')], 'pr'));
  s = validate(s, 'b');
  s = recordNativeCycleDelivery(s, 'b', receipt(s, 'b', true));
  const accepted = receipt(s, 'b', true);
  s = validate(s, 'a');
  expect(nextNativeCycle(s)).toEqual({action: 'deliver', phaseId: 'a'});
  expect(recordNativeCycleDelivery(s, 'b', accepted)).toEqual(s);
});

it.each(['pr', 'commit', 'local'] as const)(
  'requires every effective ancestor after a retained %s parent is retargeted',
  mode => {
    let s = initializeNativeCycle(plan([phase('a'), phase('b', 'a'), phase('c', 'b'), phase('p')], mode));
    for (const id of ['a', 'b']) {
      s = validate(s, id);
      s = recordNativeCycleDelivery(s, id, receipt(s, id));
    }
    const priorB = s.phases.b;
    s = reconcileNativeCyclePlan(
      s,
      {...s.plan, phases: [phase('a', 'p'), phase('b', 'a'), phase('c', 'b'), phase('p')]},
      'Retarget ancestor to pending parent',
    ).state;
    expect(s.phases.b).toEqual(priorB);
    expect(nativeCycleParentsReady(s, 'c')).toBe(false);
    expect(nextNativeCycle(s)).toEqual({action: 'implement', phaseId: 'p'});
    expect(() => validate(s, 'c')).toThrow('dependencies');
    s = validate(s, 'p');
    if (mode !== 'local') {
      expect(nativeCycleParentsReady(s, 'c')).toBe(false);
      s = recordNativeCycleDelivery(s, 'p', receipt(s, 'p'));
      expect(nextNativeCycle(s)).toEqual({action: 'deliver', phaseId: 'a'});
      s = recordNativeCycleDelivery(s, 'a', receipt(s, 'a'));
    }
    expect(nativeCycleParentsReady(s, 'c')).toBe(true);
    expect(nextNativeCycle(s)).toEqual({action: 'implement', phaseId: 'c'});
  },
);
