import {Array as EffectArray} from 'effect';
import {execFile} from '@threadnote/testing/node-child-process';
import {mkdir, mkdtemp, readFile, rm, writeFile} from '@threadnote/testing/node-fs-promises';
import {tmpdir} from '@threadnote/testing/node-os';
import {dirname, join} from '@threadnote/testing/node-path';
import {promisify} from '@threadnote/testing/node-util';
import {parseMemoryDocument} from '@threadnote/memory/hygiene';
import {expect, it} from 'vitest';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

const execute = promisify(execFile);
const standalone = join(process.cwd(), 'apps', 'threadnote', 'src', 'standalone.ts');

function parseContentionGraphStatus(stdout: string) {
  const value: unknown = JSON.parse(stdout);
  if (
    typeof value !== 'object' ||
    value === null ||
    EffectArray.isArray(value) ||
    !('identity' in value) ||
    typeof value.identity !== 'object' ||
    value.identity === null ||
    EffectArray.isArray(value.identity) ||
    !('checkoutId' in value.identity) ||
    typeof value.identity.checkoutId !== 'string' ||
    !('readySnapshot' in value) ||
    typeof value.readySnapshot !== 'object' ||
    value.readySnapshot === null ||
    EffectArray.isArray(value.readySnapshot) ||
    !('id' in value.readySnapshot) ||
    typeof value.readySnapshot.id !== 'string'
  ) {
    throw new Error('Code graph status JSON had an invalid contention fixture shape.');
  }
  return {identity: {checkoutId: value.identity.checkoutId}, readySnapshot: {id: value.readySnapshot.id}};
}

it('captures strict and deferred references promptly while an unrelated graph writer is held', async () => {
  const root = await mkdtemp(join(tmpdir(), 'threadnote-citation-contention-'));
  const repository = join(root, 'repository');
  const home = join(root, 'home');
  const environment = {...process.env, THREADNOTE_HOME: home, THREADNOTE_USER: 'local', NO_COLOR: '1'};
  const run = (args: readonly string[], timeout = 30_000) =>
    execute(process.execPath, [standalone, ...args], {
      cwd: repository,
      env: environment,
      timeout,
      killSignal: 'SIGKILL',
    });
  try {
    await mkdir(repository);
    await writeFile(join(repository, 'source.ts'), 'export const value = 1;\n');
    await execute('git', ['init', '--quiet'], {cwd: repository});
    await execute('git', ['add', '.'], {cwd: repository});
    await execute(
      'git',
      ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture'],
      {
        cwd: repository,
      },
    );
    await run(['graph', 'index', '--no-vectors', '--json']);
    const status = parseContentionGraphStatus((await run(['graph', 'status', '--json'])).stdout);
    const lock = join(home, 'locks', 'indexes', 'code-graph', 'database-writes', `${status.identity.checkoutId}.lock`);
    await mkdir(dirname(lock), {recursive: true});
    // A live fixture-owned writer; no normal user home or runtime is involved.
    const owner = JSON.stringify({version: 1, processId: process.pid, token: 'fixture-writer'});
    await writeFile(lock, owner);
    const args = [
      'remember',
      '--project',
      'repository',
      '--topic',
      'contention',
      '--keyword',
      'fixture',
      '--code-ref',
      'source.ts',
      '--require-current-code-refs',
      '--text',
      'Keep the source invariant.',
    ];
    const memory = join(
      home,
      'data',
      'local',
      'user',
      'local',
      'memories',
      'durable',
      'projects',
      'repository',
      'contention.md',
    );

    await run([...args, '--dry-run'], 10_000);
    await expect(readFile(memory, 'utf8')).rejects.toThrow();
    expect(await readFile(lock, 'utf8')).toBe(owner);

    const assertStoredCitation = async (stdout: string, filename: string) => {
      expect(stdout).toContain('Stored memory:');
      expect(stdout).not.toContain('threadnote graph index');
      const uri = Effect.pipe(
        stdout,
        EffectString.match(/Stored memory: (threadnote:\/\/\S+)/u),
        Effect.Option.getOrElse(() => null),
      )?.[1];
      expect(uri).toBeDefined();
      const content = await readFile(filename, 'utf8');
      expect(content).toContain('Keep the source invariant.');
      expect(uri && parseMemoryDocument(uri, content)?.metadata.codeCitations).toEqual([
        expect.objectContaining({path: 'source.ts', target: {kind: 'file'}, sourceSnapshotId: status.readySnapshot.id}),
      ]);
    };
    await assertStoredCitation((await run(args, 10_000)).stdout, memory);
    expect(await readFile(lock, 'utf8')).toBe(owner);

    for (const [topic, deferArgs] of [
      ['default', []],
      ['explicit', ['--defer-code-refs']],
    ] as const) {
      const deferredArgs = EffectArray.map(
        EffectArray.filter(args, argument => argument !== '--require-current-code-refs'),
        argument => (argument === 'contention' ? `contention-${topic}` : argument),
      );
      const filename = join(dirname(memory), `contention-${topic}.md`);
      await run([...deferredArgs, ...deferArgs, '--dry-run'], 10_000);
      await expect(readFile(filename, 'utf8')).rejects.toThrow();
      await assertStoredCitation((await run([...deferredArgs, ...deferArgs], 10_000)).stdout, filename);
      expect(await readFile(lock, 'utf8')).toBe(owner);
    }
    const after = parseContentionGraphStatus((await run(['graph', 'status', '--json'])).stdout);
    expect(after.readySnapshot.id).toBe(status.readySnapshot.id);
    await rm(lock);
    const afterArgs = EffectArray.map(args, argument => (argument === 'contention' ? 'contention-after' : argument));
    await assertStoredCitation((await run(afterArgs, 10_000)).stdout, join(dirname(memory), 'contention-after.md'));
  } finally {
    await rm(root, {recursive: true, force: true});
  }
}, 60_000);
