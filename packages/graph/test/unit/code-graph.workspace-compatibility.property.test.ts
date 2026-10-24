import {describe, expect, it} from 'vitest';
import fc from 'fast-check';
import type {CodeGraphWorkspace, CodeGraphWorkspaceProject} from '@threadnote/graph/languages/types';
import {assessCodeGraphWorkspaceCompatibility} from '@threadnote/graph/workspace/compatibility';
import {classifyWorkspaceTransition} from '@threadnote/graph/workspace/transition';

describe('code graph workspace compatibility properties', () => {
  it('ignores repository fingerprint churn when every project surface stays identical', () => {
    fc.assert(
      fc.property(fc.integer({max: 12, min: 1}), projectCount => {
        const projects = Array.from({length: projectCount}, (_, index) => project(index));
        expect(
          assessCodeGraphWorkspaceCompatibility(workspace('base', projects), workspace('current', projects)),
        ).toEqual({
          mode: 'unchanged',
        });
      }),
      {numRuns: 50},
    );
  });

  it('seeds only projects whose semantic workspace surface changed', () => {
    fc.assert(
      fc.property(fc.integer({max: 12, min: 2}), fc.nat(), (projectCount, salt) => {
        const projects = Array.from({length: projectCount}, (_, index) => project(index));
        const changedIndex = salt % projectCount;
        const dependencyIndex = (changedIndex + 1) % projectCount;
        const changed = projects.map((value, index) =>
          index === changedIndex
            ? {
                ...value,
                dependencies: [projects[dependencyIndex].id],
                dependencyDetails: [
                  {
                    evidence: `${value.root}/BUILD.bazel`,
                    provenance: 'declared' as const,
                    targetId: projects[dependencyIndex].id,
                  },
                ],
              }
            : value,
        );

        expect(
          assessCodeGraphWorkspaceCompatibility(workspace('base', projects), workspace('current', changed)),
        ).toEqual({mode: 'project-closure', seedProjectIds: [projects[changedIndex].id]});
      }),
      {numRuns: 100},
    );
  });

  it('fails closed when project ownership is added or removed', () => {
    fc.assert(
      fc.property(fc.integer({max: 12, min: 1}), projectCount => {
        const projects = Array.from({length: projectCount}, (_, index) => project(index));
        expect(
          assessCodeGraphWorkspaceCompatibility(workspace('base', projects), workspace('current', projects.slice(1))),
        ).toEqual({mode: 'fallback', reason: 'workspace-changed'});
      }),
      {numRuns: 50},
    );
  });

  it('models a nested declared package addition over unchanged files in both versions', () => {
    const parent = nodeProject('parent', 'packages');
    const child = nodeProject('child', 'packages/child');
    const files = [
      transitionFile('packages/child/src/index.ts', 1, ['typescript'], true),
      transitionFile('packages/other.ts'),
    ];
    const result = classifyWorkspaceTransition({
      base: side([parent], files),
      current: side([parent, child], files),
      resolverExtractorContextUnchanged: true,
    });
    expect(result).toMatchObject({
      mode: 'eligible',
      addedProjectIds: ['child'],
      removedProjectIds: [],
      ownerChangedPaths: ['packages/child/src/index.ts'],
    });
    if (result.mode === 'eligible') {
      expect(result.baseAffectedPaths).toContain('packages/child/src/index.ts');
      expect(result.currentAffectedPaths).toContain('packages/child/src/index.ts');
    }
  });

  it('keeps removed and replacement project versions separate and closes reverse dependents on each side', () => {
    const consumer = nodeProject('consumer', 'packages/consumer', ['old']);
    const currentConsumer = nodeProject('consumer', 'packages/consumer', ['new']);
    const old = nodeProject('old', 'packages/lib');
    const replacement = nodeProject('new', 'packages/lib');
    const files = [
      transitionFile('packages/consumer/index.ts'),
      transitionFile('packages/lib/index.ts', 1, ['typescript'], true),
    ];
    const result = classifyWorkspaceTransition({
      base: side([consumer, old], files),
      current: side([currentConsumer, replacement], files),
      resolverExtractorContextUnchanged: true,
    });
    expect(result).toMatchObject({
      mode: 'eligible',
      addedProjectIds: ['new'],
      removedProjectIds: ['old'],
      semanticChangedProjectIds: ['consumer'],
      ownerChangedPaths: ['packages/lib/index.ts'],
    });
    if (result.mode === 'eligible') {
      expect(result.baseProjectClosureIds).toContain('consumer');
      expect(result.currentProjectClosureIds).toContain('new');
      expect(result.baseProjectClosureIds).not.toContain('new');
      expect(result.currentProjectClosureIds).not.toContain('old');
    }
  });

  it('reparents unchanged files to the parent when a nested package boundary is removed', () => {
    const parent = nodeProject('parent', 'packages');
    const nested = nodeProject('nested', 'packages/nested');
    const consumerBefore = nodeProject('consumer', 'apps/consumer', ['nested']);
    const consumerAfter = nodeProject('consumer', 'apps/consumer');
    const files = [transitionFile('packages/nested/kept.ts', 4), transitionFile('apps/consumer/index.ts', 2)];
    const result = classifyWorkspaceTransition({
      base: side([parent, nested, consumerBefore], files),
      current: side([parent, consumerAfter], files),
      resolverExtractorContextUnchanged: true,
    });
    expect(result).toMatchObject({
      mode: 'eligible',
      removedProjectIds: ['nested'],
      ownerChangedPaths: ['packages/nested/kept.ts'],
      semanticChangedProjectIds: ['consumer'],
    });
    if (result.mode === 'eligible') {
      expect(result.baseAffectedPaths).toEqual(['apps/consumer/index.ts', 'packages/nested/kept.ts']);
      expect(result.currentAffectedPaths).toContain('packages/nested/kept.ts');
    }
  });

  it('is canonical, deterministic and non-mutating under input reordering', () => {
    const projects = [nodeProject('a', 'packages/a'), nodeProject('b', 'packages/b')];
    const files = [transitionFile('packages/a/index.ts'), transitionFile('packages/b/index.ts')];
    const input = {
      base: side(projects, files),
      current: side([...projects, nodeProject('c', 'packages/c')], [...files, transitionFile('packages/c/index.ts')]),
      resolverExtractorContextUnchanged: true,
    };
    const before = structuredClone(input);
    const expected = classifyWorkspaceTransition(input);
    expect(
      classifyWorkspaceTransition({
        ...input,
        base: side([...projects].reverse(), [...files].reverse()),
        current: side([...input.current.workspace.projects].reverse(), [...input.current.files].reverse()),
      }),
    ).toEqual(expected);
    expect(classifyWorkspaceTransition(input)).toEqual(expected);
    expect(input).toEqual(before);
  });

  it('fails closed for duplicate IDs, incomplete dependency evidence and unsupported global changes', () => {
    const pkg = nodeProject('p', 'packages/p');
    const base = side([pkg], [transitionFile('packages/p/index.ts')]);
    expect(
      classifyWorkspaceTransition({
        base,
        current: side([pkg, pkg], base.files),
        resolverExtractorContextUnchanged: true,
      }),
    ).toEqual({mode: 'fallback', reason: 'duplicate-project-id'});
    const broken = {...pkg, dependencies: ['missing']};
    expect(
      classifyWorkspaceTransition({base, current: side([broken], base.files), resolverExtractorContextUnchanged: true}),
    ).toEqual({mode: 'fallback', reason: 'incomplete-project-model'});
    expect(classifyWorkspaceTransition({base, current: base, resolverExtractorContextUnchanged: false})).toEqual({
      mode: 'fallback',
      reason: 'unrelated-workspace-change',
    });
    expect(
      classifyWorkspaceTransition({
        base,
        current: {...base, workspace: {...base.workspace, diagnostics: ['warning']}},
        resolverExtractorContextUnchanged: true,
      }),
    ).toEqual({mode: 'fallback', reason: 'workspace-diagnostics'});
    const declaredBazel = project(0);
    const unsupportedAddition = {
      ...project(1),
      workspaceId: declaredBazel.workspaceId,
      workspaceRoots: declaredBazel.workspaceRoots,
    };
    expect(
      classifyWorkspaceTransition({
        base: side([declaredBazel], []),
        current: side([declaredBazel, unsupportedAddition], []),
        resolverExtractorContextUnchanged: true,
      }),
    ).toEqual({mode: 'fallback', reason: 'unsupported-roster-change'});
    expect(
      classifyWorkspaceTransition({
        base: side([pkg], []),
        current: side([{...pkg, provenance: 'inferred'}], []),
        resolverExtractorContextUnchanged: true,
      }),
    ).toEqual({mode: 'fallback', reason: 'incomplete-project-model'});
    expect(
      classifyWorkspaceTransition({
        base,
        current: side([pkg], [{...transitionFile('packages/p/index.ts'), resolutionDomains: ['other']}]),
        resolverExtractorContextUnchanged: true,
      }),
    ).toEqual({mode: 'fallback', reason: 'unowned-path'});
    const duplicateRoot = side([pkg, nodeProject('duplicate-root', pkg.root)], base.files);
    expect(
      classifyWorkspaceTransition({
        base: duplicateRoot,
        current: duplicateRoot,
        resolverExtractorContextUnchanged: true,
      }),
    ).toEqual({mode: 'fallback', reason: 'ambiguous-owner'});
    const changedWorkspace = {
      ...base,
      workspace: {...base.workspace, workspaces: base.workspace.workspaces.map(value => ({...value, name: 'changed'}))},
    };
    expect(
      classifyWorkspaceTransition({base, current: changedWorkspace, resolverExtractorContextUnchanged: true}),
    ).toEqual({mode: 'fallback', reason: 'unrelated-workspace-change'});
  });

  it('refuses incomplete dependency evidence even when both workspace versions are identical', () => {
    const broken = {...nodeProject('p', 'packages/p'), dependencies: ['missing']};
    const unchanged = side([broken], [transitionFile('packages/p/index.ts')]);
    expect(
      classifyWorkspaceTransition({base: unchanged, current: unchanged, resolverExtractorContextUnchanged: true}),
    ).toEqual({mode: 'fallback', reason: 'incomplete-project-model'});
  });

  it('reports an empty valid transition explicitly', () => {
    const pkg = nodeProject('p', 'packages/p');
    expect(
      classifyWorkspaceTransition({
        base: side([pkg], [transitionFile('packages/p/index.ts')]),
        current: side([pkg], [transitionFile('packages/p/index.ts')]),
        resolverExtractorContextUnchanged: true,
      }),
    ).toEqual({mode: 'unchanged'});
  });

  it('supports the empty repository root and uses source roots before all project roots', () => {
    const rootProject = nodeProject('root', '');
    const nested = {...nodeProject('nested', 'packages/nested'), sourceRoots: []};
    const path = 'packages/nested/src/file.ts';
    const file = transitionFile(path, 1, ['typescript'], true);
    const result = classifyWorkspaceTransition({
      base: side([rootProject], [file]),
      current: side([rootProject, nested], [file]),
      resolverExtractorContextUnchanged: true,
    });
    expect(result).toMatchObject({mode: 'eligible', addedProjectIds: ['nested'], ownerChangedPaths: []});
  });

  it('fails closed when either ownership inventory is incomplete', () => {
    const pkg = nodeProject('p', 'packages/p');
    const complete = side([pkg], [transitionFile('packages/p/index.ts')]);
    expect(
      classifyWorkspaceTransition({
        base: {...complete, inventoryComplete: false},
        current: complete,
        resolverExtractorContextUnchanged: true,
      }),
    ).toEqual({mode: 'fallback', reason: 'incomplete-inventory'});
  });

  it('applies exact file and source byte bounds', () => {
    const parent = nodeProject('parent', 'packages');
    const child = nodeProject('child', 'packages/child');
    const files = [transitionFile('packages/child/a.ts', 3), transitionFile('packages/child/b.ts', 5)];
    const input = {
      base: side([parent], files),
      current: side([parent, child], files),
      resolverExtractorContextUnchanged: true,
    };
    expect(classifyWorkspaceTransition({...input, maxFiles: 2, maxSourceBytes: 8}).mode).toBe('eligible');
    expect(classifyWorkspaceTransition({...input, maxFiles: 1, maxSourceBytes: 8})).toEqual({
      mode: 'fallback',
      reason: 'closure-over-budget',
    });
    expect(classifyWorkspaceTransition({...input, maxFiles: 2, maxSourceBytes: 7})).toEqual({
      mode: 'fallback',
      reason: 'closure-over-budget',
    });
    expect(classifyWorkspaceTransition({...input, maxFiles: Number.POSITIVE_INFINITY})).toEqual({
      mode: 'fallback',
      reason: 'closure-over-budget',
    });
    expect(classifyWorkspaceTransition({...input, maxFiles: 129})).toEqual({
      mode: 'fallback',
      reason: 'closure-over-budget',
    });
  });

  it('always reports generated nested ownership changes independent of inventory order', () => {
    fc.assert(
      fc.property(fc.integer({min: 1, max: 50_000}), suffix => {
        const path = `packages/p${suffix}/src/index.ts`;
        const parent = nodeProject(`parent${suffix}`, 'packages');
        const child = nodeProject(`child${suffix}`, `packages/p${suffix}`);
        const files = [transitionFile(path, 1, ['typescript'], true), transitionFile(`packages/p${suffix}/README.md`)];
        const result = classifyWorkspaceTransition({
          base: side([parent], files),
          current: side([child, parent], [...files].reverse()),
          resolverExtractorContextUnchanged: true,
        });
        expect(result.mode).toBe('eligible');
        if (result.mode === 'eligible') expect(result.ownerChangedPaths).toEqual(files.map(file => file.path).sort());
      }),
      {numRuns: 75},
    );
  });
});

function nodeProject(id: string, root: string, dependencies: readonly string[] = []): CodeGraphWorkspaceProject {
  return {
    ...project(0),
    buildSystem: 'node',
    dependencies,
    dependencyDetails: dependencies.map(targetId => ({
      evidence: `${root}/package.json`,
      provenance: 'declared' as const,
      targetId,
    })),
    id,
    name: id,
    resolutionDomain: 'typescript',
    root,
    sourceRoots: [root],
    workspaceId: 'node-workspace',
    workspaceRoots: ['packages'],
  };
}
function transitionFile(path: string, size = 1, resolutionDomains = ['typescript'], hasWorkspacePackageSymbol = false) {
  return {path, size, resolutionDomains, hasWorkspacePackageSymbol};
}
function side(projects: readonly CodeGraphWorkspaceProject[], files: readonly ReturnType<typeof transitionFile>[]) {
  const workspaces = [
    ...new Map(
      projects.map(value => [
        value.workspaceId,
        {
          buildSystem: value.buildSystem,
          diagnostics: [],
          id: value.workspaceId,
          name: value.workspaceId,
          provenance: 'declared' as const,
          root: value.workspaceRoots[0] ?? value.root,
        },
      ]),
    ).values(),
  ];
  return {workspace: {diagnostics: [], fingerprint: 'test', projects, workspaces}, files, inventoryComplete: true};
}

function project(index: number): CodeGraphWorkspaceProject {
  const root = `apps/bazel-${index}`;
  return {
    buildSystem: 'bazel',
    dependencies: [],
    dependencyDetails: [],
    diagnostics: [],
    id: `project-${index}`,
    kind: 'package',
    languages: ['bazel', 'starlark'],
    name: `//app-${index}`,
    provenance: 'declared',
    resolutionDomain: 'bazel',
    root,
    sourceRoots: [root],
    workspaceId: `workspace-${index}`,
    workspaceRoots: [root],
  };
}

function workspace(fingerprint: string, projects: readonly CodeGraphWorkspaceProject[]): CodeGraphWorkspace {
  return {diagnostics: [], fingerprint, projects, workspaces: []};
}
