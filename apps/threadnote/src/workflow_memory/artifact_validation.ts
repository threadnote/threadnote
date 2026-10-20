import {workflowError, type WorkflowBinding, type WorkflowRequest} from './protocol.js';

/** Recognized workflow records cannot contradict the native ownership envelope. */
export function assertWorkflowArtifactIdentity(binding: WorkflowBinding, request: WorkflowRequest): void {
  const body = request.body ?? '';
  const markers = [...body.matchAll(/<!-- dev-(spec|plan):([^ ]+) /gu)];
  if (markers.length === 0) return;
  if (markers.length !== 1 || markers[0][2] !== 'v1')
    throw workflowError('artifact-identity-conflict', 'Use one supported workflow artifact sentinel.');
  const marker = markers[0];
  const start = marker.index + marker[0].length;
  const end = body.indexOf(' -->', start);
  if (end < 0 || body.slice(end + 4).trim())
    throw workflowError('artifact-identity-conflict', 'The workflow artifact sentinel must be complete and final.');
  let record: Record<string, unknown>;
  try {
    record = JSON.parse(body.slice(start, end));
  } catch {
    throw workflowError('artifact-identity-conflict', 'The workflow artifact sentinel is not valid JSON.');
  }
  const data = record?.data as Record<string, unknown> | undefined;
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
