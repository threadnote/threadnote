import {Array as EffectArray} from 'effect';
import {Effect, FileSystem, Option, Schema, Stream} from 'effect';
import type {AccessTokenClaims} from '@threadnote/protocol/access-token';
import {SHA256_DIGEST, SHA256_HEX} from '../digest.js';
import {graphSharingFailure} from '../errors.js';

const Text = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512));
const Policy = Schema.Struct({
  audience: Text,
  grants: Schema.Array(
    Schema.Struct({
      expiresAt: Schema.Int.check(Schema.isGreaterThan(0)),
      scopes: Schema.Array(Schema.Literals(['graph:read', 'graph:contribute'])).check(Schema.isMaxLength(2)),
      subject: Text,
    }),
  ).check(Schema.isMaxLength(1024)),
  issuer: Text,
  jwksUrl: Text,
  organization: Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9._-]{0,127}$/u)),
  profileDigest: Schema.String.check(Schema.isPattern(SHA256_DIGEST)),
  repositoryId: Schema.String.check(Schema.isPattern(SHA256_HEX)),
  schemaVersion: Schema.Literal(1),
});

export type GraphControlPolicy = typeof Policy.Type;
export type GraphControlScope = Pick<GraphControlPolicy, 'organization' | 'profileDigest' | 'repositoryId'>;

export function parseGraphControlPolicy(value: unknown): GraphControlPolicy {
  try {
    const policy = Schema.decodeUnknownSync(Policy, {onExcessProperty: 'error'})(value);
    const issuer = policyUrl(policy.issuer);
    const jwks = policyUrl(policy.jwksUrl);
    policyUrl(policy.audience);
    if (
      issuer.origin !== jwks.origin ||
      new Set(EffectArray.map(policy.grants, grant => grant.subject)).size !== policy.grants.length
    ) {
      throw new Error('Invalid policy binding');
    }
    return policy;
  } catch {
    throw graphSharingFailure('Graph control policy is invalid.');
  }
}

function policyUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash)
    throw new Error('Invalid URL');
  return url;
}

export const readGraphControlPolicy = Effect.fn('codeGraph.sharing.readControlPolicy')(function* (file: string) {
  const bytes = yield* readGraphControlBytes(file, 128 * 1024);
  return yield* Effect.try({
    try: () => parseGraphControlPolicy(JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes))),
    catch: () => graphSharingFailure('Graph control policy is invalid.'),
  });
});

export const readGraphControlBytes = Effect.fn('codeGraph.sharing.readControlBytes')(function* (
  file: string,
  maximum: number,
) {
  const fs = yield* FileSystem.FileSystem;
  if (Option.isSome(yield* fs.readLink(file).pipe(Effect.option))) {
    return yield* graphSharingFailure('Graph control metadata is unavailable.');
  }
  const chunks = yield* Stream.runCollect(fs.stream(file, {bytesToRead: maximum + 1}));
  const bytes = Buffer.concat(chunks);
  if (bytes.length > maximum) return yield* graphSharingFailure('Graph control metadata exceeds its size limit.');
  return bytes;
});

export function graphControlGrantAllowsRead(
  policy: GraphControlPolicy,
  scope: GraphControlScope,
  principal: Pick<AccessTokenClaims, 'issuer' | 'subject' | 'scopes'>,
  nowSeconds: number,
): boolean {
  return graphControlGrantExpiry(policy, scope, principal, 'graph:read', nowSeconds) !== undefined;
}

export function graphControlGrantExpiry(
  policy: GraphControlPolicy,
  scope: GraphControlScope,
  principal: Pick<AccessTokenClaims, 'issuer' | 'subject' | 'scopes'>,
  capability: 'graph:read' | 'graph:contribute',
  nowSeconds: number,
): number | undefined {
  if (
    !Number.isFinite(nowSeconds) ||
    policy.organization !== scope.organization ||
    policy.repositoryId !== scope.repositoryId ||
    policy.profileDigest !== scope.profileDigest ||
    policy.issuer !== principal.issuer ||
    !principal.scopes.has(capability)
  )
    return undefined;
  return Option.getOrUndefined(
    EffectArray.findFirst(
      policy.grants,
      __effectArrayValue =>
        !!(grant =>
          grant.subject === principal.subject && grant.expiresAt > nowSeconds && grant.scopes.includes(capability))(
          __effectArrayValue,
        ),
    ),
  )?.expiresAt;
}

export function makeGraphControlRateLimit(options = {maximumPrincipals: 1024, requestsPerMinute: 120}) {
  const entries = new Map<string, {count: number; expiresAt: number}>();
  return (principal: string, nowMilliseconds: number): boolean => {
    for (const [key, value] of entries) if (value.expiresAt <= nowMilliseconds) entries.delete(key);
    const current = entries.get(principal);
    if (current) {
      if (current.count >= options.requestsPerMinute) return false;
      current.count += 1;
      return true;
    }
    if (entries.size >= options.maximumPrincipals) return false;
    entries.set(principal, {count: 1, expiresAt: nowMilliseconds + 60_000});
    return true;
  };
}
