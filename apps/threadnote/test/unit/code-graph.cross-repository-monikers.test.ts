import {Array as EffectArray} from 'effect';
import {fcProp} from '@threadnote/testing/fast-check-property';
import {Database} from 'bun:sqlite';
import {it as effectIt} from '@effect/vitest';
import {Option, Effect, Schema} from 'effect';
import * as FC from 'fast-check';
import {describe, expect, it} from 'vitest';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {
  canonicalCodeGraphMonikers,
  codeGraphPackageMoniker,
  codeGraphProtobufMoniker,
  parseCodeGraphMonikerV1,
} from '@threadnote/graph/cross_repository/monikers';
import {
  CODE_GRAPH_MONIKER_STRICT_PARSE_OPTIONS,
  CodeGraphMonikerSchemaV1,
} from '@threadnote/graph/cross_repository/types';
import {extractStructuredSchemaFacts} from '@threadnote/graph/languages/schemas/extractor';
import {codeGraphLanguagePack as structuredSchemaLanguagePack} from '@threadnote/graph/languages/schemas/pack';
import {packCacheIdentity} from '@threadnote/graph/languages/registry';
import {CodeGraphStore} from '@threadnote/graph/store';
import type {CodeGraphDirectPersistentCapacityProtector} from '@threadnote/graph/store/models';
import type {CodeGraphStoreShape} from '@threadnote/graph/store/shape';
import type {
  CodeGraphFileFacts,
  CodeGraphInventoryFile,
  CodeGraphSnapshot,
  RepositoryIdentity,
} from '@threadnote/graph/types';
import {discoverManifestWorkspace} from '@threadnote/graph/workspace';
import {join, mkdtemp, rm} from '../helpers/effect-filesystem.js';
import {runEffect} from '../helpers/effect-runtime.js';
import {claimPersistentBuildForTest} from '@threadnote/graph/test/helpers/code-graph-build';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

const span = {column: 1, endColumn: 8, endLine: 2, line: 2} as const;
const unprotectedCacheWrite: CodeGraphDirectPersistentCapacityProtector = (_boundary, transaction) => transaction;

describe('cross-repository declarations and monikers', () => {
  it('keeps npm external declarations separate from exact local component dependencies', () => {
    const workspace = discoverManifestWorkspace([
      file('package.json', 'npm-manifest', JSON.stringify({name: '@acme/root', workspaces: ['packages/*']})),
      file('packages/core/package.json', 'npm-manifest', JSON.stringify({name: '@acme/core', version: '1.2.3'})),
      file(
        'packages/app/package.json',
        'npm-manifest',
        JSON.stringify(
          {
            dependencies: {
              '@ACME/CORE': 'workspace:*',
              legacyTools: 'npm:@scope/tools@^2.0.0',
              Lodash: '^4.17.21',
            },
            devDependencies: {Vitest: '~4.1.0'},
            name: '@acme/app',
            optionalDependencies: {'optional-lib': '2.x'},
            peerDependencies: {React: '>=18'},
            version: '2.0.0',
          },
          null,
          2,
        ),
      ),
    ]);
    const app = Option.getOrUndefined(
      EffectArray.findFirst(workspace.projects, project => project.name === '@acme/app'),
    )!;
    const core = Option.getOrUndefined(
      EffectArray.findFirst(workspace.projects, project => project.name === '@acme/core'),
    )!;

    expect(app.dependencies).toContain(core.id);
    expect(app.externalDependencies).toEqual([
      expect.objectContaining({
        importAlias: 'legacytools',
        kind: 'runtime',
        name: '@scope/tools',
        versionConstraint: '^2.0.0',
      }),
      expect.objectContaining({importAlias: 'lodash', kind: 'runtime', name: 'lodash', versionConstraint: '^4.17.21'}),
      expect.objectContaining({
        importAlias: 'optional-lib',
        kind: 'optional',
        name: 'optional-lib',
        versionConstraint: '2.x',
      }),
      expect.objectContaining({importAlias: 'react', kind: 'peer', name: 'react', versionConstraint: '>=18'}),
      expect.objectContaining({
        importAlias: 'vitest',
        kind: 'development',
        name: 'vitest',
        versionConstraint: '~4.1.0',
      }),
    ]);
    expect(
      Option.getOrUndefined(
        Option.map(Option.fromNullishOr(app.externalDependencies), __effectArrayReceiver =>
          EffectArray.some(__effectArrayReceiver, dependency => dependency.name === '@acme/core'),
        ),
      ),
    ).toBe(false);
    expect(
      Option.getOrUndefined(
        Option.map(Option.fromNullishOr(app.externalDependencies), __effectArrayReceiver =>
          EffectArray.every(
            __effectArrayReceiver,
            dependency => dependency.evidence.path === 'packages/app/package.json',
          ),
        ),
      ),
    ).toBe(true);
    expect(
      Option.getOrUndefined(
        Option.map(Option.fromNullishOr(app.externalDependencies), __effectArrayReceiver =>
          EffectArray.every(__effectArrayReceiver, dependency => dependency.evidence.span !== undefined),
        ),
      ),
    ).toBe(true);
    expect(
      Option.getOrUndefined(
        Option.map(Option.fromNullishOr(app.monikers), monikers =>
          EffectArray.filter(
            monikers,
            (moniker, index) => index in monikers && moniker.scheme === 'package' && moniker.role === 'import',
          ),
        ),
      ),
    ).toHaveLength(5);
    expect(app.monikers).toContainEqual(
      expect.objectContaining({identity: 'package:npm:@scope/tools', packageVersion: '^2.0.0', role: 'import'}),
    );
    expect(
      Option.getOrUndefined(
        Option.map(Option.fromNullishOr(app.monikers), __effectArrayReceiver =>
          EffectArray.some(__effectArrayReceiver, moniker => moniker.identity === 'package:npm:legacytools'),
        ),
      ),
    ).toBe(false);
    expect(app.monikers).toContainEqual(
      expect.objectContaining({
        identity: 'package:npm:@acme/app',
        packageVersion: '2.0.0',
        role: 'export',
      }),
    );
  });

  it('preserves an external declaration when duplicate local aliases make resolution ambiguous', () => {
    const workspace = discoverManifestWorkspace([
      file('package.json', 'npm-manifest', JSON.stringify({name: '@acme/root', workspaces: ['packages/*']})),
      file('packages/one/package.json', 'npm-manifest', JSON.stringify({name: '@acme/duplicate'})),
      file('packages/two/package.json', 'npm-manifest', JSON.stringify({name: '@acme/duplicate'})),
      file(
        'packages/app/package.json',
        'npm-manifest',
        JSON.stringify({dependencies: {'@acme/duplicate': '^1.0.0'}, name: '@acme/app'}),
      ),
    ]);
    const app = Option.getOrUndefined(
      EffectArray.findFirst(workspace.projects, project => project.name === '@acme/app'),
    )!;
    expect(app.dependencies).toEqual([]);
    expect(app.externalDependencies).toContainEqual(
      expect.objectContaining({
        importAlias: '@acme/duplicate',
        name: '@acme/duplicate',
        versionConstraint: '^1.0.0',
      }),
    );
    expect(workspace.diagnostics).toContain(
      'packages/app/package.json: local dependency alias @acme/duplicate matched multiple declared projects',
    );
  });

  it('extracts a large npm declaration surface with one indexed evidence pass', () => {
    const dependencies = EffectRecord.fromEntries(
      Array.from({length: 10_000}, (_, index) => [
        `dependency-${Effect2.pipe(String(index), EffectString.padStart(5, '0'))}`,
        `^${index}.0.0`,
      ]),
    );
    const startedAt = performance.now();
    const workspace = discoverManifestWorkspace([
      file('package.json', 'npm-manifest', JSON.stringify({dependencies, name: '@acme/large-manifest'}, null, 2)),
    ]);
    const elapsedMilliseconds = performance.now() - startedAt;
    const project = Option.getOrUndefined(
      EffectArray.findFirst(workspace.projects, candidate => candidate.name === '@acme/large-manifest'),
    )!;
    expect(project.externalDependencies).toHaveLength(10_000);
    expect(
      new Set(
        Option.getOrUndefined(
          Option.map(Option.fromNullishOr(project.externalDependencies), __effectArrayReceiver =>
            EffectArray.map(__effectArrayReceiver, dependency => dependency.evidence.span?.line),
          ),
        ),
      ).size,
    ).toBe(10_000);
    expect(elapsedMilliseconds).toBeLessThan(4_000);
  }, 10_000);

  it('extracts scoped protobuf file/package/message/service/RPC monikers with evidence on both sides', () => {
    const facts = protobufFacts(
      file(
        'proto/orders/v1/orders.proto',
        'protobuf',
        `syntax = "proto3";
         package acme.orders.v1;
         import "acme/common/v1/money.proto";
         message Order { string id = 1; }
         service Orders { rpc GetOrder (Order) returns (Order); }`,
      ),
    );
    expect(
      Option.getOrUndefined(
        Option.map(Option.fromNullishOr(facts.monikers), __effectArrayReceiver =>
          EffectArray.map(__effectArrayReceiver, moniker => [moniker.role, moniker.kind, moniker.identity]),
        ),
      ),
    ).toEqual([
      ['import', 'file', 'protobuf:file:acme/common/v1/money.proto'],
      ['export', 'file', 'protobuf:file:proto/orders/v1/orders.proto'],
      ['export', 'message', 'protobuf:message:acme.orders.v1.Order'],
      ['export', 'package', 'protobuf:package:acme.orders.v1'],
      ['export', 'rpc', 'protobuf:rpc:acme.orders.v1.Orders.GetOrder'],
      ['export', 'service', 'protobuf:service:acme.orders.v1.Orders'],
    ]);
    expect(
      Option.getOrUndefined(
        Option.map(Option.fromNullishOr(facts.monikers), __effectArrayReceiver =>
          EffectArray.every(__effectArrayReceiver, moniker => moniker.evidence.path === facts.path),
        ),
      ),
    ).toBe(true);
    expect(
      Option.getOrUndefined(
        Option.map(Option.fromNullishOr(facts.monikers), __effectArrayReceiver =>
          EffectArray.every(__effectArrayReceiver, moniker => moniker.evidence.span.line >= 1),
        ),
      ),
    ).toBe(true);
    const message = Option.getOrUndefined(
      Option.map(Option.fromNullishOr(facts.monikers), __effectArrayReceiver =>
        Option.getOrUndefined(
          EffectArray.findFirst(
            __effectArrayReceiver,
            moniker => moniker.kind === 'message' && moniker.scheme === 'protobuf',
          ),
        ),
      ),
    );
    expect(message && 'symbolId' in message ? message.symbolId : undefined).toMatch(/^cgs_/u);
  });

  it('retains bounded protobuf import edges after declaration monikers fill their independent budget', () => {
    const declarations = EffectArray.join(
      Array.from({length: 3_999}, (_, index) => `message Message${index} {}`),
      '\n',
    );
    const facts = protobufFacts(
      file('proto/bounded.proto', 'protobuf', `syntax = "proto3";\n${declarations}\nimport "acme/common.proto";`),
    );
    expect(facts.symbols).toHaveLength(4_000);
    expect(facts.monikers).toHaveLength(4_000);
    expect(facts.edges).toContainEqual(expect.objectContaining({relation: 'imports', targetName: 'acme/common.proto'}));
    expect(facts.diagnostics).toContain(
      'proto/bounded.proto: protobuf monikers exceeded 4000 entries and were truncated',
    );
  });

  it('retains local import edges when a strict cross-repository import identity is rejected', () => {
    const facts = protobufFacts(
      file(
        'proto/imports.proto',
        'protobuf',
        'syntax = "proto3"; import "../outside.proto"; import "acme/valid.proto";',
      ),
    );
    expect(
      EffectArray.map(
        EffectArray.filter(facts.edges, edge => edge.relation === 'imports'),
        edge => edge.targetName,
      ),
    ).toEqual(['../outside.proto', 'acme/valid.proto']);
    expect(
      Option.getOrUndefined(
        Option.map(Option.fromNullishOr(facts.monikers), __effectArrayReceiver =>
          EffectArray.map(__effectArrayReceiver, moniker => moniker.identity),
        ),
      ),
    ).toEqual(['protobuf:file:acme/valid.proto', 'protobuf:file:proto/imports.proto']);
    expect(facts.diagnostics).toContain(
      'proto/imports.proto: one or more protobuf declarations or imports could not form scoped cross-repository monikers',
    );
  });

  it('retains protobuf declarations when a malformed package cannot form strict monikers', () => {
    const facts = protobufFacts(
      file(
        'proto/malformed-package.proto',
        'protobuf',
        'syntax = "proto3"; package foo..bar; message Kept {} service KeptService {}',
      ),
    );
    expect(EffectArray.map(facts.symbols, symbol => symbol.name)).toEqual([
      'proto/malformed-package.proto',
      'Kept',
      'KeptService',
    ]);
    expect(
      Option.getOrUndefined(
        Option.map(Option.fromNullishOr(facts.monikers), __effectArrayReceiver =>
          EffectArray.map(__effectArrayReceiver, moniker => moniker.identity),
        ),
      ),
    ).toEqual(['protobuf:file:proto/malformed-package.proto']);
    expect(facts.diagnostics).toContain(
      'proto/malformed-package.proto: one or more protobuf declarations or imports could not form scoped cross-repository monikers',
    );
  });

  it('does not treat import-shaped protobuf option strings as authoritative imports', () => {
    const facts = protobufFacts(
      file(
        'proto/options.proto',
        'protobuf',
        `syntax = "proto3";
         option java_package = "import 'evil.proto';";
         import "acme/valid.proto";`,
      ),
    );
    expect(
      EffectArray.map(
        EffectArray.filter(facts.edges, edge => edge.relation === 'imports'),
        edge => edge.targetName,
      ),
    ).toEqual(['acme/valid.proto']);
    expect(
      Option.getOrUndefined(
        Option.map(Option.fromNullishOr(facts.monikers), __effectArrayReceiver =>
          EffectArray.map(__effectArrayReceiver, moniker => moniker.identity),
        ),
      ),
    ).toEqual(['protobuf:file:acme/valid.proto', 'protobuf:file:proto/options.proto']);
    expect(
      Option.getOrUndefined(
        Option.map(Option.fromNullishOr(facts.monikers), __effectArrayReceiver =>
          EffectArray.some(
            __effectArrayReceiver,
            __effectArrayValue =>
              !!(moniker => Effect2.pipe(moniker.identity, EffectString.includes('evil.proto')))(__effectArrayValue),
          ),
        ),
      ),
    ).toBe(false);
  });

  it('strictly round-trips monikers and rejects unnormalized or excess-field input', () => {
    const moniker = codeGraphPackageMoniker({
      componentId: `cgp_${Effect2.pipe('1', EffectString.repeat(32))}`,
      dependencyKind: 'runtime',
      evidence: {path: 'packages/app/package.json', span},
      packageName: '@ＡＣＭＥ/ＴＯＯＬＳ',
      packageVersion: '^1.0.0',
      role: 'import',
    });
    expect(moniker.identity).toBe('package:npm:@acme/tools');
    expect(parseCodeGraphMonikerV1(JSON.parse(JSON.stringify(moniker)))).toEqual(moniker);
    expect(() => parseCodeGraphMonikerV1({...moniker, identity: '@acme/tools'})).toThrow(/not canonical/u);
    expect(() => parseCodeGraphMonikerV1({...moniker, packageName: '@ACME/TOOLS'})).toThrow(/not canonical/u);
    expect(() => parseCodeGraphMonikerV1({...moniker, packageVersion: ' ^1.0.0 '})).toThrow(/not canonical/u);
    expect(() =>
      parseCodeGraphMonikerV1({...moniker, evidence: {...moniker.evidence, path: 'packages\\app\\package.json'}}),
    ).toThrow(/not canonical/u);
    expect(
      Option.isNone(
        Schema.decodeUnknownOption(
          CodeGraphMonikerSchemaV1,
          CODE_GRAPH_MONIKER_STRICT_PARSE_OPTIONS,
        )({
          ...moniker,
          sourceBody: 'must never be accepted',
        }),
      ),
    ).toBe(true);
  });

  it('materializes equivalent compact declaration rows for clean and incremental snapshots', async () => {
    const root = await mkdtemp('threadnote-cross-repository-monikers-');
    const incrementalDatabase = join(root, 'incremental.sqlite');
    const cleanDatabase = join(root, 'clean.sqlite');
    const directDatabase = join(root, 'direct.sqlite');
    try {
      const identity = repositoryIdentity(root);
      const firstFile = file(
        'proto/orders.proto',
        'protobuf',
        'syntax = "proto3";\npackage acme.orders;\nimport "acme/common.proto";\nmessage Order {}',
      );
      const finalFile = file(
        'proto/orders.proto',
        'protobuf',
        'syntax = "proto3";\npackage acme.orders;\nimport "acme/shared.proto";\nmessage Order {}',
      );
      const firstFacts = protobufFacts(firstFile);
      const finalFacts = protobufFacts(finalFile);
      const workspace = discoverManifestWorkspace([
        file(
          'package.json',
          'npm-manifest',
          JSON.stringify({dependencies: {zod: '^4.0.0'}, name: '@acme/orders', version: '1.0.0'}),
        ),
      ]);
      const base = snapshot(identity, 'base', firstFacts);
      const overlay = {
        ...snapshot(identity, 'overlay', finalFacts),
        baseSnapshotId: base.id,
        dirty: true,
        overlayFingerprint: 'changed-proto-import',
      } satisfies CodeGraphSnapshot;
      const rebuilt = snapshot(identity, 'rebuilt', finalFacts);
      const direct = snapshot(identity, 'direct', finalFacts);

      await runEffect(
        Effect.gen(function* () {
          const store = yield* CodeGraphStore;
          yield* store.withSession(
            incrementalDatabase,
            Effect.gen(function* () {
              yield* stageClean(store, incrementalDatabase, identity, base, firstFile, firstFacts, workspace);
              expect(
                yield* store.preparePersistedIncrementalActivation(
                  incrementalDatabase,
                  base.id,
                  [finalFile],
                  [finalFacts],
                ),
              ).toBe(true);
              yield* store.activateStaged(incrementalDatabase, identity, overlay);
            }),
          );
          yield* store.withSession(
            cleanDatabase,
            stageClean(store, cleanDatabase, identity, rebuilt, finalFile, finalFacts, workspace),
          );
          yield* store.withSession(
            directDatabase,
            stageDirect(store, directDatabase, identity, direct, finalFile, finalFacts, workspace),
          );
        }),
      );

      const incrementalRows = declarationRows(incrementalDatabase, overlay.id);
      const cleanRows = declarationRows(cleanDatabase, rebuilt.id);
      expect(incrementalRows).toEqual(cleanRows);
      expect(declarationRows(directDatabase, direct.id)).toEqual(cleanRows);
      expect(
        EffectArray.some(incrementalRows.monikers, row => row.identity === 'protobuf:file:acme/common.proto'),
      ).toBe(false);
      expect(
        EffectArray.some(incrementalRows.monikers, row => row.identity === 'protobuf:file:acme/shared.proto'),
      ).toBe(true);
      expect(incrementalRows.externalDependencies).toEqual([
        expect.objectContaining({
          dependency_kind: 'runtime',
          import_alias: 'zod',
          package_name: 'zod',
          version_constraint: '^4.0.0',
        }),
      ]);
      expect(JSON.stringify(incrementalRows)).not.toContain('syntax =');
      expect(tableColumns(cleanDatabase, 'code_graph_monikers')).not.toEqual(
        expect.arrayContaining(['content', 'source_body', 'source_text']),
      );
      expect(tablePrimaryKey(cleanDatabase, 'workspace_external_dependencies')).toEqual([
        'snapshot_id',
        'source_component_id',
        'ecosystem',
        'package_name',
        'import_alias',
        'dependency_kind',
        'version_constraint',
        'evidence_path',
      ]);
    } finally {
      await rm(root, {force: true, recursive: true});
    }
  });

  it('preserves workspace package monikers when an unchanged manifest declaration is incrementally restaged', async () => {
    const root = await mkdtemp('threadnote-cross-repository-manifest-incremental-');
    const persistedDatabase = join(root, 'persisted.sqlite');
    const stagedDatabase = join(root, 'staged.sqlite');
    const cleanDatabase = join(root, 'clean.sqlite');
    try {
      const identity = repositoryIdentity(root);
      const baseContent = JSON.stringify(
        {
          dependencies: {zod: '^4.0.0'},
          name: '@acme/orders',
          version: '1.0.0',
          scripts: {test: 'vitest run'},
        },
        null,
        2,
      );
      const finalContent = Effect2.pipe(baseContent, EffectString.replace('vitest run', 'vitest run --coverage'));
      const baseFile = file('package.json', 'json', baseContent);
      const finalFile = file('package.json', 'json', finalContent);
      const baseFacts = extractStructuredSchemaFacts(baseFile, {packageName: Option.none(), project: Option.none()});
      const finalFacts = extractStructuredSchemaFacts(finalFile, {packageName: Option.none(), project: Option.none()});
      const baseWorkspace = discoverManifestWorkspace([{...baseFile, language: 'npm-manifest'}]);
      const finalWorkspace = discoverManifestWorkspace([{...finalFile, language: 'npm-manifest'}]);
      expect(finalWorkspace.fingerprint).toBe(baseWorkspace.fingerprint);

      const persistedBase = snapshot(identity, 'manifest-persisted-base', baseFacts);
      const persistedOverlay = dirtySnapshot(identity, persistedBase.id, 'manifest-persisted-overlay', finalFacts);
      const stagedBase = snapshot(identity, 'manifest-staged-base', baseFacts);
      const stagedOverlay = dirtySnapshot(identity, stagedBase.id, 'manifest-staged-overlay', finalFacts);
      const rebuilt = snapshot(identity, 'manifest-clean-rebuild', finalFacts);

      await runEffect(
        Effect.gen(function* () {
          const store = yield* CodeGraphStore;
          yield* store.withSession(
            persistedDatabase,
            Effect.gen(function* () {
              yield* stageClean(store, persistedDatabase, identity, persistedBase, baseFile, baseFacts, baseWorkspace);
              expect(
                yield* store.preparePersistedIncrementalActivation(
                  persistedDatabase,
                  persistedBase.id,
                  [finalFile],
                  [finalFacts],
                ),
              ).toBe(true);
              yield* store.activateStaged(persistedDatabase, identity, persistedOverlay);
            }),
          );
          yield* store.withSession(
            stagedDatabase,
            Effect.gen(function* () {
              yield* stageClean(store, stagedDatabase, identity, stagedBase, baseFile, baseFacts, baseWorkspace);
              expect(
                yield* store.replaceStagedModifiedFiles(stagedDatabase, stagedBase.id, [finalFile], [finalFacts]),
              ).toBe(true);
              yield* store.activateStaged(stagedDatabase, identity, stagedOverlay);
            }),
          );
          yield* store.withSession(
            cleanDatabase,
            stageClean(store, cleanDatabase, identity, rebuilt, finalFile, finalFacts, finalWorkspace),
          );
        }),
      );

      const cleanRows = declarationRows(cleanDatabase, rebuilt.id);
      expect(declarationRows(persistedDatabase, persistedOverlay.id)).toEqual(cleanRows);
      expect(declarationRows(stagedDatabase, stagedOverlay.id)).toEqual(cleanRows);
      expect(EffectArray.map(cleanRows.monikers, row => [row.role, row.identity])).toEqual([
        ['export', 'package:npm:@acme/orders'],
        ['import', 'package:npm:zod'],
      ]);
    } finally {
      await rm(root, {force: true, recursive: true});
    }
  });

  it('does not reuse a pre-moniker structured-schema cache entry for protobuf facts', async () => {
    const root = await mkdtemp('threadnote-cross-repository-cache-version-');
    const databasePath = join(root, 'cache.sqlite');
    try {
      const source = file('proto/orders.proto', 'protobuf', 'syntax = "proto3"; package acme.orders; message Order {}');
      const currentFacts = protobufFacts(source);
      const legacyFacts: CodeGraphFileFacts = {
        diagnostics: currentFacts.diagnostics,
        edges: currentFacts.edges,
        path: currentFacts.path,
        symbols: currentFacts.symbols,
      };
      const legacyCacheIdentity = packCacheIdentity({
        ...structuredSchemaLanguagePack,
        extractor: {
          ...structuredSchemaLanguagePack.extractor,
          version: sha256HexSync('threadnote-structured-schema-extractors-v6-apple-resource-values'),
        },
      });
      const currentCacheIdentity = packCacheIdentity(structuredSchemaLanguagePack);
      expect(currentCacheIdentity).not.toBe(legacyCacheIdentity);

      const loaded = await runEffect(
        Effect.gen(function* () {
          const store = yield* CodeGraphStore;
          return yield* store.withSession(
            databasePath,
            Effect.gen(function* () {
              yield* store.initialize(databasePath);
              yield* store.cacheFacts(
                databasePath,
                [source],
                [legacyFacts],
                legacyCacheIdentity,
                unprotectedCacheWrite,
              );
              return yield* store.loadCachedFacts(databasePath, [source], currentCacheIdentity);
            }),
          );
        }),
      );
      expect(loaded.facts.has(source.path)).toBe(false);
    } finally {
      await rm(root, {force: true, recursive: true});
    }
  });

  it.each(['9', '10'] as const)(
    'retires active ready snapshots when revision %s has no cross-repository authority tables',
    async recordedRevision => {
      const root = await mkdtemp(`threadnote-cross-repository-schema-${recordedRevision}-`);
      const databasePath = join(root, 'graph.sqlite');
      try {
        const identity = repositoryIdentity(root);
        const source = file(
          'proto/orders.proto',
          'protobuf',
          'syntax = "proto3"; package acme.orders; message Order {}',
        );
        const facts = protobufFacts(source);
        const workspace = discoverManifestWorkspace([
          file(
            'package.json',
            'npm-manifest',
            JSON.stringify({dependencies: {zod: '^4.0.0'}, name: '@acme/orders', version: '1.0.0'}),
          ),
        ]);
        const ready = snapshot(identity, `ready-before-cross-repository-revision-${recordedRevision}`, facts);
        await runEffect(
          Effect.gen(function* () {
            const store = yield* CodeGraphStore;
            yield* store.withSession(
              databasePath,
              Effect.gen(function* () {
                yield* stageClean(store, databasePath, identity, ready, source, facts, workspace);
                yield* store.promote(databasePath, identity, ready.id);
              }),
            );
          }),
        );

        const drifted = new Database(databasePath, {strict: true});
        try {
          drifted.exec('PRAGMA foreign_keys = OFF');
          drifted.exec('DROP TABLE code_graph_monikers');
          if (recordedRevision === '9') drifted.exec('DROP TABLE workspace_external_dependencies');
          drifted
            .query("UPDATE schema_metadata SET value = ? WHERE key = 'persistent_extension_schema_revision'")
            .run(recordedRevision);
        } finally {
          drifted.close(false);
        }

        await runEffect(
          Effect.gen(function* () {
            const store = yield* CodeGraphStore;
            yield* store.initialize(databasePath);
          }),
        );
        const rebuilt = new Database(databasePath, {readonly: true, strict: true});
        try {
          expect(rebuilt.query('SELECT state FROM snapshots WHERE id = ?').get(ready.id)).toEqual({state: 'retired'});
          expect(rebuilt.query('SELECT COUNT(*) AS count FROM active_snapshots').get()).toEqual({count: 0});
          expect(
            rebuilt
              .query(
                "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name IN ('code_graph_monikers', 'workspace_external_dependencies')",
              )
              .get(),
          ).toEqual({count: 2});
        } finally {
          rebuilt.close(false);
        }
      } finally {
        await rm(root, {force: true, recursive: true});
      }
    },
  );

  fcProp(
    effectIt,
    'canonicalization is deterministic, ordered, deduplicating, and JSON round-trippable',
    {
      values: FC.array(
        FC.record({
          name: FC.constantFrom('alpha', 'Beta', '@acme/core', '@ACME/UI'),
          role: FC.constantFrom<'import' | 'export'>('import', 'export'),
          seed: FC.integer({max: 30, min: 1}),
        }),
        {maxLength: 30},
      ),
    },
    ({values}) => {
      const monikers = EffectArray.map(values, ({name, role, seed}) =>
        role === 'import'
          ? codeGraphPackageMoniker({
              componentId: `cgp_${Effect2.pipe(seed.toString(16), EffectString.padStart(32, '0'))}`,
              dependencyKind: 'runtime',
              evidence: {path: `packages/p${seed}/package.json`, span},
              packageName: name,
              packageVersion: `^${seed}.0.0`,
              role,
            })
          : codeGraphPackageMoniker({
              componentId: `cgp_${Effect2.pipe(seed.toString(16), EffectString.padStart(32, '0'))}`,
              evidence: {path: `packages/p${seed}/package.json`, span},
              packageName: name,
              packageVersion: `${seed}.0.0`,
              role,
            }),
      );
      const canonical = canonicalCodeGraphMonikers(monikers);
      expect(canonicalCodeGraphMonikers([...monikers].reverse())).toEqual(canonical);
      expect(canonicalCodeGraphMonikers([...canonical, ...canonical])).toEqual(canonical);
      expect(EffectArray.map(canonical, moniker => moniker.id)).toEqual(
        [...EffectArray.map(canonical, moniker => moniker.id)].sort((a, b) => {
          const left = Option.getOrUndefined(EffectArray.findFirst(canonical, moniker => moniker.id === a))!;
          const right = Option.getOrUndefined(EffectArray.findFirst(canonical, moniker => moniker.id === b))!;
          return (
            Effect2.pipe(left.identity, EffectString.localeCompare(right.identity)) ||
            Effect2.pipe(left.role, EffectString.localeCompare(right.role)) ||
            Effect2.pipe(a, EffectString.localeCompare(b))
          );
        }),
      );
      expect(JSON.parse(JSON.stringify(canonical)).map(parseCodeGraphMonikerV1)).toEqual(canonical);
    },
    {fastCheck: {numRuns: 100}},
  );

  fcProp(
    effectIt,
    'conflicting package constraints remain permutation-invariant occurrences',
    {
      versions: FC.uniqueArray(FC.integer({max: 100, min: 1}), {maxLength: 20, minLength: 2}),
    },
    ({versions}) => {
      const monikers = EffectArray.map(versions, version =>
        codeGraphPackageMoniker({
          componentId: `cgp_${Effect2.pipe('1', EffectString.repeat(32))}`,
          dependencyKind: 'runtime',
          evidence: {path: 'package.json', span},
          packageName: '@acme/tools',
          packageVersion: `^${version}.0.0`,
          role: 'import',
        }),
      );
      const canonical = canonicalCodeGraphMonikers(monikers);
      expect(canonicalCodeGraphMonikers([...monikers].reverse())).toEqual(canonical);
      expect(new Set(EffectArray.map(canonical, moniker => moniker.id)).size).toBe(versions.length);
      expect(canonical).toHaveLength(versions.length);
    },
    {fastCheck: {numRuns: 50}},
  );

  it('never aliases equal bare protobuf names across packages or declaration kinds', () => {
    const evidence = {path: 'api.proto', span};
    const symbolId = `cgs_${Effect2.pipe('1', EffectString.repeat(32))}`;
    const identities = [
      codeGraphProtobufMoniker({evidence, kind: 'message', qualifiedName: 'one.api.Item', role: 'export', symbolId})
        .identity,
      codeGraphProtobufMoniker({evidence, kind: 'message', qualifiedName: 'two.api.Item', role: 'export', symbolId})
        .identity,
      codeGraphProtobufMoniker({evidence, kind: 'service', qualifiedName: 'one.api.Item', role: 'export', symbolId})
        .identity,
    ];
    expect(new Set(identities).size).toBe(identities.length);
    expect(identities).not.toContain('Item');
  });
});

function protobufFacts(source: CodeGraphInventoryFile): CodeGraphFileFacts {
  return extractStructuredSchemaFacts(source, {packageName: Option.none(), project: Option.none()});
}

function file(path: string, language: string, content: string): CodeGraphInventoryFile {
  return {
    blobId: Effect2.pipe(Bun.hash(content).toString(16), EffectString.padStart(40, '0'), EffectString.slice(0, 40)),
    content,
    contentHash: Effect2.pipe(
      Bun.hash(`${path}\0${content}`).toString(16),
      EffectString.padStart(64, '0'),
      EffectString.slice(0, 64),
    ),
    language,
    mode: '100644',
    path,
    size: Buffer.byteLength(content),
    source: 'commit',
  };
}

function repositoryIdentity(root: string): RepositoryIdentity {
  return {
    caseMode: 'sensitive',
    checkoutId: Effect2.pipe('c', EffectString.repeat(64)),
    displayName: 'cross-repository-monikers',
    gitCommonDirectory: root,
    headCommit: Effect2.pipe('1', EffectString.repeat(40)),
    objectFormat: 'sha1',
    repoRoot: root,
    repositoryId: Effect2.pipe('a', EffectString.repeat(64)),
    worktreeId: Effect2.pipe('b', EffectString.repeat(64)),
  };
}

function snapshot(identity: RepositoryIdentity, id: string, facts: CodeGraphFileFacts): CodeGraphSnapshot {
  return {
    commit: identity.headCommit,
    dirty: false,
    edgeCount: facts.edges.length,
    extractorSet: 'cross-repository-monikers-v1',
    fileCount: 1,
    id,
    repositoryId: identity.repositoryId,
    state: 'ready',
    symbolCount: facts.symbols.length,
    worktreeId: identity.worktreeId,
  };
}

function dirtySnapshot(
  identity: RepositoryIdentity,
  baseSnapshotId: string,
  id: string,
  facts: CodeGraphFileFacts,
): CodeGraphSnapshot {
  return {
    ...snapshot(identity, id, facts),
    baseSnapshotId,
    dirty: true,
    overlayFingerprint: `${id}-overlay`,
  };
}

function stageClean(
  store: CodeGraphStoreShape,
  databasePath: string,
  identity: RepositoryIdentity,
  target: CodeGraphSnapshot,
  source: CodeGraphInventoryFile,
  facts: CodeGraphFileFacts,
  workspace: ReturnType<typeof discoverManifestWorkspace>,
) {
  return Effect.gen(function* () {
    yield* store.prepareActivation(databasePath, [source]);
    yield* store.stageWorkspaceCatalog(databasePath, workspace);
    yield* store.stageActivationFacts(
      databasePath,
      facts.symbols,
      facts.edges,
      facts.references ?? [],
      undefined,
      undefined,
      undefined,
      facts.monikers ?? [],
    );
    yield* store.activateStaged(databasePath, identity, target, {
      fileSetFingerprint: `files-${target.id}`,
      packProvenance: [],
      workspaceFingerprint: workspace.fingerprint,
    });
  });
}

function stageDirect(
  store: CodeGraphStoreShape,
  databasePath: string,
  identity: RepositoryIdentity,
  target: CodeGraphSnapshot,
  source: CodeGraphInventoryFile,
  facts: CodeGraphFileFacts,
  workspace: ReturnType<typeof discoverManifestWorkspace>,
) {
  return Effect.gen(function* () {
    const owner = yield* claimPersistentBuildForTest(store, databasePath, identity, {...target, state: 'building'});
    yield* store.prepareActivation(databasePath, [source], target.id, 1, owner);
    yield* store.stageWorkspaceCatalog(databasePath, workspace);
    yield* store.stageWorkspaceCatalog(databasePath, workspace);
    yield* store.stageActivationFactBatches(databasePath, [
      {
        batchIndex: 0,
        edges: facts.edges,
        finalFactBytes: Buffer.byteLength(JSON.stringify(facts)),
        monikers: facts.monikers ?? [],
        references: facts.references ?? [],
        symbols: facts.symbols,
      },
    ]);
    yield* store.finalizePersistentMaterializationPlan(databasePath, 1);
    yield* store.resolveStagedReferences(databasePath);
    yield* store.activateStaged(databasePath, identity, target);
  });
}

function declarationRows(databasePath: string, snapshotId: string) {
  const database = new Database(databasePath, {readonly: true, strict: true});
  try {
    const monikers = database
      .query<
        {readonly evidence_path: string; readonly identity: string; readonly kind: string; readonly role: string},
        [string]
      >(
        `SELECT identity, role, kind, evidence_path
         FROM code_graph_monikers WHERE snapshot_id = ? ORDER BY identity, role, id`,
      )
      .all(snapshotId);
    const externalDependencies = database
      .query<
        {
          readonly dependency_kind: string;
          readonly import_alias: string;
          readonly package_name: string;
          readonly version_constraint: string;
        },
        [string]
      >(
        `SELECT package_name, import_alias, dependency_kind, version_constraint
         FROM workspace_external_dependencies WHERE snapshot_id = ?
         ORDER BY package_name, dependency_kind`,
      )
      .all(snapshotId);
    return {externalDependencies, monikers};
  } finally {
    database.close(false);
  }
}

function tablePrimaryKey(databasePath: string, table: string): readonly string[] {
  const database = new Database(databasePath, {readonly: true, strict: true});
  try {
    return EffectArray.map(
      EffectArray.filter(
        database.query<{readonly name: string; readonly pk: number}, []>(`PRAGMA table_info(${table})`).all(),
        column => column.pk > 0,
      ).sort((left, right) => left.pk - right.pk),
      column => column.name,
    );
  } finally {
    database.close(false);
  }
}

function tableColumns(databasePath: string, table: string): readonly string[] {
  const database = new Database(databasePath, {readonly: true, strict: true});
  try {
    return EffectArray.map(
      database.query<{readonly name: string}, []>(`PRAGMA table_info(${table})`).all(),
      row => row.name,
    );
  } finally {
    database.close(false);
  }
}
