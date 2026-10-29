import {Array as EffectArray} from 'effect';
import {expect, it as effectIt} from '@effect/vitest';
import {DateTime, Effect, FileSystem, Option, Path} from 'effect';
import {TestClock} from 'effect/testing';
import {ResourceStore, type ResourceStoreMutation} from '@threadnote/store/resource-store';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import {readMemoryRecordsByUri} from '@threadnote/threadnote/memory/index';
import {loadRecallIndex} from '@threadnote/recall/index';
import {prepareRecallSections} from '@threadnote/recall/runtime';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {provideTestLayer} from '../helpers/effect-layer.js';

const TARGET_IDENTIFIER = 'rankRecallCandidates';
const TARGET_URI = 'threadnote://user/tester/memories/durable/projects/threadnote/recall-ranker-code.md';

function memoryDocument(topic: string, body: string): string {
  return EffectArray.join(
    [
      'MEMORY',
      'kind: durable',
      'status: active',
      'project: threadnote',
      `topic: ${topic}`,
      'source_agent_client: test',
      'timestamp: 2026-08-20T00:00:00.000Z',
      '',
      body,
    ],
    '\n',
  );
}

effectIt.effect('recalls an exact camelCase identifier extracted from the canonical store', () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-recall-identifier-'});
      const manifestPath = path.join(home, 'seed-manifest.yaml');
      yield* fs.writeFileString(manifestPath, 'version: 1\nprojects: []\n');
      yield* TestClock.setTime(DateTime.toDateUtc(DateTime.makeUnsafe('2026-08-20T00:00:00.000Z')).getTime());
      const config: RuntimeConfig = {
        account: 'local',
        agentContextHome: home,
        agentId: 'threadnote',
        manifestPath,
        user: 'tester',
      };
      const store = yield* ResourceStore;
      const location = {account: config.account, home, user: config.user};
      const distractors: readonly ResourceStoreMutation[] = Array.from({length: 20}, (_, index) => ({
        content: memoryDocument(
          `code-behavior-${index}`,
          `Code behavior implementation defined recall candidate ${index}.`,
        ),
        options: {mode: 'create' as const},
        type: 'write' as const,
        uri: `threadnote://user/tester/memories/durable/projects/threadnote/code-behavior-${index}.md`,
      }));
      yield* store.mutate(location, [
        {
          content: memoryDocument(
            'recall-ranker-code',
            `The implementation defines candidate ranking behavior in ${TARGET_IDENTIFIER}.`,
          ),
          options: {mode: 'create'},
          type: 'write',
          uri: TARGET_URI,
        },
        ...distractors,
      ]);

      const indexed = yield* loadRecallIndex(config, {
        forceRefresh: true,
        includeInactive: false,
        query: `Where is ${TARGET_IDENTIFIER} behavior defined?`,
      });
      const target = Option.getOrUndefined(EffectArray.findFirst(indexed, candidate => candidate.uri === TARGET_URI));
      expect(target?.fields?.identifiers).toContain(TARGET_IDENTIFIER);

      const prepared = yield* prepareRecallSections(config, {
        allowExactRescue: true,
        exactMatches: [],
        feedbackQuery: `Where is ${TARGET_IDENTIFIER} behavior defined?`,
        includeInactive: false,
        limit: 12,
        passes: [],
        project: 'threadnote',
        query: `Where is ${TARGET_IDENTIFIER} behavior defined?`,
        readRecords: uris => readMemoryRecordsByUri(config, uris),
        semanticResult: Option.none(),
      });

      expect(prepared.confidence?.level).not.toBe('no_answer');
      expect(prepared.ranked[0]?.uri).toBe(TARGET_URI);
    }),
  ).pipe(provideTestLayer(ApplicationLayer)),
);
