import {Array as EffectArray, Option as EffectOption} from 'effect';
import {Schema} from 'effect';
import {
  NativeCyclePlanSchema,
  NativeCycleSupplementalInitSchema,
  NativeCycleSupplementalEventSchema,
  type NativeCycleSupplementalPublication,
  nextNativeCycle,
  nativeCycleAbsolutePath,
  NativeCycleStateSchema,
  decodeNativeCyclePlan,
  decodeNativeCycleState,
  nativeCyclePhaseHash,
  nativeCycleCanonicalJson,
} from './cycle.js';
import {
  NativeCycleSnapshotSchema,
  NativeCycleReviewSchema,
  validateNativeCycleReviewHistory,
  nativeCycleBaseRequalificationReceiptDigest,
  validateNativeCycleMergeReceipt,
} from './cycle_review.js';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {WorkflowAutomationError} from './contracts.js';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

const id = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u));
const digest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));
const gitObject = Schema.String.check(Schema.isPattern(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u));
export const NativeCycleStoredSnapshotSchema = Schema.Struct({
  snapshot: NativeCycleSnapshotSchema,
  incoming: Schema.Array(
    Schema.Struct({
      path: Schema.String,
      source: Schema.Literals(['upstream', 'preserved']),
      tree: gitObject,
      mode: Schema.String.check(Schema.isPattern(/^(?:000000|100644|100755|120000|160000)$/u)),
      blob: gitObject,
      commit: gitObject,
    }),
  ).check(Schema.isMaxLength(8192)),
});
export const NativeCycleBaselineSchema = Schema.Struct({
  repo: Schema.String,
  head: gitObject,
  tree: gitObject,
  preservedFiles: Schema.Array(Schema.String).check(Schema.isMaxLength(8192)),
  pinnedRef: Schema.String,
});
export const NativeCycleReviewExpansionSchema = Schema.Struct({
  phaseId: id,
  from: Schema.Finite,
  to: Schema.Finite,
  authority: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096)),
  reason: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096))),
  requestDigest: Schema.optionalKey(digest),
});
export const NativeCycleReviewAttemptSchema = Schema.Struct({
  id,
  snapshotId: id,
  digest,
  status: Schema.Literals(['accepted', 'invalid']),
  message: Schema.String.check(Schema.isMaxLength(4096)),
  // Retain bounded failed reports as evidence; never turn malformed coverage into an empty review.
  report: Schema.String.check(Schema.isMaxLength(65_536)),
  authority: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096))),
});
export const NativeCycleRuntimeSchema = Schema.Struct({
  state: NativeCycleStateSchema,
  plans: Schema.Array(NativeCyclePlanSchema).check(Schema.isBetweenLength(1, 64)),
  baselines: Schema.Record(id, NativeCycleBaselineSchema),
  reviewLimits: Schema.Record(id, Schema.Finite.check(Schema.isInt(), Schema.isBetween({minimum: 5, maximum: 256}))),
  reviewExpansions: Schema.Array(NativeCycleReviewExpansionSchema).check(Schema.isMaxLength(256)),
  snapshots: Schema.Array(NativeCycleStoredSnapshotSchema).check(Schema.isMaxLength(256)),
  /** For each invalidated phase, the last snapshot that predates its current repair iteration. */
  invalidatedThroughSnapshot: Schema.optionalKey(Schema.Record(id, id)),
  reviews: Schema.Array(Schema.Struct({snapshotId: id, report: NativeCycleReviewSchema})).check(
    Schema.isMaxLength(256),
  ),
  attempts: Schema.Array(NativeCycleReviewAttemptSchema).check(Schema.isMaxLength(512)),
  historicalAdmission: Schema.optionalKey(
    Schema.Struct({
      version: Schema.Literal(1),
      phaseCount: Schema.Finite.check(Schema.isInt(), Schema.isBetween({minimum: 1, maximum: 128})),
    }),
  ),
  historicalAdmissions: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        phaseId: id,
        phaseHash: digest,
        snapshotId: id,
        sourceBaseCommit: gitObject,
        sourceBaseTree: gitObject,
        evidenceDigest: digest,
        history: Schema.Struct({
          snapshotIds: Schema.Array(id).check(Schema.isBetweenLength(1, 256)),
          attemptIds: Schema.Array(id).check(Schema.isBetweenLength(1, 512)),
          planCount: Schema.Finite.check(Schema.isInt(), Schema.isBetween({minimum: 1, maximum: 64})),
          expansionCount: Schema.Finite.check(Schema.isInt(), Schema.isBetween({minimum: 0, maximum: 256})),
          digest,
        }),
        evidenceRefs: Schema.Array(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2048))).check(
          Schema.isBetweenLength(1, 32),
        ),
      }),
    ).check(Schema.isMaxLength(128)),
  ),
});
export type NativeCycleRuntime = typeof NativeCycleRuntimeSchema.Type;

/** A retired snapshot cannot prove the current phase iteration, even when its tree is unchanged. */
export function nativeCycleSnapshotIsCurrentIteration(
  runtime: NativeCycleRuntime,
  phaseId: string,
  snapshotId: string,
): boolean {
  const snapshotIndex = EffectOption.getOrUndefined(
    EffectArray.findFirstIndex(
      runtime.snapshots,
      entry => entry.snapshot.phaseId === phaseId && entry.snapshot.snapshotId === snapshotId,
    ),
  );
  if (snapshotIndex === undefined) return false;
  const boundaryId = runtime.invalidatedThroughSnapshot?.[phaseId];
  if (!boundaryId) return true;
  const retiredIndex = EffectOption.getOrUndefined(
    EffectArray.findFirstIndex(
      runtime.snapshots,
      entry => entry.snapshot.phaseId === phaseId && entry.snapshot.snapshotId === boundaryId,
    ),
  );
  return retiredIndex !== undefined && snapshotIndex > retiredIndex;
}

/** Counts accepted reports continuously across every snapshot for the phase. */
export function nativeCyclePhaseReviewUsage(runtime: NativeCycleRuntime, phaseId: string) {
  const count = EffectArray.filter(
    runtime.reviews,
    item =>
      EffectOption.getOrUndefined(
        EffectArray.findFirst(runtime.snapshots, entry => entry.snapshot.snapshotId === item.snapshotId),
      )?.snapshot.phaseId === phaseId,
  ).length;
  const limit = runtime.reviewLimits[phaseId] ?? 5;
  return {count, limit, exhausted: count >= limit};
}

export function nativeCycleHasBasePlanTransition(
  plans: NativeCycleRuntime['plans'],
  prior: typeof NativeCycleSnapshotSchema.Type,
  phaseHash: string,
  fromBaseBranch: string,
  toBaseBranch: string,
): boolean {
  if (fromBaseBranch === toBaseBranch) return false;
  let fromFound = false;
  for (const plan of plans) {
    const phase = EffectArray.findFirst(plan.phases, item => item.id === prior.phaseId);
    if (phase._tag === 'None') continue;
    const hash = nativeCyclePhaseHash(plan, prior.phaseId);
    if (fromFound && phase.value.baseBranch === toBaseBranch && hash === phaseHash) return true;
    if (phase.value.baseBranch === fromBaseBranch && hash === prior.phaseHash) fromFound = true;
  }
  return false;
}

export function decodeNativeCycleRuntime(input: unknown): NativeCycleRuntime {
  const runtime = Schema.decodeUnknownSync(NativeCycleRuntimeSchema, {onExcessProperty: 'error'})(input);
  decodeNativeCycleState(runtime.state);
  EffectArray.forEach(runtime.plans, decodeNativeCyclePlan);
  function fail(message: string): never {
    throw WorkflowAutomationError.make({code: 'invalid-cycle-state', message});
  }
  const snapshots = new Map(EffectArray.map(runtime.snapshots, entry => [entry.snapshot.snapshotId, entry]));
  const reviews = new Map(EffectArray.map(runtime.reviews, entry => [entry.snapshotId, entry.report]));
  if (
    snapshots.size !== runtime.snapshots.length ||
    reviews.size !== runtime.reviews.length ||
    new Set(EffectArray.map(runtime.attempts, attempt => attempt.id)).size !== runtime.attempts.length
  )
    fail('Duplicate cycle evidence identity.');
  for (const [phaseId, snapshotId] of EffectRecord.toEntries(runtime.invalidatedThroughSnapshot ?? {})) {
    if (!runtime.state.phases[phaseId] || snapshots.get(snapshotId)?.snapshot.phaseId !== phaseId)
      fail('Invalidated snapshot boundary does not belong to its canonical phase.');
  }
  const admissions = runtime.historicalAdmissions ?? [];
  if (
    (runtime.historicalAdmission === undefined) !== (runtime.historicalAdmissions === undefined) ||
    (runtime.historicalAdmission !== undefined && runtime.historicalAdmission.phaseCount !== admissions.length)
  )
    fail(
      'Marked historical runtimes require their complete admission provenance; ordinary legacy runtimes have neither field.',
    );
  if (new Set(EffectArray.map(admissions, item => item.phaseId)).size !== admissions.length)
    fail('Duplicate historical phase admission.');
  for (const [index, admission] of admissions.entries()) {
    const phase = runtime.state.phases[admission.phaseId];
    const stored = snapshots.get(admission.snapshotId);
    if (
      runtime.state.plan.phases[index]?.id !== admission.phaseId ||
      !phase ||
      phase.status !== 'merged' ||
      phase.phaseHash !== admission.phaseHash ||
      !stored ||
      stored.snapshot.phaseId !== admission.phaseId ||
      stored.snapshot.phaseHash !== admission.phaseHash ||
      stored.snapshot.baseTree !== admission.sourceBaseTree ||
      !phase.delivery ||
      phase.delivery.pr?.state !== 'merged' ||
      !reviews.has(admission.snapshotId) ||
      !EffectRecord.has(runtime.baselines, admission.phaseId) ||
      runtime.baselines[admission.phaseId]?.head !== admission.sourceBaseCommit ||
      runtime.baselines[admission.phaseId]?.tree !== admission.sourceBaseTree
    )
      fail('Historical admission provenance does not match retained phase evidence and source base.');
  }
  const limits: Record<string, number> = {};
  const expansionDigests = new Set<string>();
  for (const expansion of runtime.reviewExpansions) {
    if (
      !runtime.state.phases[expansion.phaseId] ||
      expansion.from !== (limits[expansion.phaseId] ?? 5) ||
      !Number.isSafeInteger(expansion.to) ||
      expansion.to <= expansion.from ||
      expansion.to > 256 ||
      !Effect.pipe(expansion.authority, EffectString.trim)
    )
      fail('Review expansion lost its phase, prior budget or explicit authority.');
    if (expansion.reason !== undefined && !Effect.pipe(expansion.reason, EffectString.trim))
      fail('Review expansion lost its concrete reason.');
    if (expansion.requestDigest && expansionDigests.has(expansion.requestDigest))
      fail('Review expansion request identities must be unique.');
    if (expansion.requestDigest) expansionDigests.add(expansion.requestDigest);
    limits[expansion.phaseId] = expansion.to;
  }
  if (
    JSON.stringify(EffectRecord.toEntries(limits).sort()) !==
    JSON.stringify(EffectRecord.toEntries(runtime.reviewLimits).sort())
  )
    fail('Review limits differ from their continuous authorization history.');
  for (const [phaseId, baseline] of EffectRecord.toEntries(runtime.baselines)) {
    if (!runtime.state.phases[phaseId] || new Set(baseline.preservedFiles).size !== baseline.preservedFiles.length)
      fail('The pre-implementation baseline lost its phase or preserved-work manifest.');
  }
  const capturedSnapshots = new Set<string>();
  const latestSnapshotByPhase = new Map<string, string>();
  for (const {snapshot, incoming} of runtime.snapshots) {
    const baseline = runtime.baselines[snapshot.phaseId];
    if (!baseline || baseline.tree !== snapshot.baseTree || baseline.repo !== snapshot.repo)
      fail('Snapshot baseline differs from its pre-implementation source pin.');
    if (snapshot.unreviewedSupersession) {
      const prior = snapshot.supersedes ? snapshots.get(snapshot.supersedes) : undefined;
      if (
        !prior ||
        latestSnapshotByPhase.get(snapshot.phaseId) !== prior.snapshot.snapshotId ||
        prior.snapshot.phaseId !== snapshot.phaseId ||
        prior.snapshot.phaseHash !== snapshot.phaseHash ||
        prior.snapshot.tree === snapshot.tree ||
        prior.snapshot.baseTree !== snapshot.baseTree ||
        reviews.has(prior.snapshot.snapshotId) ||
        !Effect.pipe(snapshot.unreviewedSupersession.reason, EffectString.trim)
      )
        fail('Unreviewed supersession must retain the latest changed-source snapshot without an accepted review.');
    }
    if (snapshot.baseRequalification) {
      const receipt = snapshot.baseRequalification;
      const predecessor = snapshot.previous ?? snapshot.supersedes;
      const prior = predecessor ? snapshots.get(predecessor)?.snapshot : undefined;
      if (
        !prior ||
        !capturedSnapshots.has(prior.snapshotId) ||
        !reviews.has(prior.snapshotId) ||
        receipt.preRebaseHead !== prior.head ||
        receipt.priorDeclaredBaseHead !== prior.declaredBaseHead ||
        receipt.ontoHead !== snapshot.declaredBaseHead ||
        receipt.rebasedHead !== snapshot.head ||
        receipt.preRebaseHead === snapshot.head ||
        receipt.priorDeclaredBaseHead === snapshot.declaredBaseHead ||
        snapshot.acceptedHead !== snapshot.head ||
        !EffectString.trim(receipt.reason) ||
        !EffectString.trim(receipt.authority) ||
        !nativeCycleHasBasePlanTransition(
          runtime.plans,
          prior,
          snapshot.phaseHash,
          receipt.fromBaseBranch,
          receipt.toBaseBranch,
        ) ||
        receipt.receiptDigest !== nativeCycleBaseRequalificationReceiptDigest(snapshot, receipt)
      )
        fail('Base requalification lost its reviewed predecessor, approved plan transition or immutable witness.');
    }
    if (snapshot.ordinaryMergeQualificationV1) {
      const predecessor = snapshot.previous ?? snapshot.supersedes;
      const prior = predecessor ? snapshots.get(predecessor)?.snapshot : undefined;
      if (!prior || !capturedSnapshots.has(prior.snapshotId) || !reviews.has(prior.snapshotId))
        fail('Ordinary merge qualification requires its retained reviewed predecessor.');
      validateNativeCycleMergeReceipt(snapshot, prior, runtime.plans, baseline.head);
      const proof = snapshot.ordinaryMergeQualificationV1;
      const plan = EffectOption.getOrUndefined(
        EffectArray.findFirst(runtime.plans, item => item.source.documentHash === proof.planDocumentHash),
      )!;
      const phase = EffectOption.getOrUndefined(
        EffectArray.findFirst(plan.phases, item => item.id === snapshot.phaseId),
      )!;
      const expected = EffectArray.filter(proof.upstreamEvidence, item => !phase.allowedPaths.includes(item.path));
      if (
        incoming.length !== expected.length ||
        EffectArray.some(incoming, (item, index) => {
          const entry = expected[index];
          return (
            !entry ||
            item.path !== entry.path ||
            item.source !== 'upstream' ||
            item.commit !== proof.currentBaseHead ||
            item.tree !== proof.currentBaseTree ||
            item.mode !== entry.head.mode ||
            item.blob !== entry.head.blob
          );
        })
      )
        fail('Keep the exact per-phase upstream incoming subset separate from the complete merge proof.');
    }
    capturedSnapshots.add(snapshot.snapshotId);
    if (
      !runtime.state.phases[snapshot.phaseId] ||
      !EffectArray.some(
        runtime.plans,
        plan =>
          EffectArray.some(plan.phases, phase => phase.id === snapshot.phaseId) &&
          nativeCyclePhaseHash(plan, snapshot.phaseId) === snapshot.phaseHash,
      ) ||
      new Set(snapshot.files).size !== snapshot.files.length ||
      new Set(snapshot.scopeFiles).size !== snapshot.scopeFiles.length ||
      EffectArray.some(snapshot.scopeFiles, file => !snapshot.files.includes(file)) ||
      new Set(EffectArray.map(incoming, item => item.path)).size !== incoming.length ||
      EffectArray.some(
        incoming,
        item =>
          !snapshot.files.includes(item.path) ||
          (item.source === 'preserved'
            ? !baseline.preservedFiles.includes(item.path) ||
              item.tree !== baseline.tree ||
              item.commit !== baseline.head
            : item.tree !== snapshot.scopeBase),
      )
    )
      fail('Snapshot evidence does not match the phase or incoming manifest.');
    if (snapshot.previous) {
      const previous = snapshots.get(snapshot.previous)?.snapshot;
      if (
        !previous ||
        previous.tree !== snapshot.previousTree ||
        previous.phaseId !== snapshot.phaseId ||
        previous.baseTree !== snapshot.baseTree
      )
        fail('Snapshot history is incomplete.');
    } else if (snapshot.previousTree) fail('Snapshot previous tree has no identity.');
    if (snapshot.supersedes) {
      const prior = snapshots.get(snapshot.supersedes)?.snapshot;
      if (
        !prior ||
        snapshot.previous ||
        prior.phaseId !== snapshot.phaseId ||
        prior.baseTree !== snapshot.baseTree ||
        (snapshot.unreviewedSupersession
          ? prior.phaseHash !== snapshot.phaseHash
          : prior.phaseHash === snapshot.phaseHash)
      )
        fail('Material review restart lacks its historical source boundary.');
    }
    latestSnapshotByPhase.set(snapshot.phaseId, snapshot.snapshotId);
  }
  for (const {snapshotId, report} of runtime.reviews) {
    const snapshot = snapshots.get(snapshotId)?.snapshot;
    if (!snapshot) fail('Review snapshot is missing.');
    const predecessor = snapshot.previous ?? snapshot.supersedes;
    const previous = predecessor ? snapshots.get(predecessor)?.snapshot : undefined;
    const priorReport = previous ? reviews.get(previous.snapshotId) : undefined;
    if (previous && !priorReport && !snapshot.unreviewedSupersession)
      fail('Review history lost its prior finding ledger.');
    validateNativeCycleReviewHistory(
      snapshot,
      report,
      previous && priorReport ? {snapshot: previous, review: priorReport} : undefined,
    );
  }
  if (EffectArray.some(runtime.attempts, attempt => !snapshots.has(attempt.snapshotId)))
    fail('Review attempt snapshot is missing.');
  const checksums = makeNativeHistoricalDigests(runtime.plans);
  for (const admission of admissions) {
    const {history, ...metadata} = admission;
    const {digest: _digest, ...witness} = history;
    const phaseSnapshots = EffectArray.filter(runtime.snapshots, entry => entry.snapshot.phaseId === admission.phaseId);
    const phaseIds = new Set(EffectArray.map(phaseSnapshots, entry => entry.snapshot.snapshotId));
    const phaseAttempts = EffectArray.filter(runtime.attempts, attempt => phaseIds.has(attempt.snapshotId));
    if (
      JSON.stringify(history.snapshotIds) !==
        JSON.stringify(EffectArray.map(phaseSnapshots, entry => entry.snapshot.snapshotId)) ||
      JSON.stringify(history.attemptIds) !== JSON.stringify(EffectArray.map(phaseAttempts, attempt => attempt.id)) ||
      history.snapshotIds.at(-1) !== admission.snapshotId ||
      history.planCount > runtime.plans.length ||
      history.expansionCount >
        EffectArray.filter(runtime.reviewExpansions, item => item.phaseId === admission.phaseId).length ||
      history.digest !== checksums.history(runtime, metadata, witness)
    )
      fail('Historical admission lost its complete source, review, attempt, budget or phase proof lineage.');
  }
  validateNativeCycleSupplementalPublications(runtime);
  return runtime;
}

/** Request-local reuse of actual plan-prefix checksums; no caller-supplied or persisted hash authority. */
export function makeNativeHistoricalDigests(plans: NativeCycleRuntime['plans']) {
  const prefixes = new Map<number, string>();
  const planLineage = (count: number) => {
    if (!Number.isInteger(count) || count < 1 || count > plans.length)
      throw WorkflowAutomationError.make({code: 'invalid-cycle-state', message: 'Historical plan prefix is missing.'});
    let digest = prefixes.get(count);
    if (digest === undefined) {
      digest = sha256HexSync(
        nativeCycleCanonicalJson(['threadnote-native-historical-plan-lineage-v1', count, plans.slice(0, count)]),
      );
      prefixes.set(count, digest);
    }
    return {count, digest};
  };
  const history = (
    runtime: NativeCycleRuntime,
    admission: Omit<NonNullable<NativeCycleRuntime['historicalAdmissions']>[number], 'history'>,
    witness: Omit<NonNullable<NativeCycleRuntime['historicalAdmissions']>[number]['history'], 'digest'>,
  ): string => {
    if (runtime.plans !== plans)
      throw WorkflowAutomationError.make({
        code: 'invalid-cycle-state',
        message: 'Historical checksum belongs to another plan lineage.',
      });
    const {phaseId} = admission;
    const snapshots = EffectArray.filter(runtime.snapshots, item => item.snapshot.phaseId === phaseId);
    const ids = new Set(EffectArray.map(snapshots, item => item.snapshot.snapshotId));
    return sha256HexSync(
      nativeCycleCanonicalJson({
        format: 'threadnote-native-historical-history-v2',
        historicalAdmission: runtime.historicalAdmission,
        admission,
        history: witness,
        planLineage: planLineage(witness.planCount),
        baseline: runtime.baselines[phaseId],
        phase: runtime.state.phases[phaseId],
        snapshots,
        reviews: EffectArray.filter(runtime.reviews, item => ids.has(item.snapshotId)),
        attempts: EffectArray.filter(runtime.attempts, item => ids.has(item.snapshotId)),
        expansions: EffectArray.filter(runtime.reviewExpansions, item => item.phaseId === phaseId).slice(
          0,
          witness.expansionCount,
        ),
      }),
    );
  };
  return {planLineage, history};
}

/** Canonical cycle CAS is independent of provider state and task-card serialization. */
export const nativeCycleSupplementalRevision = (runtime: NativeCycleRuntime): string =>
  sha256HexSync(nativeCycleCanonicalJson(runtime));
const supplementalDigest = (value: unknown): string => sha256HexSync(nativeCycleCanonicalJson(value));
const supplementalInitialRef = (publicationId: string): string =>
  supplementalDigest(['threadnote-supplemental-chain-initial-v1', publicationId]);
const supplementalRecordRef = (publicationId: string, operationId: string): string =>
  supplementalDigest(['threadnote-supplemental-chain-record-v1', publicationId, operationId]);
/** Operation identity binds the prior chain ref and the complete record; no prefix serialization. */
export const nativeCycleSupplementalRef = (publication: NativeCycleSupplementalPublication): string => {
  const last = publication.records.at(-1);
  return last
    ? supplementalRecordRef(publication.publicationId, last.operationId)
    : supplementalInitialRef(publication.publicationId);
};
const supplementalId = (initialization: NativeCycleSupplementalPublication['initialization']): string =>
  supplementalDigest(['threadnote-supplemental-initialization-v1', initialization]);
const supplementalOperation = (
  publicationId: string,
  record: Omit<NativeCycleSupplementalPublication['records'][number], 'operationId'>,
): string => supplementalDigest(['threadnote-supplemental-record-v1', publicationId, record]);
function supplementalFail(message: string): never {
  throw WorkflowAutomationError.make({code: 'invalid-cycle-state', message});
}

function supplementalProofContext(runtime: NativeCycleRuntime) {
  return {
    planDigest: supplementalDigest(runtime.state.plan),
    localComplete:
      runtime.state.plan.delivery === 'local' &&
      nextNativeCycle(runtime.state).action === 'complete' &&
      EffectArray.every(
        runtime.state.plan.phases,
        item => runtime.state.phases[item.id].delivery?.delivery === 'local',
      ),
  };
}
function validateSupplementalInitialization(
  runtime: NativeCycleRuntime,
  init: NativeCycleSupplementalPublication['initialization'],
  context = supplementalProofContext(runtime),
): void {
  const phase = runtime.state.phases[init.phaseId];
  const definition = EffectOption.getOrUndefined(
    EffectArray.findFirst(runtime.state.plan.phases, item => item.id === init.phaseId),
  );
  const stored = EffectArray.filter(runtime.snapshots, item => item.snapshot.phaseId === init.phaseId).at(-1);
  const snapshot = stored?.snapshot;
  const review = EffectOption.getOrUndefined(
    EffectArray.findFirst(runtime.reviews, item => item.snapshotId === init.snapshotId),
  );
  if (
    !context.localComplete ||
    !phase ||
    !definition ||
    !snapshot ||
    !review ||
    phase.delivery?.delivery !== 'local' ||
    !phase.validation ||
    init.planDigest !== context.planDigest ||
    init.phaseHash !== phase.phaseHash ||
    snapshot.snapshotId !== init.snapshotId ||
    snapshot.phaseHash !== init.phaseHash ||
    !nativeCycleSnapshotIsCurrentIteration(runtime, init.phaseId, init.snapshotId) ||
    (snapshot.acceptedHead ?? snapshot.head) !== init.head ||
    snapshot.tree !== init.tree ||
    phase.head !== init.head ||
    phase.tree !== init.tree ||
    init.validationDigest !== supplementalDigest(phase.validation) ||
    init.localReceiptDigest !== supplementalDigest(phase.delivery) ||
    init.pr.headSha !== init.head ||
    init.pr.branch !== definition.branch ||
    !/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/[1-9][0-9]*$/u.test(init.pr.url) ||
    (definition.baseBranch !== init.pr.baseBranch &&
      definition.baseBranch !== init.pr.baseRefBinding?.ref &&
      definition.baseBranch !== `${init.pr.baseRefBinding?.remote}/${init.pr.baseBranch}`)
  )
    supplementalFail('Supplemental attachment requires exact completed local proof and an existing matching PR.');
  const predecessorId = snapshot.previous ?? snapshot.supersedes;
  const predecessor = predecessorId
    ? EffectOption.getOrUndefined(
        EffectArray.findFirst(runtime.snapshots, item => item.snapshot.snapshotId === predecessorId),
      )?.snapshot
    : undefined;
  const priorReview = predecessor
    ? EffectOption.getOrUndefined(
        EffectArray.findFirst(runtime.reviews, item => item.snapshotId === predecessor.snapshotId),
      )?.report
    : undefined;
  if (
    validateNativeCycleReviewHistory(
      snapshot,
      review.report,
      predecessor && priorReview ? {snapshot: predecessor, review: priorReview} : undefined,
    ).summary.blockingIssueCount
  )
    supplementalFail('Supplemental attachment requires an accepted nonblocking source review.');
}

function validateSupplementalRecords(publication: NativeCycleSupplementalPublication): void {
  let previousRef = supplementalInitialRef(publication.publicationId);
  let verified = false,
    merged = false,
    watched = false,
    completed = false;
  const operations = new Set<string>();
  for (const record of publication.records) {
    const {operationId, ...request} = record;
    if (
      operations.has(operationId) ||
      operationId !== supplementalOperation(publication.publicationId, request) ||
      record.previousRef !== previousRef
    )
      supplementalFail('Supplemental records lost their unique operation identity or append-only predecessor.');
    operations.add(operationId);
    const event = record.event;
    if (event.kind === 'provider-verified') {
      const {state: _initialState, ...destination} = publication.initialization.pr;
      const {state: currentState, ...observed} = event.pr;
      if (
        verified ||
        (_initialState === 'merged' && currentState !== 'merged') ||
        nativeCycleCanonicalJson(destination) !== nativeCycleCanonicalJson(observed)
      )
        supplementalFail('Provider verification must bind the immutable authorized PR destination and head.');
      verified = true;
      merged = currentState === 'merged';
    } else if (event.kind === 'watch') {
      if (
        !verified ||
        event.watch.prUrl !== publication.initialization.pr.url ||
        event.watch.headSha !== publication.initialization.head ||
        event.watch.state !== (merged ? 'terminal' : 'active') ||
        !nativeCycleAbsolutePath(event.watch.stateDir)
      )
        supplementalFail('Supplemental watch requires matching verified PR and lifecycle proof.');
      watched = true;
    } else if (event.kind === 'merged') {
      if (!verified || merged) supplementalFail('Merge observation requires a verified open PR.');
      merged = true;
    } else {
      if (completed || !verified || (!merged && !watched))
        supplementalFail('Completion requires verified merge or active watch proof.');
      completed = true;
    }
    previousRef = supplementalRecordRef(publication.publicationId, operationId);
  }
}

function validateNativeCycleSupplementalPublications(runtime: NativeCycleRuntime): void {
  const publications = runtime.state.supplementalPublications ?? [];
  if (publications.length === 0) return;
  const context = supplementalProofContext(runtime);
  const ids = new Set<string>();
  for (const publication of publications) {
    if (ids.has(publication.publicationId) || publication.publicationId !== supplementalId(publication.initialization))
      supplementalFail('Supplemental initialization identity is immutable and unique.');
    ids.add(publication.publicationId);
    validateSupplementalInitialization(runtime, publication.initialization, context);
    validateSupplementalRecords(publication);
  }
}

export interface NativeCycleSupplementalSource {
  readonly head: string;
  readonly tree: string;
  readonly clean: boolean;
}
function requireSupplementalSource(
  source: NativeCycleSupplementalSource,
  init: NativeCycleSupplementalPublication['initialization'],
): void {
  if (source.clean !== true || source.head !== init.head || source.tree !== init.tree)
    supplementalFail('Changed or dirty source requires the ordinary development cycle and fresh validation.');
}

/** Pure proof admission only; the application must supply independently observed provider/source evidence. */
export function initializeNativeCycleSupplementalPublication(
  runtimeInput: NativeCycleRuntime,
  input: unknown,
  source: NativeCycleSupplementalSource,
): NativeCycleRuntime {
  const runtime = decodeNativeCycleRuntime(runtimeInput);
  const initialization = Schema.decodeUnknownSync(NativeCycleSupplementalInitSchema, {onExcessProperty: 'error'})(
    input,
  );
  requireSupplementalSource(source, initialization);
  validateSupplementalInitialization(runtime, initialization);
  const publicationId = supplementalId(initialization);
  if (EffectArray.some(runtime.state.supplementalPublications ?? [], item => item.publicationId === publicationId))
    return runtime;
  if (initialization.expectedRevision !== nativeCycleSupplementalRevision(runtime))
    supplementalFail('Supplemental initialization CAS is stale.');
  return decodeNativeCycleRuntime({
    ...runtime,
    state: {
      ...runtime.state,
      version: 2,
      supplementalPublications: [
        ...(runtime.state.supplementalPublications ?? []),
        {publicationId, initialization, records: []},
      ],
    },
  });
}

export function appendNativeCycleSupplementalRecord(
  runtimeInput: NativeCycleRuntime,
  input: {
    readonly publicationId: string;
    readonly publicationRef: string;
    readonly expectedRevision: string;
    readonly event: unknown;
  },
  source: NativeCycleSupplementalSource,
): NativeCycleRuntime {
  const runtime = decodeNativeCycleRuntime(runtimeInput);
  const publication = EffectOption.getOrUndefined(
    EffectArray.findFirst(
      runtime.state.supplementalPublications ?? [],
      item => item.publicationId === input.publicationId,
    ),
  );
  if (!publication) return supplementalFail('Supplemental publication owner is missing.');
  requireSupplementalSource(source, publication.initialization);
  const event = Schema.decodeUnknownSync(NativeCycleSupplementalEventSchema, {onExcessProperty: 'error'})(input.event);
  const request = {
    version: 1 as const,
    expectedRevision: input.expectedRevision,
    previousRef: input.publicationRef,
    event,
  };
  const operationId = supplementalOperation(publication.publicationId, request);
  if (EffectArray.some(publication.records, item => item.operationId === operationId)) return runtime;
  if (
    input.expectedRevision !== nativeCycleSupplementalRevision(runtime) ||
    input.publicationRef !== nativeCycleSupplementalRef(publication)
  )
    supplementalFail('Supplemental record CAS or publication reference is stale.');
  const updated = {...publication, records: [...publication.records, {...request, operationId}]};
  return decodeNativeCycleRuntime({
    ...runtime,
    state: {
      ...runtime.state,
      supplementalPublications: EffectArray.map(runtime.state.supplementalPublications ?? [], item =>
        item.publicationId === publication.publicationId ? updated : item,
      ),
    },
  });
}
