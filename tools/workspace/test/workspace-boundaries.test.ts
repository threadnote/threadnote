import {describe, expect, it} from 'vitest';
import {
  moduleSpecifiers,
  validateRelocatedTestPaths,
  validateSourceVisibility,
  validateWorkspaceBoundaries,
  type WorkspacePackage,
} from '../boundaries.js';

const platform: WorkspacePackage = {
  name: '@threadnote/platform',
  directory: 'packages/platform',
  private: true,
  exports: {'./hash': './src/hash.ts'},
  dependencies: {},
};
const memory: WorkspacePackage = {
  name: '@threadnote/memory',
  directory: 'packages/memory',
  private: true,
  exports: {'./document': './src/document.ts'},
  dependencies: {'@threadnote/platform': 'workspace:*'},
};

describe('private workspace boundaries', () => {
  it('rejects parent segments corrupted while relocating the legacy test root', () => {
    expect(
      validateRelocatedTestPaths([
        {path: 'apps/threadnote/test/unit/example.test.ts', content: `join(path, '../../../test')`},
        {
          path: 'apps/threadnote/test/integration/runtime.test.ts',
          content: `join(repoRoot, 'src', 'standalone.ts')`,
        },
        {path: 'packages/graph/test/example.test.ts', content: `join(path, '../../../test')`},
      ]),
    ).toEqual([
      'apps/threadnote/test/integration/runtime.test.ts: launches the retired root src/standalone.ts entrypoint',
      'apps/threadnote/test/unit/example.test.ts: contains a corrupted parent segment from the test-root migration',
      'packages/graph/test/example.test.ts: contains a corrupted parent segment from the test-root migration',
    ]);
  });

  it('rejects source modules hidden by Git ignore rules', () => {
    const sources = [
      {path: 'packages/graph/src/build/owner.ts', imports: []},
      {path: 'packages/graph/src/index.ts', imports: []},
    ];
    expect(validateSourceVisibility(sources, new Set(['packages/graph/src/index.ts']))).toEqual([
      'packages/graph/src/build/owner.ts: source file is hidden by Git ignore rules',
    ]);
  });
  it('accepts a declared exported domain dependency', () => {
    expect(
      validateWorkspaceBoundaries(
        [platform, memory],
        [{path: 'packages/memory/src/document.ts', imports: ['@threadnote/platform/hash']}],
      ),
    ).toEqual([]);
  });
  it('rejects relative escapes, including imports from the application workspace', () => {
    expect(
      validateWorkspaceBoundaries(
        [platform, memory],
        [
          {path: 'packages/memory/src/document.ts', imports: ['../../platform/src/hash.js', '../../../src/utils.js']},
          {path: 'apps/threadnote/src/utils.ts', imports: ['../../../packages/platform/src/hash.js']},
        ],
      ),
    ).toHaveLength(3);
  });
  it('rejects undeclared dependencies and bypassed exports', () => {
    const errors = validateWorkspaceBoundaries(
      [platform, {...memory, dependencies: {}}],
      [{path: 'packages/memory/src/document.ts', imports: ['@threadnote/platform/src/hash.ts']}],
    );
    expect(errors).toHaveLength(2);
    expect(errors.join('\n')).toContain('undeclared dependency');
    expect(errors.join('\n')).toContain('unexported entrypoint');
  });
  it('rejects cycles, public packages, and reversed domain dependencies', () => {
    const errors = validateWorkspaceBoundaries(
      [{...platform, private: false, dependencies: {'@threadnote/memory': 'workspace:*'}}, memory],
      [],
    );
    expect(errors.join('\n')).toContain('Workspace cycle:');
    expect(errors.join('\n')).toContain('must be private');
    expect(errors.join('\n')).toContain('forbidden dependency');
  });
  it('keeps test dependencies out of production modules', () => {
    const pkg = {...memory, dependencies: {}, devDependencies: {'@threadnote/platform': 'workspace:*'}};
    expect(
      validateWorkspaceBoundaries(
        [platform, pkg],
        [
          {path: 'packages/memory/test/document.test.ts', imports: ['@threadnote/platform/hash']},
          {path: 'packages/memory/src/test/document.test.ts', imports: ['@threadnote/platform/hash']},
        ],
      ),
    ).toEqual([]);
    expect(
      validateWorkspaceBoundaries(
        [platform, pkg],
        [{path: 'packages/memory/src/document.ts', imports: ['@threadnote/platform/hash']}],
      ).join('\n'),
    ).toContain('undeclared dependency');
  });
  it('finds static, dynamic, re-exported, and type-only imports', () => {
    expect(
      moduleSpecifiers(
        'example.ts',
        `import type {Hash} from '@threadnote/platform/hash'; export {run} from './run.js'; const x = import('./dynamic.js'); type T = import('./type.js').T;`,
      ),
    ).toEqual(['./dynamic.js', './run.js', './type.js', '@threadnote/platform/hash']);
  });
  it('allows shared testing helpers only as development dependencies', () => {
    const testing: WorkspacePackage = {
      name: '@threadnote/testing',
      directory: 'packages/testing',
      private: true,
      exports: {'./property': './src/property.ts'},
      dependencies: {},
    };
    expect(
      validateWorkspaceBoundaries(
        [testing, {...memory, dependencies: {}, devDependencies: {'@threadnote/testing': 'workspace:*'}}],
        [{path: 'packages/memory/test/document.test.ts', imports: ['@threadnote/testing/property']}],
      ),
    ).toEqual([]);
    expect(
      validateWorkspaceBoundaries(
        [testing, {...memory, dependencies: {'@threadnote/testing': 'workspace:*'}}],
        [],
      ).join('\n'),
    ).toContain('forbidden dependency');
  });
});
