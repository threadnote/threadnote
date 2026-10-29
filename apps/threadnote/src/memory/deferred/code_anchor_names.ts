import {Effect} from 'effect';
import {sha256Hex} from '@threadnote/platform/digest';
import {parseResourceId} from '@threadnote/store/resource-id';
import {DEFERRED_CODE_ANCHOR_URI_ADDRESS_HEX_LENGTH} from './code_anchor_private_fs.js';
import type {DeferredCodeAnchorIntentV1} from './code_anchor_scope.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

const DEFERRED_CODE_ANCHOR_REFS_BLOOM_BYTES = 16;
const DEFERRED_CODE_ANCHOR_REFS_BLOOM_HASH_COUNT = 7;

export function deferredCodeAnchorUriDigest(memoryUri: string) {
  return sha256Hex(parseResourceId(memoryUri).canonicalUri);
}

interface DeferredCodeAnchorIntentNameAddress {
  readonly intentId?: string;
  readonly kind: 'legacy' | 'routed' | 'sharded';
  readonly qualified: boolean;
  readonly refsBloom?: string;
  readonly repositoryRouteDigest?: string;
  readonly uriDigest: string;
  readonly worksetRouteDigest?: string;
}

export const deferredCodeAnchorShardedIntentName = Effect.fn('memoryCodeAnchor.shardedIntentName')(function* (
  intent: DeferredCodeAnchorIntentV1,
) {
  const uriDigest = yield* deferredCodeAnchorUriDigest(intent.memoryUri);
  const refsBloom = yield* deferredCodeAnchorRefsBloom(intent.codeRefs);
  return `${Effect2.pipe(uriDigest, EffectString.slice(0, DEFERRED_CODE_ANCHOR_URI_ADDRESS_HEX_LENGTH))}-${intent.intentId}-b${refsBloom}.json`;
});

export const deferredCodeAnchorRefsBloom = Effect.fn('memoryCodeAnchor.refsBloom')(function* (refs: readonly string[]) {
  const digests = yield* Effect.forEach(refs, ref => sha256Hex(ref), {concurrency: 4});
  const bits = Array.from({length: DEFERRED_CODE_ANCHOR_REFS_BLOOM_BYTES * 8}, () => false);
  for (const digest of digests) {
    for (const position of deferredCodeAnchorBloomPositions(digest)) bits[position] = true;
  }
  let encoded = '';
  for (let offset = 0; offset < bits.length; offset += 4) {
    let value = 0;
    for (let index = 0; index < 4; index += 1) value = value * 2 + (bits[offset + index] ? 1 : 0);
    encoded += value.toString(16);
  }
  return encoded;
});

function deferredCodeAnchorBloomPositions(digest: string): readonly number[] {
  const bitCount = DEFERRED_CODE_ANCHOR_REFS_BLOOM_BYTES * 8;
  return Array.from(
    {length: DEFERRED_CODE_ANCHOR_REFS_BLOOM_HASH_COUNT},
    (_, index) => Number.parseInt(Effect2.pipe(digest, EffectString.slice(index * 8, index * 8 + 8)), 16) % bitCount,
  );
}

export function parseDeferredCodeAnchorIntentName(name: string): DeferredCodeAnchorIntentNameAddress | undefined {
  const legacy = /^([a-f0-9]{64})(?:-(tnca_[a-f0-9]+))?\.json$/u.exec(name);
  if (legacy) {
    return {
      intentId: legacy[2],
      kind: 'legacy',
      qualified: false,
      uriDigest: legacy[1],
    };
  }
  const sharded = /^([a-f0-9]{32})-(tnca_[a-f0-9]{32})-b([a-f0-9]{32})\.json$/u.exec(name);
  if (sharded) {
    return {
      intentId: sharded[2],
      kind: 'sharded',
      qualified: false,
      refsBloom: sharded[3],
      uriDigest: sharded[1],
    };
  }
  const routed =
    /^((?:[a-f0-9]{32}|[a-f0-9]{64}))-(tnca_[a-f0-9]{32})-r((?:[a-f0-9]{8}|[a-f0-9]{12}|[a-f0-9]{32}))(?:-w((?:[a-f0-9]{8}|[a-f0-9]{12}|[a-f0-9]{32})))?(-q)?(?:-b([a-f0-9]{32}))?\.json$/u.exec(
      name,
    );
  if (!routed) return undefined;
  return {
    intentId: routed[2],
    kind: 'routed',
    qualified: routed[5] !== undefined,
    refsBloom: routed[6],
    repositoryRouteDigest: routed[3],
    uriDigest: routed[1],
    worksetRouteDigest: routed[4],
  };
}

/** Public filename-shape classifier for bounded diagnostics and dogfood evidence. */
export function isDeferredCodeAnchorIntentFilename(name: string): boolean {
  return parseDeferredCodeAnchorIntentName(name) !== undefined;
}

export function deferredCodeAnchorIntentIdFromName(name: string): string | undefined {
  return parseDeferredCodeAnchorIntentName(name)?.intentId;
}

export function deferredCodeAnchorUriDigestFromName(name: string): string | undefined {
  return (
    parseDeferredCodeAnchorIntentName(name)?.uriDigest ?? /^([a-f0-9]{64}|[a-f0-9]{32})(?:-|\.json$)/u.exec(name)?.[1]
  );
}

export function isDeferredCodeAnchorIntentNameForDigest(name: string, digest: string): boolean {
  const addressedDigest = parseDeferredCodeAnchorIntentName(name)?.uriDigest;
  return (
    (addressedDigest !== undefined && Effect2.pipe(digest, EffectString.startsWith(addressedDigest))) ||
    ((Effect2.pipe(name, EffectString.startsWith(`${digest}-tnca_`)) ||
      Effect2.pipe(
        name,
        EffectString.startsWith(
          `${Effect2.pipe(digest, EffectString.slice(0, DEFERRED_CODE_ANCHOR_URI_ADDRESS_HEX_LENGTH))}-tnca_`,
        ),
      )) &&
      Effect2.pipe(name, EffectString.endsWith('.json')))
  );
}
