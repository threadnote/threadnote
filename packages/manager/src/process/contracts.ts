export type ManagerProcessRole =
  | 'cli'
  | 'graph-builder'
  | 'graph-compaction-worker'
  | 'graph-diagnostics-worker'
  | 'graph-parser-worker'
  | 'graph-query-worker'
  | 'graph-waiter'
  | 'legacy'
  | 'local-model-worker'
  | 'manager'
  | 'mcp'
  | 'mcp-broker';

export interface ManageableManagerProcess {
  readonly activityRole?: Exclude<ManagerProcessRole, 'legacy'>;
  readonly ageMilliseconds: number;
  readonly currentOperation?: string;
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

export interface ManagerProcessDiagnostics {
  readonly processes: readonly ManageableManagerProcess[];
  readonly schemaVersion: number;
  readonly truncated: boolean;
}

export function orderManagerProcessesByAttention<T extends ManageableManagerProcess>(
  processes: readonly T[],
): readonly T[] {
  return processes
    .map((process, inputIndex) => ({inputIndex, process}))
    .sort(
      (left, right) =>
        attentionRank(left.process) - attentionRank(right.process) ||
        left.process.startedAt.localeCompare(right.process.startedAt) ||
        left.process.processId - right.process.processId ||
        left.inputIndex - right.inputIndex,
    )
    .map(entry => entry.process);
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
