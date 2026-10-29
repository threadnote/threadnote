import {Schema} from 'effect';
import {isMemoryRelationType, MAX_MEMORY_RELATIONS, type MemoryRelation} from '../document.js';
import {parseRemoteShareAddress} from './address.js';

export class InvalidRemoteMemoryRelations extends Schema.TaggedError<
  InvalidRemoteMemoryRelations,
  {readonly brand: unique symbol}
>()('InvalidRemoteMemoryRelations', {message: Schema.String}) {}

export function normalizeRemoteMemoryRelations(
  inputs: readonly Readonly<{readonly type: string; readonly uri: string}>[] | undefined,
): readonly MemoryRelation[] | undefined {
  if (inputs === undefined) return undefined;
  if (inputs.length > MAX_MEMORY_RELATIONS) {
    throw relationError(`A remote memory can declare at most ${MAX_MEMORY_RELATIONS} relations.`);
  }
  const normalized: MemoryRelation[] = [];
  const seen = new Set<string>();
  for (const input of inputs) {
    if (!isMemoryRelationType(input.type)) {
      throw relationError('Remote memory relation type is unsupported.');
    }
    let uri: string;
    try {
      const address = parseRemoteShareAddress(input.uri);
      if (address.canonicalUri !== input.uri) throw new Error('noncanonical');
      uri = address.canonicalUri;
    } catch {
      throw relationError('Relation targets must use canonical remote memory URIs.');
    }
    const key = `${input.type}\n${uri}`;
    if (seen.has(key)) throw relationError('Duplicate remote memory relations are not allowed.');
    seen.add(key);
    normalized.push({type: input.type, uri});
  }
  return normalized.sort(compareRelation);
}

function relationError(message: string): InvalidRemoteMemoryRelations {
  return InvalidRemoteMemoryRelations.make({message});
}

function compareRelation(left: MemoryRelation, right: MemoryRelation): number {
  const type = compareText(left.type, right.type);
  return type === 0 ? compareText(left.uri, right.uri) : type;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
