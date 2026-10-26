import {Database} from 'bun:sqlite';
import {it as effectIt} from '@effect/vitest';
import {Effect, FileSystem, Path} from 'effect';
import {describe, expect} from 'vitest';
import {ResourceStore} from '@threadnote/store/resource-store';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import {memoryIdentityAlias} from '@threadnote/memory/identity-alias';
import {readMemoryWithRelocations, recordMemoryRelocation} from '@threadnote/memory/relocation';
import {loadRecallIndex, recallIndexDatabaseFilename} from '@threadnote/recall/index';
import {resolveMemoryIdentityAliases, verifyResolvedMemoryIdentity} from '@threadnote/recall/memory/identity';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {provideTestLayer} from '../helpers/effect-layer.js';

describe('stable memory identity resolution', () => {
  effectIt.effect('resolves only one active identity inside an explicit authorized scope', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-memory-identity-'});
      const manifestPath = path.join(home, 'seed-manifest.yaml');
      const config: RuntimeConfig = {
        account: 'local',
        agentContextHome: home,
        agentId: 'threadnote',
        manifestPath,
        user: 'me',
      };
      yield* fs.writeFileString(manifestPath, 'version: 1\nprojects: []\n');
      const root = path.join(home, 'data', 'local', 'user', 'me', 'memories', 'durable', 'projects', 'threadnote');
      yield* fs.makeDirectory(root, {recursive: true});
      yield* fs.writeFileString(
        path.join(root, 'active.md'),
        memory('tn_active_identity', 'active', 'Active evidence.'),
      );
      yield* fs.writeFileString(
        path.join(root, 'inactive.md'),
        memory('tn_inactive_identity', 'archived', 'Inactive evidence.'),
      );
      yield* fs.writeFileString(
        path.join(root, 'conflict-a.md'),
        memory('tn_conflicted_identity', 'active', 'First evidence.'),
      );
      yield* fs.writeFileString(
        path.join(root, 'conflict-b.md'),
        memory('tn_conflicted_identity', 'active', 'Divergent evidence.'),
      );
      yield* loadRecallIndex(config, {forceRefresh: true, includeInactive: false});
      const queryPlan = yield* Effect.sync(() => {
        const database = new Database(path.join(home, 'indexes', 'lexical', recallIndexDatabaseFilename(false)));
        try {
          return database
            .query<{readonly detail: string}, []>(
              `
              EXPLAIN QUERY PLAN
              SELECT d.id, d.uri, d.candidate_json
              FROM documents AS d
              WHERE d.uri >= 'threadnote://user/me/memories/'
                AND d.uri < 'threadnote://user/me/memories0'
                AND json_extract(d.candidate_json, '$.memoryId') IN ('tn_active_identity')
              ORDER BY d.uri
            `,
            )
            .all()
            .map(row => row.detail)
            .join('\n');
        } finally {
          database.close();
        }
      });
      expect(queryPlan).toContain('documents_memory_identity');

      const authorizedRoot = 'threadnote://user/me/memories';
      const [resolved] = yield* resolveMemoryIdentityAliases(
        config,
        [memoryIdentityAlias('tn_active_identity')],
        [authorizedRoot],
      );
      expect(resolved).toMatchObject({
        canonicalUri: 'threadnote://user/me/memories/durable/projects/threadnote/active.md',
        expectedMemoryId: 'tn_active_identity',
        requestedUri: memoryIdentityAlias('tn_active_identity'),
      });

      const inactive = yield* Effect.flip(
        resolveMemoryIdentityAliases(config, [memoryIdentityAlias('tn_inactive_identity')], [authorizedRoot]),
      );
      expect(inactive).toMatchObject({reason: 'not-found'});

      const outsideScope = yield* Effect.flip(
        resolveMemoryIdentityAliases(
          config,
          [memoryIdentityAlias('tn_active_identity')],
          ['threadnote://user/me/memories/shared/other-team'],
        ),
      );
      expect(outsideScope).toMatchObject({reason: 'not-found'});

      const conflicted = yield* Effect.flip(
        resolveMemoryIdentityAliases(config, [memoryIdentityAlias('tn_conflicted_identity')], [authorizedRoot]),
      );
      expect(conflicted).toMatchObject({reason: 'ambiguous'});

      const unscoped = yield* Effect.flip(
        resolveMemoryIdentityAliases(config, [memoryIdentityAlias('tn_active_identity')], []),
      );
      expect(unscoped).toMatchObject({reason: 'scope-required'});
    }).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('keeps retained-scope identity reads current across homes, accounts and users', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const store = yield* ResourceStore;
      const firstHome = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-identity-first-'});
      const secondHome = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-identity-second-'});
      const configs = [
        {agentContextHome: firstHome, account: 'first', user: 'me'},
        {agentContextHome: firstHome, account: 'second', user: 'me'},
        {agentContextHome: secondHome, account: 'first', user: 'other'},
      ].map(config => ({
        ...config,
        agentId: 'threadnote',
        manifestPath: path.join(config.agentContextHome, 'manifest.yaml'),
      }));
      for (const home of [firstHome, secondHome])
        yield* fs.writeFileString(path.join(home, 'manifest.yaml'), 'version: 1\nprojects: []\n');
      const uris = configs.map(
        (config, index) => `threadnote://user/${config.user}/memories/durable/projects/threadnote/target-${index}.md`,
      );
      for (const [index, config] of configs.entries())
        yield* store.write(
          {home: config.agentContextHome, account: config.account, user: config.user},
          uris[index],
          memory('tn_same_id', 'active', `Current corpus ${index}.`),
          {mode: 'create'},
        );
      for (const index of [0, 1, 2, 0, 1]) {
        const config = configs[index];
        const scopes = [
          ...Array.from(
            {length: 200},
            (_, ordinal) => `threadnote://user/${config.user}/memories/durable/retained-${ordinal}.md`,
          ),
          uris[index],
        ];
        const [resolved] = yield* resolveMemoryIdentityAliases(config, [memoryIdentityAlias('tn_same_id')], scopes);
        expect(resolved).toMatchObject({canonicalUri: uris[index], expectedMemoryId: 'tn_same_id'});
        const content = yield* store.read(
          {home: config.agentContextHome, account: config.account, user: config.user},
          resolved.canonicalUri,
        );
        yield* verifyResolvedMemoryIdentity(resolved, resolved.canonicalUri, content);
        expect(content).toContain(`Current corpus ${index}.`);
      }
      const config = configs[0];
      const location = {home: config.agentContextHome, account: config.account, user: config.user};
      const conflictUri = uris[0].replace('target-0.md', 'conflict.md');
      const scopes = [
        ...Array.from({length: 200}, (_, index) => `threadnote://user/me/memories/durable/retained-${index}.md`),
        uris[0],
        conflictUri,
      ];
      yield* store.write(location, conflictUri, memory('tn_same_id', 'active', 'New conflicting identity.'), {
        mode: 'create',
      });
      for (const options of [{}, {validateNow: true}]) {
        const conflict = yield* Effect.flip(
          resolveMemoryIdentityAliases(config, [memoryIdentityAlias('tn_same_id')], scopes, options),
        );
        expect(conflict).toMatchObject({reason: 'ambiguous'});
      }
      yield* store.remove(location, conflictUri);
      const [restored] = yield* resolveMemoryIdentityAliases(config, [memoryIdentityAlias('tn_same_id')], scopes);
      expect(restored.canonicalUri).toBe(uris[0]);
    }).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('uses one private relocation receipt to recover an active id-less destination', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const store = yield* ResourceStore;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-memory-identity-relocation-'});
        const config: RuntimeConfig = {
          account: 'local',
          agentContextHome: home,
          agentId: 'threadnote',
          manifestPath: path.join(home, 'seed-manifest.yaml'),
          user: 'me',
        };
        yield* fs.writeFileString(config.manifestPath, 'version: 1\nprojects: []\n');
        const location = {account: config.account, home, user: config.user};
        const sourceUri = 'threadnote://user/me/memories/durable/projects/threadnote/source.md';
        const targetUri = 'threadnote://user/me/memories/shared/default/durable/projects/threadnote/destination.md';
        const original = memory('tn_receipt_identity', 'active', 'Receipt identity evidence.');
        const missingIdentity = original.replace('memory_id: tn_receipt_identity\n', '');
        yield* store.write(location, sourceUri, original, {mode: 'create'});
        yield* store.write(location, targetUri, original, {mode: 'create'});
        yield* recordMemoryRelocation(config, {
          fromContent: original,
          fromUri: sourceUri,
          toContent: original,
          toUri: targetUri,
        });
        yield* store.remove(location, sourceUri);
        yield* store.write(location, targetUri, missingIdentity, {mode: 'upsert'});
        yield* loadRecallIndex(config, {forceRefresh: true, includeInactive: false});

        const alias = memoryIdentityAlias('tn_receipt_identity');
        const [resolved] = yield* resolveMemoryIdentityAliases(config, [alias], ['threadnote://user/me/memories']);
        expect(resolved).toMatchObject({
          canonicalUri: targetUri,
          identityWitness: 'private-relocation-receipt',
          requestedUri: alias,
        });
        if (resolved === undefined) {
          return yield* Effect.die(new Error('Expected a relocation-witnessed identity.'));
        }
        const live = yield* readMemoryWithRelocations(config, targetUri);
        yield* verifyResolvedMemoryIdentity(resolved, live.canonicalUri, live.content);

        const outsideScope = yield* Effect.flip(
          resolveMemoryIdentityAliases(config, [alias], ['threadnote://user/me/memories/shared/other-team']),
        );
        expect(outsideScope).toMatchObject({reason: 'not-found'});

        const secondSourceUri = 'threadnote://user/me/memories/durable/projects/threadnote/source-two.md';
        const secondTargetUri =
          'threadnote://user/me/memories/shared/default/durable/projects/threadnote/destination-two.md';
        yield* store.write(location, secondSourceUri, original, {mode: 'create'});
        yield* store.write(location, secondTargetUri, original, {mode: 'create'});
        yield* recordMemoryRelocation(config, {
          fromContent: original,
          fromUri: secondSourceUri,
          toContent: original,
          toUri: secondTargetUri,
        });
        yield* store.remove(location, secondSourceUri);
        yield* store.write(location, secondTargetUri, missingIdentity, {mode: 'upsert'});
        const ambiguous = yield* Effect.flip(
          resolveMemoryIdentityAliases(config, [alias], ['threadnote://user/me/memories'], {validateNow: true}),
        );
        expect(ambiguous).toMatchObject({reason: 'ambiguous'});
        yield* store.remove(location, secondTargetUri);

        yield* store.write(location, targetUri, memory('tn_other_identity', 'active', 'Other evidence.'), {
          mode: 'upsert',
        });
        const mismatch = yield* Effect.flip(
          resolveMemoryIdentityAliases(config, [alias], ['threadnote://user/me/memories'], {validateNow: true}),
        );
        expect(mismatch).toMatchObject({reason: 'ambiguous'});
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('rejects two receipt identities that claim the same id-less destination', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const store = yield* ResourceStore;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-memory-identity-conflict-'});
        const config: RuntimeConfig = {
          account: 'local',
          agentContextHome: home,
          agentId: 'threadnote',
          manifestPath: path.join(home, 'seed-manifest.yaml'),
          user: 'me',
        };
        yield* fs.writeFileString(config.manifestPath, 'version: 1\nprojects: []\n');
        const location = {account: config.account, home, user: config.user};
        const firstSourceUri = 'threadnote://user/me/memories/durable/projects/threadnote/first-source.md';
        const secondSourceUri = 'threadnote://user/me/memories/durable/projects/threadnote/second-source.md';
        const targetUri = 'threadnote://user/me/memories/shared/default/durable/projects/threadnote/destination.md';
        const first = memory('tn_first_receipt', 'active', 'First receipt evidence.');
        const second = memory('tn_second_receipt', 'active', 'Second receipt evidence.');
        yield* store.write(location, firstSourceUri, first, {mode: 'create'});
        yield* store.write(location, secondSourceUri, second, {mode: 'create'});
        yield* store.write(location, targetUri, first, {mode: 'create'});
        yield* recordMemoryRelocation(config, {
          fromContent: first,
          fromUri: firstSourceUri,
          toContent: first,
          toUri: targetUri,
        });
        yield* store.write(location, targetUri, second, {mode: 'upsert'});
        yield* recordMemoryRelocation(config, {
          fromContent: second,
          fromUri: secondSourceUri,
          toContent: second,
          toUri: targetUri,
        });
        yield* store.remove(location, firstSourceUri);
        yield* store.remove(location, secondSourceUri);
        yield* store.write(location, targetUri, first.replace('memory_id: tn_first_receipt\n', ''), {
          mode: 'upsert',
        });
        yield* loadRecallIndex(config, {forceRefresh: true, includeInactive: false});

        const conflicted = yield* Effect.flip(
          resolveMemoryIdentityAliases(
            config,
            [memoryIdentityAlias('tn_first_receipt')],
            ['threadnote://user/me/memories'],
          ),
        );
        expect(conflicted).toMatchObject({reason: 'ambiguous'});
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('does not scan unrelated receipt history for an indexed active identity', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-memory-identity-indexed-'});
        const manifestPath = path.join(home, 'seed-manifest.yaml');
        const config: RuntimeConfig = {
          account: 'local',
          agentContextHome: home,
          agentId: 'threadnote',
          manifestPath,
          user: 'me',
        };
        yield* fs.writeFileString(manifestPath, 'version: 1\nprojects: []\n');
        const root = path.join(home, 'data', 'local', 'user', 'me', 'memories', 'durable', 'projects', 'threadnote');
        yield* fs.makeDirectory(root, {recursive: true});
        yield* fs.writeFileString(path.join(root, 'active.md'), memory('tn_indexed_identity', 'active', 'Indexed.'));
        yield* loadRecallIndex(config, {forceRefresh: true, includeInactive: false});

        const receiptRoot = path.join(home, 'data', 'local', 'user', 'me', 'private', 'memory-relocations', 'v1');
        yield* fs.makeDirectory(receiptRoot, {recursive: true, mode: 0o700});
        yield* Effect.forEach(
          Array.from({length: 1_025}, (_, index) =>
            path.join(receiptRoot, `${index.toString().padStart(4, '0')}.json`),
          ),
          target => fs.writeFileString(target, '{}', {mode: 0o600}),
          {concurrency: 32, discard: true},
        );

        const [resolved] = yield* resolveMemoryIdentityAliases(
          config,
          [memoryIdentityAlias('tn_indexed_identity')],
          ['threadnote://user/me/memories'],
        );
        expect(resolved).toMatchObject({
          canonicalUri: 'threadnote://user/me/memories/durable/projects/threadnote/active.md',
          expectedMemoryId: 'tn_indexed_identity',
        });
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );
});

function memory(memoryId: string, status: 'active' | 'archived', body: string): string {
  return [
    'MEMORY',
    'kind: durable',
    `status: ${status}`,
    'project: threadnote',
    `topic: ${memoryId}`,
    `memory_id: ${memoryId}`,
    'source_agent_client: test',
    'timestamp: 2026-08-31T00:00:00.000Z',
    '',
    body,
  ].join('\n');
}
