import {it as effectIt} from '@effect/vitest';
import {Effect, Result, Schema} from 'effect';
import {TestClock} from 'effect/testing';
import {expect, vi} from 'vitest';
import {runCommandEffect} from '@threadnote/platform/command';
import {SystemInfo} from '@threadnote/platform/system';
import {obsidianSourceWork} from '@threadnote/integration-obsidian/source';
import {ApplicationLayer} from '../../src/effect/runtime.js';
import {captureConsole} from '../../src/effect/console.js';
import * as maintenance from '../../src/memory/context/maintenance.js';
import * as refresh from '../../src/memory/context/maintenance_refresh.js';
import {EffectMcpServerAdapter} from '../../src/effect/ai/mcp.js';
import {registerContextMaintenanceTools} from '../../src/mcp/server/context/maintenance.js';
import {runContextMaintainCommand} from '../../src/memory/context/maintenance_commands.js';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {managerImportedTopicFixture} from '../helpers/manager-imported-topic.js';

const refreshConfig = {
  account: 'local',
  user: 'tester',
  agentId: 'test',
  agentContextHome: '/unused',
  manifestPath: '/unused',
};

effectIt.effect('explicit refresh CLI preserves the selected scope and never falls through to a repair tick', () =>
  Effect.gen(function* () {
    const observed = {
      outcome: 'incomplete' as const,
      reason: 'Target evidence is unavailable; no absence is inferred.',
    };
    const refreshSpy = vi.spyOn(refresh, 'refreshContextMaintenanceCase').mockReturnValue(Effect.succeed(observed));
    const runSpy = vi.spyOn(maintenance, 'runContextMaintenance');
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        refreshSpy.mockRestore();
        runSpy.mockRestore();
      }),
    );
    const selection = {
      memoryUri: 'threadnote://user/tester/memories/durable/selected.md',
      startLine: 2,
      maximumLines: 4,
    };
    const result = yield* captureConsole(
      runContextMaintainCommand(refreshConfig, {
        action: 'refresh',
        project: 'fixture',
        caseId: 'selected-case',
        sourceCwd: '/selected',
        json: true,
        ...selection,
      }),
    );
    expect(JSON.parse(result.output)).toEqual(observed);
    expect(refreshSpy).toHaveBeenCalledExactlyOnceWith(
      refreshConfig,
      {project: 'fixture', caseId: 'selected-case', cwd: '/selected'},
      {...selection, citationId: undefined},
    );
    expect(runSpy).not.toHaveBeenCalled();
    for (const missing of [{project: undefined}, {caseId: undefined}, {sourceCwd: 'relative'}]) {
      const refused = yield* runContextMaintainCommand(refreshConfig, {
        action: 'refresh',
        project: 'fixture',
        caseId: 'selected-case',
        sourceCwd: '/selected',
        ...missing,
      }).pipe(Effect.result);
      expect(Result.isFailure(refused)).toBe(true);
    }
    expect(refreshSpy).toHaveBeenCalledTimes(1);
    expect(runSpy).not.toHaveBeenCalled();
  }).pipe(provideTestLayer(ApplicationLayer)),
);

effectIt.effect('registered MCP refresh validates its exact scope and preserves an incomplete observation', () =>
  Effect.gen(function* () {
    const observed = {outcome: 'incomplete' as const, reason: 'Selected target remains unknown.'};
    const refreshSpy = vi.spyOn(refresh, 'refreshContextMaintenanceCase').mockReturnValue(Effect.succeed(observed));
    const runSpy = vi.spyOn(maintenance, 'runContextMaintenance');
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        refreshSpy.mockRestore();
        runSpy.mockRestore();
      }),
    );
    const server = new EffectMcpServerAdapter('refresh-test', '0', 'Synthetic refresh adapter test.');
    registerContextMaintenanceTools(server, refreshConfig);
    const input = {action: 'refresh', project: 'fixture', caseId: 'selected-case', callerCwd: '/selected'};
    const result = yield* server.invokeTool('context_maintain', input);
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual(observed);
    expect(refreshSpy).toHaveBeenCalledExactlyOnceWith(refreshConfig, {
      project: 'fixture',
      caseId: 'selected-case',
      cwd: '/selected',
    });
    for (const invalid of [{project: undefined}, {caseId: undefined}, {callerCwd: 'relative'}]) {
      const refused = yield* server.invokeTool(
        'context_maintain',
        Object.fromEntries(Object.entries({...input, ...invalid}).filter(([, value]) => value !== undefined)),
      );
      expect(refused.isError).toBe(true);
    }
    expect(refreshSpy).toHaveBeenCalledTimes(1);
    expect(runSpy).not.toHaveBeenCalled();
  }).pipe(provideTestLayer(ApplicationLayer)),
);

effectIt.effect('source CLI reads an unchanged imported packet as JSON with either output format', () =>
  Effect.gen(function* () {
    const f = yield* managerImportedTopicFixture();
    const system = yield* SystemInfo;
    const environment = system.environment();
    const userHome = f.path.join(f.home, 'cli-user');
    const temporary = f.path.join(f.home, 'cli-tmp');
    yield* f.fs.makeDirectory(userHome, {recursive: true});
    yield* f.fs.makeDirectory(temporary, {recursive: true});
    const pinDirectory = f.path.join(f.home, 'threadnote', 'sources', 'obsidian', 'notes', 'evidence');
    const before = yield* f.store.read(f.location, f.uri);
    const pins = yield* f.fs.readDirectory(pinDirectory);
    const statePath = f.path.join(f.home, 'context-maintenance', 'state-v2.json');
    const state = yield* f.fs.readFileString(statePath);
    for (const json of [false, true]) {
      const result = yield* runCommandEffect(
        system.executablePath,
        [
          f.path.resolve('apps/threadnote/src/standalone.ts'),
          '--home',
          f.home,
          '--manifest',
          f.config.manifestPath,
          'context',
          'maintain',
          '--action',
          'packet',
          '--case-id',
          f.caseId,
          ...(json ? ['--json'] : []),
        ],
        {
          cwd: f.home,
          env: {
            PATH: environment.PATH,
            SystemRoot: environment.SystemRoot,
            ComSpec: environment.ComSpec,
            PATHEXT: environment.PATHEXT,
            HOME: userHome,
            USERPROFILE: userHome,
            XDG_CONFIG_HOME: f.path.join(userHome, '.config'),
            XDG_CACHE_HOME: f.path.join(userHome, '.cache'),
            TMPDIR: temporary,
            TMP: temporary,
            TEMP: temporary,
            THREADNOTE_HOME: f.home,
            THREADNOTE_ACCOUNT: f.config.account,
            THREADNOTE_USER: f.config.user,
            THREADNOTE_AGENT_ID: f.config.agentId,
            THREADNOTE_INSTALL_ROOT: f.path.join(f.home, 'cli-installation'),
            THREADNOTE_TELEMETRY: 'off',
            NO_COLOR: '1',
          },
          allowFailure: true,
        },
      );
      expect(result.exitCode, result.stderr + result.stdout).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual(f.packet);
    }
    expect(yield* f.store.read(f.location, f.uri)).toBe(before);
    expect(yield* f.fs.readFileString(f.notePath)).toBe(f.currentText);
    expect(yield* f.fs.readDirectory(pinDirectory)).toEqual(pins);
    expect(yield* f.fs.readFileString(statePath)).toBe(state);
  }).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
);

effectIt.effect('packet CLI adapter retains every imported excerpt-selection refusal without changing evidence', () =>
  Effect.gen(function* () {
    const f = yield* managerImportedTopicFixture();
    const before = yield* f.store.read(f.location, f.uri);
    const pinsPath = f.path.join(f.home, 'threadnote', 'sources', 'obsidian', 'notes', 'evidence');
    const pins = yield* f.fs.readDirectory(pinsPath);
    const readable = yield* captureConsole(runContextMaintainCommand(f.config, {action: 'packet', caseId: f.caseId}));
    expect(JSON.parse(readable.output)).toEqual(f.packet);
    for (const selection of [{citationId: 'tnob_unselected'}, {memoryUri: f.uri}, {startLine: 1}, {maximumLines: 24}]) {
      const result = yield* runContextMaintainCommand(f.config, {
        action: 'packet',
        caseId: f.caseId,
        json: true,
        ...selection,
      }).pipe(Effect.result);
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) expect(String(result.failure)).toContain('imported topic observation changed');
    }
    expect(yield* f.store.read(f.location, f.uri)).toBe(before);
    expect(yield* f.fs.readFileString(f.notePath)).toBe(f.currentText);
    expect(yield* f.fs.readDirectory(pinsPath)).toEqual(pins);
  }).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
);

effectIt.effect.each(['source', 'target'] as const)(
  'packet CLI adapter rejects a genuinely changed imported %s',
  changed =>
    Effect.gen(function* () {
      const f = yield* managerImportedTopicFixture();
      if (changed === 'source') {
        yield* f.fs.writeFileString(f.notePath, 'New source evidence after observation.');
        yield* obsidianSourceWork.run(f.config, 'notes', {
          mode: 'automatic',
          requestId: 'packet-source-changed',
          credentialEnvironment: {},
        });
      } else {
        const original = yield* f.store.read(f.location, f.uri);
        yield* f.store.write(f.location, f.uri, original.replace('Old descriptive claim.', 'Edited target claim.'), {
          mode: 'replace',
        });
      }
      const target = yield* f.store.read(f.location, f.uri);
      const source = yield* f.fs.readFileString(f.notePath);
      const result = yield* runContextMaintainCommand(f.config, {action: 'packet', caseId: f.caseId, json: true}).pipe(
        Effect.result,
      );
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(String(result.failure)).toContain(
          changed === 'source' ? 'imported source or target changed' : 'selected maintenance case is stale',
        );
      }
      expect(yield* f.store.read(f.location, f.uri)).toBe(target);
      expect(yield* f.fs.readFileString(f.notePath)).toBe(source);
    }).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
);

const boundedText = Schema.String.check(Schema.isMaxLength(32));
effectIt.effect.prop(
  'passes native or non-topic excerpt selectors unchanged under unrelated CLI envelopes without mutating options',
  {
    selection: Schema.Struct({
      citationId: boundedText,
      memoryUri: boundedText,
      startLine: Schema.Int.check(Schema.isBetween({minimum: 1, maximum: 1000000})),
      maximumLines: Schema.Int.check(Schema.isBetween({minimum: 1, maximum: 24})),
    }),
    envelope: Schema.Struct({
      json: Schema.Boolean,
      project: boundedText,
      maxRecords: Schema.Int.check(Schema.isBetween({minimum: 1, maximum: 100})),
      receiptId: boundedText,
      caseCursor: boundedText,
      receiptCursor: boundedText,
      limit: Schema.Int.check(Schema.isBetween({minimum: 1, maximum: 100})),
      evidenceRevision: boundedText,
      expectedContentHash: boundedText,
      backend: boundedText,
      modelId: boundedText,
      regenerate: Schema.Boolean,
      reviewId: boundedText,
      revision: Schema.Int,
      approvalDigest: boundedText,
      approved: Schema.Boolean,
      inspectionDigest: boundedText,
      fragmentStart: Schema.Int,
      fragmentEnd: Schema.Int,
      retentionDays: Schema.Int,
      unitsPerHour: Schema.Int,
    }),
  },
  ({selection, envelope}) =>
    Effect.gen(function* () {
      const config = {
        account: 'local',
        user: 'tester',
        agentId: 'test',
        agentContextHome: '/unused',
        manifestPath: '/unused',
      };
      const intercepted = maintenance.ContextMaintenanceError.make({message: 'packet-boundary-intercepted'});
      const spy = vi.spyOn(maintenance, 'readContextMaintenancePacket').mockReturnValue(Effect.fail(intercepted));
      yield* Effect.addFinalizer(() => Effect.sync(() => spy.mockRestore()));
      const base = {action: 'packet', caseId: 'selected-case', sourceCwd: '/unused-source', ...selection};
      const options = Object.freeze({...base, ...envelope});
      const before = JSON.stringify(options);
      for (const input of [Object.freeze(base), options]) {
        const result = yield* runContextMaintainCommand(config, input).pipe(Effect.result);
        expect(Result.isFailure(result)).toBe(true);
        if (Result.isFailure(result)) expect(result.failure).toBe(intercepted);
      }
      expect(spy).toHaveBeenCalledTimes(2);
      for (const [receivedConfig, receivedCase, receivedSelection] of spy.mock.calls) {
        expect(receivedConfig).toBe(config);
        expect(receivedCase).toBe('selected-case');
        expect(receivedSelection).toEqual(selection);
        expect(Object.keys(receivedSelection!).sort()).toEqual([
          'citationId',
          'maximumLines',
          'memoryUri',
          'startLine',
        ]);
      }
      expect(JSON.stringify(options)).toBe(before);
      expect(options).toEqual({...base, ...envelope});
    }).pipe(provideTestLayer(ApplicationLayer)),
  {arbitrary: {runs: 30}},
);
