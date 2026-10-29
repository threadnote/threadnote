/* oxlint-disable effecttsgo/node-builtin-import -- This container preflight verifies raw volume files and native Ed25519 key identity before starting Effect services. */
import * as Effect from 'effect';
import * as EffectString from 'effect/String';
import {canonicalOAuthUrl, sameOriginOAuthEndpoint} from '@threadnote/graph/sharing/oauth/m2m_config';
import {parseOAuthM2MPublisherRegistryCredentialConfig} from '@threadnote/graph/sharing/oauth/m2m_registry_credential';
import {createPrivateKey, createPublicKey} from 'node:crypto';
import {constants, fstatSync, lstatSync, openSync, readFileSync, closeSync} from 'node:fs';
import {join, resolve, sep} from 'node:path';
import {
  parseGraphShareEnrollment,
  parseGraphShareProfile,
  parseGraphShareProfilePointer,
  enrolledProfileBodyDigest,
  graphShareProfileDigest,
  type GraphShareEnrollment,
  type GraphShareProfileV1,
} from '@threadnote/graph/sharing/profile';
import {parseGraphShareProfileOciArtifact} from '@threadnote/graph/sharing/profile/oci_artifact';
import {parseGraphSharePublisherKey, type GraphSharePublisherKeyV1} from '@threadnote/graph/sharing/artifacts';
import {parseGraphControlPolicy, type GraphControlPolicy} from '@threadnote/graph/sharing/control/authorization';
import {sha256Digest, SHA256_DIGEST, SHA256_HEX} from '@threadnote/graph/sharing/digest';

type Environment = Readonly<Record<string, string | undefined>>;

function required(env: Environment, name: string): string {
  const value = env[name];
  if (value === undefined || value.length === 0 || EffectString.trim(value) !== value)
    throw new Error(`${name} is missing or invalid`);
  return value;
}

function canonicalHttps(value: string, name: string, issuer = false): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} is invalid`);
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (issuer ? !canonicalOAuthUrl(value) : url.pathname !== '/' || value !== url.origin)
  )
    throw new Error(`${name} must be a canonical HTTPS ${issuer ? 'URL' : 'origin'}`);
  return url;
}

function deploymentBinding(env: Environment) {
  const control = canonicalHttps(required(env, 'THREADNOTE_GRAPH_CONTROL_ORIGIN'), 'Control origin');
  const registry = canonicalHttps(required(env, 'THREADNOTE_GRAPH_REGISTRY_ORIGIN'), 'Registry origin');
  const issuer = canonicalHttps(required(env, 'THREADNOTE_GRAPH_OAUTH_ISSUER'), 'OAuth issuer', true);
  const audience = canonicalHttps(required(env, 'THREADNOTE_GRAPH_OAUTH_AUDIENCE'), 'OAuth audience');
  const credentials = parseOAuthM2MPublisherRegistryCredentialConfig(env);
  const issuerValue = required(env, 'THREADNOTE_GRAPH_OAUTH_ISSUER');
  const jwksUrl =
    env.THREADNOTE_GRAPH_OAUTH_JWKS_URL ??
    (env.THREADNOTE_AUTH0_REGISTRY_M2M_ISSUER === issuerValue && env.THREADNOTE_OAUTH_REGISTRY_M2M_ISSUER === undefined
      ? new URL('.well-known/jwks.json', issuer).href
      : undefined);
  if (
    !jwksUrl ||
    !sameOriginOAuthEndpoint(jwksUrl, issuerValue) ||
    credentials.origin !== registry.origin ||
    credentials.audience !== registry.origin
  )
    throw new Error('Publisher credential authority differs from the graph deployment');
  const canonicalRepository = required(env, 'THREADNOTE_GRAPH_CANONICAL_REPOSITORY');
  const workerRepository = required(env, 'THREADNOTE_GRAPH_WORKER_REPOSITORY');
  if (
    !/^[a-z0-9][a-z0-9._/-]{0,254}$/u.test(canonicalRepository) ||
    !/^[a-z0-9][a-z0-9._/-]{0,254}$/u.test(workerRepository) ||
    canonicalRepository === workerRepository
  )
    throw new Error('Registry repositories are invalid');
  const repositoryId = required(env, 'THREADNOTE_GRAPH_REPOSITORY_ID');
  const profileDigest = required(env, 'THREADNOTE_GRAPH_PROFILE_DIGEST');
  if (!SHA256_HEX.test(repositoryId) || !SHA256_DIGEST.test(profileDigest))
    throw new Error('Repository or profile identity is invalid');
  const branch = required(env, 'THREADNOTE_GRAPH_GIT_BRANCH');
  if (
    !/^[A-Za-z0-9._/-]{1,255}$/u.test(branch) ||
    Effect.pipe(branch, EffectString.startsWith('-')) ||
    Effect.pipe(branch, EffectString.includes('..'))
  )
    throw new Error('Git branch is invalid');
  const gitRemoteUrl = required(env, 'THREADNOTE_GRAPH_GIT_REMOTE_URL');
  const remoteMatch = /^git@github\.com:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\.git$/u.exec(gitRemoteUrl);
  const gitRemoteIdentity = required(env, 'THREADNOTE_GRAPH_GIT_REMOTE_IDENTITY');
  if (!remoteMatch || gitRemoteIdentity !== `github.com/${remoteMatch[1]}`)
    throw new Error('Git source URL differs from the enrolled repository identity');
  return {
    audience: audience.origin,
    branch: `refs/heads/${branch}`,
    canonicalRegistry: `oci://${registry.host}/${canonicalRepository}`,
    controlOrigin: control.origin,
    gitRemoteIdentity,
    issuer: issuerValue,
    jwksUrl,
    organization: required(env, 'THREADNOTE_GRAPH_ORGANIZATION'),
    profileDigest,
    repositoryId,
    workerRegistry: `oci://${registry.host}/${workerRepository}`,
  };
}

export function assertGraphPublisherDeploymentBinding(
  env: Environment,
  profile: GraphShareProfileV1,
  enrollment: GraphShareEnrollment,
  policy: GraphControlPolicy,
  key: GraphSharePublisherKeyV1,
): void {
  const expected = deploymentBinding(env);
  const pointer = parseGraphShareProfilePointer(enrollment.profile);
  if (
    enrolledProfileBodyDigest(enrollment) !== expected.profileDigest ||
    (pointer.kind === 'oci' && pointer.registryReference !== expected.canonicalRegistry) ||
    graphShareProfileDigest(profile) !== expected.profileDigest ||
    enrollment.repositoryId !== expected.repositoryId ||
    profile.repositoryId !== expected.repositoryId ||
    policy.repositoryId !== expected.repositoryId ||
    profile.organization !== expected.organization ||
    policy.organization !== expected.organization ||
    profile.coordinator?.url !== expected.controlOrigin ||
    profile.registry.canonical !== expected.canonicalRegistry ||
    profile.registry.worker !== expected.workerRegistry ||
    profile.source.canonicalRemote !== expected.gitRemoteIdentity ||
    profile.source.branches.length !== 1 ||
    profile.source.branches[0] !== expected.branch ||
    policy.profileDigest !== expected.profileDigest ||
    policy.issuer !== expected.issuer ||
    policy.jwksUrl !== expected.jwksUrl ||
    policy.audience !== expected.audience ||
    enrollment.publisherKeyFingerprint !== key.fingerprint ||
    !profile.trust.publisherKeys.includes(key.fingerprint)
  )
    throw new Error('Persisted graph authority differs from the configured deployment');
  const publicBytes = Buffer.from(key.publicKey, 'hex');
  const privateKey = createPrivateKey({
    key: Buffer.from(key.privateKey, 'hex'),
    format: 'der',
    type: 'pkcs8',
  });
  const derivedPublic = createPublicKey(privateKey.export({format: 'pem', type: 'pkcs8'})).export({
    format: 'der',
    type: 'spki',
  }) as Buffer;
  if (
    publicBytes.byteLength !== 32 ||
    !derivedPublic.subarray(-32).equals(publicBytes) ||
    sha256Digest(publicBytes) !== key.fingerprint
  )
    throw new Error('Persisted publisher key does not match the enrolled public key');
  const now = Math.floor(Date.now() / 1000);
  if (
    !policy.grants.some(grant => grant.expiresAt > now && grant.scopes.includes('graph:read')) ||
    !policy.grants.some(grant => grant.expiresAt > now && grant.scopes.includes('graph:contribute'))
  )
    throw new Error('Graph control policy has no active reader or contributor');
}

function readStateFile(root: string, relative: string, limit: number, privateFile = false): Uint8Array {
  const base = resolve(root);
  let current = base;
  if (!lstatSync(base).isDirectory()) throw new Error('Publisher volume is unavailable');
  for (const component of Effect.pipe(relative, EffectString.split('/'))) {
    current = join(current, component);
    const metadata = lstatSync(current);
    if (metadata.isSymbolicLink()) throw new Error('Publisher state must not use symbolic links');
  }
  if (!Effect.pipe(current, EffectString.startsWith(`${base}${sep}`)))
    throw new Error('Publisher state escaped its volume');
  const handle = openSync(current, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = fstatSync(handle);
    if (!metadata.isFile() || metadata.size > limit || (privateFile && (metadata.mode & 0o077) !== 0))
      throw new Error('Publisher state is missing, oversized, or insecure');
    return readFileSync(handle);
  } finally {
    closeSync(handle);
  }
}

function readJson(root: string, relative: string, limit: number, privateFile = false): unknown {
  return JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(readStateFile(root, relative, limit, privateFile)));
}

export function validateGraphPublisherDeployment(root: string, env: Environment): void {
  const enrollment = parseGraphShareEnrollment(readJson(root, 'repository/.threadnote/graph-share.json', 4096));
  const pointer = parseGraphShareProfilePointer(enrollment.profile);
  const bodyDigest = enrolledProfileBodyDigest(enrollment);
  const bytes = readStateFile(
    root,
    `threadnote/graph-sharing/cas/sha256/${Effect.pipe(bodyDigest, EffectString.slice(7))}`,
    128 * 1024,
  );
  if (sha256Digest(bytes) !== bodyDigest) throw new Error('Persisted profile digest differs from enrollment');
  const profile =
    pointer.kind === 'cas'
      ? parseGraphShareProfile(JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes)))
      : parseGraphShareProfileOciArtifact(
          readStateFile(
            root,
            `threadnote/graph-sharing/cas/sha256/${Effect.pipe(pointer.manifestDigest, EffectString.slice(7))}`,
            8192,
          ),
          pointer.manifestDigest,
          bytes,
        );
  const policy = parseGraphControlPolicy(readJson(root, 'control-policy.json', 128 * 1024, true));
  const key = parseGraphSharePublisherKey(
    readJson(root, 'threadnote/graph-sharing/keys/publisher.ed25519.json', 4096, true),
  );
  assertGraphPublisherDeploymentBinding(env, profile, enrollment, policy, key);
}

if (import.meta.main) {
  try {
    validateGraphPublisherDeployment('/data/signed', process.env);
    process.stdout.write('Publisher deployment preflight passed.\n');
  } catch (error) {
    process.stderr.write(
      `Publisher deployment preflight failed: ${error instanceof Error ? error.message : 'invalid state'}\n`,
    );
    process.exitCode = 1;
  }
}
