import {Array as EffectArray} from 'effect';
import {spawn} from '@threadnote/testing/node-child-process';
import {createServer} from '@threadnote/testing/node-net';
import {mkdir, mkdtemp, rm, writeFile} from '@threadnote/testing/node-fs-promises';
import {tmpdir} from '@threadnote/testing/node-os';
import {join} from '@threadnote/testing/node-path';
import {promisify} from '@threadnote/testing/node-util';
import {execFile} from '@threadnote/testing/node-child-process';
import {describe, expect, it} from 'vitest';
import {sha256HexFromDigest, sha256Digest} from '@threadnote/graph/sharing/digest';
import * as EffectString from 'effect/String';
import {Schema} from 'effect';
import * as Effect from 'effect';
import {Option as EffectOption} from 'effect';

const execFilePromise = promisify(execFile);
const initializedSchema = Schema.Struct({profileDigest: Schema.String, written: Schema.Boolean});
const snapshotIdSchema = Schema.Struct({snapshot: Schema.Struct({id: Schema.String})});
const contributionStatusSchema = Schema.Struct({mode: Schema.String});
const coordinatorStatusSchema = Schema.Struct({
  receipts: Schema.Array(Schema.Struct({resultManifestDigest: Schema.String})),
});
const sharedQuerySchema = Schema.Struct({
  nodes: Schema.Array(Schema.Struct({name: Schema.String})),
  source: Schema.optional(Schema.Struct({kind: Schema.String, profileDigest: Schema.String})),
});
const localOverlaySourceSchema = Schema.Struct({source: Schema.optional(Schema.Struct({kind: Schema.String}))});
const publisherReadySchema = Schema.Struct({
  coordinatorUrl: Schema.String,
  generation: Schema.Finite,
  listening: Schema.Boolean,
});

function parseJson<S extends Schema.ConstraintDecoder<unknown>>(schema: S, content: string): S['Type'] {
  return Schema.decodeUnknownSync(schema)(JSON.parse(content));
}

describe('code graph sharing multi-contributor HTTP', () => {
  it('lets two homes build a remote graph over the coordinator and a third home use it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'threadnote-graph-share-http-e2e-'));
    const repository = join(root, 'repository');
    const publisherHome = join(root, 'publisher-home');
    const contributorAHome = join(root, 'contributor-a');
    const contributorBHome = join(root, 'contributor-b');
    const consumerHome = join(root, 'consumer-home');
    const localHome = join(root, 'local-home');
    let listener: ReturnType<typeof spawn> | undefined;
    try {
      await mkdir(join(repository, 'src'), {recursive: true});
      await writeFile(join(repository, 'package.json'), '{"name":"graph-share-http","private":true,"type":"module"}\n');
      await writeFile(join(repository, 'src', 'index.ts'), 'export const shared = 1;\n');
      await git(repository, ['init', '-q', '--initial-branch=main']);
      await git(repository, ['remote', 'add', 'origin', 'https://github.com/acme/graph-share-http.git']);
      await git(repository, ['add', '.']);
      await commit(repository, 'base');

      const port = await reservedPort();
      const coordinator = `http://127.0.0.1:${port}`;
      await runCli(['graph', 'index', '--home', publisherHome, '--cwd', repository, '--json']);
      const initialized = parseJson(
        initializedSchema,
        (
          await runCli([
            'graph',
            'share',
            'init',
            '--home',
            publisherHome,
            '--cwd',
            repository,
            '--organization',
            'acme',
            '--coordinator',
            coordinator,
            '--write-config',
            '--json',
          ])
        ).stdout,
      );
      expect(initialized.written).toBe(true);
      await git(repository, ['add', '.threadnote/graph-share.json']);
      await commit(repository, 'enroll graph sharing');
      await runCli(['graph', 'index', '--full', '--home', publisherHome, '--cwd', repository, '--json']);
      await runCli(['graph', 'publisher', 'bootstrap', '--home', publisherHome, '--cwd', repository, '--json']);

      listener = spawn(
        process.execPath,
        [
          'apps/threadnote/src/standalone.ts',
          'graph',
          'publisher',
          'serve',
          '--home',
          publisherHome,
          '--cwd',
          repository,
          '--listen',
          `127.0.0.1:${port}`,
          '--json',
        ],
        {
          cwd: process.cwd(),
          env: {...process.env, NO_COLOR: '1', THREADNOTE_TELEMETRY: '0'},
        },
      );
      const served = await waitForJson(listener);
      expect(served.listening).toBe(true);
      expect(served.coordinatorUrl).toBe(coordinator);
      expect(served.generation).toBe(1);

      await runCli([
        'graph',
        'share',
        'join',
        '--home',
        contributorAHome,
        '--cwd',
        repository,
        '--coordinator',
        coordinator,
        '--json',
      ]);
      const contributed = parseJson(
        snapshotIdSchema,
        (await runCli(['graph', 'index', '--home', contributorAHome, '--cwd', repository, '--json'])).stdout,
      );
      expect(contributed.snapshot.id).toMatch(/^cgsn_/);
      const contributeStatus = parseJson(
        contributionStatusSchema,
        (await runCli(['graph', 'contribute', 'status', '--home', contributorAHome, '--cwd', repository, '--json']))
          .stdout,
      );
      expect(contributeStatus.mode).toBe('passive');
      const afterA = Schema.decodeUnknownSync(coordinatorStatusSchema)(
        await (await fetch(`${coordinator}/v1/status`)).json(),
      );
      expect(afterA.receipts.length).toBeGreaterThan(0);

      await runCli([
        'graph',
        'share',
        'join',
        '--home',
        contributorBHome,
        '--cwd',
        repository,
        '--coordinator',
        coordinator,
        '--json',
      ]);
      await runCli(['graph', 'index', '--home', contributorBHome, '--cwd', repository, '--json']);

      await runCli([
        'graph',
        'share',
        'join',
        '--home',
        consumerHome,
        '--cwd',
        repository,
        '--coordinator',
        coordinator,
        '--read-only',
        '--json',
      ]);
      await runCli(['graph', 'index', '--home', consumerHome, '--cwd', repository, '--json']);
      const queried = parseJson(
        sharedQuerySchema,
        (await runCli(['graph', 'query', '--home', consumerHome, '--cwd', repository, '--query', 'shared', '--json']))
          .stdout,
      );
      expect(queried.source).toMatchObject({
        kind: 'shared-base-plus-local-overlay',
        profileDigest: initialized.profileDigest,
      });
      expect(EffectArray.some(queried.nodes, node => node.name === 'shared')).toBe(true);

      const gitBlob = Buffer.from('blob 4\0test');
      const treeResponse = await fetch(`${coordinator}/v1/cas/sha256/${sha256HexFromDigest(sha256Digest(gitBlob))}`, {
        method: 'PUT',
        body: gitBlob,
      });
      expect(treeResponse.status).toBe(400);
      const missing = await fetch(`${coordinator}/v1/cas/sha256/${Effect.pipe('0', EffectString.repeat(64))}`);
      expect(missing.status).toBe(404);

      listener.kill('SIGTERM');
      listener = undefined;

      const afterDown = parseJson(
        localOverlaySourceSchema,
        (await runCli(['graph', 'query', '--home', consumerHome, '--cwd', repository, '--query', 'shared', '--json']))
          .stdout,
      );
      expect(afterDown.source?.kind).toBe('shared-base-plus-local-overlay');

      const unenrolled = join(root, 'unenrolled');
      await mkdir(join(unenrolled, 'src'), {recursive: true});
      await writeFile(join(unenrolled, 'package.json'), '{"name":"local-only","private":true,"type":"module"}\n');
      await writeFile(join(unenrolled, 'src', 'index.ts'), 'export const localOnly = 1;\n');
      await git(unenrolled, ['init', '-q', '--initial-branch=main']);
      await git(unenrolled, ['remote', 'add', 'origin', 'https://github.com/acme/local-only.git']);
      await git(unenrolled, ['add', '.']);
      await commit(unenrolled, 'local');
      const localIndex = parseJson(
        snapshotIdSchema,
        (await runCli(['graph', 'index', '--home', localHome, '--cwd', unenrolled, '--json'])).stdout,
      );
      expect(localIndex.snapshot.id).toMatch(/^cgsn_/);
    } finally {
      listener?.kill('SIGTERM');
      await rm(root, {force: true, recursive: true});
    }
  }, 180_000);
});

function reservedPort(): Promise<number> {
  // The plain async test awaits this OS net.Server listen/close callback boundary.

  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      server.close(error => (error ? reject(error) : resolve(port)));
    });
    server.on('error', reject);
  });
}

function waitForJson(child: ReturnType<typeof spawn>): Promise<typeof publisherReadySchema.Type> {
  // The plain async test awaits child stdout/error/exit events and its watchdog timer.

  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      reject(new Error(`publisher serve did not print JSON\n${stdout}\n${stderr}`));
    }, 120_000);
    child.stdout?.on('data', chunk => {
      stdout += String(chunk);
      const line = EffectOption.getOrUndefined(
        EffectArray.findFirst(
          EffectArray.map(Effect.pipe(stdout, EffectString.split('\n')), value =>
            Effect.pipe(value, EffectString.trim),
          ),
          __effectArrayValue =>
            !!(value =>
              Effect.pipe(value, EffectString.startsWith('{')) &&
              Effect.pipe(value, EffectString.includes('coordinatorUrl')))(__effectArrayValue),
        ),
      );
      if (line === undefined) return;
      try {
        clearTimeout(timer);
        resolve(parseJson(publisherReadySchema, line));
      } catch (cause) {
        clearTimeout(timer);
        reject(cause);
      }
    });
    child.stderr?.on('data', chunk => {
      stderr += String(chunk);
    });
    child.on('exit', code => {
      if (code !== 0 && code !== null) {
        clearTimeout(timer);
        reject(new Error(`publisher serve exited ${code}\n${stdout}\n${stderr}`));
      }
    });
  });
}

async function git(cwd: string, args: readonly string[]): Promise<void> {
  await execFilePromise('git', ['-C', cwd, ...args]);
}

async function commit(cwd: string, message: string): Promise<void> {
  await git(cwd, [
    '-c',
    'user.name=Threadnote Test',
    '-c',
    'user.email=test@threadnote.local',
    'commit',
    '-qm',
    message,
  ]);
}

function runCli(args: readonly string[]) {
  return execFilePromise(process.execPath, ['apps/threadnote/src/standalone.ts', ...args], {
    cwd: process.cwd(),
    env: {...process.env, NO_COLOR: '1', THREADNOTE_TELEMETRY: '0'},
  });
}
