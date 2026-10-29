import {Array as EffectArray} from 'effect';
import {Effect, Option} from 'effect';
import {uriSegment} from '@threadnote/workspace/manifest';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {loadMcpRecallSemanticScoresResult, prepareRecallSections} from '@threadnote/recall/runtime';
import {renderRecallOperationalWarning} from '@threadnote/recall/warning';
import type {LibrarySearchResponse} from '@threadnote/manager/ui/contracts';
import {readMemoryRecordsByUri} from '../memory/index.js';
import {ManagerOperationError} from './operation_error.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

/** Search active indexes without running CLI sync, repairs or query-expansion agents per keystroke. */
export const searchManagerLibrary = Effect.fn('manager.searchLibrary')(function* (config: RuntimeConfig, url: URL) {
  const query = Effect2.pipe(url.searchParams.get('query') ?? '', EffectString.trim);
  const scope = url.searchParams.get('scope') ?? 'local';
  if (!query || query.length > 1024)
    return yield* ManagerOperationError.make({message: 'Library search requires a query of 1–1024 characters.'});
  if (
    scope !== 'local' &&
    (!Effect2.pipe(scope, EffectString.startsWith('team:')) ||
      !Effect2.pipe(scope, EffectString.slice(5), EffectString.trim))
  )
    return yield* ManagerOperationError.make({message: 'Choose Local or a named Team library.'});
  const root = `threadnote://user/${uriSegment(config.user)}/memories`;
  const prefix = scope === 'local' ? root : `${root}/shared/${uriSegment(Effect2.pipe(scope, EffectString.slice(5)))}`;
  const eligibility = {kind: 'pinned-hard-uri-bypass'} as const;
  const semantic = yield* loadMcpRecallSemanticScoresResult(config, query, 100, eligibility, [prefix]);
  const sections = yield* prepareRecallSections(config, {
    query,
    feedbackQuery: query,
    limit: 100,
    includeInactive: false,
    allowExactRescue: true,
    allowSemanticRescue: true,
    allowedUriScopes: [prefix],
    eligibility,
    exactMatches: [],
    passes: [],
    semanticResult: Option.some(semantic.result),
    semanticGenerationMismatchPolicy: 'fallback',
    readRecords: uris => readMemoryRecordsByUri(config, uris),
  });
  // Browser search also retains literal body matches that the answer-oriented
  // recall confidence gate intentionally omits without semantic corroboration.
  const expansionCandidates = sections.expansionCandidates;
  const literalCandidates = EffectArray.filter(
    expansionCandidates,
    (candidate, __effectArrayIndex) =>
      __effectArrayIndex in expansionCandidates &&
      Effect2.pipe(candidate.text, __effectPipeInput => {
        const __effectPipeStage0 = Effect2.pipe(__effectPipeInput, EffectString.toLocaleLowerCase());
        const __effectPipeStage1 = Effect2.pipe(
          __effectPipeStage0,
          EffectString.includes(Effect2.pipe(query, EffectString.toLocaleLowerCase())),
        );
        return __effectPipeStage1;
      }),
  ).slice(0, 100);
  const literalRecords = yield* readMemoryRecordsByUri(
    config,
    EffectArray.map(literalCandidates, candidate => candidate.uri),
  );
  const literalUris = EffectArray.map(
    EffectArray.filter(
      literalRecords,
      (record, __effectArrayIndex) =>
        __effectArrayIndex in literalRecords &&
        Effect2.pipe(record.body, __effectPipeInput => {
          const __effectPipeStage0 = Effect2.pipe(__effectPipeInput, EffectString.toLocaleLowerCase());
          const __effectPipeStage1 = Effect2.pipe(
            __effectPipeStage0,
            EffectString.includes(Effect2.pipe(query, EffectString.toLocaleLowerCase())),
          );
          return __effectPipeStage1;
        }),
    ),
    record => record.uri,
  );
  const uris = EffectArray.filter(
    [
      ...new Set([
        ...EffectArray.map(sections.ranked, hit => Effect2.pipe(hit.uri, EffectString.replace(/#.*$/u, ''))),
        ...literalUris,
      ]),
    ],
    uri =>
      Effect2.pipe(uri, EffectString.startsWith(prefix + '/')) &&
      (scope !== 'local' || !Effect2.pipe(uri, EffectString.startsWith(root + '/shared/'))),
  );
  return {
    uris: uris.slice(0, 100),
    semantic: Option.isSome(sections.semanticResult.scores)
      ? 'available'
      : semantic.status === 'available'
        ? 'unavailable'
        : semantic.status,
    warnings: [
      ...Option.toArray(sections.semanticResult.warning),
      ...EffectArray.map(sections.operationalWarnings, renderRecallOperationalWarning),
    ],
  } satisfies LibrarySearchResponse;
});
