import * as BunServices from '@effect/platform-bun/BunServices';
import {it as effectIt} from '@effect/vitest';
import {Clock, DateTime, Effect, FileSystem, Layer, Path, PlatformError, Schema} from 'effect';
import {TestClock} from 'effect/testing';
import {describe, expect} from 'vitest';
import {ResourceStore} from '@threadnote/store/resource-store';
import {ResourceRecallInvalidation} from '@threadnote/store/resource/recall-invalidation';
import {ChildEnvironmentPolicy} from '@threadnote/platform/child-environment-policy';
import {RuntimeEntrypoint} from '@threadnote/platform/runtime-entrypoint';
import {SystemInfo} from '@threadnote/platform/system';
import {makeSourceConfigurationRegistry, sourceConfigurationStoreLayer} from '@threadnote/integration-runtime/config';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {
  captureObsidianEvidence,
  inspectObsidianNote,
  obsidianSourceWork,
  readObsidianEvidence,
  recoverObsidianEvidenceCapture,
  runObsidianSourceAdd,
  runObsidianSourceRemove,
  runObsidianSourceSync,
} from '../src/source.js';
import {obsidianSourceCodec} from '../src/config.js';

const base = Layer.mergeAll(
  BunServices.layer,
  SystemInfo.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(RuntimeEntrypoint, {developmentEntrypoint: 'obsidian_evidence.test.ts'}),
        Layer.succeed(ChildEnvironmentPolicy, {
          preserveIntendedChild: value => ({...value}),
          sanitizeExternal: value => ({...value}),
        }),
      ),
    ),
  ),
  Layer.succeed(ResourceRecallInvalidation, {expire: () => Effect.void}),
);
const services = Layer.merge(
  base,
  sourceConfigurationStoreLayer(
    makeSourceConfigurationRegistry({sources: [obsidianSourceCodec], projections: []}),
  ).pipe(Layer.provide(base)),
);
const layer = Layer.merge(services, ResourceStore.layer.pipe(Layer.provide(services)));
const provide = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.scoped(Layer.build(layer).pipe(Effect.flatMap(context => effect.pipe(Effect.provide(context)))));

const reservedFixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-reserved-evidence-'});
  const home = path.join(root, 'home');
  const vault = path.join(root, 'vault');
  const note = path.join(vault, 'Decision.md');
  const config: RuntimeConfig = {
    account: 'local',
    agentContextHome: home,
    agentId: 'threadnote',
    manifestPath: path.join(home, 'manifest.yaml'),
    user: 'tester',
  };
  yield* fs.makeDirectory(vault, {recursive: true});
  yield* fs.writeFileString(note, 'signal signal');
  yield* runObsidianSourceAdd(config, {apply: true, id: 'notes', include: ['**/*.md'], vault});
  yield* runObsidianSourceSync(config, {apply: true, id: 'notes'});
  const reviewed = yield* inspectObsidianNote(config, 'notes', 'Decision.md');
  const now = yield* Clock.currentTimeMillis;
  const input = {
    sourceId: 'notes',
    relativePath: 'Decision.md',
    fragment: 'signal',
    retentionDays: 1,
    expectedSourceInstanceId: reviewed.sourceInstanceId,
    expectedNoteId: reviewed.noteId,
    expectedRevisionHash: reviewed.revisionHash,
    expectedSanitizerVersion: reviewed.sanitizerVersion,
    reservation: {
      version: 1 as const,
      operationId: '11111111-1111-4111-8111-111111111111',
      pinId: '22222222-2222-4222-8222-222222222222',
      capturedAt: DateTime.formatIso(DateTime.makeUnsafe(now)),
      expiresAt: DateTime.formatIso(DateTime.makeUnsafe(now + 86_400_000)),
      accessHash: reviewed.accessHash,
      vaultHash: reviewed.vaultHash,
      fragmentStart: 7,
      fragmentEnd: 13,
    },
  };
  const dir = path.join(home, 'threadnote', 'sources', 'obsidian', 'notes', 'evidence');
  return {fs, path, config, vault, note, reviewed, input, dir};
});

describe('cited Obsidian evidence', () => {
  effectIt.effect('preserves renamed identity and access checks while a checkpoint retains its missing old path', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-evidence-rename-access-'});
      const home = path.join(root, 'home');
      const vault = path.join(root, 'vault');
      const note = path.join(vault, 'Decision.md');
      const config: RuntimeConfig = {
        account: 'local',
        agentContextHome: home,
        agentId: 'threadnote',
        manifestPath: path.join(home, 'manifest.yaml'),
        user: 'tester',
      };
      yield* fs.makeDirectory(vault, {recursive: true});
      yield* fs.writeFileString(note, 'A reviewed fact.');
      yield* runObsidianSourceAdd(config, {apply: true, id: 'notes', include: ['**/*.md'], vault});
      yield* runObsidianSourceSync(config, {apply: true, id: 'notes'});
      const reviewed = yield* inspectObsidianNote(config, 'notes', 'Decision.md');
      const citation = yield* captureObsidianEvidence(config, {
        sourceId: 'notes',
        relativePath: 'Decision.md',
        fragment: 'reviewed',
        expectedSourceInstanceId: reviewed.sourceInstanceId,
        expectedNoteId: reviewed.noteId,
        expectedRevisionHash: reviewed.revisionHash,
        expectedSanitizerVersion: reviewed.sanitizerVersion,
      });
      yield* fs.makeDirectory(path.join(vault, 'Folder', 'Nested'), {recursive: true});
      yield* fs.rename(note, path.join(vault, 'Folder', 'Renamed.md'));
      const options = {mode: 'automatic', requestId: 'rename-access', credentialEnvironment: {}} as const;
      expect((yield* obsidianSourceWork.run(config, 'notes', options)).more).toBe(true);
      expect((yield* obsidianSourceWork.run(config, 'notes', options)).more).toBe(true);
      const state = JSON.parse(
        yield* fs.readFileString(path.join(home, 'threadnote', 'sources', 'obsidian', 'notes', 'state-v1.json')),
      ) as {files: Record<string, {noteId: string}>};
      expect(
        Object.entries(state.files)
          .filter(([, file]) => file.noteId === citation.noteId)
          .map(([name]) => name),
      ).toEqual(['Decision.md', 'Folder/Renamed.md']);
      expect((yield* readObsidianEvidence(config, citation)).historical).toBe('available');
      const renamed = path.join(yield* fs.realPath(vault), 'Folder', 'Renamed.md');
      const guarded = FileSystem.FileSystem.of({
        ...fs,
        access: (target, options) =>
          target === renamed
            ? Effect.fail(
                PlatformError.systemError({
                  _tag: 'PermissionDenied',
                  module: 'FileSystem',
                  method: 'access',
                  pathOrDescriptor: target,
                }),
              )
            : fs.access(target, options),
      });
      const denied = yield* readObsidianEvidence(config, citation).pipe(
        Effect.provideService(FileSystem.FileSystem, guarded),
      );
      expect(denied.historical).toBe('revoked');
      expect(denied.currentRevision).toBe('unknown');
      expect(denied.fragment).toBeUndefined();
      yield* runObsidianSourceSync(config, {apply: true, id: 'notes'});
      const reconciled = yield* inspectObsidianNote(config, 'notes', 'Folder/Renamed.md');
      expect(reconciled.noteId).toBe(citation.noteId);
      const afterReconciliation = yield* readObsidianEvidence(config, citation).pipe(
        Effect.provideService(FileSystem.FileSystem, guarded),
      );
      expect(afterReconciliation.historical).toBe('revoked');
      expect(afterReconciliation.fragment).toBeUndefined();
    }).pipe(provide),
  );

  effectIt.effect('revokes historical content when vault, nested directory, or cited file access is denied', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-evidence-access-'});
      const home = path.join(root, 'home');
      const vault = path.join(root, 'vault');
      const folder = path.join(vault, 'Folder');
      const note = path.join(folder, 'Decision.md');
      const config: RuntimeConfig = {
        account: 'local',
        agentContextHome: home,
        agentId: 'threadnote',
        manifestPath: path.join(home, 'manifest.yaml'),
        user: 'tester',
      };
      yield* fs.makeDirectory(folder, {recursive: true});
      yield* fs.writeFileString(note, 'A reviewed fact.');
      yield* runObsidianSourceAdd(config, {apply: true, id: 'notes', include: ['**/*.md'], vault});
      yield* runObsidianSourceSync(config, {apply: true, id: 'notes'});
      const reviewed = yield* inspectObsidianNote(config, 'notes', 'Folder/Decision.md');
      const citation = yield* captureObsidianEvidence(config, {
        sourceId: 'notes',
        relativePath: 'Folder/Decision.md',
        fragment: 'reviewed',
        expectedSourceInstanceId: reviewed.sourceInstanceId,
        expectedNoteId: reviewed.noteId,
        expectedRevisionHash: reviewed.revisionHash,
        expectedSanitizerVersion: reviewed.sanitizerVersion,
      });
      const canonicalVault = yield* fs.realPath(vault);
      for (const [denied, method] of [
        [canonicalVault, 'readDirectory'],
        [canonicalVault, 'stat'],
        [path.join(canonicalVault, 'Folder'), 'readDirectory'],
        [path.join(canonicalVault, 'Folder'), 'stat'],
        [path.join(canonicalVault, 'Folder', 'Decision.md'), 'access'],
      ] as const) {
        const guarded = FileSystem.FileSystem.of({
          ...fs,
          readDirectory: target =>
            target === denied && method === 'readDirectory'
              ? Effect.fail(
                  PlatformError.systemError({
                    _tag: 'PermissionDenied',
                    module: 'FileSystem',
                    method: 'readDirectory',
                    pathOrDescriptor: target,
                  }),
                )
              : fs.readDirectory(target),
          stat: target =>
            target === `${denied}/.` && method === 'stat'
              ? Effect.fail(
                  PlatformError.systemError({
                    _tag: 'PermissionDenied',
                    module: 'FileSystem',
                    method: 'stat',
                    pathOrDescriptor: target,
                  }),
                )
              : fs.stat(target),
          access: (target, options) =>
            target === denied && method === 'access'
              ? Effect.fail(
                  PlatformError.systemError({
                    _tag: 'PermissionDenied',
                    module: 'FileSystem',
                    method: 'access',
                    pathOrDescriptor: target,
                  }),
                )
              : fs.access(target, options),
        });
        const result = yield* readObsidianEvidence(config, citation).pipe(
          Effect.provideService(FileSystem.FileSystem, guarded),
        );
        expect(result.historical, `${method} on ${denied}`).toBe('revoked');
        expect(result.fragment).toBeUndefined();
      }
      const canonicalNote = path.join(canonicalVault, 'Folder', 'Decision.md');
      const noRawRead = FileSystem.FileSystem.of({
        ...fs,
        readFileString: target =>
          target === canonicalNote
            ? Effect.die(new Error('Raw live note read is forbidden'))
            : fs.readFileString(target),
      });
      yield* fs.truncate(note, 16 * 1_024 * 1_024);
      const oversized = yield* readObsidianEvidence(config, citation).pipe(
        Effect.provideService(FileSystem.FileSystem, noRawRead),
      );
      expect(oversized.historical).toBe('available');
      expect(oversized.currentRevision).toBe('unknown');

      yield* fs.remove(note);
      yield* fs.makeDirectory(note);
      const directory = yield* readObsidianEvidence(config, citation).pipe(
        Effect.provideService(FileSystem.FileSystem, noRawRead),
      );
      expect(directory.historical).toBe('revoked');
      expect(directory.fragment).toBeUndefined();
      yield* fs.remove(note, {recursive: true});
      yield* fs.writeFileString(note, 'A reviewed fact.');
      const fifo = FileSystem.FileSystem.of({
        ...noRawRead,
        stat: target =>
          target === canonicalNote
            ? fs.stat(target).pipe(Effect.map(info => ({...info, type: 'FIFO' as const})))
            : fs.stat(target),
      });
      const nonRegular = yield* readObsidianEvidence(config, citation).pipe(
        Effect.provideService(FileSystem.FileSystem, fifo),
      );
      expect(nonRegular.historical).toBe('revoked');
      expect(nonRegular.fragment).toBeUndefined();

      const outside = path.join(home, 'outside.md');
      yield* fs.writeFileString(outside, 'Outside the configured vault.');
      yield* fs.remove(note);
      yield* fs.symlink(outside, note);
      const linked = yield* readObsidianEvidence(config, citation).pipe(
        Effect.provideService(FileSystem.FileSystem, noRawRead),
      );
      expect(linked.historical).toBe('revoked');
      expect(linked.fragment).toBeUndefined();
      yield* fs.remove(note);
      const removed = yield* readObsidianEvidence(config, citation);
      expect(removed.historical).toBe('available');
      expect(removed.currentRevision).toBe('removed');
      yield* fs.remove(folder, {recursive: true});
      expect((yield* readObsidianEvidence(config, citation)).historical).toBe('available');
    }).pipe(provide),
  );

  effectIt.effect.prop(
    'resolves the same sanitized fragment byte-for-byte after edit and deletion (property)',
    {
      chars: Schema.Array(Schema.Literals(['a', 'β', '🙂', '\n', ' '])).check(
        Schema.isMinLength(1),
        Schema.isMaxLength(12),
      ),
    },
    ({chars}) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-evidence-property-'});
        const home = path.join(root, 'home');
        const vault = path.join(root, 'vault');
        const note = path.join(vault, 'Decision.md');
        const config: RuntimeConfig = {
          account: 'local',
          agentContextHome: home,
          agentId: 'threadnote',
          manifestPath: path.join(home, 'manifest.yaml'),
          user: 'tester',
        };
        const fragment = `signal:${chars.join('')}`;
        yield* fs.makeDirectory(vault, {recursive: true});
        yield* fs.writeFileString(note, `# Decision\n\n${fragment}\n`);
        yield* runObsidianSourceAdd(config, {apply: true, id: 'notes', include: ['**/*.md'], vault});
        yield* runObsidianSourceSync(config, {apply: true, id: 'notes'});
        const reviewed = yield* inspectObsidianNote(config, 'notes', 'Decision.md');
        const citation = yield* captureObsidianEvidence(config, {
          sourceId: 'notes',
          relativePath: 'Decision.md',
          fragment,
          expectedSourceInstanceId: reviewed.sourceInstanceId,
          expectedNoteId: reviewed.noteId,
          expectedRevisionHash: reviewed.revisionHash,
          expectedSanitizerVersion: reviewed.sanitizerVersion,
        });
        yield* fs.writeFileString(note, '# Revised\n\nDifferent content.');
        const edited = yield* readObsidianEvidence(config, citation);
        expect(edited.historical).toBe('available');
        expect(edited.fragment).toBe(fragment);
        expect(edited.currentRevision).toBe('changed');
        yield* fs.remove(note);
        const deleted = yield* readObsidianEvidence(config, citation);
        expect(deleted.historical).toBe('available');
        expect(deleted.fragment).toBe(fragment);
        expect(deleted.currentRevision).toBe('removed');
      }).pipe(provide),
    {arbitrary: {runs: 20}},
  );

  effectIt.effect(
    'pins the exact sanitized revision through unsynced edits, sync, rename, path reuse and deletion',
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-evidence-'});
        const home = path.join(root, 'home');
        const vault = path.join(root, 'vault');
        const note = path.join(vault, 'Decision.md');
        const renamed = path.join(vault, 'Renamed.md');
        const config: RuntimeConfig = {
          account: 'local',
          agentContextHome: home,
          agentId: 'threadnote',
          manifestPath: path.join(home, 'manifest.yaml'),
          user: 'tester',
        };
        yield* fs.makeDirectory(vault, {recursive: true});
        yield* fs.writeFileString(note, '# Decision\n\nUse local evidence.');
        yield* runObsidianSourceAdd(config, {apply: true, id: 'notes', include: ['**/*.md'], vault});
        yield* runObsidianSourceSync(config, {apply: true, id: 'notes'});
        const reviewed = yield* inspectObsidianNote(config, 'notes', 'Decision.md');
        expect(
          (yield* Effect.result(
            captureObsidianEvidence(config, {
              sourceId: 'notes',
              relativePath: 'Decision.md',
              fragment: 'Use local evidence.',
              expectedSourceInstanceId: reviewed.sourceInstanceId,
              expectedNoteId: reviewed.noteId,
              expectedRevisionHash: reviewed.revisionHash,
              expectedSanitizerVersion: 'older-scrubber',
            }),
          ))._tag,
        ).toBe('Failure');
        const citation = yield* captureObsidianEvidence(config, {
          sourceId: 'notes',
          relativePath: 'Decision.md',
          fragment: 'Use local evidence.',
          expectedSourceInstanceId: reviewed.sourceInstanceId,
          expectedNoteId: reviewed.noteId,
          expectedRevisionHash: reviewed.revisionHash,
          expectedSanitizerVersion: reviewed.sanitizerVersion,
        });
        const first = yield* readObsidianEvidence(config, citation);
        expect(first.historical).toBe('available');
        expect(first.fragment).toBe('Use local evidence.');
        expect(first.currentRevision).toBe('same');

        yield* fs.writeFileString(note, '# Decision\n\nUse revised evidence.');
        expect((yield* readObsidianEvidence(config, citation)).currentRevision).toBe('changed');
        yield* runObsidianSourceSync(config, {apply: true, id: 'notes'});
        expect((yield* readObsidianEvidence(config, citation)).fragment).toBe('Use local evidence.');
        yield* fs.rename(note, renamed);
        expect((yield* readObsidianEvidence(config, citation)).currentRevision).toBe('changed');
        yield* runObsidianSourceSync(config, {apply: true, id: 'notes'});
        const renamedReview = yield* inspectObsidianNote(config, 'notes', 'Renamed.md');
        const renamedCitation = yield* captureObsidianEvidence(config, {
          sourceId: 'notes',
          relativePath: 'Renamed.md',
          fragment: 'Use revised evidence.',
          expectedSourceInstanceId: renamedReview.sourceInstanceId,
          expectedNoteId: renamedReview.noteId,
          expectedRevisionHash: renamedReview.revisionHash,
          expectedSanitizerVersion: renamedReview.sanitizerVersion,
        });
        expect(renamedCitation.noteId).toBe(citation.noteId);

        yield* fs.writeFileString(note, '# Different note\n\nReuse path.');
        yield* runObsidianSourceSync(config, {apply: true, id: 'notes'});
        const reusedReview = yield* inspectObsidianNote(config, 'notes', 'Decision.md');
        const reused = yield* captureObsidianEvidence(config, {
          sourceId: 'notes',
          relativePath: 'Decision.md',
          fragment: 'Reuse path.',
          expectedSourceInstanceId: reusedReview.sourceInstanceId,
          expectedNoteId: reusedReview.noteId,
          expectedRevisionHash: reusedReview.revisionHash,
          expectedSanitizerVersion: reusedReview.sanitizerVersion,
        });
        expect(reused.noteId).not.toBe(citation.noteId);
        yield* fs.remove(renamed);
        expect((yield* readObsidianEvidence(config, renamedCitation)).currentRevision).toBe('removed');
        expect((yield* readObsidianEvidence(config, citation)).fragment).toBe('Use local evidence.');
      }).pipe(provide),
  );

  effectIt.effect(
    'rejects stale capture and reports logical expiry and source revocation without returning content',
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-evidence-policy-'});
        const home = path.join(root, 'home');
        const vault = path.join(root, 'vault');
        const note = path.join(vault, 'Decision.md');
        const config: RuntimeConfig = {
          account: 'local',
          agentContextHome: home,
          agentId: 'threadnote',
          manifestPath: path.join(home, 'manifest.yaml'),
          user: 'tester',
        };
        yield* fs.makeDirectory(vault, {recursive: true});
        yield* fs.writeFileString(note, 'A reviewed fact.');
        yield* runObsidianSourceAdd(config, {apply: true, id: 'notes', include: ['**/*.md'], vault});
        yield* runObsidianSourceSync(config, {apply: true, id: 'notes'});
        const reviewed = yield* inspectObsidianNote(config, 'notes', 'Decision.md');
        const citation = yield* captureObsidianEvidence(config, {
          sourceId: 'notes',
          relativePath: 'Decision.md',
          fragment: 'reviewed',
          expectedSourceInstanceId: reviewed.sourceInstanceId,
          expectedNoteId: reviewed.noteId,
          expectedRevisionHash: reviewed.revisionHash,
          expectedSanitizerVersion: reviewed.sanitizerVersion,
          retentionDays: 1,
        });
        yield* fs.writeFileString(note, 'A changed fact.');
        const stale = yield* Effect.result(
          captureObsidianEvidence(config, {
            sourceId: 'notes',
            relativePath: 'Decision.md',
            fragment: 'reviewed',
            expectedSourceInstanceId: reviewed.sourceInstanceId,
            expectedNoteId: reviewed.noteId,
            expectedRevisionHash: reviewed.revisionHash,
            expectedSanitizerVersion: reviewed.sanitizerVersion,
          }),
        );
        expect(stale._tag).toBe('Failure');
        yield* fs.writeFileString(note, 'A reviewed fact with new detail.');
        yield* runObsidianSourceSync(config, {apply: true, id: 'notes'});
        const changedAfterReview = yield* Effect.result(
          captureObsidianEvidence(config, {
            sourceId: 'notes',
            relativePath: 'Decision.md',
            fragment: 'reviewed',
            expectedSourceInstanceId: reviewed.sourceInstanceId,
            expectedNoteId: reviewed.noteId,
            expectedRevisionHash: reviewed.revisionHash,
            expectedSanitizerVersion: reviewed.sanitizerVersion,
          }),
        );
        expect(changedAfterReview._tag).toBe('Failure');
        yield* runObsidianSourceRemove(config, {apply: true, id: 'notes'});
        const revoked = yield* readObsidianEvidence(config, citation);
        expect(revoked.historical).toBe('revoked');
        expect(revoked.fragment).toBeUndefined();
        expect(revoked.currentRevision).toBe('unknown');
        yield* TestClock.adjust('2 days');
        const expired = yield* readObsidianEvidence(config, citation);
        expect(expired.historical).toBe('expired');
        expect(expired.fragment).toBeUndefined();
        expect(expired.currentRevision).toBe('unknown');
      }).pipe(provide),
  );
  effectIt.effect('reconciles a capture-after-rename failure without allocating or renewing a reserved pin', () =>
    Effect.gen(function* () {
      const {fs, path, config, input, dir} = yield* reservedFixture;
      expect(yield* recoverObsidianEvidenceCapture(config, input)).toBeUndefined();
      expect(yield* fs.exists(dir)).toBe(false);
      const destination = path.join(dir, `${input.reservation.pinId}.json`);
      const crashAfterRename = FileSystem.FileSystem.of({
        ...fs,
        rename: (from, to) =>
          fs.rename(from, to).pipe(
            Effect.andThen(
              to === destination
                ? Effect.fail(
                    PlatformError.systemError({
                      _tag: 'PermissionDenied',
                      module: 'FileSystem',
                      method: 'rename',
                      pathOrDescriptor: to,
                    }),
                  )
                : Effect.void,
            ),
          ),
      });
      const failed = yield* Effect.result(
        captureObsidianEvidence(config, input).pipe(Effect.provideService(FileSystem.FileSystem, crashAfterRename)),
      );
      expect(failed._tag).toBe('Failure');
      expect(yield* fs.exists(destination)).toBe(true);
      const bytes = yield* fs.readFileString(destination);
      yield* TestClock.adjust('1 hour');
      const recovered = yield* recoverObsidianEvidenceCapture(config, input);
      expect(recovered?.pinId).toBe(input.reservation.pinId);
      expect(recovered?.fragmentStart).toBe(7); // Select the second identical occurrence exactly.
      expect(recovered?.expiresAt).toBe(input.reservation.expiresAt);
      expect(yield* captureObsidianEvidence(config, input)).toEqual(recovered);
      expect(yield* fs.readDirectory(dir)).toEqual([`${input.reservation.pinId}.json`]);
      expect(yield* fs.readFileString(destination)).toBe(bytes);
    }).pipe(provide),
  );

  effectIt.effect(
    'refuses reservation collisions, altered selections, changed deadlines and operation reuse without mutation',
    () =>
      Effect.gen(function* () {
        const {fs, path, config, input, dir} = yield* reservedFixture;
        yield* captureObsidianEvidence(config, input);
        const destination = path.join(dir, `${input.reservation.pinId}.json`);
        const bytes = yield* fs.readFileString(destination);
        for (const reservation of [
          {...input.reservation, operationId: '33333333-3333-4333-8333-333333333333'},
          {...input.reservation, fragmentStart: 0, fragmentEnd: 6},
          {
            ...input.reservation,
            capturedAt: DateTime.formatIso(DateTime.makeUnsafe(Date.parse(input.reservation.capturedAt) - 1000)),
            expiresAt: DateTime.formatIso(DateTime.makeUnsafe(Date.parse(input.reservation.expiresAt) - 1000)),
          },
          {...input.reservation, pinId: '44444444-4444-4444-8444-444444444444'},
          {...input.reservation, accessHash: 'a'.repeat(64)},
        ]) {
          expect((yield* Effect.result(captureObsidianEvidence(config, {...input, reservation})))._tag).toBe('Failure');
          expect(yield* fs.readFileString(destination)).toBe(bytes);
          expect(yield* fs.readDirectory(dir)).toEqual([`${input.reservation.pinId}.json`]);
        }
        yield* TestClock.adjust('2 days');
        expect((yield* Effect.result(captureObsidianEvidence(config, input)))._tag).toBe('Failure');
        expect((yield* Effect.result(recoverObsidianEvidenceCapture(config, input)))._tag).toBe('Failure');
        expect(yield* fs.readFileString(destination)).toBe(bytes);
      }).pipe(provide),
  );

  effectIt.effect('rechecks stable note identity across rename and path reuse; access denial withholds recovery', () =>
    Effect.gen(function* () {
      const {fs, path, config, input, dir, note, vault, reviewed} = yield* reservedFixture;
      const citation = yield* captureObsidianEvidence(config, input);
      const bytes = yield* fs.readFileString(path.join(dir, `${citation.pinId}.json`));
      const renamed = path.join(vault, 'Renamed.md');
      yield* fs.rename(note, renamed);
      yield* fs.writeFileString(note, 'different note');
      yield* runObsidianSourceSync(config, {apply: true, id: 'notes'});
      const inspected = yield* inspectObsidianNote(config, 'notes', {
        sourceInstanceId: reviewed.sourceInstanceId,
        noteId: reviewed.noteId,
      });
      expect(inspected.relativePath).toBe('Renamed.md');
      expect(inspected.noteId).toBe(citation.noteId);
      expect(yield* recoverObsidianEvidenceCapture(config, input)).toEqual(citation);
      expect(yield* captureObsidianEvidence(config, input)).toEqual(citation);
      const canonicalRenamed = path.join(yield* fs.realPath(vault), 'Renamed.md');
      const guarded = FileSystem.FileSystem.of({
        ...fs,
        access: (target, options) =>
          target === canonicalRenamed
            ? Effect.fail(
                PlatformError.systemError({
                  _tag: 'PermissionDenied',
                  module: 'FileSystem',
                  method: 'access',
                  pathOrDescriptor: target,
                }),
              )
            : fs.access(target, options),
      });
      expect(
        (yield* Effect.result(
          recoverObsidianEvidenceCapture(config, input).pipe(Effect.provideService(FileSystem.FileSystem, guarded)),
        ))._tag,
      ).toBe('Failure');
      yield* fs.writeFileString(renamed, 'changed revision');
      expect((yield* Effect.result(recoverObsidianEvidenceCapture(config, input)))._tag).toBe('Failure');
      expect(yield* fs.readFileString(path.join(dir, `${citation.pinId}.json`))).toBe(bytes);
      expect(yield* fs.readDirectory(dir)).toEqual([`${citation.pinId}.json`]);
    }).pipe(provide),
  );

  effectIt.effect('rejects malformed capture vectors and ambiguous live note identities without allocating pins', () =>
    Effect.gen(function* () {
      const {fs, path, config, input, dir, note, vault, reviewed} = yield* reservedFixture;
      for (const invalid of [
        {...input, fragment: ''},
        {...input, fragment: 'β'.repeat(4097)},
        {...input, fragment: 'absent'},
        {...input, expectedSanitizerVersion: 'unsupported'},
        {...input, expectedNoteId: 'unknown'},
        {...input, expectedSourceInstanceId: 'unknown'},
        {...input, reservation: {...input.reservation, fragmentStart: 2, fragmentEnd: 8}},
        {...input, reservation: {...input.reservation, pinId: '../unsafe'}},
      ])
        expect((yield* Effect.result(captureObsidianEvidence(config, invalid)))._tag).toBe('Failure');
      expect(yield* fs.exists(dir)).toBe(false);
      yield* fs.link(note, path.join(vault, 'Ambiguous.md'));
      expect((yield* Effect.result(captureObsidianEvidence(config, input)))._tag).toBe('Failure');
      expect(
        (yield* Effect.result(
          inspectObsidianNote(config, 'notes', {sourceInstanceId: reviewed.sourceInstanceId, noteId: reviewed.noteId}),
        ))._tag,
      ).toBe('Failure');
      expect(yield* fs.exists(dir)).toBe(false);
    }).pipe(provide),
  );

  effectIt.effect('fails closed on pin corruption or full capacity while preserving every existing pin', () =>
    Effect.gen(function* () {
      const {fs, path, config, input, dir} = yield* reservedFixture;
      const citation = yield* captureObsidianEvidence(config, input);
      const destination = path.join(dir, `${citation.pinId}.json`);
      const bytes = yield* fs.readFileString(destination);
      yield* fs.writeFileString(destination, '{corrupt');
      expect((yield* Effect.result(captureObsidianEvidence(config, input)))._tag).toBe('Failure');
      expect((yield* Effect.result(recoverObsidianEvidenceCapture(config, input)))._tag).toBe('Failure');
      expect(yield* fs.readFileString(destination)).toBe('{corrupt');
      const freshInput = {
        ...input,
        reservation: {
          ...input.reservation,
          operationId: '33333333-3333-4333-8333-333333333333',
          pinId: '44444444-4444-4444-8444-444444444444',
        },
      };
      expect((yield* Effect.result(captureObsidianEvidence(config, freshInput)))._tag).toBe('Failure');
      yield* fs.writeFileString(destination, bytes);
      const pin = JSON.parse(bytes);
      for (let index = 0; index < 255; index += 1) {
        const pinId = `${index.toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`;
        yield* fs.writeFileString(
          path.join(dir, `${pinId}.json`),
          JSON.stringify({citation: {...pin.citation, pinId}, sanitizedContent: pin.sanitizedContent}),
        );
      }
      const before = (yield* fs.readDirectory(dir)).sort();
      expect((yield* Effect.result(captureObsidianEvidence(config, freshInput)))._tag).toBe('Failure');
      expect((yield* fs.readDirectory(dir)).sort()).toEqual(before);
      expect(yield* fs.readFileString(destination)).toBe(bytes);
      expect(yield* captureObsidianEvidence(config, input)).toEqual(citation); // Retry consumes no additional capacity.
      yield* TestClock.adjust('2 days');
      const now = yield* Clock.currentTimeMillis;
      const newlyApproved = {
        ...freshInput,
        reservation: {
          ...freshInput.reservation,
          capturedAt: DateTime.formatIso(DateTime.makeUnsafe(now)),
          expiresAt: DateTime.formatIso(DateTime.makeUnsafe(now + 86_400_000)),
        },
      };
      expect((yield* Effect.result(captureObsidianEvidence(config, newlyApproved)))._tag).toBe('Failure');
      expect((yield* fs.readDirectory(dir)).sort()).toEqual(before);
      expect(yield* fs.readFileString(destination)).toBe(bytes);
    }).pipe(provide),
  );

  effectIt.effect.prop(
    'reserved retries never increase pin count, alter bytes or extend expiry (property)',
    {
      retries: Schema.Array(Schema.Boolean).check(Schema.isMinLength(1), Schema.isMaxLength(4)),
    },
    ({retries}) =>
      Effect.gen(function* () {
        const {fs, path, config, input, dir} = yield* reservedFixture;
        const first = yield* captureObsidianEvidence(config, input);
        const bytes = yield* fs.readFileString(path.join(dir, `${first.pinId}.json`));
        for (const recover of retries) {
          yield* TestClock.adjust('1 minute');
          const repeated = recover
            ? yield* recoverObsidianEvidenceCapture(config, input)
            : yield* captureObsidianEvidence(config, input);
          expect(repeated).toEqual(first);
          expect(yield* fs.readDirectory(dir)).toEqual([`${first.pinId}.json`]);
          expect(yield* fs.readFileString(path.join(dir, `${first.pinId}.json`))).toBe(bytes);
        }
      }).pipe(provide),
    {arbitrary: {runs: 12}},
  );
});
