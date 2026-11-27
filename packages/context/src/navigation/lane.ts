import {Array as EffectArray, DateTime, Effect, Schema} from 'effect';
import {AGENT_RESPONSE_ESTIMATED_BYTES_PER_TOKEN, measureAgentToolResponse} from '@threadnote/protocol/agent-response';
import {
  makeReadDeadline,
  ReadDeadlineExceeded,
  readDeadlineRemaining,
  withinReadDeadline,
  type ReadDeadline,
} from '@threadnote/platform/read_deadline';
import {CONTEXT_BRIEF_READ_MILLISECONDS} from '../compiler.js';
import {planContextBrief} from '../planner.js';
import {unavailableContextBriefMemoryEvidence} from '../memory-evidence.js';
import type {ContextBriefMemoryRetrievalV1, ContextBriefPlanV1} from '../types.js';
import {assembleNavigationAnswer} from './assemble.js';
import {
  decodeNavigationContinuation,
  encodeNavigationContinuation,
  invalidatedNavigationEffects,
  navigationEffectsDelta,
  type NavigationEffectsDelta,
} from './continuation.js';
import {navigationScopeKey, type NavigationAnswerV1, type NavigationInput} from './model.js';
import {projectStructuralNavigationAnswer, type NavigationProjection} from './project.js';
import type {NavigationReadEvidenceV1, NavigationReadRequestV1, NavigationReadResultV1} from './read.js';
import {parseContextBriefNavigationRequestV1, type ContextBriefNavigationRequestV1} from './request.js';
import type {NavigationSemanticDependency} from './semantic.js';

export const CONTEXT_BRIEF_NAVIGATION_TYPE = 'context-brief-navigation' as const;
/** Semantic enrichment ends this long after the request starts, or at the parent deadline when that is earlier. */
export const NAVIGATION_SEMANTIC_MILLISECONDS = 1500;
/** No semantic request starts with less time than one coordinator request needs. */
export const NAVIGATION_SEMANTIC_MINIMUM_MILLISECONDS = 500;

export interface NavigationLaneDependencies<NavigationR = never, MemoryR = never, SemanticR = never> {
  readonly navigationEvidence: (
    request: NavigationReadRequestV1,
    deadline: ReadDeadline,
  ) => Effect.Effect<NavigationReadResultV1, unknown, NavigationR>;
  readonly memoryEvidence: (
    plan: ContextBriefPlanV1['memory'],
    deadline?: ReadDeadline,
  ) => Effect.Effect<ContextBriefMemoryRetrievalV1, unknown, MemoryR>;
  /** Optional; absent means a structural-only answer. Implemented by the application. */
  readonly navigationSemantic?: NavigationSemanticDependency<SemanticR>;
}

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
  MemoryR = never,
  SemanticR = never,
>(dependencies: NavigationLaneDependencies<NavigationR, MemoryR, SemanticR>, input: unknown) {
  const request = parseContextBriefNavigationRequestV1(input);
  const readDeadline = yield* makeReadDeadline(CONTEXT_BRIEF_READ_MILLISECONDS);
  const startedNanos = readDeadline.expiresAtNanos - BigInt(CONTEXT_BRIEF_READ_MILLISECONDS) * 1_000_000n;
  const semanticDeadline: ReadDeadline = Object.freeze({
    expiresAtNanos: minimum(
      startedNanos + BigInt(NAVIGATION_SEMANTIC_MILLISECONDS) * 1_000_000n,
      readDeadline.expiresAtNanos,
    ),
  });
  if (request.scope.kind !== 'repository') return finish(request, {gaps: ['navigation-workset-unsupported']});
  const continuation =
    request.continuation === undefined ? undefined : decodeNavigationContinuation(request.continuation.token);
  if (request.continuation !== undefined && continuation === undefined)
    return finish(request, {
      gaps: [],
      followUp: invalidatedNavigationEffects('navigation-continuation-invalid'),
    });
  const readRequest: NavigationReadRequestV1 = {
    scope: request.scope,
    task: request.task,
    codeRefs: request.codeRefs,
    maximumEstimatedTokens: request.budgetTokens,
    ...(continuation === undefined ? {} : {followUp: continuation.locators}),
  };
  const plan = planContextBrief({
    mode: 'brief',
    task: request.task,
    scope: request.scope,
    budgetTokens: request.budgetTokens,
    ...(request.codeRefs.length === 0 ? {} : {codeRefs: request.codeRefs}),
  });
  const read = withinReadDeadline(
    readDeadline,
    Effect.suspend(() => dependencies.navigationEvidence(readRequest, readDeadline)),
  ).pipe(
    Effect.catchIf(Schema.is(ReadDeadlineExceeded), () =>
      Effect.succeed<NavigationReadResultV1>({status: 'unavailable', gaps: ['navigation-read-deadline-exhausted']}),
    ),
  );
  // A follow-up re-reads only the previous effect nodes; memory is not reloaded.
  const memory =
    continuation === undefined
      ? withinReadDeadline(
          readDeadline,
          Effect.suspend(() => dependencies.memoryEvidence(plan.memory, readDeadline)),
        ).pipe(
          Effect.catchIf(Schema.is(ReadDeadlineExceeded), () =>
            Effect.succeed({...unavailableContextBriefMemoryEvidence(), gaps: ['memory-recall-budget-exhausted']}),
          ),
        )
      : Effect.void;
  const [evidence, memoryEvidence] = yield* Effect.all([read, memory], {concurrency: 2});
  if (evidence.status !== 'ok')
    return finish(request, {
      gaps: evidence.gaps,
      ...(continuation === undefined
        ? {}
        : {followUp: invalidatedNavigationEffects(evidence.gaps[0] ?? 'navigation-follow-up-unresolved')}),
    });
  const enriched = yield* enrich(dependencies.navigationSemantic, request, evidence, semanticDeadline);
  const answer = assembleNavigationAnswer(enriched);
  if (continuation !== undefined)
    return finish(request, {gaps: [], followUp: navigationEffectsDelta(continuation.summary, answer)});
  const projected = projectStructuralNavigationAnswer(
    {
      structural: {answer, proofLocators: evidence.proofLocators},
      graph: evidence.graph,
      plan,
      observedAt: DateTime.formatIso(yield* DateTime.now),
      ...(memoryEvidence === undefined ? {} : {memory: memoryEvidence}),
      repositoryIdentityKind: evidence.repositoryIdentityKind,
    },
    request.budgetTokens,
    request.responseFormat,
  );
  return finish(request, {
    gaps: [],
    navigation: projected.structuredContent,
    continuation: encodeNavigationContinuation(answer),
  });
});

/** Optional semantic step. It never removes structural evidence and never changes the requested scope. */
const enrich = Effect.fn('contextBrief.navigation.enrich')(function* <R>(
  dependency: NavigationSemanticDependency<R> | undefined,
  request: ContextBriefNavigationRequestV1,
  evidence: NavigationReadEvidenceV1,
  deadline: ReadDeadline,
) {
  if (dependency === undefined || evidence.anchors.length === 0 || request.scope.kind !== 'repository')
    return evidence.input;
  if ((yield* readDeadlineRemaining(deadline)) < NAVIGATION_SEMANTIC_MINIMUM_MILLISECONDS)
    return withGap(evidence.input, 'semantic-enrichment-budget-exhausted');
  const result = yield* withinReadDeadline(
    deadline,
    Effect.suspend(() =>
      dependency({
        callerCwd: request.scope.kind === 'repository' ? request.scope.callerCwd : '',
        scope: evidence.input.scope,
        identity: evidence.identity,
        observation: evidence.observation,
        input: evidence.input,
        anchors: evidence.anchors,
        deadline,
      }),
    ),
  ).pipe(Effect.catchIf(Schema.is(ReadDeadlineExceeded), () => Effect.void));
  if (result === undefined) return withGap(evidence.input, 'semantic-enrichment-budget-exhausted');
  if (navigationScopeKey(result.scope) !== navigationScopeKey(evidence.input.scope))
    return withGap(evidence.input, 'semantic-scope-changed');
  return result;
});

function withGap(input: NavigationInput, gap: string): NavigationInput {
  return {...input, gaps: [...new Set([...(input.gaps ?? []), gap])]};
}

function minimum(left: bigint, right: bigint): bigint {
  return left < right ? left : right;
}

function finish(
  request: ContextBriefNavigationRequestV1,
  parts: {
    readonly gaps: readonly string[];
    readonly navigation?: NavigationProjection;
    readonly followUp?: NavigationEffectsDelta;
    readonly continuation?: string | undefined;
  },
): ProjectedContextBriefNavigationV1 {
  const maximumBytes = request.budgetTokens * AGENT_RESPONSE_ESTIMATED_BYTES_PER_TOKEN;
  const followUp = parts.followUp === undefined ? undefined : renderFollowUp(parts.followUp);
  const base: ContextBriefNavigationV1 = {
    type: CONTEXT_BRIEF_NAVIGATION_TYPE,
    version: 1,
    outcome:
      followUp !== undefined ? 'follow-up' : parts.navigation === undefined ? 'unavailable' : parts.navigation.outcome,
    gaps: [...new Set(parts.gaps)].sort(),
    ...(parts.navigation === undefined ? {} : {navigation: parts.navigation}),
    ...(followUp === undefined ? {} : {followUp}),
  };
  const withToken: ContextBriefNavigationV1 =
    parts.continuation === undefined ? base : {...base, continuation: parts.continuation};
  const rendered = render(withToken, request.responseFormat);
  // The continuation is optional; it never pushes the answer over its budget.
  if (parts.continuation === undefined || rendered.measurement.totalBytes <= maximumBytes)
    return {maximumBytes, ...rendered};
  return {
    maximumBytes,
    ...render({...base, gaps: [...base.gaps, 'navigation-continuation-omitted'].sort()}, request.responseFormat),
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

function render(value: ContextBriefNavigationV1, format: 'agent' | 'dual') {
  const text = format === 'agent' ? JSON.stringify(value) : renderText(value);
  return {
    measurement: measureAgentToolResponse(format === 'agent' ? {text} : {structuredContent: value, text}),
    structuredContent: value,
    text,
  };
}

function renderText(value: ContextBriefNavigationV1): string {
  const lines = [`NAVIGATE/1 ${value.outcome}`];
  if (value.gaps.length > 0) lines.push(`gaps: ${EffectArray.join(value.gaps, ', ')}`);
  if (value.navigation !== undefined)
    for (const [role, status, nodes] of value.navigation.roles)
      lines.push(
        `${role}: ${status} ${EffectArray.join(
          EffectArray.map(nodes, index => `n${index}`),
          ',',
        )}`,
      );
  if (value.followUp !== undefined) lines.push(`follow-up: ${value.followUp.status} (${value.followUp.reason})`);
  if (value.continuation !== undefined) lines.push(`continuation: ${value.continuation}`);
  return EffectArray.join(lines, '\n');
}
