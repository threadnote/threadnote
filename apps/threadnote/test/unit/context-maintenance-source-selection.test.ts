import {it as effectIt} from '@effect/vitest';
import {Array as EffectArray, Effect, FileSystem, Option, Path, Schema, String as EffectString} from 'effect';
import {TestClock} from 'effect/testing';
import {expect} from 'vitest';
import {CodeGraphIndexer} from '@threadnote/graph/indexer';
import {CodeGraphQueryService} from '@threadnote/graph/query';
import {captureMemoryCodeCitations} from '@threadnote/context/citation/capture';
import {contextHealthCaseIdV2} from '@threadnote/context/health_maintenance';
import {runCommandEffect} from '@threadnote/platform/command';
import {SystemInfo} from '@threadnote/platform/system';
import {formatMemoryDocument} from '@threadnote/memory/document';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {ApplicationLayer} from '../../src/effect/runtime.js';
import {captureConsole} from '../../src/effect/console.js';
import {EffectMcpServerAdapter} from '../../src/effect/ai/mcp.js';
import {registerContextMaintenanceTools} from '../../src/mcp/server/context/maintenance.js';
import {runContextMaintainCommand} from '../../src/memory/context/maintenance_commands.js';
import {
  readState,
  runContextMaintenance,
  setContextMaintenancePaused,
  writeState,
} from '../../src/memory/context/maintenance.js';
import {refreshContextMaintenanceCase} from '../../src/memory/context/maintenance_refresh.js';
import type {ContextMaintenanceCaseV2, MaintenanceState} from '../../src/memory/context/maintenance_contracts.js';
import {provideTestLayer} from '../helpers/effect-layer.js';

const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fs.makeTempDirectoryScoped({prefix: 'maintenance-source-selection-'});
  const home = yield* fs.realPath(directory);
  const retained = path.join(home, 'retained');
  const requested = path.join(home, 'requested');
  yield* fs.makeDirectory(retained);
  const config = {
    account: 'local',
    agentContextHome: home,
    agentId: 'test',
    user: 'tester',
    manifestPath: path.join(home, 'manifest.yaml'),
  };
  const git = (cwd: string, args: readonly string[]) => runCommandEffect('git', ['-C', cwd, ...args]);
  yield* git(retained, ['init', '--quiet']);
  yield* git(retained, ['config', 'user.name', 'Test']);
  yield* git(retained, ['config', 'user.email', 'test@example.invalid']);
  yield* git(retained, ['remote', 'add', 'origin', 'https://example.invalid/source-selection.git']);
  const source = path.join(retained, 'source.ts');
  yield* fs.writeFileString(source, 'export const supported = 0;\n');
  const commit = (cwd: string) =>
    git(cwd, ['add', '.']).pipe(Effect.andThen(git(cwd, ['commit', '--quiet', '-m', 'source'])));
  yield* commit(retained);
  yield* fs.writeFileString(
    config.manifestPath,
    `version: 1\nprojects:\n  - name: fixture\n    path: ${JSON.stringify(retained)}\n    uri: threadnote://resources/repos/fixture\n    seed: []\n`,
  );
  const indexer = yield* CodeGraphIndexer;
  yield* indexer.index({cwd: retained, threadnoteHome: home, ensureVectors: false});
  const codeCitations = yield* captureMemoryCodeCitations(config, {
    callerCwd: retained,
    project: 'fixture',
    refs: ['source.ts'],
  });
  const raw = formatMemoryDocument(
    'MEMORY',
    {
      schemaVersion: 5,
      kind: 'durable',
      status: 'active',
      memoryId: 'tn_source_selection',
      project: 'fixture',
      topic: 'source-selection',
      timestamp: '2026-10-29T00:00:00.000Z',
      sourceAgentClient: 'test',
      codeCitations,
    },
    'Synthetic source claim.',
  );
  const memoryFile = path.join(home, 'data/local/user/tester/memories/durable/projects/fixture/source-selection.md');
  yield* fs.makeDirectory(path.dirname(memoryFile), {recursive: true});
  yield* fs.writeFileString(memoryFile, raw);
  const retainedText = 'export const supported = 1;\n';
  yield* fs.writeFileString(source, retainedText);
  yield* commit(retained);
  yield* indexer.index({cwd: retained, threadnoteHome: home, ensureVectors: false});
  const currentCitations = yield* captureMemoryCodeCitations(config, {
    callerCwd: retained,
    project: 'fixture',
    refs: ['source.ts'],
  });
  yield* git(retained, ['worktree', 'add', '--quiet', '-b', 'requested', requested]);
  const requestedText = 'export const supported = 2;\n';
  yield* fs.writeFileString(path.join(requested, 'source.ts'), requestedText);
  yield* commit(requested);
  yield* indexer.index({cwd: requested, threadnoteHome: home, ensureVectors: false});
  yield* setContextMaintenancePaused(config, false);
  const status = yield* runContextMaintenance(config, {cwd: retained, project: 'fixture', maxRecords: 1});
  const item = Option.getOrUndefined(
    EffectArray.findFirst(status.cases, value => value.family === 'citation' && value.disposition === 'needs-decision'),
  );
  expect(item, JSON.stringify(status)).toBeDefined();
  if (!item) return yield* Effect.die('Expected selected citation case.');
  expect(item.sourceSnapshot?.cwd).toBe(retained);
  return {
    fs,
    path,
    home,
    config,
    retained,
    requested,
    source,
    retainedText,
    requestedText,
    memoryFile,
    raw,
    item,
    git,
    currentCitations,
  };
});

effectIt.effect(
  'refuses a different ready worktree, preserves state and returns only actual retained bytes after selection',
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const query = yield* CodeGraphQueryService;
      const snapshots = [];
      for (const cwd of [f.retained, f.requested]) {
        const status = yield* query.status(f.home, cwd);
        expect(status.stale).toBe(false);
        expect(status.readySnapshot?.dirty).toBe(false);
        expect(status.readySnapshot?.commit).toBe(EffectString.trim((yield* f.git(cwd, ['rev-parse', 'HEAD'])).stdout));
        expect((yield* f.git(cwd, ['status', '--porcelain'])).stdout).toBe('');
        snapshots.push(status.readySnapshot);
      }
      expect(snapshots[0]?.commit).not.toBe(snapshots[1]?.commit);
      expect(yield* f.fs.readFileString(f.path.join(f.requested, 'source.ts'))).not.toBe(f.retainedText);
      const before = yield* readState(f.config);
      const input = {project: 'fixture', caseId: f.item.caseId, cwd: f.requested, sourceCwd: f.requested};
      const expected = {
        outcome: 'incomplete',
        code: 'source-selection-mismatch',
        sourceSelection: {requestedCwd: f.requested, retainedCwd: f.retained},
      };
      const result = yield* refreshContextMaintenanceCase(f.config, input);
      expect(result).toMatchObject(expected);
      expect('packet' in result).toBe(false);
      if ('reason' in result) expect(result.reason).toContain('sourceSelection.retainedCwd');
      const cli = yield* captureConsole(
        runContextMaintainCommand(f.config, {
          action: 'refresh',
          project: 'fixture',
          caseId: f.item.caseId,
          sourceCwd: f.requested,
          json: true,
        }),
      );
      expect(JSON.parse(cli.output)).toEqual(result);
      const server = new EffectMcpServerAdapter('source-selection-test', '0', 'Synthetic source selector test.');
      registerContextMaintenanceTools(server, f.config);
      const mcp = yield* server.invokeTool('context_maintain', {
        action: 'refresh',
        project: 'fixture',
        caseId: f.item.caseId,
        callerCwd: f.requested,
      });
      expect(mcp.structuredContent).toEqual(result);
      const system = yield* SystemInfo;
      const bin = system.environment().THREADNOTE_SOURCE_SELECTION_SMOKE_BIN;
      if (bin) {
        const command = yield* runCommandEffect(
          bin,
          [
            '--home',
            f.home,
            '--manifest',
            f.config.manifestPath,
            'context',
            'maintain',
            '--action',
            'refresh',
            '--project',
            'fixture',
            '--case-id',
            f.item.caseId,
            '--source-cwd',
            f.requested,
            '--json',
          ],
          {
            cwd: f.requested,
            env: {
              ...system.environment(),
              THREADNOTE_ACCOUNT: 'local',
              THREADNOTE_USER: 'tester',
              THREADNOTE_AGENT_ID: 'test',
              THREADNOTE_TELEMETRY: 'off',
            },
          },
        );
        expect(JSON.parse(command.stdout)).toEqual(result);
      }
      expect(yield* readState(f.config)).toEqual(before);
      expect(yield* f.fs.readFileString(f.memoryFile)).toBe(f.raw);
      for (const [index, cwd] of [f.retained, f.requested].entries())
        expect((yield* query.status(f.home, cwd)).readySnapshot).toEqual(snapshots[index]);
      const refreshed = yield* refreshContextMaintenanceCase(f.config, {...input, sourceCwd: f.retained});
      expect(refreshed.outcome).toBe('ready');
      if (refreshed.outcome !== 'ready') return yield* Effect.die(JSON.stringify(refreshed));
      expect(refreshed.item.sourceSnapshot?.cwd).toBe(f.retained);
      if (!('evidence' in refreshed.packet)) return yield* Effect.die('Expected citation evidence.');
      const excerpts = EffectArray.filter(
        refreshed.packet.evidence?.excerpts ?? [],
        value => value.provenance === 'current-verified',
      );
      expect(excerpts.length).toBeGreaterThan(0);
      for (const excerpt of excerpts) {
        expect(excerpt.source.sourceSnapshotId).toBe(snapshots[0]?.id);
        expect(excerpt.source.sourceCommit).toBe(snapshots[0]?.commit);
        expect(excerpt.source.fileContentHash).toBe(f.currentCitations[0].fileContentHash.value);
        expect(excerpt.fileBytesHash).toBe(sha256HexSync(f.retainedText));
        expect(excerpt.content).toContain('supported = 1');
        expect(excerpt.content).not.toContain('supported = 2');
      }
      // No explicit selector preserves the retained source even when cwd differs.
      const implicit = yield* refreshContextMaintenanceCase(f.config, {
        project: 'fixture',
        caseId: f.item.caseId,
        cwd: f.requested,
      });
      expect(implicit.outcome).toBe('ready');
      expect(yield* f.fs.readFileString(f.memoryFile)).toBe(f.raw);
    }).pipe(TestClock.withLive, provideTestLayer(ApplicationLayer)),
);

effectIt.effect('accepts an alias of the retained checkout and refuses missing routes without recreating them', () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const alias = f.path.join(f.home, 'alias');
    yield* f.fs.symlink(f.retained, alias);
    const input = {project: 'fixture', caseId: f.item.caseId, cwd: f.requested, sourceCwd: alias};
    expect((yield* refreshContextMaintenanceCase(f.config, input)).outcome).toBe('ready');
    const before = yield* readState(f.config);
    const missing = f.path.join(f.home, 'missing');
    expect(yield* refreshContextMaintenanceCase(f.config, {...input, sourceCwd: missing})).toMatchObject({
      outcome: 'incomplete',
      code: 'source-selection-unavailable',
    });
    yield* f.fs.remove(f.retained, {recursive: true});
    expect(yield* refreshContextMaintenanceCase(f.config, {...input, sourceCwd: f.requested})).toMatchObject({
      outcome: 'incomplete',
      code: 'source-selection-unavailable',
    });
    expect(yield* f.fs.exists(missing)).toBe(false);
    expect(yield* f.fs.exists(f.retained)).toBe(false);
    expect(yield* readState(f.config)).toEqual(before);
    expect(yield* f.fs.readFileString(f.memoryFile)).toBe(f.raw);
  }).pipe(TestClock.withLive, provideTestLayer(ApplicationLayer)),
);

effectIt.effect.prop(
  'mismatching explicit directories never observe subjects or mutate a retained case',
  [
    Schema.Literals(['citation', 'citation-coverage', 'topic-maintenance', 'relation', 'shared-owner-proposal']),
    Schema.Int.check(Schema.isBetween({minimum: 0, maximum: 100})),
  ],
  ([family, suffix]) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({prefix: 'source-selection-property-'});
      const retained = path.join(home, `retained-${suffix}`);
      const requested = path.join(home, `requested-${suffix}`);
      yield* fs.makeDirectory(retained);
      yield* fs.makeDirectory(requested);
      const config = {
        account: 'local',
        agentContextHome: home,
        agentId: 'test',
        user: 'tester',
        manifestPath: path.join(home, 'unused'),
      };
      const item: ContextMaintenanceCaseV2 = {
        caseId: contextHealthCaseIdV2({project: 'fixture', memoryId: 'tn_subject', family, slot: 'selected'}),
        project: 'fixture',
        memoryId: 'tn_subject',
        family,
        slot: 'selected',
        evidenceRevision: 'unchanged',
        disposition: 'needs-decision',
        reason: 'unchanged',
        firstSeen: '2026-10-29T00:00:00.000Z',
        lastSeen: '2026-10-29T00:00:00.000Z',
        lastChecked: '2026-10-29T00:00:00.000Z',
        attemptCount: 0,
        events: [],
        sourceSnapshot: {cwd: retained, generation: 'unchanged', revision: 'unchanged'},
      };
      const state: MaintenanceState = {
        version: 2,
        paused: false,
        state: 'idle',
        generation: 'fixture',
        projects: [],
        cases: [item],
        receipts: [],
        checkpoints: {},
      };
      yield* writeState(config, state);
      const before = yield* readState(config);
      const result = yield* refreshContextMaintenanceCase(config, {
        project: 'fixture',
        caseId: item.caseId,
        cwd: retained,
        sourceCwd: requested,
      });
      expect(result).toMatchObject({outcome: 'incomplete', code: 'source-selection-mismatch'});
      expect('packet' in result).toBe(false);
      expect(yield* readState(config)).toEqual(before);
    }).pipe(provideTestLayer(ApplicationLayer)),
  {arbitrary: {runs: 10}},
);
