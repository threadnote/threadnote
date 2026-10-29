import {it as effectIt} from '@effect/vitest';
import {Effect, FileSystem, Path, Queue, Ref, Stream} from 'effect';
import {TestClock} from 'effect/testing';
import {describe, expect} from 'vitest';
import {runCommandEffect} from '@threadnote/platform/command';
import {StandaloneBrokerLayer} from '@threadnote/threadnote/effect/runtime';
import {makeCodeGraphWatchIgnorePolicy, watchRepository, type CodeGraphWatchOptions} from '@threadnote/graph/watcher';
import {provideTestLayer} from '../helpers/effect-layer.js';

describe('filesystem graph watch ignore policy', () => {
  effectIt.effect('drops gitignored build chatter before maintenance and reloads after .gitignore changes', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-watch-ignore-'});
      yield* runCommandEffect('git', ['init', root], {timeoutMs: 0});
      yield* fs.writeFileString(path.join(root, '.gitignore'), 'artifacts/\n');
      yield* fs.makeDirectory(path.join(root, 'artifacts', 'server'), {recursive: true});
      const {events, changes, notifications, classifications} = yield* startWatch(fs, path, root);

      yield* Queue.offer(changes, {_tag: 'Update', path: 'artifacts/server/output.js'});
      expect(yield* Queue.take(classifications).pipe(Effect.timeout('5 seconds'))).toEqual({
        accepted: false,
        path: 'artifacts/server/output.js',
      });
      expect(yield* Ref.get(events)).toEqual([]);

      yield* Queue.offer(changes, {_tag: 'Update', path: 'src/entry.ts'});
      yield* nextRefresh(notifications);
      expect(yield* Ref.get(events)).toEqual(['maintenance', 'refresh']);

      yield* fs.writeFileString(path.join(root, '.gitignore'), 'new-artifacts/\n');
      yield* Queue.offer(changes, {_tag: 'Update', path: '.gitignore'});
      yield* nextRefresh(notifications);
      yield* Queue.offer(changes, {_tag: 'Update', path: 'artifacts/server/output.js'});
      yield* nextRefresh(notifications);
      expect(yield* Ref.get(events)).toEqual([
        'maintenance',
        'refresh',
        'maintenance',
        'refresh',
        'maintenance',
        'refresh',
      ]);
    }).pipe(provideTestLayer(StandaloneBrokerLayer), TestClock.withLive),
  );

  effectIt.effect('drops .threadnoteignore and local-ignore paths while keeping ignore manifests relevant', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-watch-ignore-'});
      yield* runCommandEffect('git', ['init', root], {timeoutMs: 0});
      yield* fs.writeFileString(path.join(root, '.threadnoteignore'), 'generated/\n');
      yield* fs.writeFileString(path.join(root, '.threadnoteignore.local'), 'private-output/\n');
      const {events, changes, notifications, classifications} = yield* startWatch(fs, path, root);

      yield* Queue.offer(changes, {_tag: 'Update', path: 'generated/value.ts'});
      yield* Queue.offer(changes, {_tag: 'Update', path: 'private-output/value.ts'});
      expect(yield* Queue.take(classifications).pipe(Effect.timeout('5 seconds'))).toEqual({
        accepted: false,
        path: 'generated/value.ts',
      });
      expect(yield* Queue.take(classifications).pipe(Effect.timeout('5 seconds'))).toEqual({
        accepted: false,
        path: 'private-output/value.ts',
      });
      expect(yield* Ref.get(events)).toEqual([]);

      yield* fs.writeFileString(path.join(root, '.threadnoteignore'), 'new-generated/\n');
      yield* Queue.offer(changes, {_tag: 'Update', path: '.threadnoteignore'});
      yield* nextRefresh(notifications);
      yield* Queue.offer(changes, {_tag: 'Update', path: 'generated/value.ts'});
      yield* nextRefresh(notifications);
      yield* fs.writeFileString(path.join(root, '.threadnoteignore.local'), 'new-private-output/\n');
      yield* Queue.offer(changes, {_tag: 'Update', path: '.threadnoteignore.local'});
      yield* nextRefresh(notifications);
      yield* Queue.offer(changes, {_tag: 'Update', path: 'private-output/value.ts'});
      yield* nextRefresh(notifications);
      expect(yield* Ref.get(events)).toEqual([
        'maintenance',
        'refresh',
        'maintenance',
        'refresh',
        'maintenance',
        'refresh',
        'maintenance',
        'refresh',
      ]);
    }).pipe(provideTestLayer(StandaloneBrokerLayer), TestClock.withLive),
  );

  effectIt.effect('applies repository-scoped ignore rules to events from a nested watch cwd', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-watch-ignore-'});
      yield* runCommandEffect('git', ['init', root], {timeoutMs: 0});
      yield* fs.writeFileString(path.join(root, '.gitignore'), 'packages/app/artifacts/\n');
      const watchCwd = path.join(root, 'packages', 'app');
      yield* fs.makeDirectory(path.join(watchCwd, 'artifacts'), {recursive: true});
      const {events, changes, notifications, classifications} = yield* startWatch(fs, path, root, watchCwd);

      yield* Queue.offer(changes, {_tag: 'Update', path: 'artifacts/output.js'});
      expect(yield* Queue.take(classifications).pipe(Effect.timeout('5 seconds'))).toEqual({
        accepted: false,
        path: 'artifacts/output.js',
      });
      expect(yield* Ref.get(events)).toEqual([]);

      yield* Queue.offer(changes, {_tag: 'Update', path: 'src/entry.ts'});
      yield* nextRefresh(notifications);
      expect(yield* Ref.get(events)).toEqual(['maintenance', 'refresh']);
    }).pipe(provideTestLayer(StandaloneBrokerLayer), TestClock.withLive),
  );
});

function startWatch(fs: FileSystem.FileSystem, path: Path.Path, root: string, watchCwd = root) {
  return Effect.gen(function* () {
    const events = yield* Ref.make<string[]>([]);
    const changes = yield* Queue.unbounded<FileSystem.WatchEvent>();
    const notifications = yield* Queue.unbounded<string>();
    const classifications = yield* Queue.unbounded<{readonly accepted: boolean; readonly path: string}>();
    const options: CodeGraphWatchOptions = {cwd: watchCwd, key: 'fixture:watch', threadnoteHome: root};
    const watchedFs = FileSystem.makeNoop({...fs, watch: () => Stream.fromQueue(changes)});
    const ignorePolicy = yield* makeCodeGraphWatchIgnorePolicy(fs, path, root, watchCwd);
    yield* watchRepository(
      watchedFs,
      path,
      options,
      false,
      () =>
        Ref.update(events, current => [...current, 'refresh']).pipe(
          Effect.andThen(Queue.offer(notifications, 'refresh')),
          Effect.asVoid,
        ),
      {
        changeRefreshRequired: Effect.succeed(true),
        periodicRefreshRequired: Effect.succeed(false),
        requestAfterChange: Ref.update(events, current => [...current, 'maintenance']).pipe(
          Effect.andThen(Queue.offer(notifications, 'maintenance')),
          Effect.asVoid,
        ),
        requestInitial: Effect.void,
        watchIgnorePolicy: Effect.succeed({
          ...ignorePolicy,
          accepts: watchPath =>
            ignorePolicy
              .accepts(watchPath)
              .pipe(Effect.tap(accepted => Queue.offer(classifications, {accepted, path: watchPath}))),
        }),
      },
    ).pipe(Effect.forkScoped);
    return {changes, classifications, events, notifications};
  });
}

function nextRefresh(notifications: Queue.Dequeue<string>) {
  return Effect.gen(function* () {
    expect(yield* Queue.take(notifications)).toBe('maintenance');
    expect(yield* Queue.take(notifications)).toBe('refresh');
  }).pipe(Effect.timeout('5 seconds'));
}
