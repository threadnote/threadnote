import type {CallToolResult} from '@modelcontextprotocol/sdk/types.js';
import {Array as EffectArray, pipe as EffectArrayPipe, Predicate} from 'effect';
import {memoryIdFromIdentityAlias} from '@threadnote/memory/identity-alias';
import type {MemoryReadResource} from '@threadnote/memory/read/projection';

export function memoryReadResourcesFromNativeResult(
  result: CallToolResult,
  uris: readonly string[],
): MemoryReadResource[] | undefined {
  const canonicalRead = canonicalReadMetadata(result);
  const mappings = canonicalRead?.resources;
  if (mappings) {
    return projectCanonicalReadResources(result, mappings);
  }
  if (result.content.length !== uris.length) return undefined;
  return projectCanonicalReadResources(
    result,
    EffectArray.map(uris, (uri, index) => ({canonicalUri: uri, contentIndex: index, requestedUri: uri})),
  );
}

function projectCanonicalReadResources(
  result: CallToolResult,
  mappings: readonly {readonly canonicalUri: string; readonly contentIndex: number; readonly requestedUri: string}[],
): MemoryReadResource[] | undefined {
  const resources: MemoryReadResource[] = [];
  for (const mapping of mappings) {
    const content = result.content[mapping.contentIndex];
    if (content?.type !== 'text') return undefined;
    const requestedUri = mapping.requestedUri;
    const canonicalUri = mapping.canonicalUri;
    if (memoryIdFromIdentityAlias(requestedUri) !== undefined) {
      resources.push({requestedUri, text: content.text, uri: requestedUri});
      continue;
    }
    resources.push({
      ...(requestedUri === canonicalUri ? {} : {canonicalUri, requestedUri}),
      text: content.text,
      uri: canonicalUri,
    });
  }
  return resources;
}

export function canonicalReadMissing(result: CallToolResult): readonly string[] {
  const value = result._meta?.['threadnote.io/canonical-read'];
  if (!Predicate.isObject(value) || !EffectArray.isArray(value.missing)) return [];
  return EffectArrayPipe(value.missing, __effectArrayValues =>
    EffectArray.filter(
      __effectArrayValues,
      (uri, __effectArrayIndex): uri is string => __effectArrayIndex in __effectArrayValues && typeof uri === 'string',
    ),
  );
}

export function canonicalReadMetadata(result: CallToolResult):
  | {
      readonly resources: readonly {
        readonly canonicalUri: string;
        readonly contentIndex: number;
        readonly requestedUri: string;
      }[];
    }
  | undefined {
  const value = result._meta?.['threadnote.io/canonical-read'];
  if (!Predicate.isObject(value)) return undefined;
  const candidate = value;
  if (
    candidate.type !== 'threadnote-canonical-read' ||
    candidate.version !== 1 ||
    !EffectArray.isArray(candidate.resources)
  ) {
    return undefined;
  }
  const resources: {
    canonicalUri: string;
    contentIndex: number;
    requestedUri: string;
  }[] = [];
  for (const resource of candidate.resources) {
    if (!Predicate.isObject(resource)) return undefined;
    const entry = resource;
    const requestedUri =
      typeof entry.requestedUri === 'string'
        ? entry.requestedUri
        : typeof entry.uri === 'string'
          ? entry.uri
          : undefined;
    const canonicalUri = typeof entry.canonicalUri === 'string' ? entry.canonicalUri : requestedUri;
    if (
      typeof entry.contentIndex !== 'number' ||
      !Number.isSafeInteger(entry.contentIndex) ||
      !requestedUri ||
      !canonicalUri
    ) {
      return undefined;
    }
    resources.push({canonicalUri, contentIndex: entry.contentIndex, requestedUri});
  }
  return {resources};
}
