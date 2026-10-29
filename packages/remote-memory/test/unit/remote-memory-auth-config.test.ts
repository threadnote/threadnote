import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {
  assertUriBelongsToAuthorizedShare,
  requestedRemoteShare,
  requireAuthorizedProject,
  requireRemoteScope,
  type AuthorizedRemotePrincipal,
  type RemoteMemoryFeatureFlag,
  type RemoteMemoryScope,
} from '@threadnote/remote-memory/authorization';
import {redactedRemoteMemoryConfig, remoteMemoryConfigFromEnvironment} from '@threadnote/remote-memory/config';
import {bearerTokenFromRequest} from '@threadnote/remote-memory/oauth';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

const productionEnvironment = {
  THREADNOTE_REMOTE_ALLOWED_HOSTS: 'memory.example.test,memory.internal.test:8443',
  THREADNOTE_REMOTE_ALLOWED_ORIGINS: 'https://cursor.com,https://app.cursor.com',
  THREADNOTE_REMOTE_DATABASE_URL: 'postgresql://service:database-secret@db.example.test/threadnote?sslmode=verify-full',
  THREADNOTE_REMOTE_OAUTH_ISSUER: 'https://identity.example.test/tenant/',
  THREADNOTE_REMOTE_OAUTH_JWKS_URL: 'https://identity.example.test/jwks?key=oauth-jwks-secret',
  THREADNOTE_REMOTE_PUBLIC_URL: 'https://memory.example.test',
} as const;

function principalFixture(
  options: {
    readonly allowedProjects?: ReadonlySet<string> | 'all';
    readonly capabilities?: readonly RemoteMemoryScope[];
    readonly featureFlags?: readonly RemoteMemoryFeatureFlag[];
    readonly tokenScopes?: readonly string[];
  } = {},
): AuthorizedRemotePrincipal {
  return {
    allowedProjects: options.allowedProjects ?? new Set(['threadnote']),
    attestationRequiredForWrites: true,
    capabilities: new Set(options.capabilities ?? ['memory:read']),
    cloudAdmissionRequired: false,
    cursorOwnerIds: new Set(['user-1']),
    cursorSubjects: new Set(['cursor-workload']),
    cursorTeamId: 'team-1',
    featureFlags: new Set(options.featureFlags ?? ['remote_memory_read', 'remote_memory_ga']),
    OAuth: {
      issuer: 'https://identity.example.test/tenant',
      scopes: new Set(options.tokenScopes ?? ['memory:read']),
      subject: 'oauth-subject',
    },
    policyVersion: 'policy-v1',
    policyDigest: 'digest-v1',
    principalId: 'principal-1',
    repositoryBindings: new Set(['https://github.com/example/threadnote']),
    repositoriesByProject: new Map([['threadnote', new Set(['https://github.com/example/threadnote'])]]),
    shareId: 'share-1',
    sharePolicyDigest: 'share-digest-v1',
    sharePolicyVersion: 'share-policy-v1',
    tenantId: 'tenant-1',
  };
}

describe('remote memory service configuration', () => {
  it('normalizes explicit production origins, hosts, and bounded defaults', () => {
    const config = remoteMemoryConfigFromEnvironment(productionEnvironment);

    expect(config.publicBaseUrl.toString()).toBe('https://memory.example.test/');
    expect(config.accessTokenIssuer).toBe('https://identity.example.test/tenant/');
    expect(config.allowedHosts).toEqual(['memory.example.test', 'memory.internal.test:8443']);
    expect(config.allowedOrigins).toEqual(['https://cursor.com', 'https://app.cursor.com']);
    expect(config.accessTokenAudience).toBe('https://memory.example.test/mcp');
    expect(config.attestationAudience).toBe('https://memory.example.test/attest/cursor');
    expect(config.cursorJwksUrl.toString()).toBe('https://api.cursor.com/keys');
    expect(config.globallyEnabled).toBe(false);
    expect(config.canonicalStore).toBe('postgres');
    expect(config.gitWorktree).toBeUndefined();
    expect(config.maxBodyBytes).toBe(256 * 1024);
    expect(config.readRequestsPerMinute).toBe(300);
    expect(config.writeRequestsPerMinute).toBe(60);
  });

  it('preserves the exact OAuth issuer identifier after trimming environment whitespace', () => {
    fc.assert(
      fc.property(fc.webUrl({validSchemes: ['https']}), fc.boolean(), (url, trailingSlash) => {
        const issuer = `${new URL(url).origin}${trailingSlash ? '/' : ''}`;
        const config = remoteMemoryConfigFromEnvironment({
          ...productionEnvironment,
          THREADNOTE_REMOTE_OAUTH_ISSUER: `  ${issuer}  `,
          THREADNOTE_REMOTE_OAUTH_JWKS_URL: `${new URL(issuer).origin}/.well-known/jwks.json`,
        });

        expect(config.accessTokenIssuer).toBe(issuer);
      }),
      {numRuns: 100},
    );
  });

  it('permits an explicit localhost development service without database TLS', () => {
    const config = remoteMemoryConfigFromEnvironment({
      THREADNOTE_REMOTE_DATABASE_URL: 'postgres://threadnote@localhost/threadnote',
      THREADNOTE_REMOTE_OAUTH_ISSUER: 'http://localhost:9000',
      THREADNOTE_REMOTE_PUBLIC_URL: 'http://127.0.0.1:8787',
    });

    expect(config.publicBaseUrl.toString()).toBe('http://127.0.0.1:8787/');
    expect(config.allowedHosts).toEqual(['127.0.0.1:8787']);
    expect(config.autoMigrate).toBe(true);
  });

  it('accepts loopback HTTP origins for the local composer OAuth callback', () => {
    const config = remoteMemoryConfigFromEnvironment({
      THREADNOTE_REMOTE_ALLOWED_ORIGINS: 'https://cursor.com,http://127.0.0.1:8787,http://localhost:8787',
      THREADNOTE_REMOTE_DATABASE_URL: 'postgres://threadnote@localhost/threadnote',
      THREADNOTE_REMOTE_OAUTH_ISSUER: 'http://127.0.0.1:18788',
      THREADNOTE_REMOTE_PUBLIC_URL: 'http://127.0.0.1:18788',
    });
    expect(config.allowedOrigins).toEqual(['https://cursor.com', 'http://127.0.0.1:8787', 'http://localhost:8787']);
  });

  it('accepts only an explicit environment-wide enablement switch', () => {
    const config = remoteMemoryConfigFromEnvironment({...productionEnvironment, THREADNOTE_REMOTE_ENABLED: 'true'});
    expect(config.globallyEnabled).toBe(true);
  });

  it('accepts an explicit provider-neutral OAuth client claim mapping', () => {
    const config = remoteMemoryConfigFromEnvironment({
      ...productionEnvironment,
      THREADNOTE_REMOTE_OAUTH_CLIENT_ID_CLAIM: 'cid',
    });
    expect(config.accessTokenClientIdClaim).toBe('cid');
    expect(redactedRemoteMemoryConfig(config)).toMatchObject({accessTokenClientIdClaim: 'cid'});
  });

  it('bounds the explicit legacy client-binding transition window', () => {
    const until = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const config = remoteMemoryConfigFromEnvironment({
      ...productionEnvironment,
      THREADNOTE_REMOTE_OAUTH_CLIENT_ID_CLAIM: 'cid',
      THREADNOTE_REMOTE_OAUTH_LEGACY_CLIENT_ID_COMPATIBILITY_UNTIL: until,
    });
    expect(config.legacyClientIdCompatibilityUntil).toBe(until);
    expect(redactedRemoteMemoryConfig(config)).toMatchObject({legacyClientIdCompatibilityUntil: until});
    expect(() =>
      remoteMemoryConfigFromEnvironment({
        ...productionEnvironment,
        THREADNOTE_REMOTE_OAUTH_LEGACY_CLIENT_ID_COMPATIBILITY_UNTIL: until,
      }),
    ).toThrow('requires a client-id claim mapping');
    expect(() =>
      remoteMemoryConfigFromEnvironment({
        ...productionEnvironment,
        THREADNOTE_REMOTE_OAUTH_CLIENT_ID_CLAIM: 'cid',
        THREADNOTE_REMOTE_OAUTH_LEGACY_CLIENT_ID_COMPATIBILITY_UNTIL: new Date(
          Date.now() + 32 * 24 * 60 * 60 * 1000,
        ).toISOString(),
      }),
    ).toThrow('within 31 days');
  });

  it.each([
    [{...productionEnvironment, THREADNOTE_REMOTE_PUBLIC_URL: 'http://memory.example.test'}, 'HTTPS'],
    [{...productionEnvironment, THREADNOTE_REMOTE_PUBLIC_URL: 'ftp://localhost/threadnote'}, 'HTTPS'],
    [
      {
        ...productionEnvironment,
        THREADNOTE_REMOTE_DATABASE_URL: 'postgres://db.example.test/threadnote',
        THREADNOTE_REMOTE_PUBLIC_URL: 'http://localhost:8787',
      },
      'sslmode=verify-full',
    ],
    [
      {...productionEnvironment, THREADNOTE_REMOTE_DATABASE_URL: 'postgres://db.example.test/threadnote'},
      'sslmode=verify-full',
    ],
    [{...productionEnvironment, THREADNOTE_REMOTE_DATABASE_URL: 'sqlite:///tmp/threadnote.db'}, 'PostgreSQL'],
    [{...productionEnvironment, THREADNOTE_REMOTE_ALLOWED_HOSTS: 'https://memory.example.test'}, 'Host'],
    [{...productionEnvironment, THREADNOTE_REMOTE_ALLOWED_HOSTS: 'memory.example.test:99999'}, 'Host'],
    [{...productionEnvironment, THREADNOTE_REMOTE_ALLOWED_HOSTS: 'memory..example.test'}, 'Host'],
    [{...productionEnvironment, THREADNOTE_REMOTE_ALLOWED_ORIGINS: 'https://cursor.com/path'}, 'Origin'],
    [{...productionEnvironment, THREADNOTE_REMOTE_ALLOWED_ORIGINS: 'http://cursor.com'}, 'Origin'],
    [
      {...productionEnvironment, THREADNOTE_REMOTE_ALLOWED_ORIGINS: 'https://cursor.com,http://127.0.0.1:8787'},
      'Origin',
    ],
    [{...productionEnvironment, THREADNOTE_REMOTE_OAUTH_JWKS_URL: 'http://identity.example.test/jwks'}, 'HTTPS'],
    [{...productionEnvironment, THREADNOTE_REMOTE_CURSOR_JWKS_URL: 'http://api.cursor.com/jwks'}, 'HTTPS'],
    [{...productionEnvironment, THREADNOTE_REMOTE_OAUTH_CLIENT_ID_CLAIM: 'client'}, 'CLIENT_ID_CLAIM'],
    [{...productionEnvironment, THREADNOTE_REMOTE_PUBLIC_URL: 'https://memory.example.test/path'}, 'origin'],
  ])('rejects an unsafe network configuration %#', (environment, expectedMessage) => {
    expect(() => remoteMemoryConfigFromEnvironment(environment)).toThrow(expectedMessage);
  });

  it('pins the managed Cursor issuer to its published JWKS path', () => {
    expect(() =>
      remoteMemoryConfigFromEnvironment({
        ...productionEnvironment,
        THREADNOTE_REMOTE_CURSOR_JWKS_URL: 'https://api.cursor.com/not-the-published-key-set',
      }),
    ).toThrow("Cursor's published /keys endpoint");
  });

  it('keeps connection credentials and JWKS query material out of redacted diagnostics', () => {
    const redacted = redactedRemoteMemoryConfig(remoteMemoryConfigFromEnvironment(productionEnvironment));
    const serialized = JSON.stringify(redacted);

    expect(serialized).not.toContain('database-secret');
    expect(serialized).not.toContain('oauth-jwks-secret');
    expect(redacted).not.toHaveProperty('databaseUrl');
    expect(redacted).not.toHaveProperty('accessTokenJwksUrl');
    expect(redacted).toMatchObject({
      accessTokenIssuer: 'https://identity.example.test/tenant/',
      canonicalStore: 'postgres',
      publicBaseUrl: 'https://memory.example.test/',
    });
  });

  it('requires an absolute git worktree when the canonical store is git', () => {
    expect(() =>
      remoteMemoryConfigFromEnvironment({...productionEnvironment, THREADNOTE_REMOTE_CANONICAL_STORE: 'git'}),
    ).toThrow('THREADNOTE_REMOTE_MEMORY_GIT_WORKTREE');
    expect(() =>
      remoteMemoryConfigFromEnvironment({
        ...productionEnvironment,
        THREADNOTE_REMOTE_CANONICAL_STORE: 'git',
        THREADNOTE_REMOTE_MEMORY_GIT_WORKTREE: 'relative/worktree',
      }),
    ).toThrow('absolute path');
    const config = remoteMemoryConfigFromEnvironment({
      ...productionEnvironment,
      THREADNOTE_REMOTE_CANONICAL_STORE: 'git',
      THREADNOTE_REMOTE_MEMORY_GIT_WORKTREE: '/var/threadnote/memory-git',
      THREADNOTE_REMOTE_MEMORY_GIT_TENANT_ID: 'tenant-org',
      THREADNOTE_REMOTE_MEMORY_GIT_SHARE_ID: 'share-org',
    });
    expect(config.canonicalStore).toBe('git');
    expect(config.gitWorktree).toBe('/var/threadnote/memory-git');
    expect(config.gitBranch).toBe('main');
  });

  it('rejects git remotes and branches that are not safe refnames', () => {
    expect(() =>
      remoteMemoryConfigFromEnvironment({
        ...productionEnvironment,
        THREADNOTE_REMOTE_CANONICAL_STORE: 'git',
        THREADNOTE_REMOTE_MEMORY_GIT_WORKTREE: '/var/threadnote/memory-git',
        THREADNOTE_REMOTE_MEMORY_GIT_TENANT_ID: 'tenant-org',
        THREADNOTE_REMOTE_MEMORY_GIT_SHARE_ID: 'share-org',
        THREADNOTE_REMOTE_MEMORY_GIT_REMOTE: 'https://evil.example/repo.git',
      }),
    ).toThrow('safe git refname');
    expect(() =>
      remoteMemoryConfigFromEnvironment({
        ...productionEnvironment,
        THREADNOTE_REMOTE_CANONICAL_STORE: 'git',
        THREADNOTE_REMOTE_MEMORY_GIT_WORKTREE: '/var/threadnote/memory-git',
        THREADNOTE_REMOTE_MEMORY_GIT_TENANT_ID: 'tenant-org',
        THREADNOTE_REMOTE_MEMORY_GIT_SHARE_ID: 'share-org',
        THREADNOTE_REMOTE_MEMORY_GIT_BRANCH: '-u',
      }),
    ).toThrow('safe git refname');
  });
});

describe('remote memory request authorization', () => {
  it('requires token scope, share grant, and feature activation together', () => {
    fc.assert(
      fc.property(fc.boolean(), fc.boolean(), fc.boolean(), (tokenAllows, grantAllows, featureAllows) => {
        const principal = principalFixture({
          capabilities: grantAllows ? ['memory:write:durable'] : [],
          featureFlags: featureAllows ? ['remote_memory_durable_write', 'remote_memory_ga'] : [],
          tokenScopes: tokenAllows ? ['memory:write:durable'] : [],
        });
        const authorize = () => requireRemoteScope(principal, 'memory:write:durable');
        if (tokenAllows && grantAllows && featureAllows) expect(authorize).not.toThrow();
        else expect(authorize).toThrow(/does not grant|has not enabled/u);
      }),
    );
  });

  it('lets an admin scope and grant authorize operations but not bypass feature rollout', () => {
    const enabled = principalFixture({
      capabilities: ['memory:admin'],
      featureFlags: ['remote_memory_handoff_write', 'remote_memory_ga'],
      tokenScopes: ['memory:admin'],
    });
    const disabled = principalFixture({
      capabilities: ['memory:admin'],
      featureFlags: [],
      tokenScopes: ['memory:admin'],
    });

    expect(() => requireRemoteScope(enabled, 'memory:write:handoff')).not.toThrow();
    expect(() => requireRemoteScope(disabled, 'memory:write:handoff')).toThrow('has not enabled');
  });

  it('uses remote_memory_ga as a share-wide traffic kill switch', () => {
    const principal = principalFixture({featureFlags: ['remote_memory_read']});
    expect(() => requireRemoteScope(principal, 'memory:read')).toThrow('remote_memory_ga');
  });

  it('confines projects and canonical resource URIs to the authorized share', () => {
    const principal = principalFixture();
    const allowed = 'threadnote://share/share-1/memories/durable/threadnote/auth.md';
    const otherShare = 'threadnote://share/share-2/memories/durable/threadnote/auth.md';

    expect(() => requireAuthorizedProject(principal, 'threadnote')).not.toThrow();
    expect(() => requireAuthorizedProject(principal, 'another-project')).toThrow('outside the authorized share');
    expect(() => assertUriBelongsToAuthorizedShare(principal, allowed)).not.toThrow();
    expect(() => assertUriBelongsToAuthorizedShare(principal, otherShare)).toThrow(
      'outside the authorized memory share',
    );
  });

  it('accepts one exact share selector and rejects ambiguous or malformed selectors', () => {
    expect(
      requestedRemoteShare(
        new Request('https://memory.example.test/mcp?share=share-1', {
          headers: {'threadnote-share-id': 'share-1'},
        }),
      ),
    ).toBe('share-1');
    expect(() =>
      requestedRemoteShare(
        new Request('https://memory.example.test/mcp?share=share-2', {
          headers: {'threadnote-share-id': 'share-1'},
        }),
      ),
    ).toThrow('do not match');
    expect(() => requestedRemoteShare(new Request('https://memory.example.test/mcp?share=%2Fetc'))).toThrow(
      'identifier is invalid',
    );
  });

  it('parses exactly one bounded bearer token and rejects malformed authorization', () => {
    expect(
      bearerTokenFromRequest(
        new Request('https://memory.example.test/mcp', {headers: {authorization: 'Bearer opaque-token'}}),
      ),
    ).toBe('opaque-token');

    for (const authorization of [
      'Basic value',
      'Bearer token trailing',
      'Bearer',
      `Bearer ${Effect.pipe('x', EffectString.repeat(16_385))}`,
    ]) {
      expect(() =>
        bearerTokenFromRequest(new Request('https://memory.example.test/mcp', {headers: {authorization}})),
      ).toThrow('bearer access token');
    }
  });
});
