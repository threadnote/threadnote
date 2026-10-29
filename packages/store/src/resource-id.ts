import {Array as EffectArray} from 'effect';
import {Schema} from 'effect';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

export const RESOURCE_ID_SCHEMES = ['threadnote', 'viking'] as const;
export type ResourceIdScheme = (typeof RESOURCE_ID_SCHEMES)[number];

export interface ResourceId {
  readonly anchor?: string;
  readonly canonicalUri: string;
  readonly inputScheme: ResourceIdScheme;
  readonly namespace: string;
  readonly segments: readonly string[];
}

export class InvalidResourceId extends Schema.TaggedError<InvalidResourceId, {readonly brand: unique symbol}>()(
  'InvalidResourceId',
  {
    input: Schema.String,
    message: Schema.String,
    reason: Schema.String,
  },
) {}

const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
const PORTABLE_UNSAFE_CHARACTERS = /[<>:"|?*\\/]/;

export function parseResourceId(input: string): ResourceId {
  const trimmed = Effect.pipe(input, EffectString.trim);
  const parsed = splitResourceId(trimmed);
  if (!parsed) return invalid(input, 'expected threadnote:// URI syntax (legacy viking:// aliases are accepted)');
  const inputScheme = resourceIdScheme(Effect.pipe(parsed.scheme, EffectString.toLowerCase));
  const namespace = decodeSegment(parsed.namespace, input, 'namespace');
  const rawPath = parsed.path;
  if (parsed.hasQuery) return invalid(input, 'query parameters are not supported');
  if (rawPath && !Effect.pipe(rawPath, EffectString.startsWith('/')))
    return invalid(input, 'resource path must start with /');
  if (Effect.pipe(rawPath, EffectString.includes('//'))) return invalid(input, 'empty path segments are not allowed');
  const rawSegments = Effect.pipe(rawPath, EffectString.split('/')).slice(1);
  if (rawSegments.at(-1) === '') rawSegments.pop();
  const segments = EffectArray.map(rawSegments, (segment, index) =>
    decodeSegment(segment, input, `path segment ${index + 1}`),
  );
  const anchor = parsed.anchor ? decodeAnchor(parsed.anchor, input) : undefined;
  return {
    ...(anchor ? {anchor} : {}),
    canonicalUri: canonicalResourceUri(namespace, segments, anchor),
    inputScheme,
    namespace,
    segments,
  };
}

function splitResourceId(value: string):
  | {
      readonly anchor?: string;
      readonly hasQuery: boolean;
      readonly namespace: string;
      readonly path: string;
      readonly scheme: string;
    }
  | undefined {
  const schemeEnd = Effect.pipe(
    value,
    EffectString.indexOf('://'),
    Effect.Option.getOrElse(() => -1),
  );
  if (schemeEnd <= 0) return undefined;
  const scheme = Effect.pipe(value, EffectString.slice(0, schemeEnd));
  if (
    Effect.pipe(scheme, EffectString.toLowerCase) !== 'threadnote' &&
    Effect.pipe(scheme, EffectString.toLowerCase) !== 'viking'
  )
    return undefined;
  const remainderStart = schemeEnd + 3;
  // oxlint-disable-next-line effecttsgo/prefer-effect-string -- The native search position argument changes the search origin; Effect String has no position parameter.
  const fragment = value.indexOf('#', remainderStart);
  // oxlint-disable-next-line effecttsgo/prefer-effect-string -- The native search position argument changes the search origin; Effect String has no position parameter.
  const query = value.indexOf('?', remainderStart);
  const queryBeforeFragment = query >= 0 && (fragment < 0 || query < fragment);
  const pathEnd = queryBeforeFragment ? query : fragment >= 0 ? fragment : value.length;
  // oxlint-disable-next-line effecttsgo/prefer-effect-string -- The native search position argument changes the search origin; Effect String has no position parameter.
  const slash = value.indexOf('/', remainderStart);
  const namespaceEnd = slash >= 0 && slash < pathEnd ? slash : pathEnd;
  if (namespaceEnd === remainderStart) return undefined;
  const path = namespaceEnd < pathEnd ? Effect.pipe(value, EffectString.slice(namespaceEnd, pathEnd)) : '';
  return {
    ...(fragment >= 0 ? {anchor: Effect.pipe(value, EffectString.slice(fragment + 1))} : {}),
    hasQuery: queryBeforeFragment,
    namespace: Effect.pipe(value, EffectString.slice(remainderStart, namespaceEnd)),
    path,
    scheme,
  };
}

function resourceIdScheme(value: string): ResourceIdScheme {
  if (value === 'threadnote' || value === 'viking') return value;
  return invalid(value, 'unsupported URI scheme');
}

export function canonicalResourceUri(namespace: string, segments: readonly string[], anchor?: string): string {
  validatePortableSegment(namespace, namespace);
  for (const segment of segments) validatePortableSegment(segment, segment);
  const path = segments.length > 0 ? `/${EffectArray.join(EffectArray.map(segments, encodeURIComponent), '/')}` : '';
  const fragment = anchor ? `#${encodeURIComponent(validateAnchor(anchor, anchor))}` : '';
  return `threadnote://${encodeURIComponent(namespace)}${path}${fragment}`;
}

export function resourceIdWithoutAnchor(resourceId: ResourceId): ResourceId {
  if (!resourceId.anchor) return resourceId;
  return {
    canonicalUri: canonicalResourceUri(resourceId.namespace, resourceId.segments),
    inputScheme: resourceId.inputScheme,
    namespace: resourceId.namespace,
    segments: resourceId.segments,
  };
}

export function resourceIdIsWithin(candidateUri: string, rootUri: string): boolean {
  const candidate = resourceIdWithoutAnchor(parseResourceId(candidateUri));
  const root = resourceIdWithoutAnchor(parseResourceId(rootUri));
  return (
    candidate.namespace === root.namespace &&
    EffectArray.every(root.segments, (segment, index) => candidate.segments[index] === segment)
  );
}

/** Reuse only pure URI parsing within one evaluator; callers still compare every current scope. */
export function makeResourceIdScopeChecker() {
  const parsed = new Map<string, ResourceId>();
  const maximumEntries = 4096;
  const maximumCharacters = 1024 * 1024;
  let retainedCharacters = 0;
  const parse = (input: string): ResourceId => {
    const cached = parsed.get(input);
    if (cached !== undefined) return cached;
    const result = parseResourceId(input);
    Object.freeze(result.segments);
    Object.freeze(result);
    const characters =
      input.length +
      result.canonicalUri.length +
      result.namespace.length +
      EffectArray.reduce(result.segments, 0, (total, segment) => total + segment.length) +
      (result.anchor?.length ?? 0);
    if (parsed.size < maximumEntries && characters <= maximumCharacters - retainedCharacters) {
      parsed.set(input, result);
      retainedCharacters += characters;
    }
    return result;
  };
  const isWithin = (candidateUri: string, rootUri: string): boolean => {
    const candidate = resourceIdWithoutAnchor(parse(candidateUri));
    const root = resourceIdWithoutAnchor(parse(rootUri));
    return (
      candidate.namespace === root.namespace &&
      EffectArray.every(root.segments, (segment, index) => candidate.segments[index] === segment)
    );
  };
  return {parse, isWithin};
}

export function resourceIdIsManagedMemoryNamespace(uri: string): boolean {
  const resource = parseResourceId(uri);
  return (
    (resource.namespace === 'user' || resource.namespace === 'agent' || resource.namespace === 'share') &&
    resource.segments[1] === 'memories'
  );
}

export function validatePortableSegment(value: string, input = value): string {
  if (!value) return invalid(input, 'empty path segments are not allowed');
  if (value !== Effect.pipe(value, EffectString.normalize('NFC')))
    return invalid(input, 'path segments must use NFC Unicode normalization');
  if (value === '.' || value === '..') return invalid(input, 'dot path segments are not allowed');
  if (hasControlCharacter(value) || PORTABLE_UNSAFE_CHARACTERS.test(value)) {
    return invalid(input, 'path segment contains a non-portable character');
  }
  if (/[ .]$/.test(value)) return invalid(input, 'path segment may not end with a space or dot');
  if (WINDOWS_RESERVED_NAME.test(value)) return invalid(input, 'path segment is a Windows reserved name');
  if (new TextEncoder().encode(value).byteLength > 255) return invalid(input, 'path segment exceeds 255 UTF-8 bytes');
  return value;
}

function decodeSegment(raw: string, input: string, label: string): string {
  if (!raw) return invalid(input, `${label} is empty`);
  if (/%(?:2f|5c|00)/i.test(raw)) return invalid(input, `${label} contains an encoded separator or NUL`);
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return invalid(input, `${label} has invalid percent encoding`);
  }
  try {
    return validatePortableSegment(decoded, input);
  } catch (cause) {
    if (Schema.is(InvalidResourceId)(cause)) {
      return invalid(input, `${label}: ${cause.reason}`);
    }
    throw cause;
  }
}

function decodeAnchor(raw: string, input: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return invalid(input, 'anchor has invalid percent encoding');
  }
  return validateAnchor(decoded, input);
}

function validateAnchor(value: string, input: string): string {
  if (!value || hasControlCharacter(value)) return invalid(input, 'anchor is empty or contains control characters');
  return value;
}

function hasControlCharacter(value: string): boolean {
  return EffectArray.some(
    [...value],
    character =>
      Effect.pipe(
        character,
        EffectString.codePointAt(0),
        Effect.Option.getOrElse(() => undefined),
      )! <= 0x1f,
  );
}

function invalid(input: string, reason: string): never {
  throw InvalidResourceId.make({
    input,
    message: `Invalid resource identifier "${input}": ${reason}.`,
    reason,
  });
}
