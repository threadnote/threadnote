/* oxlint-disable effecttsgo/node-builtin-import -- Disposable fixture directory lifecycle requires native OS filesystem primitives. */
import {mkdtempSync, mkdirSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {expect, it} from 'vitest';

const generation = {headSha: 'head', sourceDigest: 'source', inventoryDigest: 'inventory'};
const fixture = async () => {
  const root = mkdtempSync(join(tmpdir(), 'bazel-consumers-'));
  mkdirSync(join(root, 'tools/bazel'), {recursive: true});
  mkdirSync(join(root, 'tools/ci'), {recursive: true});
  for (const path of [
    'tools/bazel/run.ts',
    'tools/ci/bazel-select.mjs',
    'tools/ci/bazel-plan-shards.mjs',
    'tools/ci/bazel-run-selected.mjs',
    'tools/ci/bazel-shards.mjs',
    'tools/ci/selection.mjs',
  ])
    await Bun.write(join(root, path), await Bun.file(path).text());
  await Bun.write(
    join(root, 'tools/bazel/prepare.mjs'),
    `
const generation = ${JSON.stringify(generation)};
export async function prepareBazelWorkspace() {
  await Bun.write('prepared', 'yes');
  if (process.env.FAIL_PREPARE) throw new Error('invalid current head');
}
export async function readPreparedInventory({expectedGeneration} = {}) {
  await prepareBazelWorkspace();
  if (expectedGeneration && JSON.stringify(expectedGeneration) !== JSON.stringify(generation)) throw new Error('generation drift');
  const inventory = {targets: [{label:'//:test', kind:'test', inputs:[], entries:[], env:{}, weight:1}]};
  await Bun.write('tools/bazel/targets.json', JSON.stringify(inventory));
  await Bun.write('.context/bazel-generated/receipt.json', JSON.stringify({version:2,...generation}));
  return {generation, inventory};
}
`,
  );
  await Bun.write(
    join(root, 'tools/bazel/cli-tools.mjs'),
    `export async function bazelPath() { return process.execPath; } export async function bazelDiffPath() { throw new Error('unused'); }`,
  );
  return root;
};
const run = async (root: string, path: string, args: string[] = [], env: Record<string, string> = {}) => {
  const child = Bun.spawn([process.execPath, path, ...args], {
    cwd: root,
    env: {...process.env, ...env},
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return {code, stdout, stderr};
};

it('prepares graph commands before executable dispatch and skips graph-independent commands', async () => {
  const root = await fixture();
  try {
    for (const command of ['version', 'help', 'shutdown', 'clean']) {
      await run(root, 'tools/bazel/run.ts', [command], {FAIL_PREPARE: '1'});
      expect(await Bun.file(join(root, 'prepared')).exists()).toBe(false);
    }
    for (const command of ['build', 'test', 'query', 'cquery', 'aquery', 'run', 'coverage']) {
      const result = await run(root, 'tools/bazel/run.ts', [command], {FAIL_PREPARE: '1'});
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain('invalid current head');
    }
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});

it('rejects an invalid current head before writing a fallback selection', async () => {
  const root = await fixture();
  try {
    const result = await run(root, 'tools/ci/bazel-select.mjs', [], {FAIL_PREPARE: '1'});
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('invalid current head');
    expect(await Bun.file(join(root, '.context/bazel-selection/selection.json')).exists()).toBe(false);
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});

it('binds shard artifacts to the prepared generation and rejects drift in planner and runner', async () => {
  const root = await fixture();
  try {
    const selection = {targets: ['//:test'], generation};
    await Bun.write(join(root, '.context/bazel-selection/selection.json'), JSON.stringify(selection));
    const planned = await run(root, 'tools/ci/bazel-plan-shards.mjs');
    expect(planned.code, planned.stderr).toBe(0);
    const shards = await Bun.file(join(root, '.context/bazel-selection/shards.json')).json();
    expect(shards.shards).toHaveLength(1);
    const artifact = await Bun.file(join(root, `.context/bazel-selection/shards/${shards.shards[0].id}.json`)).json();
    expect(artifact.generation).toEqual(generation);
    expect(artifact.targets).toEqual(selection.targets);
    for (const path of ['tools/ci/bazel-plan-shards.mjs', 'tools/ci/bazel-run-selected.mjs']) {
      await Bun.write(
        join(root, '.context/bazel-selection/selection.json'),
        JSON.stringify({...selection, generation: {...generation, sourceDigest: 'drift'}}),
      );
      const result = await run(root, path);
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain('generation drift');
    }
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});

it.each(['legacy', 'prepared'])(
  'prepares a %s baseline with its own capability before reading an untracked inventory',
  async layout => {
    const root = await fixture();
    const git = async (...args: string[]) => {
      const child = Bun.spawn(['git', ...args], {cwd: root, stdout: 'pipe', stderr: 'pipe'});
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect(code, stderr).toBe(0);
      return stdout.trim();
    };
    try {
      await Bun.write(join(root, 'package.json'), '{"name":"consumer-fixture","private":true}');
      await Bun.write(join(root, 'MODULE.bazel'), 'module(name = "fixture")');
      await Bun.write(join(root, 'deleted.ts'), 'export const removed = true;');
      await Bun.write(
        join(root, '.gitignore'),
        '.context/\nnode_modules/\ntools/bazel/targets.json\nprepared\nevents\n',
      );
      const writeInventory = `await Bun.write('tools/bazel/targets.json', JSON.stringify({targets:[{label:'//:old',kind:'test',inputs:['deleted.ts']}]}));`;
      const log = (name: string) =>
        `await Bun.write(process.env.EVENT_LOG, (await Bun.file(process.env.EVENT_LOG).text().catch(() => '')) + '${name}\\n');`;
      await Bun.write(
        join(root, 'tools/bazel/generate.mjs'),
        layout === 'legacy'
          ? log('base-generate') + writeInventory
          : `throw new Error('prepared base must not invoke legacy generator');`,
      );
      if (layout === 'legacy') {
        rmSync(join(root, 'tools/bazel/prepare.mjs'));
        await Bun.write(join(root, 'apps/website/tools/site-prepared-metadata.ts'), log('base-metadata'));
      } else {
        await Bun.write(join(root, 'tools/bazel/prepare.mjs'), log('base-prepare') + writeInventory);
      }
      await git('init', '-q');
      await git('add', '.');
      await git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'baseline');
      const revision = await git('rev-parse', 'HEAD');
      rmSync(join(root, 'deleted.ts'));
      // Restore the current head reader after recording the independently executable base.
      await Bun.write(
        join(root, 'tools/bazel/prepare.mjs'),
        `
const inventory = {targets:[{label:'//:test',kind:'test',inputs:['tools/bazel/prepare.mjs','tools/bazel/cli-tools.mjs'], entries:[],env:{}}]};
export async function prepareBazelWorkspace() {
  await Bun.write('tools/bazel/targets.json', JSON.stringify(inventory));
  await Bun.write('.context/bazel-generated/receipt.json', JSON.stringify({version:2,...${JSON.stringify(generation)}}));
}
export async function readPreparedInventory() {
  await prepareBazelWorkspace();
  return {generation:${JSON.stringify(generation)},inventory};
}`,
      );
      await Bun.write(
        join(root, 'tools/bazel/cli-tools.mjs'),
        `export async function bazelPath(){return process.env.DIFF_EXECUTABLE} export async function bazelDiffPath(){return process.env.DIFF_EXECUTABLE}`,
      );
      const executable = join(root, '.context/diff');
      await Bun.write(
        executable,
        `#!${process.execPath}\nconst i=process.argv.indexOf('-o'); if(i>=0) await Bun.write(process.argv[i+1], '');`,
      );
      // Executable mode is an OS capability required by the external diff subprocess.
      const chmod = Bun.spawn(['chmod', '+x', executable]);
      expect(await chmod.exited).toBe(0);
      await Bun.write(join(root, '.context/bazel-selection/base-generation-receipt.json'), '{"stale":true}');
      await Bun.write(join(root, '.context/bazel-selection/base-inventory.json'), '{"stale":true}');
      const result = await run(root, 'tools/ci/bazel-select.mjs', ['--base', revision], {
        EVENT_LOG: join(root, 'events'),
        DIFF_EXECUTABLE: executable,
      });
      expect(result.code, result.stderr).toBe(0);
      expect(await Bun.file(join(root, 'events')).text()).toBe(
        layout === 'legacy' ? 'base-metadata\nbase-generate\n' : 'base-prepare\n',
      );
      const selection = await Bun.file(join(root, '.context/bazel-selection/selection.json')).json();
      expect(selection.mode).toBe('selective');
      expect(selection.changedFiles).not.toContain('tools/bazel/targets.json');
      expect(selection.changedFiles).toContain('deleted.ts');
      expect(selection.generation).toEqual(generation);
      for (const [archived, original] of [
        ['inventory.json', 'tools/bazel/targets.json'],
        ['generation-receipt.json', '.context/bazel-generated/receipt.json'],
      ])
        expect(await Bun.file(join(root, '.context/bazel-selection', archived)).text()).toBe(
          await Bun.file(join(root, original)).text(),
        );
      const baseInventory = await Bun.file(join(root, '.context/bazel-selection/base-inventory.json')).json();
      expect(baseInventory.targets[0].inputs).toContain('deleted.ts');
      expect(await Bun.file(join(root, '.context/bazel-selection/base-generation-receipt.json')).exists()).toBe(false);
      expect(await git('rev-parse', 'HEAD')).toBe(revision);
    } finally {
      rmSync(root, {recursive: true, force: true});
    }
  },
);

it('executes exactly the approved selected targets after matching preparation and refuses missing identity', async () => {
  const root = await fixture();
  try {
    const executable = join(root, '.context/bazel');
    await Bun.write(
      executable,
      `#!${process.execPath}\nif (!(await Bun.file('prepared').exists())) throw new Error('executed before preparation'); await Bun.write('executed.json', JSON.stringify(process.argv.slice(2)));`,
    );
    const chmod = Bun.spawn(['chmod', '+x', executable]);
    expect(await chmod.exited).toBe(0);
    await Bun.write(
      join(root, 'tools/bazel/cli-tools.mjs'),
      `export async function bazelPath(){return ${JSON.stringify(executable)}}`,
    );
    await Bun.write(
      join(root, '.context/bazel-selection/selection.json'),
      JSON.stringify({generation, targets: ['//:test']}),
    );
    const result = await run(root, 'tools/ci/bazel-run-selected.mjs');
    expect(result.code, result.stderr).toBe(0);
    expect(await Bun.file(join(root, 'executed.json')).json()).toEqual(['test', '--local_test_jobs=1', '//:test']);
    await Bun.write(join(root, '.context/bazel-selection/selection.json'), JSON.stringify({targets: ['//:test']}));
    for (const path of ['tools/ci/bazel-plan-shards.mjs', 'tools/ci/bazel-run-selected.mjs']) {
      const missing = await run(root, path);
      expect(missing.code).not.toBe(0);
      expect(missing.stderr).toContain('Selection is missing its prepared generation');
    }
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});

it('prepares the package check command before checking or analyzing absent outputs', async () => {
  const root = await fixture();
  try {
    const manifest = await Bun.file('package.json').json();
    await Bun.write(
      join(root, 'package.json'),
      JSON.stringify({scripts: {'bazel:check': manifest.scripts['bazel:check']}}),
    );
    await Bun.write(
      join(root, 'tools/bazel/prepare.mjs'),
      "await Bun.write('order.json', JSON.stringify(['prepare']));",
    );
    await Bun.write(
      join(root, 'tools/bazel/generate.mjs'),
      `const order = await Bun.file('order.json').json(); if (order.join() !== 'prepare') throw new Error('not prepared'); await Bun.write('order.json', JSON.stringify([...order, 'check']));`,
    );
    await Bun.write(
      join(root, 'tools/bazel/run.ts'),
      `const order = await Bun.file('order.json').json(); if (order[1] !== 'check') throw new Error('not checked'); await Bun.write('order.json', JSON.stringify([...order, process.argv[2]]));`,
    );
    const result = await run(root, 'run', ['bazel:check']);
    expect(result.code, result.stderr).toBe(0);
    expect(await Bun.file(join(root, 'order.json')).json()).toEqual(['prepare', 'check', 'build', 'test']);
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});
