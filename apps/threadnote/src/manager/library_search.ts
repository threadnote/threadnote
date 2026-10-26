import {Effect, Option} from 'effect';
import {uriSegment} from '@threadnote/workspace/manifest';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {loadMcpRecallSemanticScoresResult, prepareRecallSections} from '@threadnote/recall/runtime';
import {renderRecallOperationalWarning} from '@threadnote/recall/warning';
import type {LibrarySearchResponse} from '@threadnote/manager/ui/contracts';
import {readMemoryRecordsByUri} from '../memory/index.js';
import {ManagerOperationError} from './operation_error.js';

/** Search active indexes without running CLI sync, repairs or query-expansion agents per keystroke. */
export const searchManagerLibrary = Effect.fn('manager.searchLibrary')(function* (config: RuntimeConfig, url: URL) {
  const query = (url.searchParams.get('query') ?? '').trim();
  const scope = url.searchParams.get('scope') ?? 'local';
  if (!query || query.length > 1024)
    return yield* ManagerOperationError.make({message: 'Library search requires a query of 1–1024 characters.'});
  if (scope !== 'local' && (!scope.startsWith('team:') || !scope.slice(5).trim()))
    return yield* ManagerOperationError.make({message: 'Choose Local or a named Team library.'});
  const root = `threadnote://user/${uriSegment(config.user)}/memories`;
  const prefix = scope === 'local' ? root : `${root}/shared/${uriSegment(scope.slice(5))}`;
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
  const literalCandidates = sections.expansionCandidates
    .filter(candidate => candidate.text.toLocaleLowerCase().includes(query.toLocaleLowerCase()))
    .slice(0, 100);
  const literalRecords = yield* readMemoryRecordsByUri(
    config,
    literalCandidates.map(candidate => candidate.uri),
  );
  const literalUris = literalRecords
    .filter(record => record.body.toLocaleLowerCase().includes(query.toLocaleLowerCase()))
    .map(record => record.uri);
  const uris = [...new Set([...sections.ranked.map(hit => hit.uri.replace(/#.*$/u, '')), ...literalUris])].filter(
    uri => uri.startsWith(prefix + '/') && (scope !== 'local' || !uri.startsWith(root + '/shared/')),
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
      ...sections.operationalWarnings.map(renderRecallOperationalWarning),
    ],
  } satisfies LibrarySearchResponse;
});
