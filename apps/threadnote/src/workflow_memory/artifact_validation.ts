import {workflowError, type WorkflowBinding, type WorkflowRequest} from './protocol.js';
import {Schema} from 'effect';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

const isUnknownRecord = Schema.is(Schema.Record(Schema.String, Schema.Unknown));

/** Recognized workflow records cannot contradict the native ownership envelope. */
export function assertWorkflowArtifactIdentity(binding: WorkflowBinding, request: WorkflowRequest): void {
  const body = request.body ?? '';
  // oxlint-disable-next-line effecttsgo/prefer-effect-string -- Native matchAll preserves the standard RegExpMatchArray index type.
  const markers = [...body.matchAll(/<!-- dev-(spec|plan):([^ ]+) /gu)];
  if (markers.length === 0) return;
  if (markers.length !== 1 || markers[0][2] !== 'v1')
    throw workflowError('artifact-identity-conflict', 'Use one supported workflow artifact sentinel.');
  const marker = markers[0];
  const start = marker.index + marker[0].length;
  // oxlint-disable-next-line effecttsgo/prefer-effect-string -- The native search position argument changes the search origin; Effect String has no position parameter.
  const end = body.indexOf(' -->', start);
  if (end < 0 || Effect.pipe(body, EffectString.slice(end + 4), EffectString.trim))
    throw workflowError('artifact-identity-conflict', 'The workflow artifact sentinel must be complete and final.');
  let parsed: unknown;
  try {
    parsed = JSON.parse(Effect.pipe(body, EffectString.slice(start, end)));
  } catch {
    throw workflowError('artifact-identity-conflict', 'The workflow artifact sentinel is not valid JSON.');
  }
  if (!isUnknownRecord(parsed))
    throw workflowError('artifact-identity-conflict', 'The workflow artifact sentinel must contain an object.');
  const record = parsed;
  const data = isUnknownRecord(record.data) ? record.data : undefined;
  if (
    record?.schemaVersion !== 1 ||
    record[marker[1] === 'spec' ? 'featureId' : 'planId'] !== binding.featureId ||
    record.project !== binding.project ||
    record.kind !== request.role ||
    (record.runId ?? data?.runId) !== request.sourceRunId
  )
    throw workflowError(
      'artifact-identity-conflict',
      'Artifact feature, project, role or writer differs from its bound workflow.',
    );
}
