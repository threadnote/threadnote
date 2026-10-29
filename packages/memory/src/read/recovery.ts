import * as MigrationSchema from 'effect/Schema';
import {Array as EffectArray} from 'effect';
import {parseResourceId} from '@threadnote/store/resource-id';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {parsePersonalMemoryUri} from '../hygiene.js';
import {MemoryPointerNotFound} from '../relocation.js';
import {Predicate} from 'effect';
import * as EffectRecord from 'effect/Record';

export interface MemoryReadRecoveryV1 {
  readonly code: 'memory-resource-not-found';
  readonly nextAction: Readonly<{
    readonly arguments: Readonly<{readonly query: string}>;
    readonly tool: 'recall_context';
  }>;
  readonly recoveryAction: 'recall-canonical-uri';
  readonly requestedUri: string;
  readonly retryable: false;
  readonly summary: string;
  readonly type: 'threadnote-memory-read-recovery';
  readonly version: 1;
}

export const MEMORY_READ_RECOVERY_SUMMARY =
  'The memory may have moved or been published before relocation receipts were available. Recall by its stable topic, then read the canonical URI returned.';

export function memoryReadRecoveryForError(
  config: Pick<RuntimeConfig, 'user'>,
  error: unknown,
): MemoryReadRecoveryV1 | undefined {
  if (!MigrationSchema.is(MemoryPointerNotFound)(error)) return undefined;
  const identity = parsePersonalMemoryUri(error.uri, config.user);
  if (identity === undefined) return undefined;
  return memoryReadRecoveryForRequestedUri(error.uri);
}

export function memoryReadRecoveryForRequestedUri(requestedUri: string): MemoryReadRecoveryV1 | undefined {
  try {
    const resource = parseResourceId(requestedUri);
    const user = resource.segments[0];
    if (
      resource.namespace !== 'user' ||
      resource.canonicalUri !== requestedUri ||
      resource.segments.length !== 6 ||
      user === undefined
    ) {
      return undefined;
    }
    const identity = parsePersonalMemoryUri(requestedUri, user);
    if (identity === undefined) return undefined;
    return {
      code: 'memory-resource-not-found',
      nextAction: {
        arguments: {query: identity.topic},
        tool: 'recall_context',
      },
      recoveryAction: 'recall-canonical-uri',
      requestedUri,
      retryable: false,
      summary: MEMORY_READ_RECOVERY_SUMMARY,
      type: 'threadnote-memory-read-recovery',
      version: 1,
    };
  } catch {
    return undefined;
  }
}

export function isMemoryReadRecoveryV1(value: unknown): value is MemoryReadRecoveryV1 {
  if (!Predicate.isObject(value)) return false;
  const recovery = value;
  if (
    !hasExactObjectKeys(recovery, [
      'code',
      'nextAction',
      'recoveryAction',
      'requestedUri',
      'retryable',
      'summary',
      'type',
      'version',
    ]) ||
    typeof recovery.requestedUri !== 'string'
  ) {
    return false;
  }
  const expected = memoryReadRecoveryForRequestedUri(recovery.requestedUri);
  if (expected === undefined) return false;
  if (!Predicate.isObject(recovery.nextAction)) {
    return false;
  }
  const nextAction = recovery.nextAction;
  if (!hasExactObjectKeys(nextAction, ['arguments', 'tool'])) return false;
  if (!Predicate.isObject(nextAction.arguments)) {
    return false;
  }
  const args = nextAction.arguments;
  return (
    hasExactObjectKeys(args, ['query']) &&
    recovery.code === expected.code &&
    nextAction.tool === expected.nextAction.tool &&
    args.query === expected.nextAction.arguments.query &&
    recovery.recoveryAction === expected.recoveryAction &&
    recovery.retryable === expected.retryable &&
    recovery.summary === expected.summary &&
    recovery.type === expected.type &&
    recovery.version === expected.version
  );
}

export function memoryReadRecoveryText(recovery: MemoryReadRecoveryV1): string {
  return JSON.stringify(recovery);
}

function hasExactObjectKeys(value: Readonly<Record<string, unknown>>, expected: readonly string[]): boolean {
  const actual = EffectRecord.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return (
    actual.length === sortedExpected.length && EffectArray.every(actual, (key, index) => key === sortedExpected[index])
  );
}
