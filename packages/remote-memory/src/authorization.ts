import {normalizeRemoteCitationSources} from '@threadnote/memory/remote/citation_sources';
import {Schema} from 'effect';
import {
  formatRemoteMemoryUri,
  InvalidRemoteMemoryAddress,
  parseRemoteShareAddress,
} from '@threadnote/memory/remote/address';
import type {RemoteRememberInputV1} from '@threadnote/memory/remote/contracts';
import {InvalidRemoteMemoryRelations, normalizeRemoteMemoryRelations} from '@threadnote/memory/remote/relations';
import {parseResourceId} from '@threadnote/store/resource-id';
import type {OAuthPrincipalClaims} from './oauth.js';
import {remoteMemoryError} from './errors.js';
import type {RemoteMemoryRequestExecution} from './request_execution.js';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

export const REMOTE_MEMORY_SCOPES = [
  'memory:admin',
  'memory:propose:durable',
  'memory:read',
  'memory:review:durable',
  'memory:write:durable',
  'memory:write:handoff',
] as const;

export type RemoteMemoryScope = (typeof REMOTE_MEMORY_SCOPES)[number];

export const REMOTE_MEMORY_FEATURE_FLAGS = [
  'remote_memory_read',
  'remote_memory_durable_write',
  'remote_memory_handoff_write',
  'cursor_oidc_required',
  'git_beta_import',
  'remote_memory_ga',
] as const;

export type RemoteMemoryFeatureFlag = (typeof REMOTE_MEMORY_FEATURE_FLAGS)[number];

export interface AuthorizedRemotePrincipal {
  readonly allowedProjects: ReadonlySet<string> | 'all';
  readonly attestationRequiredForWrites: boolean;
  readonly capabilities: ReadonlySet<RemoteMemoryScope>;
  readonly cloudAdmissionRequired: boolean;
  readonly OAuth: OAuthPrincipalClaims;
  readonly cursorOwnerIds: ReadonlySet<string>;
  readonly cursorSubjects: ReadonlySet<string>;
  readonly cursorTeamId?: string;
  readonly featureFlags: ReadonlySet<RemoteMemoryFeatureFlag>;
  readonly policyVersion: string;
  readonly policyDigest: string;
  readonly principalId: string;
  readonly repositoryBindings: ReadonlySet<string>;
  readonly repositoriesByProject: ReadonlyMap<string, ReadonlySet<string>>;
  readonly shareId: string;
  readonly sharePolicyDigest: string;
  readonly sharePolicyVersion: string;
  readonly tenantId: string;
}

export interface RemoteAuthorizationStore {
  readonly authorize: (
    claims: OAuthPrincipalClaims,
    requestedShareId: string | undefined,
    execution?: RemoteMemoryRequestExecution,
  ) => Promise<AuthorizedRemotePrincipal | undefined>;
}

export async function authorizeRemoteRequest(
  store: RemoteAuthorizationStore,
  claims: OAuthPrincipalClaims,
  requestedShareId: string | undefined,
  execution?: RemoteMemoryRequestExecution,
): Promise<AuthorizedRemotePrincipal> {
  const principal = await store.authorize(claims, requestedShareId, execution);
  if (!principal) throw remoteMemoryError('forbidden', 'The principal is not authorized for this memory share.');
  return principal;
}

export function requireRemoteScope(principal: AuthorizedRemotePrincipal, scope: RemoteMemoryScope): void {
  if (!principal.featureFlags.has('remote_memory_ga')) {
    throw remoteMemoryError('forbidden', 'The memory share has not enabled remote_memory_ga.');
  }
  const tokenAllows = principal.OAuth.scopes.has(scope) || principal.OAuth.scopes.has('memory:admin');
  const grantAllows = principal.capabilities.has(scope) || principal.capabilities.has('memory:admin');
  if (!tokenAllows || !grantAllows) {
    throw remoteMemoryError('forbidden', `The access token does not grant ${scope}.`);
  }
  const feature = featureForScope(scope);
  if (feature && !principal.featureFlags.has(feature)) {
    throw remoteMemoryError('forbidden', `The memory share has not enabled ${feature}.`);
  }
}

export function requireAuthorizedProject(principal: AuthorizedRemotePrincipal, project: string): void {
  if (principal.allowedProjects !== 'all' && !principal.allowedProjects.has(project)) {
    throw remoteMemoryError('forbidden', 'The project is outside the authorized share grant.');
  }
}

export function requestedRemoteShare(request: Request): string | undefined {
  const requestUrl = new URL(request.url);
  const fromHeader = Effect.pipe(request.headers.get('threadnote-share-id'), effectOptionalString =>
    effectOptionalString == null ? undefined : Effect.pipe(effectOptionalString, EffectString.trim),
  );
  const fromQuery = Effect.pipe(requestUrl.searchParams.get('share'), effectOptionalString =>
    effectOptionalString == null ? undefined : Effect.pipe(effectOptionalString, EffectString.trim),
  );
  if (fromHeader && fromQuery && fromHeader !== fromQuery) {
    throw remoteMemoryError('invalid_request', 'The requested share identifiers do not match.');
  }
  const requested = fromHeader || fromQuery;
  if (!requested) return undefined;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(requested)) {
    throw remoteMemoryError('invalid_request', 'The requested share identifier is invalid.');
  }
  return requested;
}

export function assertUriBelongsToAuthorizedShare(principal: AuthorizedRemotePrincipal, uri: string): void {
  const resource = parseResourceId(uri);
  if (resource.namespace !== 'share' || resource.segments[0] !== principal.shareId) {
    throw remoteMemoryError('forbidden', 'The resource is outside the authorized memory share.');
  }
}

export function assertRemoteRememberReplacementTarget(
  principal: AuthorizedRemotePrincipal,
  input: RemoteRememberInputV1,
): void {
  if (input.replaceUri === undefined) return;
  if (input.baseRevision === undefined) {
    throw remoteMemoryError('invalid_request', 'An explicit replacement URI requires a base revision.');
  }
  let address;
  try {
    address = parseRemoteShareAddress(input.replaceUri);
  } catch (cause) {
    if (!Schema.is(InvalidRemoteMemoryAddress)(cause)) throw cause;
    throw remoteMemoryError('invalid_request', 'The replacement memory URI is invalid.');
  }
  if (address.shareId !== principal.shareId) {
    throw remoteMemoryError('forbidden', 'The replacement memory is outside the authorized share.');
  }
  if (address.kind !== input.kind || address.project !== input.project || address.topic !== input.topic) {
    throw remoteMemoryError('invalid_request', 'The replacement URI must identify the requested memory.');
  }
}

export function authorizeRemoteRememberRelations(
  principal: AuthorizedRemotePrincipal,
  input: RemoteRememberInputV1,
): RemoteRememberInputV1 {
  input = authorizeRemoteCitationSources(principal, input);
  let relations;
  try {
    relations = normalizeRemoteMemoryRelations(input.relations);
  } catch (cause) {
    if (!Schema.is(InvalidRemoteMemoryRelations)(cause)) throw cause;
    throw remoteMemoryError('invalid_request', cause.message);
  }
  if (relations === undefined) return input;
  const sourceUri = formatRemoteMemoryUri({
    kind: input.kind,
    project: input.project,
    shareId: principal.shareId,
    topic: input.topic,
  });
  for (const relation of relations) {
    const address = parseRemoteShareAddress(relation.uri);
    if (address.shareId !== principal.shareId) {
      throw remoteMemoryError('forbidden', 'A relation target is outside the authorized memory share.');
    }
    requireAuthorizedProject(principal, address.project);
    if (address.canonicalUri === sourceUri) {
      throw remoteMemoryError('invalid_request', 'A remote memory cannot relate to itself.');
    }
  }
  return {...input, relations};
}

function featureForScope(scope: RemoteMemoryScope): RemoteMemoryFeatureFlag | undefined {
  switch (scope) {
    case 'memory:read':
      return 'remote_memory_read';
    case 'memory:propose:durable':
    case 'memory:review:durable':
    case 'memory:write:durable':
      return 'remote_memory_durable_write';
    case 'memory:write:handoff':
      return 'remote_memory_handoff_write';
    case 'memory:admin':
      return undefined;
  }
}

export function authorizeRemoteCitationSources(
  principal: AuthorizedRemotePrincipal,
  input: RemoteRememberInputV1,
): RemoteRememberInputV1 {
  let citationSources;
  try {
    citationSources = normalizeRemoteCitationSources(input.citationSources);
  } catch {
    throw remoteMemoryError(
      'invalid_request',
      'Citation sources must be bounded canonical URI and citation ID selectors.',
    );
  }
  if (citationSources === undefined) return input;
  for (const source of citationSources) {
    const address = parseRemoteShareAddress(source.uri);
    if (address.shareId !== principal.shareId)
      throw remoteMemoryError('forbidden', 'A citation source is outside the authorized memory share.');
    requireAuthorizedProject(principal, address.project);
  }
  return {...input, citationSources};
}
