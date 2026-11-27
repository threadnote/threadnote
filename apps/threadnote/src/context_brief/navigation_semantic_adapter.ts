import * as EffectArray from 'effect/Array';
import * as EffectString from 'effect/String';
import {Cause, Effect, Option, Path, Schema} from 'effect';
import {readDeadlineRemaining} from '@threadnote/platform/read_deadline';
import {canonicalFileUri, Observation} from '@threadnote/semantic/contracts';
import {createCodeGraphSourceSpanCanonicalizer} from '@threadnote/graph/citation/primitives';
import {codeGraphCitationSourceKey, readCodeGraphCitationSources} from '@threadnote/graph/citation/source';
import type {CodeGraphSpan} from '@threadnote/graph/types';
import {bindSemanticContextSource} from '@threadnote/context/compiler';
import {NAVIGATION_INPUT_LIMITS, navigationScopeKey, type NavigationInput} from '@threadnote/context/navigation/model';
import type {NavigationSemanticRequestV1} from '@threadnote/context/navigation/semantic';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {semanticProviderNotRunning, type SemanticAgentQueryResult} from '../semantic/agent_query_protocol.js';
import {
  runSemanticAgentQueryWith,
  semanticAgentQueryHost,
  type SemanticAgentQueryHost,
} from '../semantic/agent_queries.js';
import {
  attachSemanticEndpoint,
  type ensureSemanticEndpoint,
  type SemanticEndpointLaunch,
} from '../semantic/coordinator.js';
import {semanticHostSelection, type SemanticHostCatalog} from '../semantic/host_catalog.js';
import {readSemanticHostProfile} from '../semantic/host_profile.js';
import type {SemanticLanguage} from '../semantic/provider.js';
import {
  acquireSemanticNavigationEvidence,
  withSemanticNavigationEvidence,
  type SemanticNavigationAnchor,
  type SemanticNavigationOperation,
  type SemanticNavigationPorts,
} from './navigation_evidence.js';

type SemanticEndpoint = Effect.Success<ReturnType<typeof ensureSemanticEndpoint>>;

/** Host ports of the navigation semantic adapter. Neither port can start a coordinator or a provider. */
export interface NavigationSemanticHost {
  readonly runtimeIdentity: SemanticAgentQueryHost['runtimeIdentity'];
  /** The coordinator that runs now for this exact launch identity, or undefined. It never starts one. */
  readonly attach: (
    launch: SemanticEndpointLaunch,
  ) => Effect.Effect<
    SemanticEndpoint | undefined,
    Effect.Error<ReturnType<typeof ensureSemanticEndpoint>>,
    Effect.Services<ReturnType<typeof ensureSemanticEndpoint>>
  >;
}

export const navigationSemanticHost: NavigationSemanticHost = {
  runtimeIdentity: semanticAgentQueryHost.runtimeIdentity,
  attach: launch => attachSemanticEndpoint(launch),
};

/** Navigation asks callers and references; a definition query of a declaration only returns that declaration. */
const OPERATIONS: readonly SemanticNavigationOperation[] = ['call-hierarchy', 'references'];
const NOT_RUNNING = semanticProviderNotRunning.reason;
const MAXIMUM_SOURCE_BYTES = 4 * 1024 * 1024;

/** The semantic language of a repository path, by file extension; Kotlin stays deferred. */
export function navigationSemanticLanguage(path: string): SemanticLanguage | 'kotlin' | undefined {
  // The extension of the last path segment; a name that only starts with a dot has none.
  const extension = EffectString.toLowerCase(/[^/]\.([^./]+)$/u.exec(path)?.[1] ?? '');
  switch (extension) {
    case 'ts':
    case 'mts':
    case 'cts':
      return 'typescript';
    case 'tsx':
      return 'typescriptreact';
    case 'js':
    case 'mjs':
    case 'cjs':
      return 'javascript';
    case 'jsx':
      return 'javascriptreact';
    case 'py':
    case 'pyi':
      return 'python';
    case 'go':
      return 'go';
    case 'rs':
      return 'rust';
    case 'java':
      return 'java';
    case 'kt':
    case 'kts':
      return 'kotlin';
    default:
      return undefined;
  }
}

/**
 * LSP and graph line numbers can differ when the text has a lone CR, U+2028 or U+2029: the graph counts each
 * as a line break and providers do not all agree. Bytes that are not UTF-8 are 'invalid'.
 */
export function navigationLineConvention(bytes: Uint8Array): 'supported' | 'unsupported' | 'invalid' {
  let text: string;
  try {
    text = new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(bytes);
  } catch {
    return 'invalid';
  }
  return /\r(?!\n)|[\u2028\u2029]/u.test(text) ? 'unsupported' : 'supported';
}

const identifierBoundary = '[\\p{L}\\p{N}_$]';

/** True when `text` has an odd count of `quote`, that is, an open string at its end. */
const openQuote = (text: string, quote: string) => {
  let count = 0;
  for (const character of text) if (character === quote) count++;
  return count % 2 === 1;
};

/**
 * The zero-based LSP position (UTF-16 character) of the declared name inside a one-based graph declaration span.
 * A declaration span can contain annotations, decorators, strings and comments, and the graph gives no name span.
 * So the name must occur exactly once as a whole identifier in the span, and that occurrence must not follow
 * '@', a line comment, an open quote on its line or an open block comment. Otherwise the result is undefined:
 * the adapter never guesses a position.
 */
export function navigationAnchorPosition(
  text: string,
  span: CodeGraphSpan,
  name: string,
  lineComment: '//' | '#' = '//',
): {readonly line: number; readonly character: number} | undefined {
  if (name === '') return undefined;
  const fragment = createCodeGraphSourceSpanCanonicalizer(text).fragment(span);
  if (!fragment.ok) return undefined;
  const {startOffset, endOffset} = fragment.fragment;
  const escaped = EffectString.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')(name);
  const occurrence = new RegExp(`(?<!${identifierBoundary})${escaped}(?!${identifierBoundary})`, 'gu');
  occurrence.lastIndex = startOffset;
  const found: number[] = [];
  for (let match = occurrence.exec(text); match !== null; match = occurrence.exec(text)) {
    if (match.index + name.length > endOffset) break;
    found.push(match.index);
  }
  const only = found[0];
  if (only === undefined || found.length !== 1) return undefined;
  const breaks = /\n/gu;
  let line = 0;
  let lineStart = 0;
  for (let match = breaks.exec(text); match !== null && match.index < only; match = breaks.exec(text)) {
    line++;
    lineStart = match.index + 1;
  }
  const before = EffectString.slice(lineStart, only)(text);
  if (
    EffectString.endsWith('@')(before) ||
    EffectString.includes(lineComment)(before) ||
    openQuote(before, '"') ||
    openQuote(before, "'") ||
    openQuote(before, '`')
  )
    return undefined;
  if (lineComment === '//') {
    let blockComment = false;
    for (const marker of EffectString.matchAll(/\/\*|\*\//gu)(EffectString.slice(startOffset, only)(text)))
      blockComment = marker[0] === '/*';
    if (blockComment) return undefined;
  }
  return {line, character: only - lineStart};
}

/** Add gaps after the existing ones, inside the gap limit; existing gaps are never removed. */
function withAddedGaps(input: NavigationInput, gaps: readonly string[]): NavigationInput {
  const kept = [...(input.gaps ?? [])];
  for (const gap of gaps) if (!kept.includes(gap) && kept.length < NAVIGATION_INPUT_LIMITS.gaps) kept.push(gap);
  return kept.length === (input.gaps?.length ?? 0) ? input : {...input, gaps: kept};
}

const unavailable = (reason: string): SemanticAgentQueryResult => ({
  version: 1,
  status: 'unavailable',
  reason,
  evidence: null,
});

/** Stop the work at an interruption; any other cause gives `fallback`. */
const softly = <A, E, R>(effect: Effect.Effect<A, E, R>, fallback: () => A): Effect.Effect<A, never, R> =>
  effect.pipe(Effect.catchCause(cause => (Cause.hasInterrupts(cause) ? Effect.interrupt : Effect.succeed(fallback()))));

/** One endpoint for a coordinator that does not run: every query is not-running and nothing is observed. */
const notRunningEndpoint: SemanticEndpoint = {
  request: body =>
    Effect.succeed(
      body.operation === 'agent-query'
        ? structuredClone(semanticProviderNotRunning)
        : {status: 'unavailable', reason: NOT_RUNNING},
    ),
};

function environmentFor(
  catalog: SemanticHostCatalog,
  language: SemanticLanguage,
): {readonly ok: boolean; readonly environment?: string} {
  if (!catalog[semanticHostSelection[language].slot]) return {ok: false};
  if (language !== 'python' && language !== 'java') return {ok: true};
  // One configured environment is the only unambiguous choice without a caller selection.
  const environments = (language === 'python' ? catalog.python?.environments : catalog.java?.environments) ?? [];
  return environments.length === 1 ? {ok: true, environment: environments[0].id} : {ok: false};
}

const enrich = Effect.fn('navigation.semanticEnrichment')(function* (
  config: RuntimeConfig,
  host: NavigationSemanticHost,
  request: NavigationSemanticRequestV1,
) {
  const path = yield* Path.Path;
  const gaps: string[] = [];
  const root = request.identity.repoRoot;
  const worktreeUri = canonicalFileUri((yield* path.toFileUrl(root)).href);
  // The worktree host profile is the only authorization; without it the structural answer stays as it is.
  const selected = yield* readSemanticHostProfile(config, worktreeUri).pipe(Effect.option);
  if (Option.isNone(selected)) return withAddedGaps(request.input, ['semantic-unavailable']);
  const catalog = selected.value.profile.catalog;

  const graphSource = (repositoryPath: string, contentHash: string) =>
    readCodeGraphCitationSources({
      allowCommitFallback: false,
      objectFormat: request.identity.objectFormat,
      repositoryRoot: root,
      sourceCommit: request.observation.snapshot.commit,
      retainedBytesLimit: MAXIMUM_SOURCE_BYTES,
      sources: [{repositoryPath, expectedContentHash: contentHash, requireBytes: true}],
    }).pipe(
      Effect.map(resolved =>
        resolved.get(codeGraphCitationSourceKey({repositoryPath, expectedContentHash: contentHash})),
      ),
    );

  const anchors: SemanticNavigationAnchor[] = [];
  let configured = false;
  for (const anchor of request.anchors.slice(0, 2)) {
    const language = navigationSemanticLanguage(anchor.path);
    if (language === undefined) {
      gaps.push('semantic-capability-unsupported');
      continue;
    }
    if (language === 'kotlin') {
      gaps.push('semantic-capability-deferred');
      continue;
    }
    if (!environmentFor(catalog, language).ok) {
      gaps.push('semantic-capability-prerequisite-blocked');
      continue;
    }
    configured = true;
    const read = yield* softly(
      graphSource(anchor.path, anchor.contentHash).pipe(
        Effect.map((bytes): {readonly failed: boolean; readonly bytes?: Uint8Array} => ({failed: false, bytes})),
      ),
      (): {readonly failed: boolean; readonly bytes?: Uint8Array} => ({failed: true}),
    );
    if (read.failed) {
      gaps.push('semantic-anchor-position-unresolved');
      continue;
    }
    const bytes = read.bytes;
    const convention = bytes === undefined ? 'invalid' : navigationLineConvention(bytes);
    if (convention === 'unsupported') {
      gaps.push('semantic-line-convention-unsupported');
      continue;
    }
    const position =
      bytes === undefined || convention === 'invalid'
        ? undefined
        : navigationAnchorPosition(
            new TextDecoder('utf-8', {ignoreBOM: true}).decode(bytes),
            anchor.span,
            anchor.name,
            language === 'python' ? '#' : '//',
          );
    if (position === undefined) {
      gaps.push('semantic-anchor-position-unresolved');
      continue;
    }
    anchors.push({candidateId: anchor.candidateId, path: anchor.path, position});
  }
  if (!configured) return withAddedGaps(request.input, ['semantic-unavailable', ...gaps]);
  if (anchors.length === 0) return withAddedGaps(request.input, gaps);

  // One attachment per answer, success or failure. A coordinator that does not run gives not-running answers,
  // and a failed attachment gives unavailable answers, with no new probe.
  let endpoint: SemanticEndpoint | undefined;
  let attachFailed = false;
  let notRunning = false;
  const queryHost: SemanticAgentQueryHost = {
    runtimeIdentity: host.runtimeIdentity,
    attachOnly: true,
    connect: launch =>
      endpoint !== undefined
        ? Effect.succeed(endpoint)
        : host.attach(launch).pipe(
            Effect.onExit(exit =>
              Effect.sync(() => {
                if (exit._tag === 'Failure' && !Cause.hasInterrupts(exit.cause)) attachFailed = true;
              }),
            ),
            Effect.map(attached => {
              endpoint = attached ?? notRunningEndpoint;
              return endpoint;
            }),
          ),
  };
  const observations = new Map<string, Observation>();
  const bounded = <A>(milliseconds: number, effect: Effect.Effect<A, unknown, never>, fallback: () => A) =>
    softly(
      effect.pipe(
        Effect.timeoutOption(Math.max(1, Math.floor(milliseconds))),
        Effect.map(result => (Option.isSome(result) ? result.value : fallback())),
      ),
      fallback,
    );
  const requestedScope = navigationScopeKey(request.scope);
  const graph = {
    identity: request.identity,
    repositoryId: request.observation.repository.repositoryId,
    snapshot: request.observation.snapshot,
    freshness: request.observation.freshness,
    contentHashes: (repositoryPath: string) =>
      EffectArray.map(
        EffectArray.filter(
          request.input.sources,
          source => source.path === repositoryPath && navigationScopeKey(source) === requestedScope,
        ),
        source => source.contentHash,
      ),
  };
  const services = yield* Effect.context<
    | Effect.Services<ReturnType<typeof runSemanticAgentQueryWith<never>>>
    | Effect.Services<ReturnType<typeof bindSemanticContextSource>>
  >();

  const ports: SemanticNavigationPorts<never> = {
    capability: (_operation, documentPath) => {
      const language = navigationSemanticLanguage(documentPath);
      return Effect.succeed(
        language === undefined
          ? 'unsupported'
          : language === 'kotlin'
            ? 'deferred'
            : environmentFor(catalog, language).ok
              ? // Production qualification is pending for every provider, so no link is qualified yet.
                'experimental'
              : 'prerequisite-blocked',
      );
    },
    query: ({path: documentPath, operation, position, milliseconds}) => {
      if (notRunning) return Effect.succeed(structuredClone(semanticProviderNotRunning));
      if (attachFailed) return Effect.succeed(unavailable('Semantic coordinator attachment failed'));
      const language = navigationSemanticLanguage(documentPath);
      if (language === undefined || language === 'kotlin')
        return Effect.succeed(unavailable('No semantic provider is selected for this language'));
      const {environment} = environmentFor(catalog, language);
      return softly(
        runSemanticAgentQueryWith(queryHost, config, {
          callerCwd: root,
          file: documentPath,
          language,
          operation,
          position,
          maxItems: 20,
          maxBytes: 8192,
          milliseconds: Math.min(45000, Math.max(1, Math.floor(milliseconds))),
          ...(environment === undefined ? {} : {environment}),
        }).pipe(
          Effect.tap(result =>
            Effect.sync(() => {
              if (result.status === 'unavailable' && result.reason === NOT_RUNNING) notRunning = true;
              if (result.status === 'ok') observations.set(documentPath, result.evidence.observation);
            }),
          ),
          Effect.provide(services),
        ),
        () => unavailable('Semantic read prerequisites are unavailable'),
      );
    },
    observe: (documentPath, milliseconds) => {
      const current = endpoint;
      if (current === undefined || current === notRunningEndpoint) return Effect.succeed(null);
      // A far-end document reuses the provider session of a queried document in the same language.
      const language = navigationSemanticLanguage(documentPath);
      const known =
        observations.get(documentPath) ??
        EffectArray.findFirst(
          [...observations.entries()],
          ([queried]) => navigationSemanticLanguage(queried) === language,
        ).pipe(
          Option.map(([, observation]) => observation),
          Option.getOrUndefined,
        );
      if (known === undefined) return Effect.succeed(null);
      return bounded(
        milliseconds,
        Effect.gen(function* () {
          const uri = canonicalFileUri(
            (yield* path.toFileUrl(path.join(root, ...EffectString.split('/')(documentPath)))).href,
          );
          const raw = yield* current.request({
            operation: 'agent-observe',
            observation: {...known, uri},
            milliseconds: Math.min(45000, Math.max(1, Math.floor(milliseconds))),
          });
          const observed = Option.getOrUndefined(Schema.decodeUnknownOption(Observation)(raw));
          if (observed === undefined || observed.uri !== uri || observed.view.kind !== 'disk') return null;
          observations.set(documentPath, observed);
          return observed;
        }).pipe(Effect.provide(services)),
        () => null,
      );
    },
    bind: (_documentPath, observation) =>
      Effect.gen(function* () {
        const left = yield* readDeadlineRemaining(request.deadline);
        return yield* bounded(
          left,
          bindSemanticContextSource(graph, {
            basis: 'semantic',
            observation,
            scope: 'document',
            completeness: 'partial',
            limitations: [],
          }).pipe(
            Effect.map(({binding, bytes}) => {
              if (binding === null || bytes === undefined) return {binding: null};
              const convention = navigationLineConvention(bytes);
              return convention === 'supported'
                ? {binding}
                : convention === 'unsupported'
                  ? {binding: null, refusal: 'line-convention-unsupported' as const}
                  : {binding: null};
            }),
            Effect.provide(services),
          ),
          () => ({binding: null}),
        );
      }),
  };
  const evidence = yield* acquireSemanticNavigationEvidence({
    worktreeUri,
    anchors,
    operations: OPERATIONS,
    deadline: request.deadline,
    ports,
  });
  return withAddedGaps(withSemanticNavigationEvidence(request.input, evidence), [
    ...gaps,
    ...(notRunning ? ['semantic-provider-not-running'] : []),
    ...(attachFailed ? ['semantic-unavailable'] : []),
  ]);
});

/** Services the navigation semantic dependency needs from the application runtime. */
export type NavigationSemanticServices = Effect.Services<
  ReturnType<ReturnType<typeof makeNavigationSemanticDependency>>
>;

/**
 * The application's navigation semantic dependency. It enriches one structural input inside the request
 * deadline, attaches only to a running coordinator and provider session, and never fails: any cause other
 * than an interruption keeps the structural input and adds a gap.
 */
export function makeNavigationSemanticDependency(
  config: RuntimeConfig,
  host: NavigationSemanticHost = navigationSemanticHost,
) {
  return (request: NavigationSemanticRequestV1) =>
    Effect.gen(function* () {
      const left = yield* readDeadlineRemaining(request.deadline);
      if (left <= 0) return withAddedGaps(request.input, ['semantic-deadline-exhausted']);
      const enriched = yield* enrich(config, host, request).pipe(Effect.timeoutOption(left));
      return Option.isSome(enriched) ? enriched.value : withAddedGaps(request.input, ['semantic-deadline-exhausted']);
    }).pipe(effect => softly(effect, () => withAddedGaps(request.input, ['semantic-unavailable'])));
}
