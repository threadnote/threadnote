import {Clock, Context, Effect, FileSystem, Option, Path, Result, Scope} from 'effect';
import {loadCandidateReviewOptional, type CandidateReview} from '@threadnote/memory/candidate';
import {localMemoryPathForUri} from '@threadnote/memory/local-path';
import {readSeedManifest} from '@threadnote/workspace/manifest';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {expandPath} from '@threadnote/platform/paths';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {readSettledCanonicalMutationGeneration} from '@threadnote/store/resource/settled_revision';
import type {ManagerReviewBackgroundV1, ManagerReviewReadinessReason} from '@threadnote/manager/attention/contracts';
import {
  automaticReviewIsAssessment,
  untouchedAutomaticReview,
} from '../memory/context/maintenance_review_classification.js';
import {
  readContextMaintenanceSourceEpoch,
  readContextMaintenanceCitationAssociation,
} from '../memory/context/maintenance_evidence.js';
import {readTopicMaintenanceDraft} from '../memory/context/maintenance_draft.js';
import {readContextMaintenanceCanonicalRecord} from '../memory/context/maintenance_inventory.js';
import {maintenanceContentHash} from '../memory/context/maintenance_policy.js';
import {ManagerConsumerClockHints} from './live_consumer_sources.js';
import {ManagerHealthObservationHints} from './live_health_sources.js';

export type ReviewEligibility = 'actionable' | 'assessment' | 'waiting' | 'obsolete' | 'protected';
export interface ReviewReadiness {
  readonly state: 'actionable' | 'waiting' | 'obsolete';
  readonly reason?: ManagerReviewReadinessReason;
}
interface CachedReadiness {
  readonly epoch: string;
  readonly marker: string;
  readonly owner: Scope.Scope | undefined;
  readonly value: ReviewReadiness;
  readonly nextRetryAt: number;
}
/** The existing Manager lifecycle owns every asynchronous read; direct handler callers await the same worker. */
export const ManagerReviewVerificationScope = Context.Reference<Scope.Scope | undefined>(
  'threadnote/ManagerReviewVerificationScope',
  {defaultValue: () => undefined},
);
export const ManagerReviewSourceReadiness = Context.Reference<{
  readonly current: (project: string) => boolean | undefined;
}>('threadnote/ManagerReviewSourceReadiness', {defaultValue: () => ({current: () => true})});
const RETRY_MS = 60_000;
const cache = new Map<string, CachedReadiness>();
const cursors = new Map<string, string>();
const active = new Map<string, symbol>();
interface PendingReview {
  readonly reviewId: string;
  readonly revision: number;
  readonly project: string;
  readonly config: RuntimeConfig;
  readonly owner: Scope.Scope | undefined;
  readonly requestedAt: number;
}
const pending = new Map<string, Map<string, PendingReview>>();
const invalidations = new Map<string, number>();
const principal = (config: RuntimeConfig) => JSON.stringify([config.agentContextHome, config.account, config.user]);
export function invalidateManagerReviewReadiness(config: RuntimeConfig): void {
  const key = principal(config);
  invalidations.set(key, (invalidations.get(key) ?? 0) + 1);
  while (invalidations.size > 32) invalidations.delete(invalidations.keys().next().value!);
}

export function reviewReadinessReason(error: unknown): ManagerReviewReadinessReason {
  const reason = (error as {readonly reason?: unknown})?.reason;
  return ['target-changed', 'source-changed', 'source-unavailable', 'scope-changed', 'policy-changed'].includes(
    String(reason),
  )
    ? (reason as ManagerReviewReadinessReason)
    : 'verification-unavailable';
}

/** Pure partition shared by every count, scope and tab. Protected work retains its existing recovery route. */
export function projectManagerReviewEligibility(
  reviews: readonly CandidateReview[],
  readiness: ReadonlyMap<string, ReviewReadiness> = new Map(),
) {
  const byReview = new Map<string, ReviewEligibility>();
  const background: ManagerReviewBackgroundV1 = {assessments: 0, awaitingSources: 0, obsolete: 0, reasons: {}};
  let pendingCount = 0;
  for (const review of reviews) {
    if (review.maintenanceCapture && !review.maintenance) continue;
    let eligibility: ReviewEligibility = 'protected';
    if (automaticReviewIsAssessment(review)) {
      eligibility = 'assessment';
      background.assessments++;
    } else if (untouchedAutomaticReview(review)) {
      const observed = readiness.get(`${review.reviewId}:${review.revision}`);
      eligibility = observed?.state ?? 'waiting';
      if (eligibility === 'waiting') {
        background.awaitingSources++;
        const reason = observed?.reason ?? 'checking';
        background.reasons[reason] = (background.reasons[reason] ?? 0) + 1;
      } else if (eligibility === 'obsolete') background.obsolete++;
    }
    byReview.set(review.reviewId, eligibility);
    if (eligibility === 'actionable' || eligibility === 'protected')
      pendingCount += review.candidates.filter(candidate =>
        ['pending', 'deferred', 'applying'].includes(candidate.state),
      ).length;
  }
  return {byReview, background, pendingCount};
}

/** Cheap access/stat observations do not read private documents or graph quotations on a poll. */
const observeMarkers = Effect.fn('managerReviews.observeMarkers')(function* (
  config: RuntimeConfig,
  reviews: readonly CandidateReview[],
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const canonical = yield* readSettledCanonicalMutationGeneration(fs, path, config.agentContextHome, config.account);
  const manifest = yield* fs.readFileString(config.manifestPath);
  const configuredManifest = yield* readSeedManifest(config.manifestPath);
  const generation = invalidations.get(principal(config)) ?? 0;
  const markers = new Map<string, string>();
  for (const review of reviews) {
    const memoryAccess = [];
    const sourceObservable = (yield* ManagerReviewSourceReadiness).current(review.project);
    if (review.maintenance?.version === 3) {
      const uris = [
        ...new Set([
          review.maintenance.basis.targetUri,
          ...review.maintenance.basis.reads.map(read => read.uri).filter(uri => !uri.startsWith('code:')),
        ]),
      ].sort();
      for (const uri of uris) {
        const file = yield* localMemoryPathForUri(config, uri);
        const metadata = yield* Effect.gen(function* () {
          if (!file) return 'unresolved';
          yield* fs.access(file, {readable: true});
          const info = yield* fs.stat(file);
          return [
            yield* fs.realPath(file),
            info.mode,
            info.size.toString(),
            Option.getOrUndefined(info.ino)?.toString(),
            Option.getOrUndefined(info.mtime)?.getTime(),
          ];
        }).pipe(Effect.orElseSucceed(() => 'unavailable'));
        memoryAccess.push([uri, metadata]);
      }
    }
    const codeAccess = [];
    const configured = configuredManifest.projects.filter(project => project.name === review.project);
    const root = configured.length === 1 ? yield* expandPath(configured[0].path) : undefined;
    if (root && review.maintenance?.version === 3) {
      const files = [
        ...new Set(
          review.maintenance.basis.assessment.evidence.flatMap(item =>
            item.source.kind === 'code' ? [item.source.citation.path] : [],
          ),
        ),
      ].sort();
      for (const relative of files) {
        const file = path.resolve(root, relative);
        if (!file.startsWith(`${root}${path.sep}`)) {
          codeAccess.push([relative, 'outside']);
          continue;
        }
        const info = yield* fs.stat(file).pipe(Effect.option);
        codeAccess.push([
          relative,
          Option.isSome(info)
            ? [
                info.value.mode,
                info.value.size.toString(),
                Option.getOrUndefined(info.value.ino)?.toString(),
                Option.getOrUndefined(info.value.mtime)?.getTime(),
              ]
            : 'unavailable',
        ]);
      }
    }
    markers.set(
      `${review.reviewId}:${review.revision}`,
      sha256HexSync(JSON.stringify([canonical, manifest, generation, memoryAccess, codeAccess, sourceObservable])),
    );
  }
  return markers;
});

/** Full source epochs are observed only by the one bounded worker, including its independent closing fence. */
const observeEpoch = Effect.fn('managerReviews.observeEpoch')(function* (
  config: RuntimeConfig,
  review: CandidateReview,
) {
  const manifest = yield* readSeedManifest(config.manifestPath);
  const configured = manifest.projects.filter(candidate => candidate.name === review.project);
  const root = configured.length === 1 ? yield* expandPath(configured[0].path) : undefined;
  const citations =
    review.maintenance?.version === 3
      ? review.maintenance.basis.assessment.evidence.flatMap(item =>
          item.source.kind === 'code' ? [item.source.citation] : [],
        )
      : [];
  if (root) yield* (yield* ManagerHealthObservationHints).register(review.project, {cwd: root, citations});
  const source = root ? yield* readContextMaintenanceSourceEpoch(config, root, review.project) : undefined;
  const association = citations.length
    ? yield* readContextMaintenanceCitationAssociation(config, root ?? config.agentContextHome, citations)
    : undefined;
  return sha256HexSync(JSON.stringify([manifest, root, source, association?.epoch]));
});

const verify = Effect.fn('managerReviews.verify')(function* (config: RuntimeConfig, review: CandidateReview) {
  if (review.maintenance?.version !== 3) return {state: 'waiting', reason: 'verification-unavailable'} as const;
  if (review.maintenance.basis.assessment.target.readOnly) return {state: 'waiting', reason: 'policy-changed'} as const;
  const target = yield* readContextMaintenanceCanonicalRecord(config, review.maintenance.basis.targetUri);
  if (maintenanceContentHash(target.record.content) !== review.maintenance.basis.targetHash)
    return {state: 'obsolete', reason: 'target-changed'} as const;
  const current = yield* readTopicMaintenanceDraft(config, review.reviewId);
  // A stale asynchronous result cannot upgrade a newer journal or a human/writer-owned revision.
  if (current.revision !== review.revision || !untouchedAutomaticReview(current))
    return {state: 'waiting', reason: 'verification-unavailable'} as const;
  const closingTarget = yield* readContextMaintenanceCanonicalRecord(config, review.maintenance.basis.targetUri);
  if (maintenanceContentHash(closingTarget.record.content) !== review.maintenance.basis.targetHash)
    return {state: 'obsolete', reason: 'target-changed'} as const;
  return {state: 'actionable'} as const;
});

const registerRetry = Effect.fn('managerReviews.registerRetry')(function* (projects: readonly string[], next: number) {
  for (const project of new Set(['', ...projects]))
    for (const topic of project ? (['home', 'automatic-memory'] as const) : (['home'] as const))
      yield* (yield* ManagerConsumerClockHints).register(topic, project, next);
});

export const readManagerReviewEligibility = Effect.fn('managerReviews.eligibility')(function* (
  config: RuntimeConfig,
  reviews: readonly CandidateReview[],
) {
  const candidates = reviews.filter(review => untouchedAutomaticReview(review) && !automaticReviewIsAssessment(review));
  if (!candidates.length) return projectManagerReviewEligibility(reviews);
  const now = yield* Clock.currentTimeMillis;
  const owner = yield* ManagerReviewVerificationScope;
  const markers = yield* observeMarkers(config, candidates).pipe(Effect.timeout('1 second'), Effect.result);
  const ready = new Map<string, ReviewReadiness>();
  let nextRetryAt = Infinity;
  const homeKey = principal(config);
  const queue = pending.get(homeKey) ?? new Map<string, PendingReview>();
  pending.set(homeKey, queue);
  while (pending.size > 32) pending.delete(pending.keys().next().value!);
  for (const [id, entry] of queue) if (entry.requestedAt + RETRY_MS < now || entry.owner !== owner) queue.delete(id);
  for (const review of reviews) if (!candidates.includes(review)) queue.delete(review.reviewId);
  for (const review of candidates) {
    const identity = `${review.reviewId}:${review.revision}`;
    const key = JSON.stringify([homeKey, identity]);
    const prior = cache.get(key);
    const marker = Result.isSuccess(markers) ? markers.success.get(identity) : undefined;
    if (marker !== undefined && prior && prior.owner === owner && prior.marker === marker && now < prior.nextRetryAt) {
      ready.set(identity, prior.value);
      nextRetryAt = Math.min(nextRetryAt, prior.nextRetryAt);
      queue.delete(review.reviewId);
    } else {
      ready.set(identity, {state: 'waiting', reason: marker === undefined ? 'verification-unavailable' : 'checking'});
      nextRetryAt = Math.min(nextRetryAt, now + RETRY_MS);
      if (marker !== undefined && (queue.size < 500 || queue.has(review.reviewId)))
        queue.set(review.reviewId, {
          reviewId: review.reviewId,
          revision: review.revision,
          project: review.project,
          config,
          owner,
          requestedAt: now,
        });
    }
  }
  if (!active.has(homeKey) && queue.size) {
    const sorted = [...queue.values()].sort((a, b) => a.reviewId.localeCompare(b.reviewId));
    const cursor = cursors.get(homeKey) ?? '';
    const selected = sorted.find(entry => entry.reviewId > cursor) ?? sorted[0];
    const {config: selectedConfig} = selected;
    const identity = `${selected.reviewId}:${selected.revision}`;
    const key = JSON.stringify([homeKey, identity]);
    queue.delete(selected.reviewId);
    cursors.set(homeKey, selected.reviewId);
    while (cursors.size > 32) cursors.delete(cursors.keys().next().value!);
    const token = Symbol('review-readiness');
    active.set(homeKey, token);
    const projects = [...reviews.map(item => item.project), selected.project];
    const run = Effect.gen(function* () {
      let marker = 'unavailable';
      let requiresSourceObservation = false;
      const observed = yield* Effect.gen(function* () {
        const review = yield* loadCandidateReviewOptional(selectedConfig.agentContextHome, selected.reviewId);
        if (review?.revision !== selected.revision || !untouchedAutomaticReview(review))
          return {
            epoch: 'review-changed',
            value: {state: 'waiting', reason: 'verification-unavailable'} as const,
          };
        requiresSourceObservation =
          review.maintenance?.version === 3 &&
          review.maintenance.basis.reads.some(read => read.uri.startsWith('code:'));
        marker = (yield* observeMarkers(selectedConfig, [review])).get(identity)!;
        const opening = yield* observeEpoch(selectedConfig, review);
        const result = yield* verify(selectedConfig, review).pipe(Effect.result);
        const closing = yield* observeEpoch(selectedConfig, review);
        const after = yield* observeMarkers(selectedConfig, [review]);
        const current = yield* loadCandidateReviewOptional(selectedConfig.agentContextHome, review.reviewId);
        if (
          opening !== closing ||
          after.get(identity) !== marker ||
          current?.revision !== review.revision ||
          !untouchedAutomaticReview(current)
        )
          return {epoch: closing, value: {state: 'waiting', reason: 'verification-unavailable'} as const};
        const reason = Result.isFailure(result) ? reviewReadinessReason(result.failure) : undefined;
        return {
          epoch: closing,
          value: Result.isSuccess(result)
            ? result.success
            : ({
                state: reason === 'target-changed' || reason === 'source-changed' ? 'obsolete' : 'waiting',
                reason,
              } as const),
        };
      }).pipe(Effect.timeoutOption('30 seconds'), Effect.result);
      if (active.get(homeKey) !== token) return;
      const completed = yield* Clock.currentTimeMillis;
      const sourceObservable = (yield* ManagerReviewSourceReadiness).current(selected.project);
      const value =
        Result.isSuccess(observed) && Option.isSome(observed.success)
          ? observed.success.value
          : {epoch: 'unavailable', value: {state: 'waiting', reason: 'verification-unavailable'} as const};
      const fencedValue =
        value.value.state === 'actionable' && owner && requiresSourceObservation && sourceObservable !== true
          ? {...value, value: {state: 'waiting', reason: 'verification-unavailable'} as const}
          : value;
      cache.set(key, {...fencedValue, marker, owner, nextRetryAt: completed + RETRY_MS});
      while (cache.size > 256) cache.delete(cache.keys().next().value!);
      yield* registerRetry(projects, completed + 1);
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          if (active.get(homeKey) === token) active.delete(homeKey);
        }),
      ),
    );
    if (owner) {
      const environment = yield* Effect.context<Effect.Services<typeof run>>();
      yield* run.pipe(Effect.provide(environment), Effect.forkIn(owner));
    } else {
      yield* run;
      if (candidates.some(candidate => candidate.reviewId === selected.reviewId))
        ready.set(identity, cache.get(key)?.value ?? {state: 'waiting', reason: 'verification-unavailable'});
    }
  }
  if (active.has(homeKey)) nextRetryAt = Math.min(nextRetryAt, now + 30_000);
  const result = projectManagerReviewEligibility(reviews, ready);
  if (Number.isFinite(nextRetryAt))
    yield* registerRetry(
      reviews.map(review => review.project),
      nextRetryAt,
    );
  return {...result, background: {...result.background, ...(Number.isFinite(nextRetryAt) ? {nextRetryAt} : {})}};
});
