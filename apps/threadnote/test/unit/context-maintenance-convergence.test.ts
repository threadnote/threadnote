import {it as effectIt} from '@effect/vitest';
import {Effect, FileSystem, Path, Schema} from 'effect';
import {TestClock} from 'effect/testing';
import {describe, expect} from 'vitest';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import {
  runContextMaintenance,
  readContextMaintenanceStatus,
  setContextMaintenancePaused,
  undoContextMaintenance,
  type MaintenanceState,
} from '@threadnote/threadnote/memory/context/maintenance';
import {formatMemoryDocument, parseMemoryDocument, type MemoryMetadata} from '@threadnote/memory/document';
import {CodeGraphIndexer} from '@threadnote/graph/indexer';
import {captureMemoryCodeCitations} from '@threadnote/context/citation/capture';
import {runCommandEffect} from '@threadnote/platform/command';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {provideTestLayer} from '../helpers/effect-layer.js';

const PROJECT = 'convergence';
const NOW = '2026-10-03T15:00:00.000Z';
const uri = (topic: string, project = PROJECT) =>
  `threadnote://user/tester/memories/durable/projects/${project}/${topic}.md`;
function record(topic: string, metadata: Partial<MemoryMetadata> = {}, body = `Independent context for ${topic}.`) {
  return parseMemoryDocument(
    uri(topic, metadata.project),
    formatMemoryDocument(
      'MEMORY',
      {
        kind: 'durable',
        schemaVersion: 5,
        memoryId: `tn_convergence_${topic}`,
        project: PROJECT,
        sourceAgentClient: 'test',
        status: 'active',
        timestamp: NOW,
        topic,
        ...metadata,
      },
      body,
    ),
  )!;
}
function fixture() {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = yield* fs.makeTempDirectoryScoped({prefix: 'convergence-'});
    const directory = path.join(home, 'data', 'local', 'user', 'tester', 'memories', 'durable', 'projects', PROJECT);
    yield* fs.makeDirectory(directory, {recursive: true});
    const config: RuntimeConfig = {
      account: 'local',
      agentContextHome: home,
      agentId: 'test',
      manifestPath: path.join(home, 'manifest.yaml'),
      user: 'tester',
    };
    const write = (item: ReturnType<typeof record>) =>
      fs.writeFileString(path.join(directory, `${item.metadata.topic}.md`), item.content);
    const state = () =>
      fs
        .readFileString(path.join(home, 'context-maintenance', 'state-v2.json'))
        .pipe(Effect.map(text => JSON.parse(text) as MaintenanceState));
    return {fs, path, home, directory, config, write, state};
  });
}
function settle(f: Effect.Success<ReturnType<typeof fixture>>, cwd: string, batch: number, minimumCitations = 0) {
  return Effect.gen(function* () {
    for (let tick = 0; tick < 80; tick++) {
      const status = yield* runContextMaintenance(f.config, {cwd, project: PROJECT, maxRecords: batch});
      expect(status.state).not.toBe('failed');
      const progress = status.projects.find(item => item.project === PROJECT);
      if (
        status.preparation?.complete &&
        progress &&
        progress.checked === progress.eligible &&
        progress.checkedCitations >= minimumCitations
      )
        return status;
    }
    throw new Error('Finite static corpus did not complete within 80 successful ticks');
  });
}
const activeCases = (state: MaintenanceState) =>
  state.cases
    .filter(item => !['resolved', 'retired'].includes(item.disposition))
    .map(item => ({
      caseId: item.caseId,
      family: item.family,
      slot: item.slot,
      memoryId: item.memoryId,
      reason: item.reason,
      disposition: item.disposition,
    }))
    .sort((a, b) => a.caseId.localeCompare(b.caseId));

describe('whole-engine convergence', () => {
  // Real Git, parser workers and SQLite leases deliberately require live time.
  // ApplicationLayer is needed here because this is cross-domain graph/store/health composition.
  effectIt.effect.prop(
    'incremental source changes and anchor insertion/permutation equal clean recomputation without certifying unsupported prose',
    {
      batch: Schema.Int.check(Schema.isBetween({minimum: 1, maximum: 4})),
      reverse: Schema.Boolean,
      inserted: Schema.Int.check(Schema.isBetween({minimum: 1, maximum: 3})),
    },
    ({batch, reverse, inserted}) =>
      Effect.gen(function* () {
        const f = yield* fixture();
        const repository = f.path.join(f.home, 'repository');
        yield* f.fs.makeDirectory(repository);
        yield* f.fs.writeFileString(f.path.join(repository, 'claim.ts'), 'export const supported = true;\n');
        yield* f.fs.writeFileString(f.path.join(repository, 'independent.ts'), 'export const independent = true;\n');
        const git = (args: readonly string[]) => runCommandEffect('git', ['-C', repository, ...args]);
        yield* git(['init', '--quiet']);
        yield* git(['add', '.']);
        yield* git([
          '-c',
          'user.name=Test',
          '-c',
          'user.email=test@example.invalid',
          'commit',
          '--quiet',
          '-m',
          'fixture',
        ]);
        yield* f.fs.writeFileString(
          f.config.manifestPath,
          `version: 1\nprojects:\n  - name: ${PROJECT}\n    path: ${JSON.stringify(repository)}\n    uri: threadnote://resources/repos/${PROJECT}\n    seed: []\n`,
        );
        const indexer = yield* CodeGraphIndexer;
        yield* indexer.index({cwd: repository, threadnoteHome: f.home, ensureVectors: false});
        const citations = yield* captureMemoryCodeCitations(f.config, {
          callerCwd: repository,
          project: PROJECT,
          refs: ['claim.ts', 'independent.ts'],
        });
        expect(citations).toHaveLength(2);
        const source = record(
          'claim',
          {codeCitations: citations},
          'The supported flag is true. Preserve this independent body.',
        );
        yield* f.write(source);
        const initial = yield* settle(f, repository, batch, 2);
        expect(initial.projects[0].checkedCitations).toBe(2);
        expect(activeCases(yield* f.state())).toEqual([]);
        for (let index = 0; index < inserted; index++)
          yield* f.write(
            record(
              `inserted-${index}`,
              {kind: 'handoff', codeCitations: [citations[1]]},
              `Historical independent observation ${index}.`,
            ),
          );
        yield* f.write(record('claim', {codeCitations: reverse ? [...citations].reverse() : citations}, source.body));
        yield* runContextMaintenance(f.config, {cwd: repository, project: PROJECT, maxRecords: 1});
        yield* f.fs.writeFileString(f.path.join(repository, 'claim.ts'), 'export const supported = false;\n');
        yield* indexer.index({cwd: repository, threadnoteHome: f.home, ensureVectors: false});
        yield* settle(f, repository, batch);
        const maintained = yield* f.state();
        const changed = activeCases(maintained).filter(item => item.family === 'citation');
        expect(changed).toHaveLength(1);
        expect(changed[0].slot).toBe(`anchor:${citations.find(item => item.path === 'claim.ts')!.id}`);
        expect(
          changed.some(item => item.memoryId === source.metadata.memoryId && item.disposition === 'needs-decision'),
        ).toBe(true);
        expect(
          parseMemoryDocument(source.uri, yield* f.fs.readFileString(f.path.join(f.directory, 'claim.md')))!.body,
        ).toBe(source.body);
        const casesBefore = maintained.cases.length,
          receiptsBefore = maintained.receipts.length;
        yield* settle(f, repository, batch);
        const replay = yield* f.state();
        expect(activeCases(replay)).toEqual(activeCases(maintained));
        expect(replay.cases.length).toBe(casesBefore);
        expect(replay.receipts.length).toBe(receiptsBefore);
        // Recreate the same canonical corpus in a generated physical insertion order.
        // Case identity must survive both creation order and a different task batch size.
        const names = (yield* f.fs.readDirectory(f.directory)).sort();
        const documents = yield* Effect.forEach(names, name =>
          f.fs.readFileString(f.path.join(f.directory, name)).pipe(Effect.map(content => ({name, content}))),
        );
        for (const item of documents) yield* f.fs.remove(f.path.join(f.directory, item.name));
        for (const item of reverse ? [...documents].reverse() : documents)
          yield* f.fs.writeFileString(f.path.join(f.directory, item.name), item.content);
        yield* f.fs.remove(f.path.join(f.home, 'context-maintenance'), {recursive: true});
        yield* settle(f, repository, reverse ? 1 : 4);
        expect(activeCases(yield* f.state())).toEqual(activeCases(maintained));
      }).pipe(TestClock.withLive, provideTestLayer(ApplicationLayer)),
    {timeout: 120_000, arbitrary: {runs: 4, seed: 80801}},
  );

  effectIt.effect.prop(
    'interleaved permitted document updates and ticks converge to the independent link model, preserve other scopes, and reject stale undo',
    {
      updates: Schema.Array(Schema.Boolean).check(Schema.isMinLength(1), Schema.isMaxLength(5)),
      batch: Schema.Int.check(Schema.isBetween({minimum: 1, maximum: 4})),
    },
    ({updates, batch}) =>
      Effect.gen(function* () {
        const f = yield* fixture();
        const target = record('target');
        yield* f.write(target);
        const body = 'Untouched body section. Keep independent useful context.';
        const valid = {type: 'references' as const, uri: target.uri};
        const missing = {type: 'depends_on' as const, uri: uri('absent')};
        const source = () => record('source', {relations: [valid, missing]}, body);
        const unrelatedDirectory = f.path.join(f.directory, '..', 'other');
        yield* f.fs.makeDirectory(unrelatedDirectory);
        const unrelated = record('unrelated', {project: 'other'}, 'Other project exact bytes.');
        const unrelatedFile = f.path.join(unrelatedDirectory, 'unrelated.md');
        yield* f.fs.writeFileString(unrelatedFile, unrelated.content);
        const sharedDirectory = f.path.join(
          f.home,
          'data',
          'local',
          'user',
          'tester',
          'memories',
          'shared',
          'default',
          'durable',
          'projects',
          PROJECT,
        );
        yield* f.fs.makeDirectory(sharedDirectory, {recursive: true});
        const shared = record('shared', {relations: [missing]}, 'Shared canonical exact bytes.');
        const sharedFile = f.path.join(sharedDirectory, 'shared.md');
        yield* f.fs.writeFileString(sharedFile, shared.content);
        for (const interleave of updates) {
          yield* f.write(source());
          if (interleave) yield* runContextMaintenance(f.config, {cwd: f.home, project: PROJECT, maxRecords: batch});
        }
        yield* settle(f, f.home, batch);
        const canonical = parseMemoryDocument(
          uri('source'),
          yield* f.fs.readFileString(f.path.join(f.directory, 'source.md')),
        )!;
        // Independent model: only the provably absent personal dependency is removable.
        expect(canonical.metadata.relations).toEqual([valid]);
        expect(canonical.body).toBe(body);
        expect(yield* f.fs.readFileString(unrelatedFile)).toBe(unrelated.content);
        expect(yield* f.fs.readFileString(sharedFile)).toBe(shared.content);
        const before = yield* f.state();
        yield* settle(f, f.home, 4);
        const replay = yield* f.state();
        expect(replay.receipts.length).toBe(before.receipts.length);
        expect(activeCases(replay)).toEqual(activeCases(before));
        const receipt = before.receipts.find(item => item.subjectUri === uri('source'))!;
        expect(receipt).toBeDefined();
        yield* f.write(record('source', {relations: [valid]}, `${body}\nPermitted later edit.`));
        expect(yield* undoContextMaintenance(f.config, receipt.receiptId)).toMatchObject({
          status: 'conflict',
          reason: 'memory-changed',
        });
        yield* setContextMaintenancePaused(f.config, true);
        expect((yield* readContextMaintenanceStatus(f.config, PROJECT)).paused).toBe(true);
        yield* setContextMaintenancePaused(f.config, false);
        yield* settle(f, f.home, batch);
        const final = activeCases(yield* f.state());
        yield* f.fs.remove(f.path.join(f.home, 'context-maintenance'), {recursive: true});
        yield* settle(f, f.home, 4);
        expect(activeCases(yield* f.state())).toEqual(final);
      }).pipe(provideTestLayer(ApplicationLayer)),
    {timeout: 120_000, arbitrary: {runs: 8, seed: 80802}},
  );
});
