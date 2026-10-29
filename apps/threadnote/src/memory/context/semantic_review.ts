import {Array as EffectArray, Option as EffectOption} from 'effect';
import {DateTime, Effect, FileSystem, Schema} from 'effect';
import {findContextHealthSemanticContradiction} from '@threadnote/context/health_semantic';
import {buildContextHealthReport} from '@threadnote/context/health';
import {
  assertMemoryDocumentSchemaWritable,
  formatMemoryDocument,
  memoryArchiveBody,
  memoryArchiveMetadata,
  parseMemoryDocument,
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
  ManagerSemanticRefreshInputV1,
  ManagerSemanticRefreshResultV1,
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
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

function validateComparison(input: ManagerSemanticRefreshInputV1) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(input.project) || !/^[a-f0-9]{64}$/u.test(input.contradictionId))
    throw new Error('Select an exact semantic comparison and project.');
  for (const source of [input.left, input.right]) {
    if (
      !source ||
      !/^[a-f0-9]{64}$/u.test(source.recordContentFingerprint) ||
      !Effect2.pipe(source.recordUri, EffectString.startsWith('threadnote://'))
    )
      throw new Error('Select both exact source revisions.');
  }
  if (input.left.recordUri === input.right.recordUri)
    throw new Error(
      'Retiring a memory requires two different source memories. Edit this memory to resolve its internal claims.',
    );
}
function validateInput(input: ManagerSemanticReviewInputV1) {
  if (!['left', 'right', 'both'].includes(input.choice)) throw new Error('Choose an explicit semantic review choice.');
  validateComparison(input);
}
function selectedClaimFingerprints(input: ManagerSemanticRefreshInputV1): readonly [string, string] | undefined {
  const left = input.left.claimFingerprint;
  const right = input.right.claimFingerprint;
  if (left === undefined && right === undefined) return undefined;
  if (!left || !right || !/^[a-f0-9]{64}$/u.test(left) || !/^[a-f0-9]{64}$/u.test(right))
    throw new Error('Select both exact source claims.');
  return [left, right];
}

/** A health comparison exists independently of the background maintenance inventory. */
export const refreshSemanticComparison = Effect.fn('semanticReview.refresh')(function* (
  config: RuntimeConfig,
  input: ManagerSemanticRefreshInputV1,
) {
  const fingerprints = yield* Effect.try({
    try: () => {
      validateComparison(input);
      const selected = selectedClaimFingerprints(input);
      if (!selected) throw new Error('Select both exact source claims.');
      return selected;
    },
    catch: () => semanticReviewError('Select both exact source claims and their project.'),
  });
  const store = yield* ResourceStore;
  const uris = [input.left.recordUri, input.right.recordUri];
  const read = Effect.forEach(uris, uri => store.readBounded(resourceStoreLocation(config), uri, 1_048_576));
  const before = yield* read;
  const contents = EffectArray.flatMap(before, source => (source.truncated ? [] : [source.content]));
  if (contents.length !== 2)
    return {
      outcome: 'unavailable',
      reason: 'A source memory is too large for this comparison. Review it in Library.',
    } satisfies ManagerSemanticRefreshResultV1;
  const records = EffectArray.map(contents, (content, index) => parseMemoryDocument(uris[index], content));
  if (
    EffectArray.some(
      records,
      record => !record || record.metadata.status !== 'active' || record.metadata.project !== input.project,
    )
  )
    return {
      outcome: 'unavailable',
      reason: 'A selected memory is no longer active in this project.',
    } satisfies ManagerSemanticRefreshResultV1;
  const current = EffectArray.filter(records, (record): record is MemoryRecord => record !== undefined);
  const exact = findContextHealthSemanticContradiction(current, input.contradictionId, fingerprints);
  if (
    exact &&
    EffectArray.some([input.left, input.right], source => {
      const claim = EffectOption.getOrUndefined(
        EffectArray.findFirst([exact.left, exact.right], claim => claim.recordUri === source.recordUri),
      );
      return (
        claim?.recordContentFingerprint !== source.recordContentFingerprint ||
        claim.claimFingerprint !== source.claimFingerprint
      );
    })
  )
    return yield* semanticReviewError('The selected revisions do not match their source claims.');
  if (
    !exact &&
    EffectArray.every(
      current,
      (record, index) =>
        sha256HexSync(record.content) === input[index === 0 ? 'left' : 'right'].recordContentFingerprint,
    )
  )
    return yield* semanticReviewError('The selected comparison does not match these source claims.');
  const report = exact
    ? undefined
    : buildContextHealthReport({
        project: input.project,
        records: current,
        duplicateCorpus: current,
        includeFindingCategories: ['semantic-contradiction'],
        now: yield* DateTime.nowAsDate,
      });
  const comparisons = exact
    ? [exact]
    : EffectArray.flatMap(report!.findings, finding => (finding.semanticEvidence ? [finding.semanticEvidence] : []));
  const after = yield* read;
  if (EffectArray.some(after, (source, index) => source.truncated || source.content !== contents[index]))
    return {
      outcome: 'changing',
      reason: 'The selected memories changed during the check. Checking again shortly.',
    } satisfies ManagerSemanticRefreshResultV1;
  if (report && report.semanticCompleteness.state !== 'complete')
    return {
      outcome: 'incomplete',
      reason:
        'The bounded comparison check could not review every statement. Your choice is saved; check current evidence after reviewing the source memories.',
    } satisfies ManagerSemanticRefreshResultV1;
  if (comparisons.length !== 1)
    return {
      outcome: 'superseded',
      reason:
        comparisons.length === 0
          ? 'These statements no longer conflict. No memory content was changed.'
          : 'The updated memories contain several comparisons. Review their current statements before choosing a new decision.',
    } satisfies ManagerSemanticRefreshResultV1;
  return {outcome: 'ready', evidence: comparisons[0]} satisfies ManagerSemanticRefreshResultV1;
});
export function buildSemanticReviewPreview(
  input: ManagerSemanticReviewInputV1,
  records: readonly MemoryRecord[],
  user: string,
): ManagerSemanticReviewPreviewV1 {
  validateInput(input);
  const pair = EffectArray.map([input.left, input.right], source => {
    const record = EffectOption.getOrUndefined(
      EffectArray.findFirst(records, record => record.uri === source.recordUri),
    );
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
  // Keeping both writes only a local, revision-bound review receipt, never either source.
  const blockers =
    input.choice === 'both'
      ? []
      : [
          ...new Set(
            EffectArray.flatMap(pair, (record, __effectFlatMapIndex) => {
              if (!(__effectFlatMapIndex in pair)) return [];
              const reasons: string[] = [];
              if (
                !Effect2.pipe(record.uri, EffectString.startsWith(personal)) ||
                Effect2.pipe(record.uri, EffectString.slice(personal.length), EffectString.includes('/')) ||
                !/^[A-Za-z0-9._-]+\.md$/u.test(Effect2.pipe(record.uri, EffectString.slice(personal.length))) ||
                record.metadata.kind !== 'durable' ||
                record.metadata.visibility === 'shared'
              )
                reasons.push(
                  'Only personal durable memories in this project can be moved to history. Choose both to save a local review without changing either source, or review changes with the source owner.',
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
            }),
          ),
        ];
  const constraints = [
    'This is your explicit decision; the analyzer does not choose which memory is correct.',
    ...(input.choice === 'both'
      ? [
          'This decision is local to this device and is not published. Both memories remain byte-for-byte unchanged. This reviewed decision reopens if either source changes.',
        ]
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
    previewId: `semantic-review-${Effect2.pipe(revision, EffectString.slice(0, 40))}`,
    revision,
    choice: input.choice,
    mode: blockers.length ? 'review-only' : input.choice === 'both' ? 'keep-both' : 'archive-other',
    summary:
      input.choice === 'both'
        ? 'Record that you reviewed both memories and want to keep both.'
        : 'Keep the chosen memory and move the entire other memory to history.',
    ...(blockers.length ? {reason: EffectArray.join(blockers, ' ')} : {}),
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
      EffectArray.map(sources, source => [source.recordUri, source.fingerprint]).sort((left, right) =>
        Effect2.pipe(left[0], EffectString.localeCompare(right[0])),
      ),
    ]),
  );
  return {...preview, previewId: `semantic-review-${Effect2.pipe(revision, EffectString.slice(0, 40))}`, revision};
}
const assertRawSources = Effect.fn('semanticReview.assertRawSources')(function* (
  config: RuntimeConfig,
  expected: readonly RawSource[],
) {
  const current = yield* rawSourceFingerprints(
    config,
    EffectArray.map(expected, source => source.recordUri),
  );
  if (EffectArray.some(current, (source, index) => source.fingerprint !== expected[index].fingerprint))
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
        const existing = EffectOption.getOrUndefined(
          EffectArray.findFirst(state.entries, entry => entry.preview.previewId === preview.previewId),
        );
        if (existing) return existing.preview;
        const timestamp = DateTime.formatIso(yield* DateTime.now);
        const source = EffectOption.getOrUndefined(
          EffectArray.findFirst(records, record => record.uri === preview.archivedUri),
        )!;
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
          slot: EffectArray.join([comparison.left.claimFingerprint, comparison.right.claimFingerprint].sort(), ':'),
          timestamp,
          applied: false,
          rawSources,
          ...(preview.mode === 'archive-other' ? {archiveUri, archiveContent} : {}),
        };
        const entries = [...state.entries, entry];
        while (entries.length > MAX_SEMANTIC_REVIEWS) {
          const unused = EffectOption.getOrElse(
            EffectArray.findFirstIndex(entries, item => !item.applied && item.preview.previewId !== preview.previewId),
            () => -1,
          );
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
      const entry = EffectOption.getOrUndefined(
        EffectArray.findFirst(
          state.entries,
          entry =>
            entry.preview.previewId === input.previewId &&
            entry.preview.revision === input.revision &&
            entry.input.project === input.project,
        ),
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
            EffectArray.filter(uris, (uri): uri is string => uri !== undefined),
          );
          const kept = EffectOption.getOrUndefined(
            EffectArray.findFirst(current, record => record.uri === entry.preview.keptUri),
          );
          const keptSource = entry.input.left.recordUri === kept?.uri ? entry.input.left : entry.input.right;
          if (!kept || sha256HexSync(kept.content) !== keptSource.recordContentFingerprint)
            return yield* semanticReviewError('The kept source changed. Refresh the comparison.', 'stale');
          const archive = EffectOption.getOrUndefined(
            EffectArray.findFirst(current, record => record.uri === entry.archiveUri),
          );
          const source = EffectOption.getOrUndefined(
            EffectArray.findFirst(current, record => record.uri === entry.preview.archivedUri),
          );
          const recovered =
            entry.preview.mode === 'archive-other' &&
            !source &&
            archive !== undefined &&
            archive.content === entry.archiveContent &&
            (yield* store.read(location, archive.uri)) === entry.archiveContent;
          yield* assertRawSources(
            config,
            recovered ? EffectArray.filter(rawSources, source => source.recordUri === kept.uri) : rawSources,
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
                  options: {
                    expectedFingerprint: EffectOption.getOrUndefined(
                      EffectArray.findFirst(rawSources, raw => raw.recordUri === source.uri),
                    )!.fingerprint,
                  },
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
              entries: EffectArray.map(state.entries, item => (item === entry ? {...entry, applied: true} : item)),
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
