import {Array as EffectArray, Effect} from 'effect';
import type * as SqlClient from 'effect/sql/SqlClient';
import type {
  RecallIndexConfig,
  RecallIndexReadQuery,
  RecallIndexSelection,
  RecallIndexData,
  RecallExactMatch,
} from '../index.js';
import type {RecallCandidate} from '../rank.js';
import {
  recallIndexDataBatchResult,
  recallIndexDataResult,
  recallExactMatchesResult,
  recallCodeLinkMatchesResult,
  recallMemoryLinkMatchesResult,
} from './result.js';
import {selectRecallDocumentRows} from './selection.js';
import {makeRecallReadyValidator} from './ready_validation.js';

/** Apply current canonical fences to a bounded selection; never repair shared state. */
export const validateRecallReadyResult = Effect.fn('recall.validateReadyResult')(function* (
  sql: SqlClient.SqlClient,
  config: RecallIndexConfig,
  options: RecallIndexReadQuery,
  result: unknown,
  decodeCandidateRow: (row: {
    readonly candidate_json: string;
    readonly id: number;
    readonly uri: string;
  }) => RecallCandidate,
) {
  const matches:
    | readonly (
        | import('../code_links.js').RecallCodeLinkMatch
        | RecallExactMatch
        | import('../memory/links.js').RecallMemoryLinkMatch
      )[]
    | undefined =
    'terms' in options
      ? recallExactMatchesResult(result)
      : 'anchors' in options
        ? recallCodeLinkMatchesResult(result)
        : 'memorySeeds' in options
          ? recallMemoryLinkMatchesResult(result)
          : undefined;
  const uriOf = (match: NonNullable<typeof matches>[number]) => ('sourceUri' in match ? match.sourceUri : match.uri);
  const projected = matches
    ? EffectArray.map(
        yield* selectRecallDocumentRows(sql, 'uri', [...new Set(EffectArray.map(matches, uriOf))]),
        decodeCandidateRow,
      )
    : 'selections' in options
      ? EffectArray.flatMap(recallIndexDataBatchResult(result), data => [
          ...data.candidates,
          ...(data.recentCandidates ?? []),
        ])
      : [...recallIndexDataResult(result).candidates, ...(recallIndexDataResult(result).recentCandidates ?? [])];
  const validate = yield* makeRecallReadyValidator(config, projected);
  let removed = false;
  const validateData = (data: RecallIndexData, selection: RecallIndexSelection) =>
    Effect.gen(function* () {
      const filter = (candidates: readonly RecallCandidate[]) =>
        Effect.gen(function* () {
          const checked = yield* Effect.forEach(
            candidates,
            candidate =>
              Effect.gen(function* () {
                if (!(yield* validate(candidate, selection))) {
                  removed = true;
                  return undefined;
                }
                const equivalentUris = candidate.equivalentUris
                  ? yield* Effect.filter(candidate.equivalentUris, uri =>
                      validate({...candidate, uri, equivalentUris: undefined}, selection),
                    )
                  : undefined;
                if ((equivalentUris?.length ?? 0) !== (candidate.equivalentUris?.length ?? 0)) removed = true;
                return {...candidate, ...(equivalentUris ? {equivalentUris} : {})};
              }),
            {concurrency: 8},
          );
          return EffectArray.filter(checked, (candidate): candidate is RecallCandidate => candidate !== undefined);
        });
      const candidates = yield* filter(data.candidates);
      const recentCandidates = data.recentCandidates ? yield* filter(data.recentCandidates) : undefined;
      return {...data, candidates, recentCandidates, queryExhaustive: data.queryExhaustive && !removed};
    });
  if ('selections' in options) {
    result = yield* Effect.forEach(recallIndexDataBatchResult(result), (data, i) =>
      validateData(data, {...options.selections[i], includeInactive: options.includeInactive}),
    );
  } else if (matches) {
    const eligibleUris = new Set(
      EffectArray.map(
        yield* Effect.filter(projected, candidate => validate(candidate, options), {concurrency: 8}),
        candidate => candidate.uri,
      ),
    );
    const kept = EffectArray.filter(matches, match => eligibleUris.has(uriOf(match)));
    removed = kept.length !== matches.length;
    result = kept;
  } else result = yield* validateData(recallIndexDataResult(result), options);
  return {result, removed};
});
