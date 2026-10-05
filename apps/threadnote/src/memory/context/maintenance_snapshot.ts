import {Data, Effect, PlatformError} from 'effect';
import type {ContextMaintenanceSnapshotDiagnosticV1} from '@threadnote/context/health_maintenance';

type Category = ContextMaintenanceSnapshotDiagnosticV1['category'];
type Stage = ContextMaintenanceSnapshotDiagnosticV1['stage'];
const instructions: Readonly<Record<Category, readonly [string, string]>> = {
  'invalid-header': [
    'Private memory header is not a valid Threadnote document.',
    'Preserve a backup of the affected file, then restore a valid Threadnote memory header from a known-good copy. Do not delete the record to unblock maintenance. Run maintenance again after correcting it.',
  ],
  'invalid-utf8': [
    'The affected memory cannot be decoded as UTF-8.',
    'Preserve a backup of the affected file, then restore or save a known-good UTF-8 copy without changing its meaning. Run maintenance again after correcting it.',
  ],
  'permission-denied': [
    'Threadnote was denied access while preparing the memory inventory.',
    'Grant your user read access to the affected memory and access to its parent directories. For the inventory-cache stage, also check write access to the Threadnote home. Run maintenance again after correcting access.',
  ],
  'record-size-limit': [
    'The affected memory exceeds the 8 MiB safe read limit.',
    'Preserve a backup and review the oversized memory using an editor before choosing a supported reduction. Maintenance will not skip it as absent or raise the safety limit.',
  ],
  'cache-size-limit': [
    'The maintenance inventory exceeds its 32 MiB cache limit.',
    'Preserve the inventory and canonical records. Report this bounded diagnostic with file counts and sizes for investigation; do not delete memories or raise the safety limit.',
  ],
  'authority-boundary': [
    'A memory path resolves outside the authorized Threadnote memory root.',
    'Inspect the affected path and its parent links locally. Restore the intended in-root location from a known-good copy before running maintenance again; do not follow or delete the external target.',
  ],
  'record-not-regular': [
    'The inventory encountered an unexpected file or directory type.',
    'Inspect the affected path locally and restore the expected regular Markdown file or directory from a known-good copy. Preserve its data and do not replace it blindly.',
  ],
  'record-changed': [
    'A memory changed or became temporarily unavailable during its bounded read.',
    'Let the local writer finish, then run maintenance again. One automatic retry is bounded; if the problem persists, inspect the affected path. The record remains unknown-present, so its incoming relations are preserved.',
  ],
  'io-error': [
    'The memory inventory could not complete a local filesystem operation.',
    'Check local storage availability and access at the reported stage, then run maintenance again. If it persists, report this bounded diagnostic without memory contents; preserve all canonical records.',
  ],
};

class MaintenanceSnapshotError extends Data.TaggedError('MaintenanceSnapshotError')<{
  readonly diagnostic: ContextMaintenanceSnapshotDiagnosticV1;
}> {}

export function maintenanceSnapshotFailure(category: Category, stage: Stage, memoryUri?: string) {
  const [summary, recovery] = instructions[category];
  return new MaintenanceSnapshotError({
    diagnostic: {
      version: 1,
      category,
      stage,
      ...(memoryUri !== undefined &&
      memoryUri.length <= 2_048 &&
      ![...memoryUri].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
        ? {memoryUri}
        : {}),
      summary,
      recovery,
      retryable: category === 'record-changed',
    },
  });
}

export function maintenanceSnapshotError(error: unknown, stage: Stage, memoryUri?: string) {
  if (error instanceof MaintenanceSnapshotError) return error;
  const reason = PlatformError.isPlatformError(error) ? error.reason._tag : undefined;
  const category =
    reason === 'PermissionDenied'
      ? 'permission-denied'
      : stage !== 'inventory-cache' &&
          (reason === 'NotFound' || reason === 'Busy' || reason === 'WouldBlock' || reason === 'UnexpectedEof')
        ? 'record-changed'
        : 'io-error';
  return maintenanceSnapshotFailure(category, stage, memoryUri);
}

export function withMaintenanceSnapshotDiagnostic(stage: Stage, memoryUri?: string) {
  return <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(Effect.mapError(error => maintenanceSnapshotError(error, stage, memoryUri)));
}
