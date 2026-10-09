import {DateTime, Effect, FileSystem, Schema} from 'effect';
import {findContextHealthSemanticContradiction} from '@threadnote/context/health_semantic';
import {
  assertMemoryDocumentSchemaWritable,
  formatMemoryDocument,
  memoryArchiveBody,
  memoryArchiveMetadata,
  type MemoryRecord,
} from '@threadnote/memory/document';
import {withMemoryUriLocks} from '@threadnote/memory/lock';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {uriSegment} from '@threadnote/workspace/manifest';
import {ResourceStore} from '@threadnote/store/resource-store';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import type {
  ManagerSemanticReviewInputV1,
  ManagerSemanticReviewPreviewV1,
  ManagerSemanticReviewApplyResultV1,
} from '@threadnote/manager/attention/contracts';
import {readMemoryRecordsByUri, resourceStoreLocation} from '../../mcp/server/memory.js';
import {discardDeferredCodeAnchorIntentsWithin} from '../deferred/code_anchor.js';
import {consolidationEvidenceRepairBlocker} from './health_repair.js';
import {refreshRecallDerivedIndexesAfterCanonicalMutation} from '@threadnote/recall/mcp/refresh';
import {reconcileSemanticReviewMaintenanceCases} from './maintenance.js';
import {
  MAX_SEMANTIC_REVIEWS,
  readSemanticReviewState,
  writeSemanticReviewState,
  withSemanticReviewLock,
  semanticReviewError,
  type SemanticReviewEntry,
  SemanticReviewError,
} from './semantic_review_state.js';

function validateInput(input: ManagerSemanticReviewInputV1) {
  if (!['left', 'right', 'both'].includes(input.choice)) throw new Error('Choose an explicit semantic review choice.');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(input.project) || !/^[a-f0-9]{64}$/u.test(input.contradictionId))
    throw new Error('Select an exact semantic comparison and project.');
  for (const source of [input.left, input.right]) {
    if (
      !source ||
      !/^[a-f0-9]{64}$/u.test(source.recordContentFingerprint) ||
      !source.recordUri.startsWith('threadnote://')
    )
      throw new Error('Select both exact source revisions.');
  }
  if (input.left.recordUri === input.right.recordUri)
    throw new Error(
      'Retiring a memory requires two different source memories. Edit this memory to resolve its internal claims.',
    );
}
function selectedClaimFingerprints(input: ManagerSemanticReviewInputV1): readonly [string, string] | undefined {
  const left = input.left.claimFingerprint;
  const right = input.right.claimFingerprint;
  if (left === undefined && right === undefined) return undefined;
  if (!left || !right || !/^[a-f0-9]{64}$/u.test(left) || !/^[a-f0-9]{64}$/u.test(right))
    throw new Error('Select both exact source claims.');
  return [left, right];
}
export function buildSemanticReviewPreview(
  input: ManagerSemanticReviewInputV1,
  records: readonly MemoryRecord[],
  user: string,
): ManagerSemanticReviewPreviewV1 {
  validateInput(input);
  const pair = [input.left, input.right].map(source => {
    const record = records.find(record => record.uri === source.recordUri);
    if (
      !record ||
      record.metadata.status !== 'active' ||
      record.metadata.project !== input.project ||
      sha256HexSync(record.content) !== source.recordContentFingerprint
    )
      throw semanticReviewError('Either source changed or is no longer active. Refresh the comparison.', 'stale');
    return record;
  });
  const evidence = findContextHealthSemanticContradiction(
    pair,
    input.contradictionId,
    selectedClaimFingerprints(input),
  );
  if (!evidence) throw semanticReviewError('The semantic comparison changed. Refresh both source claims.', 'stale');
  const personal = `threadnote://user/${uriSegment(user)}/memories/durable/projects/${uriSegment(input.project)}/`;
  const blockers = pair.flatMap(record => {
    const reasons: string[] = [];
    if (
      !record.uri.startsWith(personal) ||
      record.uri.slice(personal.length).includes('/') ||
      !/^[A-Za-z0-9._-]+\.md$/u.test(record.uri.slice(personal.length)) ||
      record.metadata.kind !== 'durable' ||
      record.metadata.visibility === 'shared'
    )
      reasons.push(
        'Only canonical personal durable memories in this project can be changed. Open the source for manual review.',
      );
    if ((record.metadata.citationErrors?.length ?? 0) > 0)
      reasons.push('Repair malformed citation metadata before changing this memory.');
    const consolidation = consolidationEvidenceRepairBlocker(record);
    if (consolidation) reasons.push(consolidation);
    try {
      assertMemoryDocumentSchemaWritable(record.content);
    } catch {
      reasons.push('This memory schema requires manual review before changing it.');
    }
    return reasons;
  });
  const constraints = [
    'This is your explicit decision; the analyzer does not choose which memory is correct.',
    ...(input.choice === 'both'
      ? ['Both memories remain byte-for-byte unchanged. This reviewed decision reopens if either source changes.']
      : [
          'The entire other memory, including every claim and its metadata, moves to preserved history. Confirm that the entire other memory is outdated.',
        ]),
    ...(evidence.reason === 'policy-conflict'
      ? [
          'An observation and a requirement can both be true. Retiring a memory does not fix the underlying policy violation.',
        ]
      : []),
    ...(evidence.uncertainty.length > 0
      ? [
          'Applicability or interpretation needs context. Confirm your decision after reviewing both full source memories.',
        ]
      : []),
    ...blockers,
  ];
  const kept = input.choice === 'right' ? pair[1] : pair[0];
  const other = input.choice === 'right' ? pair[0] : pair[1];
  const canonicalInput = {
    project: input.project,
    contradictionId: input.contradictionId,
    left: {recordUri: input.left.recordUri, recordContentFingerprint: input.left.recordContentFingerprint},
    right: {recordUri: input.right.recordUri, recordContentFingerprint: input.right.recordContentFingerprint},
    choice: input.choice,
  };
  const revision = sha256HexSync(JSON.stringify({version: 1, input: canonicalInput, evidence, blockers}));
  return {
    previewId: `semantic-review-${revision.slice(0, 40)}`,
    revision,
    choice: input.choice,
    mode: blockers.length ? 'review-only' : input.choice === 'both' ? 'keep-both' : 'archive-other',
    summary:
      input.choice === 'both'
        ? 'Record that you reviewed both memories and want to keep both.'
        : 'Keep the chosen memory and move the entire other memory to history.',
    ...(blockers.length ? {reason: blockers.join(' ')} : {}),
    keptUri: kept.uri,
    archivedUri: other.uri,
    keptContent: kept.body,
    archivedContent: other.body,
    constraints,
  };
}
const checkedPreview = (input: ManagerSemanticReviewInputV1, records: readonly MemoryRecord[], user: string) =>
  Effect.try({
    try: () => buildSemanticReviewPreview(input, records, user),
    catch: error =>
      Schema.is(SemanticReviewError)(error)
        ? error
        : semanticReviewError('The comparison is invalid. Open both sources for manual review.'),
  });

type RawSource = NonNullable<SemanticReviewEntry['rawSources']>[number];
const rawSourceFingerprints = Effect.fn('semanticReview.rawFingerprints')(function* (
  config: RuntimeConfig,
  uris: readonly string[],
) {
  const store = yield* ResourceStore;
  return yield* Effect.forEach(uris, uri =>
    Effect.gen(function* () {
      return {
        recordUri: uri,
        fingerprint: yield* store.fingerprint(yield* store.read(resourceStoreLocation(config), uri)),
      };
    }),
  );
});
function bindRawPreview(
  preview: ManagerSemanticReviewPreviewV1,
  sources: readonly RawSource[],
): ManagerSemanticReviewPreviewV1 {
  const revision = sha256HexSync(
    JSON.stringify([
      preview.revision,
      sources
        .map(source => [source.recordUri, source.fingerprint])
        .sort((left, right) => left[0].localeCompare(right[0])),
    ]),
  );
  return {...preview, previewId: `semantic-review-${revision.slice(0, 40)}`, revision};
}
const assertRawSources = Effect.fn('semanticReview.assertRawSources')(function* (
  config: RuntimeConfig,
  expected: readonly RawSource[],
) {
  const current = yield* rawSourceFingerprints(
    config,
    expected.map(source => source.recordUri),
  );
  if (current.some((source, index) => source.fingerprint !== expected[index].fingerprint))
    return yield* semanticReviewError('A source memory changed. Reopen the comparison before deciding.', 'stale');
});

export const previewSemanticReview = Effect.fn('semanticReview.preview')(function* (
  config: RuntimeConfig,
  input: ManagerSemanticReviewInputV1,
) {
  yield* Effect.try({
    try: () => validateInput(input),
    catch: error => semanticReviewError(error instanceof Error ? error.message : 'Choose both sources and a decision.'),
  });
  const fs = yield* FileSystem.FileSystem;
  const result = yield* withSemanticReviewLock(
    config,
    withMemoryUriLocks(
      fs,
      config.agentContextHome,
      [input.left.recordUri, input.right.recordUri],
      Effect.gen(function* () {
        const records = yield* readMemoryRecordsByUri(config, [input.left.recordUri, input.right.recordUri]);
        const rawSources = yield* rawSourceFingerprints(config, [input.left.recordUri, input.right.recordUri]);
        const preview = bindRawPreview(yield* checkedPreview(input, records, config.user), rawSources);
        const state = yield* readSemanticReviewState(config);
        const existing = state.entries.find(entry => entry.preview.previewId === preview.previewId);
        if (existing) return existing.preview;
        const timestamp = DateTime.formatIso(yield* DateTime.now);
        const source = records.find(record => record.uri === preview.archivedUri)!;
        const archiveUri = `threadnote://user/${uriSegment(config.user)}/memories/durable/archived/${uriSegment(input.project)}/${preview.previewId}.md`;
        const archiveContent =
          preview.mode === 'archive-other'
            ? formatMemoryDocument(
                'MEMORY',
                memoryArchiveMetadata(source.metadata, {
                  archivedFrom: source.uri,
                  sourceAgentClient: 'threadnote',
                  timestamp,
                }),
                memoryArchiveBody(source.body),
              )
            : undefined;
        const comparison = findContextHealthSemanticContradiction(
          records,
          input.contradictionId,
          selectedClaimFingerprints(input),
        )!;
        const entry: SemanticReviewEntry = {
          input,
          preview,
          slot: [comparison.left.claimFingerprint, comparison.right.claimFingerprint].sort().join(':'),
          timestamp,
          applied: false,
          rawSources,
          ...(preview.mode === 'archive-other' ? {archiveUri, archiveContent} : {}),
        };
        const entries = [...state.entries, entry];
        while (entries.length > MAX_SEMANTIC_REVIEWS) {
          const unused = entries.findIndex(item => !item.applied && item.preview.previewId !== preview.previewId);
          if (unused < 0)
            return yield* semanticReviewError(
              'Review receipt storage is full. Preserve existing decisions before continuing.',
            );
          entries.splice(unused, 1);
        }
        yield* writeSemanticReviewState(config, {version: 1, entries});
        return preview;
      }),
    ),
  );
  return result;
});

export const applySemanticReview = Effect.fn('semanticReview.apply')(function* (
  config: RuntimeConfig,
  input: {readonly project: string; readonly previewId: string; readonly revision: string; readonly approved: boolean},
) {
  if (input.approved !== true)
    return yield* semanticReviewError('Explicit approval of the reviewed decision is required.');
  let invalidatedUris: readonly string[] = [];
  const result = yield* withSemanticReviewLock(
    config,
    Effect.gen(function* () {
      const state = yield* readSemanticReviewState(config);
      const entry = state.entries.find(
        entry =>
          entry.preview.previewId === input.previewId &&
          entry.preview.revision === input.revision &&
          entry.input.project === input.project,
      );
      if (!entry)
        return yield* semanticReviewError(
          'This saved preview is unavailable or changed. Preview the comparison again.',
          'stale',
        );
      if (entry.rawSources?.length !== 2)
        return yield* semanticReviewError('This preview needs fresh source evidence. Reopen the comparison.', 'stale');
      const rawSources = entry.rawSources;
      if (entry.preview.mode === 'review-only')
        return yield* semanticReviewError(entry.preview.reason ?? 'Open the sources for manual review.');
      if (entry.archiveUri && entry.preview.archivedUri)
        invalidatedUris = [entry.preview.archivedUri, entry.archiveUri];
      const fs = yield* FileSystem.FileSystem;
      const uris = [entry.input.left.recordUri, entry.input.right.recordUri, entry.archiveUri];
      return yield* withMemoryUriLocks(
        fs,
        config.agentContextHome,
        uris,
        Effect.gen(function* () {
          const store = yield* ResourceStore;
          const location = resourceStoreLocation(config);
          const current = yield* readMemoryRecordsByUri(
            config,
            uris.filter((uri): uri is string => uri !== undefined),
          );
          const kept = current.find(record => record.uri === entry.preview.keptUri);
          const keptSource = entry.input.left.recordUri === kept?.uri ? entry.input.left : entry.input.right;
          if (!kept || sha256HexSync(kept.content) !== keptSource.recordContentFingerprint)
            return yield* semanticReviewError('The kept source changed. Refresh the comparison.', 'stale');
          const archive = current.find(record => record.uri === entry.archiveUri);
          const source = current.find(record => record.uri === entry.preview.archivedUri);
          const recovered =
            entry.preview.mode === 'archive-other' &&
            !source &&
            archive !== undefined &&
            archive.content === entry.archiveContent &&
            (yield* store.read(location, archive.uri)) === entry.archiveContent;
          yield* assertRawSources(
            config,
            recovered ? rawSources.filter(source => source.recordUri === kept.uri) : rawSources,
          );
          if (entry.applied && entry.preview.mode === 'archive-other' && !recovered)
            return yield* semanticReviewError(
              'The retired memory or its preserved history changed after this decision. Review the sources again.',
              'stale',
            );
          if (!recovered) {
            const preview = bindRawPreview(yield* checkedPreview(entry.input, current, config.user), rawSources);
            if (preview.revision !== entry.preview.revision)
              return yield* semanticReviewError('Source safeguards changed. Preview the comparison again.', 'stale');
          }
          if (!entry.applied && !recovered && entry.preview.mode === 'archive-other') {
            if (!source || !entry.archiveUri || !entry.archiveContent)
              return yield* semanticReviewError('The archive plan is incomplete. Preview again.');
            if (archive && archive.content !== entry.archiveContent)
              return yield* semanticReviewError('The history destination contains different content.');
            yield* store.mutateChecked(
              location,
              [
                ...(archive
                  ? []
                  : [
                      {
                        type: 'write' as const,
                        uri: entry.archiveUri,
                        content: entry.archiveContent,
                        options: {mode: 'create' as const},
                      },
                    ]),
                {
                  type: 'remove',
                  uri: source.uri,
                  options: {expectedFingerprint: rawSources.find(raw => raw.recordUri === source.uri)!.fingerprint},
                },
              ],
              Effect.gen(function* () {
                const checked = yield* readMemoryRecordsByUri(config, [
                  entry.input.left.recordUri,
                  entry.input.right.recordUri,
                ]);
                yield* assertRawSources(config, rawSources);
                const final = bindRawPreview(yield* checkedPreview(entry.input, checked, config.user), rawSources);
                if (final.revision !== entry.preview.revision)
                  return yield* semanticReviewError('Either source changed before the approved mutation.', 'stale');
              }),
            );
            yield* discardDeferredCodeAnchorIntentsWithin(config, source.uri);
          }
          if (!entry.applied)
            yield* writeSemanticReviewState(config, {
              version: 1,
              entries: state.entries.map(item => (item === entry ? {...entry, applied: true} : item)),
            });
          const result: ManagerSemanticReviewApplyResultV1 = {
            status: entry.applied || recovered ? 'already-applied' : 'applied',
            choice: entry.input.choice,
            ...(entry.input.choice === 'both' ? {} : {keptUri: entry.preview.keptUri, archivedUri: entry.archiveUri}),
          };
          return result;
        }),
      );
    }),
  );
  if (result.archivedUri !== undefined)
    yield* refreshRecallDerivedIndexesAfterCanonicalMutation(config, invalidatedUris);
  yield* reconcileSemanticReviewMaintenanceCases(config);
  return result;
});
