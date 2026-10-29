import {Array as EffectArray} from 'effect';
import {Predicate} from 'effect';
import {canonicalResourceUri, parseResourceId, resourceIdWithoutAnchor} from '@threadnote/store/resource-id';
import {uriSegment} from '@threadnote/workspace/manifest';
import {MemoryOperationError} from './migrations.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

export function parseThreadnotePack(raw: string): {
  readonly resources: readonly {readonly content: string; readonly relativeUri: string}[];
  readonly sourceUri: string;
  readonly version: 1;
} {
  const value = JSON.parse(raw) as unknown;
  if (!Predicate.isObject(value)) throw MemoryOperationError.make({message: 'Pack root must be an object.'});
  const pack = value;
  if (pack.version !== 1 || typeof pack.sourceUri !== 'string' || !EffectArray.isArray(pack.resources)) {
    throw MemoryOperationError.make({message: 'Unsupported Threadnote pack version or shape.'});
  }
  const resources = EffectArray.map(pack.resources, resource => {
    if (
      !Predicate.isObject(resource) ||
      typeof resource.content !== 'string' ||
      typeof resource.relativeUri !== 'string'
    ) {
      throw MemoryOperationError.make({message: 'Pack resource entry is invalid.'});
    }
    const entry = {content: resource.content, relativeUri: resource.relativeUri};
    if (
      !entry.relativeUri ||
      Effect2.pipe(entry.relativeUri, EffectString.startsWith('/')) ||
      EffectArray.some(
        Effect2.pipe(entry.relativeUri, EffectString.split('/')),
        segment => !segment || segment === '.' || segment === '..',
      )
    ) {
      throw MemoryOperationError.make({message: `Unsafe pack relative URI: ${entry.relativeUri}.`});
    }
    return entry;
  });
  return {resources, sourceUri: pack.sourceUri, version: 1};
}

export function canonicalPackRoot(input: string): string {
  const id = parseResourceId(input);
  if (id.anchor) throw MemoryOperationError.make({message: `Pack resource roots cannot contain anchors: ${input}.`});
  return resourceIdWithoutAnchor(id).canonicalUri;
}

export function packTargetForCurrentUser(sourceUri: string, user: string): string {
  const source = resourceIdWithoutAnchor(parseResourceId(sourceUri));
  if (source.namespace === 'resources') {
    return source.canonicalUri;
  }
  if (source.namespace === 'user' && source.segments.length > 0) {
    return canonicalResourceUri('user', [uriSegment(user), ...source.segments.slice(1)]);
  }
  throw MemoryOperationError.make({message: `Unsupported Threadnote pack source URI: ${sourceUri}.`});
}
