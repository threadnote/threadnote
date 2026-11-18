import * as BunRuntime from '@effect/platform-bun/BunRuntime';
import * as BunServices from '@effect/platform-bun/BunServices';
import {Effect} from 'effect';
import {generateDocsArticlePages} from '@threadnote/website/site-doc-pages';
import {generateWebsitePostPages} from '@threadnote/website/site-articles';
import {loadPreparedWebsiteMetadataFromEnvironment} from '@threadnote/website/site-prepared-metadata';

const output = process.argv[2];
if (!output) throw new Error('Expected declared output directory');
const program = Effect.gen(function* () {
  const metadata = yield* Effect.promise(() => loadPreparedWebsiteMetadataFromEnvironment('/'));
  if (!metadata) throw new Error('Bazel website build requires prepared metadata');
  yield* Effect.sync(() => {
    const result = Bun.spawnSync(
      [
        process.execPath,
        '--bun',
        'node_modules/vite/bin/vite.js',
        'build',
        '--config',
        'apps/website/vite.config.ts',
        '--outDir',
        output,
      ],
      {stdout: 'inherit', stderr: 'inherit'},
    );
    if (result.exitCode !== 0) throw new Error(`Vite exited with ${result.exitCode}`);
  });
  yield* generateDocsArticlePages(output);
  yield* generateWebsitePostPages(output, metadata);
});
// oxlint-disable-next-line effecttsgo/strict-effect-provide -- This is the sandboxed website build entry point.
BunRuntime.runMain(program.pipe(Effect.provide(BunServices.layer)));
