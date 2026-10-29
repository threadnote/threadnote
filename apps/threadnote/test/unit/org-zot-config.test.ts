import {Array as EffectArray, Option as EffectOption} from 'effect';
import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {assertProfileMatches, buildZotConfig} from '../../../../deploy/threadnote-org-registry/render-config.js';

const env = {
  ZOT_PUBLIC_ORIGIN: 'https://registry.example.test',
  ZOT_OIDC_ISSUER: 'https://issuer.example.test/',
  ZOT_OIDC_AUDIENCE: 'https://registry.example.test',
  ZOT_CANONICAL_REPOSITORY: 'fixture/canonical',
  ZOT_WORKER_REPOSITORY: 'fixture/worker',
  ZOT_PUBLISHER_SUBJECT: 'publisher',
  ZOT_WORKER_SUBJECTS_JSON: '["laptop","cloud"]',
  ZOT_READER_SUBJECTS_JSON: '["observer"]',
};

describe('organization Zot configuration', () => {
  it('binds the challenge to the public HTTPS origin and isolates writer roles', () => {
    const config = buildZotConfig(env);
    expect(config.http.auth.bearer.realm).toBe('https://registry.example.test/zot/auth/token');
    expect(config.http.auth.bearer.oidc[0]).toEqual({
      issuer: 'https://issuer.example.test/',
      audiences: ['https://registry.example.test'],
      claimMapping: {
        username: 'claims.sub',
        validations: [
          {
            expression:
              "'scope' in claims && type(claims.scope) == string && ((claims.sub == \"publisher\" && (' ' + claims.scope + ' ').contains(' registry:publisher ')) || (claims.sub in [\"laptop\",\"cloud\"] && (' ' + claims.scope + ' ').contains(' registry:worker ')) || (claims.sub in [\"observer\"] && (' ' + claims.scope + ' ').contains(' registry:read ')))",
            message: 'Registry role scope is required.',
          },
        ],
      },
    });
    expect(config.http.accessControl.repositories['fixture/canonical'].policies).toEqual([
      {users: ['publisher'], actions: ['read', 'create', 'update']},
      {users: ['laptop', 'cloud', 'observer'], actions: ['read']},
    ]);
    expect(config.http.accessControl.repositories['fixture/worker'].policies).toEqual([
      {users: ['laptop', 'cloud'], actions: ['read', 'create', 'update']},
      {users: ['publisher', 'observer'], actions: ['read']},
    ]);
    expect(config.http.accessControl.repositories['**']).toEqual({defaultPolicy: [], anonymousPolicy: []});
    expect(config.storage.gc).toBe(false);
  });

  it.each([
    [{ZOT_PUBLIC_ORIGIN: 'http://registry.example.test'}, 'canonical HTTPS'],
    [{ZOT_PUBLIC_ORIGIN: 'https://registry.example.test/path'}, 'canonical HTTPS'],
    [{ZOT_OIDC_AUDIENCE: 'https://other.example.test'}, 'must equal'],
    [{ZOT_WORKER_REPOSITORY: 'fixture/canonical'}, 'distinct'],
    [{ZOT_WORKER_SUBJECTS_JSON: '["publisher"]'}, 'disjoint'],
    [{ZOT_WORKER_SUBJECTS_JSON: '["laptop","laptop"]'}, 'distinct'],
    [{ZOT_READER_SUBJECTS_JSON: '["cloud"]'}, 'disjoint'],
  ] as const)('rejects invalid authority or role input %#', (change, message) => {
    expect(() => buildZotConfig({...env, ...change})).toThrow(message);
  });

  it('checks both registry references against the enrollment profile', () => {
    const config = buildZotConfig(env);
    const registry = {
      canonical: 'oci://registry.example.test/fixture/canonical',
      worker: 'oci://registry.example.test/fixture/worker',
    };
    expect(() => assertProfileMatches(config, {registry})).not.toThrow();
    expect(() => assertProfileMatches(config, {registry: {...registry, worker: registry.canonical}})).toThrow(
      'do not match',
    );
  });

  it('accepts an empty optional reader list without granting reader scope to another role', () => {
    const config = buildZotConfig({...env, ZOT_READER_SUBJECTS_JSON: '[]'});
    const validation = config.http.auth.bearer.oidc[0]?.claimMapping.validations[0];
    expect(validation?.expression).toContain('claims.sub in []');
    expect(config.http.accessControl.repositories['fixture/canonical'].policies?.[1]?.users).toEqual([
      'laptop',
      'cloud',
    ]);
  });

  it('keeps every generated worker limited to worker writes and canonical reads', () => {
    fc.assert(
      fc.property(fc.uniqueArray(fc.stringMatching(/^[a-z0-9"\\]{1,8}$/u), {minLength: 1, maxLength: 4}), suffixes => {
        const workers = EffectArray.map(suffixes, suffix => `worker-${suffix}`);
        const config = buildZotConfig({...env, ZOT_WORKER_SUBJECTS_JSON: JSON.stringify(workers)});
        const canonicalPolicies = config.http.accessControl.repositories['fixture/canonical'].policies;
        const workerPolicies = config.http.accessControl.repositories['fixture/worker'].policies;
        if (canonicalPolicies === undefined || workerPolicies === undefined) throw new Error('Missing scoped policy');
        expect(
          EffectOption.getOrUndefined(
            EffectArray.findFirst(
              canonicalPolicies,
              __effectArrayValue => !!(policy => policy.actions.includes('create'))(__effectArrayValue),
            ),
          )?.users,
        ).toEqual(['publisher']);
        expect(
          EffectOption.getOrUndefined(
            EffectArray.findFirst(
              workerPolicies,
              __effectArrayValue => !!(policy => policy.actions.includes('create'))(__effectArrayValue),
            ),
          )?.users,
        ).toEqual(workers);
        expect(
          EffectOption.getOrUndefined(EffectArray.findFirst(canonicalPolicies, policy => policy.actions.length === 1))
            ?.users,
        ).toEqual([...workers, 'observer']);
        expect(config.http.auth.bearer.oidc[0]?.claimMapping.validations[0]?.expression).toContain(
          `claims.sub in ${JSON.stringify(workers)}`,
        );
      }),
      {numRuns: 50},
    );
  });
});
