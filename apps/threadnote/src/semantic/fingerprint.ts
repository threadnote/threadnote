import {Digest as EffectDigest} from 'effect/crypto';
import * as EffectArray from 'effect/Array';
import * as EffectString from 'effect/String';
import {Effect, FileSystem, Option, Path, Schema, Semaphore} from 'effect';
import {runtimeReadBoundedStableRegularFile} from '@threadnote/platform/system';
import {fromPromiseInterruptibleAwaiting} from '@threadnote/platform/errors';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {parse as parseJsonc, type ParseError} from 'jsonc-parser';
import {LspFault} from './lsp_transport.js';
export const readBounded = (file: string, maximumBytes: number) =>
  fromPromiseInterruptibleAwaiting(
    () => runtimeReadBoundedStableRegularFile(file, maximumBytes),
    () => LspFault.make({code: 'rejected'}),
  );
export const readBoundedText = (file: string, maximumBytes: number) =>
  readBounded(file, maximumBytes).pipe(
    Effect.flatMap(bytes =>
      Effect.try({
        try: () => new TextDecoder('utf-8', {fatal: true}).decode(bytes),
        catch: () => LspFault.make({code: 'protocol'}),
      }),
    ),
  );
export const boundedFileDigest = Effect.fn('semantic.boundedFileDigest')(function* (
  file: string,
  maximumBytes: number,
) {
  const digest = yield* EffectDigest.Digest;
  const hash = yield* digest.digest(EffectDigest.sha256, yield* readBounded(file, maximumBytes));
  return EffectArray.join(
    Array.from(hash, byte => EffectString.padStart(2, '0')(byte.toString(16))),
    '',
  );
});
/** Bounded conservative pilot invalidation. No build/config code is evaluated to compute this basis. */
const treeDigest = Effect.fn('semantic.treeDigest')(function* (
  root: string,
  projectConfiguration: boolean,
  sdk: boolean,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const canonical = yield* fs.realPath(root);
  if (canonical !== path.resolve(root)) return yield* LspFault.make({code: 'prerequisite'});
  const pending = [canonical];
  const entries: [string, string][] = [];
  let files = 0;
  let totalBytes = 0;
  const configurations = new Set<string>();
  const validateConfiguration = (file: string): Effect.Effect<void, unknown> =>
    Effect.gen(function* () {
      if (configurations.has(file)) return;
      if (
        configurations.size >= 256 ||
        !EffectString.startsWith(canonical + path.sep)(file) ||
        (yield* fs.realPath(file)) !== file
      )
        return yield* LspFault.make({code: 'prerequisite'});
      configurations.add(file);
      if (Number((yield* fs.stat(file)).size) > 1024 * 1024) return yield* LspFault.make({code: 'capacity'});
      const errors: ParseError[] = [];
      const raw: unknown = parseJsonc(yield* readBoundedText(file, 1024 * 1024), errors, {allowTrailingComma: true});
      if (errors.length) return yield* LspFault.make({code: 'prerequisite'});
      const configuration = yield* Schema.decodeUnknownEffect(
        Schema.Struct({
          compilerOptions: Schema.optional(
            Schema.Struct({
              plugins: Schema.optional(Schema.Array(Schema.Json).check(Schema.isMaxLength(0))),
            }),
          ),
          extends: Schema.optional(Schema.Union([Schema.String, Schema.Array(Schema.String)])),
          references: Schema.optional(Schema.Array(Schema.Struct({path: Schema.String}))),
        }),
      )(raw).pipe(Effect.mapError(() => LspFault.make({code: 'prerequisite'})));
      const extensions =
        typeof configuration.extends === 'string' ? [configuration.extends] : (configuration.extends ?? []);
      for (const base of extensions) {
        let resolved: string;
        if (EffectString.startsWith('.')(base))
          resolved = path.resolve(path.dirname(file), EffectString.endsWith('.json')(base) ? base : base + '.json');
        else
          resolved = yield* Effect.try({
            try: () => Bun.resolveSync(base, path.dirname(file)),
            catch: () => LspFault.make({code: 'prerequisite'}),
          });
        if (!EffectString.endsWith('.json')(resolved)) return yield* LspFault.make({code: 'prerequisite'});
        yield* validateConfiguration(resolved);
      }
      for (const reference of configuration.references ?? []) {
        const resolved = path.resolve(path.dirname(file), reference.path);
        if (!EffectString.startsWith(canonical + path.sep)(resolved) || (yield* fs.realPath(resolved)) !== resolved)
          return yield* LspFault.make({code: 'prerequisite'});
        yield* validateConfiguration(
          (yield* fs.stat(resolved)).type === 'Directory' ? path.join(resolved, 'tsconfig.json') : resolved,
        );
      }
    });
  const largeReads = sdk ? yield* Semaphore.make(1) : undefined;
  while (pending.length) {
    const directory = pending.pop()!;
    const names = (yield* fs.readDirectory(directory)).sort();
    if (names.length + files > 20000) return yield* LspFault.make({code: 'capacity'});
    yield* Effect.forEach(
      names,
      name =>
        Effect.gen(function* () {
          const file = path.join(directory, name);
          const relative = path.relative(canonical, file);
          if (relative === '.git' || EffectString.startsWith('.git/')(relative)) return;
          if (++files > 20000) return yield* LspFault.make({code: 'capacity'});
          // Symlinked or external project roots need explicit provider qualification; never silently omit them.
          if (Option.isSome(yield* fs.readLink(file).pipe(Effect.option)))
            return yield* LspFault.make({code: 'prerequisite'});
          const before = yield* fs.stat(file);
          if (before.type === 'Directory') {
            pending.push(file);
            entries.push([relative, 'directory']);
            return;
          }
          if (before.type !== 'File' || Number(before.size) > (sdk ? 256 : 32) * 1024 * 1024)
            return yield* LspFault.make({code: 'capacity'});
          totalBytes += Number(before.size);
          if (totalBytes > (sdk ? 1024 : 256) * 1024 * 1024) return yield* LspFault.make({code: 'capacity'});
          const read = boundedFileDigest(file, Number(before.size));
          const hash = yield* largeReads && Number(before.size) > 1024 * 1024 ? largeReads.withPermit(read) : read;
          if (projectConfiguration && /^(?:tsconfig|jsconfig)(?:\..+)?\.json$/u.test(name))
            yield* validateConfiguration(file);
          const after = yield* fs.stat(file);
          if (
            after.size !== before.size ||
            Option.getOrUndefined(after.mtime)?.getTime() !== Option.getOrUndefined(before.mtime)?.getTime()
          )
            return yield* LspFault.make({code: 'rejected'});
          entries.push([relative, hash]);
        }),
      {concurrency: sdk ? 8 : 1, discard: true},
    );
  }
  // Include worktree and common branch metadata without traversing Git object storage.
  const git = path.join(canonical, '.git');
  if (yield* fs.exists(git)) {
    const info = yield* fs.stat(git);
    let directory = git;
    if (info.type === 'File') {
      if (Number(info.size) > 8192) return yield* LspFault.make({code: 'prerequisite'});
      const text = EffectString.trim(yield* readBoundedText(git, 8192));
      if (!EffectString.startsWith('gitdir: ')(text)) return yield* LspFault.make({code: 'prerequisite'});
      directory = yield* fs.realPath(path.resolve(canonical, EffectString.slice(8)(text)));
    }
    const head = yield* readBoundedText(path.join(directory, 'HEAD'), 8192);
    entries.push(['git:HEAD', head]);
    const commonFile = path.join(directory, 'commondir');
    const common = (yield* fs.exists(commonFile))
      ? path.resolve(directory, EffectString.trim(yield* readBoundedText(commonFile, 8192)))
      : directory;
    if (EffectString.startsWith('ref: ')(head)) {
      const ref = EffectString.trim(EffectString.slice(5)(head));
      if (
        !EffectString.startsWith('refs/')(ref) ||
        EffectString.includes('..')(ref) ||
        EffectString.includes('\\')(ref)
      )
        return yield* LspFault.make({code: 'prerequisite'});
      const file = path.join(common, ref);
      if (yield* fs.exists(file)) entries.push(['git:ref', yield* readBoundedText(file, 8192)]);
      const packed = path.join(common, 'packed-refs');
      if (yield* fs.exists(packed)) {
        if (Number((yield* fs.stat(packed)).size) > 4 * 1024 * 1024) return yield* LspFault.make({code: 'capacity'});
        entries.push(['git:packed', yield* boundedFileDigest(packed, 4 * 1024 * 1024)]);
      }
    }
  }
  return sha256HexSync(JSON.stringify(entries.sort(([a], [b]) => EffectString.localeCompare(b)(a))));
});
export const semanticTreeDigest = (root: string, projectConfiguration = false) =>
  treeDigest(root, projectConfiguration, false);
/** Fixed host SDK bound; repository requests cannot choose or widen source limits. */
export const semanticSdkDigest = (root: string) => treeDigest(root, false, true);
