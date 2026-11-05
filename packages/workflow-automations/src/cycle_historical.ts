import {Array as EffectArray, Predicate, Schema, String as EffectString} from 'effect';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {
  NativeCyclePhaseProofSchema,
  checkNativeCycleScope,
  nativeCycleCanonicalJson,
  nativeCyclePhaseHash,
  recordNativeCycleDelivery,
  validateNativeCyclePhase,
} from './cycle.js';
import {
  NativeCycleBaselineSchema,
  NativeCycleReviewAttemptSchema,
  NativeCycleReviewExpansionSchema,
  NativeCycleRuntimeSchema,
  NativeCycleStoredSnapshotSchema,
  decodeNativeCycleRuntime,
  nativeCyclePhaseReviewUsage,
  makeNativeHistoricalDigests,
  type NativeCycleRuntime,
} from './cycle_runtime.js';
import {NativeCycleReviewSchema, validateNativeCycleReview, validateNativeCycleReviewHistory} from './cycle_review.js';
import {WorkflowAutomationError} from './contracts.js';

const gitObject = Schema.String.check(Schema.isPattern(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u));
const id = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u));
const ref = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2048));
const roundSchema = Schema.Struct({
  ...NativeCycleStoredSnapshotSchema.fields,
  review: NativeCycleReviewSchema,
  attempts: Schema.Array(
    Schema.Struct({
      attempt: NativeCycleReviewAttemptSchema,
      expansionsBefore: Schema.Array(NativeCycleReviewExpansionSchema).check(Schema.isMaxLength(256)),
    }),
  ).check(Schema.isBetweenLength(1, 512)),
  proofs: Schema.Array(NativeCyclePhaseProofSchema).check(Schema.isMaxLength(64)),
});
export const NativeHistoricalPhaseEvidenceSchema = Schema.Struct({
  phaseId: id,
  sourceBaseCommit: gitObject,
  sourceBaseTree: gitObject,
  baseline: NativeCycleBaselineSchema,
  rounds: Schema.Array(roundSchema).check(Schema.isBetweenLength(1, 256)),
  evidenceRefs: Schema.Array(ref).check(Schema.isBetweenLength(1, 32)),
});
export const NativeHistoricalPrefixEvidenceSchema = Schema.Struct({
  plans: NativeCycleRuntimeSchema.fields.plans,
  phases: Schema.Array(NativeHistoricalPhaseEvidenceSchema).check(Schema.isBetweenLength(1, 128)),
});

/** Fixed historical phase bundle; structural checks do not authenticate external facts or human authority. */
export function admitNativeHistoricalPrefix(
  input: NativeCycleRuntime,
  evidenceInput: typeof NativeHistoricalPrefixEvidenceSchema.Type,
): NativeCycleRuntime {
  const runtime = decodeNativeCycleRuntime(input);
  preflightHistoricalEvidence(evidenceInput, runtime);
  const evidence = Schema.decodeSync(NativeHistoricalPrefixEvidenceSchema, {onExcessProperty: 'error'})(evidenceInput);
  const checksums = makeNativeHistoricalDigests(evidence.plans);
  const planLineage = checksums.planLineage(evidence.plans.length);
  const prior = runtime.historicalAdmissions ?? [];
  const same = (a: unknown, b: unknown) => nativeCycleCanonicalJson(a) === nativeCycleCanonicalJson(b);
  if (evidence.phases.length > runtime.state.plan.phases.length)
    fail('Historical admission requires an ordered phase prefix.');
  if (prior.length) {
    if (
      prior.length === evidence.phases.length &&
      EffectArray.every(
        evidence.phases,
        (item, index) =>
          prior[index]?.phaseId === item.phaseId && prior[index]?.evidenceDigest === digestEvidence(item, planLineage),
      )
    )
      return runtime;
    fail('Historical replay must contain the exact complete original bundle.');
  }
  if (
    !same(evidence.plans.at(-1), runtime.state.plan) ||
    evidence.plans.length < runtime.plans.length ||
    !same(evidence.plans.slice(-runtime.plans.length), runtime.plans) ||
    EffectArray.some(
      evidence.plans,
      plan =>
        plan.featureId !== runtime.state.plan.featureId ||
        plan.project !== runtime.state.plan.project ||
        !same(plan.source.binding, runtime.state.plan.source.binding),
    )
  )
    fail('Retain the original plan lineage ending in the current same-run approved-plan contract.');
  const roundCount = EffectArray.reduce(evidence.phases, 0, (n, item) => n + item.rounds.length);
  const attemptCount = EffectArray.reduce(
    evidence.phases,
    0,
    (n, item) => n + EffectArray.reduce(item.rounds, 0, (m, round) => m + round.attempts.length),
  );
  const expansionCount = EffectArray.reduce(
    evidence.phases,
    0,
    (n, item) =>
      n +
      EffectArray.reduce(
        item.rounds,
        0,
        (m, round) => m + EffectArray.reduce(round.attempts, 0, (k, entry) => k + entry.expansionsBefore.length),
      ),
  );
  if (
    runtime.snapshots.length + roundCount > 256 ||
    runtime.reviews.length + roundCount > 256 ||
    runtime.attempts.length + attemptCount > 512 ||
    runtime.reviewExpansions.length + expansionCount > 256
  )
    fail('The complete original history exceeds the existing canonical runtime capacity.');
  let result: NativeCycleRuntime = {
    ...runtime,
    plans: evidence.plans,
    historicalAdmission: {version: 1, phaseCount: evidence.phases.length},
  };
  const admissions: NonNullable<NativeCycleRuntime['historicalAdmissions']>[number][] = [];
  const snapshotIds = new Set(EffectArray.map(runtime.snapshots, entry => entry.snapshot.snapshotId));
  const attemptIds = new Set(EffectArray.map(runtime.attempts, entry => entry.id));
  for (const [index, item] of evidence.phases.entries()) {
    const phase = result.state.plan.phases[index];
    if (
      !phase ||
      phase.id !== item.phaseId ||
      result.state.phases[phase.id]?.status !== 'pending' ||
      result.state.phases[phase.id]?.history?.length ||
      item.sourceBaseCommit !== item.baseline.head ||
      item.sourceBaseTree !== item.baseline.tree ||
      !EffectString.trim(item.baseline.repo) ||
      !EffectString.trim(item.baseline.pinnedRef) ||
      EffectArray.some(result.snapshots, entry => entry.snapshot.phaseId === phase.id) ||
      (result.baselines[phase.id] && !same(result.baselines[phase.id], item.baseline))
    )
      fail('Historical phase must match the exact pending ordered prefix and its original source baseline.');
    result = {...result, baselines: {...result.baselines, [phase.id]: item.baseline}};
    const phaseProofs: (typeof NativeCyclePhaseProofSchema.Type)[] = [];
    for (const [roundIndex, round] of item.rounds.entries()) {
      const snapshot = round.snapshot;
      const previous = item.rounds[roundIndex - 1];
      if (
        snapshotIds.has(snapshot.snapshotId) ||
        snapshot.phaseId !== phase.id ||
        snapshot.repo !== item.baseline.repo ||
        snapshot.baseTree !== item.sourceBaseTree ||
        (!previous &&
          (snapshot.previous ||
            snapshot.supersedes ||
            snapshot.previousTree ||
            snapshot.scopeBase !== item.sourceBaseCommit)) ||
        (previous && (snapshot.previous ?? snapshot.supersedes) !== previous.snapshot.snapshotId)
      )
        fail('Every original snapshot must retain its exact ordered predecessor and baseline.');
      const sourcePlan = EffectArray.findFirst(
        evidence.plans,
        plan =>
          EffectArray.some(plan.phases, entry => entry.id === phase.id) &&
          nativeCyclePhaseHash(plan, phase.id) === snapshot.phaseHash,
      );
      const sourcePhase =
        sourcePlan._tag === 'Some'
          ? EffectArray.findFirst(sourcePlan.value.phases, entry => entry.id === phase.id)
          : undefined;
      if (!sourcePhase || sourcePhase._tag === 'None' || !checkNativeCycleScope(sourcePhase.value, snapshot.files))
        fail('The original snapshot needs its retained phase definition and complete allowed source scope.');
      const predecessor = previous ? {snapshot: previous.snapshot, review: previous.review} : undefined;
      const final = roundIndex === item.rounds.length - 1;
      const verdict = final
        ? validateNativeCycleReview(snapshot, round.review, predecessor)
        : validateNativeCycleReviewHistory(snapshot, round.review, predecessor);
      if (
        final &&
        (snapshot.phaseHash !== nativeCyclePhaseHash(result.state.plan, phase.id) ||
          verdict.summary.blockingIssueCount !== 0 ||
          round.proofs.length === 0)
      )
        fail('Only a nonblocking exact-current-phase review and validation can establish final acceptance.');
      snapshotIds.add(snapshot.snapshotId);
      result = {...result, snapshots: [...result.snapshots, {snapshot, incoming: round.incoming}]};
      let accepted = false;
      let invalidCount = 0;
      for (const {attempt, expansionsBefore} of round.attempts) {
        for (const expansion of expansionsBefore) {
          const limit = result.reviewLimits[phase.id] ?? 5;
          if (
            expansion.phaseId !== phase.id ||
            expansion.from !== limit ||
            !Number.isSafeInteger(expansion.to) ||
            expansion.to <= limit ||
            expansion.to > 256 ||
            !EffectString.trim(expansion.authority)
          )
            fail('Keep the exact ordered explicit budget authorizations; never infer an expansion.');
          result = {
            ...result,
            reviewLimits: {...result.reviewLimits, [phase.id]: expansion.to},
            reviewExpansions: [...result.reviewExpansions, expansion],
          };
        }
        if (
          attemptIds.has(attempt.id) ||
          attempt.snapshotId !== snapshot.snapshotId ||
          attempt.digest !== sha256HexSync(attempt.report) ||
          nativeCyclePhaseReviewUsage(result, phase.id).exhausted ||
          (invalidCount >= 2 && !EffectString.trim(attempt.authority ?? ''))
        )
          fail('An original attempt lost its identity, report digest, continuous budget or recovery authority.');
        let parsed: unknown;
        let valid = false;
        try {
          parsed = JSON.parse(attempt.report);
          validateNativeCycleReview(snapshot, parsed, predecessor);
          valid = true;
        } catch {
          /* Original malformed reports are retained verbatim. */
        }
        if (attempt.status === 'accepted') {
          if (accepted || !same(parsed, round.review))
            fail('Retain exactly one original accepted attempt for each completed report.');
          validateNativeCycleReviewHistory(snapshot, parsed, predecessor);
          accepted = true;
          result = {...result, reviews: [...result.reviews, {snapshotId: snapshot.snapshotId, report: round.review}]};
        } else {
          if (valid) fail('A structurally valid report cannot be relabelled as an invalid original attempt.');
          invalidCount++;
        }
        attemptIds.add(attempt.id);
        result = {...result, attempts: [...result.attempts, attempt]};
      }
      if (!accepted) fail('The original completed report has no retained accepted attempt.');
      if (round.proofs.length && verdict.summary.blockingIssueCount)
        fail('Blocking original findings cannot authorize validation or delivery.');
      for (const proof of round.proofs) {
        if (
          proof.phaseHash !== snapshot.phaseHash ||
          proof.phaseHash !== nativeCyclePhaseHash(result.state.plan, phase.id) ||
          proof.head !== snapshot.head ||
          proof.tree !== snapshot.tree ||
          proof.validation.head !== snapshot.head ||
          proof.validation.reviewTree !== snapshot.tree
        )
          fail('Historical phase proof must bind to its reviewed exact current phase source.');
        let state = validateNativeCyclePhase(result.state, phase.id, snapshot, proof.validation);
        if (proof.delivery) state = recordNativeCycleDelivery(state, phase.id, proof.delivery);
        phaseProofs.push(proof);
        result = {...result, state};
      }
    }
    const final = item.rounds.at(-1)!;
    const phaseState = result.state.phases[phase.id];
    const finalProof = phaseProofs.at(-1)!;
    if (
      phaseState.status !== 'merged' ||
      finalProof.delivery?.pr?.state !== 'merged' ||
      !same(phaseState.history ?? [], phaseProofs.slice(0, -1))
    )
      fail(
        'The original proof lineage must end in merged PR delivery and remain exactly representable by canonical history.',
      );
    const metadata = {
      phaseId: phase.id,
      phaseHash: final.snapshot.phaseHash,
      snapshotId: final.snapshot.snapshotId,
      sourceBaseCommit: item.sourceBaseCommit,
      sourceBaseTree: item.sourceBaseTree,
      evidenceDigest: digestEvidence(item, planLineage),
      evidenceRefs: item.evidenceRefs,
    };
    const history = {
      snapshotIds: EffectArray.map(item.rounds, round => round.snapshot.snapshotId),
      attemptIds: EffectArray.flatMap(item.rounds, round => EffectArray.map(round.attempts, entry => entry.attempt.id)),
      planCount: result.plans.length,
      expansionCount: EffectArray.filter(result.reviewExpansions, entry => entry.phaseId === phase.id).length,
    };
    admissions.push({
      ...metadata,
      history: {...history, digest: checksums.history(result, metadata, history)},
    });
  }

  return decodeNativeCycleRuntime({...result, historicalAdmissions: admissions});
}

/** Length-only fixed-shape preflight. Full schema/reducer validation still follows. */
function preflightHistoricalEvidence(input: unknown, runtime: NativeCycleRuntime): void {
  const record = (value: unknown) => {
    if (!Predicate.isObject(value) || EffectArray.isArray(value))
      fail('Historical capacity preflight requires evidence records.');
    return value;
  };
  const array = (value: unknown, maximum: number) => {
    if (!EffectArray.isArray(value) || value.length > maximum)
      fail('Historical capacity exceeds the canonical runtime limits.');
    return value;
  };
  const root = record(input);
  const phases = array(root.phases, Math.min(128, runtime.state.plan.phases.length));
  array(root.plans, 64);
  const replay = (runtime.historicalAdmissions?.length ?? 0) > 0;
  const roundLimit = replay ? 256 : Math.min(256 - runtime.snapshots.length, 256 - runtime.reviews.length);
  const attemptLimit = replay ? 512 : 512 - runtime.attempts.length;
  const expansionLimit = replay ? 256 : 256 - runtime.reviewExpansions.length;
  const incomingLimit =
    256 * 8192 - (replay ? 0 : EffectArray.reduce(runtime.snapshots, 0, (n, item) => n + item.incoming.length));
  const phaseRounds: unknown[][] = [];
  let rounds = 0;
  // Prove the total round bound before visiting any round's children.
  for (const phase of phases) {
    const entries = array(record(phase).rounds, roundLimit - rounds);
    rounds += entries.length;
    phaseRounds.push(entries);
  }
  const attemptGroups: unknown[][] = [];
  let attempts = 0;
  let incoming = 0;
  // Prove aggregate attempt/proof/incoming capacities before visiting attempt children.
  for (const entries of phaseRounds) {
    let proofs = 0;
    for (const entry of entries) {
      const round = record(entry);
      const submitted = array(round.attempts, attemptLimit - attempts);
      attempts += submitted.length;
      attemptGroups.push(submitted);
      // A phase retains at most 64 historical proofs and one current proof; each round's schema caps 64.
      proofs += array(round.proofs, Math.min(64, 65 - proofs)).length;
      incoming += array(round.incoming, Math.min(8192, incomingLimit - incoming)).length;
    }
  }
  let expansions = 0;
  for (const entries of attemptGroups)
    for (const entry of entries)
      expansions += array(record(entry).expansionsBefore, expansionLimit - expansions).length;
}

function digestEvidence(
  value: typeof NativeHistoricalPhaseEvidenceSchema.Type,
  planLineage: {readonly count: number; readonly digest: string},
): string {
  return sha256HexSync(nativeCycleCanonicalJson(['threadnote-native-historical-admission-v3', planLineage, value]));
}
function fail(message: string): never {
  throw WorkflowAutomationError.make({code: 'invalid-cycle', message});
}
