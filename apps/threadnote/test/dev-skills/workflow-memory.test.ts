import {it as effectIt} from '@effect/vitest';
import {Effect, FileSystem, Path, Schema} from 'effect';
import {TestClock} from 'effect/testing';
import {describe, expect} from 'vitest';
import {runCommandEffect} from '@threadnote/platform/command';
import {SystemInfo} from '@threadnote/platform/system';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {ResourceIoFailed, ResourceStore} from '@threadnote/store/resource-store';
import {ApplicationLayer} from '../../src/effect/runtime.js';
import {runWorkflowMemory} from '../../src/workflow_memory/index.js';
import type {WorkflowBinding, WorkflowRequest, WorkflowProfile} from '../../src/workflow_memory/protocol.js';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {workflowPropertyDiagnostics} from './workflow-property-diagnostics.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';
import {Array as EffectArray, Option as EffectOption} from 'effect';

const JsonRecordSchema = Schema.Record(Schema.String, Schema.Unknown);
const withRest = <const S extends Schema.StructWithRest.Objects>(schema: S) =>
  Schema.StructWithRest(schema, [JsonRecordSchema]);
const WorkflowReadSummarySchema = withRest(
  Schema.Struct({
    canonicalUri: Schema.String,
    memoryId: Schema.optionalKey(Schema.String),
    revision: Schema.String,
    state: Schema.String,
    storageKind: Schema.String,
    verifiedReadback: Schema.Literal(true),
  }),
);
const ProfileSchema = withRest(Schema.Struct({user: Schema.String}));
const readResult = Schema.decodeUnknownSync(WorkflowReadSummarySchema);
const decodeProfile = Schema.decodeUnknownSync(ProfileSchema);

const fixture = Effect.fn('test.workflowMemory.fixture')(function* (profile: WorkflowProfile = 'desktop') {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const system = yield* SystemInfo;
  const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-workflow-memory-'});
  const home = path.join(root, 'home');
  const repo = path.join(root, 'repo');
  yield* fs.makeDirectory(home);
  yield* fs.makeDirectory(repo);
  yield* runCommandEffect('git', ['init', '--initial-branch=main', repo]);
  const config = {
    account: 'local',
    agentContextHome: home,
    agentId: 'test',
    user: 'tester',
    manifestPath: path.join(home, 'manifest.json'),
  };
  const environment: Record<string, string> = {};
  const worktree = path.join(root, 'shared');
  if (profile !== 'desktop') {
    const remote = path.join(root, 'remote.git');
    const git = (cwd: string, args: readonly string[]) => runCommandEffect('git', ['-C', cwd, ...args]);
    yield* git(root, ['init', '--bare', '--initial-branch=main', remote]);
    yield* git(root, ['clone', remote, worktree]);
    yield* git(worktree, ['config', 'user.email', 'test@example.invalid']);
    yield* git(worktree, ['config', 'user.name', 'Workflow Test']);
    yield* fs.writeFileString(path.join(worktree, 'README.md'), 'Fixture\n');
    yield* git(worktree, ['add', 'README.md']);
    yield* git(worktree, ['commit', '-m', 'seed']);
    yield* git(worktree, ['push', 'origin', 'main']);
    yield* fs.makeDirectory(path.join(home, 'share'));
    yield* fs.writeFileString(
      path.join(home, 'share/teams.json'),
      JSON.stringify({
        version: 1,
        teams: {
          personal: {name: 'personal', access: 'read-write', remote, worktree, gitdir: path.join(worktree, '.git')},
        },
      }),
    );
    const provider = profile === 'codex-cloud-personal' ? 'codex-cloud' : 'cursor-cloud';
    yield* fs.makeDirectory(path.join(home, provider));
    yield* fs.writeFileString(
      path.join(home, provider, 'profile.json'),
      JSON.stringify({
        version: 1,
        provider,
        account: config.account,
        agentId: config.agentId,
        user: config.user,
        ...(provider === 'codex-cloud' ? {teams: ['personal']} : {}),
      }),
    );
    if (provider === 'cursor-cloud') environment.THREADNOTE_CURSOR_CLOUD_TEAM = 'personal';
  }
  const call = (input: WorkflowRequest) =>
    runWorkflowMemory(config, input).pipe(
      Effect.provideService(SystemInfo, {...system, currentDirectory: () => repo, environment: () => environment}),
    );
  const bound = yield* call({
    protocolVersion: 1,
    action: 'bind',
    workflowRunId: 'workflow-1234567890',
    project: 'fixture',
    featureId: 'feature',
    generation: 'bundle-v1',
  });
  if (!('binding' in bound)) throw new Error('Expected a binding');
  const binding: WorkflowBinding = bound.binding;
  const body = 'Private plan — 仕様\n';
  const write: WorkflowRequest = {
    protocolVersion: 1,
    action: 'create',
    bindingId: binding.bindingId,
    operationId: 'create-1',
    artifactKey: 'plan-root',
    sourceRunId: 'writer-plan',
    role: 'root',
    body,
    bodySha256: sha256HexSync(body),
    expectedRevision: null,
  };
  return {fs, path, config, call, binding, write, home, repo, system, environment, worktree};
});

describe('private workflow artifact protocol', () => {
  for (const profile of ['codex-cloud-personal', 'cursor-cloud-personal'] as const) {
    effectIt.effect(`keeps ${profile} planning private and rejects profile drift`, () =>
      Effect.gen(function* () {
        const f = yield* fixture(profile);
        const before = (yield* runCommandEffect('git', ['-C', f.worktree, 'rev-parse', 'HEAD'])).stdout;
        const current = readResult(yield* f.call({...f.write, role: 'current', storageKind: 'durable'}));
        expect(current).toMatchObject({storageKind: 'handoff', state: 'active'});
        expect(current.canonicalUri).toContain('/handoffs/active/');
        const plan = readResult(
          yield* f.call({
            ...f.write,
            operationId: 'plan',
            artifactKey: 'plan',
            relations: [{type: 'depends_on', uri: `threadnote://memory/${current.memoryId}`}],
          }),
        );
        expect(plan.verifiedReadback).toBe(true);
        expect((yield* runCommandEffect('git', ['-C', f.worktree, 'status', '--porcelain'])).stdout).toBe('');
        expect((yield* runCommandEffect('git', ['-C', f.worktree, 'rev-parse', 'HEAD'])).stdout).toBe(before);
        const journalPath = f.path.join(f.home, 'workflow-memory', `${f.binding.bindingId}.json`);
        const privateState = yield* f.fs.readFileString(journalPath);
        expect(
          yield* f
            .call({
              protocolVersion: 1,
              action: 'archive',
              bindingId: f.binding.bindingId,
              operationId: 'premature-archive',
              artifactKey: 'plan',
              sourceRunId: f.write.sourceRunId,
              role: f.write.role,
              uri: plan.canonicalUri,
              expectedRevision: plan.revision,
            })
            .pipe(Effect.result),
        ).toMatchObject({_tag: 'Failure', failure: {code: 'publication-incomplete'}});
        for (const uri of [
          'threadnote://user/tester/memories/durable/projects/fixture/private.md',
          'threadnote://user/tester/memories/preferences/private.md',
          'threadnote://memory/tn_0123456789abcdef0123',
        ]) {
          const denied = yield* f
            .call({
              ...f.write,
              operationId: 'foreign-relation',
              artifactKey: 'foreign-relation',
              relations: [{type: 'references', uri}],
            })
            .pipe(Effect.result);
          expect(denied._tag).toBe('Failure');
          if (!Effect2.pipe(uri, EffectString.startsWith('threadnote://memory/')))
            expect(denied).toMatchObject({failure: {code: 'out-of-scope'}});
        }
        expect(yield* f.fs.readFileString(journalPath)).toBe(privateState);
        expect(
          yield* f.call({protocolVersion: 1, action: 'read', bindingId: f.binding.bindingId, uri: plan.canonicalUri}),
        ).toMatchObject({state: 'active', revision: plan.revision});
        const profilePath = f.path.join(
          f.home,
          profile === 'codex-cloud-personal' ? 'codex-cloud' : 'cursor-cloud',
          'profile.json',
        );
        const saved = decodeProfile(JSON.parse(yield* f.fs.readFileString(profilePath)));
        yield* f.fs.writeFileString(profilePath, JSON.stringify({...saved, user: 'different-owner'}));
        expect(
          yield* f
            .call({protocolVersion: 1, action: 'read', bindingId: f.binding.bindingId, uri: plan.canonicalUri})
            .pipe(Effect.result),
        ).toMatchObject({_tag: 'Failure', failure: {code: 'identity-drift'}});
      }).pipe(TestClock.withLive, provideTestLayer(ApplicationLayer)),
    );
  }
  // Exhaust the finite retry domain without repeating whole native fixtures
  // under a single property-test deadline.
  effectIt.effect.each([1, 2, 3, 4])(
    'replaying completed operations never resurrects retired state (replay count: %i)',
    (retries, context) => {
      const diagnostics = workflowPropertyDiagnostics(context, 'workflow-retirement');
      return diagnostics.observe(
        retries,
        Effect.gen(function* () {
          diagnostics.phase('fixture');
          const f = yield* fixture();
          diagnostics.phase('create');
          const written = readResult(yield* f.call(f.write));
          for (let index = 0; index < retries; index++) {
            diagnostics.phase('write-replay', index);
            expect(yield* f.call(f.write)).toEqual(written);
          }
          const archive: WorkflowRequest = {
            protocolVersion: 1,
            action: 'archive',
            bindingId: f.binding.bindingId,
            operationId: 'retire',
            artifactKey: f.write.artifactKey,
            sourceRunId: f.write.sourceRunId,
            role: f.write.role,
            uri: written.canonicalUri,
            expectedRevision: written.revision,
          };
          diagnostics.phase('archive');
          const retired = yield* f.call(archive);
          for (let index = 0; index < retries; index++) {
            diagnostics.phase('retired-write-replay', index);
            expect(yield* f.call(f.write).pipe(Effect.result)).toMatchObject({
              _tag: 'Failure',
              failure: {code: 'operation-superseded'},
            });
            diagnostics.phase('archive-replay', index);
            expect(yield* f.call(archive)).toEqual(retired);
          }
          diagnostics.phase('read-assertion');
          expect(
            yield* f.call({
              protocolVersion: 1,
              action: 'read',
              bindingId: f.binding.bindingId,
              uri: written.canonicalUri,
            }),
          ).toMatchObject({status: 'not-found'});
        }).pipe(
          Effect.ensuring(Effect.sync(() => diagnostics.phase('teardown'))),
          TestClock.withLive,
          provideTestLayer(ApplicationLayer),
        ),
      );
    },
  );

  effectIt.effect('previews without creating an artifact and replays an exact native write', () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const store = yield* ResourceStore;
      const preview = yield* f.call({...f.write, action: 'preflight', mutation: 'create'});
      if (!('canonicalUri' in preview)) throw new Error('Expected preview URI');
      expect(
        yield* f.call({protocolVersion: 1, action: 'read', bindingId: f.binding.bindingId, uri: preview.canonicalUri}),
      ).toMatchObject({status: 'not-found'});
      const written = readResult(yield* f.call(f.write));
      const journalPath = f.path.join(f.home, 'workflow-memory', `${f.binding.bindingId}.json`);
      const journalBeforeReplay = yield* f.fs.readFileString(journalPath);
      const artifactBeforeReplay = yield* store.read(
        {account: f.config.account, home: f.home, user: f.config.user},
        written.canonicalUri,
      );
      const repeated = yield* f.call(f.write);
      expect(repeated).toEqual(written);
      expect(yield* f.fs.readFileString(journalPath)).toBe(journalBeforeReplay);
      expect(
        yield* store.read({account: f.config.account, home: f.home, user: f.config.user}, written.canonicalUri),
      ).toBe(artifactBeforeReplay);
      expect(written).toMatchObject({
        status: 'ok',
        state: 'active',
        body: f.write.body,
        storageKind: 'handoff',
        verifiedReadback: true,
      });
      const changed = yield* f
        .call({...f.write, body: 'Changed\n', bodySha256: sha256HexSync('Changed\n')})
        .pipe(Effect.result);
      expect(changed).toMatchObject({_tag: 'Failure', failure: {code: 'operation-intent-conflict'}});
      const changedWriter = yield* f.call({...f.write, sourceRunId: 'different-writer'}).pipe(Effect.result);
      expect(changedWriter).toMatchObject({_tag: 'Failure', failure: {code: 'operation-intent-conflict'}});
      expect(yield* f.fs.readFileString(journalPath)).toBe(journalBeforeReplay);
      expect(
        yield* store.read({account: f.config.account, home: f.home, user: f.config.user}, written.canonicalUri),
      ).toBe(artifactBeforeReplay);
      const absent = yield* f
        .call({protocolVersion: 1, action: 'recover', bindingId: f.binding.bindingId, operationId: 'never-invoked'})
        .pipe(Effect.result);
      expect(absent).toMatchObject({_tag: 'Failure', failure: {code: 'operation-not-found'}});
    }).pipe(TestClock.withLive, provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('reports invalid identifiers and URIs without changing private state', () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const journalPath = f.path.join(f.home, 'workflow-memory', `${f.binding.bindingId}.json`);
      const before = yield* f.fs.readFileString(journalPath);
      for (const request of [
        {...f.write, operationId: '../escape'},
        {...f.write, artifactKey: ''},
        {protocolVersion: 1 as const, action: 'read' as const, bindingId: f.binding.bindingId, uri: 'file:///private'},
        {protocolVersion: 1 as const, action: 'read' as const, bindingId: f.binding.bindingId},
      ])
        expect(yield* f.call(request).pipe(Effect.result)).toMatchObject({
          _tag: 'Failure',
          failure: {code: 'invalid-request'},
        });
      expect(yield* f.fs.readFileString(journalPath)).toBe(before);
    }).pipe(TestClock.withLive, provideTestLayer(ApplicationLayer)),
  );

  for (const conflict of ['same destination', 'pending relation target'] as const) {
    effectIt.effect(`preserves unfinished operations when changing ${conflict}`, () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        const store = yield* ResourceStore;
        const target =
          conflict === 'pending relation target'
            ? readResult(yield* f.call({...f.write, operationId: 'target', artifactKey: 'target'}))
            : undefined;
        const pending: WorkflowRequest = {
          ...f.write,
          ...(target ? {relations: [{type: 'references', uri: target.canonicalUri}]} : {}),
        };
        const preview = yield* f.call({...pending, action: 'preflight', mutation: 'create'});
        if (!('canonicalUri' in preview)) throw new Error('Expected preview URI');
        expect(
          yield* f.call(pending).pipe(
            Effect.provideService(ResourceStore, {
              ...store,
              writeChecked: (_location, uri) =>
                Effect.fail(
                  ResourceIoFailed.make({
                    cause: new Error('Injected checked-write failure'),
                    message: 'Injected checked-write failure',
                    operation: 'write',
                    uri,
                  }),
                ),
            }),
            Effect.result,
          ),
        ).toMatchObject({_tag: 'Failure', failure: {_tag: 'ResourceIoFailed'}});
        const journalPath = f.path.join(f.home, 'workflow-memory', `${f.binding.bindingId}.json`);
        const before = yield* f.fs.readFileString(journalPath);
        const conflicting: WorkflowRequest = target
          ? {
              protocolVersion: 1,
              action: 'archive',
              bindingId: f.binding.bindingId,
              operationId: 'retire-target',
              artifactKey: 'target',
              sourceRunId: f.write.sourceRunId,
              role: f.write.role,
              uri: target.canonicalUri,
              expectedRevision: target.revision,
            }
          : {...f.write, operationId: 'different-create'};
        expect(yield* f.call(conflicting).pipe(Effect.result)).toMatchObject({
          _tag: 'Failure',
          failure: {code: 'operation-transition-conflict'},
        });
        expect(yield* f.fs.readFileString(journalPath)).toBe(before);
        expect(
          yield* f.call({
            protocolVersion: 1,
            action: 'read',
            bindingId: f.binding.bindingId,
            uri: preview.canonicalUri,
          }),
        ).toMatchObject({status: 'not-found'});
        if (target)
          expect(
            yield* f.call({
              protocolVersion: 1,
              action: 'read',
              bindingId: f.binding.bindingId,
              uri: target.canonicalUri,
            }),
          ).toMatchObject({state: 'active', revision: target.revision});
        const recovered = yield* f.call({
          protocolVersion: 1,
          action: 'recover',
          bindingId: f.binding.bindingId,
          operationId: pending.operationId,
        });
        expect(recovered).toMatchObject({status: 'ok', canonicalUri: preview.canonicalUri, body: pending.body});
        expect(yield* f.call(pending)).toEqual(recovered);
      }).pipe(TestClock.withLive, provideTestLayer(ApplicationLayer)),
    );
  }

  effectIt.effect('rejects workflow sentinel identity changes before persisting intent', () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const journalPath = f.path.join(f.home, 'workflow-memory', `${f.binding.bindingId}.json`);
      const before = yield* f.fs.readFileString(journalPath);
      const record = {
        schemaVersion: 1,
        planId: f.binding.featureId,
        project: f.binding.project,
        kind: f.write.role,
        runId: f.write.sourceRunId,
      };
      for (const change of [{planId: 'foreign'}, {project: 'foreign'}, {kind: 'target'}, {runId: 'foreign'}]) {
        const body = `Private draft\n\n<!-- dev-plan:v1 ${JSON.stringify({...record, ...change})} -->\n`;
        expect(yield* f.call({...f.write, body, bodySha256: sha256HexSync(body)}).pipe(Effect.result)).toMatchObject({
          _tag: 'Failure',
          failure: {code: 'artifact-identity-conflict'},
        });
      }
      expect(yield* f.fs.readFileString(journalPath)).toBe(before);
      const body = `Private draft\n\n<!-- dev-plan:v1 ${JSON.stringify(record)} -->\n`;
      expect(yield* f.call({...f.write, body, bodySha256: sha256HexSync(body)})).toMatchObject({status: 'ok'});
    }).pipe(TestClock.withLive, provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('enforces replace/archive revisions and recovers the exact archive destination', () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const original = readResult(yield* f.call(f.write));
      const replace = {
        ...f.write,
        action: 'replace' as const,
        operationId: 'replace-1',
        uri: original.canonicalUri,
        expectedRevision: original.revision,
        body: 'Updated\n',
        bodySha256: sha256HexSync('Updated\n'),
      };
      const updated = readResult(yield* f.call(replace));
      expect(updated.memoryId).toBe(original.memoryId);
      expect(updated.canonicalUri).toBe(original.canonicalUri);
      const stale = yield* f.call({...replace, operationId: 'stale-replace'}).pipe(Effect.result);
      expect(stale).toMatchObject({_tag: 'Failure', failure: {code: 'revision-conflict'}});
      const archive: WorkflowRequest = {
        protocolVersion: 1,
        action: 'archive',
        bindingId: f.binding.bindingId,
        operationId: 'archive-1',
        artifactKey: f.write.artifactKey,
        sourceRunId: f.write.sourceRunId,
        role: f.write.role,
        uri: updated.canonicalUri,
        expectedRevision: updated.revision,
      };
      const archived = readResult(yield* f.call(archive));
      expect(archived).toMatchObject({state: 'archived', memoryId: original.memoryId, body: 'Updated\n'});
      expect(
        yield* f.call({
          protocolVersion: 1,
          action: 'recover',
          bindingId: f.binding.bindingId,
          operationId: 'archive-1',
        }),
      ).toEqual(archived);
      expect(
        yield* f.call({protocolVersion: 1, action: 'read', bindingId: f.binding.bindingId, uri: updated.canonicalUri}),
      ).toMatchObject({status: 'not-found'});
    }).pipe(TestClock.withLive, provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('rejects foreign workflow reads, relations and mutation without changing the source', () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const first = readResult(yield* f.call(f.write));
      const other = yield* f.call({
        protocolVersion: 1,
        action: 'bind',
        workflowRunId: 'another-workflow',
        project: 'fixture',
        featureId: 'feature',
        generation: 'bundle-v1',
      });
      if (!('binding' in other)) throw new Error('Expected binding');
      const read = yield* f
        .call({protocolVersion: 1, action: 'read', bindingId: other.binding.bindingId, uri: first.canonicalUri})
        .pipe(Effect.result);
      expect(read).toMatchObject({_tag: 'Failure', failure: {code: 'out-of-scope'}});
      const relation = yield* f
        .call({
          ...f.write,
          bindingId: other.binding.bindingId,
          relations: [{type: 'depends_on', uri: `threadnote://memory/${first.memoryId}`}],
        })
        .pipe(Effect.result);
      expect(relation._tag).toBe('Failure');
      const replace = yield* f
        .call({
          ...f.write,
          action: 'replace',
          bindingId: other.binding.bindingId,
          uri: first.canonicalUri,
          expectedRevision: first.revision,
        })
        .pipe(Effect.result);
      expect(replace).toMatchObject({_tag: 'Failure', failure: {code: 'out-of-scope'}});
      expect(
        yield* f.call({protocolVersion: 1, action: 'read', bindingId: f.binding.bindingId, uri: first.canonicalUri}),
      ).toMatchObject({revision: first.revision});
    }).pipe(TestClock.withLive, provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('reports missing private manifests as task-state loss instead of recreating them', () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const store = yield* ResourceStore;
      const root = `threadnote://user/tester/memories/handoffs/active/fixture`;
      const entries = yield* store.list({account: f.config.account, home: f.home, user: f.config.user}, root);
      const manifest = EffectOption.getOrUndefined(
        EffectArray.findFirst(
          entries,
          __effectArrayValue =>
            !!(entry => Effect2.pipe(entry.uri, EffectString.endsWith('-manifest.md')))(__effectArrayValue),
        ),
      )!;
      yield* store.remove({account: f.config.account, home: f.home, user: f.config.user}, manifest.uri);
      const result = yield* f.call(f.write).pipe(Effect.result);
      expect(result).toMatchObject({_tag: 'Failure', failure: {code: 'task-state-lost'}});
    }).pipe(TestClock.withLive, provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('rejects excluded cloud selectors even with a saved personal profile', () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.fs.makeDirectory(f.path.join(f.home, 'cursor-cloud'));
      yield* f.fs.writeFileString(
        f.path.join(f.home, 'cursor-cloud/profile.json'),
        JSON.stringify({
          version: 1,
          provider: 'cursor-cloud',
          account: f.config.account,
          agentId: f.config.agentId,
          user: f.config.user,
        }),
      );
      const result = yield* runWorkflowMemory(f.config, {
        protocolVersion: 1,
        action: 'bind',
        workflowRunId: 'cloud-run',
        project: 'fixture',
        featureId: 'feature',
        generation: 'bundle-v1',
      }).pipe(
        Effect.provideService(SystemInfo, {
          ...f.system,
          currentDirectory: () => f.repo,
          environment: () => ({THREADNOTE_CURSOR_CLOUD_MODE: 'org'}),
        }),
        Effect.result,
      );
      expect(result).toMatchObject({_tag: 'Failure', failure: {code: 'unsupported-profile'}});
    }).pipe(TestClock.withLive, provideTestLayer(ApplicationLayer)),
  );
});
