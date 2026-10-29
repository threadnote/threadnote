import {Clock, Effect, Option, Ref, Semaphore} from 'effect';
import {materializationStorageShortfalls} from '../indexer/materialization.js';
import {codeGraphEtaMeasurement, makeCodeGraphEtaTracker, observeCodeGraphEta} from '../progress/eta.js';
import {formatCodeGraphStatusDuration} from '../status/render.js';
import type {CodeGraphProgress} from '../types.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

interface CodeGraphRepairProgressLine {
  readonly current: number;
  readonly phase:
    'checking' | 'cleaning-snapshots' | 'cleaning-vectors' | 'deferred' | 'discarding' | 'migrating-schema';
  readonly total: number;
}

export function formatCodeGraphIndexProgressLine(progress: CodeGraphProgress, remainingMilliseconds?: number): string {
  const eta = formatEtaSuffix(remainingMilliseconds);
  switch (progress.phase) {
    case 'registering':
      return `Registering${eta}`;
    case 'waiting':
      return `${waitingProgressLabel(progress.reason)}${waitingQueueLabel(progress)}${eta}`;
    case 'scanning':
      return `Scanning · ${countProgress(progress.completed, progress.total)} files${eta}`;
    case 'materializing': {
      const disk =
        progress.metrics?.storage === undefined
          ? ''
          : materializationStorageShortfalls(progress.metrics.storage).length > 0
            ? ' · low disk'
            : '';
      return `Materializing · ${countProgress(progress.completed, progress.total)} files${disk}${eta}`;
    }
    case 'reclaiming':
      return `Reclaiming · ${countProgress(progress.completed, progress.total)} snapshots${eta}`;
    case 'resolving':
      if (progress.subphase === 'complete') {
        return `Resolved · ${progress.symbols.toLocaleString()} symbols`;
      }
      if (progress.activity) {
        return `Resolving · ${countProgress(progress.activity.referencesCompleted, progress.activity.referencesTotal)} references${eta}`;
      }
      return 'Resolving references';
    case 'embedding':
      return `Embedding · ${countProgress(Math.min(progress.total, progress.embedded + progress.reused), progress.total)}${eta}`;
    case 'sharing':
      return {
        'applying-deltas': 'Applying shared checkpoint',
        'building-local-overlay': 'Building local overlay',
        'discovering-shared-base': 'Discovering shared base',
        'downloading-checkpoint': 'Downloading shared checkpoint',
      }[progress.subphase];
    case 'activating':
      return progress.activity
        ? `Activating · ${Effect2.pipe(progress.activity.stage, EffectString.replaceAll('-', ' '))}`
        : 'Activating snapshot';
  }
}

export function formatCodeGraphDoctorProgressLine(progress: CodeGraphRepairProgressLine): string {
  const database = `${progress.current}/${progress.total} databases`;
  switch (progress.phase) {
    case 'checking':
      return `Checking · checking ${database}`;
    case 'deferred':
      return `Checking · deferred ${database}`;
    default:
      return `Checking · ${Effect2.pipe(progress.phase, EffectString.replaceAll('-', ' '))} · ${database}`;
  }
}

export function formatCodeGraphRepairProgressLine(progress: CodeGraphRepairProgressLine, dryRun = false): string {
  const prefix = dryRun ? 'Would repair' : 'Repairing';
  const database = `${progress.current}/${progress.total} databases`;
  switch (progress.phase) {
    case 'checking':
      return `${prefix} · checking ${database}`;
    case 'migrating-schema':
      return `${prefix} · migrating schema · ${database}`;
    case 'cleaning-snapshots':
      return `${prefix} · cleaning snapshots · ${database}`;
    case 'cleaning-vectors':
      return `${prefix} · cleaning temporary files · ${database}`;
    case 'discarding':
      return `${prefix} · discarding store · ${database}`;
    case 'deferred':
      return `${prefix} · deferred ${database}`;
  }
}

export type CodeGraphCliPurgePhase =
  'acquiring-gates' | 'deleting' | 'quarantining' | 'removing-obsolete' | 'verifying' | 'waiting-builders';

export interface CodeGraphCliPurgeProgress {
  readonly checkoutCurrent?: number;
  readonly checkoutTotal?: number;
  readonly dryRun?: boolean;
  readonly filesRemoved?: number;
  readonly filesTotal?: number;
  readonly phase: CodeGraphCliPurgePhase;
}

export function formatCodeGraphPurgeProgressLine(progress: CodeGraphCliPurgeProgress): string {
  const prefix = progress.dryRun === true ? 'Would purge' : 'Purging';
  const checkout =
    progress.checkoutCurrent !== undefined && progress.checkoutTotal !== undefined
      ? ` · ${progress.checkoutCurrent}/${progress.checkoutTotal} checkouts`
      : '';
  const files =
    progress.filesRemoved !== undefined && progress.filesTotal !== undefined
      ? ` · ${countProgress(progress.filesRemoved, progress.filesTotal)} files`
      : progress.filesRemoved !== undefined
        ? ` · ${progress.filesRemoved.toLocaleString()} files`
        : '';
  return `${prefix} · ${purgePhaseLabel(progress.phase)}${checkout}${files}`;
}

export function formatCodeGraphCompactProgressLine(phase: 'inspecting' | 'waiting-builders' | 'compacting'): string {
  switch (phase) {
    case 'inspecting':
      return 'Compacting · inspecting storage';
    case 'waiting-builders':
      return 'Compacting · waiting for builders';
    case 'compacting':
      return 'Compacting · vacuuming database';
  }
}

export const makeCodeGraphHumanProgressReporter = Effect.fn('codeGraph.command.makeHumanProgressReporter')(
  function* () {
    const tracker = yield* Ref.make(makeCodeGraphEtaTracker());
    const gate = yield* Semaphore.make(1);
    return (progress: CodeGraphProgress) =>
      gate.withPermit(
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          const observed = observeCodeGraphEta(yield* Ref.get(tracker), codeGraphEtaMeasurement(progress), now);
          yield* Ref.set(tracker, observed.tracker);
          return formatCodeGraphIndexProgressLine(
            progress,
            Option.getOrUndefined(observed.estimate)?.remainingMilliseconds,
          );
        }),
      );
  },
);

export function countProgress(completed: number, total: number): string {
  const safeTotal = Number.isFinite(total) && total > 0 ? total : 0;
  const safeCompleted = Number.isFinite(completed) ? Math.max(0, completed) : 0;
  const percent = safeTotal === 0 ? 100 : Math.min(100, Math.round((safeCompleted / safeTotal) * 100));
  return `${safeCompleted.toLocaleString()}/${safeTotal.toLocaleString()} (${percent}%)`;
}

function formatEtaSuffix(remainingMilliseconds: number | undefined): string {
  if (remainingMilliseconds === undefined || !Number.isFinite(remainingMilliseconds) || remainingMilliseconds < 0) {
    return '';
  }
  return ` · ETA ${formatCodeGraphStatusDuration(remainingMilliseconds)}`;
}

function waitingProgressLabel(reason: Extract<CodeGraphProgress, {readonly phase: 'waiting'}>['reason']): string {
  switch (reason) {
    case 'database-writer':
      return 'Waiting for database writer';
    case 'home-builder-cap':
      return 'Waiting for graph builder slot';
    case 'prepared-spool-budget':
      return 'Waiting for prepared graph publication capacity';
    case 'request-lock':
      return 'Waiting for matching request';
    case 'snapshot-build':
      return 'Waiting for snapshot build';
    default:
      return 'Waiting for another build';
  }
}

function waitingQueueLabel(progress: Extract<CodeGraphProgress, {readonly phase: 'waiting'}>): string {
  return progress.reason === 'home-builder-cap' && progress.admission !== undefined
    ? ` · queue ${progress.admission.position.toLocaleString()}/${progress.admission.size.toLocaleString()}`
    : '';
}

function purgePhaseLabel(phase: CodeGraphCliPurgePhase): string {
  switch (phase) {
    case 'acquiring-gates':
      return 'acquiring locks';
    case 'waiting-builders':
      return 'waiting for builders';
    case 'verifying':
      return 'verifying checkout';
    case 'quarantining':
      return 'quarantining files';
    case 'deleting':
      return 'deleting files';
    case 'removing-obsolete':
      return 'removing obsolete stores';
  }
}
