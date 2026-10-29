import type {ISql} from 'postgres';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {remoteMemoryError} from '../errors.js';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

export function remoteGitIngestPrincipalId(tenantId: string, shareId: string): string {
  return `system:git-ingest:${Effect.pipe(sha256HexSync(JSON.stringify([tenantId, shareId])), EffectString.slice(0, 32))}`;
}

export async function provisionGitIngestPrincipal(
  transaction: ISql,
  input: {readonly tenantId: string; readonly shareId: string},
): Promise<void> {
  const principalId = remoteGitIngestPrincipalId(input.tenantId, input.shareId);
  const capabilities = ['memory:read', 'memory:write:durable', 'memory:write:handoff'];
  const document = {capabilities, internal: 'git-ingest'};
  const digest = sha256HexSync(JSON.stringify(document));
  await transaction`
    INSERT INTO remote_memory.principals(tenant_id, id, status)
    VALUES (${input.tenantId}, ${principalId}, 'active') ON CONFLICT (tenant_id, id) DO NOTHING
  `;
  await transaction`
    INSERT INTO remote_memory.tenant_memberships(tenant_id, principal_id, status)
    VALUES (${input.tenantId}, ${principalId}, 'active') ON CONFLICT (tenant_id, principal_id) DO NOTHING
  `;
  await transaction`
    INSERT INTO remote_memory.grant_policy_versions(
      tenant_id, share_id, version, principal_id, policy_document, policy_digest
    ) VALUES (
      ${input.tenantId}, ${input.shareId}, 'git-ingest-v1', ${principalId},
      ${transaction.json(document)}, ${digest}
    ) ON CONFLICT (tenant_id, share_id, version, principal_id) DO NOTHING
  `;
  const policies = await transaction<{policy_digest: string}[]>`
    SELECT policy_digest FROM remote_memory.grant_policy_versions
    WHERE tenant_id = ${input.tenantId} AND share_id = ${input.shareId}
      AND version = 'git-ingest-v1' AND principal_id = ${principalId}
  `;
  if (policies[0]?.policy_digest !== digest) {
    throw remoteMemoryError('conflict', 'The internal Git ingest policy version has conflicting content.');
  }
  await transaction`
    INSERT INTO remote_memory.share_grants(
      tenant_id, share_id, principal_id, status, capabilities, allowed_projects,
      cursor_owner_ids, cursor_subjects, cursor_attestation_required, policy_version, policy_digest
    ) VALUES (
      ${input.tenantId}, ${input.shareId}, ${principalId}, 'active', ${transaction.array(capabilities)}, NULL,
      ${transaction.array([])}, ${transaction.array([])}, false, 'git-ingest-v1', ${digest}
    ) ON CONFLICT (tenant_id, share_id, principal_id) DO NOTHING
  `;
}
