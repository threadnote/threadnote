import {Effect, Path} from 'effect';
import * as EffectArray from 'effect/Array';
import * as ChildProcess from 'effect/process/ChildProcess';
import * as BunServices from '@effect/platform-bun/BunServices';
import * as BunRuntime from '@effect/platform-bun/BunRuntime';
import {ScriptError} from '../../scripts/effect/errors.js';

/** Keep the public development command stable; compiler composition belongs to the application. */
const program = Effect.scoped(
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const root = path.resolve(import.meta.dir, '../..');
    const child = yield* ChildProcess.make(
      process.execPath,
      [
        path.join(root, 'apps/threadnote/tools/semantic/build-java-diagnostics.ts'),
        ...EffectArray.drop(process.argv, 2),
      ],
      {
        cwd: root,
        extendEnv: true,
        stdin: 'ignore',
        stdout: 'inherit',
        stderr: 'inherit',
        killSignal: 'SIGINT',
        forceKillAfter: 5000,
      },
    );
    const code = Number(yield* child.exitCode);
    if (code !== 0) return yield* ScriptError.make({message: 'Java diagnostic build exited with code ' + code});
  }),
).pipe(Effect.timeout(120000));

// oxlint-disable-next-line effecttsgo/strict-effect-provide -- This development command is an application entry point.
if (import.meta.main) BunRuntime.runMain(program.pipe(Effect.provide(BunServices.layer)));
