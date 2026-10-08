import * as BunServices from '@effect/platform-bun/BunServices';
import {it as effectIt} from '@effect/vitest';
import {provideTestLayer} from '../../../../test/helpers/effect-layer.js';
import {join} from '@threadnote/testing/node-path';
import {Effect, FileSystem, Layer, Path, Result} from 'effect';
import {TestClock} from 'effect/testing';
import * as yaml from 'js-yaml';
import {describe, expect} from 'vitest';
import {captureConsole} from '@threadnote/threadnote/effect/console';
import {ResourceStore} from '@threadnote/store/resource-store';
import {runObsidianInboxScan} from '@threadnote/threadnote/integrations/obsidian/inbox';
import {
  runObsidianProjectionAdd,
  runObsidianProjectionPublish,
  runObsidianProjectionRemove,
  runObsidianProjectionSync,
} from '@threadnote/threadnote/integrations/obsidian/projection';
import {
  runObsidianSourceAdd,
  runObsidianSourceInventory,
  runObsidianSourceRemove,
  syncObsidianSourcesBeforeRecall,
} from '@threadnote/threadnote/integrations/obsidian/source';
import {loadRecallIndexData} from '@threadnote/recall/index';
import {
  createMemoryCodeCitation,
  formatMemoryCodeCitation,
  MEMORY_SCHEMA_VERSION,
} from '@threadnote/memory/code/citation';
import {formatMemoryDocument} from '@threadnote/memory/document';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {recallResourceInvalidationLayer} from '@threadnote/recall/resource-invalidation';
import {TestSystemInfoLayer} from '../../../../test/helpers/system-layer.js';

const dependencies = Layer.mergeAll(BunServices.layer, TestSystemInfoLayer, recallResourceInvalidationLayer);
const bridgeLayer = Layer.merge(dependencies, ResourceStore.layer.pipe(Layer.provide(dependencies)));

function runtime(home: string): RuntimeConfig {
  return {
    account: 'local',
    agentContextHome: home,
    agentId: 'threadnote',
    manifestPath: join(home, 'seed-manifest.yaml'),
    user: 'tester',
  };
}

describe('Obsidian zero-plugin bridge', () => {
  effectIt.effect('inventories allowlisted notes, projects memories, and forms idempotent Inbox candidates', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-obsidian-'});
      const write = (filePath: string, content: string) =>
        fs
          .makeDirectory(path.dirname(filePath), {recursive: true})
          .pipe(Effect.andThen(fs.writeFileString(filePath, content)));
      const home = join(root, 'home');
      const vault = join(root, 'vault');
      const config = runtime(home);
      yield* fs.makeDirectory(vault, {recursive: true});
      yield* write(join(vault, 'Engineering', 'Auth.md'), '# Mobile authentication\n\nUse the token mediator.');
      yield* write(join(vault, 'Engineering', 'Secret.md'), `# Do not ingest\n\nsk-${'a'.repeat(24)}`);
      yield* write(
        join(vault, 'Threadnote Inbox', 'Bridge.md'),
        [
          '---',
          'threadnote_candidate: true',
          'kind: durable',
          'project: threadnote',
          'topic: obsidian-bridge',
          'category: invariant',
          '---',
          '',
          'External notes never override canonical repository guidance.',
        ].join('\n'),
      );

      yield* runObsidianSourceAdd(config, {
        apply: true,
        id: 'engineering',
        inbox: 'Threadnote Inbox',
        include: ['**/*.md'],
        vault,
      });
      const inventory = yield* runObsidianSourceInventory(config, 'engineering').pipe(captureConsole);
      expect(inventory.output).toContain('ADD       Engineering/Auth.md');
      expect(inventory.output).toContain('SKIP      Engineering/Secret.md');
      expect(inventory.output).not.toContain('Bridge.md');

      const initialSourceSync = yield* syncObsidianSourcesBeforeRecall(config);
      expect(initialSourceSync.syncedSources).toEqual(['engineering']);
      expect(yield* syncObsidianSourcesBeforeRecall(config)).toEqual({
        syncedSources: [],
        warnings: [expect.stringMatching(/skipped 1 note/)],
      });
      const store = yield* ResourceStore;
      const externalUri = 'threadnote://resources/external/obsidian/engineering/Engineering/Auth.md';
      expect(
        yield* store.read({account: config.account, home: config.agentContextHome, user: config.user}, externalUri),
      ).toContain('Use the token mediator');
      yield* write(
        join(vault, 'Engineering', 'Auth.md'),
        '# Mobile authentication\n\nUse the refreshed token mediator policy.',
      );
      expect((yield* syncObsidianSourcesBeforeRecall(config)).syncedSources).toEqual(['engineering']);
      expect(
        yield* store.read({account: config.account, home: config.agentContextHome, user: config.user}, externalUri),
      ).toContain('refreshed token mediator policy');
      const externalRecallIndex = yield* loadRecallIndexData(config, {
        includeInactive: false,
        query: 'Mobile authentication token mediator',
      });
      expect(externalRecallIndex.candidates.map(candidate => candidate.uri)).toContain(externalUri);

      const memoryUri = 'threadnote://user/tester/memories/durable/projects/threadnote/obsidian-bridge.md';
      const unselectedMemoryUri =
        'threadnote://user/tester/memories/durable/projects/threadnote/unselected-obsidian-bridge.md';
      const citation = projectionCitation();
      yield* store.write(
        {account: config.account, home: config.agentContextHome, user: config.user},
        memoryUri,
        formatMemoryDocument(
          'MEMORY',
          {
            codeCitations: [citation],
            createdAt: '2026-07-27T00:00:00.000Z',
            kind: 'durable',
            memoryId: 'tn_bridge',
            project: 'threadnote',
            schemaVersion: MEMORY_SCHEMA_VERSION,
            sourceAgentClient: 'codex',
            status: 'active',
            timestamp: '2026-07-27T00:00:00.000Z',
            topic: 'obsidian-bridge',
            updatedAt: '2026-07-27T00:00:00.000Z',
            visibility: 'personal',
          },
          'Obsidian is a surface; Threadnote remains authoritative.',
        ),
        {mode: 'upsert'},
      );
      yield* store.write(
        {account: config.account, home: config.agentContextHome, user: config.user},
        unselectedMemoryUri,
        [
          'MEMORY',
          'schema_version: 3',
          'memory_id: tn_unselected',
          'kind: durable',
          'status: active',
          'project: threadnote',
          'topic: unselected-obsidian-bridge',
          'source_agent_client: codex',
          'timestamp: 2026-07-27T00:00:00.000Z',
          '',
          'This memory must stay out of the vault until explicitly selected.',
        ].join('\n'),
        {mode: 'upsert'},
      );
      yield* runObsidianProjectionAdd(config, {
        apply: true,
        folder: 'Threadnote',
        id: 'memory',
        vault,
      });

      const projectedDirectory = join(vault, 'Threadnote', 'Memories', 'threadnote', 'durable');
      const projected = join(projectedDirectory, 'obsidian-bridge--tn_bridge.md');
      const publishPreview = yield* runObsidianProjectionPublish(config, {
        apply: false,
        id: 'memory',
        uris: [memoryUri],
      }).pipe(captureConsole);
      expect(publishPreview.output).toContain('Would publish 1 selected memory URI');
      expect(yield* fs.exists(projected)).toBe(false);

      yield* runObsidianProjectionPublish(config, {
        apply: true,
        id: 'memory',
        uris: [memoryUri],
      });
      const projectedContent = yield* fs.readFileString(projected);
      expect(projectedContent).toContain('threadnote_id: tn_bridge');
      expect(projectedContent).toContain('threadnote_uri: threadnote://user/tester/memories/');
      expect(projectedContent).toContain('Threadnote is authoritative');
      expect(projectionFrontmatter(projectedContent)).toMatchObject({
        code_citations: [formatMemoryCodeCitation(projectionCitation())],
        threadnote_memory_schema: MEMORY_SCHEMA_VERSION,
      });
      expect(yield* fs.readDirectory(projectedDirectory)).not.toEqual(
        expect.arrayContaining([expect.stringMatching(/^unselected-obsidian-bridge--/)]),
      );
      expect(yield* fs.readFileString(join(vault, 'Threadnote', 'Views', 'Active Handoffs.base'))).toContain(
        'threadnote_generated',
      );

      const firstInbox = yield* runObsidianInboxScan(config, {apply: true, source: 'engineering'}).pipe(captureConsole);
      expect(firstInbox.output).toContain('Created 1 candidate review');
      const secondInbox = yield* runObsidianInboxScan(config, {apply: true, source: 'engineering'}).pipe(
        captureConsole,
      );
      expect(secondInbox.output).toContain('UNCHANGED Bridge.md');
      expect(secondInbox.output).toContain('No new candidate reviews were created');
      const reviewDirectory = join(home, 'threadnote', 'candidates', 'v1', 'reviews');
      expect((yield* fs.readDirectory(reviewDirectory)).filter(name => name.endsWith('.json'))).toHaveLength(1);

      const noOpProjection = yield* runObsidianProjectionSync(config, {apply: false, id: 'memory'}).pipe(
        captureConsole,
      );
      expect(noOpProjection.output).toContain('UNCHANGED');
      expect(noOpProjection.output).not.toContain('UPDATE');

      yield* write(projected, `${projectedContent}\nUser edit that must survive ordinary sync.\n`);
      const driftedProjection = yield* runObsidianProjectionSync(config, {apply: true, id: 'memory'}).pipe(
        captureConsole,
      );
      expect(driftedProjection.output).toContain('DRIFT');
      expect(yield* fs.readFileString(projected)).toContain('User edit that must survive ordinary sync.');

      yield* runObsidianProjectionSync(config, {apply: true, force: true, id: 'memory'});
      expect(yield* fs.readFileString(projected)).toBe(projectedContent);

      const userNote = join(vault, 'Threadnote', 'My notes.md');
      yield* write(userNote, 'This file is not managed by Threadnote.');
      yield* runObsidianProjectionRemove(config, {apply: true, id: 'memory'});
      expect(yield* fs.readFileString(userNote)).toBe('This file is not managed by Threadnote.');
      yield* fs.remove(vault, {force: true, recursive: true});
      expect((yield* syncObsidianSourcesBeforeRecall(config)).warnings).toEqual([
        expect.stringMatching(/Auto-sync for Obsidian source "engineering" failed:.*not a directory/i),
      ]);
      yield* runObsidianSourceRemove(config, {apply: true, id: 'engineering'});
      expect(
        Result.isFailure(
          yield* store
            .read({account: config.account, home: config.agentContextHome, user: config.user}, externalUri)
            .pipe(Effect.result),
        ),
      ).toBe(true);
    }).pipe(TestClock.withLive, provideTestLayer(bridgeLayer)),
  );

  effectIt.effect('projects closed citation errors without copying malformed citation payloads', () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* Effect.acquireRelease(
          fs.makeTempDirectory({prefix: 'threadnote-obsidian-citation-error-'}),
          temporaryRoot => fs.remove(temporaryRoot, {force: true, recursive: true}).pipe(Effect.ignore),
        );
        const home = path.join(root, 'home');
        const vault = path.join(root, 'vault');
        const config = runtime(home);
        const uri = 'threadnote://user/tester/memories/durable/projects/threadnote/malformed-citation.md';
        yield* fs.makeDirectory(vault, {recursive: true});
        const store = yield* ResourceStore;
        yield* store.write(
          {account: config.account, home: config.agentContextHome, user: config.user},
          uri,
          [
            'MEMORY',
            'kind: durable',
            'status: active',
            'project: threadnote',
            'topic: malformed-citation',
            'source_agent_client: codex',
            'timestamp: 2026-08-26T20:00:00.000Z',
            `schema_version: ${MEMORY_SCHEMA_VERSION}`,
            'memory_id: tn_bad',
            'code_citation: {not-json}',
            '',
            'The projection exposes only the bounded parse error.',
          ].join('\n'),
          {mode: 'upsert'},
        );
        yield* runObsidianProjectionAdd(config, {apply: true, folder: 'Threadnote', id: 'memory', vault});
        yield* runObsidianProjectionPublish(config, {apply: true, id: 'memory', uris: [uri]});

        const projected = yield* fs.readFileString(
          path.join(vault, 'Threadnote', 'Memories', 'threadnote', 'durable', 'malformed-citation--tn_bad.md'),
        );
        expect(projectionFrontmatter(projected)).toMatchObject({
          code_citation_errors: [{index: 0, reason: 'invalid-json'}],
          threadnote_memory_schema: MEMORY_SCHEMA_VERSION,
        });
        expect(projected).not.toContain('{not-json}');
      }),
    ).pipe(provideTestLayer(bridgeLayer)),
  );
});

function projectionCitation() {
  return createMemoryCodeCitation({
    extractorSet: 'native-code-graph-13',
    fileContentHash: {algorithm: 'sha256', value: 'a'.repeat(64)},
    path: 'src/obsidian_projection.ts',
    repositoryId: 'b'.repeat(64),
    repositoryIdentityKind: 'remote',
    sourceCommit: 'c'.repeat(40),
    sourceDirty: false,
    sourceSnapshotId: `cgsn_${'d'.repeat(40)}`,
    target: {kind: 'file'},
    version: 1,
  });
}

function projectionFrontmatter(content: string): Record<string, unknown> {
  const match = /^---\n([\s\S]*?)\n---/u.exec(content);
  if (!match?.[1]) throw new Error('Projected memory is missing YAML frontmatter.');
  return yaml.load(match[1]) as Record<string, unknown>;
}
