import {isSafeInteger as checkedIsSafeInteger, isOneOf as checkedIsOneOf} from '@threadnote/platform/validation';
import {Array as EffectArray} from 'effect';
import {Effect, FileSystem, Path, Result} from 'effect';
import {ResourceStore} from '@threadnote/store/resource-store';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {githubDocumentId, type GitHubCandidate} from './client.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

export interface GitHubRepositoryState {
  readonly name: string;
  readonly id: string;
  readonly canonical: string;
  readonly private: boolean;
  readonly backfillComplete: boolean;
  readonly watermark?: number;
  readonly issueWatermark?: number;
  readonly commentsWatermark?: number;
  readonly reviewCommentsWatermark?: number;
  readonly unresolvedNumbers?: readonly {readonly number: number; readonly nextAttemptAt: number}[];
  readonly lastReconciledAt?: number;
  readonly reconcileAfter?: string;
  readonly status: 'active' | 'pending';
  readonly parked?: boolean;
}
export interface GitHubSyncState {
  readonly version: 1;
  readonly fingerprint: string;
  readonly accessEpoch: string;
  readonly repositoryIndex: number;
  readonly phase: 'backfill' | 'issues' | 'comments' | 'review-comments' | 'reconcile';
  readonly page: number;
  readonly offset: number;
  readonly items: readonly GitHubCandidate[];
  readonly hasMore: boolean;
  readonly continuation?: string;
  readonly numbers?: readonly number[];
  readonly boundary: number;
  readonly incomplete: boolean;
  readonly revalidatingRepositoryId?: string;
  readonly revalidatingRepositoryGeneration?: string;
}
export interface GitHubIdMarker extends GitHubCandidate {
  readonly documentId: string;
  readonly repositoryId: string;
  readonly repository: string;
  readonly nextAttemptAt?: number;
  readonly pending: boolean;
  readonly observedBoundary?: number;
}
const location = (config: RuntimeConfig) => ({
  account: config.account,
  home: config.agentContextHome,
  user: config.user,
});
const root = (id: string) => `threadnote://resources/external/github/${id}`;
const record = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !EffectArray.isArray(v);
const hash = (v: unknown) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const integer = (v: unknown): v is number => checkedIsSafeInteger(v) && v >= 0;
const time = (v: unknown) => v === undefined || (integer(v) && v < 8_640_000_000_000_000);
const repo = (v: unknown) => typeof v === 'string' && /^[a-z0-9-]+\/[a-z0-9._-]+$/.test(v);
const candidate = (v: unknown): v is GitHubCandidate =>
  record(v) &&
  typeof v.id === 'string' &&
  /^[1-9][0-9]*$/.test(v.id) &&
  integer(v.number) &&
  v.number > 0 &&
  (v.kind === 'issue' || v.kind === 'pull');
const isPositiveIntegerArray = (value: unknown): value is readonly number[] =>
  EffectArray.isArray(value) &&
  EffectArray.every(value, (number): number is number => typeof number === 'number' && integer(number) && number > 0);
const isUnresolvedNumber = (value: unknown): value is {readonly number: number; readonly nextAttemptAt: number} =>
  record(value) &&
  typeof value.number === 'number' &&
  integer(value.number) &&
  value.number > 0 &&
  typeof value.nextAttemptAt === 'number' &&
  time(value.nextAttemptAt);
const isUnresolvedNumberArray = (
  value: unknown,
): value is readonly {readonly number: number; readonly nextAttemptAt: number}[] =>
  EffectArray.isArray(value) && value.length <= 100 && EffectArray.every(value, isUnresolvedNumber);

function validState(v: unknown): v is GitHubSyncState {
  return (
    record(v) &&
    v.version === 1 &&
    hash(v.fingerprint) &&
    hash(v.accessEpoch) &&
    integer(v.repositoryIndex) &&
    checkedIsOneOf(['backfill', 'issues', 'comments', 'review-comments', 'reconcile'], v.phase) &&
    integer(v.page) &&
    v.page > 0 &&
    integer(v.offset) &&
    EffectArray.isArray(v.items) &&
    v.items.length <= 100 &&
    EffectArray.every(v.items, candidate) &&
    new Set(EffectArray.map(v.items, x => x.number)).size === v.items.length &&
    v.offset <= v.items.length &&
    typeof v.hasMore === 'boolean' &&
    (v.numbers === undefined || (isPositiveIntegerArray(v.numbers) && v.numbers.length <= 100)) &&
    (v.continuation === undefined || (typeof v.continuation === 'string' && v.continuation.length <= 4096)) &&
    time(v.boundary) &&
    v.boundary !== undefined &&
    typeof v.incomplete === 'boolean' &&
    (v.revalidatingRepositoryId === undefined ||
      (typeof v.revalidatingRepositoryId === 'string' && /^[1-9][0-9]*$/.test(v.revalidatingRepositoryId))) &&
    (v.revalidatingRepositoryGeneration === undefined ||
      (v.revalidatingRepositoryId !== undefined && hash(v.revalidatingRepositoryGeneration)))
  );
}
function validRepository(v: unknown): v is GitHubRepositoryState {
  return (
    record(v) &&
    repo(v.name) &&
    repo(v.canonical) &&
    typeof v.id === 'string' &&
    /^[1-9][0-9]*$/.test(v.id) &&
    typeof v.private === 'boolean' &&
    typeof v.backfillComplete === 'boolean' &&
    (v.status === 'active' || v.status === 'pending') &&
    (v.parked === undefined || typeof v.parked === 'boolean') &&
    time(v.watermark) &&
    time(v.issueWatermark) &&
    time(v.commentsWatermark) &&
    time(v.reviewCommentsWatermark) &&
    (v.unresolvedNumbers === undefined ||
      (isUnresolvedNumberArray(v.unresolvedNumbers) &&
        new Set(EffectArray.map(v.unresolvedNumbers, item => item.number)).size === v.unresolvedNumbers.length)) &&
    time(v.lastReconciledAt) &&
    (v.reconcileAfter === undefined ||
      (typeof v.reconcileAfter === 'string' && /^r-[0-9]+-(?:issue|pull)-[0-9]+$/.test(v.reconcileAfter)))
  );
}
function validMarker(v: unknown): v is GitHubIdMarker {
  if (
    !candidate(v) ||
    !record(v) ||
    !repo(v.repository) ||
    typeof v.repositoryId !== 'string' ||
    !time(v.nextAttemptAt) ||
    !time(v.observedBoundary) ||
    typeof v.pending !== 'boolean'
  )
    return false;
  try {
    return githubDocumentId(v.repositoryId, v) === v.documentId;
  } catch {
    return false;
  }
}
const readInternal = Effect.fn('github.readInternal')(function* (
  config: RuntimeConfig,
  sourceId: string,
  suffix: readonly string[],
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* fs.realPath(config.agentContextHome).pipe(Effect.orElseSucceed(() => undefined));
  if (home === undefined) return null;
  const filename = path.join(home, 'data', config.account, 'resources', 'external', 'github', sourceId, ...suffix);
  const result = yield* fs.stat(filename).pipe(Effect.result);
  if (Result.isFailure(result)) return result.failure.reason._tag === 'NotFound' ? undefined : null;
  if (result.success.type !== 'File' || Number(result.success.size) > 256 * 1024) return null;
  const real = yield* fs.realPath(filename).pipe(Effect.orElseSucceed(() => undefined));
  if (real !== path.resolve(filename)) return null;
  const raw = yield* fs.readFileString(filename).pipe(Effect.orElseSucceed(() => undefined));
  if (raw === undefined || Buffer.byteLength(raw) > 256 * 1024) return null;
  return yield* Effect.try({try: () => JSON.parse(raw) as unknown, catch: () => null}).pipe(
    Effect.orElseSucceed(() => null),
  );
});

const write = Effect.fn('github.writeInternal')(function* <R>(
  config: RuntimeConfig,
  id: string,
  suffix: string,
  value: unknown,
  fence: Effect.Effect<unknown, unknown, R>,
) {
  yield* (yield* ResourceStore).mutateChecked(
    location(config),
    [{type: 'write', uri: `${root(id)}/${suffix}`, content: JSON.stringify(value), options: {mode: 'upsert'}}],
    fence,
  );
});
export const readGitHubSyncState = Effect.fn('github.readSyncState')(function* (config: RuntimeConfig, id: string) {
  const v = yield* readInternal(config, id, ['.sync.json']);
  return v === undefined ? undefined : validState(v) ? v : null;
});
export const writeGitHubSyncState = Effect.fn('github.writeSyncState')(function* <R>(
  config: RuntimeConfig,
  id: string,
  v: GitHubSyncState,
  fence: Effect.Effect<unknown, unknown, R>,
) {
  if (!validState(v)) throw new Error('Invalid GitHub sync state.');
  yield* write(config, id, '.sync.json', v, fence);
});
export const clearGitHubSyncState = Effect.fn('github.clearSyncState')(function* <R>(
  config: RuntimeConfig,
  id: string,
  fence: Effect.Effect<unknown, unknown, R>,
) {
  yield* (yield* ResourceStore).mutateChecked(
    location(config),
    [{type: 'remove', uri: `${root(id)}/.sync.json`, ignoreMissing: true}],
    fence,
  );
});
const checkpointSuffix = (repositoryId: string, index: number) => {
  if (!/^[1-9][0-9]*$/.test(repositoryId) || !integer(index)) throw new Error('Invalid GitHub checkpoint identity.');
  return `.checkpoints/r-${repositoryId}-${index}.json`;
};
export const readGitHubRepositoryCheckpoint = Effect.fn('github.readRepositoryCheckpoint')(function* (
  config: RuntimeConfig,
  id: string,
  repositoryId: string,
  index: number,
) {
  const v = yield* readInternal(
    config,
    id,
    Effect2.pipe(checkpointSuffix(repositoryId, index), EffectString.split('/')),
  );
  return v === undefined ? undefined : validState(v) && v.repositoryIndex === index ? v : null;
});
export const writeGitHubRepositoryCheckpoint = Effect.fn('github.writeRepositoryCheckpoint')(function* <R>(
  config: RuntimeConfig,
  id: string,
  repositoryId: string,
  v: GitHubSyncState,
  fence: Effect.Effect<unknown, unknown, R>,
) {
  if (!validState(v)) throw new Error('Invalid GitHub repository checkpoint.');
  yield* write(config, id, checkpointSuffix(repositoryId, v.repositoryIndex), v, fence);
});
export const clearGitHubRepositoryCheckpoint = Effect.fn('github.clearRepositoryCheckpoint')(function* <R>(
  config: RuntimeConfig,
  id: string,
  repositoryId: string,
  index: number,
  fence: Effect.Effect<unknown, unknown, R>,
) {
  yield* (yield* ResourceStore).mutateChecked(
    location(config),
    [{type: 'remove', uri: `${root(id)}/${checkpointSuffix(repositoryId, index)}`, ignoreMissing: true}],
    fence,
  );
});
const isGitHubRepositoryStateArray = (value: unknown): value is readonly GitHubRepositoryState[] =>
  EffectArray.isArray(value) &&
  value.length <= 100 &&
  EffectArray.every(value, validRepository) &&
  new Set(EffectArray.map(value, repository => repository.name)).size === value.length;

export const readGitHubRepositoryStates = Effect.fn('github.readRepositories')(function* (
  config: RuntimeConfig,
  id: string,
) {
  const value = yield* readInternal(config, id, ['.repositories.json']);
  return value === undefined ? [] : isGitHubRepositoryStateArray(value) ? value : null;
});
export const writeGitHubRepositoryStates = Effect.fn('github.writeRepositories')(function* <R>(
  config: RuntimeConfig,
  id: string,
  v: readonly GitHubRepositoryState[],
  fence: Effect.Effect<unknown, unknown, R>,
) {
  if (v.length > 100 || !EffectArray.every(v, validRepository)) throw new Error('Invalid GitHub repository state.');
  yield* write(config, id, '.repositories.json', v, fence);
});
export const readGitHubIdMarker = Effect.fn('github.readMarker')(function* (
  config: RuntimeConfig,
  id: string,
  doc: string,
) {
  const v = yield* readInternal(config, id, ['.ids', `${doc}.json`]);
  return v === undefined ? undefined : validMarker(v) && v.documentId === doc ? v : null;
});
export const writeGitHubIdMarker = Effect.fn('github.writeMarker')(function* <R>(
  config: RuntimeConfig,
  id: string,
  v: GitHubIdMarker,
  fence: Effect.Effect<unknown, unknown, R>,
) {
  if (!validMarker(v)) throw new Error('Invalid GitHub marker.');
  yield* write(config, id, `.ids/${v.documentId}.json`, v, fence);
});
export const listGitHubIdMarkers = Effect.fn('github.listMarkers')(function* (config: RuntimeConfig, id: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dir = path.join(config.agentContextHome, 'data', config.account, 'resources', 'external', 'github', id, '.ids');
  const listed = yield* fs.readDirectory(dir).pipe(Effect.result);
  if (Result.isFailure(listed) && listed.failure.reason._tag !== 'NotFound') return null;
  const markers: GitHubIdMarker[] = [];
  const listedNames = Result.isSuccess(listed) ? listed.success : [];
  for (const name of EffectArray.filter(listedNames, x => /^r-[0-9]+-(?:issue|pull)-[0-9]+\.json$/.test(x)).sort()) {
    const v = yield* readGitHubIdMarker(config, id, Effect2.pipe(name, EffectString.slice(0, -5)));
    if (v === null) return null;
    if (v) markers.push(v);
  }
  return markers;
});
