import {Array as EffectArray} from 'effect';
import {describe, expect, it} from '@effect/vitest';
import {Effect, FileSystem, Path} from 'effect';
import {TestClock} from 'effect/testing';
import {
  importCodeGraphCheckpointSnapshot,
  runCodeGraphCheckpointExport,
} from '@threadnote/threadnote/code_graph/checkpoint/commands';
import {decodeCodeGraphCheckpointPackV1, encodeCodeGraphCheckpointPackV1} from '@threadnote/graph/checkpoint/pack';
import type {CodeGraphCheckpointMetadataV1} from '@threadnote/graph/checkpoint/schema';
import {CodeGraphIndexer} from '@threadnote/graph/indexer';
import {codeGraphLayout} from '@threadnote/graph/layout';
import {resolveRepositoryIdentity} from '@threadnote/graph/repository';
import {CodeGraphStore} from '@threadnote/graph/store';
import {runCommandEffect} from '@threadnote/platform/command';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import {provideTestLayer} from '../helpers/effect-layer.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

describe('checkpoint portability across Git case settings', () => {
  it.effect(
    'imports in both directions with exact path fidelity and preserves ready state on typed rejection',
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const indexer = yield* CodeGraphIndexer;
        const store = yield* CodeGraphStore;
        const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-checkpoint-case-'});
        const repo = path.join(root, 'repository');
        const spacedPath = process.platform === 'win32' ? 'src/a spaced file.ts' : 'src/a "quoted" file.ts';
        yield* fs.makeDirectory(path.join(repo, 'src'), {recursive: true});
        yield* fs.writeFileString(path.join(repo, 'package.json'), '{"name":"checkpoint-case","type":"module"}\n');
        yield* fs.writeFileString(path.join(repo, 'src/Value.ts'), 'export const value = 1;\n');
        yield* fs.writeFileString(path.join(repo, 'src/文.ts'), 'export const unicode = 2;\n');
        yield* fs.writeFileString(path.join(repo, spacedPath), 'export const quoted = 3;\n');
        yield* fs.writeFileString(path.join(repo, '.gitignore'), 'src/value.ts\n');
        yield* git(repo, ['init', '-q', '--initial-branch=main']);
        yield* git(repo, ['remote', 'add', 'origin', 'https://github.com/acme/checkpoint-case.git']);
        yield* git(repo, ['add', '-f', 'package.json', '.gitignore', 'src/Value.ts', 'src/文.ts', spacedPath]);
        yield* git(repo, ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture']);

        for (const donorMode of ['false', 'true']) {
          const receiverMode = donorMode === 'false' ? 'true' : 'false';
          const donorHome = path.join(root, `donor-${donorMode}`);
          const receiverHome = path.join(root, `receiver-${receiverMode}`);
          const independentHome = path.join(root, `independent-${receiverMode}`);
          const artifact = path.join(root, `checkpoint-${donorMode}.cgcp`);
          yield* git(repo, ['config', 'core.ignorecase', donorMode]);
          const source = yield* indexer.index({cwd: repo, threadnoteHome: donorHome, ensureVectors: false});
          const exported = yield* runCodeGraphCheckpointExport(config(donorHome), {
            cwd: repo,
            output: artifact,
            quiet: true,
          });
          const originalBytes = yield* fs.readFile(artifact);
          const decoded = decodeCodeGraphCheckpointPackV1(originalBytes);
          expect(decoded.header.repository.caseMode).toBe(donorMode === 'true' ? 'insensitive' : 'sensitive');
          expect(
            EffectArray.map(
              EffectArray.filter(decoded.records, record => record.kind === 'file'),
              record => record.path,
            ),
          ).toEqual(['package.json', 'src/Value.ts', spacedPath, 'src/文.ts']);

          yield* git(repo, ['config', 'core.ignorecase', receiverMode]);
          const imported = yield* importCodeGraphCheckpointSnapshot(config(receiverHome), {
            cwd: repo,
            input: artifact,
            expectedDigest: exported.artifact.digest,
          });
          expect(imported.result).toMatchObject({
            imported: 'created',
            publication: 'activated',
            trust: 'expected-descriptor-verified',
          });
          const independent = yield* indexer.index({cwd: repo, threadnoteHome: independentHome, ensureVectors: false});
          expect(imported.snapshot.graphContentId).toBe(source.snapshot.graphContentId);
          expect(imported.snapshot.graphContentId).toBe(independent.snapshot.graphContentId);
          const identity = yield* resolveRepositoryIdentity(repo);
          const database = codeGraphLayout(path, receiverHome, identity.checkoutId, identity.worktreeId).databasePath;
          expect(yield* store.checkpointImportReceipt(database, imported.snapshot.id)).toMatchObject({
            trust: 'expected-descriptor-verified',
          });

          const metadata: CodeGraphCheckpointMetadataV1 = {
            abi: decoded.header.abi.input,
            coverage: decoded.header.coverage,
            repository: decoded.header.repository,
            source: decoded.header.source,
            ...(decoded.header.reuse === undefined ? {} : {reuse: decoded.header.reuse}),
          };
          const invalid = [
            {
              ...metadata,
              repository: {...metadata.repository, repositoryId: Effect2.pipe('0', EffectString.repeat(64))},
            },
            {...metadata, repository: {...metadata.repository, objectFormat: 'sha256' as const}},
            {...metadata, abi: {...metadata.abi, inventoryPolicyVersion: metadata.abi.inventoryPolicyVersion - 1}},
          ];
          for (const [index, changed] of invalid.entries()) {
            const badArtifact = path.join(root, `invalid-${donorMode}-${index}.cgcp`);
            yield* fs.writeFile(badArtifact, encodeCodeGraphCheckpointPackV1(changed, decoded.records).bytes);
            const error = yield* importCodeGraphCheckpointSnapshot(config(receiverHome), {
              cwd: repo,
              input: badArtifact,
            }).pipe(Effect.flip);
            expect(error).toMatchObject({
              _tag: 'CodeGraphCheckpointCommandError',
              message: expect.stringContaining(
                index === 2 ? 'runtime ABI is incompatible' : 'repository identity does not match',
              ),
            });
            expect((yield* store.readySnapshot(database, identity.worktreeId))?.id).toBe(imported.snapshot.id);
          }
          yield* fs.writeFileString(path.join(repo, 'src/Value.ts'), 'export const value = 3;\n');
          const dirty = yield* importCodeGraphCheckpointSnapshot(config(receiverHome), {cwd: repo, input: artifact});
          expect(dirty.result.publication).toBe('stored');
          yield* fs.writeFileString(path.join(repo, 'src/Value.ts'), 'export const value = 1;\n');
          expect(
            Effect2.pipe((yield* git(repo, ['config', '--get', 'core.ignorecase'])).stdout, EffectString.trim),
          ).toBe(receiverMode);
          expect((yield* git(repo, ['status', '--porcelain'])).stdout).toBe('');
          expect(yield* fs.readFile(artifact)).toEqual(originalBytes);
        }
      }).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
    60_000,
  );
});

function config(home: string) {
  return {
    account: 'local' as const,
    agentContextHome: home,
    agentId: 'threadnote',
    manifestPath: `${home}/seed-manifest.yaml`,
    user: 'local',
  };
}

function git(repo: string, args: readonly string[]) {
  return runCommandEffect('git', ['-C', repo, ...args]);
}
