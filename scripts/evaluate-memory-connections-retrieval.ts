#!/usr/bin/env bun
import {Array as EffectArray} from 'effect';

import * as BunRuntime from '@effect/platform-bun/BunRuntime';
import {Console, Effect} from 'effect';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import {runMemoryConnectionsRetrievalBench} from '@threadnote/threadnote/evaluation/memory-connections-retrieval-bench';
import {provideScriptLayer, ScriptError} from './effect/errors.js';

const program = Effect.gen(function* () {
  const result = yield* runMemoryConnectionsRetrievalBench();
  yield* Console.log(JSON.stringify(result, undefined, 2));
  if (!result.gate.passed) return yield* ScriptError.make({message: EffectArray.join(result.gate.failures, '\n')});
});

if (import.meta.main) BunRuntime.runMain(provideScriptLayer(program, ApplicationLayer));
