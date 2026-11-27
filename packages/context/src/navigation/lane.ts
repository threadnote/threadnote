import {Array as EffectArray, Effect, Schema} from 'effect';
import {
  AGENT_RESPONSE_ESTIMATED_BYTES_PER_TOKEN,
  type measureAgentToolResponse,
} from '@threadnote/protocol/agent-response';
import {
  makeReadDeadline,
  ReadDeadlineExceeded,
  readDeadlineRemaining,
  withinReadDeadline,
  type ReadDeadline,
} from '@threadnote/platform/read_deadline';
import {CONTEXT_BRIEF_READ_MILLISECONDS} from '../compiler.js';
import {renderProjectionChannels} from '../projector/selection.js';
import {assembleNavigationAnswer} from './assemble.js';
import {
  decodeNavigationContinuation,
  encodeNavigationContinuation,
  invalidatedNavigationEffects,
  navigationEffectsDelta,
  type NavigationEffectsDelta,
} from './continuation.js';
import {navigationScopeKey, withNavigationGaps, type NavigationAnswerV1} from './model.js';
import {projectNavigationAnswer, selectNavigationMemory, type NavigationProjection} from './project.js';
import type {NavigationReadEvidenceV1, NavigationReadRequestV1, NavigationReadResultV1} from './read.js';
import {parseContextBriefNavigationRequestV1, type ContextBriefNavigationRequestV1} from './request.js';
import type {NavigationSemanticDependency} from './semantic.js';

export const CONTEXT_BRIEF_NAVIGATION_TYPE = 'context-brief-navigation' as const;
/** Semantic enrichment ends this long after the request starts, or at the parent deadline when that is earlier. */
export const NAVIGATION_SEMANTIC_MILLISECONDS = 1500;
/** No semantic request starts with less time than one coordinator request needs. */
export const NAVIGATION_SEMANTIC_MINIMUM_MILLISECONDS = 500;

export interface NavigationLaneDependencies<NavigationR = never, SemanticR = never> {
  /**
   * The structural read. A deadline failure becomes a gap here; the application maps its other recoverable read
   * failures to an unavailable result, so the lane keeps a truthful answer.
   */
  readonly navigationEvidence: (
    request: NavigationReadRequestV1,
    deadline: ReadDeadline,
  ) => Effect.Effect<NavigationReadResultV1, unknown, NavigationR>;
  /** Optional; absent means a structural-only answer. Implemented by the application. */
  readonly navigationSemantic?: NavigationSemanticDependency<SemanticR>;
}

/** The read returned no memory step at all, for example a structural-only dependency. */
const MEMORY_GAP = 'navigation-memory-not-read';
/** Room for the envelope around the projection before measuring; the measured overflow refines it once. */
const ENVELOPE_RESERVE_BYTES = 192;

export interface ContextBriefNavigationV1 {
  readonly type: typeof CONTEXT_BRIEF_NAVIGATION_TYPE;
  readonly version: 1;
  readonly outcome: NavigationAnswerV1['outcome'] | 'unavailable' | 'follow-up';
  /** Lane-level limitations; the answer's own gaps stay in `navigation`. */
  readonly gaps: readonly string[];
  readonly navigation?: NavigationProjection;
  readonly followUp?: {
    readonly status: NavigationEffectsDelta['status'];
    readonly reason: string;
    readonly effects: readonly (readonly [
      id: string,
      path: string,
      startLine: number,
      endLine: number,
      support: string,
      effect?: readonly [kind: string, target: string, condition?: string],
    ])[];
  };
  /** Opaque, stateless and untrusted when it comes back; see `continuation` in the request. */
  readonly continuation?: string;
}

export interface ProjectedContextBriefNavigationV1 {
  readonly maximumBytes: number;
  readonly measurement: ReturnType<typeof measureAgentToolResponse>;
  readonly structuredContent: ContextBriefNavigationV1;
  readonly text: string;
}

/**
 * The navigate lane: structural first, then optional semantic enrichment, then the shared final-channel
 * projection. Existing Context Brief modes never reach this function, so they never pay for navigation work.
 * Byte identity holds only for an identical evidence outcome: the semantic step depends on its deadline.
 */
export const compileContextBriefNavigationWith = Effect.fn('contextBrief.navigation.compileWith')(function* <
  NavigationR = never,
  SemanticR = never,
>(dependencies: NavigationLaneDependencies<NavigationR, SemanticR>, input: unknown) {
  const request = parseContextBriefNavigationRequestV1(input);
  const readDeadline = yield* makeReadDeadline(CONTEXT_BRIEF_READ_MILLISECONDS);
  // The read deadline started with the request, so the semantic step ends 1500 ms after the start.
  const semanticDeadline: ReadDeadline = Object.freeze({
    expiresAtNanos:
      readDeadline.expiresAtNanos -
      BigInt(CONTEXT_BRIEF_READ_MILLISECONDS - NAVIGATION_SEMANTIC_MILLISECONDS) * 1_000_000n,
  });
  const continuation =
    request.continuation === undefined ? undefined : decodeNavigationContinuation(request.continuation.token);
  const invalid = (reason: string) => finish(request, {gaps: [], followUp: invalidatedNavigationEffects(reason)});
  if (request.scope.kind !== 'repository')
    return request.continuation === undefined
      ? finish(request, {gaps: ['navigation-workset-unsupported']})
      : invalid('navigation-workset-unsupported');
  if (request.continuation !== undefined && continuation === undefined)
    return invalid('navigation-continuation-invalid');
  const readRequest: NavigationReadRequestV1 = {
    scope: request.scope,
    task: request.task,
    codeRefs: request.codeRefs,
    maximumEstimatedTokens: request.budgetTokens,
    ...(continuation === undefined ? {} : {followUp: continuation.locators}),
  };
  const evidence = yield* withinReadDeadline(
    readDeadline,
    Effect.suspend(() => dependencies.navigationEvidence(readRequest, readDeadline)),
  ).pipe(
    Effect.catchIf(Schema.is(ReadDeadlineExceeded), () =>
      Effect.succeed<NavigationReadResultV1>({status: 'unavailable', gaps: ['navigation-read-deadline-exhausted']}),
    ),
  );
  if (evidence.status !== 'ok')
    return continuation === undefined
      ? finish(request, {gaps: evidence.gaps})
      : invalid(evidence.gaps[0] ?? 'navigation-follow-up-unresolved');
  const enriched = yield* enrich(dependencies.navigationSemantic, readRequest, evidence, semanticDeadline);
  const answer = assembleNavigationAnswer(enriched);
  if (continuation !== undefined)
    return finish(request, {gaps: [], followUp: navigationEffectsDelta(continuation.summary, answer)});
  return project(request, answer, evidence);
});

/** Optional semantic step. Its result must keep the scope and every structural candidate and source. */
const enrich = Effect.fn('contextBrief.navigation.enrich')(function* <R>(
  dependency: NavigationSemanticDependency<R> | undefined,
  request: NavigationReadRequestV1,
  evidence: NavigationReadEvidenceV1,
  deadline: ReadDeadline,
) {
  if (dependency === undefined || evidence.anchors.length === 0) return evidence.input;
  if ((yield* readDeadlineRemaining(deadline)) < NAVIGATION_SEMANTIC_MINIMUM_MILLISECONDS)
    return withNavigationGaps(evidence.input, ['semantic-enrichment-budget-exhausted']);
  const result = yield* withinReadDeadline(
    deadline,
    Effect.suspend(() =>
      dependency({
        callerCwd: request.scope.callerCwd,
        scope: evidence.input.scope,
        identity: evidence.identity,
        observation: evidence.observation,
        input: evidence.input,
        anchors: evidence.anchors,
        deadline,
      }),
    ),
  ).pipe(Effect.catchIf(Schema.is(ReadDeadlineExceeded), () => Effect.void));
  if (result === undefined) return withNavigationGaps(evidence.input, ['semantic-enrichment-budget-exhausted']);
  if (navigationScopeKey(result.scope) !== navigationScopeKey(evidence.input.scope))
    return withNavigationGaps(evidence.input, ['semantic-scope-changed']);
  if (!keeps(result.candidates, evidence.input.candidates) || !keeps(result.sources, evidence.input.sources))
    return withNavigationGaps(evidence.input, ['semantic-structural-evidence-dropped']);
  return result;
});

function keeps(after: readonly {readonly id: string}[], before: readonly {readonly id: string}[]): boolean {
  const ids = new Set(EffectArray.map(after, item => item.id));
  return EffectArray.every(before, item => ids.has(item.id));
}

/**
 * Project inside the request budget, envelope included. The first pass reserves a fixed envelope allowance; when the
 * measured envelope is larger, one more pass reserves the measured amount. The continuation is dropped before the
 * answer is, and an answer that cannot fit at all is reported as a gap.
 */
function project(
  request: ContextBriefNavigationRequestV1,
  answer: NavigationAnswerV1,
  evidence: NavigationReadEvidenceV1,
): ProjectedContextBriefNavigationV1 {
  const maximumBytes = request.budgetTokens * AGENT_RESPONSE_ESTIMATED_BYTES_PER_TOKEN;
  const token = encodeNavigationContinuation(answer);
  const memory = navigationMemory(request, answer, evidence);
  const routed = memory.selected?.answer ?? answer;
  const attempt = (continuation: string | undefined, reserve: number) => {
    try {
      const projected = projectNavigationAnswer(
        {answer: routed, proofLocators: evidence.proofLocators},
        request.budgetTokens,
        request.responseFormat,
        memory.selected?.memory ?? [],
        reserve,
      );
      const gaps =
        continuation === undefined && token !== undefined
          ? [...memory.gaps, 'navigation-continuation-omitted']
          : memory.gaps;
      const result = finish(request, {gaps, navigation: projected.structuredContent, continuation}, projected.text);
      return {result, overflow: result.measurement.totalBytes - maximumBytes};
    } catch {
      return undefined;
    }
  };
  for (const continuation of token === undefined ? [undefined] : [token, undefined]) {
    const reserve = ENVELOPE_RESERVE_BYTES + (continuation?.length ?? 0);
    const first = attempt(continuation, reserve);
    if (first !== undefined && first.overflow <= 0) return first.result;
    const second = first === undefined ? undefined : attempt(continuation, reserve + first.overflow);
    if (second !== undefined && second.overflow <= 0) return second.result;
  }
  return finish(request, {gaps: [...memory.gaps, 'navigation-budget-too-small']});
}

/** The memory step's routed answer and applicable memories, or the lane gaps that say why there are none. */
function navigationMemory(
  request: ContextBriefNavigationRequestV1,
  answer: NavigationAnswerV1,
  evidence: NavigationReadEvidenceV1,
): {readonly gaps: readonly string[]; readonly selected?: ReturnType<typeof selectNavigationMemory>} {
  const read = evidence.memory;
  if (read === undefined) return {gaps: [MEMORY_GAP]};
  if (read.status !== 'ok') return {gaps: read.gaps};
  return {
    gaps: [],
    selected: selectNavigationMemory({
      answer,
      observation: evidence.observation,
      task: request.task,
      observedAt: read.observedAt,
      memory: read.memory,
      ...(read.memoryProjects === undefined ? {} : {memoryProjects: read.memoryProjects}),
      repositoryIdentityKind: evidence.repositoryIdentityKind,
    }),
  };
}

function finish(
  request: ContextBriefNavigationRequestV1,
  parts: {
    readonly gaps: readonly string[];
    readonly navigation?: NavigationProjection;
    readonly followUp?: NavigationEffectsDelta;
    readonly continuation?: string | undefined;
  },
  navigationText?: string,
): ProjectedContextBriefNavigationV1 {
  const followUp = parts.followUp === undefined ? undefined : renderFollowUp(parts.followUp);
  const value: ContextBriefNavigationV1 = {
    type: CONTEXT_BRIEF_NAVIGATION_TYPE,
    version: 1,
    outcome:
      followUp !== undefined ? 'follow-up' : parts.navigation === undefined ? 'unavailable' : parts.navigation.outcome,
    gaps: [...new Set(parts.gaps)].sort(),
    ...(parts.navigation === undefined ? {} : {navigation: parts.navigation}),
    ...(followUp === undefined ? {} : {followUp}),
    ...(parts.continuation === undefined ? {} : {continuation: parts.continuation}),
  };
  return {
    maximumBytes: request.budgetTokens * AGENT_RESPONSE_ESTIMATED_BYTES_PER_TOKEN,
    ...renderProjectionChannels(value, request.responseFormat, item =>
      request.responseFormat === 'agent' ? JSON.stringify(item) : renderText(item, navigationText),
    ),
  };
}

function renderFollowUp(delta: NavigationEffectsDelta): NonNullable<ContextBriefNavigationV1['followUp']> {
  const paths = new Map(EffectArray.map(delta.sources, source => [source.id, source.path] as const));
  return {
    status: delta.status,
    reason: delta.reason,
    effects: EffectArray.map(delta.effects, node => {
      const head = [node.id, paths.get(node.sourceId) ?? '', node.startLine, node.endLine, node.support] as const;
      const effect = node.possibleEffect;
      if (effect === undefined) return head;
      return [
        ...head,
        effect.condition === undefined
          ? ([effect.kind, effect.target] as const)
          : ([effect.kind, effect.target, effect.condition] as const),
      ] as const;
    }),
  };
}

/** Dual text: the projection's own text, then the lane lines it does not carry. */
function renderText(value: ContextBriefNavigationV1, navigationText: string | undefined): string {
  const lines = [`NAVIGATE/1 ${value.outcome}`];
  if (value.gaps.length > 0) lines.push(`gaps: ${EffectArray.join(value.gaps, ', ')}`);
  if (navigationText !== undefined) lines.push(navigationText);
  if (value.followUp !== undefined) lines.push(`follow-up: ${value.followUp.status} (${value.followUp.reason})`);
  if (value.continuation !== undefined) lines.push(`continuation: ${value.continuation}`);
  return EffectArray.join(lines, '\n');
}
