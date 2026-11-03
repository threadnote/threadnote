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
import {deduplicateLogicalRecallCandidates} from '../rank.js';
import {stripRecallAnchor} from './lexical.js';
import {
  DEFAULT_RECALL_QUERY_RESULT_LIMIT,
  MAX_READY_RECALL_SOURCE_CHECKS,
  RecallReadyReadIncomplete,
  type RecallReadyExactWindow,
} from './read_policy.js';
import {isExternalResourceUri} from '@threadnote/store/external-resource';

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
  exactWindows: readonly RecallReadyExactWindow[],
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
  const matchUris = [...new Set(EffectArray.map(matches ?? [], uriOf))];
  if (matchUris.length > MAX_READY_RECALL_SOURCE_CHECKS)
    return yield* RecallReadyReadIncomplete.make({
      message: 'Ready recall selection exceeds its bounded source window.',
    });
  const projected = matches
    ? EffectArray.map(yield* selectRecallDocumentRows(sql, 'uri', matchUris), decodeCandidateRow)
    : 'selections' in options
      ? EffectArray.flatMap(recallIndexDataBatchResult(result), data => [
          ...data.candidates,
          ...(data.recentCandidates ?? []),
        ])
      : [...recallIndexDataResult(result).candidates, ...(recallIndexDataResult(result).recentCandidates ?? [])];
  if (
    new Set(EffectArray.flatMap(projected, candidate => [candidate.uri, ...(candidate.equivalentUris ?? [])])).size >
    MAX_READY_RECALL_SOURCE_CHECKS
  )
    return yield* RecallReadyReadIncomplete.make({
      message: 'Ready recall selection exceeds its bounded source window.',
    });
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
      const authorized = yield* Effect.filter(
        data.candidates,
        candidate => (isExternalResourceUri(candidate.uri) ? validate(candidate, selection) : Effect.succeed(true)),
        {concurrency: 8},
      );
      if (authorized.length !== data.candidates.length) removed = true;
      const live = deduplicateLogicalRecallCandidates(authorized);
      const limit =
        selection.limit ?? (selection.memoryIds !== undefined ? live.length : DEFAULT_RECALL_QUERY_RESULT_LIMIT);
      const required = new Set(EffectArray.map(selection.requiredUris ?? [], stripRecallAnchor));
      const pinned =
        selection.query === undefined
          ? []
          : EffectArray.filter(live, candidate =>
              EffectArray.some([candidate.uri, ...(candidate.equivalentUris ?? [])], uri =>
                required.has(stripRecallAnchor(uri)),
              ),
            );
      const ranked = EffectArray.filter(live, candidate => !pinned.includes(candidate));
      if (!data.queryExhaustive && removed && ranked.length < limit)
        return yield* RecallReadyReadIncomplete.make({
          message: 'Ready recall authorization did not cover a complete candidate window.',
        });
      const candidates = yield* filter([...pinned, ...ranked.slice(0, limit)]);
      const recentCandidates = data.recentCandidates
        ? deduplicateLogicalRecallCandidates(yield* filter(data.recentCandidates))
        : undefined;
      return {
        ...data,
        candidates,
        recentCandidates,
        queryExhaustive: data.queryExhaustive && ranked.length <= limit && !removed,
      };
    });
  if ('selections' in options) {
    result = yield* Effect.forEach(recallIndexDataBatchResult(result), (data, i) =>
      validateData(data, {...options.selections[i], includeInactive: options.includeInactive}),
    );
  } else if (matches && 'terms' in options) {
    const limit = Math.max(0, Math.floor(options.limitPerTerm ?? 25));
    const byUri = new Map(EffectArray.map(projected, candidate => [candidate.uri, candidate] as const));
    const chosen = new Map<string, Set<string>>();
    for (const window of exactWindows) {
      const authorized: string[] = [];
      for (let offset = 0; offset < window.uris.length && authorized.length < limit; offset += 8) {
        const checked = yield* Effect.forEach(
          window.uris.slice(offset, offset + 8),
          uri => {
            const candidate = byUri.get(uri);
            return candidate
              ? validate(candidate, options).pipe(Effect.map(eligible => ({uri, eligible})))
              : Effect.succeed({uri, eligible: false});
          },
          {concurrency: 8},
        );
        for (const check of checked) {
          if (check.eligible) authorized.push(check.uri);
          else removed = true;
        }
      }
      if (!window.complete && authorized.length < limit)
        return yield* RecallReadyReadIncomplete.make({
          message: 'Ready exact authorization did not cover a complete candidate window.',
        });
      for (const uri of authorized.slice(0, limit)) {
        const terms = chosen.get(uri) ?? new Set<string>();
        terms.add(window.term);
        chosen.set(uri, terms);
      }
    }
    result = EffectArray.flatMap(recallExactMatchesResult(matches), match => {
      const terms = EffectArray.filter(match.terms, term => chosen.get(match.uri)?.has(term) === true);
      return terms.length ? [{...match, terms}] : [];
    });
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
