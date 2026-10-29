import {Array as EffectArray} from 'effect';
import {Effect, Predicate, Schema} from 'effect';
import {assertMemoryDocumentSchemaWritable, type MemoryRelation} from '@threadnote/memory/document';
import {isMemoryId} from '@threadnote/memory/identity-alias';
import {
  MemoryRelationWriteError,
  normalizeMemoryRelationInputs,
  resolveAuthoredMemoryRelations,
} from '../../memory/relations.js';
import {readMemoryRecordsByUri} from '../../memory/index.js';
import {writeDurableMemory} from '../../mcp/server/memory.js';
import {MemoryIdentityResolutionError} from '@threadnote/recall/memory/identity';
import {sharedTeamNameForUri} from '../../share/index.js';
import {parseResourceId, resourceIdIsWithin} from '@threadnote/store/resource-id';
import {readAnonymousTelemetryDiagnostic} from '../../telemetry/diagnostic.js';
import {uriSegment} from '@threadnote/workspace/manifest';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {MemoryPointerNotFound} from '@threadnote/memory/relocation';
import type {ManagerMemoryRelationsResponse} from '@threadnote/manager/memory/contracts';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';
import {Option as EffectOption} from 'effect';

export type {ManagerMemoryRelationsResponse} from '@threadnote/manager/memory/contracts';

export class ManagerMemoryRelationsError extends Schema.TaggedError<
  ManagerMemoryRelationsError,
  {readonly brand: unique symbol}
>()('ManagerMemoryRelationsError', {
  code: Schema.Literals([
    'memory-relations-conflict',
    'memory-relations-forbidden',
    'memory-relations-invalid',
    'memory-relations-not-found',
    'memory-relations-operation-failed',
    'memory-relations-verification-failed',
  ]),
  message: Schema.String,
  status: Schema.Literals([400, 403, 404, 409, 500]),
}) {}

interface ManagerMemoryRelationsInput {
  readonly expectedContent: string;
  readonly relations: readonly {readonly type: string; readonly uri: string}[];
  readonly uri: string;
}

/** Structured, CAS-protected relation replacement for Manager's memory editor. */
export const updateManagerMemoryRelations = Effect.fn('manager.updateMemoryRelations')(function* (
  config: RuntimeConfig,
  body: Record<string, unknown>,
) {
  const input = yield* Effect.try({
    catch: cause =>
      Schema.is(ManagerMemoryRelationsError)(cause)
        ? cause
        : relationError(cause instanceof Error ? cause.message : 'Invalid relation editor input.'),
    try: () => parseManagerMemoryRelationsInput(body),
  });
  const canonicalUri = yield* Effect.try({
    catch: cause => relationError(cause instanceof Error ? cause.message : 'Invalid source memory URI.'),
    try: () => parseResourceId(input.uri).canonicalUri,
  });
  const memoryRoot = `threadnote://user/${uriSegment(config.user)}/memories`;
  if (!resourceIdIsWithin(canonicalUri, memoryRoot)) {
    return yield* relationError(
      'Manager can only edit relations on the current user memory corpus.',
      403,
      'memory-relations-forbidden',
    );
  }
  const sharedTeam = sharedTeamNameForUri(config, canonicalUri);
  const allowedUriScopes = [sharedTeam ? `${memoryRoot}/shared/${uriSegment(sharedTeam)}` : memoryRoot];
  const [source] = yield* readMemoryRecordsByUri(config, [canonicalUri]).pipe(
    Effect.mapError(() => relationOperationError()),
  );
  if (!source)
    return yield* relationError('The memory no longer exists. Reload and retry.', 404, 'memory-relations-not-found');
  if (source.content !== input.expectedContent) {
    return yield* relationError(
      'The memory changed after it was opened. Reload and retry.',
      409,
      'memory-relations-conflict',
    );
  }
  yield* Effect.try({
    catch: cause =>
      relationError(
        cause instanceof Error ? cause.message : 'The memory schema is not writable.',
        409,
        'memory-relations-conflict',
      ),
    try: () => assertMemoryDocumentSchemaWritable(source.content),
  });
  const sourceMemoryId = source.metadata.memoryId;
  if (!isMemoryId(sourceMemoryId ?? '')) {
    return yield* relationError(
      'Structured relations require an identity-bearing memory.',
      409,
      'memory-relations-conflict',
    );
  }
  const checkedSourceMemoryId = sourceMemoryId!;
  const resolved = yield* resolveAuthoredMemoryRelations(config, input.relations, {
    allowedUriScopes,
    sourceMemoryId: checkedSourceMemoryId,
    sourceUri: canonicalUri,
  }).pipe(Effect.mapError(relationResolutionError));
  const writeResult = yield* writeDurableMemory(config, {
    bodyText: source.body,
    expectedReplaceContent: input.expectedContent,
    expectedSourceContent: resolved.targets,
    metadata: {...source.metadata, relations: resolved.relations},
    operation: 'replace',
    replaceUri: canonicalUri,
  });
  if (writeResult.isError) {
    const argumentFailure = readAnonymousTelemetryDiagnostic(writeResult)?.errorType === 'McpArgumentError';
    return yield* argumentFailure
      ? relationError(toolErrorMessage(writeResult.content), 409, 'memory-relations-conflict')
      : relationOperationError();
  }
  const [stored] = yield* readMemoryRecordsByUri(config, [canonicalUri]).pipe(
    Effect.mapError(() => relationOperationError()),
  );
  if (!stored || stored.metadata.memoryId !== checkedSourceMemoryId) {
    return yield* relationError(
      'The relation update could not be verified. Reload the memory.',
      500,
      'memory-relations-verification-failed',
    );
  }
  return {
    content: stored.content,
    memoryId: checkedSourceMemoryId,
    relations: stored.metadata.relations ?? [],
    uri: stored.uri,
  } satisfies ManagerMemoryRelationsResponse;
});

export function parseManagerMemoryRelationsInput(body: Record<string, unknown>): ManagerMemoryRelationsInput {
  const unsupported = EffectArray.filter(
    EffectRecord.keys(body),
    key => !new Set(['expectedContent', 'relations', 'uri']).has(key),
  );
  if (unsupported.length > 0) throw relationError(`Unsupported relation editor field: ${unsupported.sort()[0]}.`);
  if (typeof body.uri !== 'string' || !Effect2.pipe(body.uri, EffectString.trim))
    throw relationError('uri is required.');
  if (typeof body.expectedContent !== 'string' || !body.expectedContent) {
    throw relationError('expectedContent is required for relation updates.');
  }
  if (!EffectArray.isArray(body.relations)) throw relationError('relations must be an array.');
  const relations = EffectArray.map(body.relations, (value, index) => {
    if (!Predicate.isObject(value)) {
      throw relationError(`relations[${index}] must contain type and uri.`);
    }
    const relation = value;
    if (
      EffectArray.some(EffectRecord.keys(relation), key => key !== 'type' && key !== 'uri') ||
      typeof relation.type !== 'string' ||
      typeof relation.uri !== 'string'
    ) {
      throw relationError(`relations[${index}] must contain only text type and uri fields.`);
    }
    return {type: relation.type, uri: relation.uri};
  });
  let normalized: readonly {readonly type: MemoryRelation['type']; readonly uri: string}[];
  try {
    normalized = normalizeMemoryRelationInputs(relations);
  } catch (cause) {
    throw relationError(cause instanceof Error ? cause.message : 'Invalid memory relations.');
  }
  return {expectedContent: body.expectedContent, relations: normalized, uri: body.uri};
}

function relationError(
  message: string,
  status: ManagerMemoryRelationsError['status'] = 400,
  code: ManagerMemoryRelationsError['code'] = 'memory-relations-invalid',
): ManagerMemoryRelationsError {
  return ManagerMemoryRelationsError.make({code, message, status});
}

function relationOperationError(): ManagerMemoryRelationsError {
  return relationError(
    'Threadnote could not update the memory relations. Reload and retry.',
    500,
    'memory-relations-operation-failed',
  );
}

function relationResolutionError(cause: unknown): ManagerMemoryRelationsError {
  if (Schema.is(MemoryRelationWriteError)(cause) || Schema.is(MemoryPointerNotFound)(cause)) {
    return relationError(cause.message);
  }
  if (Schema.is(MemoryIdentityResolutionError)(cause)) {
    return cause.reason === 'ambiguous' || cause.reason === 'live-mismatch'
      ? relationError(cause.message, 409, 'memory-relations-conflict')
      : relationError(cause.message);
  }
  return relationOperationError();
}

function toolErrorMessage(content: readonly unknown[]): string {
  const text = EffectOption.getOrUndefined(
    EffectArray.findFirst(
      content,
      __effectArrayValue => !!(item => Predicate.isObject(item) && typeof item.text === 'string')(__effectArrayValue),
    ),
  );
  return Predicate.isObject(text) && typeof text.text === 'string'
    ? text.text
    : 'Threadnote could not update the memory relations.';
}
