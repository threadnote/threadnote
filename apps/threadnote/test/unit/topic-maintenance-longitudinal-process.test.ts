import {tmpdir} from '@threadnote/testing/node-os';
import {join} from '@threadnote/testing/node-path';
import {
  captureTopicStudyRuntime,
  assertTopicStudyRuntime,
  prepareTopicStudyModel,
  assertTopicStudyModel,
  topicStudyFileHash,
  topicStudyDependencyHash,
  topicStudySourceTreeHash,
  topicStudyExpectedSourceTreeHash,
} from '../../../../scripts/topic-maintenance-longitudinal-runtime.js';
import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {mkdtemp, mkdir, readFile, rm, writeFile, chmod, stat} from '@threadnote/testing/node-fs-promises';
import {
  parseTopicStudyCorpusJsonV1,
  topicStudyCorpusHashV1,
  topicStudyLedgerRowV1,
  topicStudyUnavailableObservationV1,
} from '@threadnote/threadnote/evaluation/topic-maintenance-longitudinal';
import {
  readBoundedChildOutput,
  topicStudyEnvironment,
  withTopicStudyTimeline,
} from '../../../../scripts/topic-maintenance-longitudinal-process.js';

function stream(chunks: readonly Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

it('refuses model execution during replay and rejects a mismatched manifest without rewriting raw observations', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'topic-study-replay-'));
  try {
    const corpus = parseTopicStudyCorpusJsonV1(
      await readFile('apps/threadnote/test/evaluation/fixtures/topic-maintenance-v1/sequence.json', 'utf8'),
    );
    const event = corpus.events[0];
    const row = topicStudyLedgerRowV1({
      corpusHash: topicStudyCorpusHashV1(corpus),
      runNonce: 'offline-replay',
      arm: 'maintained-local',
      repetition: 1,
      eventIndex: 1,
      eventId: event.id,
      previousHash: null,
      observation: topicStudyUnavailableObservationV1(event, 'fixture'),
    });
    const ledgerPath = join(directory, 'outcomes.jsonl');
    const ledger = JSON.stringify(row) + '\n';
    await writeFile(ledgerPath, ledger);
    await writeFile(join(directory, 'summary.json'), JSON.stringify({executionStatus: 'aborted-invalid-harness'}));
    const manifestPath = join(directory, 'maintained-local-1-manifest.json');
    const manifest = JSON.stringify({
      version: 1,
      arm: row.arm,
      repetition: 1,
      runNonce: row.runNonce,
      corpusHash: 'wrong',
    });
    await writeFile(manifestPath, manifest);
    for (const execute of [true, false]) {
      const result = Bun.spawnSync(
        [
          process.execPath,
          'scripts/run-topic-maintenance-longitudinal.ts',
          '--replay',
          directory,
          ...(execute ? ['--execute'] : []),
        ],
        {env: topicStudyEnvironment(process.env), stdout: 'pipe', stderr: 'pipe'},
      );
      expect(result.exitCode).not.toBe(0);
      expect(new TextDecoder().decode(result.stderr)).toContain(
        execute ? '--replay cannot execute models' : 'Replay manifest does not match the sealed execution',
      );
      expect(await readFile(ledgerPath, 'utf8')).toBe(ledger);
      expect(await readFile(manifestPath, 'utf8')).toBe(manifest);
    }
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});

describe('bounded longitudinal process capture', () => {
  it('accepts any chunk partition up to the byte ceiling', async () => {
    await fc.assert(
      fc.asyncProperty(fc.uint8Array({maxLength: 1024}), fc.integer({min: 1, max: 100}), async (bytes, size) => {
        const chunks: Uint8Array[] = [];
        for (let offset = 0; offset < bytes.length; offset += size) chunks.push(bytes.subarray(offset, offset + size));
        let terminated = false;
        const result = await readBoundedChildOutput(stream(chunks), bytes.length, () => {
          terminated = true;
        });
        expect(result).toBe(new TextDecoder().decode(bytes));
        expect(terminated).toBe(false);
      }),
      {numRuns: 100},
    );
  });

  it('terminates as soon as a chunk crosses the cap', async () => {
    let terminated = false;
    await expect(
      readBoundedChildOutput(stream([new Uint8Array(5), new Uint8Array(6), new Uint8Array(1000)]), 10, () => {
        terminated = true;
      }),
    ).rejects.toThrow('bounded capture');
    expect(terminated).toBe(true);
  });
});

it('never propagates Git index/repository/config/hook controls', () => {
  const env = topicStudyEnvironment({
    PATH: '/usr/bin:/bin',
    GIT_DIR: '/external/.git',
    GIT_WORK_TREE: '/external',
    GIT_INDEX_FILE: '/external/index',
    GIT_CONFIG_PARAMETERS: 'unsafe',
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'core.hooksPath',
    GIT_CONFIG_VALUE_0: '/external/hooks',
    GIT_OBJECT_DIRECTORY: '/external/objects',
  });
  expect(env.GIT_DIR).toBeUndefined();
  expect(env.GIT_INDEX_FILE).toBeUndefined();
  expect(env.GIT_CONFIG_PARAMETERS).toBeUndefined();
  expect(env.GIT_CONFIG_GLOBAL).toBe('/dev/null');
  expect(env.GIT_CONFIG_VALUE_0).toBe('/dev/null');
});

it('executes post-review transitions in all arms even after a failed action or early reviewed boundary', async () => {
  const source = await readFile('apps/threadnote/test/evaluation/fixtures/topic-maintenance-v1/sequence.json', 'utf8');
  const events = parseTopicStudyCorpusJsonV1(source).events;
  const trees: string[][] = [];
  for (const arm of ['manual', 'naive', 'maintained-success', 'maintained-failure']) {
    const files = new Map<string, string>();
    const apply = async (changes: (typeof events)[number]['changes']) => {
      for (const change of changes)
        if (change.content === null) files.delete(change.path);
        else files.set(change.path, change.content);
    };
    const hashes: string[] = [];
    for (const event of events) {
      try {
        await withTopicStudyTimeline(
          () => apply(event.changes),
          () => apply(event.postReviewChanges),
          async postReview => {
            if (arm === 'maintained-failure') throw new Error('model/preview failed');
            if (arm === 'maintained-success') await postReview();
          },
        );
      } catch {
        /* Failure must still replay the identical source stream. */
      }
      hashes.push(JSON.stringify([...files].sort()));
    }
    trees.push(hashes);
  }
  expect(trees.every(tree => JSON.stringify(tree) === JSON.stringify(trees[0]))).toBe(true);
  expect(trees[0][23]).toContain('timeoutSeconds = 90');
});

it('keeps an external sentinel Git repository/index untouched by sandbox Git', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'topic-study-git-'));
  try {
    const external = join(directory, 'external'),
      fixture = join(directory, 'fixture');
    await mkdir(external);
    await mkdir(fixture);
    const git = (cwd: string, args: readonly string[], env = topicStudyEnvironment(process.env)) => {
      const result = Bun.spawnSync(['git', ...args], {cwd, env, stdout: 'pipe', stderr: 'pipe'});
      if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
    };
    git(external, ['init', '-q']);
    await writeFile(join(external, 'sentinel.txt'), 'sentinel');
    git(external, ['add', '.']);
    const index = join(external, '.git', 'index');
    const originalIndex = await readFile(index);
    const originalGitTree = await topicStudyDependencyHash(join(external, '.git'));
    const originalHead = await readFile(join(external, '.git', 'HEAD'));
    await writeFile(join(fixture, 'fixture.ts'), 'export const value = 1;');
    const contaminated = {
      ...process.env,
      GIT_DIR: join(external, '.git'),
      GIT_WORK_TREE: external,
      GIT_INDEX_FILE: index,
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'core.hooksPath',
      GIT_CONFIG_VALUE_0: join(external, 'hooks'),
    };
    const safe = topicStudyEnvironment(contaminated);
    git(fixture, ['init', '-q'], safe);
    git(fixture, ['add', '.'], safe);
    git(
      fixture,
      ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture'],
      safe,
    );
    expect(await readFile(index)).toEqual(originalIndex);
    expect(await topicStudyDependencyHash(join(external, '.git'))).toBe(originalGitTree);
    expect(await readFile(join(external, '.git', 'HEAD'))).toEqual(originalHead);
    expect(await readFile(join(external, 'sentinel.txt'), 'utf8')).toBe('sentinel');
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});

it('rejects dirty/wrong source HEAD and actual dependency drift before accepting runtime provenance', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'topic-study-runtime-'));
  const git = (args: readonly string[]) => {
    const result = Bun.spawnSync(['git', ...args], {
      cwd: directory,
      env: topicStudyEnvironment(process.env),
      stdout: 'pipe',
      stderr: 'pipe',
    });
    if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
    return new TextDecoder().decode(result.stdout).trim();
  };
  try {
    await mkdir(join(directory, 'node_modules', 'native'), {recursive: true});
    await writeFile(join(directory, 'node_modules', 'native', 'runtime.node'), 'native-bytes');
    await writeFile(join(directory, 'bun.lock'), 'locked');
    await writeFile(join(directory, '.gitignore'), 'node_modules/\n');
    await writeFile(join(directory, 'source.ts'), 'export const version = 1;');
    git(['init', '-q']);
    git(['add', '.']);
    git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'source']);
    const head = git(['rev-parse', 'HEAD']);
    await expect(captureTopicStudyRuntime(directory, '0'.repeat(40))).rejects.toThrow('exact clean');
    const pinned = await captureTopicStudyRuntime(directory, head);
    await writeFile(join(directory, 'source.ts'), 'export const version = 2;');
    await expect(assertTopicStudyRuntime(pinned)).rejects.toThrow('exact clean');
    await writeFile(join(directory, 'source.ts'), 'export const version = 1;');
    await writeFile(join(directory, 'node_modules', 'native', 'runtime.node'), 'changed-native-bytes');
    await expect(assertTopicStudyRuntime(pinned)).rejects.toThrow('runtime drift');
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});

it('verifies actual model bytes and pins a private read-only path independently of catalog labels', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'topic-study-model-'));
  try {
    const source = join(directory, 'arbitrary.gguf');
    await writeFile(source, 'GGUF-fixture-bytes');
    const expected = {id: 'fixture', sha256: await topicStudyFileHash(source), size: 18};
    await expect(
      prepareTopicStudyModel(source, join(directory, 'private', 'wrong.gguf'), {...expected, sha256: '0'.repeat(64)}),
    ).rejects.toThrow('size/SHA');
    expected.size = (await stat(source)).size;
    const verified = await prepareTopicStudyModel(source, join(directory, 'private', 'verified.gguf'), expected);
    await writeFile(source, 'caller-model-changed');
    await expect(assertTopicStudyModel(verified, true)).resolves.toBeUndefined();
    await chmod(verified.path, 0o600);
    await writeFile(verified.path, 'changed-private-copy');
    await expect(assertTopicStudyModel(verified)).rejects.toThrow('GGUF changed');
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});

it('matches authored Map hashes for globally ordered filesystem leaf paths', async () => {
  await fc.assert(
    fc.asyncProperty(fc.array(fc.string({maxLength: 64}), {minLength: 4, maxLength: 4}), async contents => {
      const directory = await mkdtemp(join(tmpdir(), 'topic-study-tree-'));
      try {
        const names = ['a.ts', 'a/b.ts', 'a0/c.ts', 'z.ts'];
        const files = new Map(names.map((name, index) => [name, contents[index]]));
        for (const [name, content] of files) {
          await mkdir(join(directory, ...name.split('/').slice(0, -1)), {recursive: true});
          await writeFile(join(directory, name), content);
        }
        expect(await topicStudySourceTreeHash(directory)).toBe(
          topicStudyExpectedSourceTreeHash(new Map([...files].reverse())),
        );
      } finally {
        await rm(directory, {recursive: true, force: true});
      }
    }),
    {numRuns: 12},
  );
});
