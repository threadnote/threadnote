import {Effect} from 'effect';
import {workflowArchiveStem, workflowMemoryStem} from '@threadnote/workflow-automations/naming';
import {uriSegment} from '@threadnote/store/resource-segment';
import {ResourceStore} from '@threadnote/store/resource-store';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {
  validateWorkflowInput,
  workflowError,
  type WorkflowArtifact,
  type WorkflowBinding,
  type WorkflowJournal,
  type WorkflowRequest,
} from './protocol.js';

type ArtifactName = NonNullable<WorkflowArtifact['naming']>;
export const workflowStateTopic = (binding: WorkflowBinding) =>
  binding.naming ? workflowMemoryStem(binding.naming, 'state') : `workflow-${binding.bindingId}-manifest`;

export const workflowArtifactTopic = (binding: WorkflowBinding, key: string, name?: ArtifactName) => {
  if (!binding.naming) return `workflow-${binding.bindingId}-${key}`;
  if (!name)
    throw workflowError('invalid-journal', 'Named workflow artifacts require their immutable name allocation.');
  return workflowMemoryStem(binding.naming, name.role, name.version);
};
export const workflowArchiveTopic = (
  binding: WorkflowBinding,
  artifact: Pick<WorkflowArtifact, 'naming'>,
  operationId: string,
) => {
  if (!binding.naming) return `workflow-${binding.bindingId}-archive-${operationId}`;
  const name = artifact.naming;
  if (!name?.archiveOrdinal) throw workflowError('invalid-journal', 'Named archives require an immutable ordinal.');
  return workflowArchiveStem(binding.naming, name.role, name.version, name.archiveOrdinal);
};
export function workflowArtifactUri(
  binding: WorkflowBinding,
  artifact: Pick<WorkflowArtifact, 'storageKind' | 'artifactKey' | 'naming'>,
): string {
  const root = `threadnote://user/${uriSegment(binding.user)}/memories`;
  return `${root}/${artifact.storageKind === 'durable' ? 'durable/projects' : 'handoffs/active'}/${uriSegment(binding.project)}/${uriSegment(workflowArtifactTopic(binding, artifact.artifactKey, artifact.naming))}.md`;
}
export function workflowArchiveUri(
  binding: WorkflowBinding,
  artifact: Pick<WorkflowArtifact, 'storageKind' | 'naming'>,
  operationId: string,
): string {
  const root = `threadnote://user/${uriSegment(binding.user)}/memories`;
  const topic = workflowArchiveTopic(binding, artifact, operationId);
  // Legacy archive intent preserves operation ID case and its empty-prefix delimiter.
  return `${root}/${artifact.storageKind === 'durable' ? 'durable' : 'handoffs'}/archived/${uriSegment(binding.project)}/${binding.naming ? uriSegment(topic) : topic}.md`;
}

export const workflowRoleName = (role: string) =>
  ({current: 'arch-current', target: 'arch-target', architecture: 'arch', decision: 'decisions'})[role] ?? role;

/** The binding lock serializes child ordinals. Prepared and historical names are never reused. */
export const allocateWorkflowArtifactName = Effect.fn('workflowMemory.allocateArtifactName')(function* (
  config: RuntimeConfig,
  state: WorkflowJournal,
  request: WorkflowRequest,
  original?: WorkflowArtifact,
) {
  if (!state.binding.naming) {
    if (request.nameHint !== undefined)
      return yield* workflowError('invalid-request', 'Name hints require a fresh named native run.');
    return undefined;
  }
  const role = request.nameHint ?? original?.naming?.role ?? workflowRoleName(request.role!);
  yield* validateWorkflowInput(() => workflowMemoryStem(state.binding.naming!, role));
  if (original && original.naming?.role !== role)
    return yield* workflowError(
      'name-intent-conflict',
      'Replacing or archiving an artifact must preserve its name role.',
    );
  if (original && request.action !== 'archive' && request.mutation !== 'archive') return original.naming;
  const prior = Object.values(state.operations).map(operation => operation.artifact);
  for (let ordinal = 1; ordinal <= 1_000_000; ordinal++) {
    const naming: ArtifactName = original
      ? {role, version: original.naming!.version, archiveOrdinal: ordinal}
      : {role, version: ordinal};
    const storageKind: WorkflowArtifact['storageKind'] =
      original?.storageKind ?? (state.binding.profile === 'desktop' ? (request.storageKind ?? 'handoff') : 'handoff');
    const artifact = {
      ...original,
      artifactKey: request.artifactKey!,
      naming,
      storageKind,
    };
    const uri = original
      ? workflowArchiveUri(state.binding, artifact, request.operationId!)
      : workflowArtifactUri(state.binding, artifact);
    if (prior.some(item => item.canonicalUri === uri) || state.manifestUri === uri) continue;
    const existing = yield* (yield* ResourceStore)
      .read({account: config.account, home: config.agentContextHome, user: config.user}, uri)
      .pipe(Effect.catchTag('ResourceNotFound', () => Effect.void));
    if (existing === undefined) return naming;
  }
  return yield* workflowError(
    'name-capacity',
    'No unused bounded artifact ordinal remains; prior names were preserved.',
  );
});
