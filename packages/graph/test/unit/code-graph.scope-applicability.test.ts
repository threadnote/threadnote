import {Effect, FileSystem, Layer, Path} from 'effect';
import {describe, expect, it} from '@effect/vitest';
import {TestClock} from 'effect/testing';
import * as FC from 'fast-check';
import {fcProp} from '@threadnote/testing/fast-check-property';
import {CommandExecutor, runCommandEffect} from '@threadnote/platform/command';
import {makeIdempotentFixtureTempDirectoryScoped} from '@threadnote/testing/fixture-temp-directory';
import {observeCodeGraphAdmissionEnvironment} from '@threadnote/graph/admission_freshness';
import {CodeGraphEmbeddingIndex} from '@threadnote/graph/embedding';
import {CodeGraphIndexer, extractorSetIdentity} from '@threadnote/graph/indexer';
import {
  codeGraphInventoryScopeEvidence,
  inventoryRepository,
  observeCodeGraphStatusScope,
} from '@threadnote/graph/inventory';
import {
  BUILTIN_LANGUAGE_PACK_REGISTRY,
  CodeGraphLanguagePackRegistry,
  type CodeGraphLanguagePackRegistryShape,
} from '@threadnote/graph/languages/registry';
import {CodeGraphMaintenanceCoordinator} from '@threadnote/graph/maintenance/coordinator';
import {CodeGraphQueryService, observationFromCodeGraphStatus} from '@threadnote/graph/query';
import {observeCodeGraphQueryScope} from '@threadnote/graph/query/scope';
import {resolveRepositoryIdentity} from '@threadnote/graph/repository';
import {assessCodeGraphScopeApplicability, codeGraphScopeAdmitsPath} from '@threadnote/graph/scope/applicability';
import {CodeGraphStore} from '@threadnote/graph/store';
import {citationPlatformLayer} from '../helpers/citation-platform.js';

const recordedGitSubcommands: string[][] = [];
let recordGitSubcommands = false;

const spyPlatformLayer = Layer.effect(
  CommandExecutor,
  Effect.gen(function* () {
    const executor = yield* CommandExecutor;
    return CommandExecutor.of({
      ...executor,
      execute: (command, args, options) => {
        if (recordGitSubcommands && command === 'git') recordedGitSubcommands.push([...args]);
        return executor.execute(command, args, options);
      },
      ...(executor.executeBytes === undefined
        ? {}
        : {
            executeBytes: (command, args, options) => {
              if (recordGitSubcommands && command === 'git') recordedGitSubcommands.push([...args]);
              return executor.executeBytes!(command, args, options);
            },
          }),
    });
  }),
).pipe(Layer.provideMerge(citationPlatformLayer));

const storeLayer = CodeGraphStore.layer.pipe(Layer.provideMerge(spyPlatformLayer));
const queryTestLayer = CodeGraphQueryService.layer.pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      storeLayer,
      CodeGraphLanguagePackRegistry.layer,
      Layer.succeed(CodeGraphIndexer, {
        ensureCommit: () => Effect.die('Unexpected ensureCommit in status test'),
        index: () => Effect.die('Unexpected index in status test'),
      }),
      Layer.succeed(CodeGraphMaintenanceCoordinator, {
        kickOrdinary: () => Effect.succeed({reason: 'database-missing' as const, state: 'skipped' as const}),
        kickReconciliation: () => Effect.succeed({reason: 'database-missing' as const, state: 'skipped' as const}),
        kickResidual: () => Effect.succeed({reason: 'database-missing' as const, state: 'skipped' as const}),
        request: () => Effect.void,
        tick: () => Effect.succeed({reason: 'database-missing' as const, state: 'skipped' as const}),
      }),
      Layer.succeed(CodeGraphEmbeddingIndex, {
        check: () => Effect.succeed({state: 'unavailable' as const, reason: 'vectors disabled in fixture'}),
        ensure: () => Effect.die('Unexpected embedding ensure in status test'),
        search: () => Effect.die('Unexpected embedding search in status test'),
      }),
    ),
  ),
);

const scope = {admittedPrefixes: ['apps/a', 'shared/core'], controlPaths: ['package.json']};
const evidence = {
  repositoryId: 'repository',
  worktreeId: 'worktree',
  scopeKey: 'scope',
  definitionDigest: 'definition',
  closureDigest: 'closure',
  inventoryFingerprint: 'inventory',
  overlayFingerprint: undefined,
  extractorSet: 'extractor',
  policyFingerprint: 'policy',
  observedCommit: 'old',
  catalogFingerprint: 'catalog',
};

describe('scoped applicability', () => {
  it('advances observation without a build for unrelated commits and catalog changes', () => {
    expect(
      assessCodeGraphScopeApplicability(evidence, {...evidence, observedCommit: 'new', catalogFingerprint: 'new'}),
    ).toEqual({buildRequired: false, reason: 'equivalent-scope', observedCommit: 'new'});
  });

  it('requires a build when any effective scope evidence changes', () => {
    for (const field of [
      'repositoryId',
      'worktreeId',
      'scopeKey',
      'definitionDigest',
      'closureDigest',
      'inventoryFingerprint',
      'overlayFingerprint',
      'extractorSet',
      'policyFingerprint',
    ] as const) {
      expect(assessCodeGraphScopeApplicability(evidence, {...evidence, [field]: 'changed'}).buildRequired, field).toBe(
        true,
      );
    }
    expect(assessCodeGraphScopeApplicability(undefined, evidence).buildRequired).toBe(true);
  });

  fcProp(
    it,
    'positive scope respects path boundaries and always retains controls',
    {suffix: FC.stringMatching(/^[a-z]{1,12}$/)},
    ({suffix}) => {
      expect(codeGraphScopeAdmitsPath(scope, `apps/a/${suffix}.ts`)).toBe(true);
      expect(codeGraphScopeAdmitsPath(scope, `apps/a${suffix}/index.ts`)).toBe(false);
      expect(codeGraphScopeAdmitsPath(scope, `apps/b/${suffix}.ts`)).toBe(false);
      expect(codeGraphScopeAdmitsPath(scope, 'package.json')).toBe(true);
    },
    {fastCheck: {numRuns: 60}},
  );

  it.layer(queryTestLayer)(it => {
    it.effect(
      'preserves byte-identical scoped status evidence across clean, dirty, manifest, and ignore changes while skipping warm Git tree scans',
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const query = yield* CodeGraphQueryService;
          const temp = yield* makeIdempotentFixtureTempDirectoryScoped(fs, 'threadnote-scope-status-warm-');
          const root = path.join(temp, 'repo');
          const home = path.join(temp, 'home');
          yield* fs.makeDirectory(root, {recursive: true});
          yield* fs.makeDirectory(home, {recursive: true});

          const write = (relative: string, content: string) =>
            fs
              .makeDirectory(path.dirname(path.join(root, relative)), {recursive: true})
              .pipe(Effect.andThen(fs.writeFileString(path.join(root, relative), content)));
          const remove = (relative: string) => fs.remove(path.join(root, relative), {force: true});
          const git = (args: readonly string[]) => runCommandEffect('git', ['-C', root, ...args]);

          yield* git(['init', '-q']);
          yield* write('.gitignore', 'ignored-dir/\n');
          yield* write('MODULE.bazel', 'module(name = "fixture")\n');
          yield* write('package.json', JSON.stringify({private: true, workspaces: ['apps/*', 'shared/*']}));
          yield* write(
            'apps/a/package.json',
            JSON.stringify({name: '@fixture/a', dependencies: {'@fixture/core': 'workspace:*'}}),
          );
          yield* write('apps/a/BUILD.bazel', 'ts_project(name = "a", deps = ["//shared/core:core"])\n');
          yield* write('apps/a/index.ts', "export const a = 'v1';\n");
          yield* write('apps/a/secondary.ts', "export const secondary = 'v1';\n");
          yield* write('apps/a/logo.svg', '<svg xmlns="http://www.w3.org/2000/svg"/>\n');
          yield* write('apps/b/package.json', JSON.stringify({name: '@fixture/b'}));
          yield* write('apps/b/BUILD.bazel', 'ts_project(name = "b")\n');
          yield* write('apps/b/index.ts', "export const b = 'v1';\n");
          yield* write('shared/core/package.json', JSON.stringify({name: '@fixture/core'}));
          yield* write('shared/core/BUILD.bazel', 'ts_project(name = "core")\n');
          yield* write('shared/core/index.ts', "export const core = 'v1';\n");
          yield* write('shared/extra/package.json', JSON.stringify({name: '@fixture/extra'}));
          yield* write('shared/extra/BUILD.bazel', 'ts_project(name = "extra")\n');
          yield* write('shared/extra/index.ts', "export const extra = 'v1';\n");
          yield* git(['add', '.']);
          yield* git(['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'initial']);

          const manifestPath = path.join(home, 'seed-manifest.yaml');
          const projectManifest = {
            name: 'a',
            path: root,
            seed: [],
            uri: 'threadnote://resources/repos/a',
            graph: {closure: 'dependencies' as const, roots: ['apps/a']},
          };
          yield* fs.writeFileString(
            manifestPath,
            JSON.stringify({
              version: 1,
              projects: [projectManifest],
            }),
          );

          const captureGitSubcommands = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
            Effect.acquireUseRelease(
              Effect.sync(() => {
                recordedGitSubcommands.length = 0;
                recordGitSubcommands = true;
              }),
              () => effect,
              () =>
                Effect.sync(() => {
                  recordGitSubcommands = false;
                }),
            );

          const uncachedOracle = (currentIdentity: Effect.Success<ReturnType<typeof resolveRepositoryIdentity>>) =>
            Effect.gen(function* () {
              const freshPacks = {...BUILTIN_LANGUAGE_PACK_REGISTRY};
              const full = yield* inventoryRepository(currentIdentity, {
                project: projectManifest,
                languagePacks: freshPacks,
                includeOpaqueCorpusAssets: false,
                scopeObservationOnly: true,
              });
              const policy = yield* observeCodeGraphAdmissionEnvironment(currentIdentity);
              return {
                scope: full.scope,
                evidence: codeGraphInventoryScopeEvidence(
                  full,
                  currentIdentity,
                  extractorSetIdentity(full.files, freshPacks),
                  policy,
                ),
              };
            });

          const identity = yield* resolveRepositoryIdentity(root);
          const expectedClean = yield* uncachedOracle(identity);

          // Cold status warms the committed scoped basis cache.
          const coldStatus = yield* query.status(home, root, {
            project: 'a',
            manifestPath,
            observeSemantic: false,
            requestMaintenance: false,
          });
          expect(observationFromCodeGraphStatus(coldStatus)?.projectScope?.scope).toEqual(expectedClean.scope);
          expect(observationFromCodeGraphStatus(coldStatus)?.projectScope?.evidence).toEqual(expectedClean.evidence);

          // Warm clean status must not run ls-tree, cat-file, check-ignore, diff, or ls-files --others.
          const warmStatus = yield* captureGitSubcommands(
            query.status(home, root, {
              project: 'a',
              manifestPath,
              observeSemantic: false,
              requestMaintenance: false,
            }),
          );
          expect(observationFromCodeGraphStatus(warmStatus)?.projectScope?.scope).toEqual(expectedClean.scope);
          expect(observationFromCodeGraphStatus(warmStatus)?.projectScope?.evidence).toEqual(expectedClean.evidence);
          for (const args of recordedGitSubcommands) {
            expect(args).not.toContain('ls-tree');
            expect(args).not.toContain('cat-file');
            expect(args).not.toContain('check-ignore');
            expect(args).not.toContain('diff');
            expect(args.includes('ls-files') && args.includes('--others')).toBe(false);
          }

          // Dirty out-of-scope edits keep identical clean scope applicability without ls-tree or cat-file.
          yield* write('apps/b/index.ts', "export const b = 'dirty-out-of-scope';\n");
          yield* write('apps/b/untracked.ts', 'export const untrackedOut = 1;\n');
          const outOfScopeObserved = yield* captureGitSubcommands(
            observeCodeGraphQueryScope(home, root, identity, BUILTIN_LANGUAGE_PACK_REGISTRY, {
              project: 'a',
              manifestPath,
            }),
          );
          const outOfScopeCommands = [...recordedGitSubcommands];
          const expectedOutOfScope = yield* uncachedOracle(identity);
          expect(outOfScopeObserved?.scope).toEqual(expectedOutOfScope.scope);
          expect(outOfScopeObserved?.evidence).toEqual(expectedOutOfScope.evidence);
          expect(outOfScopeObserved?.evidence?.overlayFingerprint).toBeUndefined();
          for (const args of outOfScopeCommands) {
            expect(args).not.toContain('ls-tree');
            expect(args).not.toContain('cat-file');
          }
          yield* write('apps/b/index.ts', "export const b = 'v1';\n");
          yield* remove('apps/b/untracked.ts');

          // Dirty in-scope edits (modified source, new language pack file, deleted policy-excluded SVG) match byte-for-byte.
          yield* write('apps/a/index.ts', "export const a = 'dirty-in-scope';\n");
          yield* write('apps/a/script.py', 'VALUE = 1\n');
          yield* remove('apps/a/logo.svg');
          const inScopeObserved = yield* captureGitSubcommands(
            observeCodeGraphQueryScope(home, root, identity, BUILTIN_LANGUAGE_PACK_REGISTRY, {
              project: 'a',
              manifestPath,
            }),
          );
          const inScopeCommands = [...recordedGitSubcommands];
          const expectedInScope = yield* uncachedOracle(identity);
          expect(inScopeObserved?.scope).toEqual(expectedInScope.scope);
          expect(inScopeObserved?.evidence).toEqual(expectedInScope.evidence);
          expect(inScopeObserved?.evidence?.overlayFingerprint).toBeDefined();
          expect(inScopeObserved?.evidence?.extractorSet).not.toBe(expectedClean.evidence?.extractorSet);
          for (const args of inScopeCommands) {
            expect(args).not.toContain('ls-tree');
            expect(args).not.toContain('cat-file');
          }
          yield* git(['checkout', '--', 'apps/a/index.ts', 'apps/a/logo.svg']);
          yield* remove('apps/a/script.py');

          // Dirty workspace manifests (package.json and BUILD.bazel) re-resolve closure accurately.
          yield* write(
            'apps/a/package.json',
            JSON.stringify({
              name: '@fixture/a',
              dependencies: {'@fixture/core': 'workspace:*', '@fixture/extra': 'workspace:*'},
            }),
          );
          yield* write(
            'apps/a/BUILD.bazel',
            'ts_project(name = "a", deps = ["//shared/core:core", "//shared/extra:extra"])\n',
          );
          const dirtyManifestObserved = yield* captureGitSubcommands(
            observeCodeGraphQueryScope(home, root, identity, BUILTIN_LANGUAGE_PACK_REGISTRY, {
              project: 'a',
              manifestPath,
            }),
          );
          const dirtyManifestCommands = [...recordedGitSubcommands];
          const expectedDirtyManifest = yield* uncachedOracle(identity);
          expect(dirtyManifestObserved?.scope).toEqual(expectedDirtyManifest.scope);
          expect(dirtyManifestObserved?.evidence).toEqual(expectedDirtyManifest.evidence);
          expect(dirtyManifestObserved?.scope?.closureDigest).not.toBe(expectedClean.scope?.closureDigest);
          for (const args of dirtyManifestCommands) {
            expect(args).not.toContain('cat-file');
          }
          yield* git(['checkout', '--', 'apps/a/package.json', 'apps/a/BUILD.bazel']);

          // .threadnoteignore edits invalidate policyFingerprint and inventoryFingerprint accurately.
          yield* write('.threadnoteignore', 'apps/a/secondary.ts\n');
          const ignoredObserved = yield* observeCodeGraphQueryScope(
            home,
            root,
            identity,
            BUILTIN_LANGUAGE_PACK_REGISTRY,
            {project: 'a', manifestPath},
          );
          const expectedIgnored = yield* uncachedOracle(identity);
          expect(ignoredObserved?.scope).toEqual(expectedIgnored.scope);
          expect(ignoredObserved?.evidence).toEqual(expectedIgnored.evidence);
          expect(ignoredObserved?.evidence?.policyFingerprint).not.toBe(expectedClean.evidence?.policyFingerprint);
          expect(ignoredObserved?.evidence?.inventoryFingerprint).not.toBe(
            expectedClean.evidence?.inventoryFingerprint,
          );
          yield* remove('.threadnoteignore');

          // Warm .gitignore and nested .gitignore edits bypass cached committed basis and recompute inventoryFingerprint.
          yield* write('.gitignore', 'ignored-dir/\napps/a/secondary.ts\n');
          const rootGitIgnoredObserved = yield* observeCodeGraphQueryScope(
            home,
            root,
            identity,
            BUILTIN_LANGUAGE_PACK_REGISTRY,
            {project: 'a', manifestPath},
          );
          const expectedRootGitIgnored = yield* uncachedOracle(identity);
          expect(rootGitIgnoredObserved?.scope).toEqual(expectedRootGitIgnored.scope);
          expect(rootGitIgnoredObserved?.evidence).toEqual(expectedRootGitIgnored.evidence);
          expect(rootGitIgnoredObserved?.evidence?.inventoryFingerprint).not.toBe(
            expectedClean.evidence?.inventoryFingerprint,
          );
          yield* git(['checkout', '--', '.gitignore']);

          yield* write('apps/a/.gitignore', 'secondary.ts\n');
          const nestedGitIgnoredObserved = yield* observeCodeGraphQueryScope(
            home,
            root,
            identity,
            BUILTIN_LANGUAGE_PACK_REGISTRY,
            {project: 'a', manifestPath},
          );
          const expectedNestedGitIgnored = yield* uncachedOracle(identity);
          expect(nestedGitIgnoredObserved?.scope).toEqual(expectedNestedGitIgnored.scope);
          expect(nestedGitIgnoredObserved?.evidence).toEqual(expectedNestedGitIgnored.evidence);
          expect(nestedGitIgnoredObserved?.evidence?.inventoryFingerprint).not.toBe(
            expectedClean.evidence?.inventoryFingerprint,
          );
          yield* remove('apps/a/.gitignore');

          yield* write('apps/a/.gitignore', '.gitignore\nsecondary.ts\n');
          const selfHidingGitignoreObserved = yield* observeCodeGraphQueryScope(
            home,
            root,
            identity,
            BUILTIN_LANGUAGE_PACK_REGISTRY,
            {project: 'a', manifestPath},
          );
          const expectedSelfHiding = yield* uncachedOracle(identity);
          expect(selfHidingGitignoreObserved?.scope).toEqual(expectedSelfHiding.scope);
          expect(selfHidingGitignoreObserved?.evidence?.inventoryFingerprint).not.toBe(
            expectedClean.evidence?.inventoryFingerprint,
          );
          yield* remove('apps/a/.gitignore');

          // Cold-miss observeCodeGraphStatusScope forwards a custom languagePacks registry into inventoryRepository
          // instead of falling back to BUILTIN_LANGUAGE_PACK_REGISTRY.
          let customDiscoverCalls = 0;
          const customPacks: CodeGraphLanguagePackRegistryShape = {
            ...BUILTIN_LANGUAGE_PACK_REGISTRY,
            discoverWorkspace: files => {
              customDiscoverCalls += 1;
              return BUILTIN_LANGUAGE_PACK_REGISTRY.discoverWorkspace(files).pipe(
                Effect.map(workspace => ({
                  ...workspace,
                  diagnostics: [...workspace.diagnostics, 'apps/a/package.json: custom pack detector diagnostic'],
                })),
              );
            },
          };
          const customColdObserved = yield* observeCodeGraphStatusScope(identity, projectManifest, {
            includeOpaqueCorpusAssets: false,
            languagePacks: customPacks,
            threadnoteHome: home,
          });
          expect(customDiscoverCalls).toBeGreaterThan(0);
          expect(customColdObserved.scope).toBeDefined();
          expect(customColdObserved.scope?.diagnostics).toContain(
            'apps/a/package.json: custom pack detector diagnostic',
          );
          expect(expectedClean.scope?.diagnostics).not.toContain(
            'apps/a/package.json: custom pack detector diagnostic',
          );
          const builtinAfterCustom = yield* observeCodeGraphStatusScope(identity, projectManifest, {
            includeOpaqueCorpusAssets: false,
            languagePacks: BUILTIN_LANGUAGE_PACK_REGISTRY,
            threadnoteHome: home,
          });
          expect(builtinAfterCustom.scope).toEqual(expectedClean.scope);
        }).pipe(TestClock.withLive),
    );
  });
});
