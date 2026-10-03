import {Effect, FileSystem, Path, PlatformError, Result, Schema} from 'effect';
import {
  inspectContainedStableRegularFile,
  readBoundedContainedStableRegularFile,
} from '@threadnote/graph/inventory/contained_file';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {scanFilesWithinBoundary} from '@threadnote/platform/safe_scan';
import {uriSegment} from '@threadnote/workspace/manifest';
import {validatePortableSegment} from '@threadnote/store/resource-id';
import type {MemoryKind, MemoryStatus} from '@threadnote/memory/types';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {memoryHeaderValue, parseMemoryDocument, type MemoryRecord} from '@threadnote/memory/document';
import {localUserMemoriesRoot} from '../migrations.js';

const MAINTENANCE_READ_CONCURRENCY = 16;
const PERSONAL_PROJECT_READ_CONCURRENCY = 4;
const PERSONAL_PROJECT_FILE_LIMIT = 10_000;
const PERSONAL_PROJECT_FILE_BYTE_LIMIT = 8 * 1_024 * 1_024;
const PERSONAL_PROJECT_TOTAL_BYTE_LIMIT = 128 * 1_024 * 1_024;

class PersonalProjectReadError extends Schema.TaggedError<PersonalProjectReadError>()('PersonalProjectReadError', {
  cause: Schema.optionalKey(Schema.Defect()),
  message: Schema.String,
}) {}

/** Read canonical active records for one project without synchronizing or mutating storage. */
export const readActiveProjectMemoryRecords = Effect.fn('memory.readActiveProjectRecords')(function* (
  config: RuntimeConfig,
  project: string,
) {
  const records = yield* readMaintenanceMemoryRecords(config);
  return records.filter(record => record.metadata.status === 'active' && record.metadata.project === project);
});

/** Read active personal records without including local copies of shared team memories. */
export const readActivePersonalProjectMemoryRecords = Effect.fn('memory.readActivePersonalProjectRecords')(function* (
  config: RuntimeConfig,
  project: string,
) {
  const records = yield* readPersonalProjectMemoryRecords(config, project);
  return records.filter(record => record.metadata.status === 'active');
});

export const readPersonalProjectMemoryRecords = Effect.fn('memory.readPersonalProjectRecords')(function* (
  config: RuntimeConfig,
  project: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* localUserMemoriesRoot(config);
  const directorySnapshots: Array<{readonly directory: string; readonly entries: readonly string[] | undefined}> = [];
  const selectedEntries: Array<{
    readonly location: PersonalProjectLocation;
    readonly name: string;
    readonly relative: string;
  }> = [];
  let canonicalRoot: string | undefined;
  let filesRead = 0;
  let inspectedBytes = 0;
  for (const location of personalProjectLocations(uriSegment(project))) {
    const directory = path.join(root, ...location.relativeDirectory);
    const before = yield* canonicalDirectoryEntries(fs, directory);
    directorySnapshots.push({directory, entries: before});
    if (before === undefined) {
      continue;
    }
    for (const name of before) {
      if (!name.endsWith('.md') || name.startsWith('.')) continue;
      const nextFilesRead = admitPersonalProjectFileCount(filesRead);
      if (Result.isFailure(nextFilesRead)) return yield* personalProjectReadError(nextFilesRead.failure);
      filesRead = nextFilesRead.success;
      const relative = [...location.relativeDirectory, name].join('/');
      selectedEntries.push({location, name, relative});
    }
  }
  if (selectedEntries.length > 0) {
    canonicalRoot = yield* fs.realPath(root);
  }
  const admittedEntries = yield* Effect.forEach(
    selectedEntries,
    selected =>
      inspectContainedStableRegularFile(fs, path, canonicalRoot!, selected.relative).pipe(
        Effect.map(inspected => ({...selected, size: inspected.size})),
      ),
    {concurrency: PERSONAL_PROJECT_READ_CONCURRENCY},
  );
  for (const selected of admittedEntries) {
    const nextInspectedBytes = admitPersonalProjectBytes(inspectedBytes, selected.size);
    if (Result.isFailure(nextInspectedBytes)) return yield* personalProjectReadError(nextInspectedBytes.failure);
    inspectedBytes = nextInspectedBytes.success;
  }
  const selectedFiles = yield* Effect.forEach(
    admittedEntries,
    selected =>
      Effect.gen(function* () {
        const bytes = yield* readBoundedContainedStableRegularFile(
          fs,
          path,
          canonicalRoot!,
          selected.relative,
          PERSONAL_PROJECT_FILE_BYTE_LIMIT,
        );
        if (bytes.byteLength !== selected.size) {
          return yield* personalProjectReadError('Personal project memory content changed during the snapshot read.');
        }
        const contentHash = sha256HexSync(bytes);
        const content = yield* Effect.try({
          try: () => new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(bytes),
          catch: cause => personalProjectReadError('Personal project memory is not valid UTF-8.', cause),
        });
        const uri = `threadnote://user/${uriSegment(config.user)}/memories/${selected.relative}`;
        const record = parseMemoryDocument(uri, content);
        if (
          record === undefined ||
          record.metadata.kind !== selected.location.kind ||
          record.metadata.project !== project ||
          record.metadata.status !== selected.location.status ||
          !selected.location.headerTitles.includes(record.headerTitle) ||
          !hasPersonalVisibility(record.content) ||
          !hasCanonicalPersonalFilename(record, selected.name, selected.location.topicBoundFilename)
        ) {
          return yield* personalProjectReadError(
            `Personal project memory path and metadata do not agree: ${selected.relative}`,
          );
        }
        return {contentHash, record, relative: selected.relative};
      }),
    {concurrency: PERSONAL_PROJECT_READ_CONCURRENCY},
  );
  for (const snapshot of directorySnapshots) {
    const after = yield* canonicalDirectoryEntries(fs, snapshot.directory);
    if (
      (snapshot.entries === undefined && after !== undefined) ||
      (snapshot.entries !== undefined && (after === undefined || !sameEntries(snapshot.entries, after)))
    ) {
      return yield* personalProjectReadError('Personal project memory directory changed.');
    }
  }
  if (selectedFiles.length > 0 && canonicalRoot === undefined) {
    return yield* personalProjectReadError('Personal project memory root could not be observed.');
  }
  yield* Effect.forEach(
    selectedFiles,
    selected =>
      Effect.gen(function* () {
        const observed = yield* readBoundedContainedStableRegularFile(
          fs,
          path,
          canonicalRoot!,
          selected.relative,
          PERSONAL_PROJECT_FILE_BYTE_LIMIT,
        );
        if (sha256HexSync(observed) !== selected.contentHash) {
          return yield* personalProjectReadError('Personal project memory content changed during the snapshot read.');
        }
      }),
    {concurrency: PERSONAL_PROJECT_READ_CONCURRENCY, discard: true},
  );
  return selectedFiles.map(selected => selected.record).sort((left, right) => left.uri.localeCompare(right.uri));
});

/** Read every canonical memory document for maintenance evidence, including inactive relation targets. */
export const readMaintenanceMemoryRecords = Effect.fn('memory.readMaintenanceRecords')(function* (
  config: RuntimeConfig,
  options: {readonly personalOnly?: boolean; readonly requireReadable?: boolean} = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* localUserMemoriesRoot(config);
  const files = yield* scanFilesWithinBoundary(fs, root, root, {
    includeDirectory: directory => {
      if (options.personalOnly !== true) return true;
      const relative = path.relative(root, directory);
      return relative.split(path.sep)[0] !== 'shared';
    },
    includeFile: (_filePath, name) => name.endsWith('.md') && !name.startsWith('.'),
    recursive: true,
  });
  const records = yield* Effect.forEach(
    files,
    file =>
      Effect.gen(function* () {
        const content = yield* fs.readFileString(file.path);
        const relative = path.relative(root, file.path).split(path.sep).join('/');
        const record = parseMemoryDocument(
          `threadnote://user/${uriSegment(config.user)}/memories/${relative}`,
          content,
        );
        if (record === undefined && options.requireReadable === true && !relative.startsWith('shared/')) {
          return yield* personalProjectReadError(
            'Maintenance corpus contains an unreadable memory; absence cannot be inferred.',
          );
        }
        return record;
      }),
    {concurrency: MAINTENANCE_READ_CONCURRENCY},
  );
  return records
    .filter((record): record is MemoryRecord => record !== undefined)
    .sort((left, right) => left.uri.localeCompare(right.uri));
});

interface PersonalProjectLocation {
  readonly headerTitles: readonly MemoryRecord['headerTitle'][];
  readonly kind: Extract<MemoryKind, 'durable' | 'handoff' | 'incident'>;
  readonly relativeDirectory: readonly string[];
  readonly status: MemoryStatus;
  readonly topicBoundFilename: boolean;
}

function personalProjectLocations(project: string): readonly PersonalProjectLocation[] {
  const locations: PersonalProjectLocation[] = [
    {
      headerTitles: ['MEMORY'],
      kind: 'durable',
      relativeDirectory: ['durable', 'projects', project],
      status: 'active',
      topicBoundFilename: true,
    },
    {
      headerTitles: ['HANDOFF', 'MEMORY'],
      kind: 'handoff',
      relativeDirectory: ['handoffs', 'active', project],
      status: 'active',
      topicBoundFilename: true,
    },
    {
      headerTitles: ['MEMORY'],
      kind: 'incident',
      relativeDirectory: ['incidents', 'active', project],
      status: 'active',
      topicBoundFilename: true,
    },
  ];
  for (const status of ['archived', 'expired', 'superseded'] as const) {
    locations.push(
      {
        headerTitles: ['MEMORY'],
        kind: 'durable',
        relativeDirectory: ['durable', status, project],
        status,
        topicBoundFilename: false,
      },
      {
        // Lifecycle migration preserved HANDOFF while current archival emits MEMORY.
        headerTitles: ['HANDOFF', 'MEMORY'],
        kind: 'handoff',
        relativeDirectory: ['handoffs', status, project],
        status,
        topicBoundFilename: false,
      },
      {
        headerTitles: ['MEMORY'],
        kind: 'incident',
        relativeDirectory: ['incidents', status, project],
        status,
        topicBoundFilename: false,
      },
    );
  }
  return locations;
}

const canonicalDirectoryEntries = Effect.fn('memory.personalProjectDirectoryEntries')(function* (
  fs: FileSystem.FileSystem,
  directory: string,
) {
  const stat = yield* fs.stat(directory).pipe(Effect.result);
  if (Result.isFailure(stat)) {
    if (isNotFound(stat.failure)) return undefined;
    return yield* stat.failure;
  }
  if (stat.success.type !== 'Directory') {
    return yield* personalProjectReadError(`Personal project memory path is not a directory: ${directory}`);
  }
  const link = yield* fs.readLink(directory).pipe(Effect.result);
  if (Result.isSuccess(link)) {
    return yield* personalProjectReadError(`Personal project memory directory is symbolic: ${directory}`);
  }
  if (!isMissingOrNonLink(link.failure)) return yield* link.failure;
  return [...(yield* fs.readDirectory(directory))].sort(compareText);
});

function isNotFound(error: PlatformError.PlatformError): boolean {
  return error.reason._tag === 'NotFound';
}

function isMissingOrNonLink(error: PlatformError.PlatformError): boolean {
  if (isNotFound(error)) return true;
  if (error.reason._tag !== 'Unknown' || !('cause' in error.reason)) return false;
  const cause = error.reason.cause;
  return (
    typeof cause === 'object' &&
    cause !== null &&
    'code' in cause &&
    (cause as {readonly code?: unknown}).code === 'EINVAL'
  );
}

function sameEntries(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((entry, index) => entry === right[index]);
}

function hasCanonicalPersonalFilename(record: MemoryRecord, filename: string, topicBound: boolean): boolean {
  if (!filename.endsWith('.md')) return false;
  const basename = filename.slice(0, -'.md'.length);
  const topic = record.metadata.topic;
  try {
    validatePortableSegment(basename, basename);
  } catch {
    return false;
  }
  return !topicBound || (topic !== undefined && filename === `${uriSegment(topic)}.md`);
}

function hasPersonalVisibility(content: string): boolean {
  const normalized = content.replace(/\r\n?/gu, '\n');
  const separatorIndex = normalized.indexOf('\n\n');
  const header = separatorIndex === -1 ? normalized : normalized.slice(0, separatorIndex);
  const visibility = memoryHeaderValue(header, 'visibility');
  return visibility === undefined || visibility === 'personal';
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function personalProjectReadError(message: string, cause?: unknown): PersonalProjectReadError {
  return PersonalProjectReadError.make({message, ...(cause === undefined ? {} : {cause})});
}

export function admitPersonalProjectFileCount(filesRead: number): Result.Result<number, string> {
  const nextFilesRead = filesRead + 1;
  return nextFilesRead > PERSONAL_PROJECT_FILE_LIMIT
    ? Result.fail('Personal project memory file limit exceeded.')
    : Result.succeed(nextFilesRead);
}

export function admitPersonalProjectBytes(inspectedBytes: number, size: number): Result.Result<number, string> {
  if (size > PERSONAL_PROJECT_FILE_BYTE_LIMIT) {
    return Result.fail('Personal project memory file byte limit exceeded.');
  }
  const nextInspectedBytes = inspectedBytes + size;
  return nextInspectedBytes > PERSONAL_PROJECT_TOTAL_BYTE_LIMIT
    ? Result.fail('Personal project memory byte limit exceeded.')
    : Result.succeed(nextInspectedBytes);
}
