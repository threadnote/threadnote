import {Array as EffectArray} from 'effect';
import {Effect, Schema} from 'effect';
import {parseMemoryDocument} from '@threadnote/memory/document';
import {isMemoryId, memoryIdentityAlias} from '@threadnote/memory/identity-alias';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {resolveMemoryIdentityAliases, verifyResolvedMemoryIdentity} from '@threadnote/recall/memory/identity';
import {parseResourceId, resourceIdIsWithin} from '@threadnote/store/resource-id';
import {uriSegment} from '@threadnote/store/resource-segment';
import {ResourceStore} from '@threadnote/store/resource-store';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {
  workflowError,
  WorkflowMemoryError,
  validateWorkflowInput,
  type WorkflowBinding,
  type WorkflowEvidenceReference,
} from './protocol.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

/** Per-intent exact read scopes; this never changes the run's binding or owned artifacts. */
export function workflowEvidenceScopes(
  binding: WorkflowBinding,
  refs: readonly WorkflowEvidenceReference[] = [],
): readonly string[] {
  if (refs.length > 16)
    throw workflowError('invalid-request', 'A workflow can admit at most sixteen evidence references.');
  if (refs.length && binding.profile !== 'desktop')
    throw workflowError('out-of-scope', 'Private cross-run evidence is available only to desktop workflows.');
  const root = 'threadnote://user/' + uriSegment(binding.user) + '/memories/';
  const roots = [
    root + 'handoffs/active/' + uriSegment(binding.project),
    root + 'durable/projects/' + uriSegment(binding.project),
  ];
  const uris = new Set<string>();
  const identities = new Set<string>();
  for (const ref of refs) {
    const resource = parseResourceId(ref.uri);
    if (
      resource.canonicalUri !== ref.uri ||
      resource.anchor !== undefined ||
      !EffectArray.some(
        roots,
        scope =>
          resourceIdIsWithin(ref.uri, scope) && resource.segments.length === parseResourceId(scope).segments.length + 1,
      ) ||
      !Effect2.pipe(resource.segments.at(-1), effectOptionalString =>
        effectOptionalString == null ? undefined : Effect2.pipe(effectOptionalString, EffectString.endsWith('.md')),
      )
    )
      throw workflowError('out-of-scope', 'Evidence must be an exact private memory in this user and project.');
    if (!isMemoryId(ref.memoryId) || !/^[a-f0-9]{64}$/u.test(ref.revision))
      throw workflowError('invalid-request', 'Evidence must pin a native memory identity and revision.');
    if (uris.has(ref.uri) || identities.has(ref.memoryId))
      throw workflowError('invalid-request', 'Evidence references must have distinct URIs and memory identities.');
    uris.add(ref.uri);
    identities.add(ref.memoryId);
  }
  return [...uris];
}

/** Pure proof used for live readback and the native prepared-operation integrity check. */
export function assertWorkflowEvidenceSnapshot(
  binding: WorkflowBinding,
  ref: WorkflowEvidenceReference,
  uri: string,
  content: string,
): void {
  workflowEvidenceScopes(binding, [ref]);
  const record = parseMemoryDocument(uri, content);
  const expectedKind = resourceIdIsWithin(
    uri,
    'threadnote://user/' + uriSegment(binding.user) + '/memories/handoffs/active',
  )
    ? 'handoff'
    : 'durable';
  if (
    uri !== ref.uri ||
    !record ||
    record.metadata.memoryId !== ref.memoryId ||
    record.metadata.project !== binding.project ||
    record.metadata.kind !== expectedKind ||
    (record.metadata.status ?? 'active') !== 'active' ||
    sha256HexSync(content) !== ref.revision
  )
    throw workflowError(
      'evidence-conflict',
      'Evidence changed identity, revision, location or active project scope. Refresh its exact reference before retrying.',
    );
}

/** Re-read exact native bytes; identity aliases cannot relocate or broaden these admissions. */
export const verifyWorkflowEvidence = Effect.fn('workflowMemory.verifyEvidence')(function* (
  config: RuntimeConfig,
  binding: WorkflowBinding,
  refs: readonly WorkflowEvidenceReference[] = [],
) {
  const scopes = yield* validateWorkflowInput(() => workflowEvidenceScopes(binding, refs));
  if (refs.length === 0) return scopes;
  return yield* Effect.gen(function* () {
    const store = yield* ResourceStore;
    const resolved = yield* resolveMemoryIdentityAliases(
      config,
      EffectArray.map(refs, ref => memoryIdentityAlias(ref.memoryId)),
      scopes,
      {validateNow: true},
    );
    for (const [index, ref] of refs.entries()) {
      const candidate = resolved[index];
      if (candidate.canonicalUri !== ref.uri)
        return yield* workflowError('evidence-conflict', 'Evidence identity moved outside its exact admitted URI.');
      const content = yield* store.read(
        {account: config.account, home: config.agentContextHome, user: config.user},
        ref.uri,
      );
      yield* verifyResolvedMemoryIdentity(candidate, ref.uri, content);
      yield* validateWorkflowInput(() => assertWorkflowEvidenceSnapshot(binding, ref, ref.uri, content));
    }
    return scopes;
  }).pipe(
    Effect.mapError(error =>
      Schema.is(WorkflowMemoryError)(error)
        ? error
        : workflowError(
            'evidence-conflict',
            'Evidence is absent, retired or no longer resolves to its admitted identity.',
          ),
    ),
  );
});

/** Exact-byte admission inside an already-owned canonical write fence. Never refresh recall here. */
export const verifyWorkflowEvidenceBytes = Effect.fn('workflowMemory.verifyEvidenceBytes')(function* (
  config: RuntimeConfig,
  binding: WorkflowBinding,
  refs: readonly WorkflowEvidenceReference[] = [],
) {
  yield* validateWorkflowInput(() => workflowEvidenceScopes(binding, refs));
  const store = yield* ResourceStore;
  for (const ref of refs) {
    const content = yield* store.read(
      {account: config.account, home: config.agentContextHome, user: config.user},
      ref.uri,
    );
    yield* validateWorkflowInput(() => assertWorkflowEvidenceSnapshot(binding, ref, ref.uri, content));
  }
});
