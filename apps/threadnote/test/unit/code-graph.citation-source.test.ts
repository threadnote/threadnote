import {Array as EffectArray} from 'effect';
import {it as effectIt} from '@effect/vitest';
import {Effect, FileSystem, Path} from 'effect';
import {describe, expect} from 'vitest';
import {codeGraphCitationSourceKey, readCodeGraphCitationSources} from '@threadnote/graph/citation/source';
import {codeGraphCommittedFileContentHash} from '@threadnote/graph/content_identity';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {CommandExecutor} from '@threadnote/platform/command';
import {StandaloneBrokerLayer} from '@threadnote/threadnote/effect/runtime';
import {provideTestLayer} from '../helpers/effect-layer.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

const encoder = new TextEncoder();

describe('code graph citation source reads', () => {
  effectIt.effect('batches exact commit bytes when a clean/smudge filter changes checkout spelling', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-citation-source-'});
      const repositoryRoot = yield* fs.realPath(root);
      yield* fs.makeDirectory(path.join(root, 'src'), {recursive: true});
      const committed = encoder.encode('export const value = 1;\n');
      const checkout = encoder.encode('export const value = 1;\r\n');
      yield* fs.writeFile(path.join(root, 'src', 'value.ts'), checkout);
      const expectedContentHash = codeGraphCommittedFileContentHash('sha1', committed);
      const blobId = gitBlobId('sha1', committed);
      const sourceCommit = Effect2.pipe('1', EffectString.repeat(40));
      const base = yield* CommandExecutor;
      let gitReads = 0;
      const observed = CommandExecutor.of({
        ...base,
        executeBytes: (executable, args, options) =>
          Effect.sync(() => {
            gitReads += 1;
            expect(executable).toBe('git');
            expect(options?.env?.GIT_NO_LAZY_FETCH).toBe('1');
            if (args.includes('--batch-check')) {
              expect(args).toEqual(['-C', repositoryRoot, 'cat-file', '--batch-check', '-z']);
              expect(options?.input).toEqual(encoder.encode(`${sourceCommit}:src/value.ts\0`));
              return {exitCode: 0, stderr: '', stdout: encoder.encode(`${blobId} blob ${committed.byteLength}\n`)};
            }
            expect(args).toEqual(['-C', repositoryRoot, 'cat-file', '--batch', '-z']);
            expect(options?.input).toEqual(encoder.encode(`${blobId}\0`));
            return {exitCode: 0, stderr: '', stdout: batchBlob(blobId, committed)};
          }),
      });

      const committedSource = {expectedContentHash, repositoryPath: 'src/value.ts', requireBytes: true};
      const committedResult = yield* readCodeGraphCitationSources({
        objectFormat: 'sha1',
        repositoryRoot,
        sourceCommit,
        sources: [committedSource],
      }).pipe(Effect.provideService(CommandExecutor, observed));
      expect(committedResult.get(codeGraphCitationSourceKey(committedSource))).toEqual(committed);
      expect(gitReads).toBe(2);

      const fileOnlySource = {...committedSource, requireBytes: false};
      const fileOnlyResult = yield* readCodeGraphCitationSources({
        objectFormat: 'sha1',
        repositoryRoot,
        sourceCommit,
        sources: [fileOnlySource],
      }).pipe(Effect.provideService(CommandExecutor, observed));
      expect(fileOnlyResult.get(codeGraphCitationSourceKey(fileOnlySource))).toEqual(new Uint8Array());
      expect(gitReads).toBe(3);

      const checkoutSource = {
        expectedContentHash: sha256HexSync(checkout),
        repositoryPath: 'src/value.ts',
        requireBytes: true,
      };
      const checkoutResult = yield* readCodeGraphCitationSources({
        objectFormat: 'sha1',
        repositoryRoot,
        sourceCommit,
        sources: [checkoutSource],
      }).pipe(Effect.provideService(CommandExecutor, observed));
      expect(checkoutResult.get(codeGraphCitationSourceKey(checkoutSource))).toEqual(checkout);
      expect(gitReads).toBe(3);
    }).pipe(provideTestLayer(StandaloneBrokerLayer)),
  );

  effectIt.effect('does not fetch a missing promised blob while validation abstains', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-citation-missing-'});
      const repositoryRoot = yield* fs.realPath(root);
      const sourceCommit = Effect2.pipe('2', EffectString.repeat(40));
      const source = {
        expectedContentHash: codeGraphCommittedFileContentHash('sha1', encoder.encode('missing\n')),
        repositoryPath: 'src/missing.ts',
        requireBytes: true,
      };
      const base = yield* CommandExecutor;
      let gitReads = 0;
      const observed = CommandExecutor.of({
        ...base,
        executeBytes: (_executable, args, options) =>
          Effect.sync(() => {
            gitReads += 1;
            expect(args).toContain('--batch-check');
            expect(options?.env?.GIT_NO_LAZY_FETCH).toBe('1');
            return {
              exitCode: 0,
              stderr: '',
              stdout: encoder.encode(`${sourceCommit}:${source.repositoryPath} missing\n`),
            };
          }),
      });

      const result = yield* readCodeGraphCitationSources({
        objectFormat: 'sha1',
        repositoryRoot,
        sourceCommit,
        sources: [source],
      }).pipe(Effect.provideService(CommandExecutor, observed));
      expect(result.has(codeGraphCitationSourceKey(source))).toBe(false);
      expect(gitReads).toBe(1);
    }).pipe(provideTestLayer(StandaloneBrokerLayer)),
  );

  effectIt.effect('admits long missing-path inspection output within the bounded command budget', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-citation-long-missing-'});
      const repositoryRoot = yield* fs.realPath(root);
      const sourceCommit = Effect2.pipe('4', EffectString.repeat(40));
      const sources = Array.from({length: 32}, (_, index) => ({
        expectedContentHash: Effect2.pipe('a', EffectString.repeat(64)),
        repositoryPath: `src/${Effect2.pipe(String(index), EffectString.padStart(2, '0'))}-${Effect2.pipe('x', EffectString.repeat(2_800))}.ts`,
        requireBytes: false,
      }));
      const stdout = encoder.encode(
        EffectArray.join(
          EffectArray.map(sources, source => `${sourceCommit}:${source.repositoryPath} missing\n`),
          '',
        ),
      );
      const base = yield* CommandExecutor;
      const observed = CommandExecutor.of({
        ...base,
        executeBytes: (_executable, args, options) =>
          Effect.sync(() => {
            expect(args).toContain('--batch-check');
            expect(options?.maxOutputBytes).toBeGreaterThanOrEqual(stdout.byteLength);
            return {exitCode: 0, stderr: '', stdout};
          }),
      });

      const result = yield* readCodeGraphCitationSources({
        objectFormat: 'sha1',
        repositoryRoot,
        sourceCommit,
        sources,
      }).pipe(Effect.provideService(CommandExecutor, observed));
      expect(result.size).toBe(0);
    }).pipe(provideTestLayer(StandaloneBrokerLayer)),
  );

  effectIt.effect('charges exact commit sizes after mismatched worktree reservations are released', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-citation-budget-'});
      const repositoryRoot = yield* fs.realPath(root);
      yield* fs.makeDirectory(path.join(root, 'src'), {recursive: true});
      yield* fs.writeFile(path.join(root, 'src', 'a.ts'), encoder.encode('x'));
      yield* fs.writeFile(path.join(root, 'src', 'b.ts'), encoder.encode('y'));
      const committed = [encoder.encode('abc'), encoder.encode('def')];
      const sourceCommit = Effect2.pipe('3', EffectString.repeat(40));
      const sources = EffectArray.map(committed, (bytes, index) => ({
        expectedContentHash: codeGraphCommittedFileContentHash('sha1', bytes),
        repositoryPath: `src/${index === 0 ? 'a' : 'b'}.ts`,
        requireBytes: true,
      }));
      const blobIds = EffectArray.map(committed, bytes => gitBlobId('sha1', bytes));
      const base = yield* CommandExecutor;
      const observed = CommandExecutor.of({
        ...base,
        executeBytes: (_executable, args, options) =>
          Effect.sync(() => {
            if (args.includes('--batch-check')) {
              expect(options?.input).toEqual(
                encoder.encode(
                  EffectArray.join(
                    EffectArray.map(sources, source => `${sourceCommit}:${source.repositoryPath}\0`),
                    '',
                  ),
                ),
              );
              return {
                exitCode: 0,
                stderr: '',
                stdout: encoder.encode(
                  EffectArray.join(
                    EffectArray.map(blobIds, blobId => `${blobId} blob 3\n`),
                    '',
                  ),
                ),
              };
            }
            expect(args).toContain('--batch');
            expect(options?.input).toEqual(encoder.encode(`${blobIds[0]}\0`));
            return {exitCode: 0, stderr: '', stdout: batchBlob(blobIds[0], committed[0])};
          }),
      });

      const result = yield* readCodeGraphCitationSources({
        objectFormat: 'sha1',
        repositoryRoot,
        retainedBytesLimit: 4,
        sourceCommit,
        sources,
      }).pipe(Effect.provideService(CommandExecutor, observed));
      expect(result.get(codeGraphCitationSourceKey(sources[0]))).toEqual(committed[0]);
      expect(result.has(codeGraphCitationSourceKey(sources[1]))).toBe(false);
    }).pipe(provideTestLayer(StandaloneBrokerLayer)),
  );
});

function gitBlobId(algorithm: 'sha1' | 'sha256', bytes: Uint8Array): string {
  const hasher = new Bun.CryptoHasher(algorithm);
  hasher.update(`blob ${bytes.byteLength}\0`);
  hasher.update(bytes);
  return hasher.digest('hex');
}

function batchBlob(blobId: string, bytes: Uint8Array): Uint8Array {
  const header = encoder.encode(`${blobId} blob ${bytes.byteLength}\n`);
  const output = new Uint8Array(header.byteLength + bytes.byteLength + 1);
  output.set(header);
  output.set(bytes, header.byteLength);
  output[output.byteLength - 1] = 0x0a;
  return output;
}
