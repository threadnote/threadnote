import {mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync} from '@threadnote/testing/node-fs';
import {tmpdir} from '@threadnote/testing/node-os';
import {join} from '@threadnote/testing/node-path';
import {execFileSync} from '@threadnote/testing/node-child-process';
import {describe, expect, it} from 'vitest';
import {prepareBazelWorkspace} from '../prepare.mjs';

const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), 'threadnote-bazel-prepare-'));
  mkdirSync(join(root, 'apps/demo'), {recursive: true});
  mkdirSync(join(root, 'packages'), {recursive: true});
  mkdirSync(join(root, 'tools/bazel'), {recursive: true});
  writeFileSync(join(root, 'package.json'), JSON.stringify({name: 'fixture', dependencies: {}}));
  writeFileSync(join(root, 'bun.lock'), 'lock');
  writeFileSync(join(root, 'apps/demo/package.json'), JSON.stringify({name: '@fixture/demo', dependencies: {}}));
  writeFileSync(join(root, 'apps/demo/main.ts'), 'export const answer = 42;\n');
  writeFileSync(join(root, 'tools/bazel/targets.json'), 'stale');
  writeFileSync(join(root, 'apps/demo/BUILD.bazel'), 'handwritten');
  execFileSync('git', ['init', '-q'], {cwd: root});
  execFileSync('git', ['add', '.'], {cwd: root});
  return root;
};

const options = {
  produceMetadata: false,
  modelOptions: {
    specs: [
      {package: '', name: 'alpha', kind: 'action', entries: ['apps/demo/main.ts'], data: ['tools/bazel/targets.json']},
    ],
    suites: [],
    statics: [],
    modules: [],
  },
};

describe('prepareBazelWorkspace', () => {
  it('publishes atomically-replaced declarations, writes a receipt last, and preserves handwritten BUILD files', async () => {
    const root = fixture();
    try {
      const first = await prepareBazelWorkspace({root, ...options});
      const bytes = readFileSync(join(root, 'BUILD.bazel'), 'utf8');
      const second = await prepareBazelWorkspace({root, ...options});
      expect(readFileSync(join(root, 'BUILD.bazel'), 'utf8')).toBe(bytes);
      expect(second.outputCount).toBe(first.outputCount);
      expect(readFileSync(join(root, '.context/bazel-generated/receipt.json'), 'utf8')).toContain('targets.json');
      expect(readFileSync(join(root, 'apps/demo/BUILD.bazel'), 'utf8')).toBe('handwritten');
    } finally {
      rmSync(root, {recursive: true, force: true});
    }
  });
});

it('serializes concurrent preparers and releases the native lock after process death', async () => {
  const root = fixture();
  try {
    await prepareBazelWorkspace({root, ...options});
    const database = join(root, '.context/bazel-generated/prepare.sqlite');
    const child = Bun.spawn(
      [
        process.execPath,
        '-e',
        `import {Database} from 'bun:sqlite'; const db = new Database(${JSON.stringify(database)}); db.exec('BEGIN IMMEDIATE'); console.log('locked'); await Bun.sleep(60000);`,
      ],
      {stdout: 'pipe', stderr: 'pipe'},
    );
    try {
      const reader = child.stdout.getReader();
      expect(new TextDecoder().decode((await reader.read()).value)).toContain('locked');
      reader.releaseLock();
      let completed = false;
      const waiting = prepareBazelWorkspace({root, ...options}).then(result => {
        completed = true;
        return result;
      });
      await Bun.sleep(40);
      expect(completed).toBe(false);
      child.kill('SIGKILL');
      await child.exited;
      await waiting;
      const [first, second] = await Promise.all([
        prepareBazelWorkspace({root, ...options}),
        prepareBazelWorkspace({root, ...options}),
      ]);
      expect(first).toEqual(second);
    } finally {
      child.kill();
      await child.exited;
    }
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});

it('invalidates incomplete publication, repairs it and cleans only previously owned generated output', async () => {
  const root = fixture();
  try {
    rmSync(join(root, 'apps/demo/BUILD.bazel'));
    await prepareBazelWorkspace({root, ...options});
    const before = await Bun.file(join(root, 'BUILD.bazel')).text();
    rmSync(join(root, 'BUILD.bazel'));
    mkdirSync(join(root, 'BUILD.bazel'));
    await expect(prepareBazelWorkspace({root, ...options})).rejects.toThrow();
    expect(await Bun.file(join(root, '.context/bazel-generated/receipt.json')).exists()).toBe(false);
    rmSync(join(root, 'BUILD.bazel'), {recursive: true});
    await prepareBazelWorkspace({root, ...options});
    expect(await Bun.file(join(root, 'BUILD.bazel')).text()).toBe(before);
    rmSync(join(root, 'apps/demo/package.json'));
    await prepareBazelWorkspace({root, ...options});
    expect(await Bun.file(join(root, 'apps/demo/BUILD.bazel')).exists()).toBe(false);
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});

it('refuses to hide generated targets behind a handwritten package and keeps its contents', async () => {
  const root = fixture();
  try {
    const spec = {package: 'apps/demo', name: 'test', kind: 'action', entries: ['apps/demo/main.ts']};
    await expect(
      prepareBazelWorkspace({
        root,
        produceMetadata: false,
        modelOptions: {specs: [spec], suites: [], statics: [], modules: []},
      }),
    ).rejects.toThrow('handwritten');
    expect(await Bun.file(join(root, 'apps/demo/BUILD.bazel')).text()).toBe('handwritten');
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});

it('repairs an interrupted publication without admitting its staging files as authored inputs', async () => {
  const root = fixture();
  try {
    const broad = {
      produceMetadata: false,
      modelOptions: {
        specs: [{package: '', name: 'format', kind: 'action', entries: [], dataRoots: ['apps', 'tools']}],
        suites: [],
        statics: [],
        modules: [],
      },
    };
    await prepareBazelWorkspace({root, ...broad});
    const cleanBuild = await Bun.file(join(root, 'BUILD.bazel')).text();
    const cleanInventory = await Bun.file(join(root, 'tools/bazel/targets.json')).text();
    await Bun.file(join(root, '.context/bazel-generated/receipt.json')).delete();
    await Bun.write(join(root, '.context/bazel-generated/staging/12345-0.tmp'), 'partial generated output');
    await prepareBazelWorkspace({root, ...broad});
    expect(await Bun.file(join(root, '.context/bazel-generated/staging/12345-0.tmp')).exists()).toBe(false);
    expect(await Bun.file(join(root, 'BUILD.bazel')).text()).toBe(cleanBuild);
    expect(await Bun.file(join(root, 'tools/bazel/targets.json')).text()).toBe(cleanInventory);
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});
