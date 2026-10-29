import * as Effect from 'effect';
import * as EffectString from 'effect/String';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {parseGraphShareRegistryChallenge} from '@threadnote/graph/sharing/registry/auth';
import {parseGraphShareRegistryTarget} from '@threadnote/graph/sharing/registry/reference';
import {assertProfileMatches, buildZotConfig} from './render-config.js';

const CANARY = Buffer.from('threadnote-org-registry-authz-canary-v1\n');
const DIGEST = `sha256:${createHash('sha256').update(CANARY).digest('hex')}`;

function token(path: string, issuer: string, audience: string, subject: string): string {
  const value = readFileSync(path, 'utf8').trim();
  if (value.length > 16_384 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u.test(value))
    throw new Error('Token file must contain one JWT');
  const claims = JSON.parse(Buffer.from(value.split('.')[1], 'base64url').toString('utf8')) as Record<string, unknown>;
  if (
    claims.iss !== issuer ||
    claims.sub !== subject ||
    !(claims.aud === audience || (Array.isArray(claims.aud) && claims.aud.includes(audience))) ||
    typeof claims.exp !== 'number' ||
    claims.exp <= Math.floor(Date.now() / 1000) + 30
  )
    throw new Error('JWT issuer, audience, subject, or lifetime does not match this role');
  return value;
}

async function request(origin: string, path: string, method: string, credential?: string, body?: Buffer) {
  const url = new URL(path, origin);
  if (url.origin !== origin) throw new Error('Registry request escaped the configured origin');
  const response = await fetch(url, {
    method,
    headers: {
      ...(credential === undefined ? {} : {Authorization: `Bearer ${credential}`}),
      ...(body === undefined ? {} : {'Content-Type': 'application/octet-stream'}),
    },
    body,
    redirect: 'error',
    signal: AbortSignal.timeout(10_000),
  });
  if (response.redirected) throw new Error('Registry redirected a credentialed request');
  return response;
}

function expectStatus(response: Response, allowed: readonly number[], operation: string): void {
  if (!allowed.includes(response.status)) throw new Error(`${operation} returned HTTP ${response.status}`);
}

async function readBounded(response: Response, maximum: number): Promise<Buffer> {
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > maximum) throw new Error('Registry response exceeds bound');
  const reader = response.body?.getReader();
  if (reader === undefined) throw new Error('Registry response had no body');
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    size += next.value.byteLength;
    if (size > maximum) throw new Error('Registry response exceeds bound');
    chunks.push(next.value);
  }
  return Buffer.concat(chunks, size);
}

async function exchange(
  origin: string,
  repository: string,
  method: 'GET' | 'POST',
  identityJwt: string,
): Promise<string> {
  const access = method === 'POST' ? 'write' : 'read';
  const path = method === 'POST' ? `/v2/${repository}/blobs/uploads/` : `/v2/${repository}/tags/list`;
  const challengeResponse = await request(origin, path, method);
  expectStatus(challengeResponse, [401], 'Registry authentication challenge');
  const target = parseGraphShareRegistryTarget(
    `oci://${Effect.pipe(origin, EffectString.slice('https://'.length))}/${repository}`,
  );
  const challenge = parseGraphShareRegistryChallenge(
    challengeResponse.headers.get('www-authenticate') ?? undefined,
    target,
    access,
  );
  if (challenge.kind !== 'bearer' || challenge.realm !== `${origin}/zot/auth/token`)
    throw new Error('Registry returned an unsupported token challenge');
  const url = new URL(challenge.realm);
  url.searchParams.set('scope', `repository:${repository}:${access === 'write' ? 'pull,push' : 'pull'}`);
  if (challenge.service !== undefined) url.searchParams.set('service', challenge.service);
  const basic = Buffer.from(`zot:${identityJwt}`).toString('base64');
  const response = await fetch(url, {
    headers: {Authorization: `Basic ${basic}`},
    redirect: 'error',
    signal: AbortSignal.timeout(10_000),
  });
  expectStatus(response, [200], 'Scoped Zot token exchange');
  const bytes = await readBounded(response, 32_768);
  const body = JSON.parse(bytes.toString('utf8')) as {token?: unknown; access_token?: unknown};
  const token = body.token ?? body.access_token;
  if (
    typeof token !== 'string' ||
    token.length === 0 ||
    (body.token !== undefined && body.access_token !== undefined && body.token !== body.access_token)
  )
    throw new Error('Zot token response is invalid');
  return token;
}

async function upload(origin: string, repository: string, credential: string): Promise<void> {
  const start = await request(origin, `/v2/${repository}/blobs/uploads/`, 'POST', credential);
  expectStatus(start, [202], 'Authorized upload start');
  const location = start.headers.get('location');
  if (location === null) throw new Error('Upload response omitted Location');
  const url = new URL(location, origin);
  if (url.origin !== origin || !Effect.pipe(url.pathname, EffectString.startsWith(`/v2/${repository}/blobs/uploads/`)))
    throw new Error('Upload Location escaped the approved registry repository');
  url.searchParams.set('digest', DIGEST);
  const finish = await request(origin, url.href, 'PUT', credential, CANARY);
  expectStatus(finish, [201], 'Authorized upload finish');
}

async function readCanary(origin: string, repository: string, credential: string): Promise<void> {
  const response = await request(origin, `/v2/${repository}/blobs/${DIGEST}`, 'GET', credential);
  expectStatus(response, [200], 'Authorized blob read');
  if (!(await readBounded(response, 1024)).equals(CANARY)) throw new Error('Blob content differs from canary');
}

async function main(): Promise<void> {
  const profilePath = process.env.ZOT_PROFILE_FILE;
  const publisherPath = process.env.ZOT_PUBLISHER_TOKEN_FILE;
  const workerPath = process.env.ZOT_WORKER_TOKEN_FILE;
  const readerPath = process.env.ZOT_READER_TOKEN_FILE;
  if (!profilePath || !publisherPath || !workerPath || !readerPath)
    throw new Error('Profile and publisher, worker, reader token file paths are required');
  const config = buildZotConfig(process.env);
  assertProfileMatches(config, JSON.parse(readFileSync(profilePath, 'utf8')));
  const origin = process.env.ZOT_PUBLIC_ORIGIN;
  const issuer = process.env.ZOT_OIDC_ISSUER;
  const audience = process.env.ZOT_OIDC_AUDIENCE;
  const canonical = process.env.ZOT_CANONICAL_REPOSITORY;
  const worker = process.env.ZOT_WORKER_REPOSITORY;
  const workerSubjects = JSON.parse(process.env.ZOT_WORKER_SUBJECTS_JSON) as string[];
  const readerSubjects = JSON.parse(process.env.ZOT_READER_SUBJECTS_JSON) as string[];
  if (workerSubjects.length !== 1 || readerSubjects.length !== 1)
    throw new Error('Live role probe requires exactly one worker and one reader subject');
  const publisherToken = token(publisherPath, issuer, audience, process.env.ZOT_PUBLISHER_SUBJECT);
  const workerToken = token(workerPath, issuer, audience, workerSubjects[0]);
  const readerToken = token(readerPath, issuer, audience, readerSubjects[0]);

  const anonymous = await request(origin, `/v2/${canonical}/tags/list`, 'GET');
  expectStatus(anonymous, [401], 'Anonymous canonical read');
  if (
    !Effect.pipe(
      anonymous.headers.get('www-authenticate') ?? '',
      EffectString.includes(`realm="${origin}/zot/auth/token"`),
    )
  )
    throw new Error('Registry challenge realm differs from the approved HTTPS origin');

  for (const [identity, repository] of [
    [publisherToken, canonical],
    [workerToken, worker],
    [readerToken, canonical],
  ] as const) {
    const readToken = await exchange(origin, repository, 'GET', identity);
    const read = await request(origin, `/v2/${repository}/tags/list`, 'GET', readToken);
    expectStatus(read, [200, 404], 'Scoped token read');
  }
  const publisherWriteToken = await exchange(origin, canonical, 'POST', publisherToken);
  const workerWriteToken = await exchange(origin, worker, 'POST', workerToken);

  for (const [credential, repository] of [
    [workerToken, canonical],
    [publisherToken, worker],
    [readerToken, canonical],
    [readerToken, worker],
  ] as const) {
    const denied = await request(origin, `/v2/${repository}/blobs/uploads/`, 'POST', credential);
    expectStatus(denied, [403], 'Cross-role upload denial');
  }

  await upload(origin, canonical, publisherWriteToken);
  await upload(origin, worker, workerWriteToken);
  for (const [credential, repository] of [
    [publisherToken, canonical],
    [workerToken, canonical],
    [readerToken, canonical],
    [publisherToken, worker],
    [workerToken, worker],
    [readerToken, worker],
  ] as const)
    await readCanary(origin, repository, credential);
  process.stdout.write('Live Zot OIDC role and OCI canary checks passed.\n');
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    process.stderr.write(`Live Zot verification failed: ${error instanceof Error ? error.message : 'unknown error'}\n`);
    process.exitCode = 1;
  });
}
