import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {codeGraphContentIdentity, createCodeGraphContentIdentityAccumulator} from '@threadnote/graph/graph_identity';
import {codeGraphBuildRequestKey} from '@threadnote/graph/indexer/build';
import {
  graphContentIdentity,
  snapshotIdentity,
  sparseOverlayGraphContentIdentity,
  sparseOverlaySnapshotIdentity,
} from '@threadnote/graph/indexer/materialization';
import {BUILTIN_LANGUAGE_PACK_REGISTRY} from '@threadnote/graph/languages/registry';
import {
  codeGraphScopeIdentityCompatible,
  codeGraphScopeViewKey,
  type CodeGraphScopeIdentity,
} from '@threadnote/graph/scope/identity';

const identity = {
  checkoutId: 'c'.repeat(64),
  headCommit: 'e'.repeat(40),
  repositoryId: 'a'.repeat(64),
  worktreeId: 'd'.repeat(64),
};
const files = [
  {path: 'src/a.ts', contentHash: '1'.repeat(64), source: 'commit', language: 'typescript', mode: '100644'},
];
const full: CodeGraphScopeIdentity = {
  scopeKey: 'full-repository',
  definitionDigest: '1'.repeat(64),
  closureDigest: '2'.repeat(64),
};
function identities(scope?: CodeGraphScopeIdentity) {
  return {
    snapshot: snapshotIdentity(identity, false, 'extractors', files, scope),
    content: graphContentIdentity('extractors', files, scope),
    sparseSnapshot: sparseOverlaySnapshotIdentity(identity, 'base', 'extractors', 'overlay', scope),
    sparseContent: sparseOverlayGraphContentIdentity('base-content', 'extractors', 'overlay', scope),
    request: codeGraphBuildRequestKey(
      identity,
      {dirty: false},
      BUILTIN_LANGUAGE_PACK_REGISTRY,
      undefined,
      false,
      '1'.repeat(64),
      scope,
    ),
  };
}

describe('scope-bound graph identities', () => {
  it('preserves every legacy full-repository identity byte for byte', () => {
    const expected = {
      snapshot: 'cgsn_a4c917d4dc9e1769f62eba609b29873f08299334',
      content: 'cgc_12b506b3abbfbc2188ca3719e3aaad36bf45cc5e',
      sparseSnapshot: 'cgsn_9f2d7685baa60d382ff6e1c8718b0bcfebd21307',
      sparseContent: 'cgc_c30b1bbfb3e0a77e420d5fcd18afce1f03ac91d4',
      request: 'ab2a9ef5c2c905222ab7bcb36bb92357e108a7bc03946ba53bbddf876834e102',
    };
    expect(identities()).toEqual(expected);
    expect(identities(full)).toEqual(expected);
    expect(codeGraphScopeIdentityCompatible(undefined, full)).toBe(true);
    expect(codeGraphScopeViewKey(identity.worktreeId)).toBe(identity.worktreeId);
  });

  it('distinguishes every scope identity dimension and preserves streaming equivalence', () => {
    fc.assert(
      fc.property(fc.string({maxLength: 64}), seed => {
        const scope: CodeGraphScopeIdentity = {
          scopeKey: `code-graph-scope:${sha256HexSync(`scope:${seed}`)}`,
          definitionDigest: sha256HexSync(`definition:${seed}`),
          closureDigest: sha256HexSync(`closure:${seed}`),
        };
        const original = identities(scope);
        expect(identities({...scope})).toEqual(original);
        for (const changed of [
          full,
          {...scope, scopeKey: `code-graph-scope:${sha256HexSync(`other:${seed}`)}`},
          {...scope, definitionDigest: sha256HexSync(`other-definition:${seed}`)},
          {...scope, closureDigest: sha256HexSync(`other-closure:${seed}`)},
        ]) {
          const other = identities(changed);
          for (const key of Object.keys(original) as (keyof typeof original)[]) {
            expect(other[key]).not.toBe(original[key]);
          }
          expect(codeGraphScopeIdentityCompatible(scope, changed)).toBe(false);
        }
        const accumulator = createCodeGraphContentIdentityAccumulator('extractors', scope);
        for (const file of files) accumulator.update(file);
        expect(accumulator.digest()).toBe(codeGraphContentIdentity('extractors', files, scope));
      }),
      {numRuns: 80},
    );
  });

  it('keys views by the independent worktree and logical scope, not their changing definition', () => {
    fc.assert(
      fc.property(fc.uniqueArray(fc.string({maxLength: 32}), {minLength: 2, maxLength: 12}), seeds => {
        const keys = seeds.flatMap(worktree =>
          seeds.map(scope =>
            codeGraphScopeViewKey(sha256HexSync(worktree), `code-graph-scope:${sha256HexSync(scope)}`),
          ),
        );
        expect(new Set(keys).size).toBe(seeds.length ** 2);
        expect(keys.every(key => /^[0-9a-f]{64}\.scope-[0-9a-f]{64}$/u.test(key))).toBe(true);
      }),
      {numRuns: 80},
    );
  });
});
