import {Array as EffectArray} from 'effect';
import {Effect, Predicate} from 'effect';
import {CodeGraphQueryService} from '@threadnote/graph/query';
import {sha256Hex} from '@threadnote/platform/digest';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import type {
  MemoryCodeCitationCaptureRecoveryV1,
  MemoryCodeCitationProjectScopeExpectationV1,
} from '@threadnote/context/citation/capture';
import {
  memoryCodeCitationProjectScopeMatches,
  MemoryCodeCitationCaptureError,
} from '@threadnote/context/citation/capture';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

export type DeferredCodeAnchorProjectScopeExpectationV1 = MemoryCodeCitationProjectScopeExpectationV1;

export function isDeferredCodeAnchorFullProjectScope(
  value: DeferredCodeAnchorProjectScopeExpectationV1,
): value is {readonly kind: 'full'} {
  return 'kind' in value && value.kind === 'full';
}

export interface DeferredCodeAnchorIntentV1 {
  readonly authorization: 'explicit-code-refs';
  readonly callerCwd: string;
  readonly codeRefs: readonly string[];
  readonly createdAt: string;
  readonly expectedMemoryHash: string;
  readonly intentId: string;
  readonly memoryId: string;
  readonly memoryUri: string;
  readonly project?: string;
  readonly projectScope?: DeferredCodeAnchorProjectScopeExpectationV1;
  readonly repositoryId: string;
  readonly recovery: MemoryCodeCitationCaptureRecoveryV1;
  readonly type: 'threadnote-deferred-code-anchor-intent';
  readonly version: 1;
  readonly visibility: 'private-local';
  readonly worktreeId: string;
}

export const verifyDeferredCodeAnchorProjectScope = Effect.fn('memoryCodeAnchor.verifyProjectScope')(function* (
  config: RuntimeConfig,
  intent: DeferredCodeAnchorIntentV1,
) {
  if (intent.projectScope === undefined) return;
  const query = yield* CodeGraphQueryService;
  const status = yield* query.status(config.agentContextHome, intent.callerCwd, {
    project: intent.project,
    manifestPath: config.manifestPath,
    observeWorktree: true,
    requestMaintenance: false,
  });
  if (!memoryCodeCitationProjectScopeMatches(status, intent.projectScope)) {
    return yield* MemoryCodeCitationCaptureError.of(
      'The selected project graph changed since deferred code citation capture; replace the memory with current code references.',
    );
  }
});

export function deferredCodeAnchorIntentId(input: {
  readonly callerCwd: string;
  readonly codeRefs: readonly string[];
  readonly expectedMemoryHash: string;
  readonly memoryId: string;
  readonly memoryUri: string;
  readonly project?: string;
  readonly projectScope?: DeferredCodeAnchorProjectScopeExpectationV1;
  readonly repositoryId: string;
  readonly recovery: MemoryCodeCitationCaptureRecoveryV1;
  readonly worktreeId: string;
}) {
  const fields = [
    input.memoryUri,
    input.memoryId,
    input.expectedMemoryHash,
    input.repositoryId,
    input.worktreeId,
    input.callerCwd,
    input.recovery.code,
    input.recovery.observedGraph.freshness,
    input.recovery.observedGraph.readySnapshot,
    String(input.recovery.observedGraph.stale),
    ...(input.recovery.recovery === 'prepare-current-graph'
      ? [
          input.recovery.preparation.action,
          input.recovery.preparation.target,
          input.recovery.preparation.command,
          ...input.recovery.preparation.arguments,
        ]
      : [input.recovery.recovery, input.recovery.retryCondition]),
    ...input.codeRefs,
  ];
  if (input.project !== undefined) fields.push('project', input.project);
  if (input.projectScope !== undefined) {
    fields.push('projectScope');
    if (isDeferredCodeAnchorFullProjectScope(input.projectScope)) {
      fields.push('full');
    } else {
      fields.push(
        input.projectScope.project,
        input.projectScope.scopeKey,
        input.projectScope.definitionDigest,
        input.projectScope.closureDigest,
      );
    }
  }
  return sha256Hex(EffectArray.join(fields, '\n')).pipe(
    Effect.map(digest => `tnca_${Effect2.pipe(digest, EffectString.slice(0, 32))}`),
  );
}

export function hasDeferredCodeAnchorIntentKeys(value: Record<string, unknown>, required: readonly string[]): boolean {
  const allowed = new Set([...required, 'project', 'projectScope']);
  return (
    EffectArray.every(required, key => key in value) &&
    EffectArray.every(EffectRecord.keys(value), key => allowed.has(key))
  );
}

export function parseMemoryCodeCitationProjectScopeReceipt(
  value: unknown,
): DeferredCodeAnchorProjectScopeExpectationV1 | undefined {
  if (Predicate.isObject(value) && hasExactKeys(value, ['kind']) && value.kind === 'full') return {kind: 'full'};
  if (!Predicate.isObject(value) || !hasExactKeys(value, ['closureDigest', 'definitionDigest', 'project', 'scopeKey']))
    return undefined;
  return typeof value.project === 'string' &&
    value.project.length > 0 &&
    typeof value.scopeKey === 'string' &&
    value.scopeKey.length > 0 &&
    typeof value.definitionDigest === 'string' &&
    /^[a-f0-9]{64}$/u.test(value.definitionDigest) &&
    typeof value.closureDigest === 'string' &&
    /^[a-f0-9]{64}$/u.test(value.closureDigest)
    ? {
        closureDigest: value.closureDigest,
        definitionDigest: value.definitionDigest,
        project: value.project,
        scopeKey: value.scopeKey,
      }
    : undefined;
}

export function isMemoryCodeCitationRecovery(value: unknown): value is MemoryCodeCitationCaptureRecoveryV1 {
  if (!Predicate.isObject(value) || value.type !== 'memory-code-citation-capture-recovery' || value.version !== 1)
    return false;
  if (value.recovery === 'retry-capture') {
    return (
      hasExactKeys(value, [
        'code',
        'indexingStarted',
        'observedGraph',
        'recovery',
        'retryCondition',
        'retryable',
        'type',
        'version',
      ]) &&
      value.code === 'graph-writer-busy' &&
      value.indexingStarted === false &&
      value.retryCondition === 'after-writer-available' &&
      value.retryable === true &&
      Predicate.isObject(value.observedGraph) &&
      hasExactKeys(value.observedGraph, ['freshness', 'readySnapshot', 'stale']) &&
      value.observedGraph.freshness === 'current' &&
      value.observedGraph.readySnapshot === 'available' &&
      value.observedGraph.stale === false
    );
  }
  if (
    !hasExactKeys(value, [
      'code',
      'indexingStarted',
      'observedGraph',
      'preparation',
      'recovery',
      'retryCondition',
      'retryable',
      'type',
      'version',
    ]) ||
    (value.code !== 'exact-current-evidence-unavailable' && value.code !== 'ready-graph-unavailable') ||
    value.indexingStarted !== false ||
    value.recovery !== 'prepare-current-graph' ||
    value.retryCondition !== 'after-current-graph-ready' ||
    value.retryable !== true ||
    !Predicate.isObject(value.observedGraph) ||
    !Predicate.isObject(value.preparation)
  ) {
    return false;
  }
  if (
    !hasExactKeys(value.observedGraph, ['freshness', 'readySnapshot', 'stale']) ||
    !['current', 'deferred', 'stale'].includes(String(value.observedGraph.freshness)) ||
    !['absent', 'available'].includes(String(value.observedGraph.readySnapshot)) ||
    typeof value.observedGraph.stale !== 'boolean'
  ) {
    return false;
  }
  if (value.preparation.target === 'callerCwd') {
    return (
      hasExactKeys(value.preparation, ['action', 'arguments', 'command', 'target']) &&
      value.preparation.action === 'index-current-graph' &&
      value.preparation.command === 'threadnote graph index --no-vectors' &&
      EffectArray.isArray(value.preparation.arguments) &&
      value.preparation.arguments.length === 0
    );
  }
  return (
    value.preparation.target === 'workset' &&
    hasExactKeys(value.preparation, ['action', 'arguments', 'command', 'target']) &&
    value.preparation.action === 'prepare-workset' &&
    value.preparation.command === 'threadnote workset prepare' &&
    EffectArray.isArray(value.preparation.arguments) &&
    value.preparation.arguments.length === 1 &&
    typeof value.preparation.arguments[0] === 'string' &&
    value.preparation.arguments[0].length > 0
  );
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = EffectRecord.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && EffectArray.every(actual, (key, index) => key === expected[index]);
}
