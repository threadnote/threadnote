import {Crypto, Effect, FileSystem, Option, Path, Schema} from 'effect';
import {withExclusiveFileLock} from '@threadnote/platform/file/lock';
import {sha256HexSync} from '@threadnote/platform/sha256';
import type {MemoryRecord} from '@threadnote/memory/document';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import type {
  ManagerSemanticReviewPreviewV1,
  ManagerSemanticReviewInputV1,
} from '@threadnote/manager/attention/contracts';
import type {ContextMaintenanceCaseV2} from './maintenance.js';
import {readMemoryRecordsByUri} from '../../mcp/server/memory.js';
import {resourceStoreLocation} from '../../mcp/server/memory.js';
import {ResourceStore} from '@threadnote/store/resource-store';

const Source = Schema.Struct({recordUri: Schema.String, recordContentFingerprint: Schema.String});
const Input = Schema.Struct({
  project: Schema.String,
  contradictionId: Schema.String,
  left: Source,
  right: Source,
  choice: Schema.Literals(['left', 'right', 'both']),
});
const Preview = Schema.Struct({
  previewId: Schema.String,
  revision: Schema.String,
  choice: Schema.Literals(['left', 'right', 'both']),
  mode: Schema.Literals(['archive-other', 'keep-both', 'review-only']),
  summary: Schema.String,
  reason: Schema.optional(Schema.String),
  keptUri: Schema.optional(Schema.String),
  archivedUri: Schema.optional(Schema.String),
  keptContent: Schema.optional(Schema.String),
  archivedContent: Schema.optional(Schema.String),
  constraints: Schema.Array(Schema.String),
});
const Entry = Schema.Struct({
  input: Input,
  preview: Preview,
  slot: Schema.String,
  timestamp: Schema.String,
  archiveUri: Schema.optional(Schema.String),
  archiveContent: Schema.optional(Schema.String),
  applied: Schema.Boolean,
  rawSources: Schema.optional(Schema.Array(Schema.Struct({recordUri: Schema.String, fingerprint: Schema.String}))),
});
const State = Schema.Struct({version: Schema.Literal(1), entries: Schema.Array(Entry)});
export interface SemanticReviewEntry {
  readonly input: ManagerSemanticReviewInputV1;
  readonly preview: ManagerSemanticReviewPreviewV1;
  readonly timestamp: string;
  readonly slot: string;
  readonly archiveUri?: string;
  readonly archiveContent?: string;
  readonly applied: boolean;
  readonly rawSources?: readonly {readonly recordUri: string; readonly fingerprint: string}[];
}
export interface SemanticReviewState {
  readonly version: 1;
  readonly entries: readonly SemanticReviewEntry[];
}
const MAX_BYTES = 2 * 1_024 * 1_024;
export const MAX_SEMANTIC_REVIEWS = 128;
const statePath = (config: RuntimeConfig) =>
  Effect.map(Path.Path, path => path.join(config.agentContextHome, 'threadnote', 'semantic-reviews', 'v1.json'));
export function withSemanticReviewLock<A, E, R>(config: RuntimeConfig, effect: Effect.Effect<A, E, R>) {
  return Effect.gen(function* () {
    return yield* withExclusiveFileLock(
      yield* FileSystem.FileSystem,
      `${yield* statePath(config)}.lock`,
      {retryIntervalMilliseconds: 25, staleAfterMilliseconds: 300_000, waitTimeoutMilliseconds: 5_000},
      effect,
    );
  });
}
export const readSemanticReviewState = Effect.fn('semanticReview.readState')(function* (config: RuntimeConfig) {
  const fs = yield* FileSystem.FileSystem;
  const file = yield* statePath(config);
  if (!(yield* fs.exists(file))) return {version: 1 as const, entries: []};
  const stat = yield* fs.stat(file);
  if (
    stat.type !== 'File' ||
    Number(stat.size) > MAX_BYTES ||
    Option.isSome(yield* fs.readLink(file).pipe(Effect.option))
  )
    return yield* semanticReviewError('Semantic review state is unsafe or exceeds its size boundary.');
  const content = yield* fs.readFileString(file);
  const parsed = yield* Effect.try({
    try: () => JSON.parse(content),
    catch: () => semanticReviewError('Semantic review state is invalid. Preserve its history for recovery.'),
  });
  const state = yield* Schema.decodeUnknownEffect(State)(parsed).pipe(
    Effect.mapError(() =>
      semanticReviewError('Semantic review state has an unsupported shape. Preserve it for recovery.'),
    ),
  );
  if (state.entries.length > MAX_SEMANTIC_REVIEWS)
    return yield* semanticReviewError('Semantic review storage exceeds its entry boundary.');
  return state;
});
export const writeSemanticReviewState = Effect.fn('semanticReview.writeState')(function* (
  config: RuntimeConfig,
  state: SemanticReviewState,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const file = yield* statePath(config);
  const content = JSON.stringify(state);
  if (new TextEncoder().encode(content).length > MAX_BYTES || state.entries.length > MAX_SEMANTIC_REVIEWS)
    return yield* semanticReviewError(
      'Semantic review storage is full. Preserve receipts and remove unused previews before continuing.',
    );
  yield* fs.makeDirectory(path.dirname(file), {recursive: true});
  const temporary = `${file}.${yield* (yield* Crypto.Crypto).randomUUIDv4}.tmp`;
  yield* Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* fs.open(temporary, {flag: 'wx', mode: 0o600});
      yield* handle.writeAll(new TextEncoder().encode(content));
      yield* handle.sync;
    }),
  ).pipe(
    Effect.andThen(fs.rename(temporary, file)),
    Effect.ensuring(fs.remove(temporary, {force: true}).pipe(Effect.ignore)),
  );
});
export class SemanticReviewError extends Schema.TaggedError<SemanticReviewError>()('SemanticReviewError', {
  message: Schema.String,
  reason: Schema.Literals(['stale', 'blocked']),
}) {}
export function semanticReviewError(message: string, reason: 'stale' | 'blocked' = 'blocked') {
  return SemanticReviewError.make({message, reason});
}

export const semanticReviewRawSourcesCurrent = Effect.fn('semanticReview.rawSourcesCurrent')(function* (
  config: RuntimeConfig,
  entry: SemanticReviewEntry,
) {
  if (
    entry.rawSources?.length !== 2 ||
    ![entry.input.left, entry.input.right].every(source =>
      entry.rawSources?.some(raw => raw.recordUri === source.recordUri),
    )
  )
    return false;
  const store = yield* ResourceStore;
  const results = yield* Effect.forEach(entry.rawSources, source =>
    store.read(resourceStoreLocation(config), source.recordUri).pipe(
      Effect.flatMap(content => store.fingerprint(content)),
      Effect.map(fingerprint => fingerprint === source.fingerprint),
      Effect.orElseSucceed(() => false),
    ),
  );
  return results.every(Boolean);
});
export const reviewedSemanticContradictionIds = Effect.fn('semanticReview.reviewedIds')(function* (
  config: RuntimeConfig,
  project: string,
  records: readonly MemoryRecord[],
) {
  const state = yield* readSemanticReviewState(config);
  const candidates = state.entries.filter(
    entry =>
      entry.applied &&
      entry.input.choice === 'both' &&
      entry.input.project === project &&
      [entry.input.left, entry.input.right].every(source =>
        records.some(
          record =>
            record.uri === source.recordUri &&
            record.metadata.status === 'active' &&
            sha256HexSync(record.content) === source.recordContentFingerprint,
        ),
      ),
  );
  const verified = yield* Effect.filter(candidates, entry => semanticReviewRawSourcesCurrent(config, entry));
  return verified.map(entry => entry.input.contradictionId);
});

export function projectReviewedSemanticCases(
  cases: readonly ContextMaintenanceCaseV2[],
  entries: readonly SemanticReviewEntry[],
  records: readonly MemoryRecord[],
) {
  return cases.map(item => {
    if (item.family !== 'semantic-contradiction') return item;
    const reviewed = entries.find(
      entry =>
        entry.applied &&
        entry.rawSources?.length === 2 &&
        entry.input.project === item.project &&
        entry.slot === item.slot &&
        item.subjectContentHashes?.length === 2 &&
        item.subjectContentHashes.every(source =>
          [entry.input.left, entry.input.right].some(
            expected => expected.recordUri === source.uri && expected.recordContentFingerprint === source.hash,
          ),
        ) &&
        (entry.input.choice === 'both'
          ? [entry.input.left, entry.input.right].every(source =>
              records.some(
                record =>
                  record.uri === source.recordUri &&
                  record.metadata.status === 'active' &&
                  sha256HexSync(record.content) === source.recordContentFingerprint,
              ),
            )
          : records.some(
              record =>
                record.uri === entry.preview.keptUri &&
                sha256HexSync(record.content) ===
                  [entry.input.left, entry.input.right].find(source => source.recordUri === record.uri)
                    ?.recordContentFingerprint,
            ) &&
            records.some(record => record.uri === entry.archiveUri && record.content === entry.archiveContent) &&
            !records.some(record => record.uri === entry.preview.archivedUri)),
    );
    if (!reviewed) {
      if (item.reason !== 'human-reviewed-keep-both' || item.disposition !== 'resolved') return item;
      const sameClaims = item.subjectContentHashes?.every(source =>
        records.some(record => record.uri === source.uri && sha256HexSync(record.content) === source.hash),
      );
      return {
        ...item,
        disposition: sameClaims ? ('needs-decision' as const) : ('historical' as const),
        reason: 'reviewed-sources-changed',
      };
    }
    const reason = reviewed.input.choice === 'both' ? 'human-reviewed-keep-both' : 'human-retired-outdated-memory';
    return {
      ...item,
      disposition: 'resolved' as const,
      reason,
      events: item.events.some(event => event.reason === reason && event.at === reviewed.timestamp)
        ? item.events
        : [...item.events, {at: reviewed.timestamp, reason}].slice(-16),
    };
  });
}

export const reviewedSemanticMaintenanceCases = Effect.fn('semanticReview.reviewedCases')(function* (
  config: RuntimeConfig,
  cases: readonly ContextMaintenanceCaseV2[],
  project?: string,
) {
  const candidates = (yield* readSemanticReviewState(config)).entries.filter(
    entry => entry.applied && (project === undefined || entry.input.project === project),
  );
  const entries = yield* Effect.filter(candidates, entry =>
    entry.input.choice === 'both'
      ? semanticReviewRawSourcesCurrent(config, entry)
      : Effect.succeed(entry.rawSources?.length === 2),
  );
  if (candidates.length === 0) return cases;
  const records = yield* readMemoryRecordsByUri(config, [
    ...new Set(
      candidates.flatMap(entry => [
        entry.input.left.recordUri,
        entry.input.right.recordUri,
        ...(entry.archiveUri === undefined ? [] : [entry.archiveUri]),
      ]),
    ),
  ]);
  return projectReviewedSemanticCases(cases, entries, records);
});

export function saveReviewedSemanticMaintenanceCases<
  S extends {readonly cases: readonly ContextMaintenanceCaseV2[]},
  E,
  R,
>(config: RuntimeConfig, state: S, save: (state: S) => Effect.Effect<void, E, R>) {
  return Effect.gen(function* () {
    const cases = yield* reviewedSemanticMaintenanceCases(config, state.cases);
    if (cases.some((item, index) => item !== state.cases[index])) yield* save({...state, cases});
  });
}
