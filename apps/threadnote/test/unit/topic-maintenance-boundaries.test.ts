import {it as effectIt} from '@effect/vitest';
import {describe, expect, it} from 'vitest';
import {Effect, FileSystem, Path} from 'effect';
import {TestClock} from 'effect/testing';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import {ResourceStore} from '@threadnote/store/resource-store';
import {createMemoryCodeCitation} from '@threadnote/memory/code/citation';
import {formatMemoryDocument, parseMemoryDocument} from '@threadnote/memory/document';
import {proposeTopicMaintenanceEnrollment} from '@threadnote/memory/topic-maintenance';
import {storeMemory} from '@threadnote/threadnote/memory/commands';
import {writeDurableMemory, writeMemoryContentWithExpectedHash} from '@threadnote/threadnote/mcp/server/memory';
import {stripPersonalProvenanceForSharedPublication} from '@threadnote/threadnote/share/core';
import {provideTestLayer} from '../helpers/effect-layer.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

const uri = 'threadnote://user/tester/memories/durable/projects/threadnote/topic.md';
const body = 'The code uses a retry limit.';
const citation = createMemoryCodeCitation({
  evidenceRetention: 'capsule-retained',
  extractorSet: 'native-code-graph-13',
  fileContentHash: {algorithm: 'sha256', value: Effect2.pipe('a', EffectString.repeat(64))},
  path: 'packages/memory/src/document.ts',
  repositoryId: Effect2.pipe('1', EffectString.repeat(64)),
  repositoryIdentityKind: 'remote',
  sourceCommit: Effect2.pipe('2', EffectString.repeat(40)),
  sourceDirty: false,
  sourceSnapshotId: `cgsn_${Effect2.pipe('4', EffectString.repeat(40))}`,
  target: {kind: 'file'},
  version: 1,
});

function enrolled() {
  const source = parseMemoryDocument(
    uri,
    formatMemoryDocument(
      'MEMORY',
      {
        codeCitations: [citation],
        kind: 'durable',
        memoryId: 'tn_boundary_topic',
        project: 'threadnote',
        schemaVersion: 8,
        sourceAgentClient: 'test',
        status: 'active',
        timestamp: '2026-10-16T00:00:00.000Z',
        topic: 'topic',
      },
      body,
    ),
  )!;
  return proposeTopicMaintenanceEnrollment(source, {
    paragraphs: [{role: 'descriptive', support: 'direct', citationIds: [citation.id]}],
  });
}

describe('topic maintenance generic write boundaries', () => {
  it('blocks generic sharing of enrolled topics', () => {
    const content = enrolled().content;
    for (const variant of [
      content,
      Effect2.pipe(content, EffectString.replace('topic_maintenance:', ' \n\t \ntopic_maintenance:')),
    ])
      expect(() => stripPersonalProvenanceForSharedPublication(variant)).toThrow(/reviewed existing-target/);
  });

  it('keeps an authored shared manifest valid only while accepted body and anchors survive', () => {
    const initial = enrolled();
    const sharedUri = Effect2.pipe(
      uri,
      EffectString.replace('/memories/durable/', '/memories/shared/default/durable/'),
    );
    const content = formatMemoryDocument('MEMORY', {...initial.metadata, visibility: 'shared'}, body);
    expect(parseMemoryDocument(sharedUri, content)?.metadata.topicMaintenance).toEqual(initial.manifest);
    expect(
      parseMemoryDocument(sharedUri, Effect2.pipe(content, EffectString.replace(body, `${body} Changed.`)))?.metadata
        .topicMaintenanceError,
    ).toBeDefined();
  });

  effectIt.effect('rejects CLI and MCP replacement that changes body or loses manifest', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-topic-boundary-'});
        const config = {
          account: 'local',
          agentContextHome: home,
          agentId: 'test',
          user: 'tester',
          manifestPath: path.join(home, 'manifest.json'),
        };
        const location = {account: config.account, home, user: config.user};
        const store = yield* ResourceStore;
        const initial = enrolled();
        yield* store.write(location, uri, initial.content, {mode: 'create'});

        const cli = yield* storeMemory(config, {
          bodyText: body,
          dryRun: false,
          metadata: {...initial.metadata, topicMaintenance: undefined},
          replaceUri: uri,
          title: 'MEMORY',
        }).pipe(Effect.exit);
        expect(String(cli)).toContain('Topic maintenance');
        expect(yield* store.read(location, uri)).toBe(initial.content);

        const mcp = yield* writeDurableMemory(config, {
          bodyText: `${body} Changed.`,
          metadata: initial.metadata,
          replaceUri: uri,
          deferRecallIndexRefresh: true,
        });
        expect(mcp.isError).toBe(true);
        expect(JSON.stringify(mcp)).toContain('Topic maintenance');
        expect(yield* store.read(location, uri)).toBe(initial.content);

        const dropped = yield* writeDurableMemory(config, {
          bodyText: body,
          metadata: {...initial.metadata, topicMaintenance: undefined},
          replaceUri: uri,
          deferRecallIndexRefresh: true,
        });
        expect(dropped.isError).toBe(true);
        expect(JSON.stringify(dropped)).toContain('Topic maintenance');
        expect(yield* store.read(location, uri)).toBe(initial.content);

        for (const invalid of [
          Effect2.pipe(initial.content, EffectString.replace(/^topic_maintenance:.*\n/mu, '')),
          Effect2.pipe(initial.content, EffectString.replace(body, `${body} Changed.`)),
        ]) {
          const result = yield* writeMemoryContentWithExpectedHash(
            config,
            'threadnote-native',
            uri,
            invalid,
            initial.content,
          );
          expect(result.isError).toBe(true);
          expect(yield* store.read(location, uri)).toBe(initial.content);
        }
        const metadataOnly = Effect2.pipe(
          initial.content,
          EffectString.replace('topic: topic', 'topic: topic\nowner: maintainer'),
        );
        const accepted = yield* writeMemoryContentWithExpectedHash(
          config,
          'threadnote-native',
          uri,
          metadataOnly,
          initial.content,
        );
        expect(accepted.isError).not.toBe(true);
        expect(parseMemoryDocument(uri, yield* store.read(location, uri))?.metadata.topicMaintenance).toEqual(
          initial.manifest,
        );

        const malformed = Effect2.pipe(
          metadataOnly,
          EffectString.replace(/^topic_maintenance:.*$/mu, 'topic_maintenance: {bad-json}'),
        );
        yield* store.write(location, uri, malformed, {mode: 'replace'});
        const repair = yield* writeMemoryContentWithExpectedHash(
          config,
          'threadnote-native',
          uri,
          metadataOnly,
          malformed,
        );
        expect(repair.isError).toBe(true);
        expect(yield* store.read(location, uri)).toBe(malformed);

        yield* store.write(location, uri, initial.content, {mode: 'replace'});
        const allowed = yield* storeMemory(config, {
          bodyText: body,
          dryRun: false,
          deferRecallIndexRefresh: true,
          metadata: {...initial.metadata, owner: 'maintainer'},
          replaceUri: uri,
          title: 'MEMORY',
        });
        expect(allowed).toBe(uri);
        const after = parseMemoryDocument(uri, yield* store.read(location, uri));
        expect(after?.metadata.owner).toBe('maintainer');
        expect(after?.metadata.topicMaintenance).toEqual(initial.manifest);
      }),
    ).pipe(TestClock.withLive, provideTestLayer(ApplicationLayer)),
  );
});
