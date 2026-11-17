import {Array as EffectArray} from 'effect';
import {Clock, Context, Effect, FileSystem, Option, Path} from 'effect';
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
import type {NativeCycleBaseRequalificationInput} from '@threadnote/workflow-automations/cycle-review';
import {
  readPathFileSystemAuthority,
  runtimePlatform,
  sameFileSystemIdentity,
  SystemInfo,
} from '@threadnote/platform/system';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

const fail = (code: string, message: string) => WorkflowAutomationError.make({code, message});
const objectId = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const outputLimit = 4 * 1_048_576;
const snapshotPathLimit = 8192;
const stagingTimeoutMs = 120_000;
const recentIndexCtimeWindowSeconds = 2;
const targetedRenormalizePathLimit = 512;
const gitIndexHeaderBytes = 12;
const gitIndexSignature = Uint8Array.of(0x44, 0x49, 0x52, 0x43); // DIRC
const gitIndexEntryStatBytes = 40;
const gitIndexFlagsBytes = 2;
const gitIndexOptionalExtensionHeaderBytes = 8;
const gitIndexExtendedFlag = 0x4000;
const gitIndexHiddenOrUnmergedMask = 0xb000;
const gitIndexIntentToAddExtendedFlag = 0x2000;
const gitIndexNameLengthMask = 0x0fff;
const gitIndexMaxPathBytes = 4096;
const statVerificationGitConfig = [
  '-c',
  'core.trustctime=true',
  '-c',
  'core.checkStat=default',
  '-c',
  'core.ignoreStat=false',
  '-c',
  'core.fsmonitor=false',
] as const;

type GitIndexStagingPlan =
  {readonly mode: 'full-renormalize'} | {readonly mode: 'targeted'; readonly renormalizePaths: readonly string[]};

function isGitAttributesPath(value: string): boolean {
  const lower = Effect2.pipe(value, EffectString.toLowerCase);
  return lower === '.gitattributes' || Effect2.pipe(lower, EffectString.endsWith('/.gitattributes'));
}

function porcelainRecordPath(record: string, spaceCount: number): string | undefined {
  let rest = record;
  for (let count = 0; count < spaceCount; count++) {
    const space = Effect2.pipe(
      rest,
      EffectString.indexOf(' '),
      Option.getOrElse(() => -1),
    );
    if (space < 0) return undefined;
    rest = Effect2.pipe(rest, EffectString.slice(space + 1));
  }
  return rest.length > 0 ? rest : undefined;
}

function decodeGitIndexVarint(
  bytes: Uint8Array,
  start: number,
  end: number,
): {readonly nextOffset: number; readonly value: number} | undefined {
  let offset = start;
  if (offset >= end) return undefined;
  let byte = bytes[offset++];
  let value = byte & 0x7f;
  while ((byte & 0x80) !== 0) {
    if (offset >= end || value > Math.floor(Number.MAX_SAFE_INTEGER / 128) - 1) return undefined;
    byte = bytes[offset++];
    value = (value + 1) * 128 + (byte & 0x7f);
  }
  return {nextOffset: offset, value};
}

function validGitIndexTrailer(index: Uint8Array, contentEnd: number, objectFormat: 'sha1' | 'sha256'): boolean {
  const trailer = index.subarray(contentEnd);
  let allZero = true;
  for (let offset = 0; offset < trailer.byteLength; offset++) {
    if (trailer[offset] !== 0) {
      allZero = false;
      break;
    }
  }
  if (allZero) return true;
  const actual = new Bun.CryptoHasher(objectFormat).update(index.subarray(0, contentEnd)).digest();
  if (actual.byteLength !== trailer.byteLength) return false;
  for (let offset = 0; offset < trailer.byteLength; offset++) {
    if (actual[offset] !== trailer[offset]) return false;
  }
  return true;
}

function walkGitIndex(
  index: Uint8Array,
  objectFormat: 'sha1' | 'sha256',
  verifyTrailer: boolean,
  onEntry: (ctimeSec: number, mode: number, flags: number, extendedFlags: number, pathBytes: Uint8Array) => boolean,
): boolean {
  const objectIdBytes = objectFormat === 'sha1' ? 20 : 32;
  if (index.byteLength < gitIndexHeaderBytes + objectIdBytes) return false;
  for (let offset = 0; offset < gitIndexSignature.byteLength; offset++) {
    if (index[offset] !== gitIndexSignature[offset]) return false;
  }
  const view = new DataView(index.buffer, index.byteOffset, index.byteLength);
  const version = view.getUint32(4, false);
  if (version !== 2 && version !== 3 && version !== 4) return false;
  const entryCount = view.getUint32(8, false);
  const contentEnd = index.byteLength - objectIdBytes;

  const scratch = version === 4 ? new Uint8Array(gitIndexMaxPathBytes) : undefined;
  let previousPathLength = 0;
  let offset = gitIndexHeaderBytes;

  for (let entryIndex = 0; entryIndex < entryCount; entryIndex++) {
    const entryStart = offset;
    const flagsOffset = entryStart + gitIndexEntryStatBytes + objectIdBytes;
    if (flagsOffset + gitIndexFlagsBytes > contentEnd) return false;
    const ctimeSec = view.getUint32(entryStart, false);
    const mode = view.getUint32(entryStart + 24, false);
    const flags = view.getUint16(flagsOffset, false);
    offset = flagsOffset + gitIndexFlagsBytes;
    let extendedFlags = 0;
    if ((flags & gitIndexExtendedFlag) !== 0) {
      if (version === 2 || offset + 2 > contentEnd) return false;
      extendedFlags = view.getUint16(offset, false);
      offset += 2;
    }

    let pathBytes: Uint8Array<ArrayBufferLike>;
    if (version === 4) {
      const decoded = decodeGitIndexVarint(index, offset, contentEnd);
      if (decoded === undefined || decoded.value > previousPathLength) return false;
      offset = decoded.nextOffset;
      const terminator = index.indexOf(0, offset);
      if (terminator < 0 || terminator >= contentEnd) return false;
      const suffix = index.subarray(offset, terminator);
      const prefixLength = previousPathLength - decoded.value;
      const pathLength = prefixLength + suffix.byteLength;
      if (pathLength > gitIndexMaxPathBytes) return false;
      scratch!.set(suffix, prefixLength);
      pathBytes = scratch!.subarray(0, pathLength);
      previousPathLength = pathLength;
      offset = terminator + 1;
    } else {
      const terminator = index.indexOf(0, offset);
      if (terminator < 0 || terminator >= contentEnd) return false;
      pathBytes = index.subarray(offset, terminator);
      const entryBytes = terminator + 1 - entryStart;
      const paddedEntryBytes = Math.ceil(entryBytes / 8) * 8;
      offset = entryStart + paddedEntryBytes;
      if (offset > contentEnd) return false;
      for (let pad = terminator + 1; pad < offset; pad++) {
        if (index[pad] !== 0) return false;
      }
    }

    const declaredPathBytes = flags & gitIndexNameLengthMask;
    if (declaredPathBytes !== gitIndexNameLengthMask && declaredPathBytes !== pathBytes.byteLength) return false;
    if (!onEntry(ctimeSec, mode, flags, extendedFlags, pathBytes)) return false;
  }

  while (offset < contentEnd) {
    if (offset + gitIndexOptionalExtensionHeaderBytes > contentEnd) return false;
    const sig0 = index[offset];
    const extensionBytes = view.getUint32(offset + 4, false);
    const extensionEnd = offset + gitIndexOptionalExtensionHeaderBytes + extensionBytes;
    if (extensionEnd > contentEnd) return false;
    if (sig0 < 0x41 || sig0 > 0x5a) return false;
    offset = extensionEnd;
  }
  if (offset !== contentEnd) return false;
  return !verifyTrailer || validGitIndexTrailer(index, contentEnd, objectFormat);
}

function inspectGitIndexForRenormalizeTargets(
  index: Uint8Array,
  objectFormat: 'sha1' | 'sha256',
  recentCtimeFloorSec: number,
): readonly string[] | undefined {
  const decoder = new TextDecoder('utf-8', {fatal: true});
  const recentPaths: string[] = [];
  const ok = walkGitIndex(index, objectFormat, true, (ctimeSec, mode, flags, extendedFlags, pathBytes) => {
    if ((flags & gitIndexHiddenOrUnmergedMask) !== 0 || (extendedFlags & ~gitIndexIntentToAddExtendedFlag) !== 0)
      return false;
    if ((mode === 0o100644 || mode === 0o100755) && ctimeSec >= recentCtimeFloorSec) {
      if (recentPaths.length >= targetedRenormalizePathLimit) return false;
      try {
        const decoded = decoder.decode(pathBytes);
        if (!nativeCycleRelativePath(decoded)) return false;
        recentPaths.push(decoded);
      } catch {
        return false;
      }
    }
    return true;
  });
  return ok ? recentPaths : undefined;
}

const gitConfigFalse = (value: string) =>
  EffectArray.contains(['', '0', 'false', 'no', 'off'], Effect2.pipe(value, EffectString.toLowerCase));
const outOfTreeAttributesByteLimit = 65_536;
const blobNeutralAttributes = new Set([
  'conflict-marker-size',
  'delta',
  'diff',
  'encoding',
  'export-ignore',
  'export-subst',
  'merge',
  'whitespace',
]);

/** Diff, merge and export attributes leave staged blob bytes alone; any other attribute may normalize them. */
function attributesMayNormalize(content: string): boolean {
  for (const line of Effect2.pipe(content, EffectString.split('\n'))) {
    const fields = EffectArray.filter(Effect2.pipe(line, EffectString.trim, EffectString.split(/\s+/u)), Boolean);
    if (fields.length === 0 || Effect2.pipe(fields[0], EffectString.startsWith('#'))) continue;
    for (const field of fields.slice(1)) {
      const name = Effect2.pipe(field, EffectString.replace(/^[-!]/u, ''), EffectString.split('='))[0];
      if (!blobNeutralAttributes.has(name) && !Effect2.pipe(name, EffectString.startsWith('linguist-'))) return true;
    }
  }
  return false;
}

/** An attributes file outside the index that may change normalization; unreadable files count as changing it. */
const outOfTreeAttributesMayNormalize = Effect.fn('workflowAutomation.cycle.outOfTreeAttributes')(function* (
  file: string,
) {
  const fs = yield* FileSystem.FileSystem;
  if (!(yield* fs.exists(file).pipe(Effect.orElseSucceed(() => true)))) return false;
  const info = yield* fs.stat(file).pipe(Effect.option);
  if (Option.isNone(info) || info.value.type !== 'File' || Number(info.value.size) > outOfTreeAttributesByteLimit)
    return true;
  const content = yield* fs.readFileString(file).pipe(Effect.option);
  return Option.isNone(content) || attributesMayNormalize(content.value);
});

/** Effective config in one read; a system-scope origin locates the sibling system attributes file. */
const readGitNormalizationConfig = Effect.fn('workflowAutomation.cycle.readNormalizationConfig')(function* (
  repo: string,
) {
  const result = yield* runCommandEffect(
    'git',
    ['--no-optional-locks', '-C', repo, 'config', '-z', '--list', '--show-scope', '--show-origin'],
    {allowFailure: true, maxOutputBytes: outputLimit, timeoutMs: 10_000},
  );
  const fields = Effect2.pipe(result.stdout, EffectString.split('\0'));
  if (result.exitCode !== 0 || fields.length % 3 !== 1 || fields.at(-1) !== '') return undefined;
  const values = new Map<string, string>();
  const systemFiles: string[] = [];
  for (let offset = 0; offset + 3 < fields.length; offset += 3) {
    const [scope, origin, entry] = [fields[offset], fields[offset + 1], fields[offset + 2]];
    const separator = Effect2.pipe(
      entry,
      EffectString.indexOf('\n'),
      Option.getOrElse(() => -1),
    );
    // A key without "=" is an implicit boolean true.
    if (separator < 0) values.set(entry, 'true');
    else
      values.set(
        Effect2.pipe(entry, EffectString.slice(0, separator)),
        Effect2.pipe(entry, EffectString.slice(separator + 1)),
      );
    if (scope === 'system' && Effect2.pipe(origin, EffectString.startsWith('file:')))
      systemFiles.push(Effect2.pipe(origin, EffectString.slice(5)));
  }
  return {values, systemFiles};
});

const renormalizeIndexedPathBatches = Effect.fn('workflowAutomation.cycle.renormalizePathBatches')(function* (
  root: string,
  index: string,
  paths: readonly string[],
) {
  let offset = 0;
  while (offset < paths.length) {
    const batch: string[] = [];
    let argumentBytes = 0;
    while (offset < paths.length && batch.length < 128) {
      const spec = `:(literal)${paths[offset]}`;
      const size = new TextEncoder().encode(spec).byteLength + 1;
      if (batch.length && argumentBytes + size > 24_576) break;
      batch.push(spec);
      argumentBytes += size;
      offset++;
    }
    yield* git(root, [...statVerificationGitConfig, 'add', '--renormalize', '--', ...batch], index, stagingTimeoutMs);
  }
});

function filterTrackedRegularFilesInIndex(
  index: Uint8Array,
  objectFormat: 'sha1' | 'sha256',
  candidates: readonly string[],
): readonly string[] | undefined {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder('utf-8', {fatal: true});
  const wantedByLength = new Map<number, Set<string>>();
  for (const candidate of candidates) {
    const byteLength = encoder.encode(candidate).byteLength;
    let bucket = wantedByLength.get(byteLength);
    if (!bucket) {
      bucket = new Set<string>();
      wantedByLength.set(byteLength, bucket);
    }
    bucket.add(candidate);
  }
  const matched: string[] = [];
  const ok = walkGitIndex(index, objectFormat, false, (_ctimeSec, mode, flags, extendedFlags, pathBytes) => {
    if ((flags & gitIndexHiddenOrUnmergedMask) !== 0 || (extendedFlags & ~gitIndexIntentToAddExtendedFlag) !== 0) {
      return false;
    }
    if (mode !== 0o100644 && mode !== 0o100755) return true;
    const bucket = wantedByLength.get(pathBytes.byteLength);
    if (!bucket) return true;
    try {
      const decoded = decoder.decode(pathBytes);
      if (bucket.has(decoded)) matched.push(decoded);
      return true;
    } catch {
      return false;
    }
  });
  return ok ? matched : undefined;
}

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

const git = (repo: string, args: readonly string[], temporaryIndex?: string, timeoutMs = 30_000) =>
  runBinaryCommandEffect('git', ['--no-optional-locks', '-C', repo, ...args], {
    timeoutMs,
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
  const system = yield* Effect.serviceOption(SystemInfo);
  const platform = Option.match(system, {
    onNone: () => runtimePlatform,
    onSome: info => info.platform,
  });
  const objectFormat = head.length === 64 ? 'sha256' : 'sha1';
  // Status omits ignored files, yet Git still applies an ignored .gitattributes; --directory skips wholly ignored trees.
  // A failed probe leaves the attribute basis unknown, so it counts as drift.
  const ignoredGitAttributesProbe = git(root, [
    'ls-files',
    '--others',
    '--ignored',
    '--exclude-standard',
    '--directory',
    '-z',
    '--',
    ':(icase,glob).gitattributes',
    ':(icase,glob)**/.gitattributes',
  ]).pipe(
    Effect.map(ignored => EffectArray.some(Effect2.pipe(ignored, EffectString.split('\0')), isGitAttributesPath)),
    Effect.orElseSucceed(() => true),
  );
  const [status, hasIgnoredGitAttributes] = yield* Effect.all(
    [
      git(root, ['status', '--porcelain=v2', '-z', '--ignore-submodules=none', '--untracked-files=all']),
      platform === 'win32' ? Effect.succeed(true) : ignoredGitAttributesProbe,
    ],
    {concurrency: 2},
  );
  const statusRecords = Effect2.pipe(status, EffectString.split('\0'));
  let hasNormalizationBasisDrift = hasIgnoredGitAttributes;
  for (let index = 0; index < statusRecords.length; index++) {
    const record = statusRecords[index];
    if (!record) continue;
    if (Effect2.pipe(record, EffectString.startsWith('? '))) {
      if (!hasNormalizationBasisDrift && isGitAttributesPath(Effect2.pipe(record, EffectString.slice(2)))) {
        hasNormalizationBasisDrift = true;
      }
      continue;
    }
    const renamed = Effect2.pipe(record, EffectString.startsWith('2 '));
    let originalPath: string | undefined;
    if (renamed) {
      index++; // porcelain-v2 -z stores the original path in the next NUL record
      originalPath = statusRecords[index];
    }
    if (!Effect2.pipe(record, EffectString.startsWith('1 ')) && !renamed) continue;
    if (!hasNormalizationBasisDrift) {
      const currentPath = porcelainRecordPath(record, renamed ? 9 : 8);
      if (
        (currentPath !== undefined && isGitAttributesPath(currentPath)) ||
        (originalPath !== undefined && isGitAttributesPath(originalPath))
      ) {
        hasNormalizationBasisDrift = true;
      }
    }
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
  const gitPathLines = Effect2.pipe(
    yield* git(root, ['rev-parse', '--git-path', 'index', '--git-path', 'info/attributes']),
    EffectString.trimEnd,
    EffectString.split('\n'),
  );
  const indexName = gitPathLines[0] ? Effect2.pipe(gitPathLines[0], EffectString.trim) : '';
  const infoAttributesName = gitPathLines[1] ? Effect2.pipe(gitPathLines[1], EffectString.trim) : '';
  if (!indexName || !infoAttributesName)
    return yield* fail('invalid-snapshot', 'Git did not return expected repository metadata paths.');
  const realIndex = path.isAbsolute(indexName) ? indexName : path.resolve(root, indexName);
  const infoAttributesPath = path.isAbsolute(infoAttributesName)
    ? infoAttributesName
    : path.resolve(root, infoAttributesName);
  if (Option.isSome(yield* fs.readLink(realIndex).pipe(Effect.option)))
    return yield* fail('unsafe-index', 'Cycle snapshots do not follow a symbolic contributor index.');
  const captureStartSec = Math.floor((yield* Clock.currentTimeMillis) / 1000);
  const originalIndex = (yield* fs.exists(realIndex)) ? yield* fs.readFile(realIndex) : undefined;
  const realIndexStat = originalIndex ? yield* fs.stat(realIndex).pipe(Effect.option) : Option.none();
  if (!hasNormalizationBasisDrift) {
    const infoAttributesStat = yield* fs.stat(infoAttributesPath).pipe(Effect.option);
    if (
      Option.isSome(infoAttributesStat) &&
      (infoAttributesStat.value.type !== 'File' || Number(infoAttributesStat.value.size) > 0)
    ) {
      hasNormalizationBasisDrift = true;
    }
  }
  // CRLF conversion, an index that ignores ctime, or attributes outside the index need full renormalization.
  if (!hasNormalizationBasisDrift) {
    const config = yield* readGitNormalizationConfig(root);
    const environment = Option.getOrUndefined(Option.map(system, info => info.environment()));
    const autocrlf = config?.values.get('core.autocrlf');
    const trustCtime = config?.values.get('core.trustctime');
    const attributesFile = config?.values.get('core.attributesfile');
    const home = environment?.HOME;
    const xdgConfigHome = environment?.XDG_CONFIG_HOME;
    const configuredAttributes =
      attributesFile === undefined
        ? []
        : path.isAbsolute(attributesFile)
          ? [attributesFile]
          : home && Effect2.pipe(attributesFile, EffectString.startsWith('~/'))
            ? [path.join(home, Effect2.pipe(attributesFile, EffectString.slice(2)))]
            : undefined;
    hasNormalizationBasisDrift =
      config === undefined ||
      environment === undefined ||
      configuredAttributes === undefined ||
      (autocrlf !== undefined && !gitConfigFalse(autocrlf)) ||
      (trustCtime !== undefined && gitConfigFalse(trustCtime));
    for (const file of [
      ...(configuredAttributes ?? []),
      ...(xdgConfigHome ? [path.join(xdgConfigHome, 'git', 'attributes')] : []),
      ...(home ? [path.join(home, '.config', 'git', 'attributes')] : []),
      '/etc/gitattributes',
      ...EffectArray.map(config?.systemFiles ?? [], file => path.join(path.dirname(file), 'gitattributes')),
    ]) {
      if (hasNormalizationBasisDrift) break;
      hasNormalizationBasisDrift = yield* outOfTreeAttributesMayNormalize(file);
    }
  }
  const recentCtimeFloorSec = Math.max(0, captureStartSec - recentIndexCtimeWindowSeconds);
  const renormalizePaths =
    hasNormalizationBasisDrift || !originalIndex
      ? []
      : inspectGitIndexForRenormalizeTargets(originalIndex, objectFormat, recentCtimeFloorSec);
  let stagingPlan: GitIndexStagingPlan =
    hasNormalizationBasisDrift || renormalizePaths === undefined
      ? {mode: 'full-renormalize'}
      : {mode: 'targeted', renormalizePaths};
  if (stagingPlan.mode !== 'full-renormalize' && base !== 'HEAD') {
    const headTree = yield* resolveObject(root, head, 'tree');
    if (headTree !== baseTree) {
      const changedAttributes = yield* git(
        root,
        [
          'diff-tree',
          '-r',
          '--name-only',
          '-z',
          baseTree,
          headTree,
          '--',
          ':(icase,glob).gitattributes',
          ':(icase,glob)**/.gitattributes',
        ],
        undefined,
        stagingTimeoutMs,
      );
      if (changedAttributes.length > 0) stagingPlan = {mode: 'full-renormalize'};
    }
  }
  const captured = yield* Effect.scoped(
    Effect.gen(function* () {
      const temporary = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-cycle-index-'});
      const index = path.join(temporary, 'index');
      if (originalIndex) {
        yield* fs.writeFile(index, originalIndex, {mode: 0o600, flag: 'wx'});
        if (
          Option.isSome(realIndexStat) &&
          Option.isSome(realIndexStat.value.atime) &&
          Option.isSome(realIndexStat.value.mtime)
        ) {
          yield* fs.utimes(index, realIndexStat.value.atime.value, realIndexStat.value.mtime.value);
        }
      }
      yield* git(root, [...statVerificationGitConfig, 'add', '--all', '--', '.'], index, stagingTimeoutMs);
      if (stagingPlan.mode === 'full-renormalize') {
        yield* git(
          root,
          [...statVerificationGitConfig, 'add', '--renormalize', '--all', '--', '.'],
          index,
          stagingTimeoutMs,
        );
      } else if (stagingPlan.renormalizePaths.length > 0) {
        const stagedIndexBytes = (yield* fs.exists(index)) ? yield* fs.readFile(index) : undefined;
        const tracked = stagedIndexBytes
          ? filterTrackedRegularFilesInIndex(stagedIndexBytes, objectFormat, stagingPlan.renormalizePaths)
          : undefined;
        if (tracked === undefined)
          yield* git(
            root,
            [...statVerificationGitConfig, 'add', '--renormalize', '--all', '--', '.'],
            index,
            stagingTimeoutMs,
          );
        else {
          const livePaths: string[] = [];
          for (const recentPath of tracked) {
            const fullPath = path.join(root, recentPath);
            if (Option.isSome(yield* fs.readLink(fullPath).pipe(Effect.option))) continue;
            const stat = yield* fs.stat(fullPath).pipe(Effect.option);
            if (Option.isSome(stat) && stat.value.type === 'File') livePaths.push(recentPath);
          }
          yield* renormalizeIndexedPathBatches(root, index, livePaths);
        }
      }
      const tree = Effect2.pipe(yield* git(root, ['write-tree'], index, stagingTimeoutMs), EffectString.trim);
      if (!objectId.test(tree)) return yield* fail('invalid-snapshot', 'Git did not return a snapshot tree.');
      const raw = EffectArray.filter(
        Effect2.pipe(
          yield* git(
            root,
            ['diff', '--raw', '--no-renames', '--abbrev=64', '-z', baseTree, tree, '--'],
            undefined,
            stagingTimeoutMs,
          ),
          EffectString.split('\0'),
        ),
        Boolean,
      );
      if (raw.length % 2 !== 0) return yield* fail('invalid-snapshot', 'Git returned malformed raw diff path framing.');
      const changedPathCount = raw.length / 2;
      if (changedPathCount > snapshotPathLimit)
        return yield* fail(
          'snapshot-capacity',
          `Snapshot raw diff contains ${changedPathCount} changed paths, exceeding the ${snapshotPathLimit}-path limit. The bound is measured from the pinned cycle baseline tree (${baseTree}) to the captured worktree tree (${tree}); current HEAD is ${head}. Inspect the reported baseline, captured tree, and HEAD identities. Capture requires the complete baseline-relative delta to contain at most ${snapshotPathLimit} changed paths.`,
        );
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

export const pinNativeCycleCommit = Effect.fn('workflowAutomation.cycle.pinCommit')(function* (
  repo: string,
  bindingId: string,
  snapshotId: string,
  commit: string,
  purpose:
    'requalification-before' | 'requalification-after' | 'requalification-base' | 'snapshot-head' | 'snapshot-base',
) {
  if (
    !/^[a-f0-9]{64}$/u.test(bindingId) ||
    !objectId.test(commit) ||
    (yield* resolveObject(repo, commit, 'commit')) !== commit
  )
    return yield* fail('invalid-base-requalification', 'Retention requires exact commit identities.');
  const reference = `refs/threadnote/cycles/${purpose}/${sha256HexSync(JSON.stringify([bindingId, purpose, snapshotId]))}`;
  const existing = yield* runCommandEffect(
    'git',
    ['--no-optional-locks', '-C', repo, 'show-ref', '--verify', '--hash', reference],
    {
      allowFailure: true,
      timeoutMs: 10_000,
      maxOutputBytes: 4096,
    },
  );
  if (existing.exitCode === 0) {
    if (EffectString.trim(existing.stdout) !== commit)
      return yield* fail('snapshot-conflict', 'This immutable reference already pins another commit.');
    return reference;
  }
  if (existing.exitCode !== 1 && existing.exitCode !== 128)
    return yield* fail('invalid-base-requalification', 'The commit reference could not be inspected.');
  yield* git(repo, ['update-ref', reference, commit, EffectString.repeat(commit.length)('0')]);
  return reference;
});

export const nativeCycleIsAncestor = Effect.fn('workflowAutomation.cycle.isAncestor')(function* (
  repo: string,
  before: string,
  after: string,
) {
  const result = yield* runCommandEffect(
    'git',
    ['--no-optional-locks', '-C', repo, 'merge-base', '--is-ancestor', before, after],
    {
      allowFailure: true,
      timeoutMs: 30_000,
      maxOutputBytes: 4096,
    },
  );
  if (result.exitCode === 0) return true;
  if (result.exitCode === 1) return false;
  return yield* fail('invalid-base-requalification', 'Git could not verify source ancestry.');
});

export const verifyNativeCycleBaseRequalification = Effect.fn('workflowAutomation.cycle.verifyBaseRequalification')(
  function* (
    repo: string,
    priorHead: string,
    currentHead: string,
    declaredBaseHead: string,
    witness: NativeCycleBaseRequalificationInput,
  ) {
    if (
      witness.preRebaseHead !== priorHead ||
      witness.rebasedHead !== currentHead ||
      witness.ontoHead !== declaredBaseHead
    )
      return yield* fail(
        'invalid-base-requalification',
        'Use the exact reviewed predecessor, current HEAD and declared new base.',
      );
    for (const commit of new Set([priorHead, currentHead, declaredBaseHead]))
      if (
        (yield* resolveObject(repo, commit, 'commit').pipe(
          Effect.mapError(() => fail('invalid-base-requalification', 'A witnessed commit is unavailable.')),
        )) !== commit
      )
        return yield* fail('invalid-base-requalification', 'Every witnessed commit must resolve exactly.');
    if (
      (yield* nativeCycleIsAncestor(repo, priorHead, currentHead)) ||
      !(yield* nativeCycleIsAncestor(repo, declaredBaseHead, currentHead))
    )
      return yield* fail(
        'invalid-base-requalification',
        'Requalification requires rewritten source descended from its declared new base.',
      );
    const common = EffectString.trim(
      yield* git(repo, ['merge-base', priorHead, declaredBaseHead]).pipe(
        Effect.mapError(() => fail('invalid-base-requalification', 'Keep a common repository history.')),
      ),
    );
    if (!objectId.test(common))
      return yield* fail('invalid-base-requalification', 'Git did not return a common repository history.');
  },
);

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
