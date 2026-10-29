import {Array as EffectArray, Option as EffectOption} from 'effect';
import {TestError} from '@threadnote/testing/test-error';
import {createHash} from '@threadnote/testing/node-crypto';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rm,
  symlink,
  writeFile,
} from '@threadnote/testing/node-fs-promises';
import {tmpdir} from '@threadnote/testing/node-os';
import {dirname, join, resolve} from '@threadnote/testing/node-path';
import {Database} from 'bun:sqlite';
import {Effect} from 'effect';
import {afterEach, describe, expect, it} from 'vitest';
import {codeGraphDoctorCheck} from '@threadnote/graph/maintenance';
import {CodeGraphStore} from '@threadnote/graph/store';
import {CODE_GRAPH_SCHEMA_VERSION} from '@threadnote/graph/types';
import {captureConsole} from '@threadnote/threadnote/effect/console';
import {LocalModelRuntime} from '@threadnote/inference/engine/local-model-runtime';
import {SystemInfo} from '@threadnote/platform/system';
import {runDoctor, runRepair} from '@threadnote/threadnote/lifecycle';
import {BUILTIN_MODEL_MANIFESTS, CORE_EMBEDDING_MODEL_ID} from '@threadnote/inference/models/builtin';
import {LocalModelCatalog, type LocalModelManifest} from '@threadnote/inference/models/catalog';
import {LocalModelStore, type LocalModelStoreShape} from '@threadnote/inference/models/store';
import {loadRecallIndexData, recallIndexDatabaseFilename} from '@threadnote/recall/index';
import {THREADNOTE_STORAGE_LAYOUT_VERSION} from '@threadnote/store/layout';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {assertSafeThreadnoteHomeForErase} from '@threadnote/threadnote/utils';
import {runEffect} from '../helpers/effect-runtime.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

const temporaryRoots: string[] = [];
const embeddingManifest = EffectOption.getOrUndefined(
  EffectArray.findFirst(BUILTIN_MODEL_MANIFESTS, model => model.id === CORE_EMBEDDING_MODEL_ID),
)!;

afterEach(async () => {
  await Promise.all(EffectArray.map(temporaryRoots.splice(0), root => rm(root, {force: true, recursive: true})));
});

describe('destructive Threadnote home validation', () => {
  it('rejects an arbitrary directory without an ownership receipt', async () => {
    const root = await temporaryRoot('threadnote-erase-arbitrary-');
    await writeFile(join(root, 'user-file.txt'), 'must survive\n');

    await expect(runEffect(assertSafeThreadnoteHomeForErase(root))).rejects.toThrow(
      /Refusing to erase unowned THREADNOTE_HOME/,
    );
    await expect(readFile(join(root, 'user-file.txt'), 'utf8')).resolves.toBe('must survive\n');
  });

  it('accepts only a current Threadnote-owned layout receipt', async () => {
    const root = await temporaryRoot('threadnote-erase-owned-');
    await writeLayoutReceipt(root);

    await expect(runEffect(assertSafeThreadnoteHomeForErase(root))).resolves.toBe(resolve(root));

    await writeFile(
      join(root, 'layout.json'),
      `${JSON.stringify({createdBy: 'another-tool', version: THREADNOTE_STORAGE_LAYOUT_VERSION})}\n`,
    );
    await expect(runEffect(assertSafeThreadnoteHomeForErase(root))).rejects.toThrow(
      /invalid or unsupported layout receipt/,
    );
  });

  it.skipIf(process.platform === 'win32')('rejects a symbolic-link home even when its target is owned', async () => {
    const root = await temporaryRoot('threadnote-erase-symlink-');
    const target = join(root, 'owned');
    const link = join(root, 'linked-home');
    await mkdir(target);
    await writeLayoutReceipt(target);
    await symlink(target, link, 'dir');

    await expect(runEffect(assertSafeThreadnoteHomeForErase(link))).rejects.toThrow(
      /Refusing to erase symbolic-link THREADNOTE_HOME/,
    );
  });
});

describe('read-only doctor', () => {
  it('does not create an index, lock, SQLite sidecar, or any other home entry', async () => {
    const root = await temporaryRoot('threadnote-doctor-read-only-empty-');
    const config = runtimeConfig(root);
    await writeLayoutReceipt(root);
    const before = await filesystemSnapshot(root);

    const report = await runDoctor(config, {dryRun: true}).pipe(captureConsole, runEffect);

    expect(report.output).toContain('FAIL lexical recall index: not built');
    expect(await filesystemSnapshot(root)).toEqual(before);
  });

  it('inspects an existing lexical SQLite index without changing logical content or unrelated home artifacts', async () => {
    const root = await temporaryRoot('threadnote-doctor-read-only-indexed-');
    const config = runtimeConfig(root);
    await writeLayoutReceipt(root);
    await runEffect(loadRecallIndexData(config, {includeInactive: false}));
    const databaseName = recallIndexDatabaseFilename(false);
    const databasePath = join(root, 'indexes', 'lexical', databaseName);
    const sqliteArtifacts = new Set([
      `indexes/lexical/${databaseName}`,
      `indexes/lexical/${databaseName}-shm`,
      `indexes/lexical/${databaseName}-wal`,
    ]);
    const logicalBefore = recallDatabaseLogicalSnapshot(databasePath);
    const before = await filesystemSnapshot(root, sqliteArtifacts);

    const report = await runDoctor(config, {dryRun: true}).pipe(captureConsole, runEffect);

    expect(report.output).toContain('lexical recall index: 0 canonical document(s)');
    expect(recallDatabaseLogicalSnapshot(databasePath)).toEqual(logicalBefore);
    expect(await filesystemSnapshot(root, sqliteArtifacts)).toEqual(before);
  });

  it('verifies an installed embedding model without creating a model lock', async () => {
    const root = await temporaryRoot('threadnote-doctor-read-only-model-');
    const config = runtimeConfig(root);
    const modelContent = Buffer.from('small immutable model fixture\n');
    const manifest = fixtureEmbeddingManifest(modelContent);
    const modelPath = join(root, 'models', 'embedding', manifest.id, manifest.file);
    await writeLayoutReceipt(root);
    await mkdir(dirname(modelPath), {recursive: true});
    await writeFile(modelPath, modelContent);
    await writeFile(
      join(root, 'models', 'selection.json'),
      `${JSON.stringify({roles: {embedding: manifest.id}, version: 1})}\n`,
    );
    const installation = {
      bytes: manifest.size,
      installed: true,
      modelId: manifest.id,
      partialBytes: 0,
      path: modelPath,
      verified: false,
    };
    const modelStore = LocalModelStore.of({
      install: () => Effect.die(TestError.make({message: 'Doctor must not install models.'})),
      path: () => modelPath,
      remove: () => Effect.die(TestError.make({message: 'Doctor must not remove models.'})),
      status: () => Effect.succeed(installation),
      verify: () =>
        Effect.die(TestError.make({message: 'Doctor must not acquire the mutating model verification lock.'})),
    } satisfies LocalModelStoreShape);
    const catalog = LocalModelCatalog.of({
      get: modelId =>
        modelId === manifest.id
          ? Effect.succeed(manifest)
          : Effect.die(TestError.make({message: `Unexpected model ${modelId}`})),
      list: () => Effect.succeed([manifest]),
      selected: () => Effect.succeed(manifest),
    });
    const before = await filesystemSnapshot(root);

    const report = await runEffect(
      captureConsole(runDoctor(config, {dryRun: true})).pipe(
        Effect.provideService(LocalModelCatalog, catalog),
        Effect.provideService(LocalModelStore, modelStore),
      ),
    );

    expect(report.output).toContain(`embedding model: ${manifest.id}; 2 dimensions; verified`);
    expect(await filesystemSnapshot(root)).toEqual(before);
  });

  it('diagnoses a fully initialized native code graph database without logical writes', async () => {
    const root = await temporaryRoot('threadnote-doctor-read-only-graph-');
    const databasePath = join(
      root,
      'indexes',
      'code-graph',
      'repositories',
      Effect2.pipe('a', EffectString.repeat(64)),
      `graph-v${CODE_GRAPH_SCHEMA_VERSION}.sqlite`,
    );
    await mkdir(dirname(databasePath), {recursive: true});
    await runEffect(
      Effect.gen(function* () {
        const store = yield* CodeGraphStore;
        yield* store.initialize(databasePath);
      }),
    );
    const before = graphSchemaMetadata(databasePath);

    const check = await runEffect(codeGraphDoctorCheck(root));

    expect(check.status).toBe('ok');
    expect(graphSchemaMetadata(databasePath)).toEqual(before);
  });
});

describe('repair failure propagation', () => {
  it('fails repair when the core recall index cannot be rebuilt', async () => {
    const root = await temporaryRoot('threadnote-repair-recall-failure-');
    const home = join(root, 'home');
    const userHome = join(root, 'user');
    const config = runtimeConfig(home);
    await mkdir(join(home, 'indexes'), {recursive: true});
    await writeFile(join(home, 'indexes', 'lexical'), 'blocks the lexical index directory\n');

    const modelPath = join(home, 'models', 'embedding', embeddingManifest.id, 'fixture.gguf');
    const installation = {
      bytes: embeddingManifest.size,
      installed: true,
      modelId: embeddingManifest.id,
      partialBytes: 0,
      path: modelPath,
      verified: true,
    };
    const modelStore = LocalModelStore.of({
      install: () => Effect.succeed({...installation, resumed: false, sourceUrl: 'fixture://embedding'}),
      path: () => modelPath,
      remove: () => Effect.succeed(false),
      status: () => Effect.succeed(installation),
      verify: () => Effect.succeed(installation),
    } satisfies LocalModelStoreShape);
    const modelRuntime = LocalModelRuntime.of({
      diagnostics: Effect.succeed({backend: 'fake', buildType: 'prebuilt', cpuMathCores: 4}),
      embedMany: () =>
        Effect.die(TestError.make({message: 'Embedding must not start when lexical index setup fails.'})),
      generate: () => Effect.die(TestError.make({message: 'Unexpected generation.'})),
      rerank: () => Effect.die(TestError.make({message: 'Unexpected reranking.'})),
    });

    await expect(
      runEffect(
        Effect.gen(function* () {
          const system = yield* SystemInfo;
          const testSystem = SystemInfo.of({
            ...system,
            environment: () => ({
              ...system.environment(),
              HOME: userHome,
              NVM_DIR: undefined,
              NVM_HOME: undefined,
              THREADNOTE_BIN_DIR: join(root, 'bin'),
              THREADNOTE_INSTALL_ROOT: join(root, 'install'),
            }),
            homeDirectory: userHome,
          });
          yield* runRepair(config, {mcp: 'none', postUpdate: false}).pipe(
            Effect.provideService(LocalModelRuntime, modelRuntime),
            Effect.provideService(LocalModelStore, modelStore),
            Effect.provideService(SystemInfo, testSystem),
          );
        }),
      ),
    ).rejects.toThrow(/Recall index repair failed/);
  });

  it('fails repair when native code graph maintenance cannot inspect its derived root', async () => {
    const root = await temporaryRoot('threadnote-repair-graph-failure-');
    const home = join(root, 'home');
    const repositories = join(home, 'indexes', 'code-graph', 'repositories');
    await mkdir(dirname(repositories), {recursive: true});
    await writeFile(repositories, 'not a directory\n');

    await expect(
      runEffect(runRepair(runtimeConfig(home), {dryRun: true, mcp: 'none', postUpdate: false})),
    ).rejects.toThrow(/Native code graph repair failed/);
  });
});

async function temporaryRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  temporaryRoots.push(root);
  return root;
}

function runtimeConfig(home: string): RuntimeConfig {
  return {
    account: 'local',
    agentContextHome: home,
    agentId: 'threadnote',
    manifestPath: join(home, 'seed-manifest.yaml'),
    user: 'test-user',
  };
}

async function writeLayoutReceipt(home: string): Promise<void> {
  await mkdir(home, {recursive: true});
  await writeFile(
    join(home, 'layout.json'),
    `${JSON.stringify({createdBy: 'threadnote', version: THREADNOTE_STORAGE_LAYOUT_VERSION})}\n`,
  );
}

async function filesystemSnapshot(
  root: string,
  ignoredRelativePaths: ReadonlySet<string> = new Set(),
): Promise<readonly string[]> {
  const output: string[] = [];
  const visit = async (current: string, relative: string): Promise<void> => {
    if (ignoredRelativePaths.has(Effect2.pipe(relative, EffectString.replaceAll('\\', '/')))) return;
    const info = await lstat(current);
    const mode = (info.mode & 0o777).toString(8);
    if (info.isSymbolicLink()) {
      output.push(`${relative}\tsymlink\t${mode}\t${await readlink(current)}`);
      return;
    }
    if (info.isDirectory()) {
      output.push(`${relative}\tdirectory\t${mode}`);
      const entries = (await readdir(current)).sort();
      for (const entry of entries) await visit(join(current, entry), relative === '.' ? entry : join(relative, entry));
      return;
    }
    const content = await readFile(current);
    output.push(
      `${relative}\tfile\t${mode}\t${content.byteLength}\t${createHash('sha256').update(content).digest('hex')}`,
    );
  };
  await visit(root, '.');
  return output;
}

function recallDatabaseLogicalSnapshot(databasePath: string): unknown {
  const database = new Database(databasePath, {readonly: true});
  try {
    return {
      documents: database.query('SELECT * FROM documents ORDER BY id').all(),
      metadata: database.query('SELECT key, value FROM metadata ORDER BY key').all(),
      postings: database.query('SELECT * FROM postings ORDER BY term, document_id').all(),
      schema: database
        .query(
          `SELECT type, name, tbl_name, sql
           FROM sqlite_schema
           WHERE name NOT LIKE 'sqlite_%'
           ORDER BY type, name`,
        )
        .all(),
      termStatistics: database.query('SELECT * FROM term_statistics ORDER BY term').all(),
    };
  } finally {
    database.close();
  }
}

function graphSchemaMetadata(databasePath: string): unknown {
  const database = new Database(databasePath, {readonly: true});
  try {
    return {
      metadata: database.query('SELECT key, value FROM schema_metadata ORDER BY key').all(),
      schema: database
        .query(
          `SELECT type, name, tbl_name, sql
           FROM sqlite_schema
           WHERE name NOT LIKE 'sqlite_%'
           ORDER BY type, name`,
        )
        .all(),
      snapshots: database.query('SELECT id, state FROM snapshots ORDER BY id').all(),
    };
  } finally {
    database.close();
  }
}

function fixtureEmbeddingManifest(content: Uint8Array): LocalModelManifest {
  return {
    architecture: 'fixture',
    contextLimit: 32,
    dimensions: 2,
    file: 'fixture.gguf',
    id: 'fixture-embedding',
    license: 'MIT',
    minimumRamBytes: 1,
    normalization: 'l2',
    promptPrefixes: {document: '', query: ''},
    quantization: 'fixture',
    repository: 'threadnote/fixture',
    revision: Effect2.pipe('a', EffectString.repeat(40)),
    role: 'embedding',
    runtime: {nodeLlamaCpp: '3.19.1'},
    sha256: createHash('sha256').update(content).digest('hex'),
    size: content.byteLength,
    version: 1,
  };
}
