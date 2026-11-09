import {Array as EffectArray, String as EffectString, Option as EffectOption} from 'effect';
import {Schema} from 'effect';
import fc from 'fast-check';
import {decodeNativeCycleRuntime, nativeCyclePhaseReviewUsage, type NativeCycleRuntime} from '../src/cycle_runtime.js';
import {describe, expect, it} from 'vitest';
import {decodeNativeCyclePlan, nativeCyclePhaseHash, initializeNativeCycle} from '../src/cycle.js';
import {NativeCycleSnapshotSchema, validateNativeCycleReview, type NativeCycleSnapshot} from '../src/cycle_review.js';
import {
  nativeCycleMergeReceiptDigest,
  nativeCycleQualificationEvidenceDigest,
  nativeCycleQualificationHistory,
  nativeCycleSameLabelRebasedBaseReceiptDigest,
  validateNativeCycleSameLabelRebasedBaseReceipt,
  type NativeCycleSameLabelRebasedBaseReceipt,
  validateNativeCycleMergeOwners,
  validateNativeCycleMergeReceipt,
  type NativeCycleOrdinaryMergeReceipt,
} from '../src/cycle_merge.js';

const hash = (value: string) => EffectString.repeat(64)(value);
const object = (value: string) => EffectString.repeat(40)(value);
const entry = (value: string, mode = '100644') => ({mode, blob: object(value)});
function fixture(owned = ['owned.ts'], inherited = ['upstream.ts']) {
  const plan = decodeNativeCyclePlan({
    format: 'threadnote-native-cycle-plan',
    version: 1,
    featureId: 'feature',
    project: 'fixture',
    objective: 'Integrate reviewed work',
    delivery: 'local',
    source: {
      root: {uri: 'threadnote://user/me/plan', memoryId: 'tn_fixture', revision: hash('a')},
      binding: {bindingId: hash('a'), runId: 'run', generation: 'gen', profile: 'desktop'},
      documentHash: hash('a'),
    },
    completion: {},
    phases: [
      {
        id: 'one',
        definitionHash: hash('b'),
        title: 'One',
        dependsOn: [],
        allowedPaths: owned,
        acceptanceCriteria: ['works'],
        safeToMergeReason: 'Reviewed',
        branch: 'feature/one',
        baseBranch: 'main',
        status: 'pending',
        acceptanceRefs: [{id: 'a1', criterion: 'works', requirements: ['r'], specScenarios: []}],
      },
    ],
  });
  const prior: NativeCycleSnapshot = {
    format: 'threadnote-native-cycle-snapshot',
    version: 1,
    snapshotId: 'prior',
    phaseId: 'one',
    phaseHash: nativeCyclePhaseHash(plan, 'one'),
    repo: '/fixture',
    head: object('1'),
    tree: object('2'),
    baseTree: object('3'),
    scopeBase: object('3'),
    declaredBaseHead: object('4'),
    files: owned,
    scopeFiles: owned,
    pinnedRef: 'refs/threadnote/cycles/snapshot/' + hash('1'),
  };
  const snapshot: NativeCycleSnapshot = {
    ...prior,
    version: 2,
    snapshotId: 'new',
    head: object('5'),
    tree: object('6'),
    scopeBase: object('7'),
    declaredBaseHead: object('8'),
    acceptedHead: object('5'),
    previous: 'prior',
    previousTree: prior.tree,
    files: [...owned, ...inherited].sort(),
    scopeFiles: owned,
    pinnedRef: 'refs/threadnote/cycles/snapshot/' + hash('2'),
  };
  const evidence = (paths: readonly string[], upstream: boolean) =>
    EffectArray.map(paths, path => ({
      path,
      baseline: entry('a'),
      oldBase: entry('a'),
      currentBase: entry('b'),
      head: entry(upstream ? 'b' : 'c'),
    }));
  const receipt: NativeCycleOrdinaryMergeReceipt = {
    format: 'threadnote-native-ordinary-merge-qualification',
    version: 1,
    priorHead: prior.head,
    currentBaseHead: snapshot.declaredBaseHead,
    currentHead: snapshot.head,
    fromBaseBranch: 'main',
    toBaseBranch: 'main',
    planDocumentHash: plan.source.documentHash,
    phaseOwnedPaths: [{phaseId: 'one', paths: owned}],
    priorSnapshotId: prior.snapshotId,
    priorTree: prior.tree,
    priorDeclaredBaseHead: prior.declaredBaseHead,
    priorDeclaredBaseTree: prior.scopeBase,
    currentBaseTree: snapshot.scopeBase,
    baselineHead: object('4'),
    expectedRevision: hash('3'),
    reason: 'Ordinary integration',
    authority: 'Reviewed amendment',
    capturedBaselinePaths: snapshot.files,
    currentBaseChangedPaths: owned,
    inheritedUpstreamOnlyPaths: inherited,
    currentBaseEvidence: evidence(owned, false),
    upstreamEvidence: evidence(inherited, true),
    mergeBases: {bases: prior.declaredBaseHead, prior: prior.head, current: snapshot.declaredBaseHead},
    priorHeadRef: 'refs/threadnote/cycles/merge-prior/' + hash('1'),
    currentHeadRef: 'refs/threadnote/cycles/merge-head/' + hash('1'),
    priorBaseRef: 'refs/threadnote/cycles/merge-old-base/' + hash('1'),
    currentBaseRef: 'refs/threadnote/cycles/merge-base/' + hash('1'),
    receiptDigest: hash('0'),
  };
  const seal = (value = receipt): NativeCycleSnapshot => ({
    ...snapshot,
    ordinaryMergeQualificationV1: {...value, receiptDigest: nativeCycleMergeReceiptDigest(snapshot, value)},
  });
  const validate = (value: NativeCycleSnapshot) => validateNativeCycleMergeReceipt(value, prior, [plan], object('4'));
  return {plan, prior, snapshot: seal(), receipt, seal, validate};
}

describe('ordinary merge qualification contract', () => {
  it('round trips the closed version2 proof and fails closed for legacy readers and unknown receipt fields', () => {
    const f = fixture();
    expect(
      Schema.decodeUnknownSync(NativeCycleSnapshotSchema, {onExcessProperty: 'error'})(
        JSON.parse(JSON.stringify(f.snapshot)),
      ),
    ).toEqual(f.snapshot);
    expect(() => Schema.decodeUnknownSync(Schema.Struct({version: Schema.Literal(1)}))(f.snapshot)).toThrow();
    expect(() => Schema.decodeSync(NativeCycleSnapshotSchema)({...f.snapshot, version: 1})).toThrow();
    expect(() =>
      Schema.decodeSync(NativeCycleSnapshotSchema)({...f.snapshot, ordinaryMergeQualificationV1: undefined}),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(NativeCycleSnapshotSchema, {onExcessProperty: 'error'})({
        ...f.snapshot,
        ordinaryMergeQualificationV1: {...f.snapshot.ordinaryMergeQualificationV1, omittedCapability: true},
      }),
    ).toThrow();
    expect(() => f.validate(f.snapshot)).not.toThrow();
  });

  it('requires every explicit shared owner and never expands permissions from inherited paths or globs', () => {
    const f = fixture();
    const input = f.receipt;
    const shared = {...f.plan, phases: [...f.plan.phases, {...f.plan.phases[0], id: 'two'}]};
    expect(() => validateNativeCycleMergeOwners(shared, input, ['owned.ts'])).toThrow();
    expect(() =>
      validateNativeCycleMergeOwners(
        shared,
        {...input, phaseOwnedPaths: [...input.phaseOwnedPaths, {phaseId: 'two', paths: ['owned.ts']}]},
        ['owned.ts'],
      ),
    ).not.toThrow();
    expect(() =>
      validateNativeCycleMergeOwners(f.plan, {...input, phaseOwnedPaths: [{phaseId: 'one', paths: ['upstream.ts']}]}, [
        'owned.ts',
      ]),
    ).toThrow();
    expect(() =>
      validateNativeCycleMergeOwners({...f.plan, phases: [{...f.plan.phases[0], allowedPaths: ['*.ts']}]}, input, [
        'owned.ts',
      ]),
    ).toThrow();
    expect(() =>
      validateNativeCycleMergeOwners(f.plan, {...input, planDocumentHash: hash('f')}, ['owned.ts']),
    ).toThrow();
  });

  it('requires full current-base review while preserving prior blockers', () => {
    const f = fixture();
    const review = {
      snapshotId: f.prior.snapshotId,
      phaseHash: f.prior.phaseHash,
      snapshotTree: f.prior.tree,
      status: 'complete' as const,
      mode: 'full' as const,
      selected: ['correctness', 'simplicity'],
      lanes: [
        {name: 'correctness', status: 'complete' as const},
        {name: 'simplicity', status: 'complete' as const},
      ],
      findings: [],
    };
    const current = {...review, snapshotId: f.snapshot.snapshotId, snapshotTree: f.snapshot.tree};
    expect(() => validateNativeCycleReview(f.snapshot, current, {snapshot: f.prior, review})).not.toThrow();
    expect(() =>
      validateNativeCycleReview(f.snapshot, {...current, mode: 'incremental'}, {snapshot: f.prior, review}),
    ).toThrow();
    const finding = {
      id: 'F1',
      file: 'owned.ts',
      line: 1,
      body: 'Still broken',
      trigger: 'Use the changed path',
      impact: 'The operation fails',
      evidence: 'Private fixture',
      severity: 'important' as const,
      category: 'correctness' as const,
      confidence: 99,
      state: 'new' as const,
    };
    const blocked = {...review, findings: [finding]};
    expect(() => validateNativeCycleReview(f.snapshot, current, {snapshot: f.prior, review: blocked})).toThrow();
    expect(() =>
      validateNativeCycleReview(
        f.snapshot,
        {...current, findings: [{...finding, state: 'carried'}]},
        {snapshot: f.prior, review: blocked},
      ),
    ).not.toThrow();
  });

  it('conserves arbitrary disjoint partitions and rejects omission, overlap, body and mode laundering even with a recomputed digest', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.integer({min: 0, max: 99}), {minLength: 2, maxLength: 16}),
        fc.nat(),
        (values, split) => {
          const paths = EffectArray.map(
            values,
            value => `src/p${EffectString.padStart(2, '0')(String(value))}.ts`,
          ).sort();
          const cut = 1 + (split % (paths.length - 1));
          const f = fixture(paths.slice(0, cut), paths.slice(cut));
          expect(() => f.validate(f.snapshot)).not.toThrow();
          expect(() =>
            f.validate(
              f.seal({...f.receipt, inheritedUpstreamOnlyPaths: f.receipt.inheritedUpstreamOnlyPaths.slice(1)}),
            ),
          ).toThrow();
          expect(() =>
            f.validate(
              f.seal({
                ...f.receipt,
                inheritedUpstreamOnlyPaths: [
                  ...f.receipt.currentBaseChangedPaths,
                  ...f.receipt.inheritedUpstreamOnlyPaths,
                ].sort(),
              }),
            ),
          ).toThrow();
          for (const forged of [entry('d'), entry('b', '100755')]) {
            const changed = EffectArray.map(f.receipt.upstreamEvidence, (item, index) =>
              index ? item : {...item, head: forged},
            );
            expect(() => f.validate(f.seal({...f.receipt, upstreamEvidence: changed}))).toThrow();
          }
          expect(f.snapshot.ordinaryMergeQualificationV1?.phaseOwnedPaths[0].paths).toEqual(paths.slice(0, cut));
        },
      ),
      {numRuns: 40},
    );
  });
});

function rewrittenBaseFixture() {
  const f = fixture();
  const priorReview = {
    snapshotId: f.prior.snapshotId,
    phaseHash: f.prior.phaseHash,
    snapshotTree: f.prior.tree,
    status: 'complete' as const,
    mode: 'full' as const,
    selected: ['correctness', 'simplicity'],
    lanes: [
      {name: 'correctness', status: 'complete' as const},
      {name: 'simplicity', status: 'complete' as const},
    ],
    findings: [],
  };
  const runtime: NativeCycleRuntime = {
    state: initializeNativeCycle(f.plan),
    plans: [f.plan],
    baselines: {
      one: {
        repo: f.prior.repo,
        head: object('4'),
        tree: f.prior.baseTree,
        preservedFiles: [],
        pinnedRef: 'refs/threadnote/cycles/baseline/' + hash('3'),
      },
    },
    snapshots: [{snapshot: f.prior, incoming: []}],
    reviews: [{snapshotId: f.prior.snapshotId, report: priorReview}],
    attempts: [
      {
        id: 'prior-attempt',
        snapshotId: f.prior.snapshotId,
        digest: hash('1'),
        status: 'accepted',
        message: '',
        report: '{}',
      },
    ],
    reviewLimits: {one: 10},
    reviewExpansions: [{phaseId: 'one', from: 5, to: 10, authority: 'Continue existing review rounds'}],
  };
  const {ordinaryMergeQualificationV1: _legacy, ...source} = f.snapshot;
  const snapshot: NativeCycleSnapshot = {...source, version: 3};
  const proof: NativeCycleSameLabelRebasedBaseReceipt = {
    ...f.receipt,
    format: 'threadnote-native-same-label-rebased-base-integration',
    independentReviewRequired: true,
    runId: 'run',
    generation: 'gen',
    bindingId: f.plan.source.binding.bindingId,
    project: f.plan.project,
    repo: f.prior.repo,
    worktreeDirectory: f.prior.repo,
    commonDirectory: '/fixture/.git',
    gitDirectory: '/fixture/.git',
    phaseBranch: f.plan.phases[0].branch,
    priorScopeBase: f.prior.scopeBase,
    priorPinnedRef: f.prior.pinnedRef,
    priorScopeRef: 'refs/threadnote/cycles/merge-scope/' + hash('4'),
    baselineTree: f.prior.baseTree,
    baselinePinnedRef: runtime.baselines.one.pinnedRef,
    priorSnapshotId: f.prior.snapshotId,
    expectedPriorEntryDigest: nativeCycleQualificationEvidenceDigest('predecessor-entry', runtime.snapshots[0]),
    expectedPriorReviewDigest: nativeCycleQualificationEvidenceDigest('predecessor-review', runtime.reviews[0]),
    sameBaseBranch: 'main',
    authorityKind: 'same-label-upstream-rebase-integration',
    history: nativeCycleQualificationHistory(runtime),
    historicalMergeBases: [object('9')],
    mergeBases: {prior: f.prior.head, current: f.snapshot.declaredBaseHead},
    sourceEvidence: [],
    reconciliationPaths: ['staged-only.ts'],
    reconciliationEvidence: [
      {
        path: 'staged-only.ts',
        baseline: entry('0', '000000'),
        declaredBase: entry('0', '000000'),
        priorScope: entry('0', '000000'),
        prior: entry('a'),
        currentBase: entry('0', '000000'),
        head: entry('0', '000000'),
      },
    ],
  };
  const absent = entry('0', '000000');
  const sourceEvidence = EffectArray.map([...snapshot.files, 'staged-only.ts'].sort(), path => {
    const current = EffectOption.getOrUndefined(
      EffectArray.findFirst([...proof.currentBaseEvidence, ...proof.upstreamEvidence], item => item.path === path),
    );
    return current
      ? {
          path,
          baseline: current.baseline,
          declaredBase: absent,
          priorScope: current.oldBase,
          prior: current.head,
          currentBase: current.currentBase,
          head: current.head,
        }
      : proof.reconciliationEvidence[0];
  });
  const completeProof = {...proof, sourceEvidence};
  const seal = (receipt = completeProof) => ({
    ...snapshot,
    sameLabelRebasedBaseIntegrationV1: {
      ...receipt,
      receiptDigest: nativeCycleSameLabelRebasedBaseReceiptDigest(snapshot, receipt),
    },
  });
  const current = seal();
  const completed: NativeCycleRuntime = {
    ...runtime,
    snapshots: [
      ...runtime.snapshots,
      {
        snapshot: current,
        incoming: EffectArray.map(f.receipt.upstreamEvidence, item => ({
          path: item.path,
          source: 'upstream' as const,
          tree: current.scopeBase,
          commit: current.declaredBaseHead,
          ...item.head,
        })),
      },
    ],
  };
  return {...f, runtime, completed, current, proof: completeProof, seal, priorReview};
}

function ordinaryContinuation(baseline = entry('a'), head = entry('b')) {
  const f = rewrittenBaseFixture();
  const proof = {
    ...f.proof,
    upstreamEvidence: EffectArray.map(f.proof.upstreamEvidence, item => ({...item, baseline, currentBase: head, head})),
    sourceEvidence: EffectArray.map(f.proof.sourceEvidence, item =>
      item.path === 'upstream.ts' ? {...item, baseline, prior: head, currentBase: head, head} : item,
    ),
  };
  const prior = f.seal(proof);
  const snapshot: NativeCycleSnapshot = {
    ...f.snapshot,
    snapshotId: 'continued',
    head: object('c'),
    tree: object('d'),
    declaredBaseHead: object('e'),
    scopeBase: object('f'),
    acceptedHead: object('c'),
    previous: prior.snapshotId,
    previousTree: prior.tree,
  };
  const receipt: NativeCycleOrdinaryMergeReceipt = {
    ...f.receipt,
    priorSnapshotId: prior.snapshotId,
    priorHead: prior.head,
    priorTree: prior.tree,
    priorDeclaredBaseHead: prior.declaredBaseHead,
    priorDeclaredBaseTree: prior.scopeBase,
    currentBaseHead: snapshot.declaredBaseHead,
    currentBaseTree: snapshot.scopeBase,
    currentHead: snapshot.head,
    mergeBases: {bases: prior.declaredBaseHead, prior: prior.head, current: snapshot.declaredBaseHead},
    upstreamEvidence: EffectArray.map(proof.upstreamEvidence, item => ({...item, oldBase: head})),
  };
  const seal = (value = receipt): NativeCycleSnapshot => ({
    ...snapshot,
    ordinaryMergeQualificationV1: {...value, receiptDigest: nativeCycleMergeReceiptDigest(snapshot, value)},
  });
  const runtime: NativeCycleRuntime = {
    ...f.completed,
    snapshots: [
      ...f.runtime.snapshots,
      {
        snapshot: prior,
        incoming: [
          {path: 'upstream.ts', source: 'upstream', tree: prior.scopeBase, commit: prior.declaredBaseHead, ...head},
        ],
      },
      {
        snapshot: seal(),
        incoming: [
          {
            path: 'upstream.ts',
            source: 'upstream',
            tree: snapshot.scopeBase,
            commit: snapshot.declaredBaseHead,
            ...head,
          },
        ],
      },
    ],
    reviews: [
      ...f.completed.reviews,
      {
        snapshotId: prior.snapshotId,
        report: {...f.priorReview, snapshotId: prior.snapshotId, snapshotTree: prior.tree},
      },
    ],
  };
  return {
    ...f,
    prior,
    snapshot: seal(),
    receipt,
    seal,
    runtime,
    validate: (value = seal(), predecessor: NativeCycleSnapshot = prior) =>
      validateNativeCycleMergeReceipt(value, predecessor, [f.plan], object('4')),
  };
}

function repeatedOrdinaryContinuation(f: ReturnType<typeof ordinaryContinuation>) {
  const prior = f.snapshot;
  const snapshot: NativeCycleSnapshot = {
    ...prior,
    snapshotId: 'continued-again',
    head: object('7'),
    tree: object('8'),
    declaredBaseHead: object('9'),
    scopeBase: object('6'),
    acceptedHead: object('7'),
    previous: prior.snapshotId,
    previousTree: prior.tree,
  };
  const receipt: NativeCycleOrdinaryMergeReceipt = {
    ...f.receipt,
    priorSnapshotId: prior.snapshotId,
    priorHead: prior.head,
    priorTree: prior.tree,
    priorDeclaredBaseHead: prior.declaredBaseHead,
    priorDeclaredBaseTree: prior.scopeBase,
    currentBaseHead: snapshot.declaredBaseHead,
    currentBaseTree: snapshot.scopeBase,
    currentHead: snapshot.head,
    mergeBases: {bases: prior.declaredBaseHead, prior: prior.head, current: snapshot.declaredBaseHead},
    upstreamEvidence: EffectArray.map(f.receipt.upstreamEvidence, item => ({...item, oldBase: item.currentBase})),
  };
  const seal = (value = receipt): NativeCycleSnapshot => ({
    ...snapshot,
    ordinaryMergeQualificationV1: {...value, receiptDigest: nativeCycleMergeReceiptDigest(snapshot, value)},
  });
  const runtime: NativeCycleRuntime = {
    ...f.runtime,
    snapshots: [
      ...f.runtime.snapshots,
      {
        snapshot: seal(),
        incoming: EffectArray.map(f.runtime.snapshots[2].incoming, item => ({
          ...item,
          tree: snapshot.scopeBase,
          commit: snapshot.declaredBaseHead,
        })),
      },
    ],
    reviews: [
      ...f.runtime.reviews,
      {
        snapshotId: prior.snapshotId,
        report: {...f.priorReview, snapshotId: prior.snapshotId, snapshotTree: prior.tree},
      },
    ],
  };
  return {
    prior,
    snapshot: seal(),
    receipt,
    seal,
    runtime,
    validate: (value = seal(), predecessor = prior, plans = [f.plan]) =>
      validateNativeCycleMergeReceipt(value, predecessor, plans, object('4')),
  };
}

describe('same-label rewritten-base qualification contract', () => {
  it.each([
    {kind: 'existing', baseline: entry('a'), head: entry('b')},
    {kind: 'added', baseline: entry('0', '000000'), head: entry('b')},
    {kind: 'deleted', baseline: entry('a'), head: entry('0', '000000')},
  ])('continues validated ordinary $kind inheritance through repeated advances', ({baseline, head}) => {
    const f = ordinaryContinuation(baseline, head);
    expect(() => decodeNativeCycleRuntime(JSON.parse(JSON.stringify(f.runtime)))).not.toThrow();
    const repeated = repeatedOrdinaryContinuation(f);
    expect(() => decodeNativeCycleRuntime(JSON.parse(JSON.stringify(repeated.runtime)))).not.toThrow();
    expect(() => repeated.validate()).not.toThrow();
  });

  it('refuses malformed or foreign immediate ordinary evidence without falling back to older inheritance', () => {
    const f = ordinaryContinuation();
    const repeated = repeatedOrdinaryContinuation(f);
    const prior = repeated.prior;
    const proof = f.receipt;
    const runtimeWithPrior = (snapshot: NativeCycleSnapshot) => ({
      ...repeated.runtime,
      snapshots: EffectArray.map(repeated.runtime.snapshots, item =>
        item.snapshot.snapshotId === prior.snapshotId ? {...item, snapshot} : item,
      ),
    });
    for (const patch of [
      {upstreamEvidence: []},
      {
        upstreamEvidence: [...proof.upstreamEvidence, ...proof.upstreamEvidence],
        inheritedUpstreamOnlyPaths: [...proof.inheritedUpstreamOnlyPaths, ...proof.inheritedUpstreamOnlyPaths],
      },
      {upstreamEvidence: [], inheritedUpstreamOnlyPaths: []},
      {baselineHead: object('f')},
      {currentHead: object('f')},
      {currentBaseHead: object('f')},
      {currentBaseTree: object('5')},
      {planDocumentHash: hash('f')},
      {
        upstreamEvidence: EffectArray.map(proof.upstreamEvidence, item => ({
          ...item,
          currentBase: entry('d'),
          head: entry('d'),
        })),
      },
      {
        upstreamEvidence: EffectArray.map(proof.upstreamEvidence, item => ({
          ...item,
          currentBase: entry('b', '100755'),
          head: entry('b', '100755'),
        })),
      },
    ]) {
      const changed = {...proof, ...patch};
      const predecessor = {
        ...prior,
        ordinaryMergeQualificationV1: {...changed, receiptDigest: nativeCycleMergeReceiptDigest(prior, changed)},
      };
      expect(() => repeated.validate(repeated.snapshot, predecessor)).toThrow();
      expect(() => decodeNativeCycleRuntime(runtimeWithPrior(predecessor))).toThrow();
    }
    for (const predecessor of [
      {...prior, ordinaryMergeQualificationV1: undefined},
      {...prior, ordinaryMergeQualificationV1: {...proof, receiptDigest: hash('f')}},
    ])
      expect(() => decodeNativeCycleRuntime(runtimeWithPrior(predecessor))).toThrow();
    for (const binding of [
      {...f.plan.source.binding, runId: 'other'},
      {...f.plan.source.binding, generation: 'other'},
      {...f.plan.source.binding, bindingId: hash('f')},
    ]) {
      const plan = {...f.plan, source: {...f.plan.source, documentHash: hash('c'), binding}};
      expect(() =>
        repeated.validate(repeated.seal({...repeated.receipt, planDocumentHash: plan.source.documentHash}), prior, [
          f.plan,
          plan,
        ]),
      ).toThrow();
    }
  });

  it('carries unchanged validated manifest3 inherited existing, added and deleted entries into an ordinary advance', () => {
    for (const [baseline, head] of [
      [entry('a'), entry('b')],
      [entry('0', '000000'), entry('b')],
      [entry('a'), entry('0', '000000')],
    ]) {
      const f = ordinaryContinuation(baseline, head);
      expect(() => f.validate()).not.toThrow();
      expect(() => decodeNativeCycleRuntime(JSON.parse(JSON.stringify(f.runtime)))).not.toThrow();
    }
    const f = ordinaryContinuation();
    const plan = {
      ...f.plan,
      source: {...f.plan.source, documentHash: hash('c')},
      phases: [{...f.plan.phases[0], definitionHash: hash('c'), baseBranch: 'stack'}],
    };
    const {previous: _previous, previousTree: _tree, ...source} = f.snapshot;
    const snapshot = {...source, phaseHash: nativeCyclePhaseHash(plan, 'one'), supersedes: f.prior.snapshotId};
    const proof = {...f.receipt, planDocumentHash: plan.source.documentHash, toBaseBranch: 'stack'};
    const continued = {
      ...snapshot,
      ordinaryMergeQualificationV1: {...proof, receiptDigest: nativeCycleMergeReceiptDigest(snapshot, proof)},
    };
    expect(snapshot.phaseHash).not.toBe(f.prior.phaseHash);
    expect(() => validateNativeCycleMergeReceipt(continued, f.prior, [f.plan, plan], object('4'))).not.toThrow();
  });

  it('refuses carry-forward without exact inherited predecessor evidence and unchanged mode/blob identities', () => {
    const f = ordinaryContinuation();
    const priorProof = f.prior.sameLabelRebasedBaseIntegrationV1;
    for (const predecessor of [
      {...f.prior, version: 1 as const, sameLabelRebasedBaseIntegrationV1: undefined},
      {...f.prior, phaseId: 'other'},
      {...f.prior, repo: '/other'},
      {...f.prior, baseTree: object('f')},
      {...f.prior, snapshotId: 'other'},
    ])
      expect(() => f.validate(f.snapshot, predecessor)).toThrow();
    for (const patch of [
      {upstreamEvidence: []},
      {upstreamEvidence: [...priorProof.upstreamEvidence, ...priorProof.upstreamEvidence]},
      {upstreamEvidence: [], inheritedUpstreamOnlyPaths: []},
      {baselineHead: object('f')},
      {baselineTree: object('f')},
      {currentHead: object('f')},
      {currentBaseHead: object('f')},
      {currentBaseTree: object('f')},
      {planDocumentHash: hash('f')},
      {runId: 'other'},
      {generation: 'other'},
      {bindingId: hash('f')},
    ]) {
      const changed = {...priorProof, ...patch};
      const predecessor = {
        ...f.prior,
        sameLabelRebasedBaseIntegrationV1: {
          ...changed,
          receiptDigest: nativeCycleSameLabelRebasedBaseReceiptDigest(f.prior, changed),
        },
      };
      expect(() => f.validate(f.snapshot, predecessor)).toThrow();
    }
    for (const key of ['baseline', 'currentBase', 'head'] as const)
      for (const value of [entry('d'), entry('b', '100755')]) {
        const upstreamEvidence = EffectArray.map(f.receipt.upstreamEvidence, item => ({...item, [key]: value}));
        expect(() => f.validate(f.seal({...f.receipt, upstreamEvidence}))).toThrow();
      }
    for (const value of [entry('d'), entry('b', '100755')]) {
      const upstreamEvidence = EffectArray.map(f.receipt.upstreamEvidence, item => ({
        ...item,
        oldBase: value,
        currentBase: value,
        head: value,
      }));
      expect(() => f.validate(f.seal({...f.receipt, upstreamEvidence}))).toThrow();
    }
    expect(() => ordinaryContinuation(entry('b'), entry('b')).validate()).toThrow();
    expect(() =>
      decodeNativeCycleRuntime({
        ...f.runtime,
        snapshots: [
          f.runtime.snapshots[0],
          {
            ...f.runtime.snapshots[1],
            snapshot: {...f.prior, sameLabelRebasedBaseIntegrationV1: {...priorProof, receiptDigest: hash('f')}},
          },
          f.runtime.snapshots[2],
        ],
      }),
    ).toThrow();
    // Resealing cannot turn a tampered historical proof into validated runtime authority.
    const changed = {...priorProof, sourceEvidence: priorProof.sourceEvidence.slice(1)};
    const forged = {
      ...f.prior,
      sameLabelRebasedBaseIntegrationV1: {
        ...changed,
        receiptDigest: nativeCycleSameLabelRebasedBaseReceiptDigest(f.prior, changed),
      },
    };
    expect(() =>
      decodeNativeCycleRuntime({
        ...f.runtime,
        snapshots: [f.runtime.snapshots[0], {...f.runtime.snapshots[1], snapshot: forged}, f.runtime.snapshots[2]],
      }),
    ).toThrow();
  });

  it('round trips manifest3, rejects old readers and conflicting witnesses, and retains independent staged reconciliation', () => {
    const f = rewrittenBaseFixture();
    const decoded = Schema.decodeUnknownSync(NativeCycleSnapshotSchema, {onExcessProperty: 'error'})(
      JSON.parse(JSON.stringify(f.current)),
    );
    expect(decoded).toEqual(f.current);
    expect(() => decodeNativeCycleRuntime(JSON.parse(JSON.stringify(f.completed)))).not.toThrow();
    expect(() => Schema.decodeUnknownSync(Schema.Struct({version: Schema.Literals([1, 2])}))(decoded)).toThrow();
    for (const change of [
      {version: 2},
      {version: 1},
      {ordinaryMergeQualificationV1: f.receipt},
      {sameLabelRebasedBaseIntegrationV1: undefined},
    ])
      expect(() => Schema.decodeUnknownSync(NativeCycleSnapshotSchema)({...decoded, ...change})).toThrow();
    const {previous: _previous, previousTree: _previousTree, ...source} = f.current;
    expect(() =>
      Schema.decodeSync(NativeCycleSnapshotSchema)({
        ...source,
        supersedes: f.prior.snapshotId,
        unreviewedSupersession: {reason: 'New source before review'},
      }),
    ).toThrow();
    expect(f.current.files).not.toContain('staged-only.ts');
    expect(f.proof.reconciliationPaths).toEqual(['staged-only.ts']);
    expect(f.proof.priorDeclaredBaseHead).not.toBe(f.proof.historicalMergeBases[0]);
    expect(nativeCyclePhaseReviewUsage(f.completed, 'one')).toEqual({count: 1, limit: 10, exhausted: false});
  });

  it('rejects forged retained provenance and history/budget resets even after resealing the outer receipt', () => {
    const f = rewrittenBaseFixture();
    for (const patch of [
      {expectedPriorEntryDigest: hash('f')},
      {expectedPriorReviewDigest: hash('f')},
      {priorScopeBase: object('f')},
      {priorDeclaredBaseHead: object('f')},
      {priorTree: object('f')},
      {runId: 'other'},
      {generation: 'other'},
      {bindingId: hash('f')},
      {project: 'other'},
      {repo: '/other'},
      {worktreeDirectory: '/linked'},
      {phaseBranch: 'other'},
      {sameBaseBranch: 'other'},
      {planDocumentHash: hash('f')},
      {authority: ' '},
      {phaseOwnedPaths: [{phaseId: 'one', paths: ['upstream.ts']}]},
    ]) {
      const forged = f.seal({...f.proof, ...patch});
      expect(() =>
        validateNativeCycleSameLabelRebasedBaseReceipt(
          forged,
          {...f.completed, snapshots: [...f.runtime.snapshots, {snapshot: forged, incoming: []}]},
          1,
        ),
      ).toThrow();
    }
    for (const patch of [
      {reviews: []},
      {attempts: []},
      {reviewExpansions: [], reviewLimits: {}},
      {baselines: {...f.completed.baselines, one: {...f.completed.baselines.one, tree: object('f')}}},
      {snapshots: f.completed.snapshots.slice(1)},
    ])
      expect(() => decodeNativeCycleRuntime({...f.completed, ...patch})).toThrow();
  });

  it('rejects omitted or altered prior-tree reconciliation after resealing and serialized readback', () => {
    const f = rewrittenBaseFixture();
    const altered = {...f.proof.reconciliationEvidence[0], prior: entry('d')};
    for (const patch of [
      {reconciliationPaths: []},
      {reconciliationEvidence: []},
      {reconciliationPaths: [], reconciliationEvidence: []},
      {reconciliationEvidence: [altered]},
      {sourceEvidence: EffectArray.filter(f.proof.sourceEvidence, item => item.path !== 'staged-only.ts')},
      {
        sourceEvidence: EffectArray.map(f.proof.sourceEvidence, item =>
          item.path === 'staged-only.ts' ? altered : item,
        ),
      },
    ]) {
      const forged = f.seal({...f.proof, ...patch});
      const runtime = {
        ...f.completed,
        snapshots: [...f.runtime.snapshots, {...f.completed.snapshots[1], snapshot: forged}],
      };
      expect(forged.sameLabelRebasedBaseIntegrationV1.receiptDigest).toBe(
        nativeCycleSameLabelRebasedBaseReceiptDigest(forged, forged.sameLabelRebasedBaseIntegrationV1),
      );
      expect(() => validateNativeCycleSameLabelRebasedBaseReceipt(forged, runtime, 1)).toThrow(
        /reconciliation|source evidence/u,
      );
      expect(() => decodeNativeCycleRuntime(JSON.parse(JSON.stringify(runtime)))).toThrow(
        /reconciliation|source evidence/u,
      );
    }
  });

  it('binds reconciliation inventory and source evidence to the receipt digest through serialized readback', () => {
    const f = rewrittenBaseFixture();
    const changedPrior = {...f.proof.reconciliationEvidence[0], prior: entry('d')};
    const renamed = {...f.proof.reconciliationEvidence[0], path: 'renamed-staged-only.ts'};
    for (const patch of [
      {
        reconciliationPaths: [renamed.path],
        reconciliationEvidence: [renamed],
        sourceEvidence: EffectArray.map(f.proof.sourceEvidence, item =>
          item.path === 'staged-only.ts' ? renamed : item,
        ).sort((a, b) => EffectString.Order(a.path, b.path)),
      },
      {
        reconciliationEvidence: [changedPrior],
        sourceEvidence: EffectArray.map(f.proof.sourceEvidence, item =>
          item.path === 'staged-only.ts' ? changedPrior : item,
        ),
      },
      {
        sourceEvidence: EffectArray.map(f.proof.sourceEvidence, item =>
          item.path === 'owned.ts' ? {...item, declaredBase: entry('d')} : item,
        ),
      },
    ]) {
      const changed = {...f.proof, ...patch};
      const resealed = f.seal(changed);
      const runtime = (snapshot: NativeCycleSnapshot) => ({
        ...f.completed,
        snapshots: [...f.runtime.snapshots, {...f.completed.snapshots[1], snapshot}],
      });
      // These mutations preserve the inner consistency checks, isolating receipt integrity.
      expect(() => decodeNativeCycleRuntime(JSON.parse(JSON.stringify(runtime(resealed))))).not.toThrow();
      const forged = {
        ...f.current,
        sameLabelRebasedBaseIntegrationV1: {
          ...changed,
          receiptDigest: f.current.sameLabelRebasedBaseIntegrationV1.receiptDigest,
        },
      };
      expect(() => validateNativeCycleSameLabelRebasedBaseReceipt(forged, runtime(forged), 1)).toThrow(
        /receipt digest changed/u,
      );
      expect(() => decodeNativeCycleRuntime(JSON.parse(JSON.stringify(runtime(forged))))).toThrow(
        /receipt digest changed/u,
      );
    }
  });

  it('forces full independent review and preserves the prior finding ledger', () => {
    const f = rewrittenBaseFixture();
    const current = {...f.priorReview, snapshotId: f.current.snapshotId, snapshotTree: f.current.tree};
    expect(() =>
      validateNativeCycleReview(f.current, current, {snapshot: f.prior, review: f.priorReview}),
    ).not.toThrow();
    for (const patch of [
      {mode: 'incremental'},
      {selected: ['orchestrator'], lanes: [{name: 'orchestrator', status: 'complete'}]},
    ])
      expect(() =>
        validateNativeCycleReview(f.current, {...current, ...patch}, {snapshot: f.prior, review: f.priorReview}),
      ).toThrow();
  });
});
