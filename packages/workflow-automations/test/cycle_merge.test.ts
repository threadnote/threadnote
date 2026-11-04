import {Array as EffectArray, String as EffectString} from 'effect';
import {Schema} from 'effect';
import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {decodeNativeCyclePlan, nativeCyclePhaseHash} from '../src/cycle.js';
import {NativeCycleSnapshotSchema, validateNativeCycleReview, type NativeCycleSnapshot} from '../src/cycle_review.js';
import {
  nativeCycleMergeReceiptDigest,
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
