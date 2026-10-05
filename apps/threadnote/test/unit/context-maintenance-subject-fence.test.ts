import {it as effectIt} from '@effect/vitest';
import {Effect, FileSystem, Path, Schema} from 'effect';
import {TestClock} from 'effect/testing';
import {describe, expect} from 'vitest';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import {CodeGraphIndexer} from '@threadnote/graph/indexer';
import {CodeGraphQueryService} from '@threadnote/graph/query';
import {captureMemoryCodeCitations} from '@threadnote/context/citation/capture';
import {createMemoryCodeCitation} from '@threadnote/memory/code/citation';
import {formatMemoryDocument, parseMemoryDocument} from '@threadnote/memory/document';
import {runCommandEffect} from '@threadnote/platform/command';
import {ResourceStore} from '@threadnote/store/resource-store';
import {runContextMaintenance} from '@threadnote/threadnote/memory/context/maintenance';
import {
  collectMaintenanceWorkerBatch,
  mergeMaintenanceWorkerEvidence,
  maintenanceWorkerBatchCurrent,
} from '../../src/memory/context/maintenance_batch.js';
import {provideTestLayer} from '../helpers/effect-layer.js';

function fixture(reverse = false) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = yield* fs.makeTempDirectoryScoped({prefix: 'maintenance-subject-fence-'});
    const repositoryPath = path.join(home, 'repository');
    yield* fs.makeDirectory(repositoryPath);
    const repository = yield* fs.realPath(repositoryPath);
    yield* fs.writeFileString(path.join(repository, 'source.ts'), 'export const supported = true;\n');
    const git = (args: readonly string[]) => runCommandEffect('git', ['-C', repository, ...args]);
    yield* git(['init', '--quiet']);
    yield* git(['add', '.']);
    yield* git(['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--quiet', '-m', 'fixture']);
    const config = {
      account: 'local',
      agentContextHome: home,
      agentId: 'test',
      manifestPath: path.join(home, 'manifest.yaml'),
      user: 'tester',
    };
    yield* fs.writeFileString(
      config.manifestPath,
      `version: 1\nprojects:\n  - name: fixture\n    path: ${JSON.stringify(repository)}\n    uri: threadnote://resources/repos/fixture\n    seed: []\n`,
    );
    yield* (yield* CodeGraphIndexer).index({cwd: repository, threadnoteHome: home, ensureVectors: false});
    const [current] = yield* captureMemoryCodeCitations(config, {
      callerCwd: repository,
      project: 'fixture',
      refs: ['source.ts'],
    });
    const {id: _id, ...input} = current;
    const unavailable = createMemoryCodeCitation({
      ...input,
      repositoryId: 'f'.repeat(64),
      sourceCommit: 'e'.repeat(40),
    });
    const citations = reverse ? [unavailable, current] : [current, unavailable];
    const uri = 'threadnote://user/tester/memories/durable/projects/fixture/source.md';
    const content = formatMemoryDocument(
      'MEMORY',
      {
        schemaVersion: 5,
        memoryId: 'tn_source',
        kind: 'durable',
        status: 'active',
        project: 'fixture',
        topic: 'source',
        sourceAgentClient: 'test',
        timestamp: '2026-10-03T15:00:00.000Z',
        codeCitations: citations,
      },
      'Synthetic source claim.',
    );
    const store = yield* ResourceStore;
    const location = {account: 'local', home, user: 'tester'};
    yield* store.write(location, uri, content, {mode: 'create'});
    const unrelatedUri = 'threadnote://user/tester/memories/handoffs/active/other/unrelated.md';
    const unrelatedContent = formatMemoryDocument(
      'HANDOFF',
      {
        schemaVersion: 2,
        memoryId: 'tn_unrelated',
        kind: 'handoff',
        status: 'active',
        project: 'other',
        topic: 'unrelated',
        sourceAgentClient: 'test',
        timestamp: '2026-10-03T15:00:00.000Z',
      },
      'Independent handoff.',
    );
    return {config, repository, content, uri, citations, store, location, unrelatedUri, unrelatedContent};
  });
}

function exercise(phase: number, mutateSelected: boolean, reverse = false) {
  return Effect.gen(function* () {
    const {config, repository, content, uri, citations, store, location, unrelatedUri, unrelatedContent} =
      yield* fixture(reverse);
    const query = yield* CodeGraphQueryService;
    let calls = 0;
    const racing = CodeGraphQueryService.of({
      ...query,
      status: (threadnoteHome, cwd, options) =>
        Effect.gen(function* () {
          if (++calls === phase)
            yield* store.write(
              location,
              mutateSelected ? uri : unrelatedUri,
              mutateSelected ? `${content}\nChanged canonical claim.` : unrelatedContent,
              {mode: mutateSelected ? 'upsert' : 'create'},
            );
          return yield* query.status(threadnoteHome, cwd, options);
        }),
    });
    const status = yield* runContextMaintenance(config, {cwd: repository, project: 'fixture', maxRecords: 1}).pipe(
      Effect.provideService(CodeGraphQueryService, racing),
    );
    expect(calls).toBeGreaterThanOrEqual(phase);
    const progress = status.projects.find(project => project.project === 'fixture')!;
    expect(progress.checked).toBe(mutateSelected ? 0 : 1);
    const selected = yield* store.read(location, uri);
    expect(parseMemoryDocument(uri, selected)?.metadata.codeCitations).toEqual(citations);
    if (!mutateSelected) {
      expect(progress.checkedCitations).toBe(1);
      expect(selected).toBe(content);
      expect(yield* store.read(location, unrelatedUri)).toBe(unrelatedContent);
    }
  }).pipe(TestClock.withLive, provideTestLayer(ApplicationLayer));
}

describe('canonical subject fences for citation maintenance', () => {
  effectIt.effect(
    'survives an unrelated native write between complete selector partitions and rejects a later subject edit',
    () =>
      Effect.gen(function* () {
        const data = yield* fixture();
        const record = parseMemoryDocument(data.uri, data.content)!;
        const task = {record, project: 'fixture', chunk: 0, key: 'tn_source:0'};
        const first = yield* collectMaintenanceWorkerBatch(
          data.config,
          [{...task, citationIds: [data.citations[0].id]}],
          data.repository,
        );
        yield* data.store.write(data.location, data.unrelatedUri, data.unrelatedContent, {mode: 'create'});
        const second = yield* collectMaintenanceWorkerBatch(
          data.config,
          [{...task, citationIds: [data.citations[1].id]}],
          data.repository,
        );
        expect(first.observation?.memoryGeneration).not.toBe(second.observation?.memoryGeneration);
        const together = mergeMaintenanceWorkerEvidence(first, second);
        expect(together.observation).toBeDefined();
        expect(yield* maintenanceWorkerBatchCurrent(data.config, together)).toBe(true);
        yield* data.store.write(data.location, data.uri, `${data.content}\nChanged selected claim.`, {mode: 'upsert'});
        expect(yield* maintenanceWorkerBatchCurrent(data.config, together)).toBe(false);
      }).pipe(TestClock.withLive, provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect(
    'preserves exact and unavailable work across unrelated writes in opening, closing and final phases',
    () => Effect.forEach([1, 2, 3], phase => exercise(phase, false), {discard: true}),
  );
  effectIt.effect.prop(
    'retains progress exactly when the selected canonical claim is unchanged under bounded writer and anchor permutations',
    {
      phase: Schema.Int.check(Schema.isBetween({minimum: 1, maximum: 3})),
      mutateSelected: Schema.Boolean,
      reverse: Schema.Boolean,
    },
    ({phase, mutateSelected, reverse}) => exercise(phase, mutateSelected, reverse),
    {timeout: 90_000, arbitrary: {runs: 6, seed: 80404}},
  );
});
