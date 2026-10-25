import {describe, expect, it} from 'vitest';
import fc from 'fast-check';
import {
  nativeCyclePacket,
  validateNativeCycleCapacityRecord,
  validateNativeCycleFeaturePublication,
} from '../src/cycle_packet.js';
import {
  decodeNativeCyclePlan,
  decodeNativeCycleState,
  initializeNativeCycle,
  invalidateNativeCycle,
  nextNativeCycle,
  nativeCyclePhaseHash,
  reconcileNativeCyclePlan,
  recordNativeCycleDelivery,
  validateNativeCyclePhase,
  type NativeCycleValidation,
  type NativeCycleState,
} from '../src/cycle.js';

const gitSha = 'a'.repeat(40);
const gitTree = 'b'.repeat(40);
const digest = 'c'.repeat(64);
const makePlan = (
  phases = [
    {
      id: 'one',
      definitionHash: '1'.repeat(64),
      title: 'One',
      dependsOn: [],
      allowedPaths: ['src/'],
      acceptanceCriteria: ['works'],
      safeToMergeReason: 'Safe',
      branch: 'feature/one',
      baseBranch: 'main',
      status: 'pending',
      acceptanceRefs: [{id: 'a1', criterion: 'works', requirements: ['req'], specScenarios: []}],
    },
    {
      id: 'two',
      definitionHash: '2'.repeat(64),
      title: 'Two',
      dependsOn: ['one'],
      allowedPaths: ['test/'],
      acceptanceCriteria: ['tested'],
      safeToMergeReason: 'Safe',
      branch: 'feature/two',
      baseBranch: 'main',
      status: 'pending',
      acceptanceRefs: [{id: 'a2', criterion: 'tested', requirements: ['req'], specScenarios: []}],
    },
  ],
) => ({
  format: 'threadnote-native-cycle-plan',
  version: 1,
  featureId: 'feature',
  project: 'repo',
  objective: 'Do work',
  delivery: 'pr',
  source: {
    root: {uri: 'threadnote://user/me/plan', memoryId: 'tn_123', revision: digest},
    binding: {bindingId: digest, runId: 'run', generation: 'gen', profile: 'desktop'},
    documentHash: digest,
  },
  completion: {},
  phases,
});
const validation: NativeCycleValidation = {
  snapshotTree: gitTree,
  status: 'passed',
  productState: 'working',
  checks: [{command: 'check', result: 'passed', evidence: 'ok'}],
  acceptance: [{criterion: 'works', result: 'passed', evidence: 'ok'}],
};
const snapshot = (files = ['src/a.ts']) => ({head: gitSha, tree: gitTree, files});
const validateFirst = () =>
  validateNativeCyclePhase(initializeNativeCycle(decodeNativeCyclePlan(makePlan())), 'one', snapshot(), validation);
const packetOptions = {
  capacity: {
    model: 'selected-by-user',
    effort: 'low',
    selection: 'least-sufficient',
    risk: 'settled',
    reason: 'Routine bounded work',
    catalogEvidence: 'Available model supports the task.',
  },
  graphProof: {
    state: 'ready',
    head: gitSha,
    tree: gitTree,
    dirty: true,
    snapshotId: 'snapshot-1',
    graphContentId: 'graph-1',
    repositoryRoot: 'C:\\repo',
  },
  anchors: [
    {path: 'packages/workflow-automations/src/cycle.ts', sha256: digest, pattern: 'phase state and validation'},
  ],
  ownership: ['packages/workflow-automations/src/cycle.ts: cycle domain owns state transitions'],
  checks: ['bun --bun vitest run packages/workflow-automations/test/cycle.test.ts'],
};
const prDelivery = (state: 'open' | 'merged' = 'open') => ({
  phaseId: 'one',
  phaseHash: validateFirst().phases.one.phaseHash,
  delivery: 'pr',
  headSha: gitSha,
  validatedTree: gitTree,
  commitEvidence: 'Verified commit abc123',
  pr: {url: 'https://example.test/pr/1', headSha: gitSha, branch: 'feature/one', baseBranch: 'main', state},
  ...(state === 'open'
    ? {
        watch: {
          prUrl: 'https://example.test/pr/1',
          headSha: gitSha,
          state: 'active',
          stateDir: 'C:\\cycle\\watcher',
          consumerKind: 'worker',
          consumerId: 'watcher',
          evidence: 'watch active',
        },
      }
    : {}),
});

describe('native cycle pure domain', () => {
  it('rejects unsupported formats, unsafe paths and reserved IDs without mutation', () => {
    const input = makePlan();
    expect(decodeNativeCyclePlan(input)).toEqual(input);
    expect(() => decodeNativeCyclePlan({...input, version: 2})).toThrow();
    for (const unsafe of ['../secret', 'C:/root', 'a\\b', 'src/\u0001x', '/absolute', 'src/../secret']) {
      const phases = [...input.phases];
      phases[0] = {...phases[0], allowedPaths: [unsafe]};
      expect(() => decodeNativeCyclePlan(makePlan(phases))).toThrow();
    }
    for (const reserved of ['constructor', 'prototype', '__proto__', 'phase..part']) {
      const phases = [...input.phases];
      phases[0] = {...phases[0], id: reserved};
      expect(() => decodeNativeCyclePlan(makePlan(phases))).toThrow();
    }
    const phases = [...input.phases];
    phases[0] = {...phases[0], acceptanceRefs: [{...phases[0].acceptanceRefs[0], criterion: 'other'}]};
    expect(() => decodeNativeCyclePlan(makePlan(phases))).toThrow();
    expect(input).toEqual(makePlan());
  });

  it('prioritizes outstanding delivery across generated DAGs with varied dependency, metadata, and status inputs', () =>
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            branch: fc.stringMatching(/^[a-z][a-z0-9-]{0,8}$/),
            depends: fc.boolean(),
            title: fc.stringMatching(/^[A-Za-z][A-Za-z0-9]{0,11}$/),
          }),
          {minLength: 1, maxLength: 5},
        ),
        entries => {
          const phases = [
            {
              id: 'root',
              definitionHash: '3'.repeat(64),
              title: entries[0].title,
              dependsOn: [],
              allowedPaths: ['src/'],
              acceptanceCriteria: ['works'],
              safeToMergeReason: 'Safe',
              branch: `feature/${entries[0].branch}`,
              baseBranch: 'main',
              status: 'pending',
              acceptanceRefs: [{id: 'root-ref', criterion: 'works', requirements: ['req'], specScenarios: []}],
            },
            ...entries.map((entry, index) => ({
              id: `phase-${index}`,
              definitionHash: '4'.repeat(64),
              title: entry.title,
              dependsOn: entry.depends ? ['root'] : [],
              allowedPaths: [`dir-${index}/`],
              acceptanceCriteria: [`criterion-${index}`],
              safeToMergeReason: 'Safe',
              branch: `feature/${entry.branch}`,
              baseBranch: 'main',
              status: 'pending',
              acceptanceRefs: [
                {id: `ref-${index}`, criterion: `criterion-${index}`, requirements: ['req'], specScenarios: []},
              ],
            })),
          ];
          const initial = initializeNativeCycle(decodeNativeCyclePlan(makePlan(phases)));
          const validated = validateNativeCyclePhase(initial, 'root', snapshot(), validation);
          expect(nextNativeCycle(validated)).toEqual({action: 'deliver', phaseId: 'root'});
        },
      ),
    ));

  it('preserves proof history through invalidation and reconciles only affected phases', () => {
    const valid = validateFirst();
    const changed = invalidateNativeCycle(valid, 'one', 'source changed');
    expect(changed.phases.one?.history).toHaveLength(1);
    expect(changed.phases.one?.history?.[0]?.head).toBe(gitSha);
    expect(changed.phases.two?.status).toBe('stale');
    expect(valid.phases.one?.status).toBe('validated');

    const plan = makePlan();
    const phases = [...plan.phases];
    phases[1] = {...phases[1], branch: 'feature/two-v2'};
    const reconciled = reconcileNativeCyclePlan(
      valid,
      decodeNativeCyclePlan(makePlan(phases)),
      'delivery metadata changed',
    );
    expect(reconciled.affected).toEqual([]);
    expect(reconciled.state.phases.one?.status).toBe('validated');
    expect(reconciled.state.phases.one?.phaseHash).toBe(nativeCyclePhaseHash(reconciled.state.plan, 'one'));
  });

  it('rejects removal or rewriting of accepted and merged evidence', () => {
    const first = recordNativeCycleDelivery(validateFirst(), 'one', prDelivery());
    const accepted = validateNativeCyclePhase(first, 'two', snapshot(['test/a.ts']), {
      ...validation,
      acceptance: [{criterion: 'tested', result: 'passed', evidence: 'ok'}],
    });
    expect(() =>
      reconcileNativeCyclePlan(
        accepted,
        decodeNativeCyclePlan(makePlan([makePlan().phases[0]])),
        'remove accepted phase',
      ),
    ).toThrow();
    const validated = validateFirst();
    const forgedMerged: NativeCycleState = {
      ...validated,
      phases: {...validated.phases, one: {...validated.phases.one, status: 'merged'}},
    };
    const forgedPublished: NativeCycleState = {
      ...validated,
      phases: {...validated.phases, one: {...validated.phases.one, status: 'published'}},
    };
    expect(() => decodeNativeCycleState(forgedMerged)).toThrow();
    expect(() => decodeNativeCycleState(forgedPublished)).toThrow();
    expect(() => invalidateNativeCycle(forgedMerged, 'one', 'rewrite')).toThrow();
  });

  it('records matching PR evidence and accepts Windows watcher state directories', () => {
    const state = validateFirst();
    const delivered = recordNativeCycleDelivery(state, 'one', prDelivery());
    expect(delivered.phases.one?.status).toBe('published');
    expect(delivered.phases.one?.delivery?.watch?.stateDir).toBe('C:\\cycle\\watcher');
    expect(() => recordNativeCycleDelivery(state, 'one', {...prDelivery(), commitEvidence: undefined})).toThrow();
  });

  it('validates exact publication identity and packet content, bounds, and irrelevant sibling history', () => {
    const receipt = {
      state: 'published',
      team: 'team-a',
      uri: 'threadnote://user/me/memories/shared/team-a/feature',
      revision: digest,
      currentHead: gitSha,
      remoteCommit: 'd'.repeat(40),
      evidence: 'Published shared feature memory.',
    };
    expect(validateNativeCycleFeaturePublication(receipt, {team: 'team-a', currentHead: gitSha})).toBe(true);
    expect(() =>
      validateNativeCycleFeaturePublication({...receipt, team: 'team-b'}, {team: 'team-a', currentHead: gitSha}),
    ).toThrow();
    expect(() =>
      validateNativeCycleFeaturePublication(
        {...receipt, currentHead: 'e'.repeat(40)},
        {team: 'team-a', currentHead: gitSha},
      ),
    ).toThrow();

    const state = initializeNativeCycle(decodeNativeCyclePlan(makePlan()));
    const basePacket = nativeCyclePacket(state, 'one', {...packetOptions, budgetBytes: 12 * 1024});
    expect(basePacket.available).toBe(true);
    expect(basePacket.acceptanceCriteria).toEqual(['works']);
    const noisyHistory: NativeCycleState['phases'][string]['history'] = Array.from({length: 20}, () => ({
      phaseHash: digest,
      head: gitSha,
      tree: gitTree,
      validation: {...validation, acceptance: [{criterion: 'tested', result: 'passed', evidence: 'x'.repeat(1800)}]},
    }));
    const noisyState = {...state, phases: {...state.phases, two: {...state.phases.two, history: noisyHistory}}};
    expect(nativeCyclePacket(noisyState, 'one', {...packetOptions, budgetBytes: 12 * 1024})).toEqual(basePacket);

    const tooSmall = nativeCyclePacket(state, 'one', {...packetOptions, budgetBytes: 1024});
    expect(tooSmall).toMatchObject({available: false, reason: 'packet-budget-exceeded'});
    expect(tooSmall.acceptanceCriteria).toBeUndefined();
    expect(nativeCyclePacket(state, 'one', {...packetOptions, budgetBytes: 512})).toMatchObject({
      available: false,
      reason: 'graph-or-anchor-proof-unavailable',
    });
    expect(
      nativeCyclePacket(state, 'one', {...packetOptions, graphProof: {...packetOptions.graphProof, tree: 'bad'}}),
    ).toMatchObject({available: false, reason: 'graph-or-anchor-proof-unavailable'});
    expect(() =>
      validateNativeCycleCapacityRecord({...packetOptions.capacity, selection: 'escalation', risk: 'settled'}),
    ).toThrow();
  });
});
