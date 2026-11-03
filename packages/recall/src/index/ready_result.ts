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
  const byUri = new Map(EffectArray.map(projected, candidate => [candidate.uri, candidate] as const));
  let reconcileNeeded = false;
  let unverified = false;
  const check = (candidate: RecallCandidate, selection: Parameters<typeof validate>[1]) => {
    const indexed = byUri.get(candidate.uri);
    return (indexed ? validate(indexed, selection) : Effect.succeed('stale' as const)).pipe(
      Effect.map(state => {
        if (state === 'stale') reconcileNeeded = true;
        if (state === 'unverified') unverified = true;
        return state === 'eligible';
      }),
    );
  };
  const incomplete = (message: string) =>
    RecallReadyReadIncomplete.make({
      message,
      ...(reconcileNeeded ? {maintenance: 'reconcile' as const} : {}),
    });
  const validateData = (data: RecallIndexData, selection: RecallIndexSelection) =>
    Effect.gen(function* () {
      // Conflict/enrichment annotations belong to this selection's authorized scope.
      const selectedByUri = new Map(
        EffectArray.map(
          [...data.candidates, ...(data.recentCandidates ?? [])],
          candidate => [candidate.uri, candidate] as const,
        ),
      );
      let excluded = false;
      const filter = (candidates: readonly RecallCandidate[]) =>
        Effect.gen(function* () {
          const checked = yield* Effect.forEach(
            candidates,
            candidate =>
              Effect.gen(function* () {
                if (!(yield* check(candidate, selection))) {
                  excluded = true;
                  return undefined;
                }
                const equivalentUris = candidate.equivalentUris
                  ? yield* Effect.filter(candidate.equivalentUris, uri =>
                      check({...candidate, uri, equivalentUris: undefined}, selection),
                    )
                  : undefined;
                if ((equivalentUris?.length ?? 0) !== (candidate.equivalentUris?.length ?? 0)) excluded = true;
                // Merge only independently verified physical projections. Otherwise a
                // rejected alias could leave its relations on the logical result.
                return deduplicateLogicalRecallCandidates(
                  EffectArray.flatMap([candidate.uri, ...(equivalentUris ?? [])], uri => {
                    const indexed = selectedByUri.get(uri);
                    return indexed ? [indexed] : [];
                  }),
                )[0];
              }),
            {concurrency: 8},
          );
          return EffectArray.filter(checked, (candidate): candidate is RecallCandidate => candidate !== undefined);
        });
      const authorized = yield* Effect.filter(
        data.candidates,
        candidate => (isExternalResourceUri(candidate.uri) ? check(candidate, selection) : Effect.succeed(true)),
        {concurrency: 8},
      );
      if (authorized.length !== data.candidates.length) excluded = true;
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
      const pinnedCandidates = yield* filter(pinned);
      const rankedCandidates: RecallCandidate[] = [];
      for (let offset = 0; offset < ranked.length && rankedCandidates.length < limit; offset += 8)
        rankedCandidates.push(...(yield* filter(ranked.slice(offset, offset + 8))));
      if (!data.queryExhaustive && excluded && rankedCandidates.length < limit)
        return yield* incomplete('Ready recall authorization did not cover a complete candidate window.');
      const candidates = [...pinnedCandidates, ...rankedCandidates.slice(0, limit)];
      const recentCandidates = data.recentCandidates
        ? deduplicateLogicalRecallCandidates(yield* filter(data.recentCandidates))
        : undefined;
      return {
        ...data,
        candidates,
        recentCandidates,
        queryExhaustive: data.queryExhaustive && ranked.length <= limit && !excluded,
      };
    });
  if ('selections' in options) {
    result = yield* Effect.forEach(recallIndexDataBatchResult(result), (data, i) =>
      validateData(data, {...options.selections[i], includeInactive: options.includeInactive}),
    );
  } else if (matches && 'terms' in options) {
    const limit = Math.max(0, Math.floor(options.limitPerTerm ?? 25));
    const chosen = new Map<string, Set<string>>();
    for (const window of exactWindows) {
      const authorized: string[] = [];
      for (let offset = 0; offset < window.uris.length && authorized.length < limit; offset += 8) {
        const checked = yield* Effect.forEach(
          window.uris.slice(offset, offset + 8),
          uri => {
            const candidate = byUri.get(uri);
            return candidate
              ? check(candidate, options).pipe(Effect.map(eligible => ({uri, eligible})))
              : Effect.sync(() => {
                  reconcileNeeded = true;
                  return {uri, eligible: false};
                });
          },
          {concurrency: 8},
        );
        for (const check of checked) {
          if (check.eligible) authorized.push(check.uri);
        }
      }
      if (!window.complete && authorized.length < limit)
        return yield* incomplete('Ready exact authorization did not cover a complete candidate window.');
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
        yield* Effect.filter(projected, candidate => check(candidate, options), {concurrency: 8}),
        candidate => candidate.uri,
      ),
    );
    const kept = EffectArray.filter(matches, match => eligibleUris.has(uriOf(match)));
    if (EffectArray.some(matchUris, uri => !EffectArray.some(projected, candidate => candidate.uri === uri)))
      reconcileNeeded = true;
    result = kept;
  } else result = yield* validateData(recallIndexDataResult(result), options);
  return {result, reconcileNeeded, unverified};
});
