import {Array as EffectArray, Option as EffectOption} from 'effect';
import {fcProp} from '@threadnote/testing/fast-check-property';
import {describe, expect, it} from '@effect/vitest';
import * as FC from 'fast-check';
import type {
  CodeGraphWorkspace,
  CodeGraphWorkspaceDependency,
  CodeGraphWorkspaceProject,
} from '@threadnote/graph/languages/types';
import type {CodeGraphFileFacts, CodeGraphInventoryFile, CodeGraphSymbol} from '@threadnote/graph/types';
import {
  createWorkspaceAttributor,
  discoverBazelWorkspace,
  discoverManifestWorkspace,
  mergeCodeGraphWorkspaces,
  workspaceHasUninventoriedMonikerEvidence,
} from '@threadnote/graph/workspace';

const files = [
  workspaceFile(
    'settings.gradle.kts',
    `
      rootProject.name = "platform"
      include(":libs:shared", ":apps:app")
      project(":libs:shared").projectDir = file("libs/shared")
      project(":apps:app").projectDir = file("apps/app")
    `,
  ),
  workspaceFile('build.gradle.kts', 'plugins { kotlin("jvm") version "2.0.0" }'),
  workspaceFile('libs/shared/build.gradle.kts', 'plugins { kotlin("jvm") }'),
  workspaceFile('libs/shared/src/main/kotlin/Shared.kt', 'class Shared', 'kotlin'),
  workspaceFile('apps/app/settings.gradle.kts', 'rootProject.name = "nested-app"\ninclude(":feature")'),
  workspaceFile(
    'apps/app/build.gradle.kts',
    'plugins { kotlin("jvm") }\ndependencies { implementation(project(":libs:shared")) }',
  ),
  workspaceFile('apps/app/src/main/kotlin/App.kt', 'class App', 'kotlin'),
  workspaceFile('apps/app/feature/build.gradle.kts', 'plugins { kotlin("jvm") }'),
  workspaceFile('apps/app/feature/src/main/kotlin/Feature.kt', 'class Feature', 'kotlin'),
  workspaceFile(
    'services/orders/pom.xml',
    '<project><groupId>dev.threadnote</groupId><artifactId>orders</artifactId><modules><module>api</module></modules></project>',
    'xml',
  ),
  workspaceFile(
    'services/orders/api/pom.xml',
    '<project><parent><groupId>dev.threadnote</groupId><artifactId>orders</artifactId></parent><artifactId>api</artifactId></project>',
    'xml',
  ),
  workspaceFile('services/orders/api/src/main/java/dev/threadnote/Api.java', 'class Api {}', 'java'),
  workspaceFile(
    'ios/Package.swift',
    'let package = Package(name: "Mobile", targets: [.target(name: "MobileCore"), .testTarget(name: "MobileCoreTests", dependencies: ["MobileCore"])])',
    'swift',
  ),
  workspaceFile('ios/Sources/MobileCore/Client.swift', 'struct Client {}', 'swift'),
  workspaceFile('ios/Tests/MobileCoreTests/ClientTests.swift', 'struct ClientTests {}', 'swift'),
] as const;

const permutedFiles = FC.array(FC.integer({max: 10_000, min: -10_000}), {
  maxLength: files.length,
  minLength: files.length,
}).map(priorities =>
  EffectArray.map(
    EffectArray.map(files, (file, index) => ({file, index, priority: priorities[index]})).sort(
      (left, right) => left.priority - right.priority || left.index - right.index,
    ),
    item => item.file,
  ),
);

const shortText = FC.array(FC.constantFrom('a', 'Z', '0', '-', '_', 'é', '漢', '🙂'), {
  maxLength: 8,
  minLength: 1,
}).map(characters => EffectArray.join(characters, ''));

const dependencyArbitrary = FC.record({
  evidence: FC.oneof(FC.constant(undefined), shortText),
  provenance: FC.constantFrom<'declared' | 'inferred'>('declared', 'inferred'),
  targetId: FC.constantFrom('cgp_shared', 'cgp_a', 'cgp_b'),
}).map(
  value =>
    ({
      ...(value.evidence === undefined ? {} : {evidence: value.evidence}),
      provenance: value.provenance,
      targetId: value.targetId,
    }) satisfies CodeGraphWorkspaceDependency,
);

const sharedProjectArbitrary = FC.record({
  buildSystem: FC.constantFrom<CodeGraphWorkspaceProject['buildSystem']>(
    'gradle',
    'inferred',
    'maven',
    'node',
    'nx',
    'pnpm',
    'swiftpm',
    'typescript',
    'xcode',
  ),
  dependencies: FC.array(FC.constantFrom('cgp_shared', 'cgp_a', 'cgp_b'), {maxLength: 5}),
  dependencyDetails: FC.array(dependencyArbitrary, {maxLength: 5}),
  diagnostics: FC.array(shortText, {maxLength: 4}),
  kind: FC.constantFrom<CodeGraphWorkspaceProject['kind']>('module', 'package', 'project', 'target'),
  languages: FC.array(FC.constantFrom('java', 'kotlin', 'swift'), {maxLength: 5}),
  name: shortText,
  provenance: FC.constantFrom<CodeGraphWorkspaceProject['provenance']>('declared', 'inferred'),
  sourceRoots: FC.array(FC.constantFrom('apps/shared/src', 'apps/shared/Sources', 'apps/shared'), {maxLength: 5}),
  workspaceId: FC.constantFrom('cgw_gradle', 'cgw_maven', 'cgw_swift', 'cgw_xcode'),
  workspaceRoots: FC.array(FC.constantFrom('apps', 'apps/shared'), {maxLength: 4}),
}).map(
  value =>
    ({
      ...value,
      id: 'cgp_shared',
      resolutionDomain: 'shared-domain',
      root: 'apps/shared',
    }) satisfies CodeGraphWorkspaceProject,
);

const workspaceFragmentArbitrary = FC.record({
  diagnostics: FC.array(shortText, {maxLength: 4}),
  fingerprint: shortText,
  project: sharedProjectArbitrary,
}).map(
  ({diagnostics, fingerprint, project}) =>
    ({diagnostics, fingerprint, projects: [project], workspaces: []}) satisfies CodeGraphWorkspace,
);

describe('code graph workspace properties', () => {
  it('treats package export monikers as inventoried only when their evidence file is present', () => {
    const workspace = discoverManifestWorkspace([
      workspaceFile('package.json', JSON.stringify({name: 'root', private: true}), 'npm-manifest'),
      workspaceFile('scratchpad/package.json', JSON.stringify({name: 'scratchpad', private: true}), 'npm-manifest'),
    ]);
    expect(
      workspaceHasUninventoriedMonikerEvidence(workspace, new Set(['package.json', 'scratchpad/package.json'])),
    ).toBe(false);
    expect(workspaceHasUninventoriedMonikerEvidence(workspace, new Set(['package.json']))).toBe(true);
  });

  fcProp(
    it,
    'discovers identical nested and integrated workspace models regardless of inventory order',
    {permuted: permutedFiles},
    ({permuted}) => {
      expect(discoverManifestWorkspace(permuted)).toEqual(discoverManifestWorkspace(files));
    },
    {fastCheck: {numRuns: 150}},
  );

  it('uses the declared project name for a repository-root workspace', () => {
    const workspace = discoverManifestWorkspace([
      workspaceFile(
        'package.json',
        JSON.stringify({name: 'threadnote-root', private: true, workspaces: ['packages/*']}),
        'npm-manifest',
      ),
    ]);

    expect(workspace.workspaces).toContainEqual(expect.objectContaining({name: 'threadnote-root', root: ''}));
  });

  fcProp(
    it,
    'never derives an empty repository-root workspace name from a non-empty declared project name',
    {name: shortText},
    ({name}) => {
      const workspace = discoverManifestWorkspace([
        workspaceFile(
          'package.json',
          JSON.stringify({name, private: true, workspaces: ['packages/*']}),
          'npm-manifest',
        ),
      ]);

      const rootProject = EffectOption.getOrUndefined(
        EffectArray.findFirst(workspace.projects, project => project.root === ''),
      );
      const rootWorkspace = EffectOption.getOrUndefined(
        EffectArray.findFirst(workspace.workspaces, candidate => candidate.root === ''),
      );
      expect(rootProject).toBeDefined();
      expect(rootWorkspace).toBeDefined();
      expect(rootProject!.name).not.toBe('');
      expect(rootWorkspace!.name).toBe(rootProject!.name);
    },
    {fastCheck: {numRuns: 100}},
  );

  it('discovers npm, Bun, pnpm, and TypeScript-reference package hierarchy without hiding nested polyglot workspaces', () => {
    const workspace = discoverManifestWorkspace([
      workspaceFile(
        'package.json',
        JSON.stringify({
          name: 'threadnote-root',
          packageManager: 'bun@1.3.0',
          workspaces: ['packages/*', 'apps/*'],
        }),
        'npm-manifest',
      ),
      workspaceFile('pnpm-workspace.yaml', "packages:\n  - 'tools/*'\n", 'pnpm-workspace'),
      workspaceFile(
        'tsconfig.json',
        `{
          // TypeScript project references are JSONC in real monorepos.
          "references": [
            {"path": "./packages/core",},
            {"path": "./apps/web",},
          ],
        }`,
        'typescript-config',
      ),
      workspaceFile('src/index.ts', 'export const root = true', 'typescript'),
      workspaceFile('packages/core/package.json', JSON.stringify({name: '@acme/core'}), 'npm-manifest'),
      workspaceFile('packages/core/src/index.ts', 'export const core = true', 'typescript'),
      workspaceFile(
        'apps/web/package.json',
        JSON.stringify({dependencies: {'@acme/core': 'workspace:*'}, name: '@acme/web'}),
        'npm-manifest',
      ),
      workspaceFile('apps/web/src/index.ts', 'export const web = true', 'typescript'),
      workspaceFile('tools/release/package.json', JSON.stringify({name: '@acme/release'}), 'npm-manifest'),
      workspaceFile('tools/release/src/index.ts', 'export const release = true', 'typescript'),
      workspaceFile('apps/web/settings.gradle.kts', 'rootProject.name = "mobile"'),
      workspaceFile('apps/web/src/main/kotlin/App.kt', 'class App', 'kotlin'),
    ]);
    const packageProjects = EffectArray.filter(
      workspace.projects,
      project => project.kind === 'package' && (project.buildSystem === 'node' || project.buildSystem === 'pnpm'),
    );
    const root = EffectOption.getOrUndefined(EffectArray.findFirst(packageProjects, project => project.root === ''))!;
    const core = EffectOption.getOrUndefined(
      EffectArray.findFirst(packageProjects, project => project.root === 'packages/core'),
    )!;
    const web = EffectOption.getOrUndefined(
      EffectArray.findFirst(packageProjects, project => project.root === 'apps/web'),
    )!;
    const release = EffectOption.getOrUndefined(
      EffectArray.findFirst(packageProjects, project => project.root === 'tools/release'),
    )!;

    expect(EffectArray.map(packageProjects, project => project.name)).toEqual([
      'threadnote-root',
      '@acme/web',
      '@acme/core',
      '@acme/release',
    ]);
    expect([root.buildSystem, core.buildSystem, web.buildSystem, release.buildSystem]).toEqual([
      'pnpm',
      'node',
      'node',
      'pnpm',
    ]);
    expect(root.workspaceId).toBe(release.workspaceId);
    expect(core.workspaceId).toBe(web.workspaceId);
    expect(root.workspaceId).not.toBe(core.workspaceId);
    expect(root.dependencies).toEqual(expect.arrayContaining([core.id, web.id]));
    expect(web.dependencies).toContain(core.id);
    expect(workspace.projects).toContainEqual(expect.objectContaining({buildSystem: 'gradle', root: 'apps/web'}));

    const attributed = createWorkspaceAttributor(workspace)([
      facts('package.json', [
        {
          ...workspaceSymbol('root-package', 'package.json', 'threadnote-root', 'workspace', 'npm-manifest'),
          kind: 'package',
        },
      ]),
      facts('apps/web/package.json', [
        {
          ...workspaceSymbol('web-package', 'apps/web/package.json', '@acme/web', 'workspace', 'npm-manifest'),
          kind: 'package',
        },
      ]),
      facts('src/index.ts', [workspaceSymbol('root-ts', 'src/index.ts', 'root', 'typescript', 'typescript')]),
      facts('apps/web/src/index.ts', [
        workspaceSymbol('web-ts', 'apps/web/src/index.ts', 'web', 'typescript', 'typescript'),
      ]),
      facts('apps/web/src/main/kotlin/App.kt', [
        workspaceSymbol('web-jvm', 'apps/web/src/main/kotlin/App.kt', 'App', 'jvm', 'kotlin'),
      ]),
    ]);
    const attributedSymbols = EffectArray.flatMap(attributed, file => file.symbols);
    expect(
      EffectOption.getOrUndefined(EffectArray.findFirst(attributedSymbols, symbol => symbol.id === 'root-package'))
        ?.packageName,
    ).toBe('threadnote-root');
    expect(
      EffectOption.getOrUndefined(EffectArray.findFirst(attributedSymbols, symbol => symbol.id === 'web-package'))
        ?.packageName,
    ).toBe('@acme/web');
    expect(
      EffectOption.getOrUndefined(EffectArray.findFirst(attributedSymbols, symbol => symbol.id === 'root-ts'))
        ?.resolutionScopeId,
    ).toBe(root.id);
    expect(
      EffectOption.getOrUndefined(EffectArray.findFirst(attributedSymbols, symbol => symbol.id === 'web-ts'))
        ?.resolutionScopeId,
    ).toBe(web.id);
    expect(
      EffectOption.getOrUndefined(EffectArray.findFirst(attributedSymbols, symbol => symbol.id === 'web-jvm'))
        ?.resolutionScopeId,
    ).toBe(
      EffectOption.getOrUndefined(
        EffectArray.findFirst(
          workspace.projects,
          project => project.buildSystem === 'gradle' && project.root === 'apps/web',
        ),
      )?.id,
    );
  });

  it('uses JSONC path aliases for local dependencies without treating workspace-only names as registry packages', () => {
    const workspace = discoverManifestWorkspace([
      workspaceFile('package.json', JSON.stringify({name: '@acme/browser', private: true}), 'npm-manifest'),
      workspaceFile(
        'tsconfig.json',
        `{
          "compilerOptions": {
            "baseUrl": ".",
            "paths": {"@acme/*": ["./modules/*"],},
            "skipLibCheck": true,
            /* block comment after a trailing comma */
          },
        }`,
        'typescript-config',
      ),
      workspaceFile(
        'modules/shared/accounts/package.json',
        JSON.stringify({name: '@acme/shared/accounts'}),
        'npm-manifest',
      ),
      workspaceFile('modules/shared/accounts/index.ts', 'export const account = true', 'typescript'),
    ]);
    const root = EffectOption.getOrUndefined(
      EffectArray.findFirst(workspace.projects, project => project.root === ''),
    )!;
    const accounts = EffectOption.getOrUndefined(
      EffectArray.findFirst(workspace.projects, project => project.root === 'modules/shared/accounts'),
    )!;

    expect(EffectArray.filter(workspace.projects, project => project.root === '')).toHaveLength(1);
    expect(root.dependencies).toContain(accounts.id);
    expect(root.dependencyDetails).toContainEqual(
      expect.objectContaining({evidence: 'tsconfig.json', provenance: 'declared', targetId: accounts.id}),
    );
    expect(accounts.monikers).toEqual([]);
    expect(workspace.diagnostics).not.toContainEqual(expect.stringContaining('invalid TypeScript config'));
    expect(workspace.diagnostics).not.toContainEqual(expect.stringContaining('cannot form a package moniker'));
  });

  it('collapses overlapping Node, TypeScript, and Bazel package components at one root', () => {
    const contexts = [
      workspaceFile('package.json', JSON.stringify({name: '@acme/app', private: true}), 'npm-manifest'),
      workspaceFile('tsconfig.json', JSON.stringify({include: ['src/**/*.ts']}), 'typescript-config'),
      workspaceFile('BUILD', 'ts_project(name = "app", deps = ["//packages/core:core"])', 'bazel-build'),
      workspaceFile('packages/core/package.json', JSON.stringify({name: '@acme/core'}), 'npm-manifest'),
      workspaceFile('packages/core/tsconfig.json', JSON.stringify({include: ['src/**/*.ts']}), 'typescript-config'),
      workspaceFile('packages/core/BUILD', 'ts_project(name = "core")', 'bazel-build'),
    ];
    const workspace = mergeCodeGraphWorkspaces([discoverManifestWorkspace(contexts), discoverBazelWorkspace(contexts)]);
    const app = EffectOption.getOrUndefined(EffectArray.findFirst(workspace.projects, project => project.root === ''))!;
    const core = EffectOption.getOrUndefined(
      EffectArray.findFirst(workspace.projects, project => project.root === 'packages/core'),
    )!;

    expect(EffectArray.filter(workspace.projects, project => project.root === '')).toHaveLength(1);
    expect(EffectArray.filter(workspace.projects, project => project.root === 'packages/core')).toHaveLength(1);
    expect(app).toMatchObject({buildSystem: 'node', name: '@acme/app', resolutionDomain: 'typescript'});
    expect(app.languages).toEqual(expect.arrayContaining(['bazel', 'starlark', 'typescript']));
    expect(app.dependencies).toContain(core.id);

    const [attributed] = createWorkspaceAttributor(workspace)([
      {
        diagnostics: [],
        edges: [],
        path: 'BUILD',
        references: [
          {
            edgeId: 'bazel-dependency',
            evidencePath: 'BUILD',
            evidenceSpan: {column: 1, endColumn: 1, endLine: 1, line: 1},
            lookupTiers: [['bazel:label://packages/core:core']],
            provenance: 'declared',
            relation: 'depends_on',
            resolutionDomain: 'bazel',
            sourceName: '//:app',
            targetName: '//packages/core:core',
          },
        ],
        symbols: [workspaceSymbol('bazel-app', 'BUILD', '//:app', 'bazel', 'bazel-build')],
      },
    ]);
    expect(attributed.symbols[0]).toMatchObject({packageName: '@acme/app', resolutionScopeId: app.id});
    expect(attributed.symbols[0].lookupKeys).toEqual([`bazel:${app.id}:path:BUILD:name://:app`]);
    expect(attributed.references?.[0].lookupTiers).toEqual([
      [`bazel:${app.id}:label://packages/core:core`],
      [`bazel:${core.id}:label://packages/core:core`],
    ]);
  });

  fcProp(
    it,
    'keeps wildcard TypeScript path dependencies stable as unrelated package catalogs grow',
    {unrelatedPackageCount: FC.integer({max: 120, min: 0})},
    ({unrelatedPackageCount}) => {
      const workspace = discoverManifestWorkspace([
        workspaceFile('package.json', JSON.stringify({name: '@acme/app', private: true}), 'npm-manifest'),
        workspaceFile(
          'tsconfig.json',
          JSON.stringify({compilerOptions: {paths: {'@acme/*': ['./packages/*']}}}),
          'typescript-config',
        ),
        workspaceFile('packages/core/package.json', JSON.stringify({name: '@acme/core'}), 'npm-manifest'),
        ...Array.from({length: unrelatedPackageCount}, (_, index) =>
          workspaceFile(
            `packages/unrelated-${index}/package.json`,
            JSON.stringify({name: `@unrelated/package-${index}`}),
            'npm-manifest',
          ),
        ),
      ]);
      const app = EffectOption.getOrUndefined(
        EffectArray.findFirst(workspace.projects, project => project.root === ''),
      )!;
      const core = EffectOption.getOrUndefined(
        EffectArray.findFirst(workspace.projects, project => project.root === 'packages/core'),
      )!;

      expect(app.dependencies).toContain(core.id);
      expect(app.dependencyDetails).toContainEqual(
        expect.objectContaining({evidence: 'tsconfig.json', targetId: core.id}),
      );
    },
    {fastCheck: {numRuns: 40}},
  );

  it('uses a pnpm workspace without a root package and never lets a later positive override an exclusion', () => {
    const workspace = discoverManifestWorkspace([
      workspaceFile(
        'pnpm-workspace.yaml',
        "packages:\n  - 'packages/*'\n  - '!packages/private-*'\n  - 'packages/private-tools'\n",
        'pnpm-workspace',
      ),
      workspaceFile('packages/core/package.json', JSON.stringify({name: '@acme/core'}), 'npm-manifest'),
      workspaceFile('packages/core/src/index.ts', 'export const core = true', 'typescript'),
      workspaceFile(
        'packages/private-tools/package.json',
        JSON.stringify({name: '@acme/private-tools'}),
        'npm-manifest',
      ),
      workspaceFile('packages/private-tools/src/index.ts', 'export const internal = true', 'typescript'),
    ]);
    const core = EffectOption.getOrUndefined(
      EffectArray.findFirst(workspace.projects, project => project.name === '@acme/core'),
    )!;
    const privateTools = EffectOption.getOrUndefined(
      EffectArray.findFirst(workspace.projects, project => project.name === '@acme/private-tools'),
    )!;

    expect(core.workspaceRoots).toEqual(['']);
    expect(privateTools.workspaceRoots).toEqual(['packages/private-tools']);
    expect(core.workspaceId).not.toBe(privateTools.workspaceId);
  });

  fcProp(
    it,
    'reports ambiguous local dependency aliases independently of inventory order instead of silently dropping them',
    {priorities: FC.array(FC.integer(), {maxLength: 7, minLength: 7})},
    ({priorities}) => {
      const ambiguous = [
        workspaceFile(
          'package.json',
          JSON.stringify({name: 'root', private: true, workspaces: ['packages/*']}),
          'npm-manifest',
        ),
        workspaceFile('packages/first/package.json', JSON.stringify({name: '@acme/shared'}), 'npm-manifest'),
        workspaceFile('packages/first/index.ts', 'export const first = true', 'typescript'),
        workspaceFile('packages/second/package.json', JSON.stringify({name: '@acme/shared'}), 'npm-manifest'),
        workspaceFile('packages/second/index.ts', 'export const second = true', 'typescript'),
        workspaceFile(
          'packages/app/package.json',
          JSON.stringify({dependencies: {'@acme/shared': 'workspace:*'}, name: '@acme/app'}),
          'npm-manifest',
        ),
        workspaceFile('packages/app/index.ts', 'export const app = true', 'typescript'),
      ];
      const forward = discoverManifestWorkspace(ambiguous);
      const permuted = discoverManifestWorkspace(
        EffectArray.map(
          EffectArray.map(ambiguous, (file, index) => ({file, index, priority: priorities[index]})).sort(
            (left, right) => left.priority - right.priority || left.index - right.index,
          ),
          value => value.file,
        ),
      );

      expect(permuted).toEqual(forward);
      expect(forward.diagnostics).toContain(
        'packages/app/package.json: local dependency alias @acme/shared matched multiple declared projects',
      );
      expect(
        EffectOption.getOrUndefined(EffectArray.findFirst(forward.projects, project => project.name === '@acme/app'))
          ?.dependencies,
      ).toEqual([]);
    },
    {fastCheck: {numRuns: 100}},
  );

  fcProp(
    it,
    'persists stable typed Nx projects, targets, pnpm packages, and tsconfig references regardless of inventory order',
    {priorities: FC.array(FC.integer(), {maxLength: 13, minLength: 13})},
    ({priorities}) => {
      const nxFiles = [
        workspaceFile('nx.json', JSON.stringify({targetDefaults: {build: {dependsOn: ['^build']}}}), 'json'),
        workspaceFile('pnpm-workspace.yaml', "packages:\n  - 'apps/*'\n", 'pnpm-workspace'),
        workspaceFile('package.json', JSON.stringify({name: 'root', private: true}), 'npm-manifest'),
        workspaceFile('apps/core/package.json', JSON.stringify({name: '@acme/core'}), 'npm-manifest'),
        workspaceFile(
          'apps/core/project.json',
          JSON.stringify({name: 'core', sourceRoot: 'apps/core/src', targets: {build: {executor: '@nx/js:tsc'}}}),
          'json',
        ),
        workspaceFile('apps/core/tsconfig.json', JSON.stringify({include: ['src/**/*.ts']}), 'typescript-config'),
        workspaceFile('apps/core/src/index.ts', 'export const core = true', 'typescript'),
        workspaceFile('apps/web/package.json', JSON.stringify({name: '@acme/web'}), 'npm-manifest'),
        workspaceFile(
          'apps/web/project.json',
          JSON.stringify({
            implicitDependencies: ['core'],
            name: 'web',
            sourceRoot: 'apps/web/src',
            targets: {build: {dependsOn: ['^build']}, test: {dependsOn: ['build']}},
          }),
          'json',
        ),
        workspaceFile(
          'apps/web/tsconfig.json',
          JSON.stringify({include: ['src/**/*.ts'], references: [{path: '../core'}]}),
          'typescript-config',
        ),
        workspaceFile('apps/web/src/index.ts', 'export const web = true', 'typescript'),
        workspaceFile('README.md', '# workspace', 'markdown'),
        workspaceFile('docs/architecture.md', '# architecture', 'markdown'),
      ];
      const workspace = discoverManifestWorkspace(nxFiles);
      const permuted = discoverManifestWorkspace(
        EffectArray.map(
          EffectArray.map(nxFiles, (file, index) => ({file, index, priority: priorities[index]})).sort(
            (left, right) => left.priority - right.priority || left.index - right.index,
          ),
          value => value.file,
        ),
      );
      const nxProject = (name: string) =>
        EffectOption.getOrUndefined(
          EffectArray.findFirst(
            workspace.projects,
            project => project.buildSystem === 'nx' && project.kind === 'project' && project.name === name,
          ),
        )!;
      const nxTarget = (name: string) =>
        EffectOption.getOrUndefined(
          EffectArray.findFirst(
            workspace.projects,
            project => project.buildSystem === 'nx' && project.kind === 'target' && project.name === name,
          ),
        )!;
      const core = nxProject('core');
      const web = nxProject('web');
      const coreBuild = nxTarget('core:build');
      const webBuild = nxTarget('web:build');
      const webTest = nxTarget('web:test');
      const corePackage = EffectOption.getOrUndefined(
        EffectArray.findFirst(workspace.projects, project => project.name === '@acme/core'),
      )!;
      const webPackage = EffectOption.getOrUndefined(
        EffectArray.findFirst(workspace.projects, project => project.name === '@acme/web'),
      )!;

      expect(permuted).toEqual(workspace);
      expect(core.sourceRoots).toEqual(['apps/core/src']);
      expect(web.workspaceId).toBe(core.workspaceId);
      expect(web.dependencies).toContain(core.id);
      expect(webBuild.dependencies).toEqual(expect.arrayContaining([web.id, coreBuild.id]));
      expect(webTest.dependencies).toEqual(expect.arrayContaining([web.id, webBuild.id]));
      expect(webPackage.dependencies).toContain(corePackage.id);
      expect(
        EffectArray.filter(workspace.projects, project => project.root === 'apps/core' && project.kind !== 'target'),
      ).toHaveLength(2);
      expect(
        EffectArray.filter(workspace.projects, project => project.root === 'apps/web' && project.kind !== 'target'),
      ).toHaveLength(2);
      expect(
        EffectArray.map(
          EffectArray.filter(workspace.projects, project => project.buildSystem === 'pnpm'),
          project => project.name,
        ),
      ).toEqual(['root', '@acme/core', '@acme/web']);
    },
    {fastCheck: {numRuns: 100}},
  );

  it('keeps standalone Nx project boundaries as typed components instead of diagnostic-only records', () => {
    const workspace = discoverManifestWorkspace([
      workspaceFile(
        'package.json',
        JSON.stringify({name: 'root', private: true, workspaces: ['apps/*']}),
        'npm-manifest',
      ),
      workspaceFile('apps/web/project.json', JSON.stringify({name: 'web'}), 'json'),
      workspaceFile('apps/web/package.json', JSON.stringify({name: '@acme/web'}), 'npm-manifest'),
      workspaceFile('apps/web/index.ts', 'export const web = true', 'typescript'),
      workspaceFile('orphan/project.json', JSON.stringify({name: 'orphan'}), 'json'),
      workspaceFile('orphan/index.ts', 'export const orphan = true', 'typescript'),
    ]);

    expect(workspace.projects).toContainEqual(
      expect.objectContaining({buildSystem: 'nx', kind: 'project', name: 'web', root: 'apps/web'}),
    );
    expect(workspace.projects).toContainEqual(
      expect.objectContaining({buildSystem: 'nx', kind: 'project', name: 'orphan', root: 'orphan'}),
    );
    expect(workspace.diagnostics).not.toContainEqual(expect.stringContaining('not reconciled'));
  });

  fcProp(
    it,
    'merges duplicate detector projects commutatively, associatively, and idempotently',
    {fragments: FC.array(workspaceFragmentArbitrary, {maxLength: 8, minLength: 2})},
    ({fragments}) => {
      const expected = mergeCodeGraphWorkspaces(fragments);
      const midpoint = Math.floor(fragments.length / 2);
      const regrouped = mergeCodeGraphWorkspaces([
        mergeCodeGraphWorkspaces(fragments.slice(0, midpoint)),
        mergeCodeGraphWorkspaces(fragments.slice(midpoint)),
      ]);

      expect(mergeCodeGraphWorkspaces([...fragments].reverse())).toEqual(expected);
      expect(regrouped).toEqual(expected);
      expect(mergeCodeGraphWorkspaces([...fragments, ...fragments])).toEqual(expected);
      expect(mergeCodeGraphWorkspaces([expected])).toEqual(expected);
    },
    {fastCheck: {numRuns: 250}},
  );
});

function workspaceFile(path: string, content: string, language = 'text'): CodeGraphInventoryFile {
  return {
    blobId: `blob:${path}`,
    content,
    contentHash: `hash:${path}`,
    language,
    mode: '100644',
    path,
    size: new TextEncoder().encode(content).byteLength,
    source: 'commit',
  };
}

function facts(path: string, symbols: readonly CodeGraphSymbol[]): CodeGraphFileFacts {
  return {diagnostics: [], edges: [], path, symbols};
}

function workspaceSymbol(
  id: string,
  path: string,
  name: string,
  resolutionDomain: string,
  language: string,
): CodeGraphSymbol {
  return {
    contentHash: `hash:${path}`,
    exported: true,
    id,
    kind: 'function',
    language,
    lookupKeys: [`${resolutionDomain}:path:${path}:name:${name}`],
    name,
    path,
    qualifiedName: name,
    resolutionDomain,
    span: {column: 1, endColumn: 1, endLine: 1, line: 1},
  };
}
