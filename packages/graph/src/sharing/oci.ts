import {Array as EffectArray} from 'effect';
import {SHA256_HEX} from './digest.js';
import {graphSharingFailure} from './errors.js';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

export const GRAPH_SHARE_HTTP_CAS_MAX_BYTES = 32 * 1_048_576;
export const GRAPH_SHARE_REGISTRY_MANIFEST_MAX_BYTES = 4 * 1_048_576;
export const GRAPH_SHARE_HTTP_CAS_PATH = /^\/v1\/cas\/sha256\/([0-9a-f]{64})$/u;
export const GRAPH_SHARE_HTTP_TAG_PATH =
  /^\/v1\/tags\/(tn-(?:frontier-[0-9a-f]{40}|action-[0-9a-f]{64}|work-[0-9a-f]{40}))$/u;
export const GRAPH_SHARE_DISCOVERY_TAG = /^tn-(?:frontier-[0-9a-f]{40}|action-[0-9a-f]{64}|work-[0-9a-f]{40})$/u;

const GIT_OBJECT_PREFIXES = ['blob ', 'commit ', 'tag ', 'tree '] as const;

export function parseGraphShareHttpCasPath(pathname: string): string | undefined {
  const match = GRAPH_SHARE_HTTP_CAS_PATH.exec(pathname);
  return match?.[1] !== undefined && SHA256_HEX.test(match[1]) ? match[1] : undefined;
}

export function parseGraphShareHttpTagPath(pathname: string): string | undefined {
  const match = GRAPH_SHARE_HTTP_TAG_PATH.exec(pathname);
  return match?.[1];
}

export function assertGraphShareDiscoveryTag(name: string): string {
  if (!GRAPH_SHARE_DISCOVERY_TAG.test(name)) {
    throw graphSharingFailure('Graph share discovery tag is invalid.');
  }
  return name;
}

export function graphSharePayloadLooksLikeGitObject(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 5) return false;
  const prefix = new TextDecoder().decode(bytes.subarray(0, 7));
  return EffectArray.some(GIT_OBJECT_PREFIXES, candidate => Effect.pipe(prefix, EffectString.startsWith(candidate)));
}
