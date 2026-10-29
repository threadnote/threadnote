import {Array as EffectArray, Option as EffectOption} from 'effect';
import {execFile} from '@threadnote/testing/node-child-process';
import {mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile} from '@threadnote/testing/node-fs-promises';
import {tmpdir} from '@threadnote/testing/node-os';
import {join} from '@threadnote/testing/node-path';
import {promisify} from '@threadnote/testing/node-util';
import {describe, expect, it} from 'vitest';
import {Schema} from 'effect';
import {decodeCodeGraphCheckpointPackV1, encodeCodeGraphCheckpointPackV1} from '@threadnote/graph/checkpoint/pack';
import type {CodeGraphCheckpointMetadataV1, CodeGraphCheckpointRecordV1} from '@threadnote/graph/checkpoint/schema';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

const execFilePromise = promisify(execFile);
const JsonRecordSchema = Schema.Record(Schema.String, Schema.Unknown);
const withRest = <const S extends Schema.StructWithRest.Objects>(schema: S) =>
  Schema.StructWithRest(schema, [JsonRecordSchema]);
const CheckpointExportSchema = withRest(
  Schema.Struct({
    artifact: withRest(Schema.Struct({digest: Schema.String, size: Schema.Finite})),
    logicalDigest: Schema.String,
  }),
);
const CheckpointInspectionSchema = withRest(
  Schema.Struct({
    descriptor: withRest(Schema.Struct({digest: Schema.String})),
    verification: Schema.String,
  }),
);
const CheckpointImportSchema = withRest(
  Schema.Struct({
    artifact: withRest(Schema.Struct({digest: Schema.String, size: Schema.Finite})),
    imported: Schema.Literals(['created', 'reused']),
    publication: Schema.Literals(['activated', 'rebuilt', 'stored']),
    snapshotId: Schema.String,
    trust: Schema.Literals(['expected-descriptor-verified', 'local-unverified']),
  }),
);
const decodeCheckpointExport = Schema.decodeUnknownSync(CheckpointExportSchema);
const decodeCheckpointInspection = Schema.decodeUnknownSync(CheckpointInspectionSchema);
const decodeCheckpointImport = Schema.decodeUnknownSync(CheckpointImportSchema);

describe('code graph checkpoint CLI', () => {
  it('exports once, verifies fully, and selects safe receiver publication from Git state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'threadnote-checkpoint-cli-'));
    const repository = join(root, 'repository');
    const artifact = join(root, 'source.cgcp');
    const importedArtifact = join(root, 'imported.cgcp');
    const repeatedArtifact = join(root, 'source-repeated.cgcp');
    const corruptedArtifact = join(root, 'corrupted.cgcp');
    const forgedDisplayArtifact = join(root, 'forged-display.cgcp');
    const falseGraphContentArtifact = join(root, 'false-graph-content.cgcp');
    const falseExtractorArtifact = join(root, 'false-extractor.cgcp');
    const falsePackArtifact = join(root, 'false-pack.cgcp');
    try {
      await mkdir(join(repository, 'src'), {recursive: true});
      await writeFile(join(repository, 'package.json'), '{"name":"checkpoint-cli","private":true,"type":"module"}\n');
      await writeFile(join(repository, 'src', 'index.ts'), 'export const base = 1;\n');
      await git(repository, ['init', '-q', '--initial-branch=main']);
      await git(repository, ['remote', 'add', 'origin', 'https://github.com/acme/checkpoint-cli.git']);
      await git(repository, ['add', '.']);
      await commit(repository, 'base');
      await git(repository, ['checkout', '-qb', 'checkpoint-source']);
      await writeFile(join(repository, 'src', 'source.ts'), 'export const checkpointSource = 2;\n');
      await git(repository, ['add', '.']);
      await commit(repository, 'checkpoint source');

      const exportHome = join(root, 'export-home');
      await runCli(['graph', 'index', '--home', exportHome, '--cwd', repository, '--json']);
      const exported = decodeCheckpointExport(
        JSON.parse(
          (
            await runCli([
              'graph',
              'checkpoint',
              'export',
              '--home',
              exportHome,
              '--cwd',
              repository,
              '--output',
              artifact,
              '--json',
            ])
          ).stdout,
        ),
      );
      expect(exported.artifact.digest).toMatch(/^sha256:[0-9a-f]{64}$/u);
      expect(exported.artifact.size).toBeGreaterThan(0);
      expect(exported.logicalDigest).toMatch(/^[0-9a-f]{64}$/u);

      const originalBytes = await readFile(artifact);
      const repeated = decodeCheckpointExport(
        JSON.parse(
          (
            await runCli([
              'graph',
              'checkpoint',
              'export',
              '--home',
              exportHome,
              '--cwd',
              repository,
              '--output',
              repeatedArtifact,
              '--json',
            ])
          ).stdout,
        ),
      );
      expect(repeated.artifact).toEqual(exported.artifact);
      expect(repeated.logicalDigest).toBe(exported.logicalDigest);
      expect(await readFile(repeatedArtifact)).toEqual(originalBytes);
      await expect(
        runCli(['graph', 'checkpoint', 'export', '--home', exportHome, '--cwd', repository, '--output', artifact]),
      ).rejects.toMatchObject({code: 1, stderr: expect.stringContaining('already exists')});
      expect(await readFile(artifact)).toEqual(originalBytes);

      const inspected = decodeCheckpointInspection(
        JSON.parse(
          (
            await runCli([
              'graph',
              'checkpoint',
              'inspect',
              '--input',
              artifact,
              '--expected-digest',
              exported.artifact.digest,
              '--json',
            ])
          ).stdout,
        ),
      );
      const verified = decodeCheckpointInspection(
        JSON.parse(
          (
            await runCli([
              'graph',
              'checkpoint',
              'verify',
              '--input',
              artifact,
              '--expected-digest',
              exported.artifact.digest,
              '--json',
            ])
          ).stdout,
        ),
      );
      expect(inspected).toMatchObject({
        descriptor: {digest: exported.artifact.digest},
        verification: 'artifact-and-framing',
      });
      expect(verified).toMatchObject({descriptor: {digest: exported.artifact.digest}, verification: 'full'});

      const decoded = decodeCodeGraphCheckpointPackV1(originalBytes);
      await writeFile(
        forgedDisplayArtifact,
        rewriteCheckpoint(decoded, metadata => ({
          ...metadata,
          repository: {...metadata.repository, displayName: 'trusted\nFORGED\u001b]8;;https://invalid.local\u0007'},
        })),
      );
      const safeInspection = await runCli(['graph', 'checkpoint', 'inspect', '--input', forgedDisplayArtifact]);
      expect(safeInspection.stdout).not.toContain('\nFORGED');
      expect(safeInspection.stdout).not.toContain('\u001b');
      expect(safeInspection.stdout).not.toContain('\u0007');
      expect(safeInspection.stdout).toContain('trusted\\u{000a}FORGED\\u{001b}]8;;https://invalid.local\\u{0007}');

      await writeFile(
        falseGraphContentArtifact,
        rewriteCheckpoint(decoded, metadata => ({
          ...metadata,
          source: {...metadata.source, graphContentId: `cgc_${Effect.pipe('f', EffectString.repeat(40))}`},
        })),
      );
      await expect(
        runCli(['graph', 'checkpoint', 'verify', '--input', falseGraphContentArtifact]),
      ).rejects.toMatchObject({code: 1, stderr: expect.stringContaining('graph content identity')});
      const rejectedHome = join(root, 'rejected-home');
      await expect(
        runCli([
          'graph',
          'checkpoint',
          'import',
          '--home',
          rejectedHome,
          '--cwd',
          repository,
          '--input',
          falseGraphContentArtifact,
        ]),
      ).rejects.toMatchObject({code: 1});
      expect(
        EffectArray.some(await recursiveFiles(rejectedHome), file =>
          Effect.pipe(file, EffectString.endsWith('.sqlite')),
        ),
      ).toBe(false);

      await writeFile(
        falseExtractorArtifact,
        rewriteCheckpoint(decoded, metadata => ({
          ...metadata,
          source: {...metadata.source, extractorSet: 'forged-extractor'},
        })),
      );
      await expect(runCli(['graph', 'checkpoint', 'verify', '--input', falseExtractorArtifact])).rejects.toMatchObject({
        code: 1,
        stderr: expect.stringContaining('extractor identity'),
      });

      const packRecordIndex = EffectOption.getOrElse(
        EffectArray.findFirstIndex(decoded.records, record => record.kind === 'pack-provenance'),
        () => -1,
      );
      expect(packRecordIndex).toBeGreaterThanOrEqual(0);
      await writeFile(
        falsePackArtifact,
        rewriteCheckpoint(
          decoded,
          metadata => metadata,
          records =>
            EffectArray.map(records, (record, index) =>
              index === packRecordIndex && record.kind === 'pack-provenance'
                ? {...record, resolutionVersion: `${record.resolutionVersion}-forged`}
                : record,
            ),
        ),
      );
      await expect(runCli(['graph', 'checkpoint', 'verify', '--input', falsePackArtifact])).rejects.toMatchObject({
        code: 1,
        stderr: expect.stringContaining('pack provenance'),
      });
      if (process.platform !== 'win32') {
        const symbolicArtifact = join(root, 'symbolic.cgcp');
        await symlink(artifact, symbolicArtifact);
        await expect(
          runCli(['graph', 'checkpoint', 'inspect', '--input', symbolicArtifact, '--json']),
        ).rejects.toMatchObject({code: 1, stderr: expect.stringContaining('symbolic link')});
      }

      const populated = await importCheckpoint(repository, exportHome, artifact, exported.artifact.digest);
      expect(populated).toMatchObject({imported: 'created', publication: 'activated'});
      const importedExport = decodeCheckpointExport(
        JSON.parse(
          (
            await runCli([
              'graph',
              'checkpoint',
              'export',
              '--home',
              exportHome,
              '--cwd',
              repository,
              '--output',
              importedArtifact,
              '--json',
            ])
          ).stdout,
        ),
      );
      expect(importedExport).toMatchObject({
        artifact: exported.artifact,
        logicalDigest: exported.logicalDigest,
      });
      expect(await readFile(importedArtifact)).toEqual(originalBytes);

      const exactHome = join(root, 'exact-home');
      const exact = await importCheckpoint(repository, exactHome, artifact, exported.artifact.digest);
      const reused = await importCheckpoint(repository, exactHome, artifact, exported.artifact.digest);
      expect(exact).toMatchObject({
        imported: 'created',
        publication: 'activated',
        trust: 'expected-descriptor-verified',
      });
      expect(reused).toMatchObject({
        artifact: exact.artifact,
        imported: 'reused',
        publication: 'activated',
        snapshotId: exact.snapshotId,
      });

      await writeFile(join(repository, 'src', 'dirty.ts'), 'export const dirty = true;\n');
      const dirty = await importCheckpoint(repository, join(root, 'dirty-home'), artifact, exported.artifact.digest);
      expect(dirty).toMatchObject({imported: 'created', publication: 'rebuilt'});
      await rm(join(repository, 'src', 'dirty.ts'));

      await writeFile(join(repository, 'src', 'descendant.ts'), 'export const descendant = 3;\n');
      await git(repository, ['add', '.']);
      await commit(repository, 'descendant');
      const descendant = await importCheckpoint(
        repository,
        join(root, 'descendant-home'),
        artifact,
        exported.artifact.digest,
      );
      expect(descendant).toMatchObject({imported: 'created', publication: 'rebuilt'});
      expect(descendant.snapshotId).not.toBe(exact.snapshotId);

      await git(repository, ['checkout', '-q', 'main']);
      await writeFile(join(repository, 'src', 'divergent.ts'), 'export const divergent = 4;\n');
      await git(repository, ['add', '.']);
      await commit(repository, 'divergent');
      const divergent = await importCheckpoint(repository, join(root, 'divergent-home'), artifact);
      expect(divergent).toMatchObject({
        imported: 'created',
        publication: 'stored',
        snapshotId: exact.snapshotId,
        trust: 'local-unverified',
      });

      const corrupted = Uint8Array.from(originalBytes);
      corrupted[corrupted.length - 1] = corrupted[corrupted.length - 1] ^ 0xff;
      await writeFile(corruptedArtifact, corrupted);
      const corruptInspection = decodeCheckpointInspection(
        JSON.parse((await runCli(['graph', 'checkpoint', 'inspect', '--input', corruptedArtifact, '--json'])).stdout),
      );
      expect(corruptInspection.verification).toBe('artifact-and-framing');
      expect(corruptInspection.descriptor.digest).not.toBe(exported.artifact.digest);
      await expect(
        runCli(['graph', 'checkpoint', 'verify', '--input', corruptedArtifact, '--json']),
      ).rejects.toMatchObject({code: 1});
    } finally {
      await rm(root, {force: true, recursive: true});
    }
  }, 120_000);
});

function rewriteCheckpoint(
  decoded: ReturnType<typeof decodeCodeGraphCheckpointPackV1>,
  rewriteMetadata: (metadata: CodeGraphCheckpointMetadataV1) => CodeGraphCheckpointMetadataV1,
  rewriteRecords: (
    records: readonly CodeGraphCheckpointRecordV1[],
  ) => readonly CodeGraphCheckpointRecordV1[] = records => records,
): Uint8Array {
  const header = decoded.header;
  const metadata: CodeGraphCheckpointMetadataV1 = {
    abi: header.abi.input,
    coverage: header.coverage,
    repository: header.repository,
    ...(header.reuse === undefined ? {} : {reuse: header.reuse}),
    source: header.source,
  };
  return encodeCodeGraphCheckpointPackV1(rewriteMetadata(metadata), rewriteRecords(decoded.records)).bytes;
}

function isNodeError(cause: unknown): cause is NodeJS.ErrnoException {
  return typeof cause === 'object' && cause !== null && 'code' in cause;
}

async function recursiveFiles(root: string): Promise<readonly string[]> {
  try {
    return await readdir(root, {recursive: true});
  } catch (cause) {
    if (isNodeError(cause) && cause.code === 'ENOENT') return [];
    throw cause;
  }
}

async function importCheckpoint(
  repository: string,
  home: string,
  artifact: string,
  digest?: string,
): Promise<ReturnType<typeof decodeCheckpointImport>> {
  const result = await runCli([
    'graph',
    'checkpoint',
    'import',
    '--home',
    home,
    '--cwd',
    repository,
    '--input',
    artifact,
    ...(digest === undefined ? [] : ['--expected-digest', digest]),
    '--json',
  ]);
  return decodeCheckpointImport(JSON.parse(result.stdout));
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
