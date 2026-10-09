import * as BunServices from '@effect/platform-bun/BunServices';
import {it as effectIt} from '@effect/vitest';
import {Effect, FileSystem, Layer, Path, PlatformError, Schema} from 'effect';
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
});
