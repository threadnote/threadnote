import {Array as EffectArray} from 'effect';
import type {ISql} from 'postgres';
import type {AuthorizedRemotePrincipal, RemoteMemoryFeatureFlag, RemoteMemoryScope} from './authorization.js';
import {authorizeCursorClaims, type CursorWorkloadAttestation} from './cursor_oidc.js';
import {remoteMemoryError} from './errors.js';

export interface ShareStateRow {
  readonly indexed_generation: string | number;
  readonly policy_digest: string;
  readonly policy_version: string;
  readonly share_generation: string | number;
}

export interface GrantStateRow extends ShareStateRow {
  readonly allowed_projects: string[] | null;
  readonly capabilities: string[];
  readonly cloud_admission_required: boolean;
  readonly cursor_attestation_required: boolean;
  readonly feature_flags: string[];
  readonly grant_policy_version: string;
  readonly grant_policy_digest: string;
  readonly grant_expires_at: Date | null;
}

export async function requireShareState(
  transaction: ISql,
  principal: AuthorizedRemotePrincipal,
): Promise<GrantStateRow> {
  const rows = await transaction<GrantStateRow[]>`
    SELECT s.share_generation, s.indexed_generation, s.policy_version, s.policy_digest,
      s.feature_flags, g.capabilities, g.allowed_projects, g.cloud_admission_required, g.cursor_attestation_required,
      g.expires_at AS grant_expires_at,
      g.policy_version AS grant_policy_version,
      g.policy_digest AS grant_policy_digest
    FROM remote_memory.shares s
    JOIN remote_memory.tenants t ON t.id = s.tenant_id AND t.status = 'active'
    JOIN remote_memory.tenant_memberships m
      ON m.tenant_id = s.tenant_id AND m.principal_id = ${principal.principalId} AND m.status = 'active'
    JOIN remote_memory.share_grants g
      ON g.tenant_id = s.tenant_id AND g.share_id = s.id
      AND g.principal_id = m.principal_id AND g.status = 'active'
      AND (g.expires_at IS NULL OR g.expires_at > now())
    JOIN remote_memory.principals p
      ON p.tenant_id = m.tenant_id AND p.id = m.principal_id AND p.status = 'active'
    WHERE s.tenant_id = ${principal.tenantId} AND s.id = ${principal.shareId} AND s.status = 'active'
  `;
  return validateShareState(rows[0], principal);
}

function validateShareState(state: GrantStateRow | undefined, principal: AuthorizedRemotePrincipal): GrantStateRow {
  if (!state) throw remoteMemoryError('forbidden', 'The memory share grant is not active.');
  const allowedProjects = state.allowed_projects === null ? 'all' : new Set(state.allowed_projects);
  if (!sameSetOrAll(principal.allowedProjects, allowedProjects)) {
    throw remoteMemoryError('forbidden', 'The memory share grant changed; authenticate again.');
  }
  if (
    state.grant_policy_version !== principal.policyVersion ||
    state.grant_policy_digest !== principal.policyDigest ||
    state.policy_version !== principal.sharePolicyVersion ||
    state.policy_digest !== principal.sharePolicyDigest ||
    !setContains(state.capabilities, principal.capabilities) ||
    !setContains(state.feature_flags, principal.featureFlags) ||
    state.cloud_admission_required !== principal.cloudAdmissionRequired
  ) {
    throw remoteMemoryError('forbidden', 'The memory share policy changed; authenticate again.');
  }
  return state;
}

function sameSetOrAll(left: ReadonlySet<string> | 'all', right: ReadonlySet<string> | 'all'): boolean {
  if (left === 'all' || right === 'all') return left === right;
  return left.size === right.size && EffectArray.every([...left], value => right.has(value));
}

function setContains(current: readonly string[], authorized: ReadonlySet<string>): boolean {
  const values = new Set(current);
  return EffectArray.every([...authorized], value => values.has(value));
}

export function principalAllowsProject(principal: AuthorizedRemotePrincipal, project: string): boolean {
  return principal.allowedProjects === 'all' || principal.allowedProjects.has(project);
}

export function requirePrincipalProject(principal: AuthorizedRemotePrincipal, project: string): void {
  if (principal.allowedProjects !== 'all' && !principal.allowedProjects.has(project)) {
    throw remoteMemoryError('forbidden', 'The project is outside the authorized share grant.');
  }
}

export function requireFreshAttestationPolicy(
  principal: AuthorizedRemotePrincipal,
  state: GrantStateRow,
  attestation: CursorWorkloadAttestation | undefined,
  project: string,
  validThroughEpochMilliseconds = Date.now(),
): void {
  if (state.grant_expires_at !== null && state.grant_expires_at.getTime() <= validThroughEpochMilliseconds) {
    throw remoteMemoryError('forbidden', 'The memory share grant expires before publication can complete.');
  }
  if (
    (principal.attestationRequiredForWrites ||
      state.cursor_attestation_required ||
      state.feature_flags.includes('cursor_oidc_required')) &&
    !attestation
  ) {
    throw remoteMemoryError('attestation_required', 'A fresh Cursor workload attestation is required.');
  }
  if (attestation) {
    const expiresAt = Date.parse(attestation.expiresAt);
    if (!Number.isFinite(expiresAt) || expiresAt <= validThroughEpochMilliseconds) {
      throw remoteMemoryError('attestation_required', 'The Cursor workload attestation is invalid or expired.');
    }
    authorizeCursorClaims(principal, attestation, project);
  }
}

export async function requireActiveProject(
  transaction: ISql,
  principal: AuthorizedRemotePrincipal,
  project: string,
): Promise<void> {
  const rows = await transaction<{name: string}[]>`
    SELECT name FROM remote_memory.projects
    WHERE tenant_id = ${principal.tenantId} AND share_id = ${principal.shareId}
      AND name = ${project} AND status = 'active'
  `;
  if (!rows[0]) throw remoteMemoryError('forbidden', 'The project is not active in the authorized memory share.');
}

export function principalAllows(
  principal: AuthorizedRemotePrincipal,
  scope: RemoteMemoryScope,
  feature: RemoteMemoryFeatureFlag,
): boolean {
  return (
    (principal.OAuth.scopes.has(scope) || principal.OAuth.scopes.has('memory:admin')) &&
    (principal.capabilities.has(scope) || principal.capabilities.has('memory:admin')) &&
    principal.featureFlags.has(feature) &&
    principal.featureFlags.has('remote_memory_ga')
  );
}
