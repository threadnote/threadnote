import type {ISql} from 'postgres';
import {parseRemoteShareAddress} from '@threadnote/memory/remote/address';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {formatMemoryDocument, parseMemoryDocument} from '@threadnote/memory/document';
import {inspectRemoteMemoryContent} from '@threadnote/memory/remote/content';
import {REMOTE_MEMORY_RECEIPT_VERSION, type RemoteMemoryReceiptV1} from '@threadnote/memory/remote/receipts';
import type {AuthorizedRemotePrincipal} from '../authorization.js';
import type {CursorWorkloadAttestation} from '../cursor_oidc.js';
import {remoteMemoryError} from '../errors.js';
import type {RemoteMemoryRequestExecution} from '../request_execution.js';
import type {ShareStateRow} from '../repository_policy.js';

export function mutationAuthorityValidThrough(
  execution: RemoteMemoryRequestExecution | undefined,
  refUpdateTimeoutMilliseconds = 0,
  nowEpochMilliseconds = Date.now(),
): number {
  const requestDeadline = execution?.deadlineEpochMilliseconds ?? nowEpochMilliseconds;
  const refUpdateDeadline = nowEpochMilliseconds + refUpdateTimeoutMilliseconds;
  return Math.max(requestDeadline, refUpdateDeadline);
}

export function numeric(value: string | number): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed) && !Number.isFinite(parsed))
    throw remoteMemoryError('service_unavailable', 'A remote memory generation was invalid.');
  return parsed;
}

export function receipt(
  principal: AuthorizedRemotePrincipal,
  state: ShareStateRow,
  requestId: string,
  extra: Partial<Pick<RemoteMemoryReceiptV1, 'actor' | 'revision' | 'uri'>> & {
    readonly overlayUsed?: boolean;
  } = {},
): RemoteMemoryReceiptV1 {
  const shareGeneration = numeric(state.share_generation);
  const indexedGeneration = numeric(state.indexed_generation);
  const {overlayUsed, ...receiptFields} = extra;
  return {
    ...receiptFields,
    consistency:
      indexedGeneration === shareGeneration
        ? 'current'
        : extra.revision || overlayUsed
          ? 'recent-write-overlay'
          : 'stale-index',
    indexedGeneration,
    policyVersion: principal.policyVersion,
    sharePolicyVersion: state.policy_version,
    requestId,
    shareGeneration,
    shareId: principal.shareId,
    tenantId: principal.tenantId,
    version: REMOTE_MEMORY_RECEIPT_VERSION,
  };
}

export function lifecycleRequestFingerprint(
  principal: AuthorizedRemotePrincipal,
  input: {
    readonly baseRevision: string;
    readonly operation: string;
    readonly operationId: string;
    readonly uri: string;
  },
): string {
  return sha256HexSync(
    JSON.stringify({
      baseRevision: input.baseRevision,
      operation: input.operation,
      operationId: input.operationId,
      shareId: principal.shareId,
      uri: input.uri,
      version: 1,
    }),
  );
}

export function makeLifecycleDocument(
  current: Readonly<{
    canonical_uri: string;
    markdown_body: string;
  }>,
  status: 'active' | 'archived' | 'expired' | 'superseded',
  now: Date,
  priorBody = current.markdown_body,
): {readonly content: string; readonly contentHash: string} {
  const prior = parseMemoryDocument(current.canonical_uri, priorBody);
  if (!prior || prior.headerTitle !== 'HANDOFF') {
    throw remoteMemoryError('service_unavailable', 'The stored remote handoff document is invalid.');
  }
  const content = formatMemoryDocument(
    'HANDOFF',
    {...prior.metadata, status, updatedAt: now.toISOString()},
    prior.body,
  );
  const inspected = inspectRemoteMemoryContent(content);
  if (!inspected.allowed) {
    throw remoteMemoryError('service_unavailable', 'The stored remote handoff no longer passes content policy.');
  }
  return {content: inspected.canonicalContent, contentHash: sha256HexSync(inspected.canonicalContent)};
}

export function mutationActor(
  principal: AuthorizedRemotePrincipal,
  attestation: CursorWorkloadAttestation | undefined,
): RemoteMemoryReceiptV1['actor'] {
  return attestation
    ? {
        cloudAgentId: attestation.cloudAgentId,
        principalId: principal.principalId,
        provider: 'cursor',
        ...(attestation.turnId ? {turnId: attestation.turnId} : {}),
      }
    : {principalId: principal.principalId};
}

export async function resolveCanonicalUri(
  transaction: ISql,
  principal: AuthorizedRemotePrincipal,
  inputUri: string,
): Promise<string> {
  try {
    const address = parseRemoteShareAddress(inputUri);
    if (address.shareId !== principal.shareId)
      throw remoteMemoryError('forbidden', 'The URI belongs to another share.');
    return address.canonicalUri;
  } catch (cause) {
    if (cause instanceof Error && cause.name === 'RemoteMemoryError') throw cause;
  }
  const aliases = await transaction<{canonical_uri: string}[]>`
    SELECT canonical_uri FROM remote_memory.uri_aliases
    WHERE tenant_id = ${principal.tenantId} AND share_id = ${principal.shareId} AND alias_uri = ${inputUri}
      AND (expires_at IS NULL OR expires_at > now())
  `;
  const canonicalUri = aliases[0]?.canonical_uri;
  if (!canonicalUri || parseRemoteShareAddress(canonicalUri).shareId !== principal.shareId) {
    throw remoteMemoryError('not_found', 'The remote memory was not found.');
  }
  return canonicalUri;
}
