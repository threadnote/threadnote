import {Array as EffectArray, Option as EffectOption} from 'effect';
import {it as effectIt} from '@effect/vitest';
import {Effect, Exit, FileSystem, Path, PlatformError} from 'effect';
import {describe, expect} from 'vitest';
import type {CodeMemoryLinkAgentLedgerLayout} from '@threadnote/threadnote/evaluation/code-memory-link-agent-attempts';
import {
  CODE_MEMORY_LINK_AGENT_LEDGER_DURABILITY_STEPS,
  durablyRemoveCodeMemoryLinkAgentLedger,
  durablyReplaceCodeMemoryLinkAgentLedger,
  persistCodeMemoryLinkAgentAttemptStartDurably,
  projectCodeMemoryLinkAgentPendingCommitDurably,
  type CodeMemoryLinkAgentLedgerDurabilityStep,
} from '@threadnote/threadnote/evaluation/code-memory-link-agent-ledger-durability';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {TestError} from '@threadnote/testing/test-error';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

describe('Code Memory Link agent ledger durability', () => {
  effectIt.effect('syncs file data before rename and the parent after rename and unlink', () =>
    Effect.gen(function* () {
      const calls: string[] = [];
      const fs = FileSystem.makeNoop({
        makeDirectory: (target: string) => Effect.sync(() => calls.push(`mkdir:${target}`)),
        open: (target, options) =>
          Effect.succeed(
            fileHandle(Effect.asVoid(Effect.sync(() => calls.push(`sync:${options?.flag ?? ''}:${target}`)))),
          ),
        remove: (target: string) => Effect.sync(() => calls.push(`remove:${target}`)),
        rename: (from: string, to: string) => Effect.sync(() => calls.push(`rename:${from}:${to}`)),
        writeFileString: (target: string) => Effect.sync(() => calls.push(`write:${target}`)),
      });
      const target = '/reviewed/evidence/trials.jsonl';

      yield* durablyReplaceCodeMemoryLinkAgentLedger(target, 'trial\n').pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
      );
      const writeIndex = EffectOption.getOrElse(
        EffectArray.findFirstIndex(calls, call => Effect2.pipe(call, EffectString.startsWith('write:'))),
        () => -1,
      );
      const fileSyncIndex = EffectOption.getOrElse(
        EffectArray.findFirstIndex(calls, call => Effect2.pipe(call, EffectString.startsWith('sync:r+:'))),
        () => -1,
      );
      const renameIndex = EffectOption.getOrElse(
        EffectArray.findFirstIndex(calls, call => Effect2.pipe(call, EffectString.startsWith('rename:'))),
        () => -1,
      );
      const directorySyncIndex = EffectOption.getOrElse(
        EffectArray.findFirstIndex(calls, call => call === 'sync:r:/reviewed/evidence'),
        () => -1,
      );
      expect(writeIndex).toBeGreaterThanOrEqual(0);
      expect(fileSyncIndex).toBeGreaterThan(writeIndex);
      expect(renameIndex).toBeGreaterThan(fileSyncIndex);
      expect(directorySyncIndex).toBeGreaterThan(renameIndex);

      calls.length = 0;
      yield* durablyRemoveCodeMemoryLinkAgentLedger(target).pipe(Effect.provideService(FileSystem.FileSystem, fs));
      expect(calls).toEqual(['remove:/reviewed/evidence/trials.jsonl', 'sync:r:/reviewed/evidence']);
    }).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('does not begin external execution after a crash at the durable attempt-start boundary', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-agent-attempt-durable-'});
        const attemptsPath = path.join(root, 'trials.jsonl.attempts.jsonl');
        let executed = false;
        const exit = yield* persistCodeMemoryLinkAgentAttemptStartDurably(attemptsPath, 'started\n', {
          afterStep: () => Effect.fail(TestError.make({message: 'simulated host crash'})),
        }).pipe(Effect.andThen(Effect.sync(() => (executed = true))), Effect.exit);

        expect(Exit.isFailure(exit)).toBe(true);
        expect(executed).toBe(false);
        expect(yield* fs.readFileString(attemptsPath)).toBe('started\n');
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('fails closed when the host cannot sync the ledger directory', () =>
    Effect.gen(function* () {
      const fs = FileSystem.makeNoop({
        makeDirectory: () => Effect.void,
        open: (target, options) =>
          options?.flag === 'r'
            ? Effect.fail(
                PlatformError.systemError({
                  _tag: 'Unknown',
                  module: 'FileSystem',
                  method: 'open',
                  description: 'directory sync unsupported',
                  pathOrDescriptor: target,
                }),
              )
            : Effect.succeed(fileHandle(Effect.void)),
        remove: () => Effect.void,
        rename: () => Effect.void,
        writeFileString: () => Effect.void,
      });

      const exit = yield* durablyReplaceCodeMemoryLinkAgentLedger('/reviewed/evidence/trials.jsonl', 'trial\n').pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.exit,
      );
      expect(Exit.isFailure(exit)).toBe(true);
    }).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('recovers every fully durable pending-commit kill point without rerunning execution', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        for (const step of EffectArray.filter(
          CODE_MEMORY_LINK_AGENT_LEDGER_DURABILITY_STEPS,
          candidate => candidate !== 'attempt-start-durable',
        )) {
          const root = yield* fs.makeTempDirectoryScoped({prefix: `threadnote-agent-ledger-${step}-`});
          const layout = ledgerLayout(path, root);
          yield* fs.writeFileString(layout.evidencePath, 'old-evidence\n');
          yield* fs.writeFileString(layout.trialsPath, 'old-trial\n');
          const exit = yield* projectCodeMemoryLinkAgentPendingCommitDurably(
            layout,
            {
              evidenceSource: 'new-evidence\n',
              pendingSource: 'pending\n',
              trialsSource: 'new-trial\n',
            },
            {afterStep: observed => failAt(observed, step)},
          ).pipe(Effect.exit);
          expect(Exit.isFailure(exit), step).toBe(true);

          const pendingExists = yield* fs.exists(layout.pendingPath);
          if (step === 'pending-removal-durable') {
            expect(pendingExists, step).toBe(false);
          } else {
            expect(pendingExists, step).toBe(true);
            yield* projectCodeMemoryLinkAgentPendingCommitDurably(layout, {
              evidenceSource:
                (yield* fs.readFileString(layout.evidencePath)) === 'new-evidence\n' ? undefined : 'new-evidence\n',
              trialsSource: (yield* fs.readFileString(layout.trialsPath)) === 'new-trial\n' ? undefined : 'new-trial\n',
            });
          }
          expect(yield* fs.readFileString(layout.evidencePath), step).toBe('new-evidence\n');
          expect(yield* fs.readFileString(layout.trialsPath), step).toBe('new-trial\n');
          expect(yield* fs.exists(layout.pendingPath), step).toBe(false);
        }
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );
});

function failAt(observed: CodeMemoryLinkAgentLedgerDurabilityStep, target: CodeMemoryLinkAgentLedgerDurabilityStep) {
  return observed === target
    ? Effect.fail(TestError.make({message: `simulated host crash after ${target}`}))
    : Effect.void;
}

function ledgerLayout(path: Path.Path, root: string): CodeMemoryLinkAgentLedgerLayout {
  const trialsPath = path.join(root, 'trials.jsonl');
  return {
    attemptsPath: `${trialsPath}.attempts.jsonl`,
    evidencePath: `${trialsPath}.evidence.jsonl`,
    lockPath: `${trialsPath}.lock`,
    pendingPath: `${trialsPath}.pending.json`,
    trialsPath,
  };
}

function fileHandle(sync: Effect.Effect<void, PlatformError.PlatformError>): FileSystem.File {
  return {
    [FileSystem.FileTypeId]: FileSystem.FileTypeId,
    stat: Effect.die('file metadata is unused in this test'),
    seek: () => Effect.die('file seeking is unused in this test'),
    sync,
    read: () => Effect.die('file reads are unused in this test'),
    readAlloc: () => Effect.die('file reads are unused in this test'),
    truncate: () => Effect.die('file truncation is unused in this test'),
    write: () => Effect.die('file writes are unused in this test'),
    writeAll: () => Effect.die('file writes are unused in this test'),
  };
}
