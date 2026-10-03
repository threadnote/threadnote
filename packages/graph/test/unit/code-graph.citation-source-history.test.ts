import {it as effectIt} from '@effect/vitest';
import {Effect, FileSystem, Path} from 'effect';
import {TestClock} from 'effect/testing';
import {describe, expect} from 'vitest';
import {codeGraphCitationSourceKey, readCodeGraphCitationSources} from '@threadnote/graph/citation/source';
import {runCommandEffect} from '@threadnote/platform/command';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {citationPlatformLayer} from '../helpers/citation-platform.js';

describe('historical citation source hash compatibility', () => {
  effectIt.layer(citationPlatformLayer)(it => {
    it.effect('verifies legacy raw hashes from exact Git blobs and rejects changed or unavailable dirty support', () =>
      TestClock.withLive(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const repository = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-citation-history-'});
          const git = (args: readonly string[]) => runCommandEffect('git', ['-C', repository, ...args]);
          yield* git(['init', '--quiet']);
          yield* git(['config', 'user.name', 'Test']);
          yield* git(['config', 'user.email', 'test@example.invalid']);
          const bytes = new TextEncoder().encode('export const original = true;\n');
          yield* fs.writeFile(path.join(repository, 'source.ts'), bytes);
          yield* git(['add', '.']);
          yield* git(['commit', '--quiet', '-m', 'original']);
          const commit = (yield* git(['rev-parse', 'HEAD'])).stdout.trim();
          yield* fs.writeFileString(path.join(repository, 'source.ts'), 'export const original = false;\n');
          const source = {expectedContentHash: sha256HexSync(bytes), repositoryPath: 'source.ts', requireBytes: true};
          const input = {
            objectFormat: 'sha1' as const,
            repositoryRoot: repository,
            sourceCommit: commit,
            sources: [source, {...source, expectedContentHash: 'f'.repeat(64)}],
          };
          const historical = yield* readCodeGraphCitationSources(input);
          expect(historical.get(codeGraphCitationSourceKey(source))).toEqual(bytes);
          expect(historical.size).toBe(1);
          expect((yield* readCodeGraphCitationSources({...input, allowCommitFallback: false})).size).toBe(0);
          const identityOnly = {...source, requireBytes: false};
          expect(
            (yield* readCodeGraphCitationSources({...input, sources: [identityOnly]})).get(
              codeGraphCitationSourceKey(source),
            ),
          ).toEqual(new Uint8Array());
        }),
      ),
    );
  });
});
