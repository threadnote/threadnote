import {Array as EffectArray} from 'effect';
import {uriSegment} from '@threadnote/workspace/manifest';
import {parseMemoryDocument} from '@threadnote/memory/document';
import {memoryIdFromIdentityAlias} from '@threadnote/memory/identity-alias';
import {classifyMemoryIdentityCandidates} from '@threadnote/recall/memory/identity';
import {loadRecallMemoryIdentities} from '@threadnote/recall/index';
import {parseResourceId} from '@threadnote/store/resource-id';
import type {ShareRuntime} from '../types.js';
import {Effect} from 'effect';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

/** Publication accepts only active personal durable memories, regardless of entry point. */
export function sharePublishEligibilityError(
  config: ShareRuntime,
  sourceUri: string,
  content: string,
): string | undefined {
  const prefix = `threadnote://user/${uriSegment(config.user)}/memories/durable/projects/`;
  const resource = parseResourceId(sourceUri);
  const record = parseMemoryDocument(sourceUri, content);
  if (record?.metadata.topicMaintenance !== undefined || record?.metadata.topicMaintenanceError !== undefined)
    return `Refusing to publish ${sourceUri}: enrolled topics require the reviewed existing-target Git proposal path; generic publication cannot project their provenance.`;
  if (
    resource.anchor === undefined &&
    Effect2.pipe(resource.canonicalUri, EffectString.startsWith(prefix)) &&
    Effect2.pipe(resource.canonicalUri, EffectString.slice(prefix.length), EffectString.endsWith('.md')) &&
    record?.headerTitle === 'MEMORY' &&
    record.metadata.kind === 'durable' &&
    record.metadata.status === 'active'
  ) {
    return undefined;
  }
  return `Refusing to publish ${sourceUri}: only active personal durable memories under durable/projects can be shared.`;
}

/** A stable alias is portable only when its target is active in the destination team. */
export const sharePublishRelationWarnings = Effect.fn('share.relationWarnings')(function* (
  config: ShareRuntime,
  sourceUri: string,
  publishedContent: string,
  team: string,
) {
  const relations = parseMemoryDocument(sourceUri, publishedContent)?.metadata.relations ?? [];
  const memoryIds = [
    ...new Set(
      EffectArray.flatMap(relations, (relation, __effectArrayIndex) => {
        if (!(__effectArrayIndex in relations)) return [];
        const memoryId = memoryIdFromIdentityAlias(relation.uri);
        return memoryId === undefined ? [] : [memoryId];
      }),
    ),
  ];
  if (memoryIds.length === 0) return [];
  const scope = `threadnote://user/${uriSegment(config.user)}/memories/shared/${uriSegment(team)}/durable/projects`;
  const candidates = yield* loadRecallMemoryIdentities(config, {
    allowedUriScopes: [scope],
    memoryIds,
    validateNow: true,
  }).pipe(Effect.orElseSucceed(() => undefined));
  if (candidates === undefined) {
    return ['PREVIEW WARNING: relation target availability in the destination team could not be verified.'];
  }
  return EffectArray.flatMap(memoryIds, memoryId => {
    const resolution = classifyMemoryIdentityCandidates(candidates, memoryId, [scope]);
    return resolution.state === 'resolved'
      ? []
      : [`PREVIEW WARNING: relation threadnote://memory/${memoryId} is ${resolution.state} in team ${team}.`];
  });
});
