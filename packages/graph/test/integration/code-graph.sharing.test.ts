import {Array as EffectArray} from 'effect';
import {execFile} from '@threadnote/testing/node-child-process';
import {mkdir, mkdtemp, readFile, readdir, rm, writeFile} from '@threadnote/testing/node-fs-promises';
import {tmpdir} from '@threadnote/testing/node-os';
import {join} from '@threadnote/testing/node-path';
import {promisify} from '@threadnote/testing/node-util';
import {Schema} from 'effect';
import {describe, expect, it} from 'vitest';

const WorkflowShareOutputSchema = Schema.Struct({
  profileDigest: Schema.String,
  written: Schema.Boolean,
});
const PublishedCheckpointSchema = Schema.Struct({
  checkpointDigest: Schema.String,
  manifestDigest: Schema.String,
});
const SnapshotSchema = Schema.Struct({
  commit: Schema.String,
  fileCount: Schema.Finite,
  graphContentId: Schema.optionalKey(Schema.String),
  id: Schema.String,
  symbolCount: Schema.Finite,
});
const IndexedGraphSchema = Schema.Struct({
  identity: Schema.Struct({checkoutId: Schema.String}),
  snapshot: SnapshotSchema,
});
const LocalIndexedGraphSchema = Schema.Struct({snapshot: SnapshotSchema});
const ProvenanceSchema = Schema.Struct({
  checkpointDigest: Schema.String,
  snapshotId: Schema.String,
});
const SnapshotProvenanceSchema = Schema.Struct({snapshotId: Schema.String});
const ImportStatusSchema = Schema.Struct({
  lastImport: Schema.optionalKey(
    Schema.Struct({
      imported: Schema.Boolean,
      reason: Schema.String,
    }),
  ),
});
const QuerySourceSchema = Schema.Struct({
  deltaCount: Schema.optionalKey(Schema.Finite),
  frontierCommit: Schema.optionalKey(Schema.String),
  kind: Schema.optionalKey(Schema.String),
  localCommit: Schema.optionalKey(Schema.String),
  profileDigest: Schema.optionalKey(Schema.String),
});
const QueryResultSchema = Schema.Struct({
  nodes: Schema.Array(Schema.Struct({name: Schema.String})),
  source: Schema.optionalKey(Schema.Unknown),
});
const OverlayQueryResultSchema = Schema.Struct({
  nodes: Schema.Array(Schema.Struct({name: Schema.String})),
  snapshot: Schema.Struct({dirty: Schema.Boolean, id: Schema.String}),
  source: Schema.optionalKey(QuerySourceSchema),
});
const ParityStatusSchema = Schema.Struct({enrolled: Schema.Boolean, trusted: Schema.Boolean});
const LocalStatusSchema = Schema.Struct({
  enrolled: Schema.optionalKey(Schema.Boolean),
  lastImport: Schema.optionalKey(
    Schema.Struct({
      imported: Schema.Boolean,
      reason: Schema.String,
    }),
  ),
});
const ContributionStatusSchema = Schema.Struct({mode: Schema.String, queued: Schema.Finite});
const ServeStatusSchema = Schema.Struct({generation: Schema.Finite, sourceCommit: Schema.String});
const AdvancedGraphSchema = Schema.Struct({snapshot: Schema.Struct({id: Schema.String})});
const WorkerStatusSchema = Schema.Struct({
  eligible: Schema.Finite,
  skippedMissingBlob: Schema.Finite,
});
const JsonRecordSchema = Schema.Record(Schema.String, Schema.Unknown);
const TrustClientSchema = Schema.StructWithRest(
  Schema.Struct({
    casRoot: Schema.String,
    contributionMode: Schema.String,
  }),
  [JsonRecordSchema],
);
const TrustReceiptSchema = Schema.StructWithRest(
  Schema.Struct({
    client: TrustClientSchema,
  }),
  [JsonRecordSchema],
);
const TrustReceiptsSchema = Schema.Array(TrustReceiptSchema);
function decodeJson<S extends Schema.ConstraintDecoder<unknown>>(schema: S, value: unknown): S['Type'] {
  return Schema.decodeUnknownSync(schema)(value);
}

const execFilePromise = promisify(execFile);

describe('code graph sharing Phases 0–2', () => {
  it('imports a verified shared checkpoint on a second home and keeps local graphs without enrollment', async () => {
    const root = await mkdtemp(join(tmpdir(), 'threadnote-graph-share-'));
    const repository = join(root, 'repository');
    const cas = join(root, 'cas');
    const publisherHome = join(root, 'publisher-home');
    const clientHome = join(root, 'client-home');
    const localHome = join(root, 'local-home');
    try {
      await mkdir(join(repository, 'src'), {recursive: true});
      await writeFile(join(repository, 'package.json'), '{"name":"graph-share","private":true,"type":"module"}\n');
      await writeFile(join(repository, 'src', 'index.ts'), 'export const shared = 1;\n');
      await git(repository, ['init', '-q', '--initial-branch=main']);
      await git(repository, ['remote', 'add', 'origin', 'https://github.com/acme/graph-share.git']);
      await git(repository, ['add', '.']);
      await commit(repository, 'base');

      await runCli(['graph', 'index', '--home', publisherHome, '--cwd', repository, '--json']);
      const initialized = decodeJson(
        WorkflowShareOutputSchema,
        JSON.parse(
          (
            await runCli([
              'graph',
              'share',
              'init',
              '--home',
              publisherHome,
              '--cwd',
              repository,
              '--cas',
              cas,
              '--organization',
              'acme',
              '--write-config',
              '--json',
            ])
          ).stdout,
        ),
      );
      expect(initialized.written).toBe(true);
      expect(initialized.profileDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
      await git(repository, ['add', '.threadnote/graph-share.json']);
      await commit(repository, 'enroll graph sharing');
      await runCli(['graph', 'index', '--full', '--home', publisherHome, '--cwd', repository, '--json']);
      const published = decodeJson(
        PublishedCheckpointSchema,
        JSON.parse(
          (
            await runCli([
              'graph',
              'publisher',
              'bootstrap',
              '--home',
              publisherHome,
              '--cwd',
              repository,
              '--cas',
              cas,
              '--json',
            ])
          ).stdout,
        ),
      );
      expect(published.checkpointDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);

      const casBeforeJoin = await listFiles(cas);
      await runCli([
        'graph',
        'share',
        'join',
        '--home',
        clientHome,
        '--cwd',
        repository,
        '--cas',
        cas,
        '--read-only',
        '--json',
      ]);
      expect(await listFiles(cas)).toEqual(casBeforeJoin);

      const indexed = decodeJson(
        IndexedGraphSchema,
        JSON.parse((await runCli(['graph', 'index', '--home', clientHome, '--cwd', repository, '--json'])).stdout),
      );
      expect(indexed.snapshot.id).toMatch(/^cgsn_/);
      const provenance = decodeJson(
        ProvenanceSchema,
        JSON.parse(
          await readFile(
            join(clientHome, 'graph-sharing', 'provenance', `${indexed.identity.checkoutId}.json`),
            'utf8',
          ),
        ),
      );
      expect(provenance.checkpointDigest).toBe(published.checkpointDigest);
      expect(provenance.snapshotId).toBe(indexed.snapshot.id);
      const importStatus = decodeJson(
        ImportStatusSchema,
        JSON.parse(
          (await runCli(['graph', 'share', 'status', '--home', clientHome, '--cwd', repository, '--json'])).stdout,
        ),
      );
      expect(importStatus.lastImport).toMatchObject({imported: true, reason: 'imported'});
      const queried = decodeJson(
        QueryResultSchema,
        JSON.parse(
          (await runCli(['graph', 'query', '--home', clientHome, '--cwd', repository, '--query', 'shared', '--json']))
            .stdout,
        ),
      );
      expect(queried.source).toMatchObject({
        kind: 'shared-base-plus-local-overlay',
        profileDigest: initialized.profileDigest,
      });

      const parityHome = join(root, 'parity-home');
      const parityStatus = decodeJson(
        ParityStatusSchema,
        JSON.parse(
          (await runCli(['graph', 'share', 'status', '--home', parityHome, '--cwd', repository, '--json'])).stdout,
        ),
      );
      expect(parityStatus).toMatchObject({enrolled: true, trusted: false});
      const localIndexed = decodeJson(
        LocalIndexedGraphSchema,
        JSON.parse((await runCli(['graph', 'index', '--home', parityHome, '--cwd', repository, '--json'])).stdout),
      );
      expect(localIndexed.snapshot.commit).toBe(indexed.snapshot.commit);
      expect(localIndexed.snapshot.fileCount).toBe(indexed.snapshot.fileCount);
      expect(localIndexed.snapshot.symbolCount).toBe(indexed.snapshot.symbolCount);
      expect(localIndexed.snapshot.graphContentId).toBe(indexed.snapshot.graphContentId);
      const localQueried = decodeJson(
        QueryResultSchema,
        JSON.parse(
          (await runCli(['graph', 'query', '--home', parityHome, '--cwd', repository, '--query', 'shared', '--json']))
            .stdout,
        ),
      );
      expect(localQueried.source).toBeUndefined();
      expect(EffectArray.map(localQueried.nodes, node => node.name).sort()).toEqual(
        EffectArray.map(queried.nodes, node => node.name).sort(),
      );

      await writeFile(join(repository, 'src', 'dirty.ts'), 'export const dirty = 2;\n');
      await runCli(['graph', 'index', '--home', clientHome, '--cwd', repository, '--json']);
      const overlay = decodeJson(
        OverlayQueryResultSchema,
        JSON.parse(
          (await runCli(['graph', 'query', '--home', clientHome, '--cwd', repository, '--query', 'dirty', '--json']))
            .stdout,
        ),
      );
      expect(overlay.snapshot.dirty).toBe(true);
      expect(EffectArray.some(overlay.nodes, node => node.name === 'dirty')).toBe(true);
      expect(overlay.source).toMatchObject({
        deltaCount: 0,
        kind: 'shared-base-plus-local-overlay',
        profileDigest: initialized.profileDigest,
      });
      const overlayProvenance = decodeJson(
        SnapshotProvenanceSchema,
        JSON.parse(
          await readFile(
            join(clientHome, 'graph-sharing', 'provenance', `${indexed.identity.checkoutId}.json`),
            'utf8',
          ),
        ),
      );
      expect(overlayProvenance.snapshotId).toBe(indexed.snapshot.id);
      const overlayStatus = decodeJson(
        ImportStatusSchema,
        JSON.parse(
          (await runCli(['graph', 'share', 'status', '--home', clientHome, '--cwd', repository, '--json'])).stdout,
        ),
      );
      expect(overlayStatus.lastImport?.reason).toBe('already-installed');

      await rm(join(repository, 'src', 'dirty.ts'));
      const contribution = decodeJson(
        ContributionStatusSchema,
        JSON.parse(
          (await runCli(['graph', 'contribute', 'status', '--home', clientHome, '--cwd', repository, '--json'])).stdout,
        ),
      );
      expect(contribution).toMatchObject({mode: 'off', queued: 0});
      const idleServe = decodeJson(
        ServeStatusSchema,
        JSON.parse(
          (
            await runCli([
              'graph',
              'publisher',
              'serve',
              '--home',
              publisherHome,
              '--cwd',
              repository,
              '--cas',
              cas,
              '--json',
            ])
          ).stdout,
        ),
      );
      expect(idleServe.generation).toBe(1);
      await writeFile(join(repository, 'src', 'next.ts'), 'export const next = 3;\n');
      await git(repository, ['add', 'src/next.ts']);
      await commit(repository, 'advance frontier');
      await runCli(['graph', 'index', '--full', '--home', publisherHome, '--cwd', repository, '--json']);
      const served = decodeJson(
        ServeStatusSchema,
        JSON.parse(
          (
            await runCli([
              'graph',
              'publisher',
              'serve',
              '--home',
              publisherHome,
              '--cwd',
              repository,
              '--cas',
              cas,
              '--json',
            ])
          ).stdout,
        ),
      );
      expect(served.generation).toBe(2);
      expect(served.sourceCommit).not.toBe(idleServe.sourceCommit);
      const advanced = decodeJson(
        AdvancedGraphSchema,
        JSON.parse((await runCli(['graph', 'index', '--home', clientHome, '--cwd', repository, '--json'])).stdout),
      );
      expect(advanced.snapshot.id).toMatch(/^cgsn_/);
      const worker = decodeJson(
        WorkerStatusSchema,
        JSON.parse((await runCli(['graph', 'worker', '--json', '--home', clientHome, '--cwd', repository])).stdout),
      );
      expect(worker).toMatchObject({eligible: 0, skippedMissingBlob: 0});

      const unenrolled = join(root, 'unenrolled');
      await mkdir(join(unenrolled, 'src'), {recursive: true});
      await writeFile(join(unenrolled, 'package.json'), '{"name":"local-only","private":true,"type":"module"}\n');
      await writeFile(join(unenrolled, 'src', 'index.ts'), 'export const localOnly = 1;\n');
      await git(unenrolled, ['init', '-q', '--initial-branch=main']);
      await git(unenrolled, ['remote', 'add', 'origin', 'https://github.com/acme/local-only.git']);
      await git(unenrolled, ['add', '.']);
      await commit(unenrolled, 'local');
      const localIndex = decodeJson(
        LocalIndexedGraphSchema,
        JSON.parse((await runCli(['graph', 'index', '--home', localHome, '--cwd', unenrolled, '--json'])).stdout),
      );
      expect(localIndex.snapshot.id).toMatch(/^cgsn_/);
      const status = decodeJson(
        LocalStatusSchema,
        JSON.parse(
          (await runCli(['graph', 'share', 'status', '--home', localHome, '--cwd', unenrolled, '--json'])).stdout,
        ),
      );
      expect(status.enrolled).toBe(false);
    } finally {
      await rm(root, {force: true, recursive: true});
    }
  }, 180_000);

  it('keeps a queryable local graph when the coordinator is unavailable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'threadnote-graph-share-unavailable-'));
    const repository = join(root, 'repository');
    const cas = join(root, 'cas');
    const publisherHome = join(root, 'publisher-home');
    const clientHome = join(root, 'client-home');
    try {
      await mkdir(join(repository, 'src'), {recursive: true});
      await writeFile(join(repository, 'package.json'), '{"name":"graph-share-miss","private":true,"type":"module"}\n');
      await writeFile(join(repository, 'src', 'index.ts'), 'export const shared = 1;\n');
      await git(repository, ['init', '-q', '--initial-branch=main']);
      await git(repository, ['remote', 'add', 'origin', 'https://github.com/acme/graph-share-miss.git']);
      await git(repository, ['add', '.']);
      await commit(repository, 'base');
      await runCli(['graph', 'index', '--home', publisherHome, '--cwd', repository, '--json']);
      await runCli([
        'graph',
        'share',
        'init',
        '--home',
        publisherHome,
        '--cwd',
        repository,
        '--cas',
        cas,
        '--organization',
        'acme',
        '--write-config',
        '--json',
      ]);
      await git(repository, ['add', '.threadnote/graph-share.json']);
      await commit(repository, 'enroll graph sharing');
      await runCli([
        'graph',
        'share',
        'join',
        '--home',
        clientHome,
        '--cwd',
        repository,
        '--cas',
        cas,
        '--read-only',
        '--json',
      ]);
      const trustPath = join(clientHome, 'graph-sharing', 'trust-receipts.json');
      const trust = decodeJson(JsonRecordSchema, JSON.parse(await readFile(trustPath, 'utf8')));
      const trustReceipts = decodeJson(TrustReceiptsSchema, trust.receipts);
      expect(trustReceipts).toHaveLength(1);
      expect(trustReceipts[0].client.casRoot).toBe(cas);
      await writeFile(
        trustPath,
        `${JSON.stringify({
          ...trust,
          receipts: EffectArray.map(trustReceipts, receipt => ({
            ...receipt,
            client: {...receipt.client, coordinatorUrl: 'http://127.0.0.1:1'},
          })),
        })}\n`,
      );
      const indexed = decodeJson(
        IndexedGraphSchema,
        JSON.parse((await runCli(['graph', 'index', '--home', clientHome, '--cwd', repository, '--json'])).stdout),
      );
      expect(indexed.snapshot.id).toMatch(/^cgsn_/);
      expect(indexed.snapshot.symbolCount).toBeGreaterThan(0);
      const status = decodeJson(
        LocalStatusSchema,
        JSON.parse(
          (await runCli(['graph', 'share', 'status', '--home', clientHome, '--cwd', repository, '--json'])).stdout,
        ),
      );
      expect(status.lastImport).toEqual({imported: false, reason: 'unavailable'});
      const queried = decodeJson(
        QueryResultSchema,
        JSON.parse(
          (await runCli(['graph', 'query', '--home', clientHome, '--cwd', repository, '--query', 'shared', '--json']))
            .stdout,
        ),
      );
      expect(queried.source).toBeUndefined();
      expect(EffectArray.some(queried.nodes, node => node.name === 'shared')).toBe(true);
      const provenancePath = join(clientHome, 'graph-sharing', 'provenance', `${indexed.identity.checkoutId}.json`);
      await expect(readFile(provenancePath, 'utf8')).rejects.toThrow();
    } finally {
      await rm(root, {force: true, recursive: true});
    }
  }, 180_000);
});

async function listFiles(root: string): Promise<readonly string[]> {
  try {
    return (await readdir(root, {recursive: true})).slice().sort();
  } catch {
    return [];
  }
}

async function git(cwd: string, args: readonly string[]): Promise<void> {
  await execFilePromise('git', ['-C', cwd, ...args]);
}

async function commit(cwd: string, message: string): Promise<void> {
  await git(cwd, [
    '-c',
    'user.name=Threadnote Test',
    '-c',
    'user.email=test@threadnote.local',
    'commit',
    '-qm',
    message,
  ]);
}

function runCli(args: readonly string[]) {
  return execFilePromise(process.execPath, ['apps/threadnote/src/standalone.ts', ...args], {
    cwd: process.cwd(),
    env: {...process.env, NO_COLOR: '1', THREADNOTE_TELEMETRY: '0'},
  });
}
