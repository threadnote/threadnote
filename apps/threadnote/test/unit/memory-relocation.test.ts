import {Array as EffectArray} from 'effect';
import {fcEffectProp} from '@threadnote/testing/fast-check-property';
import {it as effectIt} from '@effect/vitest';
import {Effect, Exit, FileSystem, Path} from 'effect';
import fc from 'fast-check';
import {describe, expect} from 'vitest';
import {ResourceStore} from '@threadnote/store/resource-store';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import {formatMemoryDocument, type MemoryMetadata} from '@threadnote/memory/document';
import {
  MAX_MEMORY_RELOCATION_DEPTH,
  MemoryRelocationError,
  MemoryPointerNotFound,
  readMemoryWithRelocations,
  recordMemoryRelocation,
} from '@threadnote/memory/relocation';
import {writeMemoryFile} from '@threadnote/threadnote/share/core';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {provideTestLayer} from '../helpers/effect-layer.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

describe('private memory relocation receipts', () => {
  effectIt.effect('resolves a moved URI, lets live reuse win, and prevents stale receipt revival', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture('reuse');
        const sourceUri = memoryUri(0);
        const targetUri = memoryUri(1);
        const moved = memoryContent('tn_relocated', 'Moved evidence.');
        yield* fixture.store.write(fixture.location, sourceUri, moved, {mode: 'create'});
        yield* fixture.store.write(fixture.location, targetUri, moved, {mode: 'create'});
        yield* recordMemoryRelocation(fixture.config, {
          fromContent: moved,
          fromUri: sourceUri,
          toContent: moved,
          toUri: targetUri,
        });
        yield* fixture.store.remove(fixture.location, sourceUri);

        expect(yield* readMemoryWithRelocations(fixture.config, sourceUri)).toMatchObject({
          canonicalUri: targetUri,
          content: moved,
          memoryId: 'tn_relocated',
          relocationDepth: 1,
          requestedUri: sourceUri,
        });

        const reused = memoryContent('tn_reused', 'Independent live memory.');
        yield* writeMemoryFile(fixture.config, 'threadnote-native', sourceUri, reused, 'create', false, {quiet: true});
        expect(yield* readMemoryWithRelocations(fixture.config, sourceUri)).toMatchObject({
          canonicalUri: sourceUri,
          content: reused,
          relocationDepth: 0,
        });
        yield* fixture.store.remove(fixture.location, sourceUri);
        const missing = yield* readMemoryWithRelocations(fixture.config, sourceUri).pipe(Effect.exit);
        expect(Exit.isFailure(missing)).toBe(true);
        if (Exit.isFailure(missing)) expect(String(missing.cause)).toContain(MemoryPointerNotFound.name);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('distinguishes a first-hop miss from an incomplete verified relocation chain', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture('incomplete-chain');
        const sourceUri = memoryUri(0);
        const targetUri = memoryUri(1);
        const content = memoryContent('tn_incomplete_chain', 'Incomplete chain evidence.');
        yield* fixture.store.write(fixture.location, sourceUri, content, {mode: 'create'});
        yield* fixture.store.write(fixture.location, targetUri, content, {mode: 'create'});
        yield* recordMemoryRelocation(fixture.config, {
          fromContent: content,
          fromUri: sourceUri,
          toContent: content,
          toUri: targetUri,
        });
        yield* fixture.store.remove(fixture.location, sourceUri);
        yield* fixture.store.remove(fixture.location, targetUri);

        const result = yield* readMemoryWithRelocations(fixture.config, sourceUri).pipe(Effect.exit);
        expect(Exit.isFailure(result)).toBe(true);
        if (Exit.isFailure(result)) {
          expect(String(result.cause)).toContain(MemoryRelocationError.name);
          expect(String(result.cause)).toContain('chain is incomplete');
          expect(String(result.cause)).not.toContain(MemoryPointerNotFound.name);
        }
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('fails closed when either the move or later destination changes memory identity', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture('identity');
        const sourceUri = memoryUri(0);
        const targetUri = memoryUri(1);
        const source = memoryContent('tn_source', 'Source evidence.');
        const other = memoryContent('tn_other', 'Other evidence.');
        yield* fixture.store.write(fixture.location, sourceUri, source, {mode: 'create'});
        yield* fixture.store.write(fixture.location, targetUri, other, {mode: 'create'});

        const mismatchedMove = yield* recordMemoryRelocation(fixture.config, {
          fromContent: source,
          fromUri: sourceUri,
          toContent: other,
          toUri: targetUri,
        }).pipe(Effect.exit);
        expect(Exit.isFailure(mismatchedMove)).toBe(true);
        if (Exit.isFailure(mismatchedMove)) expect(String(mismatchedMove.cause)).toContain('memory_id');

        yield* fixture.store.write(fixture.location, targetUri, source, {mode: 'upsert'});
        yield* recordMemoryRelocation(fixture.config, {
          fromContent: source,
          fromUri: sourceUri,
          toContent: source,
          toUri: targetUri,
        });
        yield* fixture.store.remove(fixture.location, sourceUri);
        yield* fixture.store.write(fixture.location, targetUri, other, {mode: 'upsert'});
        const changedDestination = yield* readMemoryWithRelocations(fixture.config, sourceUri).pipe(Effect.exit);
        expect(Exit.isFailure(changedDestination)).toBe(true);
        if (Exit.isFailure(changedDestination)) {
          expect(String(changedDestination.cause)).toContain('MemoryRelocationError');
          expect(String(changedDestination.cause)).toContain('identity fence');
        }
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('uses its private receipt when a live destination lost only its identity header', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture('missing-destination-identity');
        const sourceUri = memoryUri(0);
        const targetUri = memoryUri(1);
        const original = memoryContent('tn_receipt_witness', 'Receipt-witnessed evidence.');
        const missingIdentity = Effect2.pipe(original, EffectString.replace('memory_id: tn_receipt_witness\n', ''));
        yield* fixture.store.write(fixture.location, sourceUri, original, {mode: 'create'});
        yield* fixture.store.write(fixture.location, targetUri, original, {mode: 'create'});
        yield* recordMemoryRelocation(fixture.config, {
          fromContent: original,
          fromUri: sourceUri,
          toContent: original,
          toUri: targetUri,
        });
        yield* fixture.store.remove(fixture.location, sourceUri);
        yield* fixture.store.write(fixture.location, targetUri, missingIdentity, {mode: 'upsert'});

        expect(yield* readMemoryWithRelocations(fixture.config, sourceUri)).toMatchObject({
          canonicalUri: targetUri,
          content: missingIdentity,
          memoryId: 'tn_receipt_witness',
          relocationDepth: 1,
          requestedUri: sourceUri,
        });

        yield* fixture.store.write(
          fixture.location,
          targetUri,
          memoryContent('tn_different_identity', 'Different evidence.'),
          {mode: 'upsert'},
        );
        const mismatch = yield* readMemoryWithRelocations(fixture.config, sourceUri).pipe(Effect.exit);
        expect(Exit.isFailure(mismatch)).toBe(true);
        if (Exit.isFailure(mismatch)) expect(String(mismatch.cause)).toContain('identity fence');
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  fcEffectProp(
    effectIt,
    'accepts only an absent or matching destination identity through a receipt',
    {
      destinationMemoryId: fc.oneof(
        fc.constant(undefined),
        fc.constant('tn_receipt_property'),
        fc.integer({max: 65_535, min: 0}).map(value => `tn_other_${value.toString(16)}`),
      ),
    },
    ({destinationMemoryId}) =>
      Effect.scoped(
        Effect.gen(function* () {
          const fixture = yield* makeFixture('identity-property');
          const sourceUri = memoryUri(0);
          const targetUri = memoryUri(1);
          const original = memoryContent('tn_receipt_property', 'Property evidence.');
          yield* fixture.store.write(fixture.location, sourceUri, original, {mode: 'create'});
          yield* fixture.store.write(fixture.location, targetUri, original, {mode: 'create'});
          yield* recordMemoryRelocation(fixture.config, {
            fromContent: original,
            fromUri: sourceUri,
            toContent: original,
            toUri: targetUri,
          });
          yield* fixture.store.remove(fixture.location, sourceUri);
          const destination =
            destinationMemoryId === undefined
              ? Effect2.pipe(original, EffectString.replace('memory_id: tn_receipt_property\n', ''))
              : memoryContent(destinationMemoryId, 'Property evidence.');
          yield* fixture.store.write(fixture.location, targetUri, destination, {mode: 'upsert'});

          const result = yield* readMemoryWithRelocations(fixture.config, sourceUri).pipe(Effect.exit);
          if (destinationMemoryId === undefined || destinationMemoryId === 'tn_receipt_property') {
            expect(Exit.isSuccess(result)).toBe(true);
          } else {
            expect(Exit.isFailure(result)).toBe(true);
            if (Exit.isFailure(result)) expect(String(result.cause)).toContain('identity fence');
          }
        }),
      ).pipe(provideTestLayer(ApplicationLayer)),
    {fastCheck: {numRuns: 24}},
  );

  fcEffectProp(
    effectIt,
    'resolves every acyclic chain up to the production depth bound',
    {depth: fc.integer({max: MAX_MEMORY_RELOCATION_DEPTH, min: 1})},
    ({depth}) =>
      Effect.scoped(
        Effect.gen(function* () {
          const fixture = yield* makeFixture(`chain-${depth}`);
          const content = memoryContent('tn_chain', `Chain depth ${depth}.`);
          const uris = Array.from({length: depth + 1}, (_, index) => memoryUri(index));
          for (const uri of uris) {
            yield* fixture.store.write(fixture.location, uri, content, {mode: 'create'});
          }
          for (let index = 0; index < depth; index += 1) {
            yield* recordMemoryRelocation(fixture.config, {
              fromContent: content,
              fromUri: uris[index],
              toContent: content,
              toUri: uris[index + 1],
            });
          }
          for (const uri of uris.slice(0, -1)) yield* fixture.store.remove(fixture.location, uri);

          expect(yield* readMemoryWithRelocations(fixture.config, uris[0])).toMatchObject({
            canonicalUri: uris.at(-1),
            content,
            relocationDepth: depth,
            requestedUri: uris[0],
          });
        }),
      ).pipe(provideTestLayer(ApplicationLayer)),
    {fastCheck: {numRuns: 16}},
  );

  effectIt.effect('rejects loops and chains beyond the fixed bound', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture('bounds');
        const content = memoryContent('tn_bounds', 'Bounded chain.');
        const uris = Array.from({length: MAX_MEMORY_RELOCATION_DEPTH + 2}, (_, index) => memoryUri(index));
        for (const uri of uris) yield* fixture.store.write(fixture.location, uri, content, {mode: 'create'});
        for (let index = 0; index < uris.length - 1; index += 1) {
          yield* recordMemoryRelocation(fixture.config, {
            fromContent: content,
            fromUri: uris[index],
            toContent: content,
            toUri: uris[index + 1],
          });
        }
        for (const uri of uris.slice(0, -1)) yield* fixture.store.remove(fixture.location, uri);
        const tooDeep = yield* readMemoryWithRelocations(fixture.config, uris[0]).pipe(Effect.exit);
        expect(Exit.isFailure(tooDeep)).toBe(true);
        if (Exit.isFailure(tooDeep)) expect(String(tooDeep.cause)).toContain('maximum depth');

        const loopFixture = yield* makeFixture('loop');
        const loopUris = [memoryUri(20), memoryUri(21)];
        for (const uri of loopUris)
          yield* loopFixture.store.write(loopFixture.location, uri, content, {mode: 'create'});
        yield* recordMemoryRelocation(loopFixture.config, {
          fromContent: content,
          fromUri: loopUris[0],
          toContent: content,
          toUri: loopUris[1],
        });
        yield* recordMemoryRelocation(loopFixture.config, {
          fromContent: content,
          fromUri: loopUris[1],
          toContent: content,
          toUri: loopUris[0],
        });
        for (const uri of loopUris) yield* loopFixture.store.remove(loopFixture.location, uri);
        const loop = yield* readMemoryWithRelocations(loopFixture.config, loopUris[0]).pipe(Effect.exit);
        expect(Exit.isFailure(loop)).toBe(true);
        if (Exit.isFailure(loop)) {
          expect(String(loop.cause)).toContain(MemoryRelocationError.name);
          expect(String(loop.cause)).toContain('loop');
        }
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('uses the canonical user slug and isolates storage accounts that share a URI slug', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-memory-relocation-identities-'});
        const store = yield* ResourceStore;
        const mixedUserConfig = runtimeConfig(home, 'team alpha', 'Test User');
        const sluggedSource = 'threadnote://user/test-user/memories/durable/projects/threadnote/mixed-user.md';
        const sluggedTarget = 'threadnote://user/test-user/memories/durable/projects/threadnote/mixed-user-moved.md';
        const content = memoryContent('tn_mixed_user', 'Mixed user evidence.');
        const mixedLocation = {account: mixedUserConfig.account, home, user: mixedUserConfig.user};
        yield* store.write(mixedLocation, sluggedSource, content, {mode: 'create'});
        yield* store.write(mixedLocation, sluggedTarget, content, {mode: 'create'});
        yield* recordMemoryRelocation(mixedUserConfig, {
          fromContent: content,
          fromUri: sluggedSource,
          toContent: content,
          toUri: sluggedTarget,
        });
        yield* store.remove(mixedLocation, sluggedSource);
        expect(yield* readMemoryWithRelocations(mixedUserConfig, sluggedSource)).toMatchObject({
          canonicalUri: sluggedTarget,
          content,
        });

        const lowerAccountConfig = runtimeConfig(home, 'team-alpha', 'Test User');
        yield* recordMemoryRelocation(lowerAccountConfig, {
          fromContent: content,
          fromUri: sluggedSource,
          toContent: content,
          toUri: 'threadnote://user/test-user/memories/durable/projects/threadnote/lower-account.md',
        });
        expect(yield* fs.exists(path.join(home, 'data', 'team alpha', 'user', 'test-user', 'private'))).toBe(true);
        expect(yield* fs.exists(path.join(home, 'data', 'team-alpha', 'user', 'test-user', 'private'))).toBe(true);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('rejects a receipt that would exceed the reader byte bound before recording the move', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture('oversized');
        const longPath = EffectArray.join(
          Array.from({length: 72}, (_, index) => `${index}-${Effect2.pipe('x', EffectString.repeat(220))}`),
          '/',
        );
        const sourceUri = `threadnote://user/tester/memories/${longPath}/source.md`;
        const targetUri = `threadnote://user/tester/memories/${longPath}/target.md`;
        const content = memoryContent('tn_oversized_receipt', 'Oversized receipt evidence.');

        const recorded = yield* recordMemoryRelocation(fixture.config, {
          fromContent: content,
          fromUri: sourceUri,
          toContent: content,
          toUri: targetUri,
        }).pipe(Effect.exit);

        expect(Exit.isFailure(recorded)).toBe(true);
        if (Exit.isFailure(recorded)) expect(String(recorded.cause)).toContain('exceeds its size limit');
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );
});

const memoryUri = (index: number) =>
  `threadnote://user/tester/memories/durable/projects/threadnote/relocation-${index}.md`;

function memoryContent(memoryId: string, body: string): string {
  const metadata: MemoryMetadata = {
    kind: 'durable',
    memoryId,
    project: 'threadnote',
    sourceAgentClient: 'test',
    status: 'active',
    timestamp: '2026-08-30T00:00:00.000Z',
    topic: 'relocation',
    visibility: 'personal',
  };
  return formatMemoryDocument('MEMORY', metadata, body);
}

const makeFixture = Effect.fn('test.memoryRelocationFixture')(function* (name: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* fs.makeTempDirectoryScoped({prefix: `threadnote-memory-relocation-${name}-`});
  const config = runtimeConfig(home, 'local', 'tester', path);
  const store = yield* ResourceStore;
  return {
    config,
    location: {account: config.account, home, user: config.user},
    store,
  } as const;
});

function runtimeConfig(home: string, account: string, user: string, path?: Path.Path): RuntimeConfig {
  return {
    account,
    agentContextHome: home,
    agentId: 'threadnote',
    manifestPath: path ? path.join(home, 'seed-manifest.yaml') : `${home}/seed-manifest.yaml`,
    user,
  };
}
