import {execFile} from '@threadnote/testing/node-child-process';
import {promisify} from '@threadnote/testing/node-util';
import {graphShareContributionFixture} from '../helpers/graph-share-contribution.js';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {describe, expect, it} from 'vitest';
import {mkdir, mkdtemp, readFile, rm, unlink, writeFile} from '@threadnote/testing/node-fs-promises';
import {tmpdir} from '@threadnote/testing/node-os';
import {join} from '@threadnote/testing/node-path';
import {canonicalJson} from '@threadnote/graph/checkpoint/canonical_json';
import {sha256Digest, sha256HexFromDigest} from '@threadnote/graph/sharing/digest';
import {defaultGraphShareProfile, graphShareProfileDigest} from '@threadnote/graph/sharing/profile';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';
import {Array as EffectArray} from 'effect';

describe('MCP-owned passive graph contribution retries', () => {
  it.each(['persisted queue', 'strict graph impact', 'dirty graph then clean restart'] as const)(
    'recovers automatically after an outage from %s',
    async source => {
      const root = await mkdtemp(join(tmpdir(), 'threadnote-mcp-contribution-retry-'));
      const home = join(root, 'home');
      const cas = join(root, 'cas');
      const repository = join(root, 'repository');
      const repositoryId = sha256HexFromDigest(sha256Digest('repository-v1\ngithub.com/acme/automatic-contribution'));
      const command = promisify(execFile);
      let healthy = false;
      let refusedRequests = 0;
      let deliveredRequests = 0;
      let refused!: () => void;
      let delivered!: () => void;
      const firstRefusal = new Promise<void>(resolve => {
        refused = resolve;
      });
      const firstDelivery = new Promise<void>(resolve => {
        delivered = resolve;
      });
      const server = Bun.serve({
        hostname: '127.0.0.1',
        port: 0,
        fetch: async request => {
          await request.arrayBuffer();
          if (request.method === 'GET')
            return Response.json({
              generation: 1,
              organization: 'acme',
              phase: 'idle',
              publishedFrontier: null,
              repositoryId,
              receipts: [],
            });
          if (!healthy) {
            refusedRequests += 1;
            refused();
            return Response.json({}, {status: 503, headers: {'Retry-After': '1'}});
          }
          if (new URL(request.url).pathname === '/v1/results') {
            deliveredRequests += 1;
            delivered();
          }
          return Response.json({});
        },
      });
      let client: Client | undefined;
      try {
        await mkdir(join(home, 'graph-sharing', 'contribution'), {recursive: true});
        await mkdir(join(cas, 'sha256'), {recursive: true});
        const publisherKeyFingerprint = sha256Digest('publisher');
        const coordinatorUrl = `http://127.0.0.1:${server.port}`;
        const profile = defaultGraphShareProfile({
          branch: 'main',
          canonicalRemote: 'github.com/acme/automatic-contribution',
          coordinatorUrl,
          organization: 'acme',
          publisherKeyFingerprint,
          repositoryId,
        });
        const profileDigest = graphShareProfileDigest(profile);
        await writeFile(join(cas, 'sha256', sha256HexFromDigest(profileDigest)), canonicalJson(profile));
        await writeFile(join(home, 'seed-manifest.yaml'), 'version: 1\nprojects: []\n');
        if (source !== 'persisted queue') {
          await mkdir(join(repository, 'src'), {recursive: true});
          await writeFile(
            join(repository, 'src', 'index.ts'),
            'export function automaticContributionTarget() { return 42; }\n',
          );
          await command('git', ['init', '-q', '--initial-branch=main', repository]);
          await command('git', [
            '-C',
            repository,
            'remote',
            'add',
            'origin',
            'https://github.com/acme/automatic-contribution.git',
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
          if (source === 'dirty graph then clean restart') {
            await writeFile(
              join(repository, 'src', 'index.ts'),
              'export function automaticContributionTarget() { return 43; }\n',
            );
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
            await writeFile(join(repository, 'untracked.txt'), 'dirty first attempt\n');
          } else {
            await writeFile(
              join(repository, 'src', 'after.ts'),
              'export function automaticContributionAfterTarget() { return 43; }\n',
            );
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
          }
        }
        const {announcement, resultBytes, attestationBytes} = graphShareContributionFixture(repositoryId);
        const {resultManifestDigest, attestationDigest} = announcement;
        await writeFile(join(cas, 'sha256', sha256HexFromDigest(resultManifestDigest)), resultBytes);
        await writeFile(join(cas, 'sha256', sha256HexFromDigest(attestationDigest)), attestationBytes);
        await writeFile(
          join(home, 'graph-sharing', 'trust-receipts.json'),
          JSON.stringify({
            schemaVersion: 1,
            receipts: [
              {
                accessMode: 'join',
                organization: 'acme',
                policyVersion: 1,
                profileDigest,
                publisherKeyFingerprint,
                registryCanonical: 'cas://local',
                repositoryId,
                client: {casRoot: cas, contributionMode: 'passive', coordinatorUrl},
              },
            ],
          }),
        );
        const queuePath = join(home, 'graph-sharing', 'contribution', `${repositoryId}.json`);
        if (source === 'persisted queue')
          await writeFile(
            queuePath,
            JSON.stringify({
              schemaVersion: 1,
              mode: 'passive',
              announcements: [announcement],
            }),
          );
        const startClient = async () => {
          const transport = new StdioClientTransport({
            command: process.execPath,
            args: [join(process.cwd(), 'apps/threadnote/src/standalone.ts'), 'mcp-server'],
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
            },
          });
          client = new Client({name: 'contribution-retry-fixture', version: '1'});
          await client.connect(transport);
        };
        const inspect = async (operation: 'query' | 'impact' = 'query') => {
          const result = await client!.callTool({
            name: 'inspect_code_graph',
            arguments: {
              callerCwd: repository,
              operation,
              ...(operation === 'query' ? {query: 'automaticContributionTarget'} : {base: 'HEAD~1'}),
              budgetTokens: 800,
            },
          });
          expect(result.isError).not.toBe(true);
        };
        await startClient();
        if (source !== 'persisted queue') {
          await inspect('impact');
        }
        await within(firstRefusal, 20_000);
        expect(refusedRequests).toBe(1);
        expect(JSON.parse(await readFile(queuePath, 'utf8')).announcements.length).toBeGreaterThan(0);
        if (source !== 'persisted queue') {
          const pendingPath = join(home, 'graph-sharing', 'signed-pending', `${repositoryId}.json`);
          let pendingCandidates = await readJournalCandidates(pendingPath);
          if (source === 'dirty graph then clean restart') {
            expect(pendingCandidates.length).toBeGreaterThan(0);
            await unlink(join(repository, 'untracked.txt'));
            await client?.close();
            await startClient();
            await inspect('impact');
          }
          for (let attempt = 0; attempt < 80; attempt++) {
            pendingCandidates = await readJournalCandidates(pendingPath);
            if (pendingCandidates.length === 0) break;
            await new Promise(resolve => setTimeout(resolve, 250));
          }
          expect(pendingCandidates).toHaveLength(0);
          const candidatePath = join(home, 'graph-sharing', 'signed-candidates', `${repositoryId}.json`);
          const candidates = await readJournalCandidates(candidatePath);
          const {stdout: sourceCommit} = await command('git', ['-C', repository, 'rev-parse', 'HEAD']);
          const packageVersion = JSON.parse(await readFile(join(process.cwd(), 'package.json'), 'utf8')).version;
          const currentCandidates = EffectArray.filter(
            candidates,
            candidate => candidate.sourceCommit === Effect.pipe(sourceCommit, EffectString.trim),
          );
          expect(currentCandidates.length).toBeGreaterThan(0);
          for (const candidate of currentCandidates) {
            expect(candidate).toMatchObject({
              casRoot: cas,
              partialCoverage: false,
              releaseIdentity: packageVersion,
              resourceLimits: [],
              sourceCommit: Effect.pipe(sourceCommit, EffectString.trim),
            });
            expect(candidate.graphAbi).toMatch(/^[0-9a-f]{64}$/u);
          }
        }
        healthy = true;
        await within(firstDelivery, 20_000);
        expect(deliveredRequests).toBeGreaterThan(0);
      } finally {
        await client?.close();
        await server.stop(true);
        await rm(root, {recursive: true, force: true});
      }
    },
    60_000,
  );
});

async function readJournalCandidates(manifestPath: string): Promise<Array<Record<string, unknown>>> {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const pages = await Promise.all(
    manifest.segments.map((segment: {id: string}) => readFile(join(`${manifestPath}.d`, `${segment.id}.json`), 'utf8')),
  );
  return EffectArray.flatMap(pages, page => JSON.parse(page).candidates);
}

async function within<A>(promise: Promise<A>, milliseconds: number): Promise<A> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('Timed out waiting for automatic contribution progress.')),
          milliseconds,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
