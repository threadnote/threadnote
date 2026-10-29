import {Array as EffectArray, Option as EffectOption} from 'effect';
import {fcEffectProp} from '@threadnote/testing/fast-check-property';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {it as effectIt} from '@effect/vitest';
import {Deferred, Effect, Exit, FileSystem, Path, Result, Scope, Schema} from 'effect';
import {TestClock} from 'effect/testing';
import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import {CommandExecutor} from '@threadnote/platform/command';
import {codeGraphWorksetCatalogLayout} from '@threadnote/graph/workset_catalog/layout';
import {CodeGraphStore} from '@threadnote/graph/store';
import {codeGraphLayout} from '@threadnote/graph/layout';
import {resolveRepositoryIdentity} from '@threadnote/graph/repository';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {withCodeGraphMaintenanceIntent} from '@threadnote/graph/maintenance/gate';
import {readSeedManifest} from '@threadnote/workspace/manifest';
import {validateManagerProjectRoots} from '@threadnote/threadnote/manager/project/roots';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {
  handleManagerWorksetRequest,
  managerWorksetJobSummary,
  managerWorksetRequestAllowedDuringMaintenance,
  mutateManagerManifestProject,
  mutateManagerWorksetDefinition,
  readManagerWorksetCatalog,
  readManagerWorksetDefinition,
  readManagerManifestProject,
  type ManagerWorksetDefinitionMutation,
} from '@threadnote/threadnote/manager/worksets';
import {managerWorksetRepositoryLabel, PrepareJobPanel} from '@threadnote/manager/worksets_view';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {runEffect} from '../helpers/effect-runtime.js';
import {startManagerTestServer} from '../helpers/manager-test-server.js';
import {TestError} from '@threadnote/testing/test-error';
import {testHttpFetch} from '@threadnote/testing/http-fetch';
import {execFileSync} from '@threadnote/testing/node-child-process';
import {existsSync} from '@threadnote/testing/node-fs';
import {mkdtemp, rm, writeFile} from '@threadnote/testing/node-fs-promises';
import {tmpdir} from '@threadnote/testing/node-os';
import {join} from '@threadnote/testing/node-path';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

const JsonRecordSchema = Schema.Record(Schema.String, Schema.Unknown);
const withRest = <const S extends Schema.StructWithRest.Objects>(schema: S) =>
  Schema.StructWithRest(schema, [JsonRecordSchema]);
const CatalogSchema = withRest(Schema.Struct({revision: Schema.String}));
const CatalogMutationSchema = withRest(Schema.Struct({catalog: withRest(Schema.Struct({revision: Schema.String}))}));
const JobStartSchema = withRest(Schema.Struct({job: withRest(Schema.Struct({id: Schema.String}))}));
const JobListSchema = withRest(Schema.Struct({jobs: Schema.Array(Schema.Unknown)}));
const decodeCatalog = Schema.decodeUnknownSync(CatalogSchema);
const decodeCatalogMutation = Schema.decodeUnknownSync(CatalogMutationSchema);
const decodeJobStart = Schema.decodeUnknownSync(JobStartSchema);
const decodeJobList = Schema.decodeUnknownSync(JobListSchema);

interface WorksetFixture {
  readonly config: RuntimeConfig;
  readonly fs: FileSystem.FileSystem;
  readonly manifestPath: string;
  readonly path: Path.Path;
  readonly root: string;
}

function fixture(rawForRoot: (root: string) => string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-manager-worksets-'});
    const home = path.join(root, 'home');
    const manifestPath = path.join(root, 'threadnote.yaml');
    yield* fs.makeDirectory(home, {recursive: true});
    yield* fs.writeFileString(manifestPath, rawForRoot(root));
    return {
      config: {
        account: 'local',
        agentContextHome: home,
        agentId: 'threadnote',
        manifestPath,
        user: 'manager-test',
      },
      fs,
      manifestPath,
      path,
      root,
    } satisfies WorksetFixture;
  });
}

function manifest(root: string, worksets = ''): string {
  return EffectString.concat(
    EffectArray.join(
      EffectArray.filter(
        [
          '# manifest heading',
          'version: 1',
          'projects:',
          '  # project inventory note',
          '  - name: api',
          `    path: ${root}/api`,
          '    uri: threadnote://resources/repos/api',
          '    seed: []',
          '  - name: billing',
          `    path: ${root}/billing`,
          '    uri: threadnote://resources/repos/billing',
          '    seed: []',
          '  - name: worker',
          `    path: ${root}/worker`,
          '    uri: threadnote://resources/repos/worker',
          '    seed: []',
          worksets,
          '',
        ],
        line => line !== '',
      ),
      '\n',
    ),
    '\n',
  );
}

function updateMutation(
  revision: string,
  projects: readonly string[],
  overrides: {readonly name?: string; readonly workset?: string} = {},
): ManagerWorksetDefinitionMutation {
  return {
    description: 'Shared runtime',
    expectedRevision: revision,
    name: 'platform',
    operation: 'update',
    projects,
    workset: 'platform',
    ...overrides,
  };
}

function git(cwd: string, args: readonly string[]): void {
  execFileSync('git', ['-C', cwd, ...args], {stdio: 'pipe'});
}

describe('Manager Worksets manifest transactions', () => {
  effectIt.effect('retires only the configured logical scope when Manager clears graph configuration', () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const current = yield* fixture(root =>
          Effect2.pipe(
            manifest(root),
            EffectString.replace(
              '    seed: []',
              '    seed: []\n    graph:\n      roots: [apps/api]\n      closure: dependencies',
            ),
          ),
        );
        const repo = current.path.join(current.root, 'api');
        yield* current.fs.makeDirectory(repo);
        yield* Effect.sync(() => {
          git(repo, ['init', '-q']);
          git(repo, [
            '-c',
            'user.name=Test',
            '-c',
            'user.email=test@example.invalid',
            'commit',
            '--allow-empty',
            '-qm',
            'fixture',
          ]);
        });
        const identity = yield* resolveRepositoryIdentity(repo);
        const layout = codeGraphLayout(
          current.path,
          current.config.agentContextHome,
          identity.checkoutId,
          identity.worktreeId,
        );
        const store = yield* CodeGraphStore;
        const scopeId = `code-graph-scope:${sha256HexSync('threadnote://resources/repos/api')}`;
        for (const [index, selectedScope] of [undefined, scopeId].entries()) {
          const snapshotId = `cgsn_${Effect2.pipe((index + 1).toString(), EffectString.repeat(40))}`;
          yield* store.activate(
            layout.databasePath,
            identity,
            {
              commit: identity.headCommit,
              completedAt: '2026-09-20T00:00:00.000Z',
              dirty: false,
              edgeCount: 0,
              extractorSet: 'manager-test',
              fileCount: 0,
              id: snapshotId,
              repositoryId: identity.repositoryId,
              scopeId: selectedScope,
              state: 'ready',
              symbolCount: 0,
              worktreeId: identity.worktreeId,
            },
            [],
            [],
            [],
          );
          yield* store.promote(layout.databasePath, identity, snapshotId);
        }
        const revision = (yield* readManagerWorksetCatalog(current.config)).revision;
        const renamed = yield* mutateManagerManifestProject(current.config, {
          expectedRevision: revision,
          operation: 'update',
          project: 'api',
          name: 'renamed-api',
          path: repo,
          seed: [],
          uri: 'threadnote://resources/repos/api',
        });
        expect(yield* store.loadActiveViewFence(layout.databasePath, identity.worktreeId, scopeId)).toBeDefined();
        const cleared = yield* mutateManagerManifestProject(current.config, {
          clearGraph: true,
          expectedRevision: renamed.catalog.revision,
          operation: 'update',
          project: 'renamed-api',
          name: 'renamed-api',
          path: repo,
          seed: [],
          uri: 'threadnote://resources/repos/api',
        });
        expect(cleared.changed).toBe(true);
        expect(yield* store.loadActiveViewFence(layout.databasePath, identity.worktreeId, scopeId)).toBeUndefined();
        expect(yield* store.loadActiveViewFence(layout.databasePath, identity.worktreeId)).toBeDefined();
      }).pipe(provideTestLayer(ApplicationLayer)),
    ),
  );

  effectIt.effect('preserves a project graph scope while editing other project fields', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const current = yield* fixture(root =>
          Effect2.pipe(
            manifest(root),
            EffectString.replace(
              '    seed: []',
              EffectArray.join(
                [
                  '    seed: []',
                  '    graph:',
                  '      roots: [apps/api]',
                  '      closure: dependencies',
                  '      include: [tools/generated]',
                ],
                '\n',
              ),
            ),
          ),
        );
        const revision = (yield* readManagerWorksetCatalog(current.config)).revision;
        yield* mutateManagerManifestProject(current.config, {
          expectedRevision: revision,
          name: 'api',
          operation: 'update',
          path: `${current.root}/api`,
          project: 'api',
          seed: ['README.md'],
          uri: 'threadnote://resources/repos/api',
        });

        expect(yield* readManagerManifestProject(current.config, 'api')).toMatchObject({
          graph: {closure: 'dependencies', include: ['tools/generated'], roots: ['apps/api']},
          seed: ['README.md'],
        });
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect(
    'sets, updates, and clears an optional project graph scope without changing other project fields',
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const current = yield* fixture(root => manifest(root));
          const catalog = yield* readManagerWorksetCatalog(current.config);
          const set = yield* mutateManagerManifestProject(current.config, {
            expectedRevision: catalog.revision,
            graph: {closure: 'dependencies', include: ['tools/generated'], roots: ['apps/api']},
            name: 'api',
            operation: 'update',
            path: `${current.root}/api`,
            project: 'api',
            seed: [],
            uri: 'threadnote://resources/repos/api',
          });
          expect(set.changed).toBe(true);
          expect(yield* readManagerManifestProject(current.config, 'api')).toMatchObject({
            graph: {closure: 'dependencies', include: ['tools/generated'], roots: ['apps/api']},
          });

          const cleared = yield* mutateManagerManifestProject(current.config, {
            clearGraph: true,
            expectedRevision: set.catalog.revision,
            name: 'api',
            operation: 'update',
            path: `${current.root}/api`,
            project: 'api',
            seed: [],
            uri: 'threadnote://resources/repos/api',
          });
          expect(cleared.changed).toBe(true);
          expect(yield* readManagerManifestProject(current.config, 'api')).not.toHaveProperty('graph');
        }),
      ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('does not mutate an unchanged structural project graph', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const current = yield* fixture(root =>
          Effect2.pipe(
            manifest(root),
            EffectString.replace(
              '    seed: []',
              EffectArray.join(
                ['    seed: []', '    graph:', '      roots: [apps/api]', '      closure: dependencies'],
                '\n',
              ),
            ),
          ),
        );
        const before = yield* current.fs.readFileString(current.manifestPath);
        const revision = (yield* readManagerWorksetCatalog(current.config)).revision;
        const result = yield* mutateManagerManifestProject(current.config, {
          expectedRevision: revision,
          name: 'api',
          operation: 'update',
          path: `${current.root}/api`,
          project: 'api',
          seed: [],
          uri: 'threadnote://resources/repos/api',
        });

        expect(result.changed).toBe(false);
        expect(yield* current.fs.readFileString(current.manifestPath)).toBe(before);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('creates the first project and then the first workset from an empty manifest inventory', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const current = yield* fixture(() => '# empty inventory\nversion: 1\nprojects: []\n');
        const emptyCatalog = yield* readManagerWorksetCatalog(current.config);
        const project = yield* mutateManagerManifestProject(current.config, {
          expectedRevision: emptyCatalog.revision,
          name: 'api',
          operation: 'create',
          path: '~/src/api',
          seed: ['README.md', 'docs/**/*.md'],
          uri: 'threadnote://resources/repos/api',
        });
        const workset = yield* mutateManagerWorksetDefinition(current.config, {
          expectedRevision: project.catalog.revision,
          name: 'platform',
          operation: 'create',
          projects: ['api'],
        });
        const raw = yield* current.fs.readFileString(current.manifestPath);

        expect(project.catalog.projects).toContainEqual(expect.objectContaining({name: 'api', worksetCount: 0}));
        expect(workset.catalog.definitions).toContainEqual({memberCount: 1, name: 'platform'});
        expect(yield* readManagerManifestProject(current.config, 'API')).toEqual({
          name: 'api',
          path: '~/src/api',
          seed: ['README.md', 'docs/**/*.md'],
          uri: 'threadnote://resources/repos/api',
        });
        expect(raw).toContain('# empty inventory');
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('renames and deletes projects without losing member comments or silently deleting worksets', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const current = yield* fixture(root => {
          const withProjectComments = Effect2.pipe(
            manifest(
              root,
              EffectArray.join(
                [
                  'worksets:',
                  '  - name: platform',
                  '    projects:',
                  '      - api # retained membership note',
                  '      - billing',
                ],
                '\n',
              ),
            ),
            __effectPipeInput => {
              const __effectPipeStage0 = Effect2.pipe(
                __effectPipeInput,
                EffectString.replace('  - name: api', '  - name: api # project name note'),
              );
              const __effectPipeStage1 = Effect2.pipe(
                __effectPipeStage0,
                EffectString.replace(`    path: ${root}/api`, `    path: ${root}/api # project path note`),
              );
              const __effectPipeStage2 = Effect2.pipe(
                __effectPipeStage1,
                EffectString.replace(
                  '    uri: threadnote://resources/repos/api',
                  '    uri: threadnote://resources/repos/api # project URI note',
                ),
              );
              return __effectPipeStage2;
            },
          );
          return withProjectComments;
        });
        const revision = (yield* readManagerWorksetCatalog(current.config)).revision;
        const renamed = yield* mutateManagerManifestProject(current.config, {
          expectedRevision: revision,
          name: 'gateway',
          operation: 'update',
          path: `${current.root}/api with  two spaces`,
          project: 'api',
          seed: ['README.md'],
          uri: 'threadnote://resources/repos/gateway',
        });
        const afterRename = yield* current.fs.readFileString(current.manifestPath);
        const renamedProject = yield* readManagerManifestProject(current.config, 'gateway');
        expect(afterRename).toContain('- gateway # retained membership note');
        expect(afterRename).toContain('name: gateway # project name note');
        expect(afterRename).toContain('# project path note');
        expect(afterRename).toContain('uri: threadnote://resources/repos/gateway # project URI note');
        expect(renamedProject.path).toBe(`${current.root}/api with  two spaces`);
        expect(
          EffectOption.getOrUndefined(
            EffectArray.findFirst(renamed.catalog.projects, project => project.name === 'gateway'),
          )?.worksetCount,
        ).toBe(1);

        const deleted = yield* mutateManagerManifestProject(current.config, {
          confirm: true,
          expectedRevision: renamed.catalog.revision,
          operation: 'delete',
          project: 'gateway',
        });
        const definition = yield* readManagerWorksetDefinition(current.config, 'platform');
        const afterDelete = yield* current.fs.readFileString(current.manifestPath);
        expect(EffectArray.join(deleted.warnings, ' ')).toContain('unresolved member');
        expect(definition.members).toContainEqual(expect.objectContaining({configured: false, project: 'gateway'}));
        expect(afterDelete).toContain('- gateway # retained membership note');
        expect(afterDelete).not.toContain('name: gateway');
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('rejects rename collisions and treats unresolved target-name worksets as affected', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const collision = yield* fixture(root =>
          manifest(root, EffectArray.join(['worksets:', '  - name: collision', '    projects: [api, gateway]'], '\n')),
        );
        const before = yield* collision.fs.readFileString(collision.manifestPath);
        const collisionRevision = (yield* readManagerWorksetCatalog(collision.config)).revision;
        const collisionError = yield* mutateManagerManifestProject(collision.config, {
          expectedRevision: collisionRevision,
          name: 'gateway',
          operation: 'update',
          path: `${collision.root}/api`,
          project: 'api',
          seed: [],
          uri: 'threadnote://resources/repos/gateway',
        }).pipe(Effect.flip);
        expect(collisionError).toMatchObject({code: 'name-conflict', status: 409});
        expect(yield* collision.fs.readFileString(collision.manifestPath)).toBe(before);

        const unresolved = yield* fixture(root =>
          manifest(
            root,
            EffectArray.join(
              [
                'worksets:',
                '  - name: old-name',
                '    projects: [api]',
                '  - name: new-name',
                '    projects: [gateway]',
              ],
              '\n',
            ),
          ),
        );
        const unresolvedRevision = (yield* readManagerWorksetCatalog(unresolved.config)).revision;
        const renamed = yield* mutateManagerManifestProject(unresolved.config, {
          expectedRevision: unresolvedRevision,
          name: 'gateway',
          operation: 'update',
          path: `${unresolved.root}/api`,
          project: 'api',
          seed: [],
          uri: 'threadnote://resources/repos/gateway',
        });
        expect(
          EffectOption.getOrUndefined(
            EffectArray.findFirst(renamed.catalog.projects, project => project.name === 'gateway'),
          )?.worksetCount,
        ).toBe(2);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('supports case-only project renames and rejects duplicate unresolved references on create', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const current = yield* fixture(root =>
          manifest(
            root,
            EffectArray.join(
              [
                'worksets:',
                '  - name: platform',
                '    projects:',
                '      - api # preserve membership note',
                '  - name: unresolved',
                '    projects: [gateway, GATEWAY]',
              ],
              '\n',
            ),
          ),
        );
        const revision = (yield* readManagerWorksetCatalog(current.config)).revision;
        const renamed = yield* mutateManagerManifestProject(current.config, {
          expectedRevision: revision,
          name: 'API',
          operation: 'update',
          path: `${current.root}/api`,
          project: 'api',
          seed: [],
          uri: 'threadnote://resources/repos/api',
        });
        const afterRename = yield* current.fs.readFileString(current.manifestPath);
        expect(afterRename).toContain('- API # preserve membership note');
        expect(
          EffectOption.getOrUndefined(
            EffectArray.findFirst(renamed.catalog.projects, project => project.name === 'API'),
          )?.worksets,
        ).toEqual(['platform']);

        const beforeCreate = yield* current.fs.readFileString(current.manifestPath);
        const createError = yield* mutateManagerManifestProject(current.config, {
          expectedRevision: renamed.catalog.revision,
          name: 'gateway',
          operation: 'create',
          path: `${current.root}/gateway`,
          seed: [],
          uri: 'threadnote://resources/repos/gateway',
        }).pipe(Effect.flip);
        expect(createError).toMatchObject({code: 'name-conflict', status: 409});
        expect(yield* current.fs.readFileString(current.manifestPath)).toBe(beforeCreate);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('rejects renaming an unreferenced project into duplicate unresolved members', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const current = yield* fixture(root =>
          manifest(root, 'worksets:\n  - name: unresolved\n    projects: [gateway, GATEWAY]'),
        );
        const before = yield* current.fs.readFileString(current.manifestPath);
        const revision = (yield* readManagerWorksetCatalog(current.config)).revision;
        const error = yield* mutateManagerManifestProject(current.config, {
          expectedRevision: revision,
          name: 'gateway',
          operation: 'update',
          path: `${current.root}/api`,
          project: 'api',
          seed: [],
          uri: 'threadnote://resources/repos/gateway',
        }).pipe(Effect.flip);
        expect(error).toMatchObject({code: 'name-conflict', status: 409});
        expect(yield* current.fs.readFileString(current.manifestPath)).toBe(before);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('rejects unsafe project resource roots and escaping seed patterns without changing bytes', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const invalidInputs = [
          {seed: ['../secret'], uri: 'threadnote://resources/repos/new'},
          {seed: ['docs/../../secret'], uri: 'threadnote://resources/repos/new'},
          {seed: ['/etc/passwd'], uri: 'threadnote://resources/repos/new'},
          {seed: [], uri: 'threadnote://user/alice/memories'},
          {seed: [], uri: 'threadnote://resources/repos/new#fragment'},
        ];
        yield* Effect.forEach(
          invalidInputs,
          input =>
            Effect.gen(function* () {
              const current = yield* fixture(root => manifest(root));
              const before = yield* current.fs.readFileString(current.manifestPath);
              const revision = (yield* readManagerWorksetCatalog(current.config)).revision;
              const error = yield* mutateManagerManifestProject(current.config, {
                expectedRevision: revision,
                name: 'new',
                operation: 'create',
                path: '~/src/new',
                seed: input.seed,
                uri: input.uri,
              }).pipe(Effect.flip);
              expect(error).toMatchObject({code: 'invalid-input', status: 400});
              expect(yield* current.fs.readFileString(current.manifestPath)).toBe(before);
            }),
          {concurrency: 1, discard: true},
        );
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('rejects literal path controls and duplicate project resource roots without changing bytes', () =>
    Effect.scoped(
      Effect.gen(function* () {
        for (const path of ['/tmp/repo\nspoof', '/tmp/repo\rspoof', '/tmp/repo\tspoof']) {
          const current = yield* fixture(root => manifest(root));
          const before = yield* current.fs.readFileString(current.manifestPath);
          const revision = (yield* readManagerWorksetCatalog(current.config)).revision;
          const error = yield* mutateManagerManifestProject(current.config, {
            expectedRevision: revision,
            name: 'new',
            operation: 'create',
            path,
            seed: [],
            uri: 'threadnote://resources/repos/new',
          }).pipe(Effect.flip);
          expect(error).toMatchObject({code: 'invalid-input', status: 400});
          expect(yield* current.fs.readFileString(current.manifestPath)).toBe(before);
        }

        const current = yield* fixture(root =>
          Effect2.pipe(
            manifest(root),
            EffectString.replace('threadnote://resources/repos/billing', 'threadnote://resources/repos/api'),
          ),
        );
        const error = yield* readManagerWorksetCatalog(current.config).pipe(Effect.flip);
        expect(error).toMatchObject({code: 'manifest-invalid', status: 409});
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('creates the first workset without replacing unrelated manifest text', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const current = yield* fixture(root => manifest(root));
        const catalog = yield* readManagerWorksetCatalog(current.config);
        const result = yield* mutateManagerWorksetDefinition(current.config, {
          description: 'First shared workspace',
          expectedRevision: catalog.revision,
          name: 'platform',
          operation: 'create',
          projects: ['api', 'billing'],
        });
        const raw = yield* current.fs.readFileString(current.manifestPath);
        const definition = yield* readManagerWorksetDefinition(current.config, 'platform');

        expect(result.changed).toBe(true);
        expect(result.catalog.definitions).toContainEqual({
          description: 'First shared workspace',
          memberCount: 2,
          name: 'platform',
        });
        expect(EffectArray.map(definition.members, member => member.project)).toEqual(['api', 'billing']);
        expect(definition.members).toContainEqual(
          expect.objectContaining({configured: true, project: 'api', uri: 'threadnote://resources/repos/api'}),
        );
        expect(raw).toContain('# manifest heading');
        expect(raw).toContain('# project inventory note');
        expect(raw).toContain('worksets:');
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('observes unborn and linked-worktree branches through bounded Git porcelain', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const current = yield* fixture(root => manifest(root));
        const api = current.path.join(current.root, 'api');
        const billing = current.path.join(current.root, 'billing');
        const billingPrimary = current.path.join(current.root, 'billing-primary');
        const outside = current.path.join(current.root, 'outside-git');
        yield* current.fs.makeDirectory(api, {recursive: true});
        yield* current.fs.makeDirectory(billingPrimary, {recursive: true});
        yield* Effect.sync(() => {
          git(api, ['init', '-q', '-b', 'feature/worksets']);
          git(billingPrimary, ['init', '-q', '-b', 'main']);
          git(billingPrimary, [
            '-c',
            'user.name=Threadnote Test',
            '-c',
            'user.email=test@threadnote.local',
            'commit',
            '--allow-empty',
            '-qm',
            'fixture',
          ]);
          git(billingPrimary, ['branch', 'billing-linked']);
          git(billingPrimary, ['worktree', 'add', '-q', billing, 'billing-linked']);
        });
        yield* current.fs.makeDirectory(outside, {recursive: true});
        yield* current.fs.writeFileString(current.path.join(outside, 'HEAD'), 'ref: refs/heads/private-secret\n');
        yield* current.fs.makeDirectory(current.path.join(current.root, 'worker', '.git'), {recursive: true});
        yield* current.fs.symlink(
          current.path.join(outside, 'HEAD'),
          current.path.join(current.root, 'worker', '.git', 'HEAD'),
        );

        const catalog = yield* readManagerWorksetCatalog(current.config);
        const projects = new Map(EffectArray.map(catalog.projects, project => [project.name, project]));

        expect(projects.get('api')).toMatchObject({branch: 'feature/worksets', branchState: 'current'});
        expect(projects.get('billing')).toMatchObject({branch: 'billing-linked', branchState: 'current'});
        expect(projects.get('worker')).toMatchObject({branchState: 'missing'});
        expect(JSON.stringify(catalog)).not.toContain('private-secret');
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('keeps foreign project paths literal and does not probe a fabricated local checkout', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const current = yield* fixture(root =>
          Effect2.pipe(manifest(root), EffectString.replace(`    path: ${root}/api`, '    path: C:\\src\\api')),
        );
        const catalog = yield* readManagerWorksetCatalog(current.config);
        expect(
          EffectOption.getOrUndefined(EffectArray.findFirst(catalog.projects, project => project.name === 'api')),
        ).toMatchObject({
          branchState: 'not-observed',
          folder: 'api',
          path: 'C:\\src\\api',
        });
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('canonicalizes shared monorepo roots for distinct graph scopes and rejects non-directory paths', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const current = yield* fixture(() => 'version: 1\nprojects: []\n');
        const repository = current.path.join(current.root, 'repository');
        const nested = current.path.join(repository, 'packages', 'app');
        const alias = current.path.join(current.root, 'repository-alias');
        const file = current.path.join(current.root, 'not-a-directory');
        yield* current.fs.makeDirectory(nested, {recursive: true});
        yield* Effect.sync(() => git(repository, ['init', '-q', '-b', 'main']));
        yield* current.fs.symlink(repository, alias);
        yield* current.fs.writeFileString(file, 'not a repository root');

        const empty = yield* readManagerWorksetCatalog(current.config);
        const created = yield* mutateManagerManifestProject(current.config, {
          expectedRevision: empty.revision,
          graph: {closure: 'dependencies', roots: ['packages/app']},
          name: 'api',
          operation: 'create',
          path: nested,
          seed: [],
          uri: 'threadnote://resources/repos/api',
        });
        const canonicalRepository = yield* current.fs.realPath(repository);
        expect((yield* readManagerManifestProject(current.config, 'api')).path).toBe(canonicalRepository);

        const aliased = yield* mutateManagerManifestProject(current.config, {
          expectedRevision: created.catalog.revision,
          graph: {closure: 'dependencies', roots: ['packages/worker']},
          name: 'alias',
          operation: 'create',
          path: alias,
          seed: [],
          uri: 'threadnote://resources/repos/alias',
        });
        const sharedRoot = yield* readManagerManifestProject(current.config, 'alias');
        expect(sharedRoot).toMatchObject({
          graph: {closure: 'dependencies', roots: ['packages/worker']},
          path: canonicalRepository,
        });
        expect((yield* readManagerManifestProject(current.config, 'api')).path).toBe(canonicalRepository);
        const afterAlias = yield* current.fs.readFileString(current.manifestPath);

        const fileError = yield* mutateManagerManifestProject(current.config, {
          expectedRevision: aliased.catalog.revision,
          name: 'file',
          operation: 'create',
          path: file,
          seed: [],
          uri: 'threadnote://resources/repos/file',
        }).pipe(Effect.flip);
        expect(fileError).toMatchObject({code: 'invalid-input', status: 400});
        expect(yield* current.fs.readFileString(current.manifestPath)).toBe(afterAlias);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('rejects a canonical non-Git root whose stored path contains control characters', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const current = yield* fixture(() => 'version: 1\nprojects: []\n');
        const target = current.path.join(current.root, 'unsafe\nroot');
        const alias = current.path.join(current.root, 'safe-alias');
        yield* current.fs.makeDirectory(target, {recursive: true});
        yield* current.fs.symlink(target, alias);
        const catalog = yield* readManagerWorksetCatalog(current.config);
        const before = yield* current.fs.readFileString(current.manifestPath);

        const error = yield* mutateManagerManifestProject(current.config, {
          expectedRevision: catalog.revision,
          name: 'unsafe',
          operation: 'create',
          path: alias,
          seed: [],
          uri: 'threadnote://resources/repos/unsafe',
        }).pipe(Effect.flip);
        expect(error).toMatchObject({code: 'project-path-unavailable', status: 409});
        expect(yield* current.fs.readFileString(current.manifestPath)).toBe(before);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('fails closed when the bounded Git root probe cannot execute', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const current = yield* fixture(() => 'version: 1\nprojects: []\n');
        const repository = current.path.join(current.root, 'repository');
        yield* current.fs.makeDirectory(repository, {recursive: true});
        const command = yield* CommandExecutor;
        const unavailableGit = CommandExecutor.of({
          ...command,
          execute: (executable, args, options) =>
            executable === 'git'
              ? Effect.succeed({exitCode: 124, stderr: '', stdout: ''})
              : command.execute(executable, args, options),
        });
        const error = yield* validateManagerProjectRoots([], {
          name: 'repository',
          path: repository,
          seed: [],
          uri: 'threadnote://resources/repos/repository',
        }).pipe(Effect.provideService(CommandExecutor, unavailableGit), Effect.flip);
        expect(error.message).toBe('Git could not inspect the configured project root safely.');
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('does not rewrite an unchanged nested checkout path during a seed-only edit', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const current = yield* fixture(root => {
          const nested = `${root}/api/packages/app`;
          return Effect2.pipe(
            manifest(root),
            EffectString.replace(`    path: ${root}/api`, `    path: ${nested} # retained nested path`),
          );
        });
        const repository = current.path.join(current.root, 'api');
        const nested = current.path.join(repository, 'packages', 'app');
        yield* current.fs.makeDirectory(nested, {recursive: true});
        yield* Effect.sync(() => git(repository, ['init', '-q', '-b', 'main']));

        const catalog = yield* readManagerWorksetCatalog(current.config);
        const updated = yield* mutateManagerManifestProject(current.config, {
          expectedRevision: catalog.revision,
          name: 'api',
          operation: 'update',
          path: nested,
          project: 'api',
          seed: ['README.md'],
          uri: 'threadnote://resources/repos/api',
        });
        const raw = yield* current.fs.readFileString(current.manifestPath);
        expect(updated.changed).toBe(true);
        expect((yield* readManagerManifestProject(current.config, 'api')).path).toBe(nested);
        expect(raw).toContain(`path: ${nested} # retained nested path`);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('keeps seed-only edits repairable when legacy projects alias one checkout', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const current = yield* fixture(root =>
          Effect2.pipe(
            manifest(root),
            EffectString.replace(`    path: ${root}/billing`, `    path: ${root}/api/packages/billing`),
          ),
        );
        const repository = current.path.join(current.root, 'api');
        yield* current.fs.makeDirectory(current.path.join(repository, 'packages', 'billing'), {recursive: true});
        yield* Effect.sync(() => git(repository, ['init', '-q', '-b', 'main']));
        const catalog = yield* readManagerWorksetCatalog(current.config);

        const result = yield* mutateManagerManifestProject(current.config, {
          expectedRevision: catalog.revision,
          name: 'api',
          operation: 'update',
          path: repository,
          project: 'api',
          seed: ['README.md'],
          uri: 'threadnote://resources/repos/api',
        });
        expect(result.changed).toBe(true);
        expect((yield* readManagerManifestProject(current.config, 'api')).seed).toEqual(['README.md']);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('preserves a legacy canonicalizable URI during an unrelated project update', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const current = yield* fixture(root =>
          Effect2.pipe(
            manifest(root),
            EffectString.replace(
              '    uri: threadnote://resources/repos/api',
              '    uri: threadnote://resources/repos/api/ # legacy URI note',
            ),
          ),
        );
        const catalog = yield* readManagerWorksetCatalog(current.config);
        expect(catalog.projectEditability).toEqual({state: 'editable'});
        expect((yield* readManagerManifestProject(current.config, 'api')).uri).toBe(
          'threadnote://resources/repos/api/',
        );

        const result = yield* mutateManagerManifestProject(current.config, {
          expectedRevision: catalog.revision,
          name: 'api',
          operation: 'update',
          path: `${current.root}/api`,
          project: 'api',
          seed: ['README.md'],
          uri: 'threadnote://resources/repos/api/',
        });
        expect(result.changed).toBe(true);
        const raw = yield* current.fs.readFileString(current.manifestPath);
        expect(raw).toContain('uri: threadnote://resources/repos/api/ # legacy URI note');
        expect((yield* readManagerManifestProject(current.config, 'api')).seed).toEqual(['README.md']);

        const repaired = yield* mutateManagerManifestProject(current.config, {
          expectedRevision: result.catalog.revision,
          name: 'api',
          operation: 'update',
          path: `${current.root}/api`,
          project: 'api',
          seed: ['README.md'],
          uri: 'threadnote://resources/repos/api',
        });
        expect(repaired.changed).toBe(true);
        const repairedRaw = yield* current.fs.readFileString(current.manifestPath);
        expect(repairedRaw).toContain('uri: threadnote://resources/repos/api # legacy URI note');
        expect(repairedRaw).not.toContain('threadnote://resources/repos/api/');
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('preserves a legacy relative project path during an unrelated project update', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const current = yield* fixture(root =>
          Effect2.pipe(manifest(root), EffectString.replace(`    path: ${root}/api`, '    path: repos/api')),
        );
        const catalog = yield* readManagerWorksetCatalog(current.config);
        const result = yield* mutateManagerManifestProject(current.config, {
          expectedRevision: catalog.revision,
          name: 'api',
          operation: 'update',
          path: 'repos/api',
          project: 'api',
          seed: ['README.md'],
          uri: 'threadnote://resources/repos/api',
        });
        expect(result.changed).toBe(true);
        expect((yield* readManagerManifestProject(current.config, 'api')).path).toBe('repos/api');
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('treats an explicitly edited canonical-equivalent checkout path as a byte-stable no-op', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const current = yield* fixture(root => manifest(root));
        const repository = current.path.join(current.root, 'api');
        const nested = current.path.join(repository, 'packages', 'app');
        yield* current.fs.makeDirectory(nested, {recursive: true});
        yield* Effect.sync(() => git(repository, ['init', '-q', '-b', 'main']));
        const canonicalRepository = yield* current.fs.realPath(repository);
        const canonicalRaw = Effect2.pipe(
          yield* current.fs.readFileString(current.manifestPath),
          EffectString.replace(`    path: ${current.root}/api`, `    path: ${canonicalRepository}`),
        );
        yield* current.fs.writeFileString(current.manifestPath, canonicalRaw);
        const catalog = yield* readManagerWorksetCatalog(current.config);

        const result = yield* mutateManagerManifestProject(current.config, {
          expectedRevision: catalog.revision,
          name: 'api',
          operation: 'update',
          path: nested,
          project: 'api',
          seed: [],
          uri: 'threadnote://resources/repos/api',
        });
        expect(result).toMatchObject({changed: false, catalog: {revision: catalog.revision}});
        expect(yield* current.fs.readFileString(current.manifestPath)).toBe(canonicalRaw);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('keeps sibling linked worktrees distinct and preserves path comments after normalization', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const current = yield* fixture(root =>
          Effect2.pipe(
            manifest(root),
            EffectString.replace(`    path: ${root}/api`, `    path: ${root}/api # canonical root note`),
          ),
        );
        const primary = current.path.join(current.root, 'api');
        const nested = current.path.join(primary, 'packages', 'app');
        const linked = current.path.join(current.root, 'api-linked');
        yield* current.fs.makeDirectory(nested, {recursive: true});
        yield* Effect.sync(() => {
          git(primary, ['init', '-q', '-b', 'main']);
          git(primary, [
            '-c',
            'user.name=Threadnote Test',
            '-c',
            'user.email=test@threadnote.local',
            'commit',
            '--allow-empty',
            '-qm',
            'fixture',
          ]);
          git(primary, ['worktree', 'add', '-q', '-b', 'linked', linked]);
        });

        const catalog = yield* readManagerWorksetCatalog(current.config);
        const canonicalPrimary = yield* current.fs.realPath(primary);
        const canonicalLinked = yield* current.fs.realPath(linked);
        const normalized = yield* mutateManagerManifestProject(current.config, {
          expectedRevision: catalog.revision,
          name: 'api',
          operation: 'update',
          path: nested,
          project: 'api',
          seed: [],
          uri: 'threadnote://resources/repos/api',
        });
        const raw = yield* current.fs.readFileString(current.manifestPath);
        expect((yield* readManagerManifestProject(current.config, 'api')).path).toBe(canonicalPrimary);
        expect(raw).toContain(`path: ${canonicalPrimary} # canonical root note`);

        const withLinked = yield* mutateManagerManifestProject(current.config, {
          expectedRevision: normalized.catalog.revision,
          name: 'api-linked',
          operation: 'create',
          path: linked,
          seed: [],
          uri: 'threadnote://resources/repos/api-linked',
        });
        expect(EffectArray.map(withLinked.catalog.projects, project => project.name)).toContain('api-linked');
        expect((yield* readManagerManifestProject(current.config, 'api-linked')).path).toBe(canonicalLinked);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('preserves retained YAML comments while adding, removing, and canonicalizing members', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const current = yield* fixture(root =>
          manifest(
            root,
            EffectArray.join(
              [
                'worksets:',
                '  # workset note',
                '  - name: platform # name note',
                '    description: Shared runtime # description note',
                '    projects:',
                '      # API member note',
                '      - API # owns ingress',
                '      # billing member note',
                '      - billing # owns invoices',
                '      - worker # remove me',
              ],
              '\n',
            ),
          ),
        );
        const catalog = yield* readManagerWorksetCatalog(current.config);
        const result = yield* mutateManagerWorksetDefinition(
          current.config,
          updateMutation(catalog.revision, ['api', 'billing']),
        );
        const raw = yield* current.fs.readFileString(current.manifestPath);

        expect(result.changed).toBe(true);
        expect(raw).toContain('# manifest heading');
        expect(raw).toContain('# project inventory note');
        expect(raw).toContain('# workset note');
        expect(raw).toContain('name: platform # name note');
        expect(raw).toContain('description: Shared runtime # description note');
        expect(raw).toContain('# API member note');
        expect(raw).toContain('- api # owns ingress');
        expect(raw).toContain('# billing member note');
        expect(raw).toContain('- billing # owns invoices');
        expect(raw).not.toContain('remove me');
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('rejects stale revisions without changing manifest bytes', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const current = yield* fixture(root =>
          manifest(
            root,
            'worksets:\n  - name: platform\n    description: Shared runtime\n    projects: [api, billing]',
          ),
        );
        const before = yield* current.fs.readFileString(current.manifestPath);
        const error = yield* mutateManagerWorksetDefinition(
          current.config,
          updateMutation(Effect2.pipe('0', EffectString.repeat(64)), ['api', 'worker']),
        ).pipe(Effect.flip);

        expect(error).toMatchObject({code: 'revision-conflict', status: 409});
        expect(yield* current.fs.readFileString(current.manifestPath)).toBe(before);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('reports symlink manifests read-only and leaves their target untouched', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const current = yield* fixture(root =>
          manifest(root, 'worksets:\n  - name: platform\n    description: Shared runtime\n    projects: [api]'),
        );
        const target = current.path.join(current.root, 'authoritative.yaml');
        const linked = current.path.join(current.root, 'linked.yaml');
        const raw = yield* current.fs.readFileString(current.manifestPath);
        yield* current.fs.writeFileString(target, raw);
        yield* current.fs.symlink(target, linked);
        const config = {...current.config, manifestPath: linked};
        const catalog = yield* readManagerWorksetCatalog(config);
        const error = yield* mutateManagerWorksetDefinition(
          config,
          updateMutation(catalog.revision, ['api', 'billing']),
        ).pipe(Effect.flip);

        expect(catalog).toMatchObject({editability: {reason: 'manifest-symlink', state: 'read-only'}, readOnly: true});
        expect(error).toMatchObject({code: 'manifest-symlink', status: 409});
        expect(yield* current.fs.readFileString(target)).toBe(raw);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('fails closed on aliased workset ASTs and ambiguous case-insensitive names', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const aliased = yield* fixture(root =>
          manifest(
            root,
            EffectArray.join(['shared: &shared', '  name: platform', '  projects: [api]', 'worksets: [*shared]'], '\n'),
          ),
        );
        const aliasedBefore = yield* aliased.fs.readFileString(aliased.manifestPath);
        const aliasedCatalog = yield* readManagerWorksetCatalog(aliased.config);
        const aliasError = yield* mutateManagerWorksetDefinition(
          aliased.config,
          updateMutation(aliasedCatalog.revision, ['api', 'billing']),
        ).pipe(Effect.flip);

        expect(aliasedCatalog.editability).toEqual({reason: 'unsupported-workset-yaml', state: 'read-only'});
        expect(aliasError).toMatchObject({code: 'manifest-invalid', status: 409});
        expect(yield* aliased.fs.readFileString(aliased.manifestPath)).toBe(aliasedBefore);

        const duplicate = yield* fixture(root =>
          manifest(
            root,
            EffectArray.join(
              [
                '  - name: API',
                `    path: ${root}/ambiguous-api`,
                '    uri: threadnote://resources/repos/ambiguous-api',
                '    seed: []',
                'worksets:',
                '  - name: platform',
                '    projects: [api]',
                '  - name: PLATFORM',
                '    projects: [billing]',
              ],
              '\n',
            ),
          ),
        );
        const duplicateBefore = yield* duplicate.fs.readFileString(duplicate.manifestPath);
        const duplicateError = yield* readManagerWorksetCatalog(duplicate.config).pipe(Effect.flip);
        const definitionError = yield* readManagerWorksetDefinition(duplicate.config, 'platform').pipe(Effect.flip);

        expect(duplicateError).toMatchObject({code: 'manifest-invalid', status: 409});
        expect(definitionError).toMatchObject({code: 'manifest-invalid', status: 409});
        expect(yield* duplicate.fs.readFileString(duplicate.manifestPath)).toBe(duplicateBefore);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('treats anchored mutable workset scalars and sequences as read-only', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const anchored = [
          ['worksets:', '  - name: &workset-name platform', '    projects: [api]', 'copied_name: *workset-name'],
          [
            'worksets:',
            '  - name: platform',
            '    projects: &workset-projects [api]',
            'copied_projects: *workset-projects',
          ],
          [
            'worksets:',
            '  - name: platform',
            '    projects: [&workset-project api]',
            'copied_project: *workset-project',
          ],
        ];
        yield* Effect.forEach(
          anchored,
          lines =>
            Effect.gen(function* () {
              const current = yield* fixture(root => manifest(root, EffectArray.join(lines, '\n')));
              const before = yield* current.fs.readFileString(current.manifestPath);
              const catalog = yield* readManagerWorksetCatalog(current.config);
              const error = yield* mutateManagerWorksetDefinition(
                current.config,
                updateMutation(catalog.revision, ['api', 'billing']),
              ).pipe(Effect.flip);

              expect(catalog.editability).toEqual({reason: 'unsupported-workset-yaml', state: 'read-only'});
              expect(error).toMatchObject({code: 'manifest-invalid', status: 409});
              expect(yield* current.fs.readFileString(current.manifestPath)).toBe(before);
            }),
          {concurrency: 1, discard: true},
        );
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('keeps workset edits available when only the project YAML shape is read-only', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const current = yield* fixture(root =>
          Effect2.pipe(manifest(root), EffectString.replace('projects:', 'projects: &project-inventory')),
        );
        const catalog = yield* readManagerWorksetCatalog(current.config);
        expect(catalog).toMatchObject({
          projectEditability: {reason: 'unsupported-project-yaml', state: 'read-only'},
          projectsReadOnly: true,
          readOnly: false,
        });
        const created = yield* mutateManagerWorksetDefinition(current.config, {
          expectedRevision: catalog.revision,
          name: 'platform',
          operation: 'create',
          projects: ['api'],
        });
        const projectError = yield* mutateManagerManifestProject(current.config, {
          expectedRevision: created.catalog.revision,
          name: 'extra',
          operation: 'create',
          path: '~/src/extra',
          seed: [],
          uri: 'threadnote://resources/repos/extra',
        }).pipe(Effect.flip);
        expect(projectError).toMatchObject({code: 'manifest-invalid', status: 409});
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('rejects misleading long or whitespace-sensitive manifest names without truncating them', () =>
    Effect.scoped(
      Effect.gen(function* () {
        for (const unsafeName of [' platform ', Effect2.pipe('x', EffectString.repeat(257))]) {
          const current = yield* fixture(root =>
            manifest(root, `worksets:\n  - name: ${JSON.stringify(unsafeName)}\n    projects: [api]`),
          );
          const before = yield* current.fs.readFileString(current.manifestPath);
          const error = yield* readManagerWorksetCatalog(current.config).pipe(Effect.flip);

          expect(error).toMatchObject({code: 'manifest-invalid', status: 409});
          expect(yield* current.fs.readFileString(current.manifestPath)).toBe(before);
        }

        const maximumName = Effect2.pipe('w', EffectString.repeat(256));
        const supported = yield* fixture(root =>
          manifest(root, `worksets:\n  - name: ${maximumName}\n    projects: [api]`),
        );
        const catalog = yield* readManagerWorksetCatalog(supported.config);
        expect(catalog.definitions[0]?.name).toBe(maximumName);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('allows exactly one concurrent mutation for one optimistic revision', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const current = yield* fixture(root => manifest(root));
        const revision = (yield* readManagerWorksetCatalog(current.config)).revision;
        const outcomes = yield* TestClock.withLive(
          Effect.forEach(
            ['platform-a', 'platform-b'],
            name =>
              mutateManagerWorksetDefinition(current.config, {
                expectedRevision: revision,
                name,
                operation: 'create' as const,
                projects: ['api'],
              }).pipe(Effect.result),
            {concurrency: 'unbounded'},
          ),
        );
        const catalog = yield* readManagerWorksetCatalog(current.config);

        expect(EffectArray.filter(outcomes, Result.isSuccess)).toHaveLength(1);
        expect(EffectArray.filter(outcomes, Result.isFailure)).toHaveLength(1);
        expect(catalog.definitions).toHaveLength(1);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('allows exactly one mixed project/workset mutation for one optimistic revision', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const current = yield* fixture(root => manifest(root));
        const revision = (yield* readManagerWorksetCatalog(current.config)).revision;
        const outcomes = yield* TestClock.withLive(
          Effect.all(
            [
              mutateManagerManifestProject(current.config, {
                expectedRevision: revision,
                name: 'extra',
                operation: 'create' as const,
                path: '~/src/extra',
                seed: [],
                uri: 'threadnote://resources/repos/extra',
              }).pipe(Effect.result),
              mutateManagerWorksetDefinition(current.config, {
                expectedRevision: revision,
                name: 'platform',
                operation: 'create' as const,
                projects: ['api'],
              }).pipe(Effect.result),
            ],
            {concurrency: 'unbounded'},
          ),
        );
        expect(EffectArray.filter(outcomes, Result.isSuccess)).toHaveLength(1);
        expect(EffectArray.filter(outcomes, Result.isFailure)).toHaveLength(1);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('commits rename and delete while a corrupt derived catalog is only a cleanup warning', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const current = yield* fixture(root =>
          manifest(root, 'worksets:\n  - name: platform\n    description: Shared runtime\n    projects: [api]'),
        );
        const layout = codeGraphWorksetCatalogLayout(current.path, current.config.agentContextHome);
        yield* current.fs.makeDirectory(current.path.dirname(layout.databasePath), {recursive: true});
        yield* current.fs.writeFileString(layout.databasePath, 'not a sqlite catalog');
        const revision = (yield* readManagerWorksetCatalog(current.config)).revision;
        const renamed = yield* mutateManagerWorksetDefinition(
          current.config,
          updateMutation(revision, ['api', 'billing'], {name: 'platform-services'}),
        );
        const afterRename = yield* current.fs.readFileString(current.manifestPath);

        expect(renamed.changed).toBe(true);
        expect(EffectArray.map(renamed.catalog.definitions, definition => definition.name)).toEqual([
          'platform-services',
        ]);
        expect(EffectArray.join(renamed.warnings, ' ')).toContain('needs catalog repair before retirement');
        expect(afterRename).toContain('name: platform-services');
        expect(afterRename).toContain('projects: [ api, billing ]');

        const deleted = yield* mutateManagerWorksetDefinition(current.config, {
          confirm: true,
          expectedRevision: renamed.catalog.revision,
          operation: 'delete',
          workset: 'platform-services',
        });
        const afterDelete = yield* current.fs.readFileString(current.manifestPath);

        expect(deleted.changed).toBe(true);
        expect(deleted.catalog.definitions).toEqual([]);
        expect(afterDelete).not.toContain('platform-services');
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  fcEffectProp(
    effectIt,
    'keeps reorder-equivalent membership updates byte-stable',
    {order: fc.shuffledSubarray(['api', 'billing', 'worker'], {minLength: 3, maxLength: 3})},
    ({order}) =>
      Effect.scoped(
        Effect.gen(function* () {
          const current = yield* fixture(root =>
            manifest(
              root,
              'worksets:\n  - name: platform\n    description: Shared runtime\n    projects: [api, billing, worker]',
            ),
          );
          const before = yield* current.fs.readFileString(current.manifestPath);
          const revision = (yield* readManagerWorksetCatalog(current.config)).revision;
          const result = yield* mutateManagerWorksetDefinition(current.config, updateMutation(revision, order));

          expect(result.changed).toBe(false);
          expect(yield* current.fs.readFileString(current.manifestPath)).toBe(before);
        }),
      ).pipe(provideTestLayer(ApplicationLayer)),
    {fastCheck: {numRuns: 12}},
  );

  fcEffectProp(
    effectIt,
    'keeps reorder-equivalent graph roots and includes byte-stable',
    {
      includes: fc.shuffledSubarray(['tools/generated', 'scripts/codegen'], {minLength: 2, maxLength: 2}),
      roots: fc.shuffledSubarray(['apps/api', 'packages/core'], {minLength: 2, maxLength: 2}),
    },
    ({includes, roots}) =>
      Effect.scoped(
        Effect.gen(function* () {
          const current = yield* fixture(root =>
            Effect2.pipe(
              manifest(root),
              EffectString.replace(
                '    seed: []',
                EffectArray.join(
                  [
                    '    seed: []',
                    '    graph:',
                    '      roots: [apps/api, packages/core]',
                    '      closure: dependencies',
                    '      include: [tools/generated, scripts/codegen]',
                  ],
                  '\n',
                ),
              ),
            ),
          );
          const before = yield* current.fs.readFileString(current.manifestPath);
          const catalog = yield* readManagerWorksetCatalog(current.config);
          const result = yield* mutateManagerManifestProject(current.config, {
            expectedRevision: catalog.revision,
            graph: {closure: 'dependencies', include: includes, roots},
            name: 'api',
            operation: 'update',
            path: `${current.root}/api`,
            project: 'api',
            seed: [],
            uri: 'threadnote://resources/repos/api',
          });
          expect(result.changed).toBe(false);
          expect(yield* current.fs.readFileString(current.manifestPath)).toBe(before);
        }),
      ).pipe(provideTestLayer(ApplicationLayer)),
    {fastCheck: {numRuns: 12}},
  );

  fcEffectProp(
    effectIt,
    'renames every matching Workset reference and makes the repeated project update byte-stable',
    {
      references: fc.array(fc.boolean(), {maxLength: 16, minLength: 1}),
      uppercase: fc.boolean(),
    },
    ({references, uppercase}) =>
      Effect.scoped(
        Effect.gen(function* () {
          const original = uppercase ? 'API' : 'api';
          const worksets = EffectArray.join(
            [
              'worksets:',
              ...EffectArray.flatMap(references, (referencesApi, index) => [
                `  - name: workset-${index}`,
                `    projects: [${referencesApi ? original : 'billing'}]`,
              ]),
            ],
            '\n',
          );
          const current = yield* fixture(root => manifest(root, worksets));
          const revision = (yield* readManagerWorksetCatalog(current.config)).revision;
          const renamed = yield* mutateManagerManifestProject(current.config, {
            expectedRevision: revision,
            name: 'gateway',
            operation: 'update',
            path: `${current.root}/api`,
            project: original,
            seed: [],
            uri: 'threadnote://resources/repos/api',
          });
          const renamedBytes = yield* current.fs.readFileString(current.manifestPath);
          const parsed = yield* readSeedManifest(current.manifestPath);
          const repeated = yield* mutateManagerManifestProject(current.config, {
            expectedRevision: renamed.catalog.revision,
            name: 'gateway',
            operation: 'update',
            path: `${current.root}/api`,
            project: 'gateway',
            seed: [],
            uri: 'threadnote://resources/repos/api',
          });

          expect(
            EffectOption.getOrUndefined(
              EffectOption.map(EffectOption.fromNullishOr(parsed.worksets), __effectArrayReceiver =>
                EffectArray.map(__effectArrayReceiver, workset => workset.projects[0]),
              ),
            ),
          ).toEqual(EffectArray.map(references, value => (value ? 'gateway' : 'billing')));
          expect(repeated.changed).toBe(false);
          expect(yield* current.fs.readFileString(current.manifestPath)).toBe(renamedBytes);
        }),
      ).pipe(provideTestLayer(ApplicationLayer)),
    {fastCheck: {numRuns: 20}},
  );
});

describe('Manager Worksets API and human labels', () => {
  it('routes Worksets only after auth and never cold-builds repository graphs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'threadnote-manager-worksets-http-'));
    const config = {
      account: 'local',
      agentContextHome: join(root, 'home'),
      agentId: 'threadnote',
      manifestPath: join(root, 'threadnote.yaml'),
      user: 'manager-test',
    } satisfies RuntimeConfig;
    await writeFile(config.manifestPath, manifest(root));
    const server = await startManagerTestServer(config, 'workset-secret');
    const headers = {authorization: 'Bearer workset-secret'};
    try {
      expect((await testHttpFetch(`${server.url}/api/worksets`)).status).toBe(401);
      const catalogResponse = await testHttpFetch(`${server.url}/api/worksets`, {headers});
      const catalog = decodeCatalog(await catalogResponse.json());
      expect(catalogResponse.status).toBe(200);
      const unauthorizedProject = await testHttpFetch(`${server.url}/api/worksets/projects`, {
        body: JSON.stringify({expectedRevision: catalog.revision, name: 'x', operation: 'create'}),
        headers: {'content-type': 'application/json'},
        method: 'POST',
      });
      expect(unauthorizedProject.status).toBe(401);

      const createdResponse = await testHttpFetch(`${server.url}/api/worksets/definitions`, {
        body: JSON.stringify({
          expectedRevision: catalog.revision,
          name: 'platform',
          operation: 'create',
          projects: ['api', 'billing'],
        }),
        headers: {...headers, 'content-type': 'application/json'},
        method: 'POST',
      });
      expect(createdResponse.status).toBe(200);
      const created = decodeCatalogMutation(await createdResponse.json());

      const definitionResponse = await testHttpFetch(`${server.url}/api/worksets/definition?workset=platform`, {
        headers,
      });
      expect(definitionResponse.status).toBe(200);
      expect(await definitionResponse.json()).toMatchObject({
        members: [{project: 'api'}, {project: 'billing'}],
        name: 'platform',
      });

      const updatedResponse = await testHttpFetch(`${server.url}/api/worksets/definitions`, {
        body: JSON.stringify({
          description: 'Shared runtime services',
          expectedRevision: created.catalog.revision,
          name: 'platform',
          operation: 'update',
          projects: ['api'],
          workset: 'platform',
        }),
        headers: {...headers, 'content-type': 'application/json'},
        method: 'POST',
      });
      expect(updatedResponse.status).toBe(200);
      const updated = decodeCatalogMutation(await updatedResponse.json());
      expect(
        await (await testHttpFetch(`${server.url}/api/worksets/definition?workset=platform`, {headers})).json(),
      ).toMatchObject({description: 'Shared runtime services', members: [{project: 'api'}]});

      const statusResponse = await testHttpFetch(`${server.url}/api/worksets/status?workset=platform`, {headers});
      expect(statusResponse.status).toBe(200);
      expect(await statusResponse.json()).toMatchObject({catalog: {state: 'missing'}, workset: 'platform'});

      const [definitionsDuringMaintenance, statusDuringMaintenance, jobsDuringMaintenance, projectDuringMaintenance] =
        await runEffect(
          withCodeGraphMaintenanceIntent(
            config.agentContextHome,
            Effect.all(
              [
                Effect.promise(() => testHttpFetch(`${server.url}/api/worksets`, {headers})),
                Effect.promise(() => testHttpFetch(`${server.url}/api/worksets/status?workset=platform`, {headers})),
                Effect.promise(() => testHttpFetch(`${server.url}/api/worksets/jobs`, {headers})),
                Effect.promise(() =>
                  testHttpFetch(`${server.url}/api/worksets/projects`, {
                    body: JSON.stringify({
                      expectedRevision: updated.catalog.revision,
                      name: 'api',
                      operation: 'update',
                      path: `${root}/api`,
                      project: 'api',
                      seed: ['README.md'],
                      uri: 'threadnote://resources/repos/api',
                    }),
                    headers: {...headers, 'content-type': 'application/json'},
                    method: 'POST',
                  }),
                ),
              ] as const,
              {concurrency: 'unbounded'},
            ),
          ),
        );
      expect(definitionsDuringMaintenance.status).toBe(200);
      expect(jobsDuringMaintenance.status).toBe(200);
      expect(statusDuringMaintenance.status).toBe(409);
      expect(await statusDuringMaintenance.json()).toMatchObject({code: 'maintenance-busy'});
      expect(projectDuringMaintenance.status).toBe(200);
      const projectMutation = decodeCatalogMutation(await projectDuringMaintenance.json());
      expect(
        await (await testHttpFetch(`${server.url}/api/worksets/project?project=api`, {headers})).json(),
      ).toMatchObject({
        name: 'api',
        seed: ['README.md'],
      });

      const queryResponse = await testHttpFetch(`${server.url}/api/worksets/query`, {
        body: JSON.stringify({query: 'checkout ownership', workset: 'platform'}),
        headers: {...headers, 'content-type': 'application/json'},
        method: 'POST',
      });
      expect(queryResponse.status).toBe(409);
      expect(await queryResponse.json()).toMatchObject({code: 'catalog-missing'});
      expect(existsSync(join(config.agentContextHome, 'indexes', 'code-graph', 'repositories'))).toBe(false);

      const deletedResponse = await testHttpFetch(`${server.url}/api/worksets/definitions`, {
        body: JSON.stringify({
          confirm: true,
          expectedRevision: projectMutation.catalog.revision,
          operation: 'delete',
          workset: 'platform',
        }),
        headers: {...headers, 'content-type': 'application/json'},
        method: 'POST',
      });
      expect(deletedResponse.status).toBe(200);
      expect((await testHttpFetch(`${server.url}/api/worksets/definition?workset=platform`, {headers})).status).toBe(
        404,
      );
    } finally {
      await server.close();
      await rm(root, {force: true, recursive: true});
    }
  });

  effectIt.effect('maps malformed or non-object JSON bodies to a pathless 400', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const jobScope = yield* Scope.Scope;
        const config = {
          account: 'local',
          agentContextHome: '/unused',
          agentId: 'threadnote',
          manifestPath: '/unused/manifest.yaml',
          user: 'manager-test',
        } satisfies RuntimeConfig;
        const failed = yield* handleManagerWorksetRequest({
          body: Effect.fail(TestError.make({message: '/private/parser/path'})),
          config,
          contextKey: {},
          jobScope,
          method: 'POST',
          url: new URL('http://127.0.0.1/api/worksets/query'),
        });
        const nonObject = yield* handleManagerWorksetRequest({
          body: Effect.succeed([]),
          config,
          contextKey: {},
          jobScope,
          method: 'POST',
          url: new URL('http://127.0.0.1/api/worksets/query'),
        });

        expect(failed).toEqual({
          body: {code: 'invalid-json', error: 'Provide a JSON object request body.'},
          status: 400,
        });
        expect(nonObject).toEqual(failed);
        expect(JSON.stringify(failed)).not.toContain('/private');
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('interrupts an active prepare when the Manager job scope closes', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const current = yield* fixture(root =>
          manifest(root, 'worksets:\n  - name: platform\n    description: Shared runtime\n    projects: [api]'),
        );
        const contextKey = {};
        const readScope = yield* Scope.Scope;
        const jobScope = yield* Scope.make();
        const started = yield* Deferred.make<void>();
        const cleaned = yield* Deferred.make<void>();
        const startedResponse = yield* handleManagerWorksetRequest({
          body: Effect.succeed({workset: 'platform'}),
          config: current.config,
          contextKey,
          jobScope,
          method: 'POST',
          prepareWorkset: () =>
            Deferred.succeed(started, undefined).pipe(
              Effect.andThen(Effect.never),
              Effect.ensuring(Deferred.succeed(cleaned, undefined)),
            ),
          url: new URL('http://127.0.0.1/api/worksets/prepare'),
        });
        if (startedResponse === undefined) return yield* TestError.make({message: 'prepare route was not handled'});
        expect(startedResponse.status).toBe(202);
        const job = decodeJobStart(startedResponse.body).job;
        yield* Deferred.await(started);

        yield* Scope.close(jobScope, Exit.void);
        yield* Deferred.await(cleaned);
        const detail = yield* handleManagerWorksetRequest({
          body: Effect.succeed({}),
          config: current.config,
          contextKey,
          jobScope: readScope,
          method: 'GET',
          url: new URL(`http://127.0.0.1/api/worksets/jobs/${job.id}`),
        });

        expect(detail).toMatchObject({
          body: {
            job: {
              progress: {
                message: 'Preparation stopped; refresh readiness to confirm whether an atomic publication completed.',
                phase: 'cancelled',
              },
              status: 'cancelled',
            },
          },
          status: 200,
        });
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('makes live member progress pollable before preparation completes', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const current = yield* fixture(root => manifest(root, 'worksets:\n  - name: platform\n    projects: [api]'));
        const contextKey = {};
        const jobScope = yield* Scope.make();
        const progressObserved = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const started = yield* handleManagerWorksetRequest({
          body: Effect.succeed({concurrency: 2, workset: 'platform'}),
          config: current.config,
          contextKey,
          jobScope,
          method: 'POST',
          prepareWorkset: (_config, workset, options) =>
            Effect.sync(() => expect(options.concurrency).toBe(2)).pipe(
              Effect.andThen(
                options.onProgress?.({
                  activity: {completed: 5, phase: 'scanning', total: 10, unit: 'files'},
                  attempt: 1,
                  completed: 0,
                  elapsedMilliseconds: 2_500,
                  maxAttempts: 2,
                  message: 'api · indexing · scanning 5/10 files · 0/1 members.',
                  phase: 'indexing',
                  project: 'api',
                  total: 1,
                  type: 'code-graph-workset-progress',
                  version: 1,
                  workset,
                }) ?? Effect.void,
              ),
              Effect.andThen(Deferred.succeed(progressObserved, undefined)),
              Effect.andThen(Deferred.await(release)),
              Effect.as({
                coverage: {complete: true, excluded: 0, failed: 0, missing: 0, ready: 1, requested: 1},
                manifestDigest: Effect2.pipe('d', EffectString.repeat(64)),
                members: [
                  {
                    project: 'api',
                    projectionDigest: Effect2.pipe('e', EffectString.repeat(64)),
                    repositoryId: Effect2.pipe('f', EffectString.repeat(64)),
                    snapshotId: `cgsn_${Effect2.pipe('a', EffectString.repeat(40))}-direct`,
                    state: 'ready' as const,
                    symbolCount: 10,
                  },
                ],
                state: 'ready' as const,
                type: 'code-graph-workset-prepare' as const,
                version: 1 as const,
                workset,
              }),
            ),
          url: new URL('http://127.0.0.1/api/worksets/prepare'),
        });
        if (started === undefined) return yield* TestError.make({message: 'prepare route was not handled'});
        const id = decodeJobStart(started.body).job.id;
        yield* Deferred.await(progressObserved);

        const running = yield* handleManagerWorksetRequest({
          body: Effect.succeed({}),
          config: current.config,
          contextKey,
          jobScope,
          method: 'GET',
          url: new URL(`http://127.0.0.1/api/worksets/jobs/${id}`),
        });
        expect(running).toMatchObject({
          body: {
            job: {
              progress: {
                activity: {completed: 5, phase: 'scanning', total: 10, unit: 'files'},
                attempt: 1,
                completed: 0,
                elapsedMilliseconds: 2_500,
                phase: 'indexing',
                project: 'api',
              },
              status: 'running',
            },
          },
          status: 200,
        });

        yield* Deferred.succeed(release, undefined);
        yield* Effect.yieldNow;
        const completed = yield* handleManagerWorksetRequest({
          body: Effect.succeed({}),
          config: current.config,
          contextKey,
          jobScope,
          method: 'GET',
          url: new URL(`http://127.0.0.1/api/worksets/jobs/${id}`),
        });
        expect(completed).toMatchObject({
          body: {job: {progress: {completed: 1, phase: 'completed'}, status: 'completed'}},
          status: 200,
        });
        yield* Scope.close(jobScope, Exit.void);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('registers one Manager-lifetime finalizer while retaining only 32 completed jobs', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const current = yield* fixture(root =>
          manifest(root, 'worksets:\n  - name: platform\n    description: Shared runtime\n    projects: [api]'),
        );
        const contextKey = {};
        const jobScope = yield* Scope.make();
        for (let index = 0; index < 33; index += 1) {
          const started = yield* handleManagerWorksetRequest({
            body: Effect.succeed({workset: 'platform'}),
            config: current.config,
            contextKey,
            jobScope,
            method: 'POST',
            prepareWorkset: (_config, workset) =>
              Effect.succeed({
                coverage: {complete: true, excluded: 0, failed: 0, missing: 0, ready: 0, requested: 0},
                manifestDigest: Effect2.pipe('d', EffectString.repeat(64)),
                members: [],
                state: 'ready',
                type: 'code-graph-workset-prepare',
                version: 1,
                workset,
              }),
            url: new URL('http://127.0.0.1/api/worksets/prepare'),
          });
          if (started === undefined) return yield* TestError.make({message: 'prepare route was not handled'});
          const id = decodeJobStart(started.body).job.id;
          yield* Effect.yieldNow;
          const detail = yield* handleManagerWorksetRequest({
            body: Effect.succeed({}),
            config: current.config,
            contextKey,
            jobScope,
            method: 'GET',
            url: new URL(`http://127.0.0.1/api/worksets/jobs/${id}`),
          });
          expect(detail).toMatchObject({body: {job: {status: 'completed'}}, status: 200});
          expect(jobScope.state._tag).toBe('Open');
          if (jobScope.state._tag === 'Open') {
            const finalizerCount =
              Number(jobScope.state.finalizer !== undefined) + (jobScope.state.finalizers?.size ?? 0);
            expect(finalizerCount).toBe(1);
          }
        }
        const listed = yield* handleManagerWorksetRequest({
          body: Effect.succeed({}),
          config: current.config,
          contextKey,
          jobScope,
          method: 'GET',
          url: new URL('http://127.0.0.1/api/worksets/jobs'),
        });
        const listedJobs = listed === undefined ? undefined : decodeJobList(listed.body).jobs;
        expect(listedJobs).toHaveLength(32);
        yield* Scope.close(jobScope, Exit.void);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  it('keeps only manifest and job operations available during graph maintenance', () => {
    expect(managerWorksetRequestAllowedDuringMaintenance('GET', '/api/worksets')).toBe(true);
    expect(managerWorksetRequestAllowedDuringMaintenance('GET', '/api/worksets/definition')).toBe(true);
    expect(managerWorksetRequestAllowedDuringMaintenance('GET', '/api/worksets/jobs')).toBe(true);
    expect(managerWorksetRequestAllowedDuringMaintenance('POST', '/api/worksets/jobs/cancel')).toBe(true);
    expect(managerWorksetRequestAllowedDuringMaintenance('GET', '/api/worksets/status')).toBe(false);
    expect(managerWorksetRequestAllowedDuringMaintenance('POST', '/api/worksets/prepare')).toBe(false);
    expect(managerWorksetRequestAllowedDuringMaintenance('POST', '/api/worksets/query')).toBe(false);
    expect(managerWorksetRequestAllowedDuringMaintenance('POST', '/api/worksets/context-brief')).toBe(false);
  });

  it('renders repository name, observed branch, and folder before opaque identifiers', () => {
    const definition = {
      configuredMembers: 1,
      members: [
        {
          branch: 'feature/worksets',
          branchState: 'current' as const,
          configured: true,
          folder: 'api-service',
          path: '/workspace/api-service',
          project: 'api',
        },
      ],
      name: 'platform',
      unresolvedMembers: 0,
    };
    expect(managerWorksetRepositoryLabel('api', definition)).toBe(
      'api · observed branch feature/worksets · api-service · /workspace/api-service',
    );
    expect(managerWorksetRepositoryLabel(Effect2.pipe('a', EffectString.repeat(64)))).toBe('Repository aaaaaaaa…');
  });

  it('renders terminal prepare receipts without repository or snapshot IDs as primary labels', () => {
    const repositoryId = Effect2.pipe('b', EffectString.repeat(64));
    const snapshotId = `cgsn_${Effect2.pipe('c', EffectString.repeat(40))}-direct`;
    const job = {
      createdAt: '2026-08-12T12:00:00.000Z',
      error: 'No ready generation was published; review member receipts.',
      id: 'cgwj_example',
      progress: {completed: 2, message: 'Preparation finished without publishing.', phase: 'failed' as const, total: 2},
      result: {
        coverage: {complete: false, excluded: 0, failed: 1, missing: 0, ready: 1, requested: 2},
        manifestDigest: Effect2.pipe('d', EffectString.repeat(64)),
        members: [
          {
            project: 'api',
            projectionDigest: Effect2.pipe('e', EffectString.repeat(64)),
            repositoryId,
            snapshotId,
            state: 'ready' as const,
            symbolCount: 42,
          },
          {
            detail: {
              code: 'unknown' as const,
              errorType: 'TestError',
              retryable: false,
              summary: 'Repository indexing failed; run graph diagnostics for this project and retry.',
            },
            project: 'worker',
            reason: 'index-failed' as const,
            state: 'failed' as const,
          },
        ],
        state: 'failed' as const,
        type: 'code-graph-workset-prepare' as const,
        version: 1 as const,
        workset: 'platform',
      },
      status: 'failed' as const,
      workset: 'platform',
    };
    const markup = renderToStaticMarkup(
      createElement(PrepareJobPanel, {
        definition: {
          configuredMembers: 2,
          members: [
            {
              branch: 'main',
              branchState: 'current',
              configured: true,
              folder: 'api',
              path: '/workspace/api',
              project: 'api',
            },
            {
              branchState: 'missing',
              configured: true,
              folder: 'worker',
              path: '/workspace/worker',
              project: 'worker',
            },
          ],
          name: 'platform',
          unresolvedMembers: 0,
        },
        job,
        onCancel: () => undefined,
      }),
    );

    expect(markup).toContain('api');
    expect(markup).toContain('observed branch main');
    expect(markup).toContain('/workspace/api');
    expect(markup).toContain('worker');
    expect(markup).toContain('index-failed');
    expect(markup).not.toContain(repositoryId);
    expect(markup).not.toContain(snapshotId);
    expect(managerWorksetJobSummary(job)).not.toHaveProperty('result');
    expect(JSON.stringify(managerWorksetJobSummary(job))).not.toContain(repositoryId);
  });
});
