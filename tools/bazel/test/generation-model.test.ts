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
      const testPath = join(root, 'apps/threadnote/test/unit/freshness.test.ts');
      writeFileSync(testPath, 'import {it} from "vitest"; it("fresh", () => {});');
      const {createTargetSpecs} = await import('../target-specs.mjs');
      const first = createTargetSpecs(root).targetSpecs.flatMap(target => target.entries);
      expect(first).toContain('apps/threadnote/test/unit/freshness.test.ts');
      rmSync(testPath);
      const second = createTargetSpecs(root).targetSpecs.flatMap(target => target.entries);
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
