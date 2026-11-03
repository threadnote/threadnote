import {Array as EffectArray} from 'effect';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';
import type {ProcessCpuObservation} from '@threadnote/platform/system';

export type ManagerProcessRole =
  | 'cli'
  | 'graph-builder'
  | 'graph-embedding-worker'
  | 'graph-compaction-worker'
  | 'graph-diagnostics-worker'
  | 'graph-parser-worker'
  | 'graph-query-worker'
  | 'graph-waiter'
  | 'integration-sync-worker'
  | 'legacy'
  | 'local-model-worker'
  | 'manager'
  | 'mcp'
  | 'mcp-broker';

export interface ManageableManagerProcess {
  readonly activityRole?: Exclude<ManagerProcessRole, 'legacy'>;
  readonly ageMilliseconds: number;
  readonly currentOperation?: string;
  readonly cpu?: ProcessCpuObservation;
  readonly displayContext?: {
    readonly launchDirectory?: string;
    readonly client?: {readonly name: string; readonly version?: string};
    readonly workspace?:
      | {readonly state: 'active' | 'last'; readonly path: string; readonly observedAt: string}
      | {readonly state: 'multiple'; readonly observedAt: string};
    readonly owner?: {readonly processId: number; readonly role: Exclude<ManagerProcessRole, 'legacy'>};
    readonly branch?:
      | {readonly state: 'branch'; readonly name: string}
      | {readonly state: 'detached'; readonly commit: string}
      | {readonly state: 'unavailable'};
  };
  readonly embeddingProgress?: {
    readonly state: 'queued' | 'deferred-cpu' | 'deferred-foreground' | 'preparing' | 'running' | 'blocked' | 'corrupt';
    readonly reason?: string;
    readonly phase?: 'metadata' | 'resolve' | 'hydrate' | 'embed' | 'retire' | 'ready';
    readonly completed?: number;
    readonly total?: number;
    readonly reusedDocuments?: number;
  };
  readonly parentProcessId: number;
  readonly parentRole?: ManagerProcessRole;
  readonly processId: number;
  readonly processRef?: string;
  readonly releaseVersion?: string;
  readonly role: ManagerProcessRole;
  readonly rssBytes?: number;
  readonly startedAt: string;
  readonly terminable: boolean;
  readonly terminationBlockedReason?: 'current-manager' | 'identity-unverified' | 'legacy-process';
}

export function recallEmbeddingProgressLabel(progress: NonNullable<ManageableManagerProcess['embeddingProgress']>) {
  const work =
    progress.phase === 'hydrate'
      ? 'Preparing documents'
      : progress.phase === 'embed'
        ? 'Embedding chunks'
        : progress.phase === 'retire'
          ? 'Cleaning obsolete versions'
          : progress.phase === 'ready'
            ? 'Verifying completion'
            : progress.phase === 'resolve'
              ? 'Resolving documents'
              : progress.phase === 'metadata'
                ? 'Reading document metadata'
                : undefined;
  const count =
    progress.completed !== undefined && progress.total !== undefined && progress.total > 0
      ? ` · ${progress.completed} / ${progress.total}`
      : '';
  const waiting =
    progress.state === 'deferred-cpu'
      ? 'Waiting for spare CPU'
      : progress.state === 'deferred-foreground'
        ? 'Waiting for foreground work'
        : progress.reason === 'fair-turn'
          ? 'Sharing capacity with graph indexing'
          : progress.reason === 'inference-active'
            ? 'Waiting for active inference'
            : progress.reason === 'source-changed'
              ? 'Memory changed; continuing latest version'
              : progress.state === 'blocked' || progress.state === 'corrupt'
                ? 'Needs attention'
                : undefined;
  if (work === undefined) return waiting ?? 'Progress unavailable';
  return `${waiting ? waiting + ' · ' : ''}${work}${count}`;
}

export interface ManagerProcessDiagnostics {
  readonly processes: readonly ManageableManagerProcess[];
  readonly schemaVersion: number;
  readonly truncated: boolean;
}

export function orderManagerProcessesByAttention<T extends ManageableManagerProcess>(
  processes: readonly T[],
): readonly T[] {
  return EffectArray.map(
    EffectArray.map(processes, (process, inputIndex) => ({inputIndex, process})).sort(
      (left, right) =>
        attentionRank(left.process) - attentionRank(right.process) ||
        Effect.pipe(left.process.startedAt, EffectString.localeCompare(right.process.startedAt)) ||
        left.process.processId - right.process.processId ||
        left.inputIndex - right.inputIndex,
    ),
    entry => entry.process,
  );
}

function attentionRank(process: ManageableManagerProcess): number {
  if (process.role === 'legacy') return 2;
  if (managerProcessIsActive(process)) {
    return 0;
  }
  return 1;
}

export function managerProcessIsActive(process: ManageableManagerProcess): boolean {
  return (
    process.role !== 'legacy' &&
    (process.activityRole !== undefined || (process.currentOperation !== undefined && !isBaselineOperation(process)))
  );
}

function isBaselineOperation(process: ManageableManagerProcess): boolean {
  switch (process.role) {
    case 'manager':
      return process.currentOperation === 'manager-ui';
    case 'mcp':
      return process.currentOperation === 'mcp-server';
    case 'mcp-broker':
      return process.currentOperation === 'mcp-broker';
    case 'local-model-worker':
      return process.currentOperation === 'model-stdio';
    case 'graph-parser-worker':
      return process.currentOperation === 'parser-stdio';
    default:
      return false;
  }
}
