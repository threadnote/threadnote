import {Array as EffectArray} from 'effect';
import * as BunServices from '@effect/platform-bun/BunServices';
import {it as effectIt} from '@effect/vitest';
import {Cause, Effect, FileSystem, Layer, Path, Result} from 'effect';
import {TestClock} from 'effect/testing';
import fc from 'fast-check';
import {expect, vi} from 'vitest';
import {fcEffectProp} from '@threadnote/testing/fast-check-property';
import {ResourceRecallInvalidation} from '@threadnote/store/resource/recall-invalidation';
import {ResourceStore} from '@threadnote/store/resource-store';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {SystemInfo} from '@threadnote/platform/system';
import {CommandExecutor} from '@threadnote/platform/command';
import {CodeGraphQueryService} from '@threadnote/graph/query';
import {LocalModelCatalog} from '@threadnote/inference/models/catalog';
import {LocalModelRuntime} from '@threadnote/inference/engine/local-model-runtime';
import {LocalModelStore} from '@threadnote/inference/models/store';
import {loadRecallIndexData, recallIndexStatus} from '@threadnote/recall/index';
import * as recallRefresh from '@threadnote/recall/mcp/refresh';
import {formatMemoryDocument, parseMemoryDocument} from '@threadnote/memory/document';
import {createMemoryCodeCitation} from '@threadnote/memory/code/citation';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {
  MemoryArchiveExecutable,
  planMemoryArchive,
  checkMemoryArchivePlan,
  commitMemoryArchive,
} from '../../src/memory/archive_plan.js';
import {runMemoryArchiveProtocol, runMemoryArchiveRequest} from '../../src/effect/memory_archive_cli.js';
import {captureConsole} from '../../src/effect/console.js';
import {CliOutput} from '../../src/effect/cli/output.js';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {TestSystemInfoLayer} from '../helpers/system-layer.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

const dependencies = Layer.mergeAll(
  BunServices.layer,
  TestSystemInfoLayer,
  Layer.succeed(ResourceRecallInvalidation, {expire: () => Effect.void}),
);
// storeMemory's wider type mentions these services; this path must never call them.
// Unimplemented mocks fail on any accidental graph, process, model or direct output operation.
const testLayer = Layer.mergeAll(
  dependencies,
  ResourceStore.layer.pipe(Layer.provide(dependencies)),
  Layer.mock(CodeGraphQueryService, {}),
  Layer.mock(CommandExecutor, {}),
  Layer.mock(LocalModelCatalog, {}),
  Layer.mock(LocalModelRuntime, {}),
  Layer.mock(LocalModelStore, {
    path: () => {
      throw new Error('Archive must not resolve a model path.');
    },
  }),
  Layer.mock(CliOutput, {
    enqueueError: () => {
      throw new Error('Archive must not enqueue direct output.');
    },
    enqueueOutput: () => {
      throw new Error('Archive must not enqueue direct output.');
    },
  }),
);
const provide = <A, E, R>(program: Effect.Effect<A, E, R>) =>
  program.pipe(provideTestLayer(testLayer), TestClock.withLive);
const SOURCE = 'threadnote://user/tester/memories/durable/projects/threadnote/legacy-plan.md';
const fixture = Effect.fn('test.archivePlanFixture')(function* (content?: string, createSource = true) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const store = yield* ResourceStore;
  const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-exact-archive-'});
  const executable = path.join(home, 'threadnote-fixture');
  const manifestPath = path.join(home, 'seed-manifest.yaml');
  yield* fs.writeFileString(executable, 'immutable synthetic standalone executable bytes');
  yield* fs.writeFileString(manifestPath, 'version: 1\nprojects: []\n');
  const config: RuntimeConfig = {
    account: 'local',
    user: 'tester',
    agentId: 'test',
    agentContextHome: home,
    manifestPath,
  };
  const location = {account: config.account, user: config.user, home};
  const raw =
    content ??
    '\nMEMORY\nkind: durable\nstatus: active\nproject: threadnote\nsource_agent_client: legacy\ntimestamp: 2025-01-01T00:00:00.000Z\ntopic: legacy-plan\n\nLegacy fact.\n';
  if (createSource) yield* store.write(location, SOURCE, raw, {mode: 'create'});
  const pinned = <A, E, R>(program: Effect.Effect<A, E, R>) =>
    program.pipe(Effect.provideService(MemoryArchiveExecutable, {path: executable}));
  const snapshot = Effect.gen(function* () {
    const names = (yield* fs.readDirectory(home, {recursive: true})).sort();
    return yield* Effect.forEach(names, name =>
      Effect.gen(function* () {
        const file = path.join(home, name);
        return [name, (yield* fs.stat(file)).type === 'File' ? sha256HexSync(yield* fs.readFile(file)) : 'directory'];
      }),
    );
  });
  return {fs, path, store, home, executable, config, location, raw, pinned, snapshot};
});

effectIt.effect.each([
  {action: 'plan', missing: 'data'},
  {action: 'plan', missing: 'account'},
  {action: 'check', missing: 'data'},
  {action: 'check', missing: 'account'},
] as const)('keeps a rejected $action read-only when the $missing root is absent', ({action, missing}) =>
  Effect.gen(function* () {
    const f = yield* fixture(undefined, action === 'check');
    const plan = action === 'check' ? yield* f.pinned(planMemoryArchive(f.config, SOURCE)) : undefined;
    const data = f.path.join(f.home, 'data');
    const absent = missing === 'data' ? data : f.path.join(data, f.config.account);
    if (action === 'check') yield* f.fs.remove(absent, {recursive: true});
    else if (missing === 'account') yield* f.fs.makeDirectory(data);
    expect(yield* f.fs.exists(absent)).toBe(false);
    const before = yield* f.snapshot;
    let exitCode = 0;
    const system = yield* SystemInfo;
    const response = yield* f
      .pinned(
        captureConsole(
          runMemoryArchiveProtocol(
            f.config,
            Effect.succeed(action === 'plan' ? {version: 1, action, uri: SOURCE} : {version: 1, action, plan}),
          ),
        ),
      )
      .pipe(
        Effect.provideService(SystemInfo, {
          ...system,
          setExitCode: code => {
            exitCode = code;
          },
        }),
      );
    expect(JSON.parse(response.output)).toMatchObject({
      version: 1,
      status: 'error',
      code: action === 'plan' ? 'invalid-request' : 'archive-conflict',
    });
    expect(exitCode).toBe(1);
    expect(yield* f.snapshot).toEqual(before);
    expect(yield* f.fs.exists(absent)).toBe(false);
  }).pipe(provide),
);

effectIt.effect('plans actual legacy bytes and exact destination without repairing headers or writing any state', () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const before = yield* f.snapshot;
    const plan = yield* f.pinned(planMemoryArchive(f.config, SOURCE));
    expect(plan.source).toEqual({
      uri: SOURCE,
      sha256: sha256HexSync(f.raw),
      bytes: new TextEncoder().encode(f.raw).length,
    });
    expect(plan.destination.uri).toBe(
      `threadnote://user/tester/memories/durable/archived/threadnote/consolidation-${plan.archiveKey}.md`,
    );
    expect(plan.runtime).toEqual({
      executablePath: yield* f.fs.realPath(f.executable),
      sha256: sha256HexSync('immutable synthetic standalone executable bytes'),
    });
    expect(yield* f.pinned(checkMemoryArchivePlan(f.config, JSON.parse(JSON.stringify(plan))))).toMatchObject({
      status: 'ready',
      planId: plan.planId,
    });
    expect(yield* f.snapshot).toEqual(before);
    expect(yield* f.store.read(f.location, SOURCE)).toBe(f.raw);
    expect(JSON.stringify(plan)).not.toContain('Legacy fact.');
  }).pipe(provide),
);

effectIt.effect('commits the planned legacy copy exactly and replays the same plan after source removal', () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const plan = yield* f.pinned(planMemoryArchive(f.config, SOURCE));
    expect((yield* f.pinned(commitMemoryArchive(f.config, plan))).status).toBe('archived');
    const archive = yield* f.store.read(f.location, plan.destination.uri);
    expect(sha256HexSync(archive)).toBe(plan.destination.sha256);
    expect(new TextEncoder().encode(archive).length).toBe(plan.destination.bytes);
    const parsed = parseMemoryDocument(plan.destination.uri, archive)!;
    expect(parsed.metadata).toMatchObject({archivedFrom: SOURCE, status: 'archived', visibility: 'personal'});
    expect(parsed.metadata.memoryId).toBeUndefined();
    expect(parsed.metadata.schemaVersion).toBeUndefined();
    expect(parsed.body).toBe('Archived original Threadnote memory.\n\nLegacy fact.');
    expect((yield* f.store.read(f.location, SOURCE).pipe(Effect.result))._tag).toBe('Failure');
    expect((yield* f.pinned(checkMemoryArchivePlan(f.config, plan))).status).toBe('already-archived');
    expect((yield* f.pinned(commitMemoryArchive(f.config, plan))).status).toBe('already-archived');
    expect(yield* f.store.read(f.location, plan.destination.uri)).toBe(archive);
  }).pipe(provide),
);

effectIt.effect('retains stable identity, schema, code citations and privacy in the exact archived bytes', () =>
  Effect.gen(function* () {
    const citation = createMemoryCodeCitation({
      version: 1,
      extractorSet: 'native-code-graph-13',
      path: 'src/example.ts',
      fileContentHash: {algorithm: 'sha256', value: Effect2.pipe('a', EffectString.repeat(64))},
      repositoryId: Effect2.pipe('b', EffectString.repeat(64)),
      repositoryIdentityKind: 'remote',
      sourceCommit: Effect2.pipe('c', EffectString.repeat(40)),
      sourceDirty: false,
      sourceSnapshotId: `cgsn_${Effect2.pipe('d', EffectString.repeat(40))}`,
      target: {kind: 'file'},
    });
    const f = yield* fixture(
      formatMemoryDocument(
        'MEMORY',
        {
          kind: 'durable',
          status: 'active',
          timestamp: '2026-01-01T00:00:00.000Z',
          project: 'threadnote',
          sourceAgentClient: 'test',
          schemaVersion: 4,
          memoryId: 'tn_native_archive_source',
          authority: 'user_approved',
          visibility: 'personal',
          codeCitations: [citation],
        },
        'Supported source.',
      ),
    );
    const plan = yield* f.pinned(planMemoryArchive(f.config, SOURCE));
    yield* f.pinned(commitMemoryArchive(f.config, plan));
    const archived = parseMemoryDocument(plan.destination.uri, yield* f.store.read(f.location, plan.destination.uri))!;
    expect(archived.metadata).toMatchObject({
      schemaVersion: 4,
      memoryId: 'tn_native_archive_source',
      authority: 'user_approved',
      visibility: 'personal',
      codeCitations: [citation],
    });
  }).pipe(provide),
);

effectIt.effect('refuses malformed citation headers before producing a plan or changing any files', () =>
  Effect.gen(function* () {
    const f = yield* fixture(
      'MEMORY\nkind: durable\nstatus: active\nschema_version: 4\ncode_citation: {not-json}\n\nProtected source.',
    );
    const before = yield* f.snapshot;
    const failed = yield* f.pinned(planMemoryArchive(f.config, SOURCE)).pipe(Effect.result);
    expect(Result.isFailure(failed)).toBe(true);
    if (Result.isFailure(failed)) expect(String(failed.failure)).toContain('Malformed code citation metadata');
    expect(yield* f.snapshot).toEqual(before);
  }).pipe(provide),
);

effectIt.effect('refreshes the real active lexical index after the exact archive mutation', () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const before = yield* loadRecallIndexData(f.config, {forceRefresh: true, includeInactive: false});
    expect(EffectArray.some(before.candidates, item => item.uri === SOURCE)).toBe(true);
    const plan = yield* f.pinned(planMemoryArchive(f.config, SOURCE));
    yield* f.pinned(commitMemoryArchive(f.config, plan));
    expect((yield* recallIndexStatus(f.config, false)).ready).toBe(true);
    const after = yield* loadRecallIndexData(f.config, {includeInactive: false});
    expect(EffectArray.some(after.candidates, item => item.uri === SOURCE || item.uri === plan.destination.uri)).toBe(
      false,
    );
  }).pipe(provide),
);

effectIt.effect('refreshes source and archive after partial mutation and replay, while check stays read-only', () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const observed: string[][] = [];
    const spy = vi
      .spyOn(recallRefresh, 'refreshRecallDerivedIndexesAfterCanonicalMutation')
      .mockImplementation((_config, uris) =>
        Effect.sync(() => {
          observed.push([...uris]);
          return {state: 'unavailable' as const};
        }),
      );
    yield* Effect.addFinalizer(() => Effect.sync(() => spy.mockRestore()));
    const plan = yield* f.pinned(planMemoryArchive(f.config, SOURCE));
    const blocked = ResourceStore.of({...f.store, mutateChecked: () => Effect.interrupt});
    yield* f
      .pinned(commitMemoryArchive(f.config, plan))
      .pipe(Effect.provideService(ResourceStore, blocked), Effect.exit);
    expect(observed).toEqual([[SOURCE, plan.destination.uri]]);
    const beforeCheck = yield* f.snapshot;
    yield* f.pinned(checkMemoryArchivePlan(f.config, plan));
    expect(yield* f.snapshot).toEqual(beforeCheck);
    expect(observed).toHaveLength(1);
    yield* f.pinned(commitMemoryArchive(f.config, plan));
    expect(observed).toEqual([
      [SOURCE, plan.destination.uri],
      [SOURCE, plan.destination.uri],
    ]);
  }).pipe(provide),
);

effectIt.effect('refuses full raw header-only drift and never cleans up a newer source', () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const plan = yield* f.pinned(planMemoryArchive(f.config, SOURCE));
    const changed = Effect2.pipe(
      f.raw,
      EffectString.replace('source_agent_client: legacy', 'source_agent_client: changed'),
    );
    yield* f.store.write(f.location, SOURCE, changed, {mode: 'replace'});
    for (const operation of [checkMemoryArchivePlan, commitMemoryArchive]) {
      const failure = yield* f.pinned(operation(f.config, plan)).pipe(Effect.result);
      expect(Result.isFailure(failure)).toBe(true);
    }
    expect(yield* f.store.read(f.location, SOURCE)).toBe(changed);
    expect((yield* f.store.read(f.location, plan.destination.uri).pipe(Effect.result))._tag).toBe('Failure');
  }).pipe(provide),
);

effectIt.effect('refuses executable, manifest, effective configuration and namespace changes', () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const plan = yield* f.pinned(planMemoryArchive(f.config, SOURCE));
    for (const config of [
      {...f.config, account: 'other-account'},
      {...f.config, user: 'other-user'},
      {...f.config, agentId: 'other-agent'},
      {...f.config, agentContextHome: f.path.join(f.home, 'other-home')},
      {...f.config, manifestPath: f.executable},
    ])
      expect(Result.isFailure(yield* f.pinned(commitMemoryArchive(config, plan)).pipe(Effect.result))).toBe(true);
    const otherExecutable = f.path.join(f.home, 'other-executable');
    yield* f.fs.writeFileString(otherExecutable, 'immutable synthetic standalone executable bytes');
    expect(
      Result.isFailure(
        yield* commitMemoryArchive(f.config, plan).pipe(
          Effect.provideService(MemoryArchiveExecutable, {path: otherExecutable}),
          Effect.result,
        ),
      ),
    ).toBe(true);
    yield* f.fs.writeFileString(f.executable, 'changed executable');
    expect(Result.isFailure(yield* f.pinned(checkMemoryArchivePlan(f.config, plan)).pipe(Effect.result))).toBe(true);
    yield* f.fs.writeFileString(f.executable, 'immutable synthetic standalone executable bytes');
    yield* f.fs.writeFileString(f.config.manifestPath, 'version: 1\nprojects: []\n# changed');
    expect(Result.isFailure(yield* f.pinned(commitMemoryArchive(f.config, plan)).pipe(Effect.result))).toBe(true);
    expect(yield* f.store.read(f.location, SOURCE)).toBe(f.raw);
  }).pipe(provide),
);

effectIt.effect.each(['before-remove', 'after-remove'] as const)(
  'recovers interruption %s using the same verified plan',
  when =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const plan = yield* f.pinned(planMemoryArchive(f.config, SOURCE));
      const interrupted = ResourceStore.of({
        ...f.store,
        mutateChecked: (...args) =>
          when === 'before-remove'
            ? Effect.interrupt
            : f.store.mutateChecked(...args).pipe(Effect.andThen(Effect.interrupt)),
      });
      const exit = yield* f
        .pinned(commitMemoryArchive(f.config, plan))
        .pipe(Effect.provideService(ResourceStore, interrupted), Effect.exit);
      expect(exit._tag).toBe('Failure');
      if (exit._tag === 'Failure') expect(Cause.hasInterrupts(exit.cause)).toBe(true);
      expect(sha256HexSync(yield* f.store.read(f.location, plan.destination.uri))).toBe(plan.destination.sha256);
      const beforeCheck = yield* f.snapshot;
      expect((yield* f.pinned(checkMemoryArchivePlan(f.config, plan))).status).toBe(
        when === 'before-remove' ? 'ready' : 'already-archived',
      );
      expect(yield* f.snapshot).toEqual(beforeCheck);
      expect((yield* f.pinned(commitMemoryArchive(f.config, plan))).status).toBe(
        when === 'before-remove' ? 'archived' : 'already-archived',
      );
    }).pipe(provide),
);

effectIt.effect('refuses changed destination bytes and rechecks source CAS after the copy was stored', () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const plan = yield* f.pinned(planMemoryArchive(f.config, SOURCE));
    yield* f.store.write(f.location, plan.destination.uri, 'unrelated existing destination', {mode: 'create'});
    expect(Result.isFailure(yield* f.pinned(commitMemoryArchive(f.config, plan)).pipe(Effect.result))).toBe(true);
    expect(yield* f.store.read(f.location, SOURCE)).toBe(f.raw);
    yield* f.store.remove(f.location, plan.destination.uri);
    const changed = f.raw + '\n';
    const racing = ResourceStore.of({
      ...f.store,
      mutateChecked: (...args) =>
        f.store
          .write(f.location, SOURCE, changed, {mode: 'replace'})
          .pipe(Effect.andThen(f.store.mutateChecked(...args))),
    });
    expect(
      Result.isFailure(
        yield* f
          .pinned(commitMemoryArchive(f.config, plan))
          .pipe(Effect.provideService(ResourceStore, racing), Effect.result),
      ),
    ).toBe(true);
    expect(yield* f.store.read(f.location, SOURCE)).toBe(changed);
    expect(sha256HexSync(yield* f.store.read(f.location, plan.destination.uri))).toBe(plan.destination.sha256);
    yield* f.store.write(f.location, SOURCE, f.raw, {mode: 'replace'});
    const corruptingCopy = ResourceStore.of({
      ...f.store,
      mutateChecked: (...args) =>
        f.store
          .write(f.location, plan.destination.uri, 'copy changed before CAS', {mode: 'replace'})
          .pipe(Effect.andThen(f.store.mutateChecked(...args))),
    });
    expect(
      Result.isFailure(
        yield* f
          .pinned(commitMemoryArchive(f.config, plan))
          .pipe(Effect.provideService(ResourceStore, corruptingCopy), Effect.result),
      ),
    ).toBe(true);
    expect(yield* f.store.read(f.location, SOURCE)).toBe(f.raw);
  }).pipe(provide),
);

effectIt.effect('keeps source mode and unsupported headers read-only, and emits one closed JSON protocol result', () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const before = yield* f.snapshot;
    expect(Result.isFailure(yield* planMemoryArchive(f.config, SOURCE).pipe(Effect.result))).toBe(true);
    expect(yield* f.snapshot).toEqual(before);
    let exitCode = 0;
    const system = yield* SystemInfo;
    const testSystem = SystemInfo.of({
      ...system,
      setExitCode: code => {
        exitCode = code;
      },
    });
    const failed = yield* captureConsole(
      runMemoryArchiveProtocol(f.config, Effect.succeed({version: 1, action: 'plan', uri: SOURCE, extra: true})),
    ).pipe(Effect.provideService(SystemInfo, testSystem));
    expect(JSON.parse(failed.output)).toMatchObject({version: 1, status: 'error', code: 'invalid-request'});
    expect(exitCode).toBe(1);
    const missingManifest = yield* f
      .pinned(
        captureConsole(
          runMemoryArchiveProtocol(
            {...f.config, manifestPath: f.path.join(f.home, 'missing-manifest.yaml')},
            Effect.succeed({version: 1, action: 'plan', uri: SOURCE}),
          ),
        ),
      )
      .pipe(Effect.provideService(SystemInfo, testSystem));
    expect(JSON.parse(missingManifest.output)).toMatchObject({version: 1, status: 'error', code: 'operation-failed'});
    expect(missingManifest.output).not.toContain(f.home);
    expect(yield* f.snapshot).toEqual(before);
    const planned = yield* f.pinned(runMemoryArchiveRequest(f.config, {version: 1, action: 'plan', uri: SOURCE}));
    expect(planned.status).toBe('ok');
    if (!('plan' in planned) || !planned.plan) throw new Error('Expected plan wrapper.');
    const committed = yield* f.pinned(
      captureConsole(
        runMemoryArchiveProtocol(f.config, Effect.succeed({version: 1, action: 'commit', plan: planned.plan})),
      ),
    );
    expect(JSON.parse(committed.output)).toMatchObject({
      version: 1,
      status: 'ok',
      result: {status: 'archived', planId: planned.plan.planId},
    });
    const unsafe = yield* fixture(
      'MEMORY\nkind: durable\nstatus: active\ncustom_private_header: preserve-me\n\nSource.',
    );
    const untouched = yield* unsafe.snapshot;
    expect(Result.isFailure(yield* unsafe.pinned(planMemoryArchive(unsafe.config, SOURCE)).pipe(Effect.result))).toBe(
      true,
    );
    expect(yield* unsafe.snapshot).toEqual(untouched);
  }).pipe(provide),
);

fcEffectProp(
  effectIt,
  'bounded archive state transitions preserve source/copy CAS and replay identity',
  {
    steps: fc.array(fc.constantFrom('check', 'commit', 'interrupt', 'edit-source', 'edit-copy'), {
      minLength: 1,
      maxLength: 8,
    }),
  },
  ({steps}) =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const plan = yield* f.pinned(planMemoryArchive(f.config, SOURCE));
      const originalPlan = JSON.stringify(plan);
      let sourcePresent = true;
      let sourceCurrent = true;
      let copyPresent = false;
      let copyCurrent = true;
      for (const step of steps) {
        if (step === 'edit-source' && sourcePresent) {
          yield* f.store.write(f.location, SOURCE, f.raw + '\n', {mode: 'replace'});
          sourceCurrent = false;
        } else if (step === 'edit-copy' && copyPresent) {
          yield* f.store.write(f.location, plan.destination.uri, 'changed copy', {mode: 'replace'});
          copyCurrent = false;
        } else if (step === 'check' || step === 'commit' || step === 'interrupt') {
          const valid = sourcePresent ? sourceCurrent && (!copyPresent || copyCurrent) : copyPresent && copyCurrent;
          const program =
            step === 'check' ? checkMemoryArchivePlan(f.config, plan) : commitMemoryArchive(f.config, plan);
          const operation =
            step === 'interrupt'
              ? program.pipe(
                  Effect.provideService(
                    ResourceStore,
                    ResourceStore.of({...f.store, mutateChecked: () => Effect.interrupt}),
                  ),
                )
              : program;
          const exit = yield* f.pinned(operation).pipe(Effect.exit);
          const interrupts = valid && step === 'interrupt' && sourcePresent;
          expect(exit._tag).toBe(valid && !interrupts ? 'Success' : 'Failure');
          if (valid && step !== 'check' && sourcePresent) {
            copyPresent = true;
            if (!interrupts) sourcePresent = false;
          }
        }
        const source = yield* f.store.read(f.location, SOURCE).pipe(Effect.result);
        expect(Result.isSuccess(source)).toBe(sourcePresent);
        if (Result.isSuccess(source)) expect(source.success).toBe(sourceCurrent ? f.raw : f.raw + '\n');
        const copy = yield* f.store.read(f.location, plan.destination.uri).pipe(Effect.result);
        expect(Result.isSuccess(copy)).toBe(copyPresent);
        if (Result.isSuccess(copy)) expect(sha256HexSync(copy.success) === plan.destination.sha256).toBe(copyCurrent);
        expect(JSON.stringify(plan)).toBe(originalPlan);
      }
    }).pipe(provide),
  {fastCheck: {numRuns: 20}},
);
