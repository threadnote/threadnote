import {Crypto, Effect, FileSystem, Option, Path, Schema} from 'effect';
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
  const crypto = yield* Crypto.Crypto;
  const hash = yield* crypto.digest('SHA-256', yield* readBounded(file, maximumBytes));
  return Array.from(hash, byte => byte.toString(16).padStart(2, '0')).join('');
});
/** Bounded conservative pilot invalidation. No build/config code is evaluated to compute this basis. */
export const semanticTreeDigest = Effect.fn('semantic.treeDigest')(function* (
  root: string,
  projectConfiguration = false,
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
      if (configurations.size >= 256 || !file.startsWith(canonical + path.sep) || (yield* fs.realPath(file)) !== file)
        return yield* LspFault.make({code: 'prerequisite'});
      configurations.add(file);
      if (Number((yield* fs.stat(file)).size) > 1024 * 1024) return yield* LspFault.make({code: 'capacity'});
      const errors: ParseError[] = [];
      const raw: unknown = parseJsonc(yield* readBoundedText(file, 1024 * 1024), errors, {allowTrailingComma: true});
      if (errors.length) return yield* LspFault.make({code: 'prerequisite'});
      const configuration = yield* Schema.decodeUnknownEffect(
        Schema.Struct({
          extends: Schema.optional(Schema.Union([Schema.String, Schema.Array(Schema.String)])),
          references: Schema.optional(Schema.Array(Schema.Struct({path: Schema.String}))),
        }),
      )(raw);
      const extensions =
        typeof configuration.extends === 'string' ? [configuration.extends] : (configuration.extends ?? []);
      for (const base of extensions) {
        let resolved: string;
        if (base.startsWith('.'))
          resolved = path.resolve(path.dirname(file), base.endsWith('.json') ? base : base + '.json');
        else
          resolved = yield* Effect.try({
            try: () => Bun.resolveSync(base, path.dirname(file)),
            catch: () => LspFault.make({code: 'prerequisite'}),
          });
        if (!resolved.endsWith('.json')) return yield* LspFault.make({code: 'prerequisite'});
        yield* validateConfiguration(resolved);
      }
      for (const reference of configuration.references ?? []) {
        const resolved = path.resolve(path.dirname(file), reference.path);
        if (!resolved.startsWith(canonical + path.sep) || (yield* fs.realPath(resolved)) !== resolved)
          return yield* LspFault.make({code: 'prerequisite'});
      }
    });
  while (pending.length) {
    const directory = pending.pop()!;
    const names = (yield* fs.readDirectory(directory)).sort();
    if (names.length + files > 20_000) return yield* LspFault.make({code: 'capacity'});
    for (const name of names) {
      const file = path.join(directory, name);
      const relative = path.relative(canonical, file);
      if (relative === '.git' || relative.startsWith('.git/')) continue;
      if (++files > 20_000) return yield* LspFault.make({code: 'capacity'});
      // Symlinked or external project roots need explicit provider qualification; never silently omit them.
      if (Option.isSome(yield* fs.readLink(file).pipe(Effect.option)))
        return yield* LspFault.make({code: 'prerequisite'});
      const before = yield* fs.stat(file);
      if (before.type === 'Directory') {
        pending.push(file);
        entries.push([relative, 'directory']);
        continue;
      }
      if (before.type !== 'File' || Number(before.size) > 32 * 1024 * 1024)
        return yield* LspFault.make({code: 'capacity'});
      totalBytes += Number(before.size);
      if (totalBytes > 256 * 1024 * 1024) return yield* LspFault.make({code: 'capacity'});
      const hash = yield* boundedFileDigest(file, Number(before.size));
      if (projectConfiguration && /^(?:tsconfig|jsconfig)(?:\..+)?\.json$/u.test(name))
        yield* validateConfiguration(file);
      const after = yield* fs.stat(file);
      if (
        after.size !== before.size ||
        Option.getOrUndefined(after.mtime)?.getTime() !== Option.getOrUndefined(before.mtime)?.getTime()
      )
        return yield* LspFault.make({code: 'rejected'});
      entries.push([relative, hash]);
    }
  }
  // Include worktree and common branch metadata without traversing Git object storage.
  const git = path.join(canonical, '.git');
  if (yield* fs.exists(git)) {
    const info = yield* fs.stat(git);
    let directory = git;
    if (info.type === 'File') {
      if (Number(info.size) > 8192) return yield* LspFault.make({code: 'prerequisite'});
      const text = (yield* readBoundedText(git, 8192)).trim();
      if (!text.startsWith('gitdir: ')) return yield* LspFault.make({code: 'prerequisite'});
      directory = yield* fs.realPath(path.resolve(canonical, text.slice(8)));
    }
    const head = yield* readBoundedText(path.join(directory, 'HEAD'), 8192);
    entries.push(['git:HEAD', head]);
    const commonFile = path.join(directory, 'commondir');
    const common = (yield* fs.exists(commonFile))
      ? path.resolve(directory, (yield* readBoundedText(commonFile, 8192)).trim())
      : directory;
    if (head.startsWith('ref: ')) {
      const ref = head.slice(5).trim();
      if (!ref.startsWith('refs/') || ref.includes('..') || ref.includes('\\'))
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
  return sha256HexSync(JSON.stringify(entries.sort(([a], [b]) => a.localeCompare(b))));
});
