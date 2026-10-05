import {provideTestLayer} from '../helpers/effect-layer.js';
import {execFileSync} from '@threadnote/testing/node-child-process';
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from '@threadnote/testing/node-fs';
import {tmpdir} from '@threadnote/testing/node-os';
import {join} from '@threadnote/testing/node-path';
import {it as effectIt} from '@effect/vitest';
import {Effect, Path} from 'effect';
import {TestClock} from 'effect/testing';
import * as SqlClient from 'effect/sql/SqlClient';
import {describe, expect} from 'vitest';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import {codeGraphCheckpointAbiInputV1} from '@threadnote/graph/checkpoint/compatibility';
import {
  CodeGraphCheckpointProjectionError,
  projectCodeGraphCheckpointV1,
} from '@threadnote/graph/checkpoint/projection';
import {
  compareCodeGraphCheckpointRecords,
  type CodeGraphCheckpointMetadataV1,
  type CodeGraphCheckpointRecordV1,
} from '@threadnote/graph/checkpoint/schema';
import {CodeGraphIndexer} from '@threadnote/graph/indexer';
import {codeGraphLayout} from '@threadnote/graph/layout';
import {CodeGraphStore} from '@threadnote/graph/store';

interface ProjectionCapture {
  readonly metadata: CodeGraphCheckpointMetadataV1;
  readonly records: readonly CodeGraphCheckpointRecordV1[];
}

describe('code graph checkpoint projection', () => {
  effectIt.effect(
    'rejects a clean scoped snapshot before emitting checkpoint metadata or records',
    () =>
      Effect.acquireUseRelease(
        Effect.sync(() => createRepository()),
        fixture =>
          Effect.gen(function* () {
            const indexer = yield* CodeGraphIndexer;
            const path = yield* Path.Path;
            const indexed = yield* indexer.index({
              cwd: fixture.repository,
              threadnoteHome: fixture.home,
              ensureVectors: false,
              project: {
                uri: 'threadnote://resources/repos/checkpoint-scoped',
                graph: {roots: ['src'], closure: 'dependencies'},
              },
            });
            const layout = codeGraphLayout(
              path,
              fixture.home,
              indexed.identity.checkoutId,
              indexed.identity.worktreeId,
              indexed.snapshot.scopeId,
            );
            let writes = 0;
            const error = yield* projectCodeGraphCheckpointV1({
              abi: codeGraphCheckpointAbiInputV1([]),
              databasePath: layout.databasePath,
              identity: indexed.identity,
              snapshotId: indexed.snapshot.id,
              writeMetadata: () =>
                Effect.sync(() => {
                  writes += 1;
                }),
              writeRecords: () =>
                Effect.sync(() => {
                  writes += 1;
                }),
            }).pipe(Effect.flip);
            expect(String(error)).toContain('only the full repository graph');
            expect(writes).toBe(0);
          }),
        fixture => Effect.sync(() => rmSync(fixture.root, {force: true, recursive: true})),
      ).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
    60_000,
  );
  effectIt.effect(
    'projects one clean ready snapshot deterministically across page boundaries',
    () => {
      let fixtureRoot: string | undefined;
      return Effect.gen(function* () {
        const fixture = createRepository();
        fixtureRoot = fixture.root;
        const indexer = yield* CodeGraphIndexer;
        const path = yield* Path.Path;
        const store = yield* CodeGraphStore;
        const indexed = yield* indexer.index({cwd: fixture.repository, threadnoteHome: fixture.home});
        const databasePath = codeGraphLayout(
          path,
          fixture.home,
          indexed.identity.checkoutId,
          indexed.identity.worktreeId,
        ).databasePath;
        const provenance = yield* store.snapshotPackProvenance(databasePath, indexed.snapshot.id);
        expect(provenance).toBeDefined();
        const abi = codeGraphCheckpointAbiInputV1(provenance!);

        const capture = (pageSize: number) => {
          let metadata: CodeGraphCheckpointMetadataV1 | undefined;
          const records: CodeGraphCheckpointRecordV1[] = [];
          return projectCodeGraphCheckpointV1({
            abi,
            databasePath,
            identity: indexed.identity,
            pageSize,
            snapshotId: indexed.snapshot.id,
            writeMetadata: value => Effect.sync(() => (metadata = value)),
            writeRecords: page => Effect.sync(() => records.push(...page)),
          }).pipe(
            Effect.map(summary => {
              expect(metadata).toBeDefined();
              expect(summary.counts.file).toBe(indexed.snapshot.fileCount);
              expect(summary.counts['file-fact']).toBe(summary.counts.file);
              return {metadata: metadata!, records} satisfies ProjectionCapture;
            }),
          );
        };

        const oneRowPages = yield* capture(1);
        const maximumPages = yield* capture(1_000);
        expect(oneRowPages).toEqual(maximumPages);
        for (let index = 1; index < oneRowPages.records.length; index += 1) {
          expect(
            compareCodeGraphCheckpointRecords(oneRowPages.records[index - 1], oneRowPages.records[index]),
          ).toBeLessThan(0);
        }
        expect(oneRowPages.metadata.reuse?.inventory).toBeDefined();
        expect(oneRowPages.metadata.reuse?.inventory).not.toHaveProperty('environmentFingerprint');
        for (const file of oneRowPages.metadata.reuse?.inventory?.attributionFiles ?? []) {
          expect(file).not.toHaveProperty('content');
          expect(file.blobSize).toBeGreaterThanOrEqual(file.size);
        }

        writeFileSync(join(fixture.repository, 'src', 'math.ts'), 'export const double = () => 99;\n');
        const dirtyError = yield* projectCodeGraphCheckpointV1({
          abi,
          databasePath,
          identity: indexed.identity,
          snapshotId: indexed.snapshot.id,
          writeMetadata: () => Effect.void,
          writeRecords: () => Effect.void,
        }).pipe(Effect.flip);
        expect(dirtyError).toBeInstanceOf(CodeGraphCheckpointProjectionError);
        expect(String(dirtyError)).toContain('not clean before checkpoint projection');
      }).pipe(
        Effect.ensuring(
          Effect.sync(() =>
            fixtureRoot === undefined ? undefined : rmSync(fixtureRoot, {force: true, recursive: true}),
          ),
        ),
        provideTestLayer(ApplicationLayer),
        TestClock.withLive,
      );
    },
    60_000,
  );

  effectIt.effect(
    'omits planted dangling monikers whose evidence file is not in the snapshot',
    () => {
      let fixtureRoot: string | undefined;
      return Effect.gen(function* () {
        const fixture = createRepository();
        fixtureRoot = fixture.root;
        const indexer = yield* CodeGraphIndexer;
        const path = yield* Path.Path;
        const store = yield* CodeGraphStore;
        const indexed = yield* indexer.index({cwd: fixture.repository, threadnoteHome: fixture.home});
        const databasePath = codeGraphLayout(
          path,
          fixture.home,
          indexed.identity.checkoutId,
          indexed.identity.worktreeId,
        ).databasePath;
        const provenance = yield* store.snapshotPackProvenance(databasePath, indexed.snapshot.id);
        expect(provenance).toBeDefined();
        if (provenance === undefined) return;
        yield* store.withSession(
          databasePath,
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            const components = yield* sql<{readonly id: string}>`
              SELECT id FROM workspace_components WHERE snapshot_id = ${indexed.snapshot.id} LIMIT 1
            `;
            const component = components[0];
            expect(component).toBeDefined();
            if (component === undefined) return;
            yield* sql`
              INSERT INTO code_graph_monikers (
                snapshot_id, id, version, scheme, role, kind, resolution_domain, identity,
                package_name, component_id, evidence_path, evidence_span_json
              ) VALUES (
                ${indexed.snapshot.id},
                ${`cgm_${'d'.repeat(64)}`},
                ${1},
                ${'package'},
                ${'export'},
                ${'package'},
                ${'package:npm'},
                ${'package:npm:scratchpad'},
                ${'scratchpad'},
                ${component.id},
                ${'scratchpad/package.json'},
                ${'{"column":1,"endColumn":1,"endLine":1,"line":1}'}
              )
            `;
          }),
        );
        const records: CodeGraphCheckpointRecordV1[] = [];
        yield* projectCodeGraphCheckpointV1({
          abi: codeGraphCheckpointAbiInputV1(provenance),
          databasePath,
          identity: indexed.identity,
          snapshotId: indexed.snapshot.id,
          writeMetadata: () => Effect.void,
          writeRecords: page => Effect.sync(() => records.push(...page)),
        });
        expect(
          records.filter(record => record.kind === 'moniker' && record.evidencePath === 'scratchpad/package.json'),
        ).toEqual([]);
      }).pipe(
        Effect.ensuring(
          Effect.sync(() =>
            fixtureRoot === undefined ? undefined : rmSync(fixtureRoot, {force: true, recursive: true}),
          ),
        ),
        provideTestLayer(ApplicationLayer),
        TestClock.withLive,
      );
    },
    60_000,
  );

  effectIt.effect(
    'does not index ignored package-export monikers that declared workspace discovery would otherwise keep',
    () => {
      let fixtureRoot: string | undefined;
      return Effect.gen(function* () {
        const fixture = createRepository({ignoreScratchpad: true});
        fixtureRoot = fixture.root;
        const indexer = yield* CodeGraphIndexer;
        const path = yield* Path.Path;
        const store = yield* CodeGraphStore;
        const indexed = yield* indexer.index({cwd: fixture.repository, threadnoteHome: fixture.home});
        const databasePath = codeGraphLayout(
          path,
          fixture.home,
          indexed.identity.checkoutId,
          indexed.identity.worktreeId,
        ).databasePath;
        const dangling = yield* store.withSession(
          databasePath,
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            const rows = yield* sql<{readonly count: number}>`
              SELECT COUNT(*) AS count
              FROM code_graph_monikers AS moniker
              LEFT JOIN snapshot_files AS evidence
                ON evidence.snapshot_id = moniker.snapshot_id AND evidence.path = moniker.evidence_path
              WHERE moniker.snapshot_id = ${indexed.snapshot.id} AND evidence.path IS NULL
            `;
            return Number(rows[0]?.count ?? -1);
          }),
        );
        expect(dangling).toBe(0);
        const provenance = yield* store.snapshotPackProvenance(databasePath, indexed.snapshot.id);
        expect(provenance).toBeDefined();
        if (provenance === undefined) return;
        const records: CodeGraphCheckpointRecordV1[] = [];
        yield* projectCodeGraphCheckpointV1({
          abi: codeGraphCheckpointAbiInputV1(provenance),
          databasePath,
          identity: indexed.identity,
          snapshotId: indexed.snapshot.id,
          writeMetadata: () => Effect.void,
          writeRecords: page => Effect.sync(() => records.push(...page)),
        });
        expect(
          records.some(
            record =>
              'evidencePath' in record &&
              typeof record.evidencePath === 'string' &&
              record.evidencePath.startsWith('scratchpad/'),
          ),
        ).toBe(false);
      }).pipe(
        Effect.ensuring(
          Effect.sync(() =>
            fixtureRoot === undefined ? undefined : rmSync(fixtureRoot, {force: true, recursive: true}),
          ),
        ),
        provideTestLayer(ApplicationLayer),
        TestClock.withLive,
      );
    },
    60_000,
  );
});

function createRepository(options: {readonly ignoreScratchpad?: boolean} = {}): {
  readonly home: string;
  readonly repository: string;
  readonly root: string;
} {
  const root = mkdtempSync(join(tmpdir(), 'threadnote-checkpoint-projection-'));
  const repository = join(root, 'repository');
  const home = join(root, 'threadnote-home');
  mkdirSync(join(repository, 'src'), {recursive: true});
  mkdirSync(home, {recursive: true});
  if (options.ignoreScratchpad === true) {
    mkdirSync(join(repository, 'scratchpad'), {recursive: true});
    writeFileSync(join(repository, '.threadnoteignore'), 'scratchpad/package.json\n');
    writeFileSync(
      join(repository, 'scratchpad', 'package.json'),
      `${JSON.stringify({name: 'scratchpad', private: true}, null, 2)}\n`,
    );
  }
  writeFileSync(
    join(repository, 'package.json'),
    `${JSON.stringify(
      {
        dependencies: {'left-pad': '^1.3.0'},
        name: '@acme/checkpoint-projection',
        private: true,
        type: 'module',
        version: '1.0.0',
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(
    join(repository, 'tsconfig.json'),
    `${JSON.stringify({compilerOptions: {module: 'NodeNext', target: 'ES2022'}, include: ['src']}, null, 2)}\n`,
  );
  writeFileSync(join(repository, 'src', 'math.ts'), 'export const double = (value: number): number => value * 2;\n');
  writeFileSync(join(repository, 'src', 'index.ts'), 'export {double} from "./math.js";\n');
  git(repository, ['init', '-q']);
  git(repository, ['remote', 'add', 'origin', 'https://github.com/acme/checkpoint-projection.git']);
  git(repository, ['add', '.']);
  git(repository, [
    '-c',
    'user.name=Threadnote Test',
    '-c',
    'user.email=test@threadnote.local',
    'commit',
    '-qm',
    'checkpoint projection fixture',
  ]);
  return {home, repository, root};
}

function git(cwd: string, args: readonly string[]): void {
  execFileSync('git', ['-C', cwd, ...args], {stdio: 'pipe'});
}
