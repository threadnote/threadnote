import {describe, expect, it} from 'vitest';
import fc from 'fast-check';
import {Array as EffectArray, String as EffectString} from 'effect';
import {initializeNativeCycle, nativeCyclePhaseHash, nextNativeCycle} from '../src/cycle.js';
import {
  NativeCycleReviewSchema,
  NativeCycleSnapshotSchema,
  nativeCycleBaseRequalificationReceiptDigest,
} from '../src/cycle_review.js';
import {admitNativeHistoricalPrefix, NativeHistoricalPhaseEvidenceSchema} from '../src/cycle_historical.js';
import {decodeNativeCycleRuntime, nativeCyclePhaseReviewUsage, type NativeCycleRuntime} from '../src/cycle_runtime.js';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {decodeNativeCyclePlan} from '../src/cycle.js';

const oid = (char: string) => EffectString.repeat(40)(char);
const hash = (char: string) => EffectString.repeat(64)(char);
const plan = decodeNativeCyclePlan({
  format: 'threadnote-native-cycle-plan',
  version: 1,
  featureId: 'feature',
  project: 'repo',
  objective: 'Complete bounded work',
  delivery: 'pr',
  source: {
    root: {uri: 'threadnote://user/me/plan', memoryId: 'tn_plan', revision: hash('a')},
    binding: {bindingId: hash('b'), runId: 'run', generation: 'generation', profile: 'desktop'},
    documentHash: hash('c'),
  },
  completion: {},
  phases: [
    {
      id: 'first',
      definitionHash: hash('1'),
      title: 'First',
      dependsOn: [],
      allowedPaths: ['src/'],
      acceptanceCriteria: ['works'],
      safeToMergeReason: 'Safe',
      branch: 'feature/first',
      baseBranch: 'main',
      status: 'pending',
      acceptanceRefs: [{id: 'a1', criterion: 'works', requirements: ['r'], specScenarios: []}],
    },
    {
      id: 'second',
      definitionHash: hash('2'),
      title: 'Second',
      dependsOn: ['first'],
      allowedPaths: ['test/'],
      acceptanceCriteria: ['tested'],
      safeToMergeReason: 'Safe',
      branch: 'feature/second',
      baseBranch: 'main',
      status: 'pending',
      acceptanceRefs: [{id: 'a2', criterion: 'tested', requirements: ['r'], specScenarios: []}],
    },
  ],
});

const evidence = (phaseId: string, index: number, evidenceRefs = ['artifact://original']) => {
  const phase = plan.phases[index];
  const base = {head: oid('d'), tree: oid('e'), files: [index === 0 ? 'src/change.ts' : 'test/change.ts']};
  const snapshot = NativeCycleSnapshotSchema.make({
    format: 'threadnote-native-cycle-snapshot',
    version: 1,
    snapshotId: `snapshot-${phaseId}`,
    phaseId,
    phaseHash: nativeCyclePhaseHash(plan, phaseId),
    repo: 'repo',
    head: base.head,
    baseTree: oid(index ? '7' : '6'),
    scopeBase: oid(index ? '2' : '1'),
    declaredBaseHead: oid('8'),
    scopeFiles: base.files,
    tree: base.tree,
    files: base.files,
    pinnedRef: `refs/threadnote/historical/${phaseId}`,
  });
  const review = NativeCycleReviewSchema.make({
    snapshotId: snapshot.snapshotId,
    phaseHash: snapshot.phaseHash,
    snapshotTree: snapshot.tree,
    status: 'complete',
    mode: 'full',
    selected: ['correctness', 'simplicity'],
    lanes: [
      {name: 'correctness', status: 'complete'},
      {name: 'simplicity', status: 'complete'},
    ],
    findings: [],
  });
  const delivery = {
    phaseId,
    phaseHash: snapshot.phaseHash,
    delivery: 'pr' as const,
    headSha: snapshot.head,
    validatedTree: snapshot.tree,
    commitEvidence: 'merged commit verified',
    pr: {
      url: `https://example.test/pr/${index + 1}`,
      headSha: snapshot.head,
      branch: phase.branch,
      baseBranch: 'main',
      state: 'merged' as const,
    },
  };
  return {
    phaseId,
    sourceBaseCommit: oid(index ? '2' : '1'),
    sourceBaseTree: oid(index ? '7' : '6'),
    baseline: {
      repo: 'repo',
      head: oid(index ? '2' : '1'),
      tree: oid(index ? '7' : '6'),
      preservedFiles: [],
      pinnedRef: snapshot.pinnedRef,
    },
    snapshot,
    incoming: [],
    review,
    validation: {
      snapshotTree: snapshot.tree,
      reviewTree: snapshot.tree,
      head: snapshot.head,
      status: 'passed' as const,
      productState: 'working' as const,
      checks: [{command: 'focused checks', result: 'passed' as const, evidence: 'passed'}],
      acceptance: [{criterion: phase.acceptanceCriteria[0], result: 'passed' as const, evidence: 'accepted'}],
    },
    delivery,
    evidenceRefs,
  };
};

const initial = (): NativeCycleRuntime => ({
  state: initializeNativeCycle(plan),
  plans: [plan],
  baselines: {},
  reviewLimits: {},
  reviewExpansions: [],
  snapshots: [],
  reviews: [],
  attempts: [],
});

const history = (phaseId = 'first', phaseIndex = 0, count = 3): typeof NativeHistoricalPhaseEvidenceSchema.Type => {
  const source = evidence(phaseId, phaseIndex);
  const rounds: (typeof NativeHistoricalPhaseEvidenceSchema.Type)['rounds'][number][] = [];
  const finding = {
    id: 'original-blocker',
    file: phaseIndex ? 'test/change.ts' : 'src/change.ts',
    line: 1,
    body: 'Refresh can discard persisted data.',
    trigger: 'A second read after expiration.',
    impact: 'The refreshed value is lost.',
    evidence: 'Original source review reproduces the loss.',
    severity: 'important' as const,
    category: 'correctness' as const,
    confidence: 95,
  };
  for (let index = 0; index < count; index++) {
    const previous = rounds[index - 1]?.snapshot;
    const snapshot = {
      ...source.snapshot,
      snapshotId: `${phaseId}-round-${index}`,
      head: oid((index + 1).toString(16)),
      tree: oid((index + 8).toString(16)),
      pinnedRef: `refs/original/${phaseId}/round-${index}`,
      ...(previous
        ? {previous: previous.snapshotId, previousTree: previous.tree, acceptedHead: oid((index + 1).toString(16))}
        : {}),
    };
    const review = NativeCycleReviewSchema.make({
      ...source.review,
      snapshotId: snapshot.snapshotId,
      snapshotTree: snapshot.tree,
      mode: previous ? 'incremental' : 'full',
      findings: [
        index === 0
          ? {...finding, state: 'new'}
          : {
              ...finding,
              state: 'resolved',
              reason: 'Original patch keeps the refreshed value and its regression now passes.',
            },
      ],
    });
    const raw = JSON.stringify(review);
    const invalid = '{"incomplete":';
    const delivery = {
      ...source.delivery,
      headSha: snapshot.head,
      validatedTree: snapshot.tree,
      pr: {
        ...source.delivery.pr,
        headSha: snapshot.head,
        state: index === count - 1 ? ('merged' as const) : ('open' as const),
      },
      ...(index === count - 1
        ? {}
        : {
            watch: {
              prUrl: source.delivery.pr.url,
              headSha: snapshot.head,
              state: 'active' as const,
              stateDir: '/original/watch',
              consumerKind: 'worker' as const,
              consumerId: 'original-worker',
              evidence: 'Original watch was active for the published source.',
            },
          }),
    };
    rounds.push({
      snapshot,
      incoming: [],
      review,
      attempts: [
        {
          attempt: {
            id: `${phaseId}-invalid-${index}`,
            snapshotId: snapshot.snapshotId,
            digest: sha256HexSync(invalid),
            status: 'invalid',
            message: 'Original incomplete review submission.',
            report: invalid,
          },
          expansionsBefore:
            index === 5
              ? [
                  {
                    phaseId,
                    from: 5,
                    to: count + 2,
                    authority: 'Original explicit authority extends the continuous review budget.',
                  },
                ]
              : [],
        },
        {
          attempt: {
            id: `${phaseId}-accepted-${index}`,
            snapshotId: snapshot.snapshotId,
            digest: sha256HexSync(raw),
            status: 'accepted',
            message: 'Original complete source-bound review.',
            report: raw,
          },
          expansionsBefore: [],
        },
      ],
      proofs:
        index === 0
          ? []
          : [
              {
                phaseHash: snapshot.phaseHash,
                head: snapshot.head,
                tree: snapshot.tree,
                validation: {
                  ...source.validation,
                  head: snapshot.head,
                  snapshotTree: snapshot.tree,
                  reviewTree: snapshot.tree,
                },
                delivery,
              },
            ],
    });
  }
  return {
    phaseId,
    sourceBaseCommit: source.sourceBaseCommit,
    sourceBaseTree: source.sourceBaseTree,
    baseline: source.baseline,
    evidenceRefs: source.evidenceRefs,
    rounds,
  };
};
const bundle = (...phases: (typeof NativeHistoricalPhaseEvidenceSchema.Type)[]) => ({plans: [plan], phases});

const withRound = (
  phase: typeof NativeHistoricalPhaseEvidenceSchema.Type,
  index: number,
  change: (round: (typeof phase.rounds)[number]) => (typeof phase.rounds)[number],
) => ({...phase, rounds: EffectArray.map(phase.rounds, (round, i) => (i === index ? change(round) : round))});

describe('same-run historical domain staging', () => {
  it('retains original multi-round rejected/resolved findings, failed attempts, proofs and consumed budget', () => {
    const source = initial();
    const first = history('first', 0, 7);
    const before = JSON.stringify(source);
    const admitted = admitNativeHistoricalPrefix(source, bundle(first));
    expect(admitted.snapshots).toEqual(
      EffectArray.map(first.rounds, round => ({snapshot: round.snapshot, incoming: round.incoming})),
    );
    expect(admitted.reviews).toEqual(
      EffectArray.map(first.rounds, round => ({snapshotId: round.snapshot.snapshotId, report: round.review})),
    );
    expect(admitted.attempts).toEqual(
      EffectArray.flatMap(first.rounds, round => EffectArray.map(round.attempts, entry => entry.attempt)),
    );
    expect(admitted.reviews[0]?.report.findings[0]?.state).toBe('new');
    expect(admitted.reviews[1]?.report.findings[0]?.state).toBe('resolved');
    expect(admitted.state.phases.first.history).toEqual(
      EffectArray.flatMap(first.rounds, round => round.proofs).slice(0, -1),
    );
    expect(admitted.reviewExpansions).toEqual(
      EffectArray.flatMap(first.rounds, round => EffectArray.flatMap(round.attempts, entry => entry.expansionsBefore)),
    );
    expect(nativeCyclePhaseReviewUsage(admitted, 'first')).toEqual({count: 7, limit: 9, exhausted: false});
    expect(
      nativeCyclePhaseReviewUsage(admitted, 'first').limit - nativeCyclePhaseReviewUsage(admitted, 'first').count,
    ).toBe(2);
    expect(admitted.state.phases.first.status).toBe('merged');
    expect(admitted.state.phases.second.status).toBe('pending');
    expect(nextNativeCycle(admitted.state)).toMatchObject({action: 'implement', phaseId: 'second'});
    expect(admitted.state.plan.phases[0]?.baseBranch).toBe('main');
    expect(admitted.baselines.first?.head).toBe(first.sourceBaseCommit);
    expect(JSON.stringify(source)).toBe(before);
    expect(() => decodeNativeCycleRuntime({...admitted, attempts: admitted.attempts.slice(1)})).toThrow();
    expect(() => decodeNativeCycleRuntime({...admitted, reviews: admitted.reviews.slice(1)})).toThrow();
    const backward = {
      ...admitted,
      historicalAdmissions:
        admitted.historicalAdmissions === undefined
          ? undefined
          : EffectArray.map(admitted.historicalAdmissions, ({history: _history, ...entry}) => entry),
    };
    expect(() => decodeNativeCycleRuntime(backward)).toThrow();
    expect(() => decodeNativeCycleRuntime(initial())).not.toThrow();
    expect(() => decodeNativeCycleRuntime({...admitted, reviewExpansions: []})).toThrow();
  });

  it('rejects aggregate capacity before deep decoding poison plans or traversing sparse child payloads', () => {
    const phase = history('first', 0, 2);
    const second = history('second', 1, 2);
    const round = phase.rounds[0];
    const entry = round.attempts[0];
    let deepReads = 0;
    const poisonPlan = Object.defineProperty({...plan}, 'objective', {
      get() {
        deepReads++;
        throw new Error('The plan body must not be decoded after shallow over-capacity.');
      },
    });
    const withRounds = (rounds: typeof phase.rounds) => ({plans: [poisonPlan], phases: [{...phase, rounds}]});
    const variants = [
      {plans: [poisonPlan], phases: new Array<typeof phase>(129)},
      {plans: new Array<typeof plan>(65), phases: [phase]},
      withRounds(new Array<typeof round>(257)),
      {
        plans: [poisonPlan],
        phases: [
          {...phase, rounds: new Array<typeof round>(129)},
          {...second, rounds: new Array<typeof round>(129)},
        ],
      },
      withRounds([{...round, attempts: new Array<typeof entry>(513)}]),
      withRounds([
        {...round, attempts: new Array<typeof entry>(257)},
        {...round, attempts: new Array<typeof entry>(257)},
      ]),
      withRounds([
        {...round, attempts: [{...entry, expansionsBefore: new Array<(typeof entry.expansionsBefore)[number]>(257)}]},
      ]),
      withRounds([
        {
          ...round,
          attempts: [
            {...entry, expansionsBefore: new Array<(typeof entry.expansionsBefore)[number]>(129)},
            {...entry, expansionsBefore: new Array<(typeof entry.expansionsBefore)[number]>(128)},
          ],
        },
      ]),
      withRounds([
        {...round, proofs: new Array<(typeof round.proofs)[number]>(33)},
        {...round, proofs: new Array<(typeof round.proofs)[number]>(33)},
      ]),
      withRounds([{...round, incoming: new Array<(typeof round.incoming)[number]>(8193)}]),
    ];
    const source = initial();
    const before = JSON.stringify(source);
    for (const variant of variants) {
      expect(() => admitNativeHistoricalPrefix(source, variant)).toThrow(/capacity/u);
      expect(deepReads).toBe(0);
      expect(JSON.stringify(source)).toBe(before);
    }
  });

  it('binds complete plan content and order across multi-phase admission, decode and replay', () => {
    const originalPlan = decodeNativeCyclePlan({...plan, source: {...plan.source, documentHash: hash('e')}});
    const proof = {plans: [originalPlan, plan], phases: [history('first', 0), history('second', 1, 2)]};
    const admitted = admitNativeHistoricalPrefix(initial(), proof);
    const alteredOriginal = {
      ...originalPlan,
      source: {...originalPlan.source, root: {...originalPlan.source.root, revision: hash('f')}},
    };
    const changed = {...proof, plans: [alteredOriginal, plan]};
    const reordered = {...proof, plans: [plan, originalPlan]};
    const before = JSON.stringify(admitted);
    expect(() => decodeNativeCycleRuntime({...admitted, plans: changed.plans})).toThrow();
    expect(() => decodeNativeCycleRuntime({...admitted, plans: reordered.plans})).toThrow();
    expect(() => admitNativeHistoricalPrefix(admitted, changed)).toThrow();
    expect(() => admitNativeHistoricalPrefix(admitted, reordered)).toThrow();
    expect(JSON.stringify(admitted)).toBe(before);
    const changedAdmission = admitNativeHistoricalPrefix(initial(), changed);
    for (let index = 0; index < 2; index++) {
      expect(changedAdmission.historicalAdmissions?.[index]?.evidenceDigest).not.toBe(
        admitted.historicalAdmissions?.[index]?.evidenceDigest,
      );
      expect(changedAdmission.historicalAdmissions?.[index]?.history.digest).not.toBe(
        admitted.historicalAdmissions?.[index]?.history.digest,
      );
    }
    expect(admitNativeHistoricalPrefix(admitted, proof)).toEqual(admitted);
  });

  it('requires marked provenance and binds evidence references, bundle digest and admission metadata', () => {
    const proof = bundle(history('first', 0, 7));
    const admitted = admitNativeHistoricalPrefix(initial(), proof);
    expect(admitted.historicalAdmission).toEqual({version: 1, phaseCount: 1});
    const {historicalAdmissions: _admissions, ...missingAdmissions} = admitted;
    const {historicalAdmission: _version, ...missingVersion} = admitted;
    const records = admitted.historicalAdmissions!;
    const original = records[0];
    const withRecord = (entry: typeof original) => ({...admitted, historicalAdmissions: [entry]});
    const variants = [
      missingAdmissions,
      missingVersion,
      {...admitted, historicalAdmission: {version: 2, phaseCount: 1}},
      {...admitted, historicalAdmissions: []},
      {...initial(), historicalAdmission: {version: 1, phaseCount: 1}},
      withRecord({...original, evidenceRefs: ['artifact://changed-original']}),
      withRecord({...original, evidenceRefs: []}),
      withRecord({...original, evidenceDigest: hash('f')}),
      withRecord({...original, history: {...original.history, digest: hash('f')}}),
      withRecord({...original, history: {...original.history, expansionCount: 0}}),
    ];
    const before = JSON.stringify(admitted);
    for (const variant of variants) {
      const variantBefore = JSON.stringify(variant);
      expect(() => decodeNativeCycleRuntime(variant)).toThrow();
      expect(JSON.stringify(variant)).toBe(variantBefore);
      expect(JSON.stringify(admitted)).toBe(before);
    }
    expect(decodeNativeCycleRuntime(initial())).toEqual(initial());
    expect(decodeNativeCycleRuntime(admitted)).toEqual(admitted);
    expect(admitNativeHistoricalPrefix(admitted, proof)).toEqual(admitted);
    const prefix = admitNativeHistoricalPrefix(initial(), bundle(history('first', 0), history('second', 1, 2)));
    const truncated = {...prefix, historicalAdmissions: prefix.historicalAdmissions!.slice(0, 1)};
    expect(() => decodeNativeCycleRuntime(truncated)).toThrow();
    // Altering the discriminator count as well still requires the original retained digest.
    expect(() => decodeNativeCycleRuntime({...truncated, historicalAdmission: {version: 1, phaseCount: 1}})).toThrow();
  });

  it('retains original base-requalification lineage without upgrading the old review to current acceptance', () => {
    const oldPlan = decodeNativeCyclePlan({
      ...plan,
      source: {...plan.source, documentHash: hash('e')},
      phases: EffectArray.map(plan.phases, phase =>
        phase.id === 'first' ? {...phase, definitionHash: hash('4'), baseBranch: 'original-base'} : phase,
      ),
    });
    const original = history();
    const first = original.rounds[0];
    const oldHash = nativeCyclePhaseHash(oldPlan, 'first');
    const oldReview = {...first.review, phaseHash: oldHash};
    const oldRaw = JSON.stringify(oldReview);
    const oldRound = {
      ...first,
      snapshot: {...first.snapshot, phaseHash: oldHash},
      review: oldReview,
      attempts: [
        first.attempts[0],
        {...first.attempts[1], attempt: {...first.attempts[1].attempt, report: oldRaw, digest: sha256HexSync(oldRaw)}},
      ],
    };
    const second = original.rounds[1];
    const {previous: _previous, previousTree: _previousTree, ...secondSource} = second.snapshot;
    const snapshot = {...secondSource, supersedes: oldRound.snapshot.snapshotId, declaredBaseHead: oid('f')};
    const receipt = {
      preRebaseHead: oldRound.snapshot.head,
      ontoHead: snapshot.declaredBaseHead,
      rebasedHead: snapshot.head,
      fromBaseBranch: 'original-base',
      toBaseBranch: 'main',
      priorDeclaredBaseHead: oldRound.snapshot.declaredBaseHead,
      reason: 'Original approved delivery-base transition.',
      authority: 'Original explicit base-requalification authority.',
      beforeRef: `refs/threadnote/cycles/requalification-before/${hash('a')}`,
      afterRef: `refs/threadnote/cycles/requalification-after/${hash('b')}`,
      priorBaseRef: `refs/threadnote/cycles/requalification-base/${hash('c')}`,
    };
    const currentSnapshot = {
      ...snapshot,
      baseRequalification: {...receipt, receiptDigest: nativeCycleBaseRequalificationReceiptDigest(snapshot, receipt)},
    };
    const currentReview = {...second.review, mode: 'full' as const};
    const currentRaw = JSON.stringify(currentReview);
    const newRound = {
      ...second,
      snapshot: currentSnapshot,
      review: currentReview,
      attempts: [
        second.attempts[0],
        {
          ...second.attempts[1],
          attempt: {...second.attempts[1].attempt, report: currentRaw, digest: sha256HexSync(currentRaw)},
        },
      ],
    };
    const proof = {plans: [oldPlan, plan], phases: [{...original, rounds: [oldRound, newRound, original.rounds[2]]}]};
    const admitted = admitNativeHistoricalPrefix(initial(), proof);
    expect(admitted.plans).toEqual([oldPlan, plan]);
    expect(admitted.snapshots[0]?.snapshot.phaseHash).toBe(oldHash);
    expect(admitted.snapshots[1]?.snapshot.baseRequalification).toEqual(currentSnapshot.baseRequalification);
    expect(admitted.reviews[0]?.report).toEqual(oldReview);
    expect(admitted.reviews.at(-1)?.report.phaseHash).toBe(nativeCyclePhaseHash(plan, 'first'));
    expect(admitted.baselines.first?.head).toBe(original.sourceBaseCommit);
    expect(admitted.state.plan.phases[0]?.baseBranch).toBe('main');
    expect(() => admitNativeHistoricalPrefix(initial(), {plans: [plan], phases: proof.phases})).toThrow();
    expect(() =>
      admitNativeHistoricalPrefix(initial(), {plans: proof.plans, phases: [{...original, rounds: [oldRound]}]}),
    ).toThrow();
    const broken = {
      ...newRound,
      snapshot: {
        ...newRound.snapshot,
        baseRequalification: {...currentSnapshot.baseRequalification, receiptDigest: hash('f')},
      },
    };
    expect(() =>
      admitNativeHistoricalPrefix(initial(), {
        plans: proof.plans,
        phases: [{...original, rounds: [oldRound, broken, original.rounds[2]]}],
      }),
    ).toThrow();
  });

  it('admits the complete ordered prefix with normal next eligibility and rejects partial/changed replay', () => {
    const proof = bundle(history('first', 0), history('second', 1, 2));
    const admitted = admitNativeHistoricalPrefix(initial(), proof);
    expect(admitted.state.phases.first.status).toBe('merged');
    expect(admitted.state.phases.second.status).toBe('merged');
    expect(nextNativeCycle(admitted.state)).toMatchObject({action: 'complete'});
    expect(admitNativeHistoricalPrefix(admitted, proof)).toEqual(admitted);
    expect(() => admitNativeHistoricalPrefix(admitted, bundle(proof.phases[0]))).toThrow();
    const changed = bundle(
      withRound(proof.phases[0], 0, round => ({
        ...round,
        attempts: [
          {...round.attempts[0], attempt: {...round.attempts[0].attempt, message: 'Changed historical failure'}},
          ...round.attempts.slice(1),
        ],
      })),
      proof.phases[1],
    );
    expect(() => admitNativeHistoricalPrefix(admitted, changed)).toThrow();
    expect(() =>
      admitNativeHistoricalPrefix(
        admitted,
        bundle({...proof.phases[0], rounds: proof.phases[0].rounds.slice(1)}, proof.phases[1]),
      ),
    ).toThrow();
  });

  it('refuses missing, reordered, malformed or over-budget original evidence without input mutation', () => {
    const proof = bundle(history('first', 0, 6));
    const phase = proof.phases[0];
    const change = (index: number, update: (round: (typeof phase.rounds)[number]) => (typeof phase.rounds)[number]) =>
      bundle(withRound(phase, index, update));
    const variants = [
      bundle({...phase, sourceBaseCommit: oid('f')}),
      bundle({...phase, rounds: [...phase.rounds].reverse()}),
      change(1, round => ({...round, snapshot: {...round.snapshot, previous: 'missing-predecessor'}})),
      change(1, round => ({...round, review: {...round.review, findings: []}})),
      change(0, round => ({...round, attempts: round.attempts.slice(0, 1)})),
      change(0, round => ({
        ...round,
        attempts: [
          {...round.attempts[0], attempt: {...round.attempts[0].attempt, digest: hash('f')}},
          ...round.attempts.slice(1),
        ],
      })),
      change(0, round => ({
        ...round,
        attempts: [
          round.attempts[0],
          {...round.attempts[1], attempt: {...round.attempts[1].attempt, status: 'invalid'}},
        ],
      })),
      change(5, round => ({
        ...round,
        attempts: [{...round.attempts[0], expansionsBefore: []}, ...round.attempts.slice(1)],
      })),
      change(5, round => ({
        ...round,
        attempts: [
          {...round.attempts[0], expansionsBefore: [{...round.attempts[0].expansionsBefore[0], from: 6}]},
          ...round.attempts.slice(1),
        ],
      })),
      change(5, round => ({...round, proofs: []})),
      change(5, round => ({
        ...round,
        proofs: [{...round.proofs[0], validation: {...round.proofs[0].validation, checks: []}}],
      })),
      change(5, round => ({
        ...round,
        proofs: [
          {
            ...round.proofs[0],
            delivery: {
              ...round.proofs[0].delivery!,
              pr: {...round.proofs[0].delivery!.pr!, baseBranch: 'wrong-target'},
            },
          },
        ],
      })),
      change(1, round => ({...round, snapshot: {...round.snapshot, previousTree: oid('f')}})),
      change(1, round => ({...round, snapshot: {...round.snapshot, files: ['outside/source.ts']}})),
    ];
    const source = initial();
    const before = JSON.stringify(source);
    for (const variant of variants) {
      const evidenceBefore = JSON.stringify(variant);
      expect(() => admitNativeHistoricalPrefix(source, variant)).toThrow();
      expect(JSON.stringify(source)).toBe(before);
      expect(JSON.stringify(variant)).toBe(evidenceBefore);
    }
  });

  it('preserves independent ordered identities, proof lineage and remaining budget for bounded histories', () => {
    fc.assert(
      fc.property(
        fc.integer({min: 2, max: 8}),
        fc.stringMatching(/^[a-z][a-z0-9:/._-]{1,30}$/u),
        (rounds, reference) => {
          const source = initial();
          const original = history('first', 0, rounds);
          const proof = bundle({...original, evidenceRefs: [reference]});
          const before = JSON.stringify(source);
          const admitted = admitNativeHistoricalPrefix(source, proof);
          expect(EffectArray.map(admitted.snapshots, entry => entry.snapshot.snapshotId)).toEqual(
            Array.from({length: rounds}, (_, index) => `first-round-${index}`),
          );
          expect(EffectArray.map(admitted.attempts, entry => entry.id)).toEqual(
            Array.from({length: rounds}, (_, index) => [`first-invalid-${index}`, `first-accepted-${index}`]).flat(),
          );
          expect((admitted.state.phases.first.history ?? []).length).toBe(rounds - 2);
          expect(nativeCyclePhaseReviewUsage(admitted, 'first')).toEqual({
            count: rounds,
            limit: rounds > 5 ? rounds + 2 : 5,
            exhausted: rounds === 5,
          });
          expect(admitNativeHistoricalPrefix(admitted, proof)).toEqual(admitted);
          const record = admitted.historicalAdmissions![0];
          expect(() =>
            decodeNativeCycleRuntime({
              ...admitted,
              historicalAdmissions: [{...record, evidenceRefs: [`${reference}-changed`]}],
            }),
          ).toThrow();
          expect(() =>
            decodeNativeCycleRuntime({...admitted, historicalAdmissions: [{...record, evidenceDigest: hash('f')}]}),
          ).toThrow();

          expect(JSON.stringify(source)).toBe(before);
          const missing = bundle({...proof.phases[0], rounds: proof.phases[0].rounds.slice(1)});
          expect(() => admitNativeHistoricalPrefix(source, missing)).toThrow();
        },
      ),
      {numRuns: 24},
    );
  });
});
