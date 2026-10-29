import {Array as EffectArray} from 'effect';
import {describe, expect, it} from 'vitest';
import * as FC from 'fast-check';
import {parseBearerAccessToken} from '@threadnote/protocol/access-token';
import {
  graphControlGrantAllowsRead,
  makeGraphControlRateLimit,
  parseGraphControlPolicy,
} from '@threadnote/graph/sharing/control/authorization';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

const scope = {
  organization: 'acme',
  profileDigest: `sha256:${Effect.pipe('b', EffectString.repeat(64))}`,
  repositoryId: Effect.pipe('a', EffectString.repeat(64)),
};
const principal = {issuer: 'https://identity.example.test/', scopes: new Set(['graph:read']), subject: 'reader'};
const policy = {
  ...scope,
  audience: 'https://graph.example.test',
  grants: [{expiresAt: 2000, scopes: ['graph:read'], subject: 'reader'}],
  issuer: principal.issuer,
  jwksUrl: 'https://identity.example.test/.well-known/jwks.json',
  schemaVersion: 1,
};

describe('graph metadata authorization', () => {
  it('rejects an oversized bearer before verification', () => {
    expect(() => parseBearerAccessToken(`Bearer ${Effect.pipe('x', EffectString.repeat(16 * 1024 + 1))}`)).toThrow(
      'The bearer access token is invalid.',
    );
  });

  it('requires the intersection of exact scope, verified identity, token scope and an unexpired grant', () => {
    const parsed = parseGraphControlPolicy(policy);
    expect(graphControlGrantAllowsRead(parsed, scope, principal, 1000)).toBe(true);
    for (const changed of [
      {...scope, organization: 'other'},
      {...scope, repositoryId: Effect.pipe('c', EffectString.repeat(64))},
      {...scope, profileDigest: `sha256:${Effect.pipe('c', EffectString.repeat(64))}`},
    ])
      expect(graphControlGrantAllowsRead(parsed, changed, principal, 1000)).toBe(false);
    for (const changed of [
      {...principal, subject: 'other'},
      {...principal, issuer: 'https://identity.example.test'},
      {...principal, scopes: new Set(['memory:admin'])},
      {...principal, scopes: new Set<string>()},
    ])
      expect(graphControlGrantAllowsRead(parsed, scope, changed, 1000)).toBe(false);
    expect(graphControlGrantAllowsRead(parsed, scope, principal, 2000)).toBe(false);
    expect(graphControlGrantAllowsRead({...parsed, grants: []}, scope, principal, 1000)).toBe(false);
  });

  it.each([
    {unexpected: true},
    {issuer: 'http://identity.example.test/'},
    {jwksUrl: 'https://user:password@identity.example.test/jwks'},
    {jwksUrl: 'https://other.example.test/jwks'},
    {grants: [{expiresAt: 2000, scopes: ['memory:admin'], subject: 'reader'}]},
    {grants: [{expiresAt: 2000, scopes: ['graph:read'], subject: 'reader', active: true}]},
    {grants: [...policy.grants, ...policy.grants]},
  ])('rejects unsafe or ambiguous policy %#', override => {
    expect(() => parseGraphControlPolicy({...policy, ...override})).toThrow('Graph control policy is invalid.');
  });

  it('grant removal cannot create access, and authorization never mutates input', () => {
    FC.assert(
      FC.property(FC.array(FC.boolean(), {maxLength: 32}), flags => {
        const grants = EffectArray.map(flags, (enabled, index) => ({
          expiresAt: 2000,
          scopes: enabled ? ['graph:read'] : [],
          subject: `reader-${index}`,
        }));
        const full = parseGraphControlPolicy({...policy, grants});
        const reduced = {...full, grants: EffectArray.filter(full.grants, (_grant, index) => index % 2 === 0)};
        const before = JSON.stringify({full, reduced});
        for (let index = 0; index < flags.length; index += 1) {
          const candidate = {...principal, subject: `reader-${index}`};
          const allowed = graphControlGrantAllowsRead(reduced, scope, candidate, 1000);
          expect(!allowed || graphControlGrantAllowsRead(full, scope, candidate, 1000)).toBe(true);
          expect(allowed).toBe(index % 2 === 0 && flags[index] === true);
        }
        expect(JSON.stringify({full, reduced})).toBe(before);
      }),
      {numRuns: 50},
    );
  });

  it('bounds principal rate state without evicting an active principal to reset its limit', () => {
    const admit = makeGraphControlRateLimit({maximumPrincipals: 2, requestsPerMinute: 2});
    expect(admit('a', 0)).toBe(true);
    expect(admit('a', 0)).toBe(true);
    expect(admit('a', 1)).toBe(false);
    expect(admit('b', 1)).toBe(true);
    expect(admit('c', 1)).toBe(false);
    expect(admit('a', 1)).toBe(false);
    expect(admit('c', 60_001)).toBe(true);
    expect(admit('a', 60_001)).toBe(true);
  });
});
