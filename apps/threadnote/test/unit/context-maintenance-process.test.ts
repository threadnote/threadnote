import {it as effectIt} from '@effect/vitest';
import {Clock, Effect, FileSystem, Path, Schema} from 'effect';
import {TestClock} from 'effect/testing';
import {describe, expect} from 'vitest';
import {formatMemoryDocument} from '@threadnote/memory/document';
import {runCommandEffect} from '@threadnote/platform/command';
import {SystemInfo} from '@threadnote/platform/system';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import {setContextMaintenancePaused} from '@threadnote/threadnote/memory/context/maintenance';
import {provideTestLayer} from '../helpers/effect-layer.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

const MaintenanceStateSchema = Schema.StructWithRest(
  Schema.Struct({receipts: Schema.Array(Schema.Unknown), state: Schema.String}),
  [Schema.Record(Schema.String, Schema.Unknown)],
);

function parseMaintenanceState(serialized: string) {
  const value: unknown = JSON.parse(serialized);
  if (!Schema.is(MaintenanceStateSchema)(value)) throw new Error('Invalid context maintenance state.');
  return value;
}

describe('headless context maintenance lifecycle', () => {
  effectIt.effect('ordinary context brief use progresses maintenance with Manager closed', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const system = yield* SystemInfo;
      const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-maintenance-process-'});
      const user = 'maintenance-process';
      yield* setContextMaintenancePaused(
        {
          account: 'local',
          agentContextHome: home,
          agentId: 'maintenance-test',
          manifestPath: path.join(home, 'manifest.yaml'),
          user,
        },
        false,
      );
      const directory = path.join(home, 'data', 'local', 'user', user, 'memories', 'durable', 'projects', 'threadnote');
      yield* fs.makeDirectory(directory, {recursive: true});
      const source = path.join(directory, 'source.md');
      const uri = `threadnote://user/${user}/memories/durable/projects/threadnote/source.md`;
      yield* fs.writeFileString(
        source,
        formatMemoryDocument(
          'MEMORY',
          {
            kind: 'durable',
            schemaVersion: 2,
            memoryId: 'tn_process_source',
            project: 'threadnote',
            sourceAgentClient: 'test',
            status: 'active',
            timestamp: '2026-10-03T15:00:00.000Z',
            topic: 'source',
            relations: [{type: 'depends_on', uri: Effect2.pipe(uri, EffectString.replace('source.md', 'missing.md'))}],
          },
          'Use current evidence.',
        ),
      );
      const result = yield* runCommandEffect(
        system.executablePath,
        [
          path.resolve('apps/threadnote/src/standalone.ts'),
          '--home',
          home,
          'context',
          'brief',
          '--cwd',
          home,
          '--task',
          'Find useful local context',
          '--project',
          'threadnote',
          '--json',
        ],
        {
          env: {
            ...system.environment(),
            THREADNOTE_HOME: home,
            THREADNOTE_ACCOUNT: 'local',
            THREADNOTE_USER: user,
            THREADNOTE_AGENT_ID: 'maintenance-test',
            THREADNOTE_TELEMETRY: 'off',
          },
          allowFailure: true,
          timeoutMs: 15_000,
        },
      );
      expect(result.exitCode, result.stdout + result.stderr).toBe(0);
      const deadline = (yield* Clock.currentTimeMillis) + 15_000;
      let content = yield* fs.readFileString(source);
      while (Effect2.pipe(content, EffectString.includes('relation:')) && (yield* Clock.currentTimeMillis) < deadline) {
        yield* Effect.sleep(100);
        content = yield* fs.readFileString(source);
      }
      expect(content).not.toContain('relation:');
      const stateFile = path.join(home, 'context-maintenance', 'state-v2.json');
      let state = parseMaintenanceState(yield* fs.readFileString(stateFile));
      while (
        (state.receipts.length === 0 || state.state === 'running') &&
        (yield* Clock.currentTimeMillis) < deadline
      ) {
        yield* Effect.sleep(100);
        state = parseMaintenanceState(yield* fs.readFileString(stateFile));
      }
      expect(state.receipts).toHaveLength(1);
    }).pipe(TestClock.withLive, provideTestLayer(ApplicationLayer)),
  );
});
