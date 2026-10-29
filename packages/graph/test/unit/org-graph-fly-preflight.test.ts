import {Array as EffectArray} from 'effect';
/* oxlint-disable effecttsgo/node-builtin-import -- These fixtures exercise native file modes, symlinks, and Ed25519 key material at the container boundary. */
import {generateKeyPairSync} from 'node:crypto';
import {chmodSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import fc from 'fast-check';
import {sha256Digest} from '@threadnote/graph/sharing/digest';
import {graphShareProfileOciArtifact} from '@threadnote/graph/sharing/profile/oci_artifact';
import {defaultGraphShareProfile, graphShareProfileDigest, ociProfilePointer} from '@threadnote/graph/sharing/profile';
import {
  assertGraphPublisherDeploymentBinding,
  validateGraphPublisherDeployment,
} from '../../../../deploy/threadnote-org-graph/preflight.js';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, {recursive: true, force: true});
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'threadnote-graph-fly-'));
  roots.push(root);
  const pair = generateKeyPairSync('ed25519');
  const publicKey = (pair.publicKey.export({format: 'der', type: 'spki'}) as Buffer).subarray(-32);
  const key = {
    fingerprint: sha256Digest(publicKey),
    privateKey: (pair.privateKey.export({format: 'der', type: 'pkcs8'}) as Buffer).toString('hex'),
    publicKey: publicKey.toString('hex'),
    schemaVersion: 1 as const,
  };
  const repositoryId = Effect.pipe('a', EffectString.repeat(64));
  const profile = {
    ...defaultGraphShareProfile({
      branch: 'refs/heads/main',
      canonicalRemote: 'github.com/example/fixture',
      coordinatorUrl: 'https://threadnote-org-graph-e2e.fly.dev',
      organization: 'threadnote-org',
      publisherKeyFingerprint: key.fingerprint,
      repositoryId,
    }),
    registry: {
      canonical: 'oci://threadnote-org-registry-e2e.fly.dev/threadnote-org-e2e/canonical',
      worker: 'oci://threadnote-org-registry-e2e.fly.dev/threadnote-org-e2e/worker',
    },
  };
  const profileDigest = graphShareProfileDigest(profile);
  const enrollment = {
    profile: `cas://${profileDigest}`,
    publisherKeyFingerprint: key.fingerprint,
    repositoryId,
    schemaVersion: 1 as const,
  };
  const policy = {
    audience: 'https://threadnote-org-graph-e2e.fly.dev',
    grants: [
      {expiresAt: 4_102_444_800, scopes: ['graph:read', 'graph:contribute'] as const, subject: 'fixture-worker'},
    ],
    issuer: 'https://threadnote-org.eu.auth0.com/',
    jwksUrl: 'https://threadnote-org.eu.auth0.com/.well-known/jwks.json',
    organization: 'threadnote-org',
    profileDigest,
    repositoryId,
    schemaVersion: 1 as const,
  };
  const env = {
    THREADNOTE_GRAPH_CONTROL_ORIGIN: 'https://threadnote-org-graph-e2e.fly.dev',
    THREADNOTE_GRAPH_REGISTRY_ORIGIN: 'https://threadnote-org-registry-e2e.fly.dev',
    THREADNOTE_GRAPH_CANONICAL_REPOSITORY: 'threadnote-org-e2e/canonical',
    THREADNOTE_GRAPH_WORKER_REPOSITORY: 'threadnote-org-e2e/worker',
    THREADNOTE_GRAPH_GIT_REMOTE_URL: 'git@github.com:example/fixture.git',
    THREADNOTE_GRAPH_GIT_REMOTE_IDENTITY: 'github.com/example/fixture',
    THREADNOTE_GRAPH_GIT_BRANCH: 'main',
    THREADNOTE_GRAPH_ORGANIZATION: 'threadnote-org',
    THREADNOTE_GRAPH_REPOSITORY_ID: repositoryId,
    THREADNOTE_GRAPH_PROFILE_DIGEST: profileDigest,
    THREADNOTE_GRAPH_OAUTH_ISSUER: 'https://threadnote-org.eu.auth0.com/',
    THREADNOTE_GRAPH_OAUTH_AUDIENCE: 'https://threadnote-org-graph-e2e.fly.dev',
    THREADNOTE_AUTH0_REGISTRY_M2M_ISSUER: 'https://threadnote-org.eu.auth0.com/',
    THREADNOTE_AUTH0_REGISTRY_M2M_ORIGIN: 'https://threadnote-org-registry-e2e.fly.dev',
    THREADNOTE_AUTH0_REGISTRY_M2M_AUDIENCE: 'https://threadnote-org-registry-e2e.fly.dev',
    THREADNOTE_AUTH0_PUBLISHER_M2M_CLIENT_ID: 'fixture-publisher',
    THREADNOTE_AUTH0_PUBLISHER_M2M_CLIENT_SECRET: 'fixture-private-value',
    THREADNOTE_AUTH0_PUBLISHER_M2M_SUBJECT: 'fixture-publisher-subject',
  };
  const write = (name: string, content: unknown, privateFile = false) => {
    const path = join(root, name);
    mkdirSync(dirname(path), {recursive: true});
    writeFileSync(path, JSON.stringify(content));
    if (privateFile) chmodSync(path, 0o600);
    return path;
  };
  write('repository/.threadnote/graph-share.json', enrollment);
  write(`threadnote/graph-sharing/cas/sha256/${Effect.pipe(profileDigest, EffectString.slice(7))}`, profile);
  write('threadnote/graph-sharing/keys/publisher.ed25519.json', key, true);
  write('control-policy.json', policy, true);
  return {env, enrollment, key, policy, profile, profileDigest, root, write};
}

describe('Fly graph publisher preflight', () => {
  it('admits a pinned persisted checkout, profile, policy, and publisher key', () => {
    const {env, root} = fixture();
    expect(() => validateGraphPublisherDeployment(root, env)).not.toThrow();
  });

  it('accepts a custom authorization server and requires the exact explicit JWKS endpoint', () => {
    const {env, root, policy, write} = fixture();
    const issuer = 'https://example.okta.test/oauth2/threadnote';
    const generic: NodeJS.ProcessEnv = EffectRecord.fromEntries(
      EffectArray.map(EffectRecord.toEntries(env), ([name, value]) => [
        Effect.pipe(name, EffectString.replace('THREADNOTE_AUTH0_', 'THREADNOTE_OAUTH_')),
        value,
      ]),
    );
    Object.assign(generic, {
      THREADNOTE_GRAPH_OAUTH_ISSUER: issuer,
      THREADNOTE_GRAPH_OAUTH_JWKS_URL: `${issuer}/v1/keys`,
      THREADNOTE_OAUTH_REGISTRY_M2M_ISSUER: 'https://example.okta.test/oauth2/registry',
      THREADNOTE_OAUTH_REGISTRY_M2M_TOKEN_URL: 'https://example.okta.test/oauth2/registry/v1/token',
      THREADNOTE_OAUTH_REGISTRY_M2M_JWKS_URL: 'https://example.okta.test/oauth2/registry/v1/keys',
      THREADNOTE_OAUTH_REGISTRY_M2M_CLIENT_AUTHENTICATION: 'client_secret_basic',
      THREADNOTE_OAUTH_REGISTRY_M2M_CLIENT_ID_CLAIM: 'cid',
    });
    write('control-policy.json', {...policy, issuer, jwksUrl: `${issuer}/v1/keys`}, true);
    expect(() => validateGraphPublisherDeployment(root, generic)).not.toThrow();
    for (const value of [undefined, 'https://other.example/keys', `${issuer}/different-keys`]) {
      expect(() =>
        validateGraphPublisherDeployment(root, {...generic, THREADNOTE_GRAPH_OAUTH_JWKS_URL: value}),
      ).toThrow();
    }
    const noncanonical = `${issuer}/v1/../keys`;
    write('control-policy.json', {...policy, issuer, jwksUrl: noncanonical}, true);
    expect(() =>
      validateGraphPublisherDeployment(root, {...generic, THREADNOTE_GRAPH_OAUTH_JWKS_URL: noncanonical}),
    ).toThrow();
  });

  it('accepts an offline-pinned OCI profile manifest without contacting Zot', () => {
    const {env, enrollment, profile, profileDigest, root, write} = fixture();
    const artifact = graphShareProfileOciArtifact(profile);
    const manifestFile = join(
      root,
      'threadnote/graph-sharing/cas/sha256',
      Effect.pipe(artifact.manifestDigest, EffectString.slice(7)),
    );
    mkdirSync(dirname(manifestFile), {recursive: true});
    writeFileSync(manifestFile, artifact.manifestBytes);
    write('repository/.threadnote/graph-share.json', {
      ...enrollment,
      profile: ociProfilePointer(profile.registry.canonical, artifact.manifestDigest),
      profileDigest,
      schemaVersion: 2,
    });
    expect(() => validateGraphPublisherDeployment(root, env)).not.toThrow();
    writeFileSync(manifestFile, '{}');
    expect(() => validateGraphPublisherDeployment(root, env)).toThrow();
    writeFileSync(manifestFile, artifact.manifestBytes);
    write('repository/.threadnote/graph-share.json', {
      ...enrollment,
      profile: ociProfilePointer(profile.registry.worker, artifact.manifestDigest),
      profileDigest,
      schemaVersion: 2,
    });
    expect(() => validateGraphPublisherDeployment(root, env)).toThrow();
  });

  it('refuses a missing publisher key rather than allowing the runtime to generate one', () => {
    const {env, root} = fixture();
    rmSync(join(root, 'threadnote/graph-sharing/keys/publisher.ed25519.json'));
    expect(() => validateGraphPublisherDeployment(root, env)).toThrow();
  });

  it('refuses a symlinked or world-readable private policy', () => {
    const {env, root} = fixture();
    const policy = join(root, 'control-policy.json');
    chmodSync(policy, 0o644);
    expect(() => validateGraphPublisherDeployment(root, env)).toThrow();
    rmSync(policy);
    symlinkSync(join(root, 'repository/.threadnote/graph-share.json'), policy);
    expect(() => validateGraphPublisherDeployment(root, env)).toThrow();
  });

  it('refuses a profile blob whose bytes do not match its pinned digest', () => {
    const {env, profileDigest, root} = fixture();
    writeFileSync(
      join(root, 'threadnote/graph-sharing/cas/sha256', Effect.pipe(profileDigest, EffectString.slice(7))),
      '{}',
    );
    expect(() => validateGraphPublisherDeployment(root, env)).toThrow();
  });

  it('refuses an OAuth policy from another audience or missing an active contributor', () => {
    const {env, policy, root, write} = fixture();
    write('control-policy.json', {...policy, audience: 'https://other.example'}, true);
    expect(() => validateGraphPublisherDeployment(root, env)).toThrow();
    write('control-policy.json', {...policy, grants: []}, true);
    expect(() => validateGraphPublisherDeployment(root, env)).toThrow();
  });

  it('refuses worker-scoped or mismatched registry credentials in the publisher image', () => {
    const {env, root} = fixture();
    expect(() =>
      validateGraphPublisherDeployment(root, {
        ...env,
        THREADNOTE_AUTH0_PUBLISHER_M2M_CLIENT_SECRET: undefined,
        THREADNOTE_AUTH0_REGISTRY_M2M_ORIGIN: 'https://other.example',
      }),
    ).toThrow();
    expect(() =>
      validateGraphPublisherDeployment(root, {
        ...env,
        THREADNOTE_AUTH0_REGISTRY_M2M_ORIGIN: 'https://other.example',
      }),
    ).toThrow();
  });

  it('refuses a Git URL that differs from the profile source identity', () => {
    const {env, root} = fixture();
    expect(() =>
      validateGraphPublisherDeployment(root, {
        ...env,
        THREADNOTE_GRAPH_GIT_REMOTE_URL: 'git@github.com:other/fixture.git',
      }),
    ).toThrow();
  });

  it('rejects every independently changed organization binding', () => {
    const {env, enrollment, key, policy, profile} = fixture();
    const changes: Array<() => {profile?: typeof profile; enrollment?: typeof enrollment; policy?: typeof policy}> = [
      () => ({profile: {...profile, organization: 'other-org'}}),
      () => ({profile: {...profile, coordinator: {url: 'https://other.example'}}}),
      () => ({profile: {...profile, registry: {...profile.registry, canonical: 'oci://other.example/repo'}}}),
      () => ({profile: {...profile, registry: {...profile.registry, worker: 'oci://other.example/worker'}}}),
      () => ({profile: {...profile, source: {...profile.source, canonicalRemote: 'github.com/other/repo'}}}),
      () => ({profile: {...profile, source: {...profile.source, branches: ['refs/heads/other']}}}),
      () => ({policy: {...policy, repositoryId: Effect.pipe('b', EffectString.repeat(64))}}),
      () => ({policy: {...policy, profileDigest: sha256Digest('other')}}),
      () => ({policy: {...policy, issuer: 'https://other.example/'}}),
      () => ({enrollment: {...enrollment, publisherKeyFingerprint: sha256Digest('other')}}),
    ];
    fc.assert(
      fc.property(fc.constantFrom(...changes), mutate => {
        const changed = mutate();
        expect(() =>
          assertGraphPublisherDeploymentBinding(
            env,
            changed.profile ?? profile,
            changed.enrollment ?? enrollment,
            changed.policy ?? policy,
            key,
          ),
        ).toThrow();
      }),
      {numRuns: 30},
    );
  });
});
