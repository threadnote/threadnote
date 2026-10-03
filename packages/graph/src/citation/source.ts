import {Effect, FileSystem, Option, Path, Schema} from 'effect';
import {runBinaryCommandEffect} from '@threadnote/platform/command';
import {SystemInfo} from '@threadnote/platform/system';
import {codeGraphCommittedContentHash, codeGraphFileContentHashMatchesBytes} from '../content_identity.js';
import {inspectContainedStableRegularFile, materializeContainedStableRegularFile} from '../inventory/contained_file.js';
import type {RepositoryIdentity} from '../types.js';

const CODE_GRAPH_CITATION_SOURCE_MAXIMUM_FILES = 256;
const CODE_GRAPH_CITATION_SOURCE_MAXIMUM_FILE_BYTES = 64 * 1_048_576;
const CODE_GRAPH_CITATION_SOURCE_MAXIMUM_TOTAL_BYTES = 64 * 1_048_576;
const CODE_GRAPH_CITATION_SOURCE_BATCH_BYTES = 16 * 1_048_576;
const CODE_GRAPH_CITATION_SOURCE_BATCH_ENTRIES = 128;
const CODE_GRAPH_CITATION_SOURCE_BATCH_INPUT_BYTES = 2 * 1_048_576;
const CODE_GRAPH_CITATION_SOURCE_COMMAND_TIMEOUT_MILLISECONDS = 10_000;
const EMPTY_SOURCE_BYTES = new Uint8Array();

export interface CodeGraphCitationSourceRequest {
  readonly expectedContentHash: string;
  readonly repositoryPath: string;
  /** File-only capture verifies identity without retaining source contents. */
  readonly requireBytes: boolean;
}

interface CommitBlobObservation extends CodeGraphCitationSourceRequest {
  readonly blobId: string;
  readonly requiresByteVerification: boolean;
  readonly size: number;
}

export class CodeGraphCitationSourceError extends Schema.TaggedError<CodeGraphCitationSourceError>()(
  'CodeGraphCitationSourceError',
  {
    cause: Schema.optionalKey(Schema.Defect()),
    message: Schema.String,
  },
) {}

export function codeGraphCitationSourceKey(
  source: Pick<CodeGraphCitationSourceRequest, 'expectedContentHash' | 'repositoryPath'>,
): string {
  return `${source.repositoryPath}\0${source.expectedContentHash}`;
}

/**
 * Read the bounded set of source bytes needed to validate one repository.
 * Stable worktree bytes are preferred. When Git checkout filters changed their
 * spelling, exact snapshot blobs are read in bounded batches without filters
 * or lazy network fetches. Missing or mismatched entries are omitted so recall
 * can abstain per citation; capture treats a missing requested entry atomically.
 */
export const readCodeGraphCitationSources = Effect.fn('codeGraph.readCitationSources')(function* (input: {
  /** Refuse snapshot blobs when the caller requires bytes from the current worktree. */
  readonly allowCommitFallback?: boolean;
  readonly objectFormat: RepositoryIdentity['objectFormat'];
  /** @internal Narrower bound used by focused admission tests. */
  readonly retainedBytesLimit?: number;
  readonly repositoryRoot: string;
  readonly sourceCommit: string;
  readonly sources: readonly CodeGraphCitationSourceRequest[];
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const requestedRetainedBytesLimit = input.retainedBytesLimit ?? CODE_GRAPH_CITATION_SOURCE_MAXIMUM_TOTAL_BYTES;
  if (!Number.isSafeInteger(requestedRetainedBytesLimit) || requestedRetainedBytesLimit < 0) {
    return yield* CodeGraphCitationSourceError.make({message: 'Citation retained-byte bound is invalid.'});
  }
  const retainedBytesLimit = Math.min(CODE_GRAPH_CITATION_SOURCE_MAXIMUM_TOTAL_BYTES, requestedRetainedBytesLimit);
  const sources = deduplicateSources(input.sources);
  if (sources.length > CODE_GRAPH_CITATION_SOURCE_MAXIMUM_FILES) {
    return yield* CodeGraphCitationSourceError.make({
      message: `Citation source request exceeds the ${CODE_GRAPH_CITATION_SOURCE_MAXIMUM_FILES}-file bound.`,
    });
  }

  const metadata = yield* Effect.forEach(
    sources,
    source =>
      inspectContainedStableRegularFile(fs, path, input.repositoryRoot, source.repositoryPath).pipe(
        Effect.option,
        Effect.map(inspected => ({inspected, source})),
      ),
    {concurrency: 4},
  );
  let reservedBytes = 0;
  const reservedBytesByKey = new Map<string, number>();
  const worktreePlans: Array<{readonly size: number; readonly source: CodeGraphCitationSourceRequest}> = [];
  const commitFallback: CodeGraphCitationSourceRequest[] = [];
  for (const {inspected, source} of metadata) {
    if (Option.isNone(inspected)) {
      commitFallback.push(source);
      continue;
    }
    const size = inspected.value.size;
    if (size > CODE_GRAPH_CITATION_SOURCE_MAXIMUM_FILE_BYTES) continue;
    if (source.requireBytes) {
      if (reservedBytes + size > retainedBytesLimit) continue;
      reservedBytes += size;
      reservedBytesByKey.set(codeGraphCitationSourceKey(source), size);
    }
    worktreePlans.push({size, source});
  }
  const worktreeResults = yield* Effect.forEach(
    worktreePlans,
    ({size, source}) =>
      materializeContainedStableRegularFile(
        fs,
        path,
        input.repositoryRoot,
        source.repositoryPath,
        () => !source.requireBytes,
        size,
        input.objectFormat,
      ).pipe(
        Effect.option,
        Effect.map(materialized => {
          if (
            Option.isSome(materialized) &&
            (materialized.value.contentHash === source.expectedContentHash ||
              materialized.value.codeGraphContentHash === source.expectedContentHash)
          ) {
            return {
              bytes: source.requireBytes ? materialized.value.bytes : EMPTY_SOURCE_BYTES,
              matches: true,
              source,
            } as const;
          }
          return {bytes: undefined, matches: false, source} as const;
        }),
      ),
    {concurrency: 4},
  );
  const resolved = new Map<string, Uint8Array>();
  for (const {bytes, matches, source} of worktreeResults) {
    const key = codeGraphCitationSourceKey(source);
    if (matches && bytes !== undefined) {
      resolved.set(key, bytes);
    } else {
      const provisionalBytes = reservedBytesByKey.get(key);
      if (provisionalBytes !== undefined) {
        reservedBytes -= provisionalBytes;
        reservedBytesByKey.delete(key);
      }
      commitFallback.push(source);
    }
  }
  if (commitFallback.length === 0 || input.allowCommitFallback === false) return resolved;

  const system = yield* SystemInfo;
  const expressions = commitFallback.map(source => `${input.sourceCommit}:${source.repositoryPath}`);
  const checkInput = nulTerminated(expressions);
  if (checkInput.byteLength > CODE_GRAPH_CITATION_SOURCE_BATCH_INPUT_BYTES) {
    return yield* CodeGraphCitationSourceError.make({message: 'Citation source batch input exceeds its byte bound.'});
  }
  const environment = {...system.environment(), GIT_NO_LAZY_FETCH: '1'};
  const checked = yield* runBinaryCommandEffect(
    'git',
    ['-C', input.repositoryRoot, 'cat-file', '--batch-check', '-z'],
    {
      env: environment,
      input: checkInput,
      maxOutputBytes: Math.max(64 * 1_024, checkInput.byteLength + commitFallback.length * 128),
      timeoutMs: CODE_GRAPH_CITATION_SOURCE_COMMAND_TIMEOUT_MILLISECONDS,
    },
  ).pipe(
    Effect.mapError(cause =>
      CodeGraphCitationSourceError.make({
        cause,
        message: 'Could not inspect cited sources at the exact snapshot commit.',
      }),
    ),
  );
  const observations = yield* Effect.try({
    try: () => parseBatchCheck(checked.stdout, commitFallback, input.objectFormat),
    catch: cause =>
      Schema.is(CodeGraphCitationSourceError)(cause)
        ? cause
        : CodeGraphCitationSourceError.make({cause, message: 'Could not parse cited source inspection.'}),
  });
  const blobsToRead: CommitBlobObservation[] = [];
  for (const observation of observations) {
    const key = codeGraphCitationSourceKey(observation);
    if (!observation.requireBytes && !observation.requiresByteVerification) {
      resolved.set(key, EMPTY_SOURCE_BYTES);
      continue;
    }
    if (!reservedBytesByKey.has(key)) {
      if (reservedBytes + observation.size > retainedBytesLimit) continue;
      reservedBytes += observation.size;
      reservedBytesByKey.set(key, observation.size);
    }
    blobsToRead.push(observation);
  }

  for (const batch of chunkCommitBlobs(blobsToRead)) {
    const result = yield* runBinaryCommandEffect('git', ['-C', input.repositoryRoot, 'cat-file', '--batch', '-z'], {
      env: environment,
      input: nulTerminated(batch.map(observation => observation.blobId)),
      maxOutputBytes: batch.reduce((total, observation) => total + observation.size + 256, 0),
      timeoutMs: CODE_GRAPH_CITATION_SOURCE_COMMAND_TIMEOUT_MILLISECONDS,
    }).pipe(
      Effect.mapError(cause =>
        CodeGraphCitationSourceError.make({
          cause,
          message: 'Could not read cited sources at the exact snapshot commit.',
        }),
      ),
    );
    const blobs = yield* Effect.try({
      try: () => parseBatchBlobs(result.stdout, batch),
      catch: cause =>
        Schema.is(CodeGraphCitationSourceError)(cause)
          ? cause
          : CodeGraphCitationSourceError.make({cause, message: 'Could not parse cited source batch.'}),
    });
    for (let index = 0; index < batch.length; index += 1) {
      const observation = batch[index];
      const bytes = blobs[index];
      if (codeGraphFileContentHashMatchesBytes(observation.expectedContentHash, input.objectFormat, bytes)) {
        resolved.set(codeGraphCitationSourceKey(observation), observation.requireBytes ? bytes : EMPTY_SOURCE_BYTES);
      }
    }
  }
  return resolved;
});

function deduplicateSources(
  sources: readonly CodeGraphCitationSourceRequest[],
): readonly CodeGraphCitationSourceRequest[] {
  const unique = new Map<string, CodeGraphCitationSourceRequest>();
  for (const source of sources) {
    const key = codeGraphCitationSourceKey(source);
    const existing = unique.get(key);
    unique.set(
      key,
      existing === undefined ? source : {...source, requireBytes: existing.requireBytes || source.requireBytes},
    );
  }
  return [...unique.values()];
}

function nulTerminated(values: readonly string[]): Uint8Array {
  return new TextEncoder().encode(`${values.join('\0')}\0`);
}

function parseBatchCheck(
  bytes: Uint8Array,
  sources: readonly CodeGraphCitationSourceRequest[],
  objectFormat: RepositoryIdentity['objectFormat'],
): readonly CommitBlobObservation[] {
  const lines = new TextDecoder('utf-8', {fatal: true}).decode(bytes).split('\n');
  if (lines.at(-1) === '') lines.pop();
  if (lines.length !== sources.length) {
    throw CodeGraphCitationSourceError.make({
      message: 'Git citation source inspection returned an unexpected row count.',
    });
  }
  const observations: CommitBlobObservation[] = [];
  for (let index = 0; index < sources.length; index += 1) {
    const source = sources[index];
    const match = /^([0-9a-f]+) blob (\d+)$/u.exec(lines[index]);
    if (!match) continue;
    const size = Number(match[2]);
    if (!Number.isSafeInteger(size) || size < 0 || size > CODE_GRAPH_CITATION_SOURCE_MAXIMUM_FILE_BYTES) {
      continue;
    }
    observations.push({
      ...source,
      blobId: match[1],
      requiresByteVerification: codeGraphCommittedContentHash(objectFormat, match[1]) !== source.expectedContentHash,
      size,
    });
  }
  return observations;
}

function chunkCommitBlobs(observations: readonly CommitBlobObservation[]): readonly CommitBlobObservation[][] {
  const batches: CommitBlobObservation[][] = [];
  let current: CommitBlobObservation[] = [];
  let currentBytes = 0;
  for (const observation of observations) {
    if (
      current.length > 0 &&
      (current.length >= CODE_GRAPH_CITATION_SOURCE_BATCH_ENTRIES ||
        currentBytes + observation.size > CODE_GRAPH_CITATION_SOURCE_BATCH_BYTES)
    ) {
      batches.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(observation);
    currentBytes += observation.size;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

function parseBatchBlobs(bytes: Uint8Array, observations: readonly CommitBlobObservation[]): readonly Uint8Array[] {
  const blobs: Uint8Array[] = [];
  let offset = 0;
  for (const observation of observations) {
    const newline = bytes.indexOf(0x0a, offset);
    if (newline < 0)
      throw CodeGraphCitationSourceError.make({message: 'Git citation source batch ended before its header.'});
    const header = new TextDecoder('utf-8', {fatal: true}).decode(bytes.subarray(offset, newline));
    const expected = `${observation.blobId} blob ${observation.size}`;
    if (header !== expected) {
      throw CodeGraphCitationSourceError.make({
        message: 'Git citation source batch returned an unexpected object header.',
      });
    }
    const start = newline + 1;
    const end = start + observation.size;
    if (end >= bytes.byteLength || bytes[end] !== 0x0a) {
      throw CodeGraphCitationSourceError.make({message: 'Git citation source batch ended before its blob payload.'});
    }
    blobs.push(bytes.slice(start, end));
    offset = end + 1;
  }
  if (offset !== bytes.byteLength) {
    throw CodeGraphCitationSourceError.make({message: 'Git citation source batch returned trailing bytes.'});
  }
  return blobs;
}
