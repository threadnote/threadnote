import {it as effectIt} from '@effect/vitest';
import {DateTime, Effect, FileSystem, Path} from 'effect';
import {TestClock} from 'effect/testing';
import {describe, expect} from 'vitest';
import {
  codeGraphWorksetRuntimeConfig,
  indexPreparedCodeGraphWorksetFixture,
  publishIndexedCodeGraphWorksetCatalog,
} from '../../../../scripts/support/code-graph-workset-harness.js';
import {
  prepareCodeGraphWorksetFixture,
  removePreparedCodeGraphWorksetFixture,
} from '../../../../scripts/support/code-graph-workset-fixture.js';
import {CodeGraphStore} from '@threadnote/graph/store';
import type {CodeGraphDatabaseSessionOptions, CodeGraphStoreShape} from '@threadnote/graph/store/shape';
import type * as SqlClient from 'effect/sql/SqlClient';
import {validateContextBriefMemoryCitations} from '@threadnote/context/citation_validation';
import {CommandExecutor, runCommandEffect} from '@threadnote/platform/command';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import {captureMemoryCodeCitations} from '@threadnote/context/citation/capture';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {TestError} from '@threadnote/testing/test-error';

describe('Context Brief published Workset citation validation', () => {
  effectIt.effect(
    'preserves policy-excluded changes and balances the lease when closing-fence races turn evidence stale',
    () =>
      Effect.acquireUseRelease(
        Effect.tryPromise({
          try: () => prepareCodeGraphWorksetFixture({size: 1, stateProfile: 'all-clean'}),
          catch: cause => TestError.make({message: 'Could not prepare the citation Workset fixture.', cause}),
        }),
        fixture =>
          Effect.gen(function* () {
            const repository = fixture.repositories[0];
            if (repository === undefined)
              return yield* TestError.make({message: 'Citation Workset fixture has no repository.'});
            const config = codeGraphWorksetRuntimeConfig(fixture);
            const fs = yield* FileSystem.FileSystem;
            const path = yield* Path.Path;
            const excludedPath = path.join(repository.path, 'assets', 'logo.svg');
            yield* fs.makeDirectory(path.dirname(excludedPath), {recursive: true});
            yield* fs.writeFileString(excludedPath, '<svg/>\n');
            yield* git(repository.path, ['add', 'assets/logo.svg']);
            yield* git(repository.path, [
              '-c',
              'user.name=Threadnote Test',
              '-c',
              'user.email=test@threadnote.local',
              'commit',
              '-qm',
              'add excluded fixture',
            ]);
            yield* indexPreparedCodeGraphWorksetFixture(fixture);
            yield* publishIndexedCodeGraphWorksetCatalog(fixture, [fixture.identity.worksetName]);
            const citations = yield* captureMemoryCodeCitations(config, {
              callerCwd: repository.path,
              refs: ['src/session.ts'],
            });
            expect(citations).toHaveLength(1);
            expect(citations[0]?.target.kind).toBe('file');

            const candidate = {
              citationErrorCount: 0,
              codeCitations: citations,
              excerpt: 'The session resolver owns the published contract.',
              kind: 'durable' as const,
              project: repository.projectName,
              rank: 0,
              topic: 'session-resolver',
              uri: 'threadnote://user/test/memories/durable/projects/workset/session-resolver.md',
            };
            const baseStore = yield* CodeGraphStore;
            let acquired = 0;
            let evidenceReads = 0;
            let released = 0;
            let sessions = 0;
            let activeFenceReads = 0;
            let changedActivationFenceRead: number | undefined;
            let mutateBeforeActiveFence = false;
            let suppressClosingTrace = false;
            const citedPath = path.join(repository.path, 'src', 'session.ts');
            const citedSource = yield* fs.readFileString(citedPath);
            const baseCommand = yield* CommandExecutor;
            const faultableCommand = CommandExecutor.of({
              ...baseCommand,
              execute: (executable, args, options) =>
                baseCommand.execute(executable, args, options).pipe(
                  Effect.map(result => {
                    if (
                      suppressClosingTrace &&
                      executable === 'git' &&
                      args.includes('status') &&
                      options?.env?.GIT_TRACE_SETUP === '1'
                    ) {
                      suppressClosingTrace = false;
                      return {...result, stderr: ''};
                    }
                    return result;
                  }),
                ),
            });
            const countedStore = CodeGraphStore.of({
              ...baseStore,
              acquireSnapshotLease: (...args: Parameters<CodeGraphStoreShape['acquireSnapshotLease']>) =>
                Effect.sync(() => void ++acquired).pipe(Effect.andThen(baseStore.acquireSnapshotLease(...args))),
              effectiveSnapshotCitationEvidence: (
                ...args: Parameters<CodeGraphStoreShape['effectiveSnapshotCitationEvidence']>
              ) =>
                Effect.sync(() => void ++evidenceReads).pipe(
                  Effect.andThen(baseStore.effectiveSnapshotCitationEvidence(...args)),
                ),
              releaseSnapshotLease: (...args: Parameters<CodeGraphStoreShape['releaseSnapshotLease']>) =>
                baseStore.releaseSnapshotLease(...args).pipe(Effect.tap(() => Effect.sync(() => void ++released))),
              loadActiveViewFence: (...args: Parameters<CodeGraphStoreShape['loadActiveViewFence']>) =>
                Effect.gen(function* () {
                  const read = ++activeFenceReads;
                  if (mutateBeforeActiveFence) {
                    mutateBeforeActiveFence = false;
                    yield* Effect.orDie(fs.writeFileString(citedPath, `${citedSource}\n// closing-fence mutation\n`));
                  }
                  const fence = yield* baseStore.loadActiveViewFence(...args);
                  if (fence !== undefined && read === changedActivationFenceRead) {
                    changedActivationFenceRead = undefined;
                    return {
                      ...fence,
                      activatedAt: DateTime.formatIso(DateTime.makeUnsafe(Date.parse(fence.activatedAt) + 1)),
                    };
                  }
                  return fence;
                }),
              withSession: <A, E, R>(
                databasePath: string,
                effect: Effect.Effect<A, E, R | SqlClient.SqlClient>,
                options?: CodeGraphDatabaseSessionOptions,
              ) => {
                expect(options).toMatchObject({existingOnly: true});
                return Effect.sync(() => void ++sessions).pipe(
                  Effect.andThen(baseStore.withSession(databasePath, effect, options)),
                );
              },
            });
            const validate = () =>
              validateContextBriefMemoryCitations(config, {kind: 'workset', name: fixture.identity.worksetName}, [
                candidate,
              ]).pipe(
                Effect.provideService(CodeGraphStore, countedStore),
                Effect.provideService(CommandExecutor, faultableCommand),
              );

            const exact = yield* validate();
            expect(exact[0]?.receipts).toMatchObject([{reason: 'exact', status: 'exact'}]);
            expect({acquired, activeFenceReads, evidenceReads, released, sessions}).toEqual({
              acquired: 1,
              activeFenceReads: 2,
              evidenceReads: 1,
              released: 1,
              sessions: 1,
            });

            suppressClosingTrace = true;
            const fallbackExact = yield* validate();
            expect(fallbackExact[0]?.receipts).toMatchObject([{reason: 'exact', status: 'exact'}]);
            expect({acquired, activeFenceReads, evidenceReads, released, sessions}).toEqual({
              acquired: 2,
              activeFenceReads: 4,
              evidenceReads: 1,
              released: 2,
              sessions: 2,
            });

            yield* fs.writeFileString(excludedPath, '<svg>excluded change</svg>\n');
            const policyClean = yield* validate();
            expect(policyClean[0]?.receipts).toMatchObject([{reason: 'exact', status: 'exact'}]);
            expect({acquired, activeFenceReads, evidenceReads, released, sessions}).toEqual({
              acquired: 3,
              activeFenceReads: 6,
              evidenceReads: 1,
              released: 3,
              sessions: 3,
            });

            yield* fs.writeFileString(excludedPath, '<svg/>\n');
            mutateBeforeActiveFence = true;
            const lateEdit = yield* validate();
            expect(lateEdit[0]?.receipts).toMatchObject([{reason: 'graph-stale', status: 'unknown'}]);
            expect({acquired, activeFenceReads, evidenceReads, released, sessions}).toEqual({
              acquired: 4,
              activeFenceReads: 7,
              evidenceReads: 1,
              released: 4,
              sessions: 4,
            });
            yield* fs.writeFileString(citedPath, citedSource);

            changedActivationFenceRead = activeFenceReads + 2;
            const promoted = yield* validate();
            expect(promoted[0]?.receipts).toMatchObject([{reason: 'graph-stale', status: 'unknown'}]);
            expect({acquired, activeFenceReads, evidenceReads, released, sessions}).toEqual({
              acquired: 5,
              activeFenceReads: 9,
              evidenceReads: 1,
              released: 5,
              sessions: 5,
            });

            yield* git(repository.path, [
              '-c',
              'user.name=Threadnote Test',
              '-c',
              'user.email=test@threadnote.local',
              'commit',
              '--allow-empty',
              '-qm',
              'move published head',
            ]);

            const stale = yield* validate();
            expect(stale[0]?.receipts).toMatchObject([{reason: 'graph-stale', status: 'unknown'}]);
            expect({acquired, activeFenceReads, evidenceReads, released, sessions}).toEqual({
              acquired: 6,
              activeFenceReads: 10,
              evidenceReads: 1,
              released: 6,
              sessions: 6,
            });
          }),
        fixture =>
          Effect.tryPromise({
            try: () => removePreparedCodeGraphWorksetFixture(fixture),
            catch: cause => TestError.make({message: 'Could not remove the citation Workset fixture.', cause}),
          }),
      ).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
    {timeout: 120_000},
  );
});

const git = Effect.fn('contextBriefCitationWorksetTest.git')((cwd: string, args: readonly string[]) =>
  runCommandEffect('git', ['-C', cwd, ...args], {maxOutputBytes: 1_048_576, timeoutMs: 30_000}),
);
