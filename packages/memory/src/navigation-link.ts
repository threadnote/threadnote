import {Array as EffectArray, Record as EffectRecord, Result, String as EffectString} from 'effect';
import * as Base64Url from 'effect/encoding/Base64Url';
import {parseResourceId} from '@threadnote/store/resource-id';
import {isMemoryId, memoryIdFromIdentityAlias} from './identity-alias.js';

export type MemoryNavigationTarget =
  {readonly kind: 'id'; readonly ref: string} | {readonly kind: 'uri'; readonly ref: string};

export const MEMORY_LINK_BASE = 'https://threadnote.io/open/#';
export const MEMORY_LAUNCH_BASE = 'threadnote://open/v1#';
export const MAX_MEMORY_LINK_TARGET_BYTES = 4096;
export const MAX_MEMORY_LINK_FRAGMENT_BYTES = 6144;

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', {fatal: true});
const selectorPrefix = 'v1.';
const encodedSelector = /^[A-Za-z0-9_-]+$/u;
const markdownPunctuation = /([\\`*_{}[\]()#+.!<>|~])/gu;

/** `verifiedMemoryId` must come from the authoritative read of `uri`, never from agent text. */
export function memoryNavigationTarget(uri: string, verifiedMemoryId?: string): MemoryNavigationTarget {
  const aliasId = memoryIdFromIdentityAlias(uri);
  if (aliasId !== undefined) {
    if (verifiedMemoryId !== undefined && verifiedMemoryId !== aliasId)
      throw new Error('Memory alias and stable identity disagree.');
    return checkedTarget({kind: 'id', ref: aliasId});
  }
  const uriTarget = checkedTarget({kind: 'uri', ref: uri});
  return verifiedMemoryId === undefined ? uriTarget : checkedTarget({kind: 'id', ref: verifiedMemoryId});
}

export function encodeMemoryLinkFragment(target: MemoryNavigationTarget): string {
  const checked = checkedTarget(target);
  const payload = encoder.encode(JSON.stringify({kind: checked.kind, ref: checked.ref}));
  if (payload.byteLength > MAX_MEMORY_LINK_TARGET_BYTES) throw new Error('Memory link target is too large.');
  return `${selectorPrefix}${Base64Url.encode(payload)}`;
}

export function decodeMemoryLinkFragment(fragment: string): MemoryNavigationTarget {
  const value = EffectString.startsWith('#')(fragment) ? EffectString.slice(1)(fragment) : fragment;
  if (value.length > MAX_MEMORY_LINK_FRAGMENT_BYTES || !EffectString.startsWith(selectorPrefix)(value))
    throw new Error('Unsupported or oversized memory link.');
  const encoded = EffectString.slice(selectorPrefix.length)(value);
  if (!encodedSelector.test(encoded)) throw new Error('Malformed memory link.');
  const result = Base64Url.decode(encoded);
  if (!Result.isSuccess(result) || Base64Url.encode(result.success) !== encoded)
    throw new Error('Malformed memory link encoding.');
  if (result.success.byteLength > MAX_MEMORY_LINK_TARGET_BYTES) throw new Error('Memory link target is too large.');
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoder.decode(result.success));
  } catch {
    throw new Error('Malformed memory link target.');
  }
  if (
    !isRecord(parsed) ||
    EffectRecord.keys(parsed).length !== 2 ||
    !EffectRecord.has(parsed, 'kind') ||
    !EffectRecord.has(parsed, 'ref')
  )
    throw new Error('Malformed memory link target.');
  const candidate = parsed;
  if ((candidate.kind !== 'id' && candidate.kind !== 'uri') || typeof candidate.ref !== 'string')
    throw new Error('Malformed memory link target.');
  const checked = checkedTarget({kind: candidate.kind, ref: candidate.ref});
  if (encodeMemoryLinkFragment(checked) !== value) throw new Error('Non-canonical memory link target.');
  return checked;
}

export function memoryLinkHref(target: MemoryNavigationTarget): string {
  return MEMORY_LINK_BASE + encodeMemoryLinkFragment(target);
}

export function memoryLaunchUri(target: MemoryNavigationTarget): string {
  return MEMORY_LAUNCH_BASE + encodeMemoryLinkFragment(target);
}

export function decodeMemoryLaunchUri(input: string): MemoryNavigationTarget {
  if (
    !EffectString.startsWith(MEMORY_LAUNCH_BASE)(input) ||
    input.length > MEMORY_LAUNCH_BASE.length + MAX_MEMORY_LINK_FRAGMENT_BYTES
  )
    throw new Error('Unsupported memory launch URI.');
  return decodeMemoryLinkFragment(EffectString.slice(MEMORY_LAUNCH_BASE.length)(input));
}

export function formatMemoryLink(target: MemoryNavigationTarget, title?: string): string {
  const label = title && EffectString.trim(title) ? title : target.ref;
  const safeLabel = EffectString.replace(markdownPunctuation, '\\$1')(EffectString.replace(/[\r\n\t]/gu, ' ')(label));
  return `[${safeLabel}](${memoryLinkHref(target)})`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !EffectArray.isArray(value);
}

function checkedTarget(target: MemoryNavigationTarget): MemoryNavigationTarget {
  if (target.kind === 'id') {
    if (!isMemoryId(target.ref)) throw new Error('Invalid stable memory identity.');
    return target;
  }
  if (target.kind !== 'uri') throw new Error('Invalid memory link target kind.');
  if (encoder.encode(target.ref).byteLength > MAX_MEMORY_LINK_TARGET_BYTES)
    throw new Error('Memory link target is too large.');
  let parsed: ReturnType<typeof parseResourceId>;
  try {
    parsed = parseResourceId(target.ref);
  } catch {
    throw new Error('Memory link requires a canonical local memory URI.');
  }
  if (
    parsed.inputScheme !== 'threadnote' ||
    parsed.anchor !== undefined ||
    parsed.canonicalUri !== target.ref ||
    parsed.namespace !== 'user' ||
    parsed.segments.length < 3 ||
    parsed.segments[1] !== 'memories'
  )
    throw new Error('Memory link requires a canonical local memory URI.');
  return target;
}
