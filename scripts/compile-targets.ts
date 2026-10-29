import {Array as EffectArray} from 'effect';
import {provideScriptLayer, ScriptError} from './effect/errors.js';
import * as BunRuntime from '@effect/platform-bun/BunRuntime';
import * as BunServices from '@effect/platform-bun/BunServices';
import {Console, Effect, FileSystem, Path} from 'effect';
import {BUN_STANDALONE_TARGETS} from './release-targets.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

const ROOT_URL = new URL('..', import.meta.url);

const compileTargets = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* path.fromFileUrl(ROOT_URL);
  const manifest = yield* fs.readFileString(path.join(root, 'package.json')).pipe(
    Effect.flatMap(content =>
      Effect.try({
        try: (): unknown => JSON.parse(content),
        catch: cause => ScriptError.make({message: 'Could not parse package.json.', cause}),
      }),
    ),
  );
  if (
    typeof manifest !== 'object' ||
    manifest === null ||
    !('version' in manifest) ||
    typeof manifest.version !== 'string' ||
    manifest.version.length === 0
  ) {
    return yield* ScriptError.make({message: 'package.json must declare a version.'});
  }

  const configuredTarget = Effect2.pipe(Bun.env.THREADNOTE_BUILD_TARGET, effectOptionalString =>
    effectOptionalString == null ? undefined : Effect2.pipe(effectOptionalString, EffectString.trim),
  );
  const targets = configuredTarget
    ? EffectArray.filter(
        BUN_STANDALONE_TARGETS,
        (target, index) => index in BUN_STANDALONE_TARGETS && target === configuredTarget,
      )
    : BUN_STANDALONE_TARGETS;
  if (targets.length === 0) {
    return yield* ScriptError.make({message: `${configuredTarget} is not a supported standalone target.`});
  }

  const outputRoot = path.join(root, '.target-builds');
  yield* fs.remove(outputRoot, {force: true, recursive: true});
  yield* fs.makeDirectory(outputRoot, {recursive: true});

  for (const target of targets) {
    const targetRoot = path.join(outputRoot, target);
    yield* fs.makeDirectory(targetRoot, {recursive: true});
    const result = yield* Effect.tryPromise({
      try: () =>
        Bun.build({
          bytecode: true,
          compile: {
            autoloadBunfig: false,
            autoloadDotenv: false,
            autoloadPackageJson: false,
            autoloadTsconfig: false,
            outfile: path.join(
              targetRoot,
              Effect2.pipe(target, EffectString.includes('windows')) ? 'threadnote.exe' : 'threadnote',
            ),
            target,
          },
          define: {
            'process.env.MSGPACKR_NATIVE_ACCELERATION_DISABLED': JSON.stringify('true'),
            THREADNOTE_STANDALONE: 'true',
            THREADNOTE_VERSION: JSON.stringify(manifest.version),
          },
          entrypoints: [path.join(root, 'apps', 'threadnote', 'src', 'standalone.ts')],
          format: 'esm',
          minify: true,
          sourcemap: 'linked',
          target: 'bun',
        }),
      catch: cause => ScriptError.make({message: `Bun could not compile ${target}.`, cause}),
    });
    if (!result.success) {
      return yield* ScriptError.make({
        message: `${target}: ${EffectArray.join(
          EffectArray.filter(
            EffectArray.map(result.logs, log => log.message),
            Boolean,
          ),
          '\n',
        )}`,
      });
    }
    yield* Console.log(`Compiled standalone Threadnote for ${target}`);
  }
});

BunRuntime.runMain(provideScriptLayer(compileTargets, BunServices.layer));
