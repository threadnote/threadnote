import {Array as EffectArray} from 'effect';
import {ScriptError} from './effect/errors.js';
import {Effect, FileSystem, Path, Schedule} from 'effect';
import {
  CODE_GRAPH_GENERIC_JSON_EXCLUSION_BYTES,
  CODE_GRAPH_HIGH_SIGNAL_JSON_HARD_CAP_BYTES,
} from '@threadnote/graph/inventory/policy';
import {runCommandEffect} from '@threadnote/platform/command';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';
import {Option as EffectOption} from 'effect';

export interface PreparedCodeGraphFixture {
  readonly home: string;
  readonly incrementalSourcePath?: string;
  readonly profile?: ProductionCodeGraphFixtureProfile;
  readonly queryText?: string;
  readonly repository: string;
  readonly root: string;
}

export interface ProductionCodeGraphFixtureClassMix {
  readonly duplicateHeavyJsonFiles: number;
  readonly generatedSvgFiles: number;
  readonly nxProjectFiles: number;
  readonly packageManifestFiles: number;
  readonly supportMarkdownFiles: number;
  readonly tsconfigFiles: number;
  readonly tsxSourceFiles: number;
  readonly typescriptSourceFiles: number;
  readonly workspaceManifestFiles: number;
}

export interface ProductionCodeGraphFixtureDuplicateBlobs {
  readonly generatedSvgVariants: number;
  readonly heavyJsonPayloadBytes: number;
  readonly heavyJsonVariants: number;
}

export interface ProductionCodeGraphFixtureProfile {
  readonly activeWorkspaceExcludedPackageCount: number;
  readonly activeWorkspaceExcludedSourceFiles: number;
  readonly classMix: ProductionCodeGraphFixtureClassMix;
  readonly declarationSymbols: number;
  readonly duplicateBlobs: ProductionCodeGraphFixtureDuplicateBlobs;
  readonly highSignalConfigHardCapBytes: number;
  readonly id: 'production-large';
  readonly lowSignalJsonExclusionThresholdBytes: number;
  readonly maxCallsPerDeclaration: number;
  readonly sourceFiles: number;
  readonly surrogate: 'threadnote-4.1.0-beta.1-public-monorepo';
  readonly targetEligibleFiles: number;
  readonly targetGraphEdges: number;
  readonly targetGraphSymbols: number;
  readonly targetLexicalTermRows: number;
  readonly targetRepositoryFiles: number;
  readonly version: 2;
  readonly workspaceCount: number;
  readonly worktreeChurnScenarioCount: 6;
}

/**
 * Public, deterministic surrogate for the Threadnote 4.1 beta monorepo evidence. The profile records shape
 * targets rather than portable latency claims; its full materialization remains opt-in/nightly.
 */
export const PRODUCTION_WORKTREE_CHURN_SCENARIOS = [
  'concurrent-linked-worktree-builds',
  'catalog-read-during-active-writer',
  'dirty-overlay-worktree-isolation',
  'linked-head-moves-during-build',
  'interrupted-linked-build-resume',
  'removed-worktree-reclaim',
] as const;

export const PRODUCTION_LARGE_CODE_GRAPH_PROFILE = {
  activeWorkspaceExcludedPackageCount: 24,
  activeWorkspaceExcludedSourceFiles: 3_000,
  classMix: {
    duplicateHeavyJsonFiles: 64,
    generatedSvgFiles: 13_000,
    nxProjectFiles: 105,
    packageManifestFiles: 996,
    supportMarkdownFiles: 13_263,
    tsconfigFiles: 571,
    tsxSourceFiles: 15_000,
    typescriptSourceFiles: 30_000,
    workspaceManifestFiles: 1,
  },
  declarationSymbols: 2_128_000,
  duplicateBlobs: {
    generatedSvgVariants: 64,
    heavyJsonPayloadBytes: 1_048_576,
    heavyJsonVariants: 8,
  },
  highSignalConfigHardCapBytes: CODE_GRAPH_HIGH_SIGNAL_JSON_HARD_CAP_BYTES,
  id: 'production-large',
  lowSignalJsonExclusionThresholdBytes: CODE_GRAPH_GENERIC_JSON_EXCLUSION_BYTES,
  maxCallsPerDeclaration: 1,
  sourceFiles: 45_000,
  surrogate: 'threadnote-4.1.0-beta.1-public-monorepo',
  targetEligibleFiles: 59_936,
  targetGraphEdges: 4_340_000,
  targetGraphSymbols: 2_200_000,
  targetLexicalTermRows: 32_250_000,
  targetRepositoryFiles: 73_000,
  version: 2,
  workspaceCount: 995,
  worktreeChurnScenarioCount: 6,
} as const satisfies ProductionCodeGraphFixtureProfile;

export const GENERATED_VECTOR_CONTROL_PATH = 'docs/vector-semantic-control.md';
export const VECTOR_SEMANTIC_CONTROL_QUERY = 'serialize concurrent tasks via mutual exclusion';

export const makeOwnedTempDirectoryScoped = Effect.fn('codeGraphFixture.makeOwnedTempDirectoryScoped')(function* (
  prefix: string,
) {
  const fs = yield* FileSystem.FileSystem;
  return yield* Effect.acquireRelease(fs.makeTempDirectory({prefix}), root =>
    fs.remove(root, {force: true, recursive: true}).pipe(
      // Windows may retain a just-closed SQLite handle briefly. Give owned
      // fixture cleanup a bounded grace period, then let an exhausted Busy
      // cleanup remain runner-local instead of changing a successful result.
      Effect.retry({
        schedule: Schedule.spaced(100),
        times: 5,
        while: error => error.reason._tag === 'Busy',
      }),
      Effect.catchIf(
        error => error.reason._tag === 'Busy' || error.reason._tag === 'NotFound',
        () => Effect.void,
      ),
      Effect.orDie,
    ),
  );
});

export const prepareCodeGraphFixture = Effect.fn('codeGraphFixture.prepare')(function* (fixture = 'code-graph-v1') {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  if (!/^code-graph-[a-z0-9-]+$/.test(fixture)) {
    return yield* ScriptError.make({message: `Invalid code graph fixture name: ${fixture}.`});
  }
  const source = yield* path.fromFileUrl(
    new URL(`../apps/threadnote/test/evaluation/fixtures/${fixture}/repository/`, import.meta.url),
  );
  const root = yield* makeOwnedTempDirectoryScoped('threadnote-code-graph-evaluation-');
  const repository = path.join(root, 'repository');
  const home = path.join(root, 'home');
  yield* fs.copy(source, repository, {overwrite: true});
  yield* fs.makeDirectory(home, {recursive: true, mode: 0o700});
  yield* git(repository, ['init', '-q']);
  yield* git(repository, ['add', '.']);
  yield* git(repository, [
    '-c',
    'user.name=Threadnote Evaluation',
    '-c',
    'user.email=evaluation@threadnote.local',
    'commit',
    '-qm',
    'reviewed fixture',
  ]);
  return {home, repository, root} satisfies PreparedCodeGraphFixture;
});

export const prepareGeneratedCodeGraphFixture = Effect.fn('codeGraphFixture.prepareGenerated')(function* (
  targetSymbols: number,
  includeVectorControl = false,
  includeStaticReexportControl = false,
  includeDependencySurfaceControl = false,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  if (!Number.isSafeInteger(targetSymbols) || targetSymbols < 1) {
    return yield* ScriptError.make({message: 'Generated code graph target must be a positive safe integer.'});
  }
  const root = yield* makeOwnedTempDirectoryScoped('threadnote-code-graph-scale-');
  const repository = path.join(root, 'repository');
  const source = path.join(repository, 'src');
  const home = path.join(root, 'home');
  yield* fs.makeDirectory(source, {recursive: true});
  yield* fs.makeDirectory(home, {recursive: true, mode: 0o700});
  yield* fs.writeFileString(
    path.join(repository, 'package.json'),
    `${JSON.stringify(
      {
        name: '@threadnote/code-graph-scale',
        private: true,
        version: '1.0.0',
        ...(includeDependencySurfaceControl ? {workspaces: ['packages/*']} : {}),
      },
      undefined,
      2,
    )}\n`,
  );
  yield* fs.writeFileString(
    path.join(repository, 'tsconfig.json'),
    `${JSON.stringify({compilerOptions: {strict: true}, include: ['src/**/*.ts']}, undefined, 2)}\n`,
  );
  if (includeVectorControl) {
    yield* fs.makeDirectory(path.join(repository, 'docs'), {recursive: true});
    yield* fs.writeFileString(
      path.join(repository, GENERATED_VECTOR_CONTROL_PATH),
      '# Fixture architecture\n\n' +
        'The application calls the search package. Search serializes recall and vector-index activation through the core\n' +
        'exclusive file-lock contract. Lock recovery must preserve the previous ready index.\n',
    );
  }
  const dependencySurfaceSourcePath = 'packages/surface-core/src/index.ts';
  if (includeDependencySurfaceControl) {
    yield* Effect.forEach(
      ['packages/surface-core/src', 'packages/surface-app/src'],
      directory => fs.makeDirectory(path.join(repository, directory), {recursive: true}),
      {discard: true},
    );
    yield* Effect.all(
      [
        fs.writeFileString(
          path.join(repository, 'packages/surface-core/package.json'),
          `${JSON.stringify(
            {exports: './src/index.ts', name: '@threadnote/surface-core', private: true, version: '1.0.0'},
            undefined,
            2,
          )}\n`,
        ),
        fs.writeFileString(
          path.join(repository, dependencySurfaceSourcePath),
          'export function dependencySurfaceControl(): number { return 1; }\n',
        ),
        fs.writeFileString(
          path.join(repository, 'packages/surface-app/package.json'),
          `${JSON.stringify(
            {
              dependencies: {'@threadnote/surface-core': 'workspace:*'},
              name: '@threadnote/surface-app',
              private: true,
              version: '1.0.0',
            },
            undefined,
            2,
          )}\n`,
        ),
        fs.writeFileString(
          path.join(repository, 'packages/surface-app/src/index.ts'),
          "import {dependencySurfaceControl} from '@threadnote/surface-core';\n" +
            'export function consumeDependencySurface(): number { return dependencySurfaceControl(); }\n',
        ),
      ],
      {concurrency: 4, discard: true},
    );
  }
  const symbolsPerFile = 100;
  if (includeStaticReexportControl && targetSymbols <= symbolsPerFile) {
    return yield* ScriptError.make({
      message: `Generated static re-export control requires at least ${symbolsPerFile + 1} symbols.`,
    });
  }
  const fileCount = Math.ceil(targetSymbols / symbolsPerFile);
  yield* Effect.forEach(
    Array.from({length: fileCount}, (_, index) => index),
    fileIndex => {
      const first = fileIndex * symbolsPerFile;
      const count = Math.min(symbolsPerFile, targetSymbols - first);
      const declarations = Array.from({length: count}, (_, offset) => {
        const symbolIndex = first + offset;
        const name = generatedSymbolName(symbolIndex);
        const body =
          symbolIndex === 0 ? `return ${symbolIndex};` : `return ${generatedSymbolName(symbolIndex - 1)}() + 1;`;
        return `export function ${name}(): number { ${body} }`;
      });
      if (includeStaticReexportControl && fileIndex === 0) {
        declarations.push(generatedStaticReexportControlStatement());
      }
      return fs.writeFileString(
        path.join(source, `module-${Effect2.pipe(String(fileIndex), EffectString.padStart(5, '0'))}.ts`),
        `${EffectArray.join(declarations, '\n')}\n`,
      );
    },
    {concurrency: 16, discard: true},
  );
  yield* git(repository, ['init', '-q']);
  yield* git(repository, ['add', '.']);
  yield* runCommandEffect(
    'git',
    [
      '-C',
      repository,
      '-c',
      'user.name=Threadnote Evaluation',
      '-c',
      'user.email=evaluation@threadnote.local',
      'commit',
      '-qm',
      `generated ${targetSymbols} symbol fixture`,
    ],
    {
      env: {
        GIT_AUTHOR_DATE: '2000-01-01T00:00:00Z',
        GIT_COMMITTER_DATE: '2000-01-01T00:00:00Z',
      },
      maxOutputBytes: 16 * 1_048_576,
      timeoutMs: 30_000,
    },
  );
  return {
    home,
    ...(includeDependencySurfaceControl ? {incrementalSourcePath: dependencySurfaceSourcePath} : {}),
    repository,
    root,
  } satisfies PreparedCodeGraphFixture;
});

export const prepareProductionCodeGraphFixture = Effect.fn('codeGraphFixture.prepareProduction')(function* (
  requested: ProductionCodeGraphFixtureProfile = PRODUCTION_LARGE_CODE_GRAPH_PROFILE,
  includeVectorControl = false,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const profile = validateProductionProfile(requested);
  const root = yield* makeOwnedTempDirectoryScoped('threadnote-code-graph-production-scale-');
  const repository = path.join(root, 'repository');
  const home = path.join(root, 'home');
  yield* fs.makeDirectory(repository, {recursive: true});
  yield* fs.makeDirectory(home, {recursive: true, mode: 0o700});

  const workspaces = productionWorkspaceRoots(profile.workspaceCount, profile.activeWorkspaceExcludedPackageCount);
  const includedWorkspaces = EffectArray.filter(workspaces, workspace => !isActiveWorkspaceExcludedRoot(workspace));
  const excludedWorkspaces = EffectArray.filter(
    workspaces,
    (__effectFilterValue: (typeof workspaces)[number], __effectFilterIndex: number) =>
      __effectFilterIndex in workspaces && isActiveWorkspaceExcludedRoot(__effectFilterValue),
  );
  yield* fs.writeFileString(
    path.join(repository, 'package.json'),
    `${JSON.stringify(
      {
        name: '@threadnote/production-large-fixture',
        private: true,
        version: '1.0.0',
      },
      undefined,
      2,
    )}\n`,
  );
  yield* fs.writeFileString(
    path.join(repository, 'tsconfig.json'),
    `${JSON.stringify(
      {
        files: [],
        references: EffectArray.map(workspaces.slice(0, profile.classMix.tsconfigFiles - 1), workspace => ({
          path: workspace,
        })),
      },
      undefined,
      2,
    )}\n`,
  );
  yield* fs.writeFileString(
    path.join(repository, 'pnpm-workspace.yaml'),
    EffectArray.join(
      [
        'packages:',
        "  - 'apps/**'",
        "  - 'libs/**'",
        "  - 'services/**'",
        "  - 'tools/**'",
        "  - 'packages/**'",
        "  - '!packages/active-excluded-*'",
        '',
      ],
      '\n',
    ),
  );

  yield* Effect.forEach(
    workspaces,
    workspace => fs.makeDirectory(path.join(repository, workspace, 'src'), {recursive: true}),
    {concurrency: 16, discard: true},
  );

  yield* Effect.all(
    [
      Effect.forEach(
        workspaces,
        (workspace, workspaceIndex) =>
          fs.writeFileString(
            path.join(repository, workspace, 'package.json'),
            `${JSON.stringify(
              {
                dependencies: workspaceIndex === 0 ? {} : {[productionPackageName(workspaceIndex - 1)]: 'workspace:*'},
                name: productionPackageName(workspaceIndex),
                private: true,
                version: '1.0.0',
              },
              undefined,
              2,
            )}\n`,
          ),
        {concurrency: 16, discard: true},
      ),
      Effect.forEach(
        workspaces.slice(0, profile.classMix.tsconfigFiles - 1),
        workspace =>
          fs.writeFileString(
            path.join(repository, workspace, 'tsconfig.json'),
            `${JSON.stringify(
              {
                compilerOptions: {composite: true, strict: true},
                include: ['src/**/*.ts', 'src/**/*.tsx'],
              },
              undefined,
              2,
            )}\n`,
          ),
        {concurrency: 16, discard: true},
      ),
      Effect.forEach(
        workspaces.slice(0, profile.classMix.nxProjectFiles),
        (workspace, workspaceIndex) =>
          fs.writeFileString(
            path.join(repository, workspace, 'project.json'),
            `${JSON.stringify(
              {
                name: `production-project-${Effect2.pipe(String(workspaceIndex), EffectString.padStart(4, '0'))}`,
                projectType: workspaceIndex % 5 === 0 ? 'application' : 'library',
                sourceRoot: `${workspace}/src`,
              },
              undefined,
              2,
            )}\n`,
          ),
        {concurrency: 16, discard: true},
      ),
    ],
    {concurrency: 3, discard: true},
  );

  if (includeVectorControl) {
    yield* fs.makeDirectory(path.join(repository, 'docs'), {recursive: true});
    yield* fs.writeFileString(
      path.join(repository, GENERATED_VECTOR_CONTROL_PATH),
      '# Fixture architecture\n\n' +
        'The application calls the search package. Search serializes recall and vector-index activation through the core\n' +
        'exclusive file-lock contract. Lock recovery must preserve the previous ready index.\n',
    );
  }

  const workspaceIndexes = new Map(EffectArray.map(workspaces, (workspace, index) => [workspace, index]));
  const sourceOrdinals = new Map<string, number>();
  const sourceLocations = Array.from({length: profile.sourceFiles}, (_, fileIndex) => {
    const excluded = fileIndex < profile.activeWorkspaceExcludedSourceFiles;
    const roots = excluded ? excludedWorkspaces : includedWorkspaces;
    const relativeIndex = excluded ? fileIndex : fileIndex - profile.activeWorkspaceExcludedSourceFiles;
    const workspace = roots[relativeIndex % roots.length];
    const extension = fileIndex < profile.classMix.tsxSourceFiles ? 'tsx' : 'ts';
    const ordinalKey = `${workspace}\0${extension}`;
    const ordinal = sourceOrdinals.get(ordinalKey) ?? 0;
    sourceOrdinals.set(ordinalKey, ordinal + 1);
    return {
      extension,
      fileIndex,
      ordinal,
      workspace,
      workspaceIndex: workspaceIndexes.get(workspace)!,
    };
  });
  const baseDeclarations = Math.floor(profile.declarationSymbols / profile.sourceFiles);
  const declarationRemainder = profile.declarationSymbols % profile.sourceFiles;
  yield* Effect.all(
    [
      Effect.forEach(
        sourceLocations,
        location => {
          const {extension, fileIndex, ordinal, workspace, workspaceIndex} = location;
          const declarationCount = baseDeclarations + (fileIndex < declarationRemainder ? 1 : 0);
          const firstSymbol = fileIndex * baseDeclarations + Math.min(fileIndex, declarationRemainder);
          const declarations = Array.from({length: declarationCount}, (_, offset) => {
            const symbolIndex = firstSymbol + offset;
            const name = productionSymbolName(symbolIndex, workspaceIndex);
            const calls = Array.from({length: Math.min(profile.maxCallsPerDeclaration, offset)}, (_, callOffset) =>
              productionSymbolName(symbolIndex - callOffset - 1, workspaceIndex),
            );
            const body =
              calls.length === 0
                ? `${symbolIndex}`
                : EffectArray.join(
                    EffectArray.map(calls, call => `${call}()`),
                    ' + ',
                  );
            return (
              '/** Account workflow feature operation. */\n' + `export function ${name}(): number { return ${body}; }`
            );
          });
          return fs.writeFileString(
            path.join(
              repository,
              workspace,
              'src',
              `module-${Effect2.pipe(String(ordinal), EffectString.padStart(5, '0'))}.${extension}`,
            ),
            `${EffectArray.join(declarations, '\n')}\n`,
          );
        },
        {concurrency: 16, discard: true},
      ),
      writeProductionSvgFiles(fs, path, repository, profile),
      writeProductionHeavyJsonFiles(fs, path, repository, profile),
      writeProductionSupportFiles(fs, path, repository, profile),
    ],
    {concurrency: 4, discard: true},
  );

  yield* git(repository, ['init', '-q'], 120_000);
  yield* git(repository, ['add', '.'], 15 * 60_000);
  yield* git(
    repository,
    [
      '-c',
      'user.name=Threadnote Evaluation',
      '-c',
      'user.email=evaluation@threadnote.local',
      'commit',
      '-qm',
      `production-scale ${profile.targetGraphSymbols} symbol fixture`,
    ],
    15 * 60_000,
  );
  const incremental =
    EffectOption.getOrUndefined(
      EffectArray.findFirst(sourceLocations, location => !isActiveWorkspaceExcludedRoot(location.workspace)),
    ) ?? sourceLocations[0];
  const lastSource = sourceLocations.at(-1)!;
  const incrementalSourcePath = path.join(
    incremental.workspace,
    'src',
    `module-${Effect2.pipe(String(incremental.ordinal), EffectString.padStart(5, '0'))}.${incremental.extension}`,
  );
  return {
    home,
    incrementalSourcePath,
    profile,
    queryText: productionSymbolName(profile.declarationSymbols - 1, lastSource.workspaceIndex),
    repository,
    root,
  } satisfies PreparedCodeGraphFixture;
});

export function generatedSymbolName(index: number): string {
  return `scaleSymbol${Effect2.pipe(String(index), EffectString.padStart(6, '0'))}`;
}

export function generatedStaticReexportControlStatement(): string {
  return `export {${generatedSymbolName(100)} as scaleStaticReexportControl} from "./module-00001.js";`;
}

export function productionSymbolName(index: number, workspaceIndex: number): string {
  return (
    `workspace${Effect2.pipe(String(workspaceIndex), EffectString.padStart(2, '0'))}AccountWorkflow` +
    `FeatureOperation${Effect2.pipe(String(index), EffectString.padStart(7, '0'))}`
  );
}

export function productionWorkspaceRoots(count: number, activeExcludedCount = 0): readonly string[] {
  if (!Number.isSafeInteger(count) || count < 1) {
    throw ScriptError.make({message: 'Production code graph workspace count must be a positive safe integer.'});
  }
  if (!Number.isSafeInteger(activeExcludedCount) || activeExcludedCount < 0 || activeExcludedCount >= count) {
    throw ScriptError.make({
      message: 'Production code graph active workspace-excluded package count must leave one included package.',
    });
  }
  const includedCount = count - activeExcludedCount;
  const fixedCandidates = [
    ...Array.from(
      {length: 6},
      (_, index) => `apps/application-${Effect2.pipe(String(index), EffectString.padStart(2, '0'))}`,
    ),
    ...Array.from(
      {length: 6},
      (_, index) => `libs/library-${Effect2.pipe(String(index), EffectString.padStart(2, '0'))}`,
    ),
    ...Array.from(
      {length: 4},
      (_, index) => `services/service-${Effect2.pipe(String(index), EffectString.padStart(2, '0'))}`,
    ),
    ...Array.from(
      {length: 2},
      (_, index) => `tools/tool-${Effect2.pipe(String(index), EffectString.padStart(2, '0'))}`,
    ),
    ...Array.from(
      {length: 3},
      (_, index) => `apps/integrated/modules/module-${Effect2.pipe(String(index), EffectString.padStart(2, '0'))}`,
    ),
    ...Array.from(
      {length: 3},
      (_, index) => `apps/isolated/packages/package-${Effect2.pipe(String(index), EffectString.padStart(2, '0'))}`,
    ),
  ];
  const generatedCandidates = Array.from({length: Math.max(0, includedCount - fixedCandidates.length)}, (_, index) => {
    const ordinal = Effect2.pipe(String(index), EffectString.padStart(4, '0'));
    switch (index % 5) {
      case 0:
        return `apps/surrogate-application-${ordinal}`;
      case 1:
        return `libs/surrogate-library-${ordinal}`;
      case 2:
        return `services/surrogate-service-${ordinal}`;
      case 3:
        return `tools/surrogate-tool-${ordinal}`;
      default:
        return `packages/surrogate-package-${ordinal}`;
    }
  });
  return [
    ...fixedCandidates.slice(0, includedCount),
    ...generatedCandidates,
    ...Array.from(
      {length: activeExcludedCount},
      (_, index) => `packages/active-excluded-${Effect2.pipe(String(index), EffectString.padStart(3, '0'))}`,
    ),
  ];
}

export function validateProductionProfile(
  profile: ProductionCodeGraphFixtureProfile,
): ProductionCodeGraphFixtureProfile {
  const scalarCounts = {
    activeWorkspaceExcludedPackageCount: profile.activeWorkspaceExcludedPackageCount,
    activeWorkspaceExcludedSourceFiles: profile.activeWorkspaceExcludedSourceFiles,
    declarationSymbols: profile.declarationSymbols,
    highSignalConfigHardCapBytes: profile.highSignalConfigHardCapBytes,
    lowSignalJsonExclusionThresholdBytes: profile.lowSignalJsonExclusionThresholdBytes,
    maxCallsPerDeclaration: profile.maxCallsPerDeclaration,
    sourceFiles: profile.sourceFiles,
    targetEligibleFiles: profile.targetEligibleFiles,
    targetGraphEdges: profile.targetGraphEdges,
    targetGraphSymbols: profile.targetGraphSymbols,
    targetLexicalTermRows: profile.targetLexicalTermRows,
    targetRepositoryFiles: profile.targetRepositoryFiles,
    workspaceCount: profile.workspaceCount,
    worktreeChurnScenarioCount: profile.worktreeChurnScenarioCount,
  };
  for (const [name, value] of EffectRecord.toEntries(scalarCounts)) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw ScriptError.make({message: `Production code graph profile ${name} must be a positive safe integer.`});
    }
  }
  for (const [name, value] of EffectRecord.toEntries(profile.classMix)) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw ScriptError.make({
        message: `Production code graph profile class mix ${name} must be a positive safe integer.`,
      });
    }
  }
  for (const [name, value] of EffectRecord.toEntries(profile.duplicateBlobs)) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw ScriptError.make({
        message: `Production code graph profile duplicate blob ${name} must be a positive safe integer.`,
      });
    }
  }
  if (
    profile.id !== 'production-large' ||
    profile.version !== 2 ||
    profile.surrogate !== 'threadnote-4.1.0-beta.1-public-monorepo'
  ) {
    throw ScriptError.make({message: 'Unsupported production code graph fixture profile.'});
  }
  if (profile.worktreeChurnScenarioCount !== PRODUCTION_WORKTREE_CHURN_SCENARIOS.length) {
    throw ScriptError.make({
      message: 'Production code graph fixture must declare the reviewed six-scenario worktree churn matrix.',
    });
  }
  if (profile.declarationSymbols < profile.sourceFiles) {
    throw ScriptError.make({
      message: 'Production code graph fixture requires at least one declaration per source file.',
    });
  }
  if (profile.classMix.typescriptSourceFiles + profile.classMix.tsxSourceFiles !== profile.sourceFiles) {
    throw ScriptError.make({message: 'Production code graph source class counts must equal sourceFiles.'});
  }
  if (productionRepositoryFileCount(profile.classMix) !== profile.targetRepositoryFiles) {
    throw ScriptError.make({message: 'Production code graph class mix must equal targetRepositoryFiles.'});
  }
  if (productionEligibleFileCount(profile.classMix) !== profile.targetEligibleFiles) {
    throw ScriptError.make({message: 'Production code graph eligible class mix must equal targetEligibleFiles.'});
  }
  if (profile.classMix.packageManifestFiles !== profile.workspaceCount + 1) {
    throw ScriptError.make({
      message: 'Production code graph package manifest count must cover the root and every package.',
    });
  }
  if (profile.classMix.workspaceManifestFiles !== 1) {
    throw ScriptError.make({message: 'Production code graph fixture requires exactly one pnpm workspace manifest.'});
  }
  if (profile.classMix.tsconfigFiles > profile.workspaceCount + 1) {
    throw ScriptError.make({message: 'Production code graph tsconfig count exceeds the root and package count.'});
  }
  if (profile.classMix.nxProjectFiles > profile.workspaceCount) {
    throw ScriptError.make({message: 'Production code graph Nx project count exceeds the package count.'});
  }
  if (profile.activeWorkspaceExcludedSourceFiles >= profile.sourceFiles) {
    throw ScriptError.make({
      message: 'Production code graph active workspace-excluded source count must leave included sourceFiles.',
    });
  }
  if (profile.duplicateBlobs.generatedSvgVariants > profile.classMix.generatedSvgFiles) {
    throw ScriptError.make({message: 'Production code graph generated SVG variants exceed generated SVG files.'});
  }
  if (profile.duplicateBlobs.heavyJsonVariants > profile.classMix.duplicateHeavyJsonFiles) {
    throw ScriptError.make({message: 'Production code graph heavy JSON variants exceed duplicate heavy JSON files.'});
  }
  if (profile.duplicateBlobs.heavyJsonPayloadBytes > 16 * 1_048_576) {
    throw ScriptError.make({message: 'Production code graph heavy JSON payload exceeds the bounded surrogate limit.'});
  }
  if (profile.duplicateBlobs.heavyJsonPayloadBytes < profile.lowSignalJsonExclusionThresholdBytes) {
    throw ScriptError.make({
      message: 'Production code graph heavy JSON payload must reach its declared exclusion threshold.',
    });
  }
  if (profile.lowSignalJsonExclusionThresholdBytes >= profile.highSignalConfigHardCapBytes) {
    throw ScriptError.make({
      message: 'Production code graph low-signal threshold must remain below the high-signal config hard cap.',
    });
  }
  if (
    profile.lowSignalJsonExclusionThresholdBytes !== CODE_GRAPH_GENERIC_JSON_EXCLUSION_BYTES ||
    profile.highSignalConfigHardCapBytes !== CODE_GRAPH_HIGH_SIGNAL_JSON_HARD_CAP_BYTES
  ) {
    throw ScriptError.make({
      message: 'Production code graph eligibility targets must match the runtime inventory admission policy.',
    });
  }
  productionWorkspaceRoots(profile.workspaceCount, profile.activeWorkspaceExcludedPackageCount);
  return profile;
}

export function productionEligibleFileCount(classMix: ProductionCodeGraphFixtureClassMix): number {
  return productionRepositoryFileCount(classMix) - classMix.generatedSvgFiles - classMix.duplicateHeavyJsonFiles;
}

export function productionRepositoryFileCount(classMix: ProductionCodeGraphFixtureClassMix): number {
  return EffectArray.reduce(EffectRecord.values(classMix), 0, (total, count) => total + count);
}

export function productionExcludedByteDistribution(profile: ProductionCodeGraphFixtureProfile): {
  readonly generatedSvgBytes: number;
  readonly heavyJsonBytes: number;
  readonly totalBytes: number;
} {
  const variantBytes = Array.from(
    {length: profile.duplicateBlobs.generatedSvgVariants},
    (_, index) => new TextEncoder().encode(productionSvgBlob(index)).byteLength,
  );
  const completeVariantCycles = Math.floor(
    profile.classMix.generatedSvgFiles / profile.duplicateBlobs.generatedSvgVariants,
  );
  const remainingVariants = profile.classMix.generatedSvgFiles % profile.duplicateBlobs.generatedSvgVariants;
  const generatedSvgBytes =
    completeVariantCycles * EffectArray.reduce(variantBytes, 0, (total, bytes) => total + bytes) +
    EffectArray.reduce(variantBytes.slice(0, remainingVariants), 0, (total, bytes) => total + bytes);
  const heavyJsonBytes = profile.classMix.duplicateHeavyJsonFiles * profile.duplicateBlobs.heavyJsonPayloadBytes;
  return {generatedSvgBytes, heavyJsonBytes, totalBytes: generatedSvgBytes + heavyJsonBytes};
}

function isActiveWorkspaceExcludedRoot(workspace: string): boolean {
  return Effect2.pipe(workspace, EffectString.startsWith('packages/active-excluded-'));
}

function writeProductionSvgFiles(
  fs: FileSystem.FileSystem,
  path: Path.Path,
  repository: string,
  profile: ProductionCodeGraphFixtureProfile,
) {
  const root = path.join(repository, 'gen', 'svg');
  return fs.makeDirectory(root, {recursive: true}).pipe(
    Effect.andThen(
      Effect.forEach(
        Array.from({length: profile.classMix.generatedSvgFiles}, (_, index) => index),
        index =>
          fs.writeFileString(
            path.join(root, `generated-${Effect2.pipe(String(index), EffectString.padStart(5, '0'))}.svg`),
            productionSvgBlob(index % profile.duplicateBlobs.generatedSvgVariants),
          ),
        {concurrency: 16, discard: true},
      ),
    ),
  );
}

function writeProductionHeavyJsonFiles(
  fs: FileSystem.FileSystem,
  path: Path.Path,
  repository: string,
  profile: ProductionCodeGraphFixtureProfile,
) {
  const root = path.join(repository, 'test', 'golden-data');
  const variants = Array.from({length: profile.duplicateBlobs.heavyJsonVariants}, (_, index) =>
    productionHeavyJsonBlob(index, profile.duplicateBlobs.heavyJsonPayloadBytes),
  );
  return fs.makeDirectory(root, {recursive: true}).pipe(
    Effect.andThen(
      Effect.forEach(
        Array.from({length: profile.classMix.duplicateHeavyJsonFiles}, (_, index) => index),
        index =>
          fs.writeFileString(
            path.join(root, `payload-${Effect2.pipe(String(index), EffectString.padStart(4, '0'))}.json`),
            variants[index % variants.length],
          ),
        {concurrency: 8, discard: true},
      ),
    ),
  );
}

function writeProductionSupportFiles(
  fs: FileSystem.FileSystem,
  path: Path.Path,
  repository: string,
  profile: ProductionCodeGraphFixtureProfile,
) {
  const root = path.join(repository, 'docs', 'support');
  return fs.makeDirectory(root, {recursive: true}).pipe(
    Effect.andThen(
      Effect.forEach(
        Array.from({length: profile.classMix.supportMarkdownFiles}, (_, index) => index),
        index =>
          fs.writeFileString(
            path.join(root, `support-${Effect2.pipe(String(index), EffectString.padStart(5, '0'))}.md`),
            `# Public monorepo surrogate support record ${index}\n`,
          ),
        {concurrency: 16, discard: true},
      ),
    ),
  );
}

function productionSvgBlob(variant: number): string {
  return (
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">' +
    `<path d="M${variant % 12} 2h${(variant % 7) + 1}v${(variant % 9) + 1}H2z"/>` +
    '</svg>\n'
  );
}

function productionHeavyJsonBlob(variant: number, targetBytes: number): string {
  const prefix = `{"fixture":"threadnote-public-monorepo","variant":${variant},"payload":"`;
  const suffix = '"}\n';
  return `${prefix}${Effect2.pipe('x', EffectString.repeat(Math.max(0, targetBytes - prefix.length - suffix.length)))}${suffix}`;
}

function productionPackageName(index: number): string {
  return `@threadnote/production-workspace-${Effect2.pipe(String(index), EffectString.padStart(2, '0'))}`;
}

export const git = Effect.fn('codeGraphFixture.git')((cwd: string, args: readonly string[], timeoutMs = 30_000) =>
  runCommandEffect('git', ['-C', cwd, ...args], {
    maxOutputBytes: 16 * 1_048_576,
    timeoutMs,
  }),
);
