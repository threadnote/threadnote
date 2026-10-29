import {Array as EffectArray} from 'effect';
import {describe, expect, it} from '@effect/vitest';
import * as FC from 'fast-check';
import {fcProp} from '@threadnote/testing/fast-check-property';
import {
  CodeGraphIndexScopeResolutionError,
  CODE_GRAPH_FULL_REPOSITORY_SCOPE_KEY,
  forwardDependencyClosure,
  previewCodeGraphIndexScope,
  resolveCodeGraphIndexScope,
  type CodeGraphWorkspaceCatalog,
} from '@threadnote/graph/index_scope';
import type {CodeGraphWorkspaceProject} from '@threadnote/graph/languages/types';
import type {CodeGraphInventoryFile} from '@threadnote/graph/types';
import {discoverBazelWorkspace, discoverManifestWorkspace} from '@threadnote/graph/workspace';
import {
  codeGraphWorkspaceProjectsForDiagnostic,
  createCodeGraphWorkspaceDiagnosticIndex,
  resolveCodeGraphWorkspaceDiagnostics,
} from '@threadnote/graph/workspace/diagnostics';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';
import {Option as EffectOption} from 'effect';

const project = (id: string, root: string, dependencies: readonly string[] = []) =>
  ({
    buildSystem: 'typescript',
    dependencies,
    dependencyDetails: EffectArray.map(dependencies, targetId => ({
      evidence: `${root}/tsconfig.json`,
      provenance: 'declared' as const,
      targetId,
    })),
    diagnostics: [],
    id,
    kind: 'project',
    languages: ['typescript'],
    name: id,
    provenance: 'declared',
    resolutionDomain: 'typescript',
    root,
    sourceRoots: [`${root}/src`],
    workspaceId: 'workspace',
    workspaceRoots: [''],
  }) satisfies CodeGraphWorkspaceProject;

const catalog = (projects: readonly CodeGraphWorkspaceProject[]): CodeGraphWorkspaceCatalog => ({
  fingerprint: 'catalog',
  resolutionContextPaths: ['tsconfig.json', ...EffectArray.map(projects, value => `${value.root}/tsconfig.json`)],
  workspace: {diagnostics: [], fingerprint: 'workspace', projects, workspaces: []},
});

const workspaceFile = (path: string, content: string, language: string): CodeGraphInventoryFile => ({
  blobId: `blob-${path}`,
  content,
  contentHash: `hash-${path}`,
  language,
  mode: '100644',
  path,
  size: Buffer.byteLength(content),
  source: 'commit',
});

function naiveDiagnosticProjects(
  projects: readonly CodeGraphWorkspaceProject[],
  diagnostic: string,
): readonly CodeGraphWorkspaceProject[] {
  const evidencePath = Effect.pipe(
    diagnostic,
    EffectString.slice(
      0,
      Effect.pipe(
        diagnostic,
        EffectString.indexOf(':'),
        Effect.Option.getOrElse(() => -1),
      ),
    ),
  );
  const specificityById = new Map(
    EffectArray.map(projects, project => {
      const specificity = Math.max(
        -1,
        ...EffectArray.map(
          EffectArray.filter(
            [project.root, ...project.sourceRoots],
            prefix =>
              prefix === '' ||
              evidencePath === prefix ||
              Effect.pipe(evidencePath, EffectString.startsWith(`${prefix}/`)),
          ),
          prefix => (prefix === '' ? 0 : Effect.pipe(prefix, EffectString.split('/')).length),
        ),
      );
      return [project.id, specificity] as const;
    }),
  );
  const maximum = Math.max(-1, ...specificityById.values());
  if (maximum < 0) return [];
  return EffectArray.filter(projects, project => specificityById.get(project.id) === maximum);
}

describe('code graph index scope', () => {
  it('retains every component at a configured root and only follows forward dependencies', () => {
    const appNode = project('app-node', 'apps/web', ['core']);
    const appTypeScript = project('app-typescript', 'apps/web', ['core']);
    const core = project('core', 'packages/core');
    const reverseDependent = project('reverse-dependent', 'apps/other', ['app-node']);
    const scope = resolveCodeGraphIndexScope(
      {graph: {closure: 'dependencies', roots: ['apps/web']}, uri: 'threadnote://resources/repos/web'},
      catalog([reverseDependent, appTypeScript, core, appNode]),
    );

    expect(scope.rootProjectIds).toEqual(['app-node', 'app-typescript']);
    expect(scope.includedProjectIds).toEqual(['app-node', 'app-typescript', 'core']);
    expect(scope.admittedPrefixes).toEqual(['apps/web', 'apps/web/src', 'packages/core', 'packages/core/src']);
    expect(scope.controlPaths).toEqual(['apps/web/tsconfig.json', 'packages/core/tsconfig.json', 'tsconfig.json']);
  });

  it('keeps scope identity stable across configured root order and emits a preview model', () => {
    const workspace = catalog([project('app', 'apps/app', ['core']), project('core', 'packages/core')]);
    const first = previewCodeGraphIndexScope(
      {graph: {closure: 'dependencies', roots: ['apps/app', 'packages/core']}, uri: 'threadnote://resources/repos/app'},
      workspace,
    );
    const second = previewCodeGraphIndexScope(
      {graph: {closure: 'dependencies', roots: ['packages/core', 'apps/app']}, uri: 'threadnote://resources/repos/app'},
      workspace,
    );

    expect(second).toEqual(first);
    expect(first).toMatchObject({type: 'code-graph-index-scope-preview', version: 1});
  });

  it('uses the canonical full-repository identity independent of project URI', () => {
    const workspace = catalog([project('app', 'apps/app')]);
    expect(resolveCodeGraphIndexScope({uri: 'threadnote://resources/repos/one'}, workspace).scopeKey).toBe(
      CODE_GRAPH_FULL_REPOSITORY_SCOPE_KEY,
    );
    expect(resolveCodeGraphIndexScope({uri: 'threadnote://resources/repos/two'}, workspace).scopeKey).toBe(
      CODE_GRAPH_FULL_REPOSITORY_SCOPE_KEY,
    );
  });

  it('fails unresolved roots with bounded candidates and marks incomplete evidence partial', () => {
    const incomplete = {...project('app', 'apps/app'), provenance: 'inferred' as const};
    const workspace = catalog([incomplete, project('core', 'packages/core')]);
    expect(
      resolveCodeGraphIndexScope({graph: {closure: 'dependencies', roots: ['apps/app']}, uri: 'x'}, workspace),
    ).toMatchObject({
      completeness: 'partial',
    });
    expect(() =>
      resolveCodeGraphIndexScope({graph: {closure: 'dependencies', roots: ['missing']}, uri: 'x'}, workspace),
    ).toThrow(CodeGraphIndexScopeResolutionError);
  });

  it('rejects unpersistable project membership before a graph build can start', () => {
    const oversizedId = (index: number) =>
      `${Effect.pipe(index.toString(), EffectString.padStart(6, '0'))}${Effect.pipe('x', EffectString.repeat(4_090))}`;
    const dependencyIds = Array.from({length: 1_024}, (_, index) => oversizedId(index + 1));
    const root = project(oversizedId(0), 'apps/app', dependencyIds);
    const dependencies = EffectArray.map(dependencyIds, (id, index) => project(id, `packages/dependency-${index}`));

    expect(() =>
      resolveCodeGraphIndexScope(
        {graph: {closure: 'dependencies', roots: ['apps/app']}, uri: 'threadnote://resources/repos/app'},
        catalog([root, ...dependencies]),
      ),
    ).toThrow(CodeGraphIndexScopeResolutionError);
  });

  it('binds effective control paths and completeness evidence into the closure digest', () => {
    const app = project('app', 'apps/app');
    const complete = resolveCodeGraphIndexScope(
      {graph: {closure: 'dependencies', roots: ['apps/app']}, uri: 'threadnote://resources/repos/app'},
      catalog([app]),
    );
    const changedControls = resolveCodeGraphIndexScope(
      {graph: {closure: 'dependencies', roots: ['apps/app']}, uri: 'threadnote://resources/repos/app'},
      {...catalog([app]), resolutionContextPaths: ['apps/app/alternate.config']},
    );
    const partial = resolveCodeGraphIndexScope(
      {graph: {closure: 'dependencies', roots: ['apps/app']}, uri: 'threadnote://resources/repos/app'},
      {...catalog([app]), workspace: {...catalog([app]).workspace, diagnostics: ['detector incomplete']}},
    );

    expect(complete.completeness).toBe('complete');
    expect(partial.completeness).toBe('partial');
    expect(changedControls.closureDigest).not.toBe(complete.closureDigest);
    expect(partial.closureDigest).not.toBe(complete.closureDigest);
  });

  it('keeps non-blocking package identity diagnostics from weakening scope completeness', () => {
    const app = project('app', 'apps/app');
    const scope = resolveCodeGraphIndexScope(
      {graph: {closure: 'dependencies', roots: ['apps/app']}, uri: 'threadnote://resources/repos/app'},
      {
        ...catalog([app]),
        workspace: {
          ...catalog([app]).workspace,
          diagnostics: ['apps/app/package.json: npm package name cannot form a package moniker'],
        },
      },
    );

    expect(scope.completeness).toBe('complete');
    expect(scope.diagnostics).toEqual(['apps/app/package.json: npm package name cannot form a package moniker']);
  });

  it('collapses repeated diagnostic classes before applying the scope output bound', () => {
    const app = project('app', 'apps/app');
    const scope = resolveCodeGraphIndexScope(
      {graph: {closure: 'dependencies', roots: ['apps/app']}, uri: 'threadnote://resources/repos/app'},
      {
        ...catalog([app]),
        workspace: {
          ...catalog([app]).workspace,
          diagnostics: Array.from(
            {length: 150},
            (_, index) => `apps/app/package-${index}.json: npm package name cannot form a package moniker`,
          ),
        },
      },
    );

    expect(scope.completeness).toBe('complete');
    expect(scope.diagnostics).toEqual([
      'apps/app/package-0.json: npm package name cannot form a package moniker (150 occurrences)',
    ]);
  });

  it('keeps unrelated workspace diagnostics out of a selected project scope', () => {
    const app = project('app', 'apps/app');
    const workspace = catalog([app, project('other', 'apps/other')]);
    const selected = resolveCodeGraphIndexScope(
      {graph: {closure: 'dependencies', roots: ['apps/app']}, uri: 'threadnote://resources/repos/app'},
      {
        ...workspace,
        workspace: {
          ...workspace.workspace,
          diagnostics: [
            'apps/app/tsconfig.json: selected project is incomplete',
            'apps/other/tsconfig.json: unrelated project is incomplete',
          ],
        },
      },
    );

    expect(selected.completeness).toBe('partial');
    expect(selected.diagnostics).toEqual(['apps/app/tsconfig.json: selected project is incomplete']);
  });

  it('indexes the most-specific diagnostic projects once, retaining equal-specificity matches', () => {
    const diagnostic = 'apps/app/src/index.ts: invalid TypeScript config';
    const resolution = resolveCodeGraphWorkspaceDiagnostics(
      [
        project('parent', 'apps'),
        {...project('left', 'components/left'), sourceRoots: ['apps/app/src']},
        {...project('right', 'components/right'), sourceRoots: ['apps/app/src']},
      ],
      [diagnostic, diagnostic, 'pathless diagnostic'],
    );

    expect(resolution.diagnostics).toEqual([diagnostic, 'pathless diagnostic']);
    expect([...resolution.projectsByDiagnostic.keys()]).toEqual([diagnostic, 'pathless diagnostic']);
    expect(
      EffectOption.getOrUndefined(
        EffectOption.map(
          EffectOption.fromNullishOr(resolution.projectsByDiagnostic.get(diagnostic)),
          __effectArrayReceiver => EffectArray.map(__effectArrayReceiver, candidate => candidate.id),
        ),
      ),
    ).toEqual(['left', 'right']);
    expect(EffectArray.map(resolution.projects, candidate => [candidate.id, candidate.diagnostics])).toEqual([
      ['parent', []],
      ['left', [diagnostic]],
      ['right', [diagnostic]],
    ]);
  });

  it('preserves a selected diagnostic beyond the global workspace diagnostic bound', () => {
    const files: CodeGraphInventoryFile[] = [];
    for (let index = 0; index < 105; index += 1) {
      const root = `apps/a-${Effect.pipe(String(index), EffectString.padStart(3, '0'))}`;
      files.push(
        workspaceFile(`${root}/package.json`, JSON.stringify({name: `@fixture/a-${index}`}), 'npm-manifest'),
        workspaceFile(`${root}/tsconfig.json`, '{invalid', 'typescript-config'),
      );
    }
    files.push(
      workspaceFile('apps/z-selected/package.json', JSON.stringify({name: '@fixture/selected'}), 'npm-manifest'),
      workspaceFile('apps/z-selected/tsconfig.json', '{selected-invalid', 'typescript-config'),
    );
    const workspace = discoverManifestWorkspace(files);
    const selected = resolveCodeGraphIndexScope(
      {graph: {closure: 'dependencies', roots: ['apps/z-selected']}, uri: 'threadnote://resources/repos/selected'},
      {
        fingerprint: workspace.fingerprint,
        resolutionContextPaths: EffectArray.map(files, file => file.path),
        workspace,
      },
    );

    expect(workspace.diagnostics).toEqual([
      expect.stringMatching(/^apps\/a-000\/tsconfig\.json: invalid TypeScript config.*\(106 occurrences\)$/u),
    ]);
    expect(
      EffectArray.some(workspace.diagnostics, diagnostic =>
        Effect.pipe(diagnostic, EffectString.startsWith('apps/z-selected/')),
      ),
    ).toBe(false);
    expect(selected.completeness).toBe('partial');
    expect(selected.diagnostics).toEqual([
      expect.stringMatching(/^apps\/z-selected\/tsconfig\.json: invalid TypeScript config/u),
    ]);
  });

  it('preserves a selected Bazel diagnostic beyond the global workspace diagnostic bound', () => {
    const files: CodeGraphInventoryFile[] = [];
    for (let index = 0; index < 101; index += 1) {
      const root = `apps/a-${Effect.pipe(String(index), EffectString.padStart(3, '0'))}`;
      files.push(
        workspaceFile(
          `${root}/BUILD`,
          `cc_library(name = "a-${index}", deps = ["//missing-a-${index}:target"])`,
          'bazel-build',
        ),
      );
    }
    files.push(
      workspaceFile(
        'apps/z-selected/BUILD',
        'cc_library(name = "selected", deps = ["//missing-selected:target"])',
        'bazel-build',
      ),
    );
    const workspace = discoverBazelWorkspace(files);
    const selected = resolveCodeGraphIndexScope(
      {graph: {closure: 'dependencies', roots: ['apps/z-selected']}, uri: 'threadnote://resources/repos/selected'},
      {
        fingerprint: workspace.fingerprint,
        resolutionContextPaths: EffectArray.map(files, file => file.path),
        workspace,
      },
    );

    expect(workspace.diagnostics).toHaveLength(100);
    expect(
      EffectArray.some(workspace.diagnostics, diagnostic =>
        Effect.pipe(diagnostic, EffectString.startsWith('apps/z-selected/')),
      ),
    ).toBe(false);
    expect(selected.completeness).toBe('partial');
    expect(selected.diagnostics).toEqual([
      'apps/z-selected/BUILD: local Bazel package //missing-selected was not indexed',
    ]);
  });

  fcProp(
    it,
    'leaves scope identity complete when only an unrelated component reports a diagnostic',
    {suffix: FC.stringMatching(/^[a-z]{1,8}$/)},
    ({suffix}) => {
      const app = project('app', 'apps/app');
      const workspace = catalog([app, project('other', `packages/${suffix}`)]);
      const complete = resolveCodeGraphIndexScope(
        {graph: {closure: 'dependencies', roots: ['apps/app']}, uri: 'threadnote://resources/repos/app'},
        workspace,
      );
      const unrelated = resolveCodeGraphIndexScope(
        {graph: {closure: 'dependencies', roots: ['apps/app']}, uri: 'threadnote://resources/repos/app'},
        {
          ...workspace,
          workspace: {
            ...workspace.workspace,
            diagnostics: [`packages/${suffix}/tsconfig.json: unrelated diagnostic`],
          },
        },
      );

      expect(unrelated).toEqual(complete);
    },
    {fastCheck: {numRuns: 100}},
  );

  fcProp(
    it,
    'matches a naive longest-prefix model and ignores duplicate diagnostics',
    {
      evidenceSelections: FC.array(FC.integer({min: 0, max: 15}), {minLength: 1, maxLength: 8}),
      projectRootSelections: FC.array(FC.integer({min: 0, max: 15}), {minLength: 1, maxLength: 6}),
      sourceRootSelections: FC.array(FC.array(FC.integer({min: 0, max: 15}), {minLength: 0, maxLength: 3}), {
        minLength: 1,
        maxLength: 6,
      }),
      segments: FC.uniqueArray(FC.stringMatching(/^[a-z]{1,6}$/), {minLength: 2, maxLength: 4}),
    },
    ({evidenceSelections, projectRootSelections, segments, sourceRootSelections}) => {
      const paths = EffectArray.map(segments, (_segment, index) => EffectArray.join(segments.slice(0, index + 1), '/'));
      const projects = EffectArray.map(
        projectRootSelections,
        (selection, index) =>
          ({
            ...project(`project-${index}`, paths[selection % paths.length]),
            sourceRoots: EffectArray.map(
              sourceRootSelections[index % sourceRootSelections.length],
              sourceSelection => paths[sourceSelection % paths.length],
            ),
          }) satisfies CodeGraphWorkspaceProject,
      );
      const diagnostics = EffectArray.map(
        evidenceSelections,
        (selection, index) => `${paths[selection % paths.length]}/evidence-${index}: diagnostic`,
      );
      const orderedDiagnostics = [...diagnostics].sort();
      const index = createCodeGraphWorkspaceDiagnosticIndex(projects);
      const resolution = resolveCodeGraphWorkspaceDiagnostics(projects, diagnostics);
      const expectedMatches = EffectArray.map(diagnostics, diagnostic =>
        EffectArray.map(naiveDiagnosticProjects(projects, diagnostic), project => project.id),
      );

      expect(
        EffectArray.map(diagnostics, diagnostic =>
          EffectArray.map(codeGraphWorkspaceProjectsForDiagnostic(index, diagnostic), project => project.id),
        ),
      ).toEqual(expectedMatches);
      expect(
        EffectArray.map([...resolution.projectsByDiagnostic.entries()], ([diagnostic, matches]) => [
          diagnostic,
          EffectArray.map(matches, project => project.id),
        ]),
      ).toEqual(
        EffectArray.map(orderedDiagnostics, diagnostic => [
          diagnostic,
          EffectArray.map(naiveDiagnosticProjects(projects, diagnostic), project => project.id),
        ]),
      );
      expect(EffectArray.map(resolution.projects, project => [project.id, project.diagnostics])).toEqual(
        EffectArray.map(projects, project => [
          project.id,
          EffectArray.filter(
            orderedDiagnostics,
            (diagnostic, __effectArrayIndex) =>
              __effectArrayIndex in orderedDiagnostics &&
              EffectArray.some(naiveDiagnosticProjects(projects, diagnostic), match => match.id === project.id),
          ),
        ]),
      );
      expect(resolveCodeGraphWorkspaceDiagnostics(projects, [...diagnostics, ...diagnostics])).toEqual(resolution);
    },
    {fastCheck: {numRuns: 80}},
  );

  fcProp(
    it,
    'matches only path boundaries and leaves unreachable additions outside the forward closure',
    {suffix: FC.stringMatching(/^[a-z]{1,8}$/)},
    ({suffix}) => {
      const root = `apps/${suffix}`;
      const adjacent = `${root}bar`;
      const selected = project('selected', root, ['dependency']);
      const dependency = project('dependency', `packages/${suffix}`);
      const unreachable = project('unreachable', adjacent);
      const scope = resolveCodeGraphIndexScope(
        {graph: {closure: 'dependencies', roots: [root]}, uri: 'threadnote://resources/repos/property'},
        catalog([selected, dependency, unreachable]),
      );
      expect(scope.includedProjectIds).toEqual(['selected', 'dependency']);
      expect(
        EffectArray.map(forwardDependencyClosure([selected], [unreachable, dependency, selected]), value => value.id),
      ).toEqual(['selected', 'dependency']);
    },
    {fastCheck: {numRuns: 100}},
  );

  fcProp(
    it,
    'normalizes root order and duplicate inputs without changing scope identity',
    {reverse: FC.boolean(), repeat: FC.boolean()},
    ({reverse, repeat}) => {
      const workspace = catalog([project('app', 'apps/app', ['core']), project('core', 'packages/core')]);
      const roots = reverse ? ['packages/core', 'apps/app'] : ['apps/app', 'packages/core'];
      const scoped = resolveCodeGraphIndexScope(
        {
          graph: {closure: 'dependencies', roots: repeat ? [...roots, roots[0]] : roots},
          uri: 'threadnote://resources/repos/property',
        },
        workspace,
      );
      const canonical = resolveCodeGraphIndexScope(
        {
          graph: {closure: 'dependencies', roots: ['apps/app', 'packages/core']},
          uri: 'threadnote://resources/repos/property',
        },
        workspace,
      );
      expect(scoped).toEqual(canonical);
    },
    {fastCheck: {numRuns: 60}},
  );

  fcProp(
    it,
    'expands monotonically for added forward dependencies while excluding reverse dependents',
    {suffix: FC.stringMatching(/^[a-z]{1,8}$/)},
    ({suffix}) => {
      const app = project('app', `apps/${suffix}`, ['core']);
      const core = project('core', `packages/${suffix}/core`);
      const utility = project('utility', `packages/${suffix}/utility`);
      const reverse = project('reverse', `apps/${suffix}-reverse`, ['app']);
      const before = resolveCodeGraphIndexScope(
        {graph: {closure: 'dependencies', roots: [app.root]}, uri: 'threadnote://resources/repos/property'},
        catalog([app, core, utility, reverse]),
      );
      const expandedCore = project('core', core.root, ['utility']);
      const after = resolveCodeGraphIndexScope(
        {graph: {closure: 'dependencies', roots: [app.root]}, uri: 'threadnote://resources/repos/property'},
        catalog([app, expandedCore, utility, reverse]),
      );

      expect(EffectArray.every(before.includedProjectIds, id => after.includedProjectIds.includes(id))).toBe(true);
      expect(after.includedProjectIds).toEqual(['app', 'core', 'utility']);
      expect(after.includedProjectIds).not.toContain('reverse');
    },
    {fastCheck: {numRuns: 60}},
  );
});
