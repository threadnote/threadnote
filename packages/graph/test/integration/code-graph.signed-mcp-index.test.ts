import {Array as EffectArray, Option as EffectOption} from 'effect';
import * as EffectRecord from 'effect/Record';
import {execFile} from '@threadnote/testing/node-child-process';
import {promisify} from '@threadnote/testing/node-util';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {describe, expect, it} from 'vitest';
import {mkdir, mkdtemp, readFile, rm, writeFile} from '@threadnote/testing/node-fs-promises';
import {tmpdir} from '@threadnote/testing/node-os';
import {join} from '@threadnote/testing/node-path';
import {canonicalJson} from '@threadnote/graph/checkpoint/canonical_json';
import {sha256Digest, sha256HexFromDigest} from '@threadnote/graph/sharing/digest';
import {isJsonObject} from '@threadnote/platform/json';
import {defaultGraphShareProfile, graphShareProfileDigest} from '@threadnote/graph/sharing/profile';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

describe('MCP-owned signed graph contribution', () => {
  it('queues and delivers a signed candidate from a strict graph inspection without a contribute command', async () => {
    const root = await mkdtemp(join(tmpdir(), 'threadnote-signed-mcp-index-'));
    const home = join(root, 'home');
    const cas = join(root, 'cas');
    const repository = join(root, 'repository');
    const repositoryId = sha256HexFromDigest(sha256Digest('repository-v1\ngithub.com/acme/signed-mcp-index'));
    const command = promisify(execFile);
    const requests: string[] = [];
    const registryBlobs = new Map<string, Uint8Array>();
    const registryManifests = new Map<string, Uint8Array>();
    let releaseResult!: () => void;
    const resultGate = new Promise<void>(resolve => {
      releaseResult = resolve;
    });
    let pendingResult: unknown;
    let evidenceVerified = false;
    let enrolledWorker:
      | {
          expiresAt: number;
          principalId: string;
          profileDigest: string;
          repositoryId: string;
          signingPublicKey: string;
          workerId: string;
        }
      | undefined;
    let delivered = false;
    const coordinator = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: async request => {
        const url = new URL(request.url);
        requests.push(`${request.method} ${url.pathname}`);
        if (url.pathname === '/v1/enroll') {
          const body = requireRecord(await request.json());
          const profileDigest = requireString(body.profileDigest);
          const bodyRepositoryId = requireString(body.repositoryId);
          const signingPublicKey = requireString(body.signingPublicKey);
          enrolledWorker = {
            expiresAt: Math.floor(Date.now() / 1000) + 3600,
            principalId: sha256Digest(JSON.stringify(['https://identity.example.test/', 'signed-mcp-fixture'])),
            profileDigest,
            repositoryId: bodyRepositoryId,
            signingPublicKey,
            workerId: `gw_${Effect.pipe('1', EffectString.repeat(32))}`,
          };
          return Response.json({...enrolledWorker, schemaVersion: 1}, {status: 201});
        }
        if (url.pathname === '/v1/results') {
          pendingResult = await request.json();
          await resultGate;
          if (!evidenceVerified) return Response.json({error: 'invalid synthetic evidence'}, {status: 400});
          delivered = true;
          const result = requireRecord(pendingResult);
          const body = requireRecord(result.body);
          return Response.json({idempotencyKey: requireString(body.idempotencyKey), status: 'accepted'}, {status: 201});
        }
        if (Effect.pipe(url.pathname, EffectString.startsWith('/v2/acme/worker/'))) {
          const suffix = Effect.pipe(url.pathname, EffectString.slice('/v2/acme/worker/'.length));
          if (request.method === 'POST' && suffix === 'blobs/uploads/')
            return new Response(null, {
              status: 202,
              headers: {location: '/v2/acme/worker/blobs/uploads/fixture?_state=opaque'},
            });
          if (request.method === 'PUT') {
            const bytes = new Uint8Array(await request.arrayBuffer());
            const digest = sha256Digest(bytes);
            if (Effect.pipe(suffix, EffectString.startsWith('blobs/uploads/'))) {
              if (url.searchParams.get('digest') !== digest) return new Response(null, {status: 400});
              registryBlobs.set(digest, bytes);
            } else if (Effect.pipe(suffix, EffectString.startsWith('manifests/'))) {
              registryManifests.set(Effect.pipe(suffix, EffectString.slice('manifests/'.length)), bytes);
            } else return new Response(null, {status: 400});
            return new Response(null, {status: 201, headers: {'docker-content-digest': digest}});
          }
          const isManifest = Effect.pipe(suffix, EffectString.startsWith('manifests/'));
          const bytes = (isManifest ? registryManifests : registryBlobs).get(
            Effect.pipe(suffix, EffectString.slice(isManifest ? 'manifests/'.length : 'blobs/'.length)),
          );
          if (bytes === undefined) return new Response(null, {status: 404});
          return new Response(request.method === 'HEAD' ? null : Uint8Array.from(bytes), {
            headers: {
              'content-length': String(bytes.length),
              'content-type': isManifest ? 'application/vnd.oci.image.manifest.v1+json' : 'application/octet-stream',
              'docker-content-digest': sha256Digest(bytes),
            },
          });
        }
        if (request.method === 'GET' && url.pathname === '/v1/status')
          return Response.json({
            generation: 1,
            organization: 'acme',
            phase: 'idle',
            publishedFrontier: null,
            repositoryId,
            receipts: [],
          });
        return new Response(null, {status: 404});
      },
    });
    let client: Client | undefined;
    try {
      await mkdir(join(home, 'graph-sharing'), {recursive: true});
      await mkdir(join(cas, 'sha256'), {recursive: true});
      await mkdir(join(repository, 'src'), {recursive: true});
      await mkdir(join(root, 'helpers'), {recursive: true});
      await mkdir(join(root, 'docker'), {recursive: true});
      await writeFile(join(home, 'seed-manifest.yaml'), 'version: 1\nprojects: []\n');
      await writeFile(
        join(root, 'docker', 'config.json'),
        JSON.stringify({credHelpers: {'registry.example.test': 'fixture'}}),
      );
      await writeFile(
        join(root, 'helpers', 'threadnote-credential-fixture'),
        `#!/usr/bin/env bun
process.stdout.write(JSON.stringify({
  accessToken: 'synthetic-token',
  audience: 'https://control.example.test/',
  expiresAt: Math.floor(Date.now() / 1000) + 600,
  issuer: 'https://identity.example.test/',
  schemaVersion: 1,
  subject: 'signed-mcp-fixture',
}));
`,
      );
      await writeFile(
        join(root, 'helpers', 'docker-credential-fixture'),
        `#!/usr/bin/env bun
process.stdout.write(JSON.stringify({Username: 'synthetic-publisher', Secret: 'fixture-only'}));
`,
      );
      await command('chmod', [
        '+x',
        join(root, 'helpers', 'threadnote-credential-fixture'),
        join(root, 'helpers', 'docker-credential-fixture'),
      ]);
      await writeFile(
        join(root, 'preload.js'),
        `const nativeFetch = globalThis.fetch;
globalThis.fetch = Object.assign(async (input, init) => {
  const request = new Request(input, init);
  const url = new URL(request.url);
  if (url.origin !== 'https://control.example.test' && url.origin !== 'https://registry.example.test') {
    if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost')
      throw new Error('Unexpected external network request in synthetic graph fixture');
    return nativeFetch(input, init);
  }
  const rewritten = new Request(process.env.THREADNOTE_TEST_GRAPH_SYNTHETIC_ORIGIN + url.pathname + url.search, request);
  return nativeFetch(rewritten);
}, {preconnect: () => undefined});
`,
      );
      await writeFile(join(repository, 'src', 'index.ts'), 'export function signedMcpTarget() { return 42; }\n');
      await command('git', ['init', '-q', '--initial-branch=main', repository]);
      await command('git', [
        '-C',
        repository,
        'remote',
        'add',
        'origin',
        'https://github.com/acme/signed-mcp-index.git',
      ]);
      await command('git', ['-C', repository, 'add', '.']);
      await command('git', [
        '-C',
        repository,
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.invalid',
        'commit',
        '-qm',
        'fixture',
      ]);
      await writeFile(join(repository, 'src', 'after.ts'), 'export function signedMcpAfterTarget() { return 43; }\n');
      await command('git', ['-C', repository, 'add', '.']);
      await command('git', [
        '-C',
        repository,
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.invalid',
        'commit',
        '-qm',
        'second fixture',
      ]);
      const {stdout: sourceCommit} = await command('git', ['-C', repository, 'rev-parse', 'HEAD']);
      const coordinatorUrl = 'https://control.example.test';
      const publisherKeyFingerprint = sha256Digest('synthetic publisher');
      const profile = {
        ...defaultGraphShareProfile({
          branch: 'main',
          canonicalRemote: 'github.com/acme/signed-mcp-index',
          coordinatorUrl,
          organization: 'acme',
          publisherKeyFingerprint,
          repositoryId,
        }),
        registry: {
          canonical: 'oci://registry.example.test/acme/canonical',
          worker: 'oci://registry.example.test/acme/worker',
        },
      };
      const profileBytes = new TextEncoder().encode(canonicalJson(profile));
      const profileDigest = graphShareProfileDigest(profile);
      await writeFile(join(cas, 'sha256', sha256HexFromDigest(profileDigest)), profileBytes);
      await writeFile(
        join(home, 'graph-sharing', 'trust-receipts.json'),
        JSON.stringify({
          receipts: [
            {
              accessMode: 'join',
              client: {casRoot: cas, contributionMode: 'passive', coordinatorUrl},
              organization: 'acme',
              policyVersion: 1,
              profileDigest,
              publisherKeyFingerprint,
              registryCanonical: profile.registry.canonical,
              repositoryId,
            },
          ],
          schemaVersion: 1,
        }),
      );
      await writeFile(
        join(home, 'graph-sharing', 'control-credentials.json'),
        JSON.stringify({
          bindings: [
            {
              audience: 'https://control.example.test/',
              coordinatorUrl,
              helper: 'fixture',
              issuer: 'https://identity.example.test/',
              organization: 'acme',
            },
          ],
          schemaVersion: 1,
        }),
      );

      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [
          `--preload=${join(root, 'preload.js')}`,
          join(process.cwd(), 'apps/threadnote/src/standalone.ts'),
          'mcp-server',
        ],
        cwd: process.cwd(),
        stderr: 'pipe',
        env: {
          ...process.env,
          THREADNOTE_HOME: home,
          THREADNOTE_MANIFEST: join(home, 'seed-manifest.yaml'),
          THREADNOTE_ACCOUNT: 'local',
          THREADNOTE_USER: 'tester',
          THREADNOTE_TELEMETRY: '0',
          THREADNOTE_MCP_TOOLSET: 'cursor-cloud-local',
          THREADNOTE_TEST_GRAPH_SYNTHETIC_ORIGIN: `http://127.0.0.1:${coordinator.port}`,
          DOCKER_CONFIG: join(root, 'docker'),
          PATH: `${join(root, 'helpers')}:${process.env.PATH ?? ''}`,
        },
      });
      client = new Client({name: 'signed-mcp-index-fixture', version: '1'});
      await client.connect(transport);
      const result = await client.callTool({
        name: 'inspect_code_graph',
        arguments: {base: 'HEAD~1', callerCwd: repository, operation: 'impact', budgetTokens: 800},
      });
      expect(result.isError).not.toBe(true);

      const candidatePath = join(home, 'graph-sharing', 'signed-candidates', `${repositoryId}.json`);
      await waitFor(() => pendingResult !== undefined, 20_000);
      const candidates = await readJournalCandidates(candidatePath);
      const packageVersion = JSON.parse(await readFile(join(process.cwd(), 'package.json'), 'utf8')).version;
      const currentCandidate = EffectOption.getOrUndefined(
        EffectArray.findFirst(
          candidates,
          candidate => candidate.sourceCommit === Effect.pipe(sourceCommit, EffectString.trim),
        ),
      );
      expect(currentCandidate).toBeDefined();
      expect(currentCandidate).toMatchObject({
        casRoot: cas,
        organization: 'acme',
        partialCoverage: false,
        profileDigest,
        releaseIdentity: packageVersion,
        resourceLimits: [],
        sourceCommit: Effect.pipe(sourceCommit, EffectString.trim),
      });
      expect(currentCandidate!.graphAbi).toMatch(/^[0-9a-f]{64}$/u);
      expect(currentCandidate!.snapshotId).toMatch(/^cgsn_[0-9a-f]{40}/u);
      expect(enrolledWorker).toBeDefined();
      const announcementValue = requireRecord(pendingResult);
      const announcement = {
        algorithm: requireString(announcementValue.algorithm),
        body: requireStringRecord(announcementValue.body),
        publicKey: requireString(announcementValue.publicKey),
        signature: requireString(announcementValue.signature),
      };
      const deliveredCandidate = EffectOption.getOrUndefined(
        EffectArray.findFirst(candidates, candidate => candidate.actionKey === announcement.body.actionKey),
      );
      expect(deliveredCandidate).toBeDefined();
      const {idempotencyKey, ...announcementFields} = announcement.body;
      expect(announcement.algorithm).toBe('ed25519');
      expect(announcement.publicKey).toBe(enrolledWorker!.signingPublicKey);
      expect(idempotencyKey).toBe(
        sha256Digest('threadnote.graph.worker.result-operation.v1\0' + canonicalJson(announcementFields)),
      );
      expect(
        await verifySignature(announcement.publicKey, 'announcement', announcement.body, announcement.signature),
      ).toBe(true);
      expect(announcement.body).toMatchObject({
        actionKey: deliveredCandidate!.actionKey,
        batchId: Effect.pipe(String(deliveredCandidate!.sourceCommit), EffectString.slice(0, 40)),
        principalId: enrolledWorker!.principalId,
        profileDigest,
        repositoryId,
        semanticDigest: deliveredCandidate!.semanticDigest,
        workerId: enrolledWorker!.workerId,
      });
      const manifestBytes = registryManifests.get(announcement.body.resultManifestDigest);
      expect(manifestBytes).toBeDefined();
      expect(sha256Digest(manifestBytes!)).toBe(announcement.body.resultManifestDigest);
      const manifest = requireRecord(JSON.parse(new TextDecoder().decode(manifestBytes)));
      const config = requireDigestSize(manifest.config);
      const layers = requireDigestSizeArray(manifest.layers);
      expect(layers).toHaveLength(2);
      expect(layers[0]?.digest).toBe(deliveredCandidate!.resultDigest);
      expect(layers[1]?.digest).toBe(announcement.body.attestationDigest);
      for (const entry of [config, ...layers]) {
        const bytes = registryBlobs.get(entry.digest);
        expect(bytes).toBeDefined();
        expect(bytes!.byteLength).toBe(entry.size);
        expect(sha256Digest(bytes!)).toBe(entry.digest);
      }
      const resultLayer = layers[0];
      const attestationLayer = layers[1];
      if (!resultLayer || !attestationLayer) throw new Error('Expected result and attestation layers.');
      const resultBytes = registryBlobs.get(resultLayer.digest);
      if (!resultBytes) throw new Error('Expected result artifact bytes.');
      const resultArtifact = requireRecord(JSON.parse(new TextDecoder().decode(resultBytes)));
      expect(resultArtifact).toMatchObject({
        actionKey: deliveredCandidate!.actionKey,
        repositoryId,
        semanticDigest: deliveredCandidate!.semanticDigest,
      });
      const attestationBytes = registryBlobs.get(attestationLayer.digest);
      if (!attestationBytes) throw new Error('Expected attestation bytes.');
      const attestationValue = requireRecord(JSON.parse(new TextDecoder().decode(attestationBytes)));
      const attestation = {
        algorithm: requireString(attestationValue.algorithm),
        claims: requireRecord(attestationValue.claims),
        publicKey: requireString(attestationValue.publicKey),
        signature: requireString(attestationValue.signature),
      };
      expect(attestation.algorithm).toBe('ed25519');
      expect(attestation.publicKey).toBe(enrolledWorker!.signingPublicKey);
      expect(attestation.claims).toMatchObject({
        actionKey: deliveredCandidate!.actionKey,
        graphAbi: deliveredCandidate!.graphAbi,
        principalId: enrolledWorker!.principalId,
        profileDigest,
        resultDigest: deliveredCandidate!.resultDigest,
        resultSize: resultBytes.byteLength,
        repositoryId,
        semanticDigest: deliveredCandidate!.semanticDigest,
        sourceCommit: deliveredCandidate!.sourceCommit,
        workerId: enrolledWorker!.workerId,
      });
      expect(
        await verifySignature(attestation.publicKey, 'attestation', attestation.claims, attestation.signature),
      ).toBe(true);
      evidenceVerified = true;
      releaseResult();
      await waitFor(() => delivered, 20_000);
      expect(requests).toContain('POST /v1/enroll');
      expect(requests).toContain('POST /v1/results');
      await waitFor(
        async () =>
          !EffectArray.some(
            await readJournalCandidates(candidatePath),
            candidate => candidate.actionKey === deliveredCandidate!.actionKey,
          ),
        5_000,
      );
    } finally {
      releaseResult();
      await client?.close();
      await coordinator.stop(true);
      await rm(root, {recursive: true, force: true});
    }
  }, 60_000);
});

function requireRecord(value: unknown): Record<string, unknown> {
  if (!isJsonObject(value)) throw new Error('Expected a JSON object.');
  return value;
}

function requireString(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Expected a string value.');
  return value;
}

function requireStringRecord(value: unknown): Record<string, string> {
  const record = requireRecord(value);
  const output: Record<string, string> = {};
  for (const [key, entry] of EffectRecord.toEntries(record)) output[key] = requireString(entry);
  return output;
}

function requireDigestSize(value: unknown): {readonly digest: string; readonly size: number} {
  const record = requireRecord(value);
  if (typeof record.size !== 'number' || !Number.isFinite(record.size) || record.size < 0)
    throw new Error('Expected a nonnegative byte size.');
  return {digest: requireString(record.digest), size: record.size};
}

function requireDigestSizeArray(value: unknown): Array<{readonly digest: string; readonly size: number}> {
  if (!EffectArray.isArray(value)) throw new Error('Expected a manifest layer list.');
  return EffectArray.map(value, requireDigestSize);
}

async function readJournalCandidates(path: string): Promise<Array<Record<string, unknown>>> {
  const manifestText = await readFile(path, 'utf8');
  const manifest = JSON.parse(manifestText);
  const pages = await Promise.all(
    manifest.segments.map((segment: {id: string}) => readFile(join(`${path}.d`, `${segment.id}.json`), 'utf8')),
  );
  return EffectArray.flatMap(pages, page => JSON.parse(page).candidates);
}

async function waitFor(predicate: () => boolean | Promise<boolean>, milliseconds: number): Promise<void> {
  const until = Date.now() + milliseconds;
  while (Date.now() < until) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Timed out waiting for passive signed graph delivery.');
}

async function verifySignature(
  publicKey: string,
  domain: 'announcement' | 'attestation',
  body: unknown,
  signature: string,
) {
  const key = await crypto.subtle.importKey('raw', Buffer.from(publicKey, 'hex'), {name: 'Ed25519'}, false, ['verify']);
  const bytes = Buffer.concat([
    Buffer.from(`threadnote.graph.worker.${domain}.v1\0`),
    Buffer.from(canonicalJson(body)),
  ]);
  return crypto.subtle.verify('Ed25519', key, Buffer.from(signature, 'hex'), bytes);
}
