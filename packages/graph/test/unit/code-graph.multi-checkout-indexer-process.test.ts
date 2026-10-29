import {Array as EffectArray} from 'effect';
import {afterEach, describe, expect, it} from 'vitest';
import {mkdtemp, mkdir, readFile, rm, writeFile} from '@threadnote/testing/node-fs-promises';
import {tmpdir} from '@threadnote/testing/node-os';
import {join} from '@threadnote/testing/node-path';

describe('multi-checkout indexer process coordination', () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(EffectArray.map(roots.splice(0), root => rm(root, {force: true, recursive: true})));
  });

  it('prepares two checkouts concurrently and publishes the same snapshots as serial builds', async () => {
    const root = await mkdtemp(join(tmpdir(), 'threadnote-multi-checkout-indexer-'));
    roots.push(root);
    const concurrentHome = join(root, 'concurrent-home');
    const serialHome = join(root, 'serial-home');
    const start = join(root, 'start');
    const repositories = [join(root, 'repository-a'), join(root, 'repository-b')];
    await Promise.all(EffectArray.map(repositories, (repository, index) => createRepository(repository, index)));

    const concurrent = EffectArray.map(repositories, (repository, index) =>
      spawnIndexer({
        cwd: repository,
        home: concurrentHome,
        marker: join(root, `concurrent-${index}.preparing`),
        otherMarker: join(root, `concurrent-${1 - index}.preparing`),
        output: join(root, `concurrent-${index}.json`),
        start,
      }),
    );
    await Promise.all(EffectArray.map(concurrent, child => child.ready));
    await writeFile(start, '');
    try {
      await waitFor(
        async () =>
          EffectArray.every(
            await Promise.all(
              EffectArray.map([0, 1], index => fileExists(join(root, `concurrent-${index}.preparing`))),
            ),
            Boolean,
          ),
        30_000,
      );
      await Promise.all(EffectArray.map(concurrent, child => child.completed));
    } finally {
      for (const child of concurrent) if (child.process.exitCode === null) child.process.kill('SIGKILL');
    }

    const serialOutputs: string[] = [];
    for (let index = 0; index < repositories.length; index += 1) {
      const output = join(root, `serial-${index}.json`);
      const child = spawnIndexer({cwd: repositories[index], home: serialHome, output});
      await child.completed;
      serialOutputs.push(output);
    }

    const concurrentSummaries = await Promise.all(
      EffectArray.map([0, 1], index => readSummary(join(root, `concurrent-${index}.json`))),
    );
    const serialSummaries = await Promise.all(EffectArray.map(serialOutputs, readSummary));
    expect(concurrentSummaries).toEqual(serialSummaries);
    expect(EffectArray.every(concurrentSummaries, summary => summary.state === 'ready')).toBe(true);
  }, 120_000);
});

interface IndexerProcessOptions {
  readonly cwd: string;
  readonly home: string;
  readonly marker?: string;
  readonly otherMarker?: string;
  readonly output: string;
  readonly start?: string;
}

function spawnIndexer(options: IndexerProcessOptions): {
  readonly completed: Promise<void>;
  readonly process: ReturnType<typeof Bun.spawn>;
  readonly ready: Promise<void>;
} {
  const indexerUrl = new URL('../../src/indexer.ts', import.meta.url).href;
  const runtimeUrl = new URL('../../../../apps/threadnote/src/effect/runtime.ts', import.meta.url).href;
  const readyPath = `${options.output}.ready`;
  const child = Bun.spawn({
    cmd: [
      process.execPath,
      '--eval',
      `
        import {Effect, FileSystem} from 'effect';
        import * as BunRuntime from '@effect/platform-bun/BunRuntime';
        import {CodeGraphIndexer} from ${JSON.stringify(indexerUrl)};
        import {ApplicationLayer} from ${JSON.stringify(runtimeUrl)};
        let paused = false;
        BunRuntime.runMain(Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          yield* fs.makeDirectory(${JSON.stringify(options.home)}, {recursive: true});
          yield* fs.writeFileString(${JSON.stringify(readyPath)}, '');
          ${options.start ? `while (!(yield* fs.exists(${JSON.stringify(options.start)}))) yield* Effect.sleep(10);` : ''}
          const indexer = yield* CodeGraphIndexer;
          const summary = yield* indexer.index({
            cwd: ${JSON.stringify(options.cwd)},
            ensureVectors: false,
            threadnoteHome: ${JSON.stringify(options.home)},
            onProgress: progress => {
              if (
                paused ||
                ${options.marker === undefined || options.otherMarker === undefined} ||
                progress.phase !== 'materializing' ||
                progress.activity?.stage !== 'committing'
              ) return Effect.void;
              paused = true;
              return Effect.gen(function* () {
                yield* fs.writeFileString(${JSON.stringify(options.marker ?? '')}, '');
                while (!(yield* fs.exists(${JSON.stringify(options.otherMarker ?? '')}))) yield* Effect.sleep(10);
              });
            },
          });
          yield* fs.writeFileString(${JSON.stringify(options.output)}, JSON.stringify({
            edgeCount: summary.snapshot.edgeCount,
            fileCount: summary.snapshot.fileCount,
            id: summary.snapshot.id,
            state: summary.snapshot.state,
            symbolCount: summary.snapshot.symbolCount,
          }));
        }).pipe(Effect.provide(ApplicationLayer)));
      `,
    ],
    stderr: 'pipe',
    stdout: 'pipe',
  });
  return {
    completed: child.exited.then(async exitCode => {
      if (exitCode === 0) return;
      const stderr = await new Response(child.stderr).text();
      const stdout = await new Response(child.stdout).text();
      throw new Error(`Indexer child exited ${exitCode}: ${stderr || stdout}`);
    }),
    process: child,
    ready: waitFor(() => fileExists(readyPath), 30_000),
  };
}

async function createRepository(repository: string, index: number): Promise<void> {
  await mkdir(join(repository, 'src'), {recursive: true});
  await Promise.all(
    Array.from({length: 80}, (_, fileIndex) =>
      writeFile(
        join(repository, 'src', `module-${fileIndex}.ts`),
        `export function value${index}_${fileIndex}(input: number) { return input + ${fileIndex}; }\n`,
      ),
    ),
  );
  runGit(repository, ['init', '--quiet']);
  runGit(repository, ['config', 'user.email', 'test@example.invalid']);
  runGit(repository, ['config', 'user.name', 'Threadnote Test']);
  runGit(repository, ['add', '.']);
  runGit(repository, ['commit', '--quiet', '-m', 'fixture']);
}

function runGit(cwd: string, args: readonly string[]): void {
  const result = Bun.spawnSync({cmd: ['git', ...args], cwd, stderr: 'pipe', stdout: 'pipe'});
  if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
}

async function readSummary(file: string): Promise<{
  readonly edgeCount: number;
  readonly fileCount: number;
  readonly id: string;
  readonly state: string;
  readonly symbolCount: number;
}> {
  return JSON.parse(await readFile(file, 'utf8'));
}

async function fileExists(file: string): Promise<boolean> {
  return Bun.file(file).exists();
}

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMilliseconds: number): Promise<void> {
  const deadline = Date.now() + timeoutMilliseconds;
  while (!(await check())) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for indexer process coordination.');
    await Bun.sleep(10);
  }
}
