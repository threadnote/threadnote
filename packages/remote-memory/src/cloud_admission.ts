import {pipe as EffectArrayPipe} from 'effect';
import {Array as EffectArray} from 'effect';
import {sha256HexSync} from '@threadnote/platform/sha256';
import type {AuthorizedRemotePrincipal, RemoteMemoryScope} from './authorization.js';
import {canonicalCursorRepositoryBinding} from './cursor_oidc.js';
import {remoteMemoryError} from './errors.js';
import type {GitMemoryBinding} from './git/binding.js';

export const ORG_CLOUD_ACCESS_HEADER = 'threadnote-cloud-access';
export const ORG_CLOUD_REPOSITORY_SET_HEADER = 'threadnote-repository-set';
export type OrgCloudAccess = 'read-only' | 'contribute';

export function orgCloudRepositorySetDigest(shareId: string, repositories: readonly string[]): string {
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(shareId) ||
    repositories.length > 4_096 ||
    EffectArray.some(repositories, repository => repository.length > 2_048)
  ) {
    throw remoteMemoryError('invalid_request', 'Organization Cloud requires one share and 1–256 repository bindings.');
  }
  const canonical = [...new Set(EffectArray.map(repositories, canonicalCursorRepositoryBinding))].sort();
  if (canonical.length === 0 || canonical.length > 256) {
    throw remoteMemoryError('invalid_request', 'Organization Cloud requires one share and 1–256 repository bindings.');
  }
  return `sha256:${sha256HexSync(JSON.stringify({version: 1, shareId, repositories: canonical}))}`;
}

export function orgCloudScopes(access: OrgCloudAccess): readonly RemoteMemoryScope[] {
  return access === 'contribute' ? ['memory:read', 'memory:write:durable'] : ['memory:read'];
}

export function admitOrgCloudRequest(
  request: Request,
  principal: AuthorizedRemotePrincipal,
  gitBinding: GitMemoryBinding | undefined,
): AuthorizedRemotePrincipal {
  const access = request.headers.get(ORG_CLOUD_ACCESS_HEADER);
  const digest = request.headers.get(ORG_CLOUD_REPOSITORY_SET_HEADER);
  const deny = () =>
    remoteMemoryError('forbidden', 'The organization Cloud share/repository binding is invalid or stale.');
  if (access === null && digest === null) {
    if (principal.cloudAdmissionRequired) throw deny();
    return principal;
  }
  if (
    (access !== 'read-only' && access !== 'contribute') ||
    !gitBinding ||
    gitBinding.shareId !== principal.shareId ||
    gitBinding.tenantId !== principal.tenantId ||
    request.headers.get('threadnote-share-id') !== principal.shareId ||
    principal.repositoryBindings.size === 0
  )
    throw deny();
  let expected: string;
  try {
    expected = orgCloudRepositorySetDigest(principal.shareId, [...principal.repositoryBindings]);
  } catch {
    throw deny();
  }
  if (digest !== expected) throw deny();
  const scopes = EffectArrayPipe(orgCloudScopes(access), __effectArrayValues =>
    EffectArray.filter(
      __effectArrayValues,
      (scope, __effectArrayIndex) =>
        __effectArrayIndex in __effectArrayValues &&
        (principal.OAuth.scopes.has(scope) || principal.OAuth.scopes.has('memory:admin')),
    ),
  );
  return {
    ...principal,
    OAuth: {...principal.OAuth, scopes: new Set(scopes)},
    attestationRequiredForWrites: true,
  };
}
