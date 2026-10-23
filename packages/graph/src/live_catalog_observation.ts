import {Clock, Effect, FileSystem, Option, Path, Schema} from 'effect';
import {runtimeTextDirectoryNamePage} from '@threadnote/platform/system';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {codeGraphMaintenanceStatusPath, codeGraphRepositoriesRoot} from './layout.js';
import {CODE_GRAPH_BUILD_STALE_AFTER_MILLISECONDS} from './build_status.js';
import {parseCodeGraphBuildStatus} from './build_status/codec.js';
import {observeCodeGraphLocalProvenance} from './local_provenance.js';

class GraphLiveObservationError extends Schema.TaggedError<GraphLiveObservationError>()('GraphLiveObservationError', {
  message: Schema.String,
}) {}

/** Exact owner files, capped before allocation. No database, indexing or model reads. */
export const codeGraphLiveObservationPaths = Effect.fn('codeGraph.liveObservationPaths')(function* (home: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const now = yield* Clock.currentTimeMillis;
  const root = codeGraphRepositoriesRoot(path, home);
  const directories = new Set<string>([
    path.dirname(root),
    root,
    path.dirname(codeGraphMaintenanceStatusPath(path, home)),
  ]);
  const files = [codeGraphMaintenanceStatusPath(path, home)];
  const statusRevisions: Array<readonly [string, string]> = [];
  let bytes = 0;
  let nextChangeAt = Infinity;
  let worktreeCount = 0;
  const names = (directory: string, limit: number) =>
    Effect.gen(function* () {
      if (Option.isSome(yield* fs.readLink(directory).pipe(Effect.option)))
        return yield* GraphLiveObservationError.make({message: 'Linked graph live source'});
      if (!(yield* fs.exists(directory))) return [] as string[];
      const page = yield* runtimeTextDirectoryNamePage(directory, limit);
      if (page.overflow) return yield* GraphLiveObservationError.make({message: 'Graph live source budget exceeded'});
      directories.add(directory);
      if (directories.size > 120)
        return yield* GraphLiveObservationError.make({message: 'Graph live watch budget exceeded'});
      return [...page.names].sort();
    });
  const add = (file: string) =>
    Effect.gen(function* () {
      if (files.length >= 512)
        return yield* GraphLiveObservationError.make({message: 'Graph live file budget exceeded'});
      files.push(file);
    });
  for (const checkout of (yield* names(root, 64)).filter(name => /^[a-f0-9]{64}$/.test(name))) {
    const repository = path.join(root, checkout);
    const provenance = yield* observeCodeGraphLocalProvenance(home, checkout, 32 - worktreeCount);
    worktreeCount += provenance.count;
    for (const file of provenance.files) yield* add(file);
    for (const directory of provenance.directories) directories.add(directory);
    if (directories.size > 120)
      return yield* GraphLiveObservationError.make({message: 'Graph live watch budget exceeded'});
    statusRevisions.push([checkout, provenance.revision]);
    if (provenance.nextChangeAt !== undefined) nextChangeAt = Math.min(nextChangeAt, provenance.nextChangeAt);
    for (const name of yield* names(repository, 256)) {
      // SHM bytes change during harmless reads and never publish graph state.
      if (/^graph-v\d+\.sqlite(?:-wal)?$/.test(name)) yield* add(path.join(repository, name));
    }
    const statuses = path.join(repository, 'build-status');
    for (const view of (yield* names(statuses, 64)).filter(name =>
      /^[a-f0-9]{64}(?:\.scope-[a-f0-9]{64})?$/.test(name),
    )) {
      const directory = path.join(statuses, view);
      for (const name of (yield* names(directory, 128)).filter(name => /^[a-f0-9-]{16,64}\.json$/.test(name))) {
        const file = path.join(directory, name);
        yield* add(file);
        const status = yield* Effect.scoped(
          Effect.gen(function* () {
            if (Option.isSome(yield* fs.readLink(file).pipe(Effect.option)))
              return yield* GraphLiveObservationError.make({message: 'Linked graph status'});
            const handle = yield* fs.open(file, {flag: 'r'});
            const buffer = new Uint8Array(64 * 1024 + 1);
            let offset = 0;
            while (offset < buffer.length) {
              const size = Number(yield* handle.read(buffer.subarray(offset)));
              if (!size) break;
              offset += size;
            }
            bytes += offset;
            if (offset === buffer.length || bytes > 8 * 1024 * 1024)
              return yield* GraphLiveObservationError.make({message: 'Graph status byte budget exceeded'});
            // Bind the deadline to the bytes actually read. A publication between this read
            // and the caller's metadata probe must remain visible on the next reconciliation.
            statusRevisions.push([file, sha256HexSync(buffer.subarray(0, offset))]);
            return yield* Effect.try(() =>
              parseCodeGraphBuildStatus(JSON.parse(new TextDecoder().decode(buffer.subarray(0, offset)))),
            );
          }),
        );
        if (!status) return yield* GraphLiveObservationError.make({message: 'Invalid graph live status'});
        if (status.state === 'queued' || status.state === 'running') {
          const deadline = Date.parse(status.timestamps.heartbeatAt) + CODE_GRAPH_BUILD_STALE_AFTER_MILLISECONDS + 1;
          if (deadline > now) nextChangeAt = Math.min(nextChangeAt, deadline);
        }
      }
    }
    const stale = path.join(repository, 'stale');
    for (const name of (yield* names(stale, 128)).filter(name => name.endsWith('.stale')))
      yield* add(path.join(stale, name));
  }
  return {
    files,
    directories: [...directories],
    statusRevision: sha256HexSync(JSON.stringify(statusRevisions)),
    ...(Number.isFinite(nextChangeAt) ? {nextChangeAt} : {}),
  };
});
