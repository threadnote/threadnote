import {Array as EffectArray, Schema} from 'effect';
import {describe, expect, it} from 'vitest';
import fc from 'fast-check';
import {Array as A, String as S} from 'effect';
import {
  NativeCyclePacketOptionsSchema,
  nativeCyclePacket,
  validateNativeCycleCapacityRecord,
  validateNativeCycleFeaturePublication,
} from '../src/cycle_packet.js';
import {
  decodeNativeCyclePlan,
  checkNativeCycleScope,
  nativeCycleHasControl,
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
import {sha256HexSync} from '@threadnote/platform/sha256';
import {nativeCycleCanonicalJson, NativeCycleStateSchema} from '../src/cycle.js';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';
import {
  appendNativeCycleSupplementalRecord,
  initializeNativeCycleSupplementalPublication,
  nativeCycleSupplementalRef,
  nativeCycleSupplementalRevision,
  type NativeCycleRuntime,
  decodeNativeCycleRuntime,
} from '../src/cycle_runtime.js';

const gitSha = Effect.pipe('a', EffectString.repeat(40));
const gitTree = Effect.pipe('b', EffectString.repeat(40));
const digest = Effect.pipe('c', EffectString.repeat(64));
const makePlan = (
  phases = [
    {
      id: 'one',
      definitionHash: Effect.pipe('1', EffectString.repeat(64)),
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
      definitionHash: Effect.pipe('2', EffectString.repeat(64)),
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
  it('requires consistent receipt-only base binding and keeps merged replay immutable', () => {
    const plan = makePlan();
    plan.phases[0].baseBranch = 'origin/main';
    const state = validateNativeCyclePhase(
      initializeNativeCycle(decodeNativeCyclePlan(plan)),
      'one',
      snapshot(),
      validation,
    );
    const publication = {
      state: 'published',
      team: 'default',
      uri: 'threadnote://memories/shared/default/durable/pr-publication',
      revision: digest,
      currentHead: gitSha,
      remoteCommit: gitSha,
      evidence: 'The current source was published with this exact reviewed receipt.',
    } as const;
    const receipt = {
      ...prDelivery('merged'),
      publication,
      pr: {
        ...prDelivery('merged').pr,
        url: 'https://github.com/example/repo/pull/1',
        baseRefBinding: {
          ref: 'refs/remotes/origin/main',
          remote: 'origin',
          repository: 'https://github.com/example/repo',
        },
      },
    };
    expect(() =>
      recordNativeCycleDelivery(state, 'one', {...receipt, pr: {...receipt.pr, baseRefBinding: undefined}}),
    ).toThrow();
    const delivered = recordNativeCycleDelivery(state, 'one', receipt);
    expect(delivered.plan).toEqual(state.plan);
    expect(delivered.phases.one.phaseHash).toBe(state.phases.one.phaseHash);
    expect(delivered.phases.one.delivery?.publication).toEqual(publication);
    expect(decodeNativeCycleState(JSON.parse(JSON.stringify(delivered)))).toEqual(delivered);
    expect(recordNativeCycleDelivery(delivered, 'one', receipt)).toEqual(delivered);
    expect(() => recordNativeCycleDelivery(delivered, 'one', {...receipt, commitEvidence: 'different'})).toThrow();
    expect(() =>
      recordNativeCycleDelivery(delivered, 'one', {
        ...receipt,
        publication: {...publication, evidence: 'Changed authority cannot replay the receipt.'},
      }),
    ).toThrow();
    for (const proof of [
      {...receipt.pr.baseRefBinding, remote: 'fork'},
      {...receipt.pr.baseRefBinding, ref: 'refs/remotes/origin/other'},
      {...receipt.pr.baseRefBinding, repository: 'https://github.com/other/repo'},
      {...receipt.pr.baseRefBinding, ref: 'refs/remotes/origin/../main'},
    ]) {
      const bad = {...receipt, pr: {...receipt.pr, baseRefBinding: proof}};
      expect(() => recordNativeCycleDelivery(state, 'one', bad)).toThrow();
      expect(() =>
        decodeNativeCycleState({
          ...delivered,
          phases: {...delivered.phases, one: {...delivered.phases.one, delivery: bad}},
        }),
      ).toThrow();
    }
  });

  it('preserves bounded PR publication authority across receipt round-trips and rejects changed-authority replay', () => {
    fc.assert(
      fc.property(
        fc
          .string({minLength: 1, maxLength: 48})
          .filter(value => /^[A-Za-z0-9 .-]+$/u.test(value) && EffectString.trim(value).length > 0),
        evidence => {
          const publication = {
            state: 'published' as const,
            team: 'default',
            uri: 'threadnote://memories/shared/default/durable/pr-publication',
            revision: digest,
            currentHead: gitSha,
            remoteCommit: gitSha,
            evidence,
          };
          const receipt = {...prDelivery('merged'), publication};
          const delivered = recordNativeCycleDelivery(validateFirst(), 'one', receipt);
          const readback = decodeNativeCycleState(JSON.parse(JSON.stringify(delivered)));
          expect(readback.phases.one.delivery?.publication).toEqual(publication);
          expect(recordNativeCycleDelivery(readback, 'one', receipt)).toEqual(readback);
          expect(() =>
            recordNativeCycleDelivery(readback, 'one', {
              ...receipt,
              publication: {...publication, evidence: evidence + ' changed'},
            }),
          ).toThrow();
        },
      ),
      {numRuns: 24},
    );
  });

  it('binds active versus terminal watch readback to open versus merged PR receipts', () => {
    fc.assert(
      fc.property(fc.boolean(), fc.boolean(), (merged, terminal) => {
        const receipt = {
          ...prDelivery(merged ? 'merged' : 'open'),
          watch: {
            prUrl: 'https://example.test/pr/1',
            headSha: gitSha,
            state: terminal ? 'terminal' : 'active',
            stateDir: '/private/test-watch',
            consumerKind: 'worker',
            consumerId: 'watcher',
            evidence: 'Canonical private watch readback.',
          },
        };
        if (merged === terminal)
          expect(recordNativeCycleDelivery(validateFirst(), 'one', receipt).phases.one.delivery).toMatchObject({
            watch: {state: terminal ? 'terminal' : 'active'},
          });
        else expect(() => recordNativeCycleDelivery(validateFirst(), 'one', receipt)).toThrow();
      }),
      {numRuns: 4},
    );
  });

  it('preserves all non-delivery state through generated base mappings and serialization', () => {
    const word = fc
      .array(fc.constantFrom('a', 'b', 'c', 'x', '1'), {minLength: 1, maxLength: 10})
      .map(x => EffectArray.join(x, ''));
    fc.assert(
      fc.property(word, word, fc.boolean(), (remote, branch, full) => {
        const plan = makePlan();
        const ref = `refs/remotes/${remote}/${branch}`;
        plan.phases[0].baseBranch = full ? ref : `${remote}/${branch}`;
        const state = validateNativeCyclePhase(
          initializeNativeCycle(decodeNativeCyclePlan(plan)),
          'one',
          snapshot(),
          validation,
        );
        const before = JSON.stringify(state);
        const receipt = {
          ...prDelivery('merged'),
          pr: {
            ...prDelivery('merged').pr,
            url: 'https://github.com/example/repo/pull/1',
            baseBranch: branch,
            baseRefBinding: {ref, remote, repository: 'https://github.com/example/repo'},
          },
        };
        const delivered = recordNativeCycleDelivery(state, 'one', receipt);
        expect(delivered).toEqual({
          ...state,
          phases: {...state.phases, one: {...state.phases.one, status: 'merged', delivery: receipt}},
        });
        expect(decodeNativeCycleState(JSON.parse(JSON.stringify(delivered)))).toEqual(delivered);
        expect(JSON.stringify(state)).toBe(before);
        expect(() =>
          recordNativeCycleDelivery(state, 'one', {...receipt, pr: {...receipt.pr, baseBranch: branch + 'different'}}),
        ).toThrow();
        expect(JSON.stringify(state)).toBe(before);
      }),
      {numRuns: 30},
    );
  });

  it('admits zero-write phases while retaining the path cardinality and text bounds', () => {
    const input = makePlan();
    const withPaths = (allowedPaths: string[]) => decodeNativeCyclePlan(makePlan([{...input.phases[0], allowedPaths}]));
    const plan = withPaths([]);
    expect(plan.phases[0].allowedPaths).toEqual([]);
    const state = initializeNativeCycle(plan);
    expect(decodeNativeCycleState(JSON.parse(JSON.stringify(state)))).toEqual(state);
    expect(checkNativeCycleScope(plan.phases[0], [])).toBe(true);
    expect(checkNativeCycleScope(plan.phases[0], ['src/a.ts'])).toBe(false);
    expect(validateNativeCyclePhase(state, 'one', snapshot([]), validation).phases.one.status).toBe('validated');
    expect(() => validateNativeCyclePhase(state, 'one', snapshot(['src/a.ts']), validation)).toThrow();
    for (const count of [129, 162, 256]) {
      const allowedPaths = Array.from({length: count}, (_, index) => `src/file-${index}.ts`);
      const phase = withPaths(allowedPaths).phases[0];
      expect(phase.allowedPaths).toEqual(allowedPaths);
      expect(checkNativeCycleScope(phase, allowedPaths)).toBe(true);
      expect(checkNativeCycleScope(phase, ['src/outside.ts'])).toBe(false);
    }
    expect(() => withPaths(Array.from({length: 257}, (_, index) => `src/file-${index}.ts`))).toThrow();
    expect(() => withPaths([''])).toThrow();
  });

  it('preserves exact-path scope for every bounded authoring-sized path set', () => {
    fc.assert(
      fc.property(fc.integer({min: 129, max: 256}), count => {
        const allowedPaths = Array.from({length: count}, (_, index) => `src/file-${index}.ts`);
        const phase = decodeNativeCyclePlan(makePlan([{...makePlan().phases[0], allowedPaths}])).phases[0];
        expect(phase.allowedPaths).toEqual(allowedPaths);
        expect(checkNativeCycleScope(phase, allowedPaths)).toBe(true);
        expect(checkNativeCycleScope(phase, ['src/unlisted.ts'])).toBe(false);
      }),
      {numRuns: 24},
    );
  });

  it('permits a change set under empty scope exactly when the change set is empty', () => {
    const input = makePlan();
    const phase = decodeNativeCyclePlan(makePlan([{...input.phases[0], allowedPaths: []}])).phases[0];
    fc.assert(
      fc.property(fc.array(fc.string({maxLength: 64}), {maxLength: 16}), files => {
        expect(checkNativeCycleScope(phase, files)).toBe(files.length === 0);
      }),
      {numRuns: 100},
    );
  });

  it('matches the prior control-character policy for arbitrary UTF-16 strings', () => {
    fc.assert(
      fc.property(fc.array(fc.integer({min: 0, max: 0xffff}), {maxLength: 256}), codeUnits => {
        const value = String.fromCharCode(...codeUnits);
        const expected = (allowLineFeed: boolean) => {
          for (const character of value) {
            const code = Effect.pipe(
              character,
              EffectString.charCodeAt(0),
              Effect.Option.getOrElse(() => Number.NaN),
            );
            if ((code < 32 && !(allowLineFeed && code === 10)) || (code >= 127 && code <= 159)) return true;
          }
          return false;
        };
        expect(nativeCycleHasControl(value)).toBe(expected(false));
        expect(nativeCycleHasControl(value, true)).toBe(expected(true));
      }),
      {numRuns: 500},
    );
  });

  const before = {...decodeNativeCyclePlan(makePlan()).source, intentHash: digest};
  const after = {
    ...before,
    root: {...before.root, revision: S.repeat(64)('d')},
    documentHash: S.repeat(64)('e'),
    intentHash: S.repeat(64)('f'),
  };
  const amendment = {
    before,
    after,
    reason: 'Approved specification revision',
    userAuthority: 'Human approved the revision',
  };
  const amendedState = () => ({
    ...initializeNativeCycle(decodeNativeCyclePlan({...makePlan(), spec: after})),
    specAmendments: [amendment],
  });
  const runtimeEnvelope = (state: NativeCycleState) => ({
    state,
    plans: [state.plan],
    baselines: {},
    reviewLimits: {},
    reviewExpansions: [],
    snapshots: [],
    reviews: [],
    attempts: [],
  });

  it('round-trips bounded retained amendment history through state and runtime envelopes without mutation', () => {
    const without = initializeNativeCycle(decodeNativeCyclePlan(makePlan()));
    expect(decodeNativeCycleState(JSON.parse(JSON.stringify(without)))).toEqual(without);
    expect(decodeNativeCycleRuntime(JSON.parse(JSON.stringify(runtimeEnvelope(without))))).toEqual(
      runtimeEnvelope(without),
    );
    expect('specAmendments' in decodeNativeCycleState(without)).toBe(false);
    for (const count of [0, 1, 64]) {
      const state = {...amendedState(), specAmendments: Array.from({length: count}, () => amendment)};
      expect(decodeNativeCycleState(JSON.parse(JSON.stringify(state)))).toEqual(state);
      expect(decodeNativeCycleRuntime(JSON.parse(JSON.stringify(runtimeEnvelope(state))))).toEqual(
        runtimeEnvelope(state),
      );
    }
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            reason: fc.stringMatching(/^[A-Za-z][A-Za-z0-9 ._-]{0,63}$/u),
            userAuthority: fc.stringMatching(/^[A-Za-z][A-Za-z0-9 ._-]{0,63}$/u),
          }),
          {maxLength: 64},
        ),
        entries => {
          const state = {...amendedState(), specAmendments: A.map(entries, entry => ({before, after, ...entry}))};
          const original = JSON.stringify(state);
          const runtime = runtimeEnvelope(state);
          expect(decodeNativeCycleState(JSON.parse(original))).toEqual(state);
          expect(decodeNativeCycleRuntime(JSON.parse(JSON.stringify(runtime)))).toEqual(runtime);
          expect(JSON.stringify(state)).toBe(original);
          expect(nextNativeCycle(state)).toEqual(nextNativeCycle({...state, specAmendments: []}));
        },
      ),
      {numRuns: 48},
    );
  });

  it('preserves historical amendments in ordinary transitions while rejecting new specification changes', () => {
    const state = amendedState();
    const original = JSON.stringify(state);
    const validated = validateNativeCyclePhase(state, 'one', snapshot(), validation);
    expect(validated.specAmendments).toEqual(state.specAmendments);
    expect(invalidateNativeCycle(validated, 'one', 'Source changed').specAmendments).toEqual(state.specAmendments);
    const plan = decodeNativeCyclePlan({
      ...state.plan,
      phases: A.map(state.plan.phases, phase => (phase.id === 'two' ? {...phase, branch: 'feature/two-next'} : phase)),
    });
    expect(reconcileNativeCyclePlan(validated, plan, 'Branch metadata changed').state.specAmendments).toEqual(
      state.specAmendments,
    );
    expect(() =>
      reconcileNativeCyclePlan(
        state,
        decodeNativeCyclePlan({
          ...state.plan,
          spec: {...after, intentHash: digest},
        }),
        'Historical authority does not authorize a new amendment',
      ),
    ).toThrow('Plan reconciliation changes identity or spec.');
    expect(JSON.stringify(state)).toBe(original);
  });

  it('rejects oversized or malformed amendment history and keeps its nested fields closed', () => {
    const state = amendedState();
    expect(() =>
      decodeNativeCycleState({...state, specAmendments: Array.from({length: 65}, () => amendment)}),
    ).toThrow();
    for (const pin of [
      {...before, root: {...before.root, revision: 'bad'}},
      {...before, root: {...before.root, uri: 'file:///spec'}},
      {...before, root: {...before.root, memoryId: 'bad'}},
      {...before, binding: {...before.binding, bindingId: 'bad'}},
      {...before, binding: {...before.binding, profile: 'unknown'}},
      {...before, documentHash: 'bad'},
      {...before, intentHash: 'bad'},
      {...before, extra: true},
    ]) {
      expect(() => decodeNativeCycleState({...state, specAmendments: [{...amendment, before: pin}]})).toThrow();
      expect(() => decodeNativeCycleState({...state, specAmendments: [{...amendment, after: pin}]})).toThrow();
    }
    expect(() => decodeNativeCycleState({...state, specAmendments: [{...amendment, extra: true}]})).toThrow();
    for (const text of [
      '',
      '  ',
      '\n',
      'Reason\u0000',
      'Reason\u007f',
      'Reason\r',
      S.repeat(4097)('a'),
      S.repeat(1366)('界'),
    ]) {
      expect(() => decodeNativeCycleState({...state, specAmendments: [{...amendment, reason: text}]})).toThrow();
      expect(() => decodeNativeCycleState({...state, specAmendments: [{...amendment, userAuthority: text}]})).toThrow();
    }
    const bounded = {...amendment, reason: S.repeat(1365)('界'), userAuthority: 'Retained\napproval'};
    expect(decodeNativeCycleState({...state, specAmendments: [bounded]}).specAmendments).toEqual([bounded]);
  });

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
              definitionHash: Effect.pipe('3', EffectString.repeat(64)),
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
            ...EffectArray.map(entries, (entry, index) => ({
              id: `phase-${index}`,
              definitionHash: Effect.pipe('4', EffectString.repeat(64)),
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

  it('invalidates base-dependent acceptance while preserving generated delivery history and phase identity', () => {
    fc.assert(
      fc.property(fc.constantFrom('stable', 'prerelease', 'release'), baseBranch => {
        const delivered = recordNativeCycleDelivery(validateFirst(), 'one', prDelivery());
        const before = structuredClone(delivered);
        const plan = makePlan();
        plan.phases[0].baseBranch = baseBranch;
        const reconciled = reconcileNativeCyclePlan(delivered, decodeNativeCyclePlan(plan), 'Approved new PR base');
        expect(reconciled.affected).toEqual(['one', 'two']);
        for (const id of ['one', 'two']) {
          expect(reconciled.state.phases[id].status).toBe('stale');
          expect(reconciled.state.phases[id].phaseHash).toBe(before.phases[id].phaseHash);
          expect(reconciled.state.phases[id].validation).toBeUndefined();
          expect(reconciled.state.phases[id].delivery).toBeUndefined();
        }
        expect(reconciled.state.phases.one.history?.at(-1)).toMatchObject({
          delivery: before.phases.one.delivery,
          validation: before.phases.one.validation,
        });
        expect(nextNativeCycle(reconciled.state)).toEqual({
          action: 'blocked',
          phaseId: 'one',
          reason: 'Approved new PR base',
        });
        expect(delivered).toEqual(before);
      }),
      {numRuns: 12},
    );
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
      remoteCommit: Effect.pipe('d', EffectString.repeat(40)),
      evidence: 'Published shared feature memory.',
    };
    expect(validateNativeCycleFeaturePublication(receipt, {team: 'team-a', currentHead: gitSha})).toBe(true);
    expect(() =>
      validateNativeCycleFeaturePublication({...receipt, team: 'team-b'}, {team: 'team-a', currentHead: gitSha}),
    ).toThrow();
    expect(() =>
      validateNativeCycleFeaturePublication(
        {...receipt, currentHead: Effect.pipe('e', EffectString.repeat(40))},
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
      validation: {
        ...validation,
        acceptance: [{criterion: 'tested', result: 'passed', evidence: Effect.pipe('x', EffectString.repeat(1800))}],
      },
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
    const mainAgentCapacity = {...packetOptions.capacity, selection: 'main-agent'};
    expect(() => validateNativeCycleCapacityRecord(mainAgentCapacity)).toThrow('background worker');
    expect(Schema.is(NativeCyclePacketOptionsSchema)({...packetOptions, capacity: mainAgentCapacity})).toBe(false);
  });
});

/** Uses the existing pure cycle fixture; no provider, Git or Effect execution boundary. */
const supplementalFixture = () => {
  const plan = decodeNativeCyclePlan({...makePlan([makePlan().phases[0]]), delivery: 'local'});
  const phase = plan.phases[0];
  const validated = validateNativeCyclePhase(initializeNativeCycle(plan), phase.id, snapshot(), validation);
  const receipt = {
    phaseId: phase.id,
    phaseHash: validated.phases.one.phaseHash,
    delivery: 'local' as const,
    headSha: gitSha,
    validatedTree: gitTree,
  };
  const state = recordNativeCycleDelivery(validated, phase.id, receipt);
  const source = {head: gitSha, tree: gitTree, clean: true};
  const stored = {
    format: 'threadnote-native-cycle-snapshot' as const,
    version: 1 as const,
    snapshotId: 'accepted-one',
    phaseId: phase.id,
    phaseHash: receipt.phaseHash,
    repo: '/repo',
    head: gitSha,
    tree: gitTree,
    baseTree: gitSha,
    scopeBase: gitSha,
    declaredBaseHead: gitSha,
    files: ['src/a.ts'],
    scopeFiles: ['src/a.ts'],
    pinnedRef: 'refs/threadnote/snapshot/accepted-one',
  };
  const runtime: NativeCycleRuntime = {
    state,
    plans: [plan],
    baselines: {one: {repo: '/repo', head: gitSha, tree: gitSha, preservedFiles: [], pinnedRef: 'refs/heads/main'}},
    reviewLimits: {},
    reviewExpansions: [],
    snapshots: [{snapshot: stored, incoming: []}],
    attempts: [],
    reviews: [
      {
        snapshotId: stored.snapshotId,
        report: {
          snapshotId: stored.snapshotId,
          phaseHash: stored.phaseHash,
          snapshotTree: gitTree,
          status: 'complete',
          mode: 'full',
          selected: ['correctness', 'simplicity'],
          lanes: [
            {name: 'correctness', status: 'complete'},
            {name: 'simplicity', status: 'complete'},
          ],
          findings: [],
        },
      },
    ],
  };
  const hash = (value: unknown) => sha256HexSync(nativeCycleCanonicalJson(value));
  const initialization = {
    version: 1 as const,
    expectedRevision: nativeCycleSupplementalRevision(runtime),
    planDigest: hash(plan),
    phaseId: phase.id,
    phaseHash: receipt.phaseHash,
    snapshotId: stored.snapshotId,
    validationDigest: hash(state.phases.one.validation),
    localReceiptDigest: hash(receipt),
    head: gitSha,
    tree: gitTree,
    pr: {...prDelivery().pr, url: 'https://github.com/example/repo/pull/1'},
    authority: 'Attach this existing authorized PR to the completed local proof.',
  };
  return {runtime, source, initialization};
};
const supplementalRequest = (runtime: NativeCycleRuntime, event: unknown) => {
  const publication = runtime.state.supplementalPublications![0];
  return {
    publicationId: publication.publicationId,
    publicationRef: nativeCycleSupplementalRef(publication),
    expectedRevision: nativeCycleSupplementalRevision(runtime),
    event,
  };
};

describe('supplemental local publication proof', () => {
  it('retains exact legacy images and requires an explicitly versioned new variant', () => {
    const {runtime, initialization, source} = supplementalFixture();
    expect(decodeNativeCycleRuntime(runtime)).toEqual(runtime);
    const attached = initializeNativeCycleSupplementalPublication(runtime, initialization, source);
    expect(attached.state.version).toBe(2);
    const oldStateSchema = Schema.Struct({...NativeCycleStateSchema.fields, version: Schema.Literal(1)});
    expect(() => Schema.decodeUnknownSync(oldStateSchema)(attached.state)).toThrow();
    expect(() => decodeNativeCycleRuntime({...attached, state: {...attached.state, version: 1}})).toThrow();
    const entry = attached.state.supplementalPublications![0];
    expect(() =>
      decodeNativeCycleRuntime({
        ...attached,
        state: {
          ...attached.state,
          supplementalPublications: [{...entry, initialization: {...entry.initialization, version: 2}}],
        },
      }),
    ).toThrow();
    expect(() =>
      appendNativeCycleSupplementalRecord(attached, supplementalRequest(attached, {kind: 'unknown'}), source),
    ).toThrow();
  });

  it('refuses stale refs, dirty or changed source, incomplete or mismatched local proof and blank authority', () => {
    const {runtime, initialization, source} = supplementalFixture();
    for (const input of [
      {...initialization, expectedRevision: digest},
      {...initialization, planDigest: digest},
      {...initialization, phaseHash: digest},
      {...initialization, snapshotId: 'missing'},
      {...initialization, validationDigest: digest},
      {...initialization, localReceiptDigest: digest},
      {...initialization, authority: ' '},
      {...initialization, pr: {...initialization.pr, headSha: gitTree}},
      {...initialization, pr: {...initialization.pr, baseBranch: 'other'}},
    ])
      expect(() => initializeNativeCycleSupplementalPublication(runtime, input, source)).toThrow();
    for (const observed of [
      {...source, clean: false},
      {...source, head: gitTree},
      {...source, tree: gitSha},
    ])
      expect(() => initializeNativeCycleSupplementalPublication(runtime, initialization, observed)).toThrow();
    expect(() =>
      initializeNativeCycleSupplementalPublication({...runtime, reviews: []}, initialization, source),
    ).toThrow();
    expect(() =>
      initializeNativeCycleSupplementalPublication(
        {
          ...runtime,
          state: {
            ...runtime.state,
            phases: {...runtime.state.phases, one: {...runtime.state.phases.one, delivery: undefined}},
          },
        },
        initialization,
        source,
      ),
    ).toThrow();
    expect(runtime.state.version).toBe(1);
  });

  it('appends verified completion, watch and merge proof with exact replay while preserving original evidence', () => {
    const {runtime, initialization, source} = supplementalFixture();
    let current = initializeNativeCycleSupplementalPublication(runtime, initialization, source);
    expect(initializeNativeCycleSupplementalPublication(current, initialization, source)).toEqual(current);
    expect(() =>
      appendNativeCycleSupplementalRecord(
        current,
        supplementalRequest(current, {kind: 'completed', evidence: 'complete'}),
        source,
      ),
    ).toThrow();
    const verification = supplementalRequest(current, {
      kind: 'provider-verified',
      pr: initialization.pr,
      evidence: 'Independent provider readback of the authorized existing PR.',
    });
    current = appendNativeCycleSupplementalRecord(current, verification, source);
    const watch = {...prDelivery().watch!, prUrl: initialization.pr.url};
    const watching = supplementalRequest(current, {kind: 'watch', watch});
    current = appendNativeCycleSupplementalRecord(current, watching, source);
    const completion = supplementalRequest(current, {
      kind: 'completed',
      evidence: 'Publication is verified and owned watch is active.',
    });
    current = appendNativeCycleSupplementalRecord(current, completion, source);
    current = appendNativeCycleSupplementalRecord(
      current,
      supplementalRequest(current, {
        kind: 'merged',
        mergeCommit: gitTree,
        evidence: 'Provider confirms merge of the bound head.',
      }),
      source,
    );
    current = appendNativeCycleSupplementalRecord(
      current,
      supplementalRequest(current, {kind: 'watch', watch: {...watch, state: 'terminal'}}),
      source,
    );
    expect(appendNativeCycleSupplementalRecord(current, verification, source)).toEqual(current);
    expect(appendNativeCycleSupplementalRecord(current, completion, source)).toEqual(current);
    expect(initializeNativeCycleSupplementalPublication(current, initialization, source)).toEqual(current);
    expect(() =>
      appendNativeCycleSupplementalRecord(
        current,
        {...watching, event: {kind: 'watch', watch: {...watch, evidence: 'changed'}}},
        source,
      ),
    ).toThrow();
    expect(() =>
      appendNativeCycleSupplementalRecord(
        current,
        {...supplementalRequest(current, {kind: 'completed', evidence: 'again'}), publicationRef: digest},
        source,
      ),
    ).toThrow();
    const {supplementalPublications, version: _version, ...retainedState} = current.state;
    const {version: _legacyVersion, ...originalState} = runtime.state;
    expect(retainedState).toEqual(originalState);
    const {state: _state, ...retainedRuntime} = current;
    const {state: _original, ...originalRuntime} = runtime;
    expect(retainedRuntime).toEqual(originalRuntime);
    expect(supplementalPublications![0].initialization).toEqual(initialization);
    expect(EffectArray.map(supplementalPublications![0].records, record => record.event.kind)).toEqual([
      'provider-verified',
      'watch',
      'completed',
      'merged',
      'watch',
    ]);
    expect(nextNativeCycle(current.state)).toEqual({action: 'complete'});
    const entry = supplementalPublications![0];
    const records = [...entry.records];
    records[1] = {...records[1], previousRef: digest};
    expect(() =>
      decodeNativeCycleRuntime({
        ...current,
        state: {...current.state, supplementalPublications: [{...entry, records}]},
      }),
    ).toThrow();
  });
});
