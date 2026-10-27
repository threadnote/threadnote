import {Context, Effect, Exit, FileSystem, Layer, Option, Path, Scope} from 'effect';
import * as SqliteClient from '@effect/sql-sqlite-bun/SqliteClient';
import * as SqlClient from 'effect/sql/SqlClient';
import {
  readOpenedFileSystemIdentity,
  readPathFileSystemIdentity,
  type FileSystemIdentity,
} from '@threadnote/platform/system';

type DatabaseContext = Context.Context<SqliteClient.SqliteClient | SqlClient.SqlClient>;
type Identity = {readonly database: string; readonly files: string};
type Entry = {
  readonly path: string;
  readonly identity: Identity;
  readonly context: DatabaseContext;
  readonly scope: Scope.Closeable;
};
type Session = {readonly owner: number; active: boolean; busy: boolean; entry?: Entry};
const closeDatabase = (scope: Scope.Closeable, exit: Exit.Exit<unknown, unknown>) =>
  Scope.close(scope, exit).pipe(Effect.withSpan('recall.closeDatabase'));
const CurrentSession = Context.Reference<Session | undefined>('threadnote/RecallDatabaseSession', {
  defaultValue: () => undefined,
});

const releaseEntry = (session: Session, exit: Exit.Exit<unknown, unknown>) =>
  Effect.suspend(() => {
    const entry = session.entry;
    // Revoke before running finalizers, including when closing defects.
    session.entry = undefined;
    return entry ? closeDatabase(entry.scope, exit) : Effect.void;
  });

/** One sequential native request may retain one connection through its normal flush. */
export const withRecallDatabaseSession = <A, E, R>(program: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  Effect.acquireUseRelease(
    Effect.map(Effect.fiberId, (owner): Session => ({owner, active: true, busy: false})),
    session => program.pipe(Effect.provideService(CurrentSession, session)),
    (session, exit) =>
      Effect.suspend(() => {
        session.active = false;
        return releaseEntry(session, exit);
      }),
  );

function identity(value: Option.Option<FileSystemIdentity>): string | undefined {
  // Effect's File.Info omits inodes beyond Number.MAX_SAFE_INTEGER. The platform
  // readers recover precise bigint identities from this handle and path; never
  // round an identity or accept absent/zero IDs in their place.
  return Option.isSome(value) && value.value.dev >= 0n && value.value.ino > 0n
    ? `${value.value.dev}:${value.value.ino}`
    : undefined;
}

export const probeRecallDatabase = (path: string, requireAuxiliaries = false) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const paths = yield* Path.Path;
      // Conservative admission only; access() alone cannot prove Windows ACLs.
      yield* fs.access(paths.dirname(path), {readable: true, writable: true});
      // A live handle must not bypass a newly denied open/ACL. Do not create or
      // chmod here: a fresh SQLite open would precede the query's normal chmod.
      const file = yield* fs.open(path, {flag: 'r+'});
      const opened = identity(yield* readOpenedFileSystemIdentity(file, yield* file.stat, 'File'));
      const current = identity(yield* readPathFileSystemIdentity(path, yield* fs.stat(path), 'File'));
      if (opened === undefined || opened !== current) return undefined;
      const files = [opened];
      for (const auxiliary of [`${path}-wal`, `${path}-shm`]) {
        if (!(yield* fs.exists(auxiliary))) {
          if (requireAuxiliaries) return undefined;
          files.push('absent');
          continue;
        }
        const file = yield* fs.open(auxiliary, {flag: 'r+'});
        const opened = identity(yield* readOpenedFileSystemIdentity(file, yield* file.stat, 'File'));
        const current = identity(yield* readPathFileSystemIdentity(auxiliary, yield* fs.stat(auxiliary), 'File'));
        if (opened === undefined || opened !== current) return undefined;
        files.push(opened);
      }
      return {database: opened, files: files.join('|')};
    }),
  ).pipe(Effect.orElseSucceed(() => undefined));

const databaseLayer = (path: string) => SqliteClient.layer({filename: path}).pipe(Layer.orDie);
const body = <A, E, R>(effect: Effect.Effect<A, E, R | SqlClient.SqlClient>, context: DatabaseContext) =>
  effect.pipe(Effect.provide(context), Effect.withSpan('recall.databaseBody'));

export function useRecallDatabase<A, E, R>(
  path: string,
  effect: Effect.Effect<A, E, R | SqlClient.SqlClient>,
  reusable = true,
): Effect.Effect<A, E, Exclude<R, SqlClient.SqlClient> | FileSystem.FileSystem | Path.Path> {
  return Effect.withFiber(fiber => {
    const session = Context.get(fiber.context, CurrentSession);
    // Inherited tokens, reentrant queries and concurrent fibers use independent
    // scopes. Recovery's replacement must close before pointer publication.
    if (!reusable || !session?.active || session.busy || session.owner !== fiber.id) {
      return Effect.scoped(
        Layer.build(databaseLayer(path)).pipe(
          Effect.withSpan('recall.acquireDatabase'),
          Effect.flatMap(context => body(effect, context)),
        ),
      );
    }
    return Effect.acquireUseRelease(
      Effect.sync(() => {
        session.busy = true;
      }),
      () =>
        Effect.gen(function* () {
          const before = yield* probeRecallDatabase(path, session.entry !== undefined);
          if (session.entry && (session.entry.path !== path || session.entry.identity.files !== before?.files)) {
            yield* releaseEntry(session, Exit.void);
          }
          if (session.entry) {
            return yield* body(effect, session.entry.context);
          }
          return yield* Effect.acquireUseRelease(
            Scope.make(),
            scope =>
              Effect.gen(function* () {
                const context = yield* Layer.buildWithScope(databaseLayer(path), scope).pipe(
                  Effect.withSpan('recall.acquireDatabase'),
                );
                const result = yield* body(effect, context);
                // Initial fresh closes remove auxiliaries. Let this successful real
                // body establish them before deciding whether its scope can survive.
                const after = before === undefined ? undefined : yield* probeRecallDatabase(path, true);
                if (before !== undefined && after !== undefined && before.database === after.database) {
                  session.entry = {path, identity: after, context, scope};
                }
                return result;
              }),
            (scope, exit) =>
              Effect.suspend(() => {
                if (session.entry?.scope === scope) {
                  if (Exit.isSuccess(exit)) return Effect.void;
                  session.entry = undefined;
                }
                return closeDatabase(scope, exit);
              }),
          );
        }),
      (_, exit) =>
        (Exit.isFailure(exit) ? releaseEntry(session, exit) : Effect.void).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              session.busy = false;
            }),
          ),
        ),
    );
  });
}
