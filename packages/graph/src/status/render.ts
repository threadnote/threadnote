import {Array as EffectArray} from 'effect';
import {Console, Effect} from 'effect';
import type {ObservedCodeGraphBuildStatus} from '../build_status.js';

export function renderCodeGraphReadySnapshotStatus(status: {
  readonly readySnapshot?: {
    readonly edgeCount: number;
    readonly fileCount: number;
    readonly id: string;
    readonly symbolCount: number;
  };
  readonly stale: boolean;
}): Effect.Effect<void> {
  return status.readySnapshot
    ? Console.log(
        `Current-worktree ready snapshot: ${status.readySnapshot.id} · ${status.readySnapshot.fileCount} files · ` +
          `${status.readySnapshot.symbolCount} symbols · ${status.readySnapshot.edgeCount} edges · ` +
          `${status.stale ? 'stale' : 'current'}`,
      )
    : Console.log('Current-worktree ready snapshot: none');
}

export function renderCodeGraphBuildCounters(status: ObservedCodeGraphBuildStatus): string | undefined {
  const counters = status.counters;
  const measured =
    counters.completed === undefined || counters.total === undefined
      ? undefined
      : `${counters.completed}/${counters.total} ${counters.unit ?? 'items'}`;
  const details = EffectArray.filter(
    [
      counters.accepted === undefined ? undefined : `${counters.accepted} accepted`,
      counters.reused === undefined ? undefined : `${counters.reused} reused`,
      counters.resolved === undefined ? undefined : `${counters.resolved} references linked`,
      counters.skipped === undefined ? undefined : `${counters.skipped} skipped`,
      counters.excluded === undefined ? undefined : `${counters.excluded} excluded`,
      counters.pagesCompleted === undefined ? undefined : `${counters.pagesCompleted} cleanup pages`,
      counters.rowsDeleted === undefined ? undefined : `${counters.rowsDeleted} rows reclaimed`,
      counters.symbols === undefined ? undefined : `${counters.symbols} symbols`,
      counters.edges === undefined ? undefined : `${counters.edges} edges`,
    ],
    (value): value is string => value !== undefined,
  );
  return (
    EffectArray.join(
      EffectArray.filter([measured, ...details], (value): value is string => value !== undefined),
      ' · ',
    ) || undefined
  );
}

export function formatCodeGraphStatusDuration(milliseconds: number): string {
  if (!Number.isFinite(milliseconds)) return 'unknown';
  const seconds = Math.max(0, Math.ceil(milliseconds / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.ceil(minutes / 60)}h`;
}

export function codeGraphEtaBasisLabel(
  basis: 'cached-fact-bytes' | 'extraction-work' | 'files' | 'final-fact-bytes' | 'source-bytes',
): string {
  switch (basis) {
    case 'cached-fact-bytes':
      return 'cached-fact bytes';
    case 'final-fact-bytes':
      return 'final attributed fact bytes';
    case 'source-bytes':
      return 'source bytes';
    case 'extraction-work':
      return 'class-weighted extraction work';
    case 'files':
      return 'files';
  }
}
