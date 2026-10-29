import * as BunRuntime from '@effect/platform-bun/BunRuntime';
import {Effect, FileSystem, Path} from 'effect';
import {
  resolveCodeMemoryLinkAgentLedgerLayout,
  withCodeMemoryLinkAgentLedgerLock,
} from '@threadnote/threadnote/evaluation/code-memory-link-agent-attempts';
import {SystemInfo} from '@threadnote/platform/system';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import {provideScriptLayer, ScriptError} from '../../../../scripts/effect/errors.js';
import {atomicWrite, scriptArguments} from '../../../../scripts/effect/script.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

const program = Effect.gen(function* () {
  const [root] = yield* scriptArguments();
  if (!root) return yield* ScriptError.make({message: 'Ledger-lock child requires a fixture root.'});
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const system = yield* SystemInfo;
  const trialsPath = path.join(root, 'trials.jsonl');
  const attemptsPath = `${trialsPath}.attempts.jsonl`;
  const evidencePath = `${trialsPath}.evidence.jsonl`;
  const layout = yield* resolveCodeMemoryLinkAgentLedgerLayout(trialsPath, attemptsPath, evidencePath);
  yield* withCodeMemoryLinkAgentLedgerLock(
    layout,
    10_000,
    Effect.gen(function* () {
      const current = (yield* fs.exists(layout.trialsPath)) ? yield* fs.readFileString(layout.trialsPath) : '';
      if (Effect2.pipe(current, EffectString.trim)) return;
      const executions = path.join(root, 'external-executions');
      yield* fs.makeDirectory(executions, {recursive: true, mode: 0o700});
      yield* fs.writeFileString(path.join(executions, `${system.processId}.marker`), 'executed\n', {
        flag: 'wx',
        mode: 0o600,
      });
      yield* Effect.sleep(500);
      yield* atomicWrite(layout.trialsPath, `${system.processId}\n`);
    }),
  );
});

BunRuntime.runMain(provideScriptLayer(program, ApplicationLayer));
