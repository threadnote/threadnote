import {Array as EffectArray} from 'effect';
import {attachAnonymousTelemetryDiagnostic, attachAnonymousTelemetryReportedOutcome} from '../telemetry/diagnostic.js';
import {CodeGraphViewRemovalError, type CodeGraphViewRemovalActionResult} from '@threadnote/graph/view_removal';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

export function serializeCodeGraphViewRemovalResult(result: CodeGraphViewRemovalActionResult): string {
  return JSON.stringify(result);
}

export function renderCodeGraphViewRemovalResult(result: CodeGraphViewRemovalActionResult): string {
  const target = `checkout ${Effect.pipe(result.checkoutId, EffectString.slice(0, 12))}, worktree ${Effect.pipe(result.worktreeId, EffectString.slice(0, 12))}, snapshot ${result.snapshotId}`;
  const headline =
    result.state === 'ready'
      ? `Would remove native code graph view for ${target}.`
      : result.state === 'removed'
        ? `Removed native code graph view for ${target}.`
        : result.state === 'already-removed'
          ? `Native code graph view is already removed for ${target}.`
          : result.state === 'stale-target'
            ? `Refusing to remove native code graph view: the selected target is stale.`
            : `Refusing to remove native code graph view: the selected target was not found.`;
  const cleanup =
    result.cleanup.vectors !== null
      ? [
          `Derived cleanup: ${result.cleanup.vectors.pointersRemoved} vector pointer(s) removed across ` +
            `${result.cleanup.vectors.databasesProcessed}/${result.cleanup.vectors.databasesInspected} store(s); ` +
            `provenance ${result.cleanup.provenance?.state ?? 'not-run'}.`,
        ]
      : result.applied && (result.state === 'removed' || result.state === 'already-removed')
        ? [`Derived cleanup: vector retirement queued; provenance ${result.cleanup.provenance?.state ?? 'not-run'}.`]
        : [];
  return EffectArray.join(
    [
      headline,
      ...cleanup,
      ...EffectArray.map(result.warnings, warning => `Warning [${warning.code}]: ${warning.message}`),
    ],
    '\n',
  );
}

export function codeGraphViewRemovalTargetFailure(result: CodeGraphViewRemovalActionResult): Error | undefined {
  if (result.state === 'stale-target') {
    return codeGraphViewRemovalTargetError(
      'The selected code graph view changed; refresh the view inventory and retry.',
    );
  }
  if (result.state === 'not-found') {
    return codeGraphViewRemovalTargetError('The selected code graph view does not exist; refresh the view inventory.');
  }
  return undefined;
}

function codeGraphViewRemovalTargetError(message: string): CodeGraphViewRemovalError {
  return attachAnonymousTelemetryReportedOutcome(
    attachAnonymousTelemetryDiagnostic(CodeGraphViewRemovalError.make({message: message}), {
      errorType: 'CodeGraphViewRemovalError',
    }),
    'unavailable',
  );
}
