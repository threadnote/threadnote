import {Array as EffectArray} from 'effect';
import {Context, Effect, FileSystem, Option, Path} from 'effect';
import {CommandExecutor} from '@threadnote/platform/command';
import {runCommandEffect, runBinaryCommandEffect} from '@threadnote/platform/command';
import {
  WorkflowAutomationError,
  WorkflowGit,
  type WorkflowSourceSnapshot,
} from '@threadnote/workflow-automations/contracts';
import {sha256HexSync} from '../workflow_memory/native_digest.js';
import {nativeWorkflowError} from './memory.js';
import {nativeCycleHasControl} from '@threadnote/workflow-automations/cycle';
import {readPathFileSystemAuthority, sameFileSystemIdentity} from '@threadnote/platform/system';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

const fail = (code: string, message: string) => WorkflowAutomationError.make({code, message});
const objectId = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const outputLimit = 4 * 1_048_576;

export function nativeCycleRelativePath(value: string): boolean {
  return (
    value.length > 0 &&
    new TextEncoder().encode(value).byteLength <= 4096 &&
    !/[\\:]/u.test(value) &&
    !nativeCycleHasControl(value) &&
    !Effect2.pipe(value, EffectString.startsWith('/')) &&
    !EffectArray.some(
      Effect2.pipe(value, EffectString.split('/')),
      segment => !segment || segment === '.' || segment === '..',
    )
  );
}

const cycleTreeModes = new Set(['100644', '100755', '120000', '160000']);
const absentTreeMode = '000000';

const git = (repo: string, args: readonly string[], temporaryIndex?: string) =>
  runBinaryCommandEffect('git', ['--no-optional-locks', '-C', repo, ...args], {
    timeoutMs: 30_000,
    maxOutputBytes: outputLimit,
    ...(temporaryIndex ? {trustedGitIndexFile: temporaryIndex} : {}),
  }).pipe(
    Effect.flatMap(result =>
      Effect.try({
        try: () => new TextDecoder('utf-8', {fatal: true}).decode(result.stdout),
        catch: () =>
          fail('invalid-snapshot', 'Git paths must be valid UTF-8; no lossy filename projection was admitted.'),
      }),
    ),
  );

const resolveObject = Effect.fn('workflowAutomation.cycle.resolveObject')(function* (
  repo: string,
  reference: string,
  kind: 'tree' | 'commit',
) {
  if (!Effect2.pipe(reference, EffectString.trim) || reference.length > 512 || nativeCycleHasControl(reference))
    return yield* fail('invalid-snapshot', 'Use one bounded Git revision.');
  const value = Effect2.pipe(
    yield* git(repo, ['rev-parse', '--verify', '--end-of-options', `${reference}^{${kind}}`]),
    EffectString.trim,
  );
  if (!objectId.test(value)) return yield* fail('invalid-snapshot', 'Git did not return a complete object identity.');
  return value;
});

/** Read exact entries in bounded literal-path batches from one immutable tree. */
export const readNativeCycleTreeEntries = Effect.fn('workflowAutomation.cycle.readTreeEntries')(function* (
  repo: string,
  reference: string,
  files: readonly string[],
) {
  if (files.length > 8192) return yield* fail('snapshot-capacity', 'Tree lookup exceeds the bounded file manifest.');
  for (const file of files)
    if (!nativeCycleRelativePath(file)) return yield* fail('invalid-scope', 'Source paths must be relative.');
  const entries: Record<string, {mode: string; blob: string}> = Object.create(null);
  if (!files.length) return entries;
  const root = yield* canonicalRepo(repo);
  const tree = yield* resolveObject(root, reference, 'tree');
  // oxlint-disable-next-line effecttsgo/prefer-effect-string -- Object identity length is validated above; retain native zero identity semantics.
  const absent = {mode: absentTreeMode, blob: '0'.repeat(tree.length)};
  const paths = [...new Set(files)];
  for (const file of paths) entries[file] = absent;
  let offset = 0;
  while (offset < paths.length) {
    const batch: string[] = [];
    let argumentBytes = 0;
    while (offset < paths.length && batch.length < 128) {
      const file = paths[offset];
      const size = new TextEncoder().encode(`:(literal)${file}`).byteLength + 1;
      if (batch.length && argumentBytes + size > 24_576) break;
      batch.push(file);
      argumentBytes += size;
      offset++;
    }
    const requested = new Set(batch);
    const seen = new Set<string>();
    const records = yield* git(root, [
      'ls-tree',
      '-r',
      '-z',
      tree,
      '--',
      ...EffectArray.map(batch, file => `:(literal)${file}`),
    ]);
    for (const record of Effect2.pipe(records, EffectString.split('\0'))) {
      if (!record) continue;
      const tab = Effect2.pipe(
        record,
        EffectString.indexOf('\t'),
        Effect2.Option.getOrElse(() => -1),
      );
      if (tab < 0) return yield* fail('invalid-snapshot', 'Git returned an unsupported tree entry.');
      const file = Effect2.pipe(record, EffectString.slice(tab + 1));
      if (!requested.has(file)) continue;
      const [mode, type, blob] = Effect2.pipe(record, EffectString.slice(0, tab), EffectString.split(' '));
      if (
        !mode ||
        !cycleTreeModes.has(mode) ||
        type !== (mode === '160000' ? 'commit' : 'blob') ||
        !blob ||
        !objectId.test(blob)
      )
        return yield* fail('invalid-snapshot', 'Git returned an unsupported tree entry.');
      if (seen.has(file)) return yield* fail('invalid-snapshot', 'Git returned duplicate exact tree entries.');
      seen.add(file);
      entries[file] = {mode, blob};
    }
  }
  return entries;
});

/** Read one exact Git tree entry, including its executable/symlink/submodule mode. */
export const readNativeCycleTreeEntry = Effect.fn('workflowAutomation.cycle.readTreeEntry')(function* (
  repo: string,
  reference: string,
  file: string,
) {
  const entries = yield* readNativeCycleTreeEntries(repo, reference, [file]);
  return entries[file];
});

const canonicalRepo = Effect.fn('workflowAutomation.cycle.canonicalRepo')(function* (repo: string) {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.realPath(repo);
  const reported = Effect2.pipe(yield* git(root, ['rev-parse', '--show-toplevel']), EffectString.trim);
  const canonicalReported = yield* fs.realPath(reported);
  if (canonicalReported !== root) {
    const requestedAuthority = yield* readPathFileSystemAuthority(root, 'Directory');
    const reportedAuthority = yield* readPathFileSystemAuthority(canonicalReported, 'Directory');
    if (
      Option.isNone(requestedAuthority) ||
      Option.isNone(reportedAuthority) ||
      !sameFileSystemIdentity(requestedAuthority.value, reportedAuthority.value)
    )
      return yield* fail('binding-drift', 'Cycle Git operations must use the bound repository root.');
  }
  return canonicalReported;
});

/** A private index captures worktree bytes; the contributor's index is never written. */
export const captureNativeCycleSource = Effect.fn('workflowAutomation.cycle.captureSource')(function* (
  repo: string,
  base: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* canonicalRepo(repo);
  const head = yield* resolveObject(root, 'HEAD', 'commit');
  const baseTree = yield* resolveObject(root, base, 'tree');
  if ((yield* git(root, ['ls-files', '--unmerged', '-z'])).length)
    return yield* fail('unmerged-index', 'Resolve index conflicts before taking a cycle snapshot.');
  const status = yield* git(root, ['status', '--porcelain=v2', '-z', '--ignore-submodules=none']);
  const statusRecords = Effect2.pipe(status, EffectString.split('\0'));
  for (let index = 0; index < statusRecords.length; index++) {
    const record = statusRecords[index];
    if (!record) continue;
    const renamed = Effect2.pipe(record, EffectString.startsWith('2 '));
    if (renamed) index++; // porcelain-v2 -z stores the original path in the next NUL record
    if (!Effect2.pipe(record, EffectString.startsWith('1 ')) && !renamed) continue;
    // oxlint-disable-next-line effecttsgo/prefer-effect-string -- The native split limit truncates results; Effect String split has no limit parameter.
    const submodule = record.split(' ', 4)[2];
    if (
      Effect2.pipe(submodule, effectOptionalString =>
        effectOptionalString == null ? undefined : Effect2.pipe(effectOptionalString, EffectString.startsWith('S')),
      ) &&
      Effect2.pipe(submodule, EffectString.slice(2)) !== '..'
    )
      return yield* fail('dirty-submodule', 'Run a separate cycle for dirty submodule content.');
  }
  const indexName = Effect2.pipe(yield* git(root, ['rev-parse', '--git-path', 'index']), EffectString.trim);
  const realIndex = path.isAbsolute(indexName) ? indexName : path.resolve(root, indexName);
  if (Option.isSome(yield* fs.readLink(realIndex).pipe(Effect.option)))
    return yield* fail('unsafe-index', 'Cycle snapshots do not follow a symbolic contributor index.');
  const originalIndex = (yield* fs.exists(realIndex)) ? yield* fs.readFile(realIndex) : undefined;
  const captured = yield* Effect.scoped(
    Effect.gen(function* () {
      const temporary = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-cycle-index-'});
      const index = path.join(temporary, 'index');
      if (originalIndex) yield* fs.writeFile(index, originalIndex, {mode: 0o600, flag: 'wx'});
      yield* git(root, ['add', '--all', '--', '.'], index);
      yield* git(root, ['add', '--renormalize', '--all', '--', '.'], index);
      const tree = Effect2.pipe(yield* git(root, ['write-tree'], index), EffectString.trim);
      if (!objectId.test(tree)) return yield* fail('invalid-snapshot', 'Git did not return a snapshot tree.');
      const raw = EffectArray.filter(
        Effect2.pipe(
          yield* git(root, ['diff', '--raw', '--no-renames', '--abbrev=64', '-z', baseTree, tree, '--']),
          EffectString.split('\0'),
        ),
        Boolean,
      );
      if (raw.length % 2 !== 0 || raw.length > 16_384)
        return yield* fail('snapshot-capacity', 'Snapshot changes exceed the bounded file manifest.');
      const files: Record<string, string> = Object.create(null);
      const entries: Record<string, {mode: string; blob: string}> = Object.create(null);
      for (let index = 0; index < raw.length; index += 2) {
        const header = Effect2.pipe(raw[index], EffectString.split(' '));
        const file = raw[index + 1];
        const newMode = header[1];
        const blob = header[3];
        if (
          !nativeCycleRelativePath(file) ||
          !newMode ||
          (newMode !== absentTreeMode && !cycleTreeModes.has(newMode)) ||
          !blob ||
          !objectId.test(blob) ||
          EffectRecord.has(files, file)
        )
          return yield* fail('invalid-snapshot', 'Git returned an unsupported changed path or blob identity.');
        files[file] = blob;
        entries[file] = {mode: newMode, blob};
      }
      return {head, tree, files, entries} satisfies WorkflowSourceSnapshot & {
        readonly entries: Readonly<Record<string, {readonly mode: string; readonly blob: string}>>;
      };
    }),
  );
  const currentIndex = (yield* fs.exists(realIndex)) ? yield* fs.readFile(realIndex) : undefined;
  if (
    (originalIndex === undefined) !== (currentIndex === undefined) ||
    (originalIndex && currentIndex && sha256HexSync(originalIndex) !== sha256HexSync(currentIndex)) ||
    (yield* resolveObject(root, 'HEAD', 'commit')) !== head
  )
    return yield* fail('source-drift', 'The contributor index or HEAD changed during snapshot capture.');
  return {...captured, baseTree, repo: root};
});

export const pinNativeCycleTree = Effect.fn('workflowAutomation.cycle.pinTree')(function* (
  repo: string,
  bindingId: string,
  snapshotId: string,
  tree: string,
  purpose: 'snapshot' | 'baseline' = 'snapshot',
) {
  if (!/^[a-f0-9]{64}$/u.test(bindingId) || !objectId.test(tree))
    return yield* fail('invalid-snapshot', 'Snapshot pin identity is invalid.');
  const reference = `refs/threadnote/cycles/${purpose}/${sha256HexSync(JSON.stringify([bindingId, purpose, snapshotId]))}`;
  const existing = yield* runCommandEffect(
    'git',
    ['--no-optional-locks', '-C', repo, 'show-ref', '--verify', '--hash', reference],
    {allowFailure: true, timeoutMs: 10_000, maxOutputBytes: 4096},
  );
  if (existing.exitCode === 0) {
    if (Effect2.pipe(existing.stdout, EffectString.trim) !== tree)
      return yield* fail('snapshot-conflict', 'This immutable snapshot ID already pins another tree.');
    return reference;
  }
  if (existing.exitCode !== 1 && existing.exitCode !== 128)
    return yield* fail('invalid-snapshot', 'The snapshot reference could not be inspected.');
  // oxlint-disable-next-line effecttsgo/prefer-effect-string -- The runtime count is not proven nonnegative; native repeat throws RangeError for negative counts while Effect String repeat returns an empty string.
  yield* git(repo, ['update-ref', reference, tree, '0'.repeat(tree.length)]);
  return reference;
});

export const makeWorkflowGitAdapter = Effect.fn('workflowAutomation.cycle.gitAdapter')(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const services = (yield* Effect.context<FileSystem.FileSystem | Path.Path | CommandExecutor>()).pipe(
    Context.pick(FileSystem.FileSystem, Path.Path, CommandExecutor),
  );
  return WorkflowGit.of({
    snapshot: (repo, base) =>
      captureNativeCycleSource(repo, base).pipe(Effect.provideContext(services), Effect.mapError(nativeWorkflowError)),
    inspect: (repo, paths) =>
      Effect.gen(function* () {
        if (!paths.length || paths.length > 128 || new Set(paths).size !== paths.length)
          return yield* fail('invalid-scope', 'Inspect between one and128unique source paths.');
        const root = yield* canonicalRepo(repo);
        const files: Record<string, string> = Object.create(null);
        for (const file of paths) {
          if (!nativeCycleRelativePath(file)) return yield* fail('invalid-scope', 'Source paths must be relative.');
          const target = path.join(root, file);
          if (Option.isSome(yield* fs.readLink(target).pipe(Effect.option)))
            return yield* fail('invalid-scope', 'Source inspection requires regular files.');
          const actual = yield* fs.realPath(target);
          const stat = yield* fs.stat(actual);
          if (
            !Effect2.pipe(actual, EffectString.startsWith(root + path.sep)) ||
            stat.type !== 'File' ||
            Number(stat.size) > 1_000_000
          )
            return yield* fail('invalid-scope', 'Source inspection requires bounded files inside the checkout.');
          const bytes = yield* fs.readFile(actual);
          if (bytes.byteLength > 1_000_000)
            return yield* fail('invalid-scope', 'Source bytes changed beyond their admitted limit.');
          files[file] = sha256HexSync(bytes);
        }
        return {
          head: yield* resolveObject(root, 'HEAD', 'commit'),
          tree: yield* resolveObject(root, 'HEAD', 'tree'),
          files,
        };
      }).pipe(Effect.provideContext(services), Effect.mapError(nativeWorkflowError)),
  });
});
