import {Array as EffectArray} from 'effect';
import {isJsonObject} from '@threadnote/platform/json';
import {it as effectIt} from '@effect/vitest';
import {Effect, FileSystem, Path, Schema} from 'effect';
import {TestClock} from 'effect/testing';
import {describe, expect} from 'vitest';
import {formatMemoryDocument} from '@threadnote/memory/document';
import {runCommandEffect} from '@threadnote/platform/command';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {SystemInfo} from '@threadnote/platform/system';
import {ResourceIoFailed, ResourceStore} from '@threadnote/store/resource-store';
import {ApplicationLayer} from '../../src/effect/runtime.js';
import {runWorkflowMemory} from '../../src/workflow_memory/index.js';
import type {WorkflowRequest} from '../../src/workflow_memory/protocol.js';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {workflowPropertyDiagnostics} from './workflow-property-diagnostics.js';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

type SuccessfulWorkflowRead = {
  readonly status: 'ok';
  readonly canonicalUri: string;
  readonly revision: string;
  readonly relations: readonly unknown[];
  readonly verifiedReadback: true;
  readonly storageKind: string;
};

function assertSuccessfulWorkflowRead(value: unknown): asserts value is SuccessfulWorkflowRead {
  if (
    !isJsonObject(value) ||
    value.status !== 'ok' ||
    typeof value.canonicalUri !== 'string' ||
    typeof value.revision !== 'string' ||
    !EffectArray.isArray(value.relations) ||
    value.verifiedReadback !== true ||
    typeof value.storageKind !== 'string'
  )
    throw new Error('Expected a successful workflow read result.');
}

const rootUri = 'threadnote://user/tester/memories';
const fixture = Effect.fn('test.workflowSharedContext.fixture')(function* (cloud = false) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const system = yield* SystemInfo;
  const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-workflow-shared-context-'});
  const home = path.join(root, 'home');
  const repo = path.join(root, 'repo');
  yield* fs.makeDirectory(home);
  yield* fs.makeDirectory(repo);
  yield* runCommandEffect('git', ['init', '--initial-branch=main', repo]);
  const config = {
    account: 'local',
    agentContextHome: home,
    user: 'tester',
    agentId: 'test',
    manifestPath: path.join(home, 'manifest.json'),
  };
  const configure = (teams: readonly string[], access: 'read-only' | 'read-write' = 'read-write') =>
    Effect.gen(function* () {
      yield* fs.makeDirectory(path.join(home, 'share'), {recursive: true});
      yield* fs.writeFileString(
        path.join(home, 'share/teams.json'),
        JSON.stringify({
          version: 1,
          teams: EffectRecord.fromEntries(
            EffectArray.map(teams, name => [
              name,
              {name, access, remote: 'https://example.invalid/memories.git', worktree: repo},
            ]),
          ),
        }),
      );
    });
  if (cloud) {
    yield* configure(['personal', 'default']);
    yield* fs.makeDirectory(path.join(home, 'codex-cloud'));
    yield* fs.writeFileString(
      path.join(home, 'codex-cloud/profile.json'),
      JSON.stringify({
        version: 1,
        provider: 'codex-cloud',
        account: 'local',
        user: 'tester',
        agentId: 'test',
        teams: ['personal'],
      }),
    );
  }
  const call = (request: WorkflowRequest) =>
    runWorkflowMemory(config, request).pipe(
      Effect.provideService(SystemInfo, {...system, currentDirectory: () => repo, environment: () => ({})}),
    );
  const bound = yield* call({
    protocolVersion: 1,
    action: 'bind',
    workflowRunId: 'original-run',
    project: 'fixture',
    featureId: 'shared-context',
    generation: 'source-original',
  });
  if (!('binding' in bound)) throw new Error('Expected binding');
  const binding = bound.binding;
  const location = {account: config.account, home, user: config.user};
  const store = yield* ResourceStore;
  const seed = (uri: string, topic = 'prior-context') => {
    const memoryId = `tn_${Effect2.pipe(sha256HexSync(uri), EffectString.slice(0, 20))}`;
    const body = 'Relevant reviewed context.\n';
    const content = formatMemoryDocument(
      'MEMORY',
      {
        kind: 'durable',
        status: 'active',
        topic,
        memoryId,
        sourceAgentClient: 'test',
        timestamp: '2026-10-23T12:00:00.000Z',
      },
      body,
    );
    return store.write(location, uri, content, {mode: 'create'}).pipe(Effect.as({uri, memoryId, body, content}));
  };
  const read = (uri: string) => call({protocolVersion: 1, action: 'read', bindingId: binding.bindingId, uri});
  const write: WorkflowRequest = {
    protocolVersion: 1,
    action: 'create',
    bindingId: binding.bindingId,
    operationId: 'plan-root',
    artifactKey: 'plan-root',
    sourceRunId: 'writer',
    role: 'root',
    storageKind: 'durable',
    body: 'Private plan retaining prior context.\n',
    bodySha256: sha256HexSync('Private plan retaining prior context.\n'),
    expectedRevision: null,
  };
  const journal = () => fs.readFileString(path.join(home, 'workflow-memory', `${binding.bindingId}.json`));
  return {binding, call, config, configure, fs, home, journal, location, path, read, seed, store, write};
});

describe('workflow configured shared context', () => {
  effectIt.effect('resumes an original desktop binding to read and reference configured read-only context', () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const original = yield* f.journal();
      expect(f.binding.sharedRoots).toEqual([]);
      yield* f.configure(['default'], 'read-only');
      const source = yield* f.seed(
        `${rootUri}/shared/default/durable/projects/fixture/prior.md`,
        'workflow-published-prior',
      );
      for (const uri of [source.uri, `threadnote://memory/${source.memoryId}`]) {
        expect(yield* f.read(uri)).toMatchObject({status: 'ok', memoryId: source.memoryId, body: source.body});
      }
      expect(yield* f.journal()).toBe(original);
      for (const [index, uri] of [source.uri, `threadnote://memory/${source.memoryId}`].entries()) {
        const written: unknown = yield* f.call({
          ...f.write,
          operationId: `plan-${index}`,
          artifactKey: `plan-${index}`,
          relations: [{type: 'references', uri}],
        });
        assertSuccessfulWorkflowRead(written);
        expect(written).toMatchObject({status: 'ok', verifiedReadback: true, storageKind: 'durable'});
        expect(written.canonicalUri).toContain('/durable/projects/fixture/workflow-');
        expect(written.relations).toEqual([{type: 'references', uri: `threadnote://memory/${source.memoryId}`}]);
        expect(yield* f.read(written.canonicalUri)).toMatchObject({revision: written.revision});
      }
      expect(JSON.parse(yield* f.journal()).binding).toEqual(f.binding);
      expect(yield* f.store.read(f.location, source.uri)).toBe(source.content);
    }).pipe(TestClock.withLive, provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('recovers a prepared shared relation only while its original share remains configured', () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.configure(['default']);
      const source = yield* f.seed(`${rootUri}/shared/default/durable/projects/fixture/prior.md`);
      const request = {...f.write, relations: [{type: 'references' as const, uri: source.uri}]};
      expect(
        yield* f.call(request).pipe(
          Effect.provideService(ResourceStore, {
            ...f.store,
            writeChecked: (_location, uri) =>
              Effect.fail(
                ResourceIoFailed.make({
                  cause: new Error('Synthetic interrupted write'),
                  message: 'Synthetic interrupted write',
                  operation: 'write',
                  uri,
                }),
              ),
          }),
          Effect.result,
        ),
      ).toMatchObject({_tag: 'Failure', failure: {_tag: 'ResourceIoFailed'}});
      const prepared = yield* f.journal();
      const recover: WorkflowRequest = {
        protocolVersion: 1,
        action: 'recover',
        bindingId: f.binding.bindingId,
        operationId: f.write.operationId,
      };
      yield* f.configure([]);
      expect(yield* f.call(recover).pipe(Effect.result)).toMatchObject({
        _tag: 'Failure',
        failure: {code: 'invalid-journal'},
      });
      expect(yield* f.journal()).toBe(prepared);
      expect(yield* f.store.read(f.location, source.uri)).toBe(source.content);
      yield* f.configure(['default']);
      const written: unknown = yield* f.call(recover);
      assertSuccessfulWorkflowRead(written);
      expect(written).toMatchObject({status: 'ok', verifiedReadback: true});
      expect(yield* f.call(request)).toEqual(written);
      expect(JSON.parse(yield* f.journal()).binding).toEqual(f.binding);
      expect(yield* f.store.read(f.location, source.uri)).toBe(source.content);
    }).pipe(TestClock.withLive, provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect(
    'revokes shared reads and references when configuration is removed, without rebinding or mutation',
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* f.configure(['default']);
        const source = yield* f.seed(`${rootUri}/shared/default/durable/projects/fixture/prior.md`);
        expect(yield* f.read(source.uri)).toMatchObject({status: 'ok'});
        yield* f.configure([]);
        const original = yield* f.journal();
        for (const uri of [source.uri, `threadnote://memory/${source.memoryId}`]) {
          expect((yield* f.read(uri).pipe(Effect.result))._tag).toBe('Failure');
          expect((yield* f.call({...f.write, relations: [{type: 'references', uri}]}).pipe(Effect.result))._tag).toBe(
            'Failure',
          );
        }
        expect(yield* f.journal()).toBe(original);
        expect(yield* f.store.read(f.location, source.uri)).toBe(source.content);
      }).pipe(TestClock.withLive, provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect(
    'does not give desktop shared context mutation ownership or access to foreign private workflow artifacts',
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* f.configure(['default']);
        const source = yield* f.seed(`${rootUri}/shared/default/durable/projects/fixture/prior.md`);
        const foreign = yield* f.seed(`${rootUri}/durable/projects/fixture/workflow-foreign.md`, 'workflow-foreign');
        const foreignTopic = yield* f.seed(`${rootUri}/durable/projects/fixture/ordinary.md`, 'workflow-foreign');
        const original = yield* f.journal();
        for (const action of ['replace', 'archive'] as const) {
          expect(
            yield* f
              .call({...f.write, action, uri: source.uri, expectedRevision: sha256HexSync(source.content)})
              .pipe(Effect.result),
          ).toMatchObject({_tag: 'Failure', failure: {code: 'out-of-scope'}});
        }
        for (const uri of [
          foreign.uri,
          `threadnote://memory/${foreign.memoryId}`,
          foreignTopic.uri,
          `${rootUri}/handoffs/active/fixture/private.md`,
        ]) {
          expect((yield* f.read(uri).pipe(Effect.result))._tag).toBe('Failure');
          expect((yield* f.call({...f.write, relations: [{type: 'references', uri}]}).pipe(Effect.result))._tag).toBe(
            'Failure',
          );
        }
        expect(yield* f.journal()).toBe(original);
        expect(yield* f.store.read(f.location, source.uri)).toBe(source.content);
        expect(yield* f.store.read(f.location, foreign.uri)).toBe(foreign.content);
        expect(yield* f.store.read(f.location, foreignTopic.uri)).toBe(foreignTopic.content);
      }).pipe(TestClock.withLive, provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('rejects malformed configured team names without changing workflow or context bytes', () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const source = yield* f.seed(`${rootUri}/shared/default/durable/projects/fixture/prior.md`);
      const original = yield* f.journal();
      for (const name of ['../outside', '.', ' default', 'Default']) {
        yield* f.configure([name]);
        expect((yield* f.read(source.uri).pipe(Effect.result))._tag).toBe('Failure');
        expect(
          (yield* f.call({...f.write, relations: [{type: 'references', uri: source.uri}]}).pipe(Effect.result))._tag,
        ).toBe('Failure');
        expect(yield* f.journal()).toBe(original);
        expect(yield* f.store.read(f.location, source.uri)).toBe(source.content);
      }
    }).pipe(TestClock.withLive, provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('keeps personal cloud workflows restricted to their bound shares', () =>
    Effect.gen(function* () {
      const f = yield* fixture(true);
      const allowed = yield* f.seed(`${rootUri}/shared/personal/durable/projects/fixture/prior.md`);
      const other = yield* f.seed(`${rootUri}/shared/default/durable/projects/fixture/prior.md`);
      expect(yield* f.read(allowed.uri)).toMatchObject({status: 'ok'});
      const original = yield* f.journal();
      for (const uri of [other.uri, `threadnote://memory/${other.memoryId}`]) {
        expect((yield* f.read(uri).pipe(Effect.result))._tag).toBe('Failure');
        expect((yield* f.call({...f.write, relations: [{type: 'references', uri}]}).pipe(Effect.result))._tag).toBe(
          'Failure',
        );
      }
      expect(yield* f.journal()).toBe(original);
      expect(yield* f.store.read(f.location, other.uri)).toBe(other.content);
    }).pipe(TestClock.withLive, provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect.prop(
    'admits only exact configured desktop team namespaces without mutating reads or preflights',
    [Schema.Int.check(Schema.isBetween({minimum: 0, maximum: 1000})), Schema.Boolean],
    ([suffix, readOnly], context) => {
      const diagnostics = workflowPropertyDiagnostics(context, 'shared-context-namespace');
      return diagnostics.observe(
        readOnly ? 2 : 1,
        Effect.gen(function* () {
          diagnostics.phase('fixture');
          const f = yield* fixture();
          const team = `team-${suffix}`;
          diagnostics.phase('configure-shared');
          yield* f.configure([team], readOnly ? 'read-only' : 'read-write');
          diagnostics.phase('seed-source');
          const source = yield* f.seed(`${rootUri}/shared/${team}/durable/projects/fixture/context.md`);
          diagnostics.phase('journal-read');
          const original = yield* f.journal();
          diagnostics.phase('authorized-read');
          expect(yield* f.read(source.uri)).toMatchObject({body: source.body});
          diagnostics.phase('authorized-preflight');
          expect(
            yield* f.call({
              ...f.write,
              action: 'preflight',
              mutation: 'create',
              relations: [{type: 'references', uri: source.uri}],
            }),
          ).toMatchObject({status: 'ok'});
          for (const uri of [
            `${rootUri}/shared/${team}-extra/durable/projects/fixture/context.md`,
            `${rootUri}/shared/unconfigured/durable/projects/fixture/context.md`,
            `threadnote://user/other/memories/shared/${team}/durable/projects/fixture/context.md`,
          ]) {
            diagnostics.phase('denied-read');
            expect(yield* f.read(uri).pipe(Effect.result)).toMatchObject({
              _tag: 'Failure',
              failure: {code: 'out-of-scope'},
            });
            diagnostics.phase('denied-preflight');
            expect(
              yield* f
                .call({...f.write, action: 'preflight', mutation: 'create', relations: [{type: 'references', uri}]})
                .pipe(Effect.result),
            ).toMatchObject({_tag: 'Failure', failure: {code: 'out-of-scope'}});
          }
          diagnostics.phase('assertion');
          expect(yield* f.journal()).toBe(original);
          expect(yield* f.store.read(f.location, source.uri)).toBe(source.content);
        }).pipe(
          Effect.ensuring(Effect.sync(() => diagnostics.phase('teardown'))),
          TestClock.withLive,
          provideTestLayer(ApplicationLayer),
        ),
      );
    },
    {arbitrary: {runs: 20}},
  );
});
