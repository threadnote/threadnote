import {mkdtempSync, mkdirSync, writeFileSync, rmSync} from '@threadnote/testing/node-fs';
import {tmpdir} from '@threadnote/testing/node-os';
import {join} from '@threadnote/testing/node-path';
import {execFileSync} from '@threadnote/testing/node-child-process';

import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {buildGenerationModel} from '../generation-model.mjs';

const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), 'threadnote-bazel-model-'));
  mkdirSync(join(root, 'apps/demo'), {recursive: true});
  mkdirSync(join(root, 'packages'), {recursive: true});
  mkdirSync(join(root, 'tools/bazel'), {recursive: true});
  writeFileSync(join(root, 'package.json'), JSON.stringify({name: 'fixture', dependencies: {}}));
  writeFileSync(join(root, 'bun.lock'), 'lock');
  writeFileSync(join(root, 'apps/demo/package.json'), JSON.stringify({name: '@fixture/demo', dependencies: {}}));
  writeFileSync(join(root, 'apps/demo/main.ts'), 'export const answer = 42;\n');
  writeFileSync(join(root, 'tools/bazel/targets.json'), 'deliberately stale');
  execFileSync('git', ['init', '-q'], {cwd: root});
  execFileSync('git', ['add', '.'], {cwd: root});
  return root;
};
const spec = (name: string) => ({
  package: '',
  name,
  kind: 'action',
  entries: ['apps/demo/main.ts'],
  data: ['tools/bazel/targets.json'],
  args: ['main.ts'],
});
const runModel = (root: string, specs: readonly object[], statics: readonly object[] = []) =>
  buildGenerationModel({root, specs, suites: [], statics, modules: []});

describe('buildGenerationModel', () => {
  it('re-discovers test additions and removals for each root-scoped target-spec build', async () => {
    const root = mkdtempSync(join(tmpdir(), 'threadnote-bazel-specs-'));
    try {
      mkdirSync(join(root, 'apps/threadnote/test/unit'), {recursive: true});
      mkdirSync(join(root, 'apps/threadnote'), {recursive: true});
      mkdirSync(join(root, 'packages'), {recursive: true});
      mkdirSync(join(root, 'tools/bazel'), {recursive: true});
      writeFileSync(join(root, 'package.json'), JSON.stringify({dependencies: {}, devDependencies: {}}));
      writeFileSync(
        join(root, 'apps/threadnote/package.json'),
        JSON.stringify({name: '@fixture/threadnote', dependencies: {}}),
      );
      writeFileSync(join(root, 'tools/bazel/project-vitest.config.ts'), 'export {};');
      execFileSync('git', ['init', '-q'], {cwd: root});
      await Bun.write(join(root, '.gitignore'), '*.log\nignored.test.ts\n');
      const testPath = join(root, 'apps/threadnote/test/unit/freshness.test.ts');
      writeFileSync(testPath, 'import {it} from "vitest"; it("fresh", () => {});');
      const {createTargetSpecs} = await import('../target-specs.mjs');
      const first = (await createTargetSpecs(root)).targetSpecs.flatMap(target => target.entries);
      expect(first).toContain('apps/threadnote/test/unit/freshness.test.ts');
      await Bun.write(join(root, 'tools/bazel/debug.log'), 'ignored');
      await Bun.write(join(root, 'apps/threadnote/test/unit/ignored.test.ts'), 'throw new Error("ignored");');
      const scratch = await createTargetSpecs(root);
      expect(scratch.targetSpecs.flatMap(target => target.entries)).toEqual(first);
      expect(scratch.staticTargets.flatMap(target => target.inputs)).not.toContain('tools/bazel/debug.log');
      rmSync(testPath);
      const second = (await createTargetSpecs(root)).targetSpecs.flatMap(target => target.entries);
      expect(second).not.toContain('apps/threadnote/test/unit/freshness.test.ts');
    } finally {
      rmSync(root, {recursive: true, force: true});
    }
  });

  it('does not read prior inventory bytes and models it as a produced consumer input', async () => {
    const root = fixture();
    try {
      const before = await runModel(root, [spec('alpha')]);
      writeFileSync(join(root, 'tools/bazel/targets.json'), '{broken');
      const after = await runModel(root, [spec('alpha')]);
      expect([...after.output]).toEqual([...before.output]);
      expect(after.inventory[0]?.inputs).toContain('tools/bazel/targets.json');
    } finally {
      rmSync(root, {recursive: true, force: true});
    }
  });

  it('models generated inventory inputs consistently in both BUILD rules and inventory on absent or corrupt prior bytes', async () => {
    const root = fixture();
    try {
      const specs = ['tooling_test', 'format', 'lint', 'workspace_check'].map(name => ({...spec(name), data: []}));
      const buildAbsent = await runModel(root, specs, [
        {label: '//:bazel_validation', kind: 'ci', lane: 'bazel_validation', inputs: ['tools/bazel/targets.json']},
      ]);
      writeFileSync(join(root, 'tools/bazel/targets.json'), '{malformed old bytes');
      const buildDirty = await runModel(root, specs, [
        {label: '//:bazel_validation', kind: 'ci', lane: 'bazel_validation', inputs: []},
      ]);
      expect([...buildDirty.output]).toEqual([...buildAbsent.output]);
      for (const label of ['//:tooling_test', '//:format', '//:lint', '//:workspace_check', '//:bazel_validation']) {
        const target = buildDirty.inventory.find(item => item.label === label)!;
        expect(target.inputs).toContain('tools/bazel/targets.json');
        if (label !== '//:bazel_validation')
          expect(buildDirty.output.get('BUILD.bazel')).toContain('"//:tools/bazel/targets.json"');
      }
    } finally {
      rmSync(root, {recursive: true, force: true});
    }
  });

  it('sorts output inventory independently of target-spec enumeration', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uniqueArray(fc.stringMatching(/^[a-z][a-z0-9_]{0,8}$/u), {minLength: 1, maxLength: 5}),
        async names => {
          const root = fixture();
          try {
            const specs = names.map(spec);
            const model = await runModel(root, specs);
            expect(model.inventory.map(target => target.label)).toEqual(
              [...model.inventory.map(target => target.label)].sort(),
            );
          } finally {
            rmSync(root, {recursive: true, force: true});
          }
        },
      ),
      {numRuns: 12},
    );
  });
});

it('keeps generated inputs equal to independent source reachability, including cycles and unrelated files', async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.array(fc.tuple(fc.integer({min: 0, max: 5}), fc.integer({min: 0, max: 5})), {maxLength: 20}),
      async edges => {
        const root = fixture();
        try {
          for (let node = 0; node < 6; node++) {
            await Bun.write(
              join(root, `apps/demo/${node}.ts`),
              edges
                .filter(([from]) => from === node)
                .map(([, to]) => `import './${to}.js';`)
                .join('\n'),
            );
          }
          const specs = [{package: '', name: 'reachable', kind: 'library', entries: ['apps/demo/0.ts']}];
          const before = await runModel(root, specs);
          const reached = new Set([0]);
          for (let pass = 0; pass < 6; pass++) for (const [from, to] of edges) if (reached.has(from)) reached.add(to);
          expect(before.inventory[0]?.inputs).toEqual([...reached].map(node => `apps/demo/${node}.ts`).sort());
          await Bun.write(join(root, 'apps/demo/unrelated.ts'), 'export const unrelated = 1;');
          expect([...(await runModel(root, specs)).output]).toEqual([...before.output]);
        } finally {
          rmSync(root, {recursive: true, force: true});
        }
      },
    ),
    {numRuns: 20},
  );
});

it('resolves imports from authored files even when ignored emitted JavaScript exists', async () => {
  const root = fixture();
  try {
    await Bun.write(join(root, '.gitignore'), '*.js\n');
    await Bun.write(join(root, 'apps/demo/main.ts'), "import './dep.js';");
    await Bun.write(join(root, 'apps/demo/dep.ts'), 'export const value = 1;');
    const before = await runModel(root, [spec('authored')]);
    await Bun.write(join(root, 'apps/demo/dep.js'), "import './missing.js';");
    expect([...(await runModel(root, [spec('authored')])).output]).toEqual([...before.output]);
    expect(before.inventory[0]?.inputs).toContain('apps/demo/dep.ts');
    expect(before.inventory[0]?.inputs).not.toContain('apps/demo/dep.js');
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});

it('factors fixture closures with identical inventory, settings, resources, and excluded leaves', async () => {
  const root = fixture();
  try {
    await Bun.write(join(root, 'apps/demo/main.ts'), 'export * as shared from "./shared.js";');
    await Bun.write(join(root, 'apps/demo/shared.ts'), 'import "runtime-npm"; export const shared = 1;');
    await Bun.write(join(root, 'apps/demo/isolated.ts'), 'export const isolated = 2;');
    await Bun.write(join(root, 'apps/demo/data.json'), '{}');
    await Bun.write(join(root, 'tools/bazel/project-vitest.config.ts'), 'export {};');
    const specs = [
      {
        package: 'apps/demo',
        name: 'sample',
        kind: 'test',
        entries: ['apps/demo/main.ts'],
        sourceRoots: ['apps/demo'],
        data: ['apps/demo/data.json'],
        exclude: (path: string) => path === 'apps/demo/shared.ts',
        npm: ['extra-npm'],
        args: ['custom', '--flag'],
        env: {FIXTURE: 'yes'},
        timeout: 'long',
        workspace: true,
      },
    ];
    const options = {root, specs, suites: [], statics: [], modules: []};
    const flat = await buildGenerationModel({...options, representation: 'flat'});
    const factored = await buildGenerationModel({...options, representation: 'factored'});
    expect(factored.inventory).toEqual(flat.inventory);
    const declaration = factored.declarations.get('//apps/demo:sample')!;
    const files = new Set(declaration.srcs);
    const npm = new Set(declaration.npm);
    const pending = [...declaration.deps];
    const visited = new Set<string>();
    while (pending.length) {
      const label = pending.pop()!;
      if (visited.has(label)) continue;
      visited.add(label);
      const library = factored.libraries.get(label)!;
      for (const file of library.srcs) files.add(file);
      for (const name of library.npm) npm.add(name);
      pending.push(...library.deps);
    }
    expect([...files].sort()).toEqual(flat.inventory[0].inputs);
    expect([...npm].sort()).toEqual(flat.inventory[0].npm);
    expect(files.has('apps/demo/shared.ts')).toBe(false);
    expect(declaration.srcs).toContain('apps/demo/main.ts');
    expect(declaration.srcs).toContain('apps/demo/data.json');
    expect(declaration.srcs).toContain('tools/bazel/project-vitest.config.ts');
    expect(declaration.deps.length).toBeGreaterThan(0);
    const build = factored.output.get('apps/demo/BUILD.bazel')!;
    expect(build).toContain('runner_args = [\n        "custom",\n        "--flag",');
    expect(build).toContain('env = {"FIXTURE":"yes"}');
    expect(build).toContain('timeout = "long"');
    expect(build).toContain('tags = ["local", "no-cache", "no-sandbox"]');
    expect(flat.libraries.size).toBe(0);
    expect([...flat.output]).toEqual([...(await buildGenerationModel({...options, representation: 'flat'})).output]);
    expect([...factored.output]).toEqual([...(await buildGenerationModel(options)).output]);
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});

it.each(['BUILD', 'BUILD.bazel'])(
  'keeps handwritten workspace %s owners as explicit library boundaries',
  async buildName => {
    const root = fixture();
    try {
      const authored = 'exports_files(["main.ts", "package.json"])\n';
      await Bun.write(join(root, 'apps/demo', buildName), authored);
      const options = {root, specs: [spec('consumer')], suites: [], statics: [], modules: []};
      const flat = await buildGenerationModel({...options, representation: 'flat'});
      const factored = await buildGenerationModel({...options, representation: 'factored'});
      expect(factored.inventory).toEqual(flat.inventory);
      expect([...factored.output]).toEqual([...flat.output]);
      expect(factored.output.has('apps/demo/BUILD.bazel')).toBe(false);
      expect([...factored.libraries.values()].some(value => value.package === 'apps/demo')).toBe(false);
      expect(factored.declarations.get('//:consumer')?.srcs).toContain('apps/demo/main.ts');
      expect(await Bun.file(join(root, 'apps/demo', buildName)).text()).toBe(authored);
      await expect(
        buildGenerationModel({...options, specs: [{...spec('conflict'), package: 'apps/demo'}]}),
      ).rejects.toThrow('Refusing to replace handwritten Bazel package');
    } finally {
      rmSync(root, {recursive: true, force: true});
    }
  },
);
