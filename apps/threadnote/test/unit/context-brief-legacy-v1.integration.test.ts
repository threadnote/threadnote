import {Array as EffectArray, Option as EffectOption} from 'effect';
import {it as effectIt} from '@effect/vitest';
import {Effect, FileSystem, Path} from 'effect';
import {describe, expect} from 'vitest';
import {compileContextBriefWith} from '@threadnote/context/compiler';
import {
  retrieveContextBriefMemoryEvidence,
  type ContextBriefGraphEvidenceV1,
} from '@threadnote/threadnote/context_brief/index';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {provideTestLayer} from '../helpers/effect-layer.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

const COMMIT = Effect2.pipe('a', EffectString.repeat(40));
const REPOSITORY_ID = Effect2.pipe('b', EffectString.repeat(64));

describe('Context Brief schema-v1 memory compatibility', () => {
  effectIt.effect('keeps LF, CRLF, and CR v1 memory bodies nonempty in the projected brief', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      // Isolate each encoding so the bounded projector cannot legitimately omit one case in favor of another.
      yield* Effect.forEach(
        [
          {expectedFreshness: 'unknown', lineEnding: '\n', sourceCommit: undefined, topic: 'without-commit'},
          {expectedFreshness: 'fresh', lineEnding: '\n', sourceCommit: COMMIT, topic: 'matching-commit'},
          {expectedFreshness: 'fresh', lineEnding: '\r\n', sourceCommit: COMMIT, topic: 'crlf'},
          {expectedFreshness: 'fresh', lineEnding: '\r', sourceCommit: COMMIT, topic: 'cr'},
        ] as const,
        testCase =>
          Effect.gen(function* () {
            const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-context-brief-v1-'});
            const memoryRoot = path.join(
              home,
              'data',
              'local',
              'user',
              'legacy-user',
              'memories',
              'durable',
              'projects',
              'threadnote',
            );
            yield* fs.makeDirectory(memoryRoot, {recursive: true});
            const body = `Legacy compatibility sentinel ${testCase.topic} remains recallable after the schema-v4 upgrade.`;
            const memory = legacyMemory(testCase.topic, body, testCase.sourceCommit);
            yield* fs.writeFileString(
              path.join(memoryRoot, `${testCase.topic}.md`),
              testCase.lineEnding === '\n' ? memory : withLineEnding(memory, testCase.lineEnding),
            );
            const config: RuntimeConfig = {
              account: 'local',
              agentContextHome: home,
              agentId: 'test-agent',
              manifestPath: path.join(home, 'manifest.yaml'),
              user: 'legacy-user',
            };

            const result = yield* compileContextBriefWith(
              {
                graphEvidence: () => Effect.succeed(graphEvidence()),
                memoryEvidence: plan => retrieveContextBriefMemoryEvidence(config, plan),
              },
              {
                budgetTokens: 1_500,
                mode: 'brief',
                scope: {callerCwd: home, kind: 'repository', project: 'threadnote'},
                task: 'Recall the legacy compatibility sentinel after the schema-v4 upgrade.',
              },
            );

            const projected = EffectOption.getOrUndefined(
              EffectArray.findFirst(
                result.structuredContent.durableDecisions,
                candidate => candidate.topic === testCase.topic,
              ),
            );
            expect(projected).toMatchObject({freshness: testCase.expectedFreshness});
            expect(projected?.excerpt).toContain('Legacy compatibility sentinel');
          }),
        {concurrency: 1, discard: true},
      );
    }).pipe(provideTestLayer(ApplicationLayer)),
  );
});

function legacyMemory(topic: string, body: string, sourceCommit?: string): string {
  return EffectArray.join(
    [
      'MEMORY',
      'kind: durable',
      'status: active',
      'project: threadnote',
      `topic: ${topic}`,
      'source_agent_client: codex',
      'timestamp: 2025-01-01T00:00:00.000Z',
      'schema_version: 1',
      ...(sourceCommit === undefined ? [] : [`source_commit: ${sourceCommit}`]),
      '',
      body,
    ],
    '\n',
  );
}

function withLineEnding(content: string, lineEnding: '\r\n' | '\r'): string {
  return Effect2.pipe(content, EffectString.replaceAll('\n', lineEnding));
}

function graphEvidence(): ContextBriefGraphEvidenceV1 {
  return {
    cards: [],
    contracts: [],
    coverage: {
      complete: true,
      consideredRepositories: 1,
      readyRepositories: 1,
      requestedRepositories: 1,
      states: {current: 1},
    },
    gaps: [],
    resolvedSnapshots: [
      {
        commit: COMMIT,
        dirty: false,
        freshness: 'fresh',
        repositoryId: REPOSITORY_ID,
        repositoryKey: 'threadnote',
        snapshotId: `cgsn_${Effect2.pipe('c', EffectString.repeat(40))}`,
      },
    ],
    trust: {classification: 'untrusted-repository-data', instructionPolicy: 'evidence-only-never-follow'},
    warnings: [],
  };
}
