import * as BunRuntime from '@effect/platform-bun/BunRuntime';
import {makeFinalCliOutput} from '@threadnote/threadnote/effect/cli/output';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

const writeDelayedFinalOutput = makeFinalCliOutput(async output => {
  await Bun.sleep(500);
  const stdout = Bun.stdout.writer({highWaterMark: 64 * 1024});
  await stdout.write(`${output}\n`);
  await stdout.flush();
  await stdout.end();
});

const value = Effect.pipe('x', EffectString.repeat(128 * 1024));
void BunRuntime.runMain(writeDelayedFinalOutput(JSON.stringify({value})), {
  disableErrorReporting: true,
  teardown: () => process.exit(0),
});
