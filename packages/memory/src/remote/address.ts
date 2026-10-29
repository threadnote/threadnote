import {Schema} from 'effect';
import type {RemoteMemoryKind} from './contracts.js';
import {
  canonicalResourceUri,
  parseResourceId,
  resourceIdIsWithin,
  resourceIdWithoutAnchor,
  validatePortableSegment,
} from '@threadnote/store/resource-id';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';
import {Array as EffectArray} from 'effect';

export const REMOTE_SHARE_NAMESPACE = 'share' as const;
export const REMOTE_MEMORY_ALIAS_VERSION = 1 as const;

export interface RemoteShareAddress {
  readonly canonicalUri: string;
  readonly kind: RemoteMemoryKind;
  readonly project: string;
  readonly shareId: string;
  readonly topic: string;
}

export interface RemoteMemoryUriAliasV1 {
  readonly aliasUri: string;
  readonly canonicalUri: string;
  readonly shareId: string;
  readonly version: typeof REMOTE_MEMORY_ALIAS_VERSION;
}

export interface RemoteMemoryAddressResolutionV1 {
  readonly address: RemoteShareAddress;
  readonly aliasUri?: string;
  readonly canonicalUri: string;
  readonly version: typeof REMOTE_MEMORY_ALIAS_VERSION;
}

export class InvalidRemoteMemoryAddress extends Schema.TaggedError<
  InvalidRemoteMemoryAddress,
  {readonly brand: unique symbol}
>()('InvalidRemoteMemoryAddress', {input: Schema.String, message: Schema.String, reason: Schema.String}) {}

export class InvalidRemoteMemoryAlias extends Schema.TaggedError<
  InvalidRemoteMemoryAlias,
  {readonly brand: unique symbol}
>()('InvalidRemoteMemoryAlias', {input: Schema.String, message: Schema.String, reason: Schema.String}) {}

export function formatRemoteShareRootUri(shareId: string): string {
  return canonicalResourceUri(REMOTE_SHARE_NAMESPACE, [validatePortableSegment(shareId), 'memories']);
}

export function formatRemoteMemoryUri(input: {
  readonly kind: RemoteMemoryKind;
  readonly project: string;
  readonly shareId: string;
  readonly topic: string;
}): string {
  const shareId = validatePortableSegment(input.shareId);
  const project = validatePortableSegment(input.project);
  const topic = validatePortableSegment(input.topic);
  const kindSegments = input.kind === 'durable' ? ['durable'] : ['handoffs', 'active'];
  return canonicalResourceUri(REMOTE_SHARE_NAMESPACE, [shareId, 'memories', ...kindSegments, project, `${topic}.md`]);
}

export function parseRemoteShareAddress(input: string): RemoteShareAddress {
  let resource;
  try {
    const parsed = parseResourceId(input);
    if (parsed.anchor) return invalidAddress(input, 'remote memory addresses cannot contain anchors');
    resource = resourceIdWithoutAnchor(parsed);
  } catch (cause) {
    return invalidAddress(input, cause instanceof Error ? cause.message : 'invalid resource identifier');
  }
  if (resource.inputScheme !== 'threadnote') return invalidAddress(input, 'remote share addresses require threadnote');
  if (resource.namespace !== REMOTE_SHARE_NAMESPACE)
    return invalidAddress(input, 'expected the immutable share namespace');

  const [shareId, memories, category, handoffStateOrProject, handoffProjectOrFile, handoffFile] = resource.segments;
  if (!shareId || memories !== 'memories') return invalidAddress(input, 'expected a share memory address');

  let kind: RemoteMemoryKind;
  let project: string | undefined;
  let file: string | undefined;
  if (category === 'durable' && resource.segments.length === 5) {
    kind = 'durable';
    project = handoffStateOrProject;
    file = handoffProjectOrFile;
  } else if (category === 'handoffs' && handoffStateOrProject === 'active' && resource.segments.length === 6) {
    kind = 'handoff';
    project = handoffProjectOrFile;
    file = handoffFile;
  } else {
    return invalidAddress(input, 'expected a durable or active-handoff memory address');
  }
  if (
    !project ||
    !Effect.pipe(file, effectOptionalString =>
      effectOptionalString == null ? undefined : Effect.pipe(effectOptionalString, EffectString.endsWith('.md')),
    ) ||
    file === '.md'
  ) {
    return invalidAddress(input, 'memory address requires a project and .md topic');
  }
  const topic = Effect.pipe(file, EffectString.slice(0, -3));
  const canonicalUri = formatRemoteMemoryUri({kind, project, shareId, topic});
  if (canonicalUri !== resource.canonicalUri) return invalidAddress(input, 'memory address is not canonical');
  return {canonicalUri, kind, project, shareId, topic};
}

export function remoteShareUriIsWithin(candidateUri: string, authorizedShareId: string): boolean {
  try {
    const candidate = parseResourceId(candidateUri);
    if (candidate.anchor || candidate.inputScheme !== 'threadnote') return false;
    return resourceIdIsWithin(candidate.canonicalUri, formatRemoteShareRootUri(authorizedShareId));
  } catch {
    return false;
  }
}

export function resolveRemoteMemoryAlias(input: {
  readonly aliases: readonly RemoteMemoryUriAliasV1[];
  readonly authorizedShareId: string;
  readonly inputUri: string;
}): RemoteMemoryAddressResolutionV1 {
  const authorizedShareId = validatePortableSegment(input.authorizedShareId);
  const direct = tryParseRemoteAddress(input.inputUri);
  if (direct) {
    if (direct.shareId !== authorizedShareId) return invalidAlias(input.inputUri, 'address belongs to another share');
    return {address: direct, canonicalUri: direct.canonicalUri, version: REMOTE_MEMORY_ALIAS_VERSION};
  }

  const normalizedInput = canonicalAliasSource(input.inputUri);
  const matches = EffectArray.filter(
    input.aliases,
    alias => alias.shareId === authorizedShareId && canonicalAliasSource(alias.aliasUri) === normalizedInput,
  );
  if (matches.length === 0) return invalidAlias(input.inputUri, 'no alias exists in the authorized share');

  const targets = new Map<string, RemoteShareAddress>();
  for (const match of matches) {
    if (match.version !== REMOTE_MEMORY_ALIAS_VERSION) {
      return invalidAlias(input.inputUri, 'unsupported alias contract version');
    }
    const address = parseRemoteShareAddress(match.canonicalUri);
    if (address.shareId !== authorizedShareId)
      return invalidAlias(input.inputUri, 'alias target belongs to another share');
    targets.set(address.canonicalUri, address);
  }
  if (targets.size !== 1) return invalidAlias(input.inputUri, 'alias is ambiguous within the authorized share');
  const [canonicalUri, address] = targets.entries().next().value!;
  return {
    address,
    aliasUri: normalizedInput,
    canonicalUri,
    version: REMOTE_MEMORY_ALIAS_VERSION,
  };
}

function canonicalAliasSource(input: string): string {
  try {
    const resource = parseResourceId(input);
    if (resource.anchor) return invalidAlias(input, 'aliases cannot contain anchors');
    return resource.canonicalUri;
  } catch (cause) {
    if (Schema.is(InvalidRemoteMemoryAlias)(cause)) throw cause;
    return invalidAlias(input, cause instanceof Error ? cause.message : 'invalid alias URI');
  }
}

function tryParseRemoteAddress(input: string): RemoteShareAddress | undefined {
  try {
    return parseRemoteShareAddress(input);
  } catch (cause) {
    if (Schema.is(InvalidRemoteMemoryAddress)(cause)) return undefined;
    throw cause;
  }
}

function invalidAddress(input: string, reason: string): never {
  throw InvalidRemoteMemoryAddress.make({
    input,
    message: `Invalid remote memory address "${input}": ${reason}.`,
    reason,
  });
}

function invalidAlias(input: string, reason: string): never {
  throw InvalidRemoteMemoryAlias.make({
    input,
    message: `Invalid remote memory alias "${input}": ${reason}.`,
    reason,
  });
}
