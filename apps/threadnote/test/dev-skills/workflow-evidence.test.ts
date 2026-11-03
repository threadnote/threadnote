import {it as effectIt} from '@effect/vitest';
import {Database} from 'bun:sqlite';
import {Effect, FileSystem, Path, Schema, Tracer} from 'effect';
import {TestClock} from 'effect/testing';
import {describe, expect} from 'vitest';
import {runCommandEffect} from '@threadnote/platform/command';
import {withExclusiveFileLock} from '@threadnote/platform/file/lock';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {SystemInfo} from '@threadnote/platform/system';
import {formatMemoryDocument, parseMemoryDocument} from '@threadnote/memory/document';
import {ResourceIoFailed, ResourceStore} from '@threadnote/store/resource-store';
import {
  expireRecallIndexValidation,
  recallIndexDatabaseFilename,
  withRecallIdentityAdmission,
  loadRecallMemoryIdentities,
} from '@threadnote/recall/index';
import {resourceAccountMutationLockPath, resourceAccountMutationLockPolicy} from '@threadnote/store/resource/lock';
import {CurrentResourceRecallInvalidationObserver} from '@threadnote/store/resource/recall-invalidation';
import {ApplicationLayer} from '../../src/effect/runtime.js';
import {verifyWorkflowEvidence, withWorkflowEvidenceAdmission} from '../../src/workflow_memory/evidence.js';
import {verifyAuthoredMemoryRelationTargetIdentities} from '../../src/memory/relations.js';
import {runWorkflowMemory} from '../../src/workflow_memory/index.js';
import type {WorkflowRequest} from '../../src/workflow_memory/protocol.js';
import {provideTestLayer} from '../helpers/effect-layer.js';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

const rootUri = 'threadnote://user/tester/memories';
const WorkflowReadResultEvidenceSchema = Schema.StructWithRest(
  Schema.Struct({
    status: Schema.Literal('ok'),
    canonicalUri: Schema.String,
    memoryId: Schema.String,
    revision: Schema.String,
    body: Schema.String,
    verifiedReadback: Schema.Literal(true),
    relations: Schema.Array(Schema.Struct({type: Schema.String, uri: Schema.String})),
  }),
  [Schema.Record(Schema.String, Schema.Unknown)],
);
const decodeWorkflowReadResult = Schema.decodeUnknownEffect(WorkflowReadResultEvidenceSchema);

const fixture = Effect.fn('test.workflowEvidence.fixture')(function* (cloud = false) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const system = yield* SystemInfo;
  const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-workflow-evidence-'});
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
  if (cloud) {
    yield* fs.makeDirectory(path.join(home, 'share'));
    yield* fs.writeFileString(
      path.join(home, 'share/teams.json'),
      JSON.stringify({
        version: 1,
        teams: {
          personal: {
            name: 'personal',
            access: 'read-write',
            remote: 'https://example.invalid/memories.git',
            worktree: repo,
          },
          default: {
            name: 'default',
            access: 'read-write',
            remote: 'https://example.invalid/memories.git',
            worktree: repo,
          },
        },
      }),
    );
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
  const bind = (run: string) =>
    call({
      protocolVersion: 1,
      action: 'bind',
      workflowRunId: run,
      project: 'fixture',
      featureId: 'evidence',
      generation: `generation-${run}`,
    });
  const store = yield* ResourceStore;
  const location = {account: config.account, home, user: config.user};
  const create = (
    bindingId: string,
    operationId: string,
    storageKind: 'handoff' | 'durable',
    body: string,
    relations: readonly {type: 'references'; uri: string}[] = [],
  ) =>
    call({
      protocolVersion: 1,
      action: 'create',
      bindingId,
      operationId,
      artifactKey: operationId,
      sourceRunId: 'source',
      role: 'root',
      storageKind,
      body,
      bodySha256: sha256HexSync(body),
      expectedRevision: null,
      relations,
    });
  const seedProjectMemory = (project: string) => {
    const uri = `${rootUri}/durable/projects/${project}/prior.md`;
    const memoryId = `tn_${Effect2.pipe(sha256HexSync(uri), EffectString.slice(0, 20))}`;
    const body = `Context for ${project}.\n`;
    const content = formatMemoryDocument(
      'MEMORY',
      {
        kind: 'durable',
        status: 'active',
        topic: 'prior-context',
        project,
        memoryId,
        sourceAgentClient: 'test',
        timestamp: '2026-10-23T12:00:00.000Z',
      },
      body,
    );
    return store.write(location, uri, content, {mode: 'create'}).pipe(Effect.as({uri, memoryId, body, content}));
  };
  const journal = (bindingId: string) => fs.readFileString(path.join(home, 'workflow-memory', `${bindingId}.json`));
  return {bind, call, config, create, fs, home, journal, location, path, seedProjectMemory, store};
});

const evidence = (uri: string, memoryId: string, revision: string) => ({uri, memoryId, revision});
const failure = <A, E, R>(effect: Effect.Effect<A, E, R>) => effect.pipe(Effect.result);

describe('prepared workflow evidence admission', () => {
  for (const kind of ['evidence', 'relation'] as const)
    for (const boundary of ['lexical', 'sqlite', 'recovery-canonical'] as const)
      effectIt.effect(`preserves busy during second-stage ${kind} ${boundary} preparation contention`, () =>
        Effect.gen(function* () {
          const f = yield* fixture();
          const bound = yield* f.bind('second-stage-contention');
          if (!('binding' in bound)) throw new Error('Expected consumer binding');
          const prior = yield* f.seedProjectMemory('fixture');
          const refs = [evidence(prior.uri, prior.memoryId, sha256HexSync(prior.content))];
          const verify = Effect.gen(function* () {
            if (kind === 'evidence') yield* verifyWorkflowEvidence(f.config, bound.binding, refs);
            else
              yield* verifyAuthoredMemoryRelationTargetIdentities(f.config, [{...prior, allowedUriScopes: [rootUri]}]);
          });
          const database = f.path.join(f.home, 'indexes', 'lexical', recallIndexDatabaseFilename(false));
          const contended =
            boundary === 'recovery-canonical'
              ? Effect.sync(() => {
                  const db = new Database(database);
                  try {
                    db.run("UPDATE metadata SET value = 'incompatible' WHERE key = 'schema_version'");
                  } finally {
                    db.close();
                  }
                }).pipe(
                  Effect.andThen(
                    withExclusiveFileLock(
                      f.fs,
                      resourceAccountMutationLockPath(f.path, f.home, f.config.account),
                      resourceAccountMutationLockPolicy,
                      verify,
                    ),
                  ),
                )
              : boundary === 'lexical'
                ? withExclusiveFileLock(
                    f.fs,
                    f.path.join(f.home, 'locks', 'indexes', 'lexical', recallIndexDatabaseFilename(false) + '.lock'),
                    resourceAccountMutationLockPolicy,
                    verify,
                  )
                : Effect.acquireUseRelease(
                    Effect.sync(() => {
                      const db = new Database(database);
                      db.exec('PRAGMA journal_mode=DELETE; BEGIN EXCLUSIVE');
                      return db;
                    }),
                    () => verify,
                    db =>
                      Effect.sync(() => {
                        db.exec('ROLLBACK');
                        db.close();
                      }),
                  );
          let entered = false;
          const started = performance.now();
          const result = yield* failure(
            withRecallIdentityAdmission(
              f.config,
              expireRecallIndexValidation(f.home, false).pipe(Effect.andThen(contended)),
              () =>
                Effect.sync(() => {
                  entered = true;
                }),
            ),
          );
          expect(result).toMatchObject({_tag: 'Failure', failure: {_tag: 'RecallIdentityAdmissionBusy'}});
          expect(entered).toBe(false);
          expect(performance.now() - started).toBeLessThan(4000);
          expect(yield* f.store.read(f.location, prior.uri)).toBe(prior.content);
        }).pipe(TestClock.withLive, provideTestLayer(ApplicationLayer)),
      );

  for (const writer of ['marker', 'pointer-recovery'] as const)
    effectIt.effect(`excludes ${writer} publication from the final pinned-byte window`, () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        const bound = yield* f.bind('final-byte-publication');
        if (!('binding' in bound)) throw new Error('Expected consumer binding');
        const prior = yield* f.seedProjectMemory('fixture');
        const refs = [evidence(prior.uri, prior.memoryId, sha256HexSync(prior.content))];
        const destination = 'threadnote://resources/final-byte-publication/result.md';
        const database = f.path.join(f.home, 'indexes', 'lexical', recallIndexDatabaseFilename(false));
        let marker: string | undefined;
        let injected = false;
        const publication = Effect.gen(function* () {
          injected = true;
          if (writer === 'marker') return yield* expireRecallIndexValidation(f.home, false);
          return yield* Effect.sync(() => {
            const db = new Database(database);
            try {
              db.run("UPDATE metadata SET value = 'incompatible' WHERE key = 'schema_version'");
            } finally {
              db.close();
            }
          }).pipe(
            Effect.andThen(
              loadRecallMemoryIdentities(f.config, {
                allowedUriScopes: [rootUri],
                memoryIds: [prior.memoryId],
                validateNow: true,
              }),
            ),
            Effect.asVoid,
          );
        });
        const result = yield* failure(
          withWorkflowEvidenceAdmission(f.config, bound.binding, refs, [], check =>
            Effect.gen(function* () {
              marker = yield* f.fs.readFileString(database + '.stale');
              return yield* f.store.writeChecked(
                f.location,
                destination,
                'result',
                {mode: 'create'},
                check.pipe(Effect.andThen(publication)),
              );
            }),
          ),
        );
        expect(result).toMatchObject({_tag: 'Failure', failure: {_tag: 'FileLockTimeout', category: 'recall-index'}});
        expect(injected).toBe(true);
        expect(yield* f.store.stat(f.location, destination).pipe(Effect.result)).toMatchObject({_tag: 'Failure'});
        expect(yield* f.fs.readFileString(database + '.stale')).toBe(marker);
        expect(yield* f.fs.exists(EffectString.replace(/\.sqlite$/, '.pointer.json')(database))).toBe(false);
      }).pipe(TestClock.withLive, provideTestLayer(ApplicationLayer)),
    );

  effectIt.effect('coordinates cross-account invalidation and inherited post-write invalidation fibers', () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const bound = yield* f.bind('account-publication');
      if (!('binding' in bound)) throw new Error('Expected consumer binding');
      const prior = yield* f.seedProjectMemory('fixture');
      const refs = [evidence(prior.uri, prior.memoryId, sha256HexSync(prior.content))];
      const database = f.path.join(f.home, 'indexes', 'lexical', recallIndexDatabaseFilename(false));
      const events: {account: string; inactive: boolean; succeeded: boolean}[] = [];
      yield* withWorkflowEvidenceAdmission(f.config, bound.binding, refs, [], check =>
        Effect.gen(function* () {
          const marker = yield* f.fs.readFileString(database + '.stale');
          yield* f.store.write(
            {...f.location, account: 'another-account'},
            'threadnote://resources/other.md',
            'other',
            {mode: 'create'},
          );
          expect(yield* f.fs.readFileString(database + '.stale')).toBe(marker);
          yield* f.store.writeChecked(
            f.location,
            'threadnote://resources/admitted.md',
            'admitted',
            {mode: 'create'},
            check,
          );
        }),
      ).pipe(
        Effect.provideService(CurrentResourceRecallInvalidationObserver, {
          begin: (location, _uris, _transition, inactive) => succeeded => {
            events.push({account: location.account, inactive, succeeded});
          },
        }),
      );
      expect(events).toEqual(
        expect.arrayContaining([
          {account: 'another-account', inactive: false, succeeded: false},
          {account: 'another-account', inactive: true, succeeded: true},
          {account: f.location.account, inactive: false, succeeded: true},
          {account: f.location.account, inactive: true, succeeded: true},
        ]),
      );
      expect(yield* f.store.read(f.location, prior.uri)).toBe(prior.content);
    }).pipe(TestClock.withLive, provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('requires fresh admission for each child after a canonical commit', () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const bound = yield* f.bind('prepared-children');
      if (!('binding' in bound)) throw new Error('Expected consumer binding');
      const prior = yield* f.seedProjectMemory('fixture');
      const refs = [evidence(prior.uri, prior.memoryId, sha256HexSync(prior.content))];
      const firstUri = 'threadnote://resources/prepared-children/first.md';
      const secondUri = 'threadnote://resources/prepared-children/second.md';

      yield* withWorkflowEvidenceAdmission(f.config, bound.binding, refs, [], check =>
        Effect.gen(function* () {
          yield* f.store.writeChecked(f.location, firstUri, 'first', {mode: 'create'}, check);
          expect(
            yield* failure(f.store.writeChecked(f.location, secondUri, 'second', {mode: 'create'}, check)),
          ).toMatchObject({_tag: 'Failure'});
          expect(yield* failure(f.store.stat(f.location, secondUri))).toMatchObject({_tag: 'Failure'});
        }),
      );

      yield* withWorkflowEvidenceAdmission(f.config, bound.binding, refs, [], check =>
        f.store.writeChecked(f.location, secondUri, 'second', {mode: 'create'}, check),
      );
      expect(yield* f.store.read(f.location, firstUri)).toBe('first');
      expect(yield* f.store.read(f.location, secondUri)).toBe('second');
      expect(yield* f.store.read(f.location, prior.uri)).toBe(prior.content);
    }).pipe(TestClock.withLive, provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect.prop(
    'refuses a prepared commit after any canonical or marker-only invalidation',
    {mutations: Schema.Array(Schema.Literals(['canonical', 'marker'])).check(Schema.isMaxLength(4))},
    ({mutations}) =>
      Effect.gen(function* () {
        const f = yield* fixture();
        const bound = yield* f.bind('prepared-invalidation');
        if (!('binding' in bound)) throw new Error('Expected consumer binding');
        const prior = yield* f.seedProjectMemory('fixture');
        const refs = [evidence(prior.uri, prior.memoryId, sha256HexSync(prior.content))];
        const destination = 'threadnote://resources/prepared-invalidation/result.md';
        const result = yield* failure(
          withWorkflowEvidenceAdmission(f.config, bound.binding, refs, [], check =>
            Effect.gen(function* () {
              for (const [index, mutation] of mutations.entries()) {
                if (mutation === 'marker') yield* expireRecallIndexValidation(f.home, false);
                else
                  yield* f.store.write(
                    f.location,
                    `threadnote://resources/prepared-invalidation/unrelated-${index}.md`,
                    'independent write',
                    {mode: 'create'},
                  );
              }
              return yield* f.store.writeChecked(f.location, destination, 'result', {mode: 'create'}, check);
            }),
          ),
        );
        // The model is the event history: any invalidation makes the earlier proof unusable.
        expect(result._tag).toBe(mutations.length === 0 ? 'Success' : 'Failure');
        expect((yield* failure(f.store.stat(f.location, destination)))._tag).toBe(result._tag);
        expect(yield* f.store.read(f.location, prior.uri)).toBe(prior.content);
      }).pipe(TestClock.withLive, provideTestLayer(ApplicationLayer)),
    {arbitrary: {runs: 20}},
  );
});

describe('workflow admitted evidence references', () => {
  effectIt.effect('admits exact same-project prior artifacts for read, alias, preflight, and a verified draft', () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const first = yield* f.bind('source-run');
      if (!('binding' in first)) throw new Error('Expected source binding');
      const handoff = yield* decodeWorkflowReadResult(
        yield* f.create(first.binding.bindingId, 'source-handoff', 'handoff', 'Prior handoff context.\n'),
      );
      const prior = yield* decodeWorkflowReadResult(
        yield* f.create(first.binding.bindingId, 'source-durable', 'durable', 'Prior durable decision.\n'),
      );
      const second = yield* f.bind('consumer-run');
      if (!('binding' in second)) throw new Error('Expected consumer binding');
      const originalSourceJournal = yield* f.journal(first.binding.bindingId);
      const sourceHandoff = yield* f.store.read(f.location, handoff.canonicalUri);
      const sourcePrior = yield* f.store.read(f.location, prior.canonicalUri);
      const refs = [
        evidence(handoff.canonicalUri, handoff.memoryId, handoff.revision),
        evidence(prior.canonicalUri, prior.memoryId, prior.revision),
      ];
      const alias = `threadnote://memory/${handoff.memoryId}`;
      expect(
        yield* failure(
          f.call({protocolVersion: 1, action: 'read', bindingId: second.binding.bindingId, uri: handoff.canonicalUri}),
        ),
      ).toMatchObject({_tag: 'Failure', failure: {code: 'out-of-scope'}});
      expect(
        yield* failure(f.call({protocolVersion: 1, action: 'read', bindingId: second.binding.bindingId, uri: alias})),
      ).toMatchObject({_tag: 'Failure', failure: {reason: 'not-found'}});
      for (const uri of [handoff.canonicalUri, alias]) {
        expect(
          yield* f.call({
            protocolVersion: 1,
            action: 'read',
            bindingId: second.binding.bindingId,
            uri,
            evidenceRefs: refs,
          }),
        ).toMatchObject({status: 'ok', memoryId: handoff.memoryId});
      }
      const before = yield* f.journal(second.binding.bindingId);
      const preflight = yield* f.call({
        protocolVersion: 1,
        action: 'preflight',
        bindingId: second.binding.bindingId,
        operationId: 'draft',
        artifactKey: 'draft',
        sourceRunId: 'consumer',
        role: 'root',
        storageKind: 'durable',
        body: 'Draft with checked evidence.\n',
        bodySha256: sha256HexSync('Draft with checked evidence.\n'),
        expectedRevision: null,
        mutation: 'create',
        relations: [
          {type: 'references', uri: handoff.canonicalUri},
          {type: 'references', uri: `threadnote://memory/${prior.memoryId}`},
        ],
        evidenceRefs: refs,
      });
      expect(preflight).toMatchObject({status: 'ok'});
      expect(yield* f.journal(second.binding.bindingId)).toBe(before);
      const written = yield* decodeWorkflowReadResult(
        yield* f.call({
          protocolVersion: 1,
          action: 'create',
          bindingId: second.binding.bindingId,
          operationId: 'draft',
          artifactKey: 'draft',
          sourceRunId: 'consumer',
          role: 'root',
          storageKind: 'durable',
          body: 'Draft with checked evidence.\n',
          bodySha256: sha256HexSync('Draft with checked evidence.\n'),
          expectedRevision: null,
          relations: [
            {type: 'references', uri: handoff.canonicalUri},
            {type: 'references', uri: `threadnote://memory/${prior.memoryId}`},
          ],
          evidenceRefs: refs,
        }),
      );
      expect(written).toMatchObject({
        status: 'ok',
        verifiedReadback: true,
      });
      expect(written.relations).toEqual(
        expect.arrayContaining([
          {type: 'references', uri: `threadnote://memory/${handoff.memoryId}`},
          {type: 'references', uri: `threadnote://memory/${prior.memoryId}`},
        ]),
      );
      expect(
        yield* f.call({
          protocolVersion: 1,
          action: 'read',
          bindingId: second.binding.bindingId,
          uri: written.canonicalUri,
        }),
      ).toMatchObject({revision: written.revision, body: 'Draft with checked evidence.\n'});
      expect(yield* f.journal(first.binding.bindingId)).toBe(originalSourceJournal);
      expect(yield* f.store.read(f.location, handoff.canonicalUri)).toBe(sourceHandoff);
      expect(yield* f.store.read(f.location, prior.canonicalUri)).toBe(sourcePrior);
    }).pipe(TestClock.withLive, provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect(
    'rejects alias admission, foreign scopes, stale evidence, and mutation ownership without writing',
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        const sourceBinding = yield* f.bind('source-run');
        if (!('binding' in sourceBinding)) throw new Error('Expected source binding');
        const prior = yield* decodeWorkflowReadResult(
          yield* f.create(sourceBinding.binding.bindingId, 'source', 'durable', 'Source evidence.\n'),
        );
        const otherProject = yield* f.seedProjectMemory('other-project');
        const target = yield* f.bind('target-run');
        if (!('binding' in target)) throw new Error('Expected target binding');
        const journalBefore = yield* f.journal(target.binding.bindingId);
        expect(EffectRecord.keys(JSON.parse(journalBefore).artifacts)).toEqual([]);
        const valid = evidence(prior.canonicalUri, prior.memoryId, prior.revision);
        const base = {
          protocolVersion: 1 as const,
          action: 'read' as const,
          bindingId: target.binding.bindingId,
          uri: prior.canonicalUri,
        };
        for (const bad of [
          evidence(`threadnote://memory/${prior.memoryId}`, prior.memoryId, prior.revision),
          evidence(
            Effect2.pipe(prior.canonicalUri, EffectString.replace('/fixture/', '/fixture-extra/')),
            prior.memoryId,
            prior.revision,
          ),
          evidence(
            Effect2.pipe(prior.canonicalUri, EffectString.replace('user/tester', 'user/other')),
            prior.memoryId,
            prior.revision,
          ),
          evidence(otherProject.uri, otherProject.memoryId, sha256HexSync(otherProject.content)),
          evidence(prior.canonicalUri, prior.memoryId, Effect2.pipe('0', EffectString.repeat(64))),
          evidence(prior.canonicalUri, 'tn_replacedmemoryid000000', prior.revision),
        ])
          expect(yield* failure(f.call({...base, evidenceRefs: [bad]}))).toMatchObject({_tag: 'Failure'});
        const draftBody = 'Draft with invalid evidence.\n';
        const draft: WorkflowRequest = {
          protocolVersion: 1,
          action: 'create',
          bindingId: target.binding.bindingId,
          operationId: 'bad-evidence',
          artifactKey: 'bad-evidence',
          sourceRunId: 'consumer',
          role: 'root',
          storageKind: 'durable',
          body: draftBody,
          bodySha256: sha256HexSync(draftBody),
          expectedRevision: null,
          relations: [{type: 'references', uri: prior.canonicalUri}],
          evidenceRefs: [evidence(prior.canonicalUri, prior.memoryId, Effect2.pipe('0', EffectString.repeat(64)))],
        };
        expect(yield* failure(f.call({...draft, action: 'preflight', mutation: 'create'}))).toMatchObject({
          _tag: 'Failure',
          failure: {code: 'evidence-conflict'},
        });
        expect(yield* failure(f.call(draft))).toMatchObject({
          _tag: 'Failure',
          failure: {code: 'evidence-conflict'},
        });
        const absentDraftUri = `${rootUri}/durable/projects/fixture/workflow-${target.binding.bindingId}-bad-evidence.md`;
        expect(yield* f.store.stat(f.location, absentDraftUri).pipe(Effect.result)).toMatchObject({_tag: 'Failure'});
        for (const action of ['replace', 'archive'] as const) {
          expect(
            yield* failure(
              f.call({
                protocolVersion: 1,
                action,
                bindingId: target.binding.bindingId,
                operationId: `unauthorized-${action}`,
                artifactKey: 'source',
                sourceRunId: 'source',
                role: 'root',
                storageKind: 'durable',
                body: 'Attempted mutation.\n',
                bodySha256: sha256HexSync('Attempted mutation.\n'),
                uri: prior.canonicalUri,
                expectedRevision: prior.revision,
                evidenceRefs: [valid],
              }),
            ),
          ).toMatchObject({_tag: 'Failure', failure: {code: 'out-of-scope'}});
        }
        const archivedSource = formatMemoryDocument(
          'MEMORY',
          {
            kind: 'durable',
            status: 'archived',
            topic: 'prior-context',
            project: 'fixture',
            memoryId: prior.memoryId,
            sourceAgentClient: 'threadnote',
            timestamp: '2026-10-23T12:00:00.000Z',
          },
          'Archived original Threadnote memory.\n\nSource evidence.\n',
        );
        yield* f.store.write(f.location, prior.canonicalUri, archivedSource, {mode: 'replace'});
        const archivedRef = evidence(prior.canonicalUri, prior.memoryId, sha256HexSync(archivedSource));
        expect(yield* failure(f.call({...base, evidenceRefs: [archivedRef]}))).toMatchObject({_tag: 'Failure'});
        expect(yield* f.journal(target.binding.bindingId)).toBe(journalBefore);
        expect(yield* f.store.read(f.location, prior.canonicalUri)).toBe(archivedSource);
      }).pipe(TestClock.withLive, provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('recovers a prepared evidence-backed operation using its saved evidence snapshot', () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const source = yield* f.bind('source-run');
      if (!('binding' in source)) throw new Error('Expected source binding');
      const prior = yield* decodeWorkflowReadResult(
        yield* f.create(source.binding.bindingId, 'source', 'durable', 'Stable source.\n'),
      );
      const target = yield* f.bind('target-run');
      if (!('binding' in target)) throw new Error('Expected target binding');
      const refs = [evidence(prior.canonicalUri, prior.memoryId, prior.revision)];
      const request: WorkflowRequest = {
        protocolVersion: 1,
        action: 'create',
        bindingId: target.binding.bindingId,
        operationId: 'recover-draft',
        artifactKey: 'recover-draft',
        sourceRunId: 'consumer',
        role: 'root',
        storageKind: 'durable',
        body: 'Recovered with saved evidence.\n',
        bodySha256: sha256HexSync('Recovered with saved evidence.\n'),
        expectedRevision: null,
        evidenceRefs: refs,
      };
      const store = yield* ResourceStore;
      expect(
        yield* f.call(request).pipe(
          Effect.provideService(ResourceStore, {
            ...store,
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
      const prepared = yield* f.journal(target.binding.bindingId);
      const recover = {
        protocolVersion: 1 as const,
        action: 'recover' as const,
        bindingId: target.binding.bindingId,
        operationId: request.operationId,
      };
      const sourceBytes = yield* f.store.read(f.location, prior.canonicalUri);
      const sourceRecord = parseMemoryDocument(prior.canonicalUri, sourceBytes);
      if (!sourceRecord) throw new Error('Expected a native source memory');
      const changedSource = formatMemoryDocument(sourceRecord.headerTitle, sourceRecord.metadata, 'Changed source.\n');
      yield* f.store.write(f.location, prior.canonicalUri, changedSource, {mode: 'replace'});
      expect(yield* failure(f.call(recover))).toMatchObject({_tag: 'Failure'});
      expect(yield* f.journal(target.binding.bindingId)).toBe(prepared);
      yield* f.store.write(f.location, prior.canonicalUri, sourceBytes, {mode: 'replace'});
      const result = yield* decodeWorkflowReadResult(yield* f.call(recover));
      expect(result).toMatchObject({status: 'ok', verifiedReadback: true, body: request.body});
      expect(yield* f.call(recover)).toEqual(result);
    }).pipe(TestClock.withLive, provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('rechecks evidence at the checked-write boundary after a successful preflight', () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const target = yield* f.bind('race-target-run');
      if (!('binding' in target)) throw new Error('Expected target binding');
      const prior = yield* f.seedProjectMemory('fixture');
      const refs = [evidence(prior.uri, prior.memoryId, sha256HexSync(prior.content))];
      const body = 'Draft protected by boundary verification.\n';
      const request: WorkflowRequest = {
        protocolVersion: 1,
        action: 'create',
        bindingId: target.binding.bindingId,
        operationId: 'race-draft',
        artifactKey: 'race-draft',
        sourceRunId: 'consumer',
        role: 'root',
        storageKind: 'durable',
        body,
        bodySha256: sha256HexSync(body),
        expectedRevision: null,
        evidenceRefs: refs,
      };
      const preflight = {...request, action: 'preflight' as const, mutation: 'create' as const};
      const journalBefore = yield* f.journal(target.binding.bindingId);
      expect(yield* f.call(preflight)).toMatchObject({status: 'ok'});
      expect(yield* f.journal(target.binding.bindingId)).toBe(journalBefore);
      const sourceBytes = yield* f.store.read(f.location, prior.uri);
      const sourceRecord = parseMemoryDocument(prior.uri, sourceBytes);
      if (!sourceRecord) throw new Error('Expected a native source memory');
      const changedSource = formatMemoryDocument(
        sourceRecord.headerTitle,
        sourceRecord.metadata,
        'Changed at the write boundary.\n',
      );
      const sourcePath = f.path.join(
        f.home,
        'data',
        f.config.account,
        'user',
        f.config.user,
        'memories',
        'durable',
        'projects',
        'fixture',
        'prior.md',
      );
      const store = yield* ResourceStore;
      expect(
        yield* f.call(request).pipe(
          Effect.provideService(ResourceStore, {
            ...store,
            writeChecked: (location, uri, content, options, check) =>
              f.fs
                .writeFileString(sourcePath, changedSource)
                .pipe(Effect.andThen(store.writeChecked(location, uri, content, options, check))),
          }),
          Effect.result,
        ),
      ).toMatchObject({_tag: 'Failure', failure: {code: 'evidence-conflict'}});
      const prepared = yield* f.journal(target.binding.bindingId);
      expect(prepared).not.toBe(journalBefore);
      expect(JSON.parse(prepared).operations['race-draft']).toMatchObject({status: 'prepared'});
      const draftUri = `${rootUri}/durable/projects/fixture/workflow-${target.binding.bindingId}-race-draft.md`;
      expect(yield* f.store.stat(f.location, draftUri).pipe(Effect.result)).toMatchObject({_tag: 'Failure'});
      yield* f.store.write(f.location, prior.uri, sourceBytes, {mode: 'replace'});
      const recovered = yield* decodeWorkflowReadResult(
        yield* f.call({
          protocolVersion: 1,
          action: 'recover',
          bindingId: target.binding.bindingId,
          operationId: request.operationId,
        }),
      );
      expect(recovered).toMatchObject({status: 'ok', verifiedReadback: true, body});
      expect(
        yield* f.call({
          protocolVersion: 1,
          action: 'recover',
          bindingId: target.binding.bindingId,
          operationId: request.operationId,
        }),
      ).toEqual(recovered);
    }).pipe(TestClock.withLive, provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('does not refresh recall under the canonical write fence after an unrelated mutation', () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const prior = yield* f.seedProjectMemory('fixture');
      const target = yield* f.bind('recall-race');
      if (!('binding' in target)) throw new Error('Expected native binding');
      const refs = [evidence(prior.uri, prior.memoryId, sha256HexSync(prior.content))];
      const body = 'Draft survives unrelated canonical mutation.\n';
      const request: WorkflowRequest = {
        protocolVersion: 1,
        action: 'create',
        bindingId: target.binding.bindingId,
        operationId: 'recall-race',
        artifactKey: 'recall-race',
        sourceRunId: 'consumer',
        role: 'root',
        storageKind: 'durable',
        body,
        bodySha256: sha256HexSync(body),
        expectedRevision: null,
        evidenceRefs: refs,
      };
      const unrelatedUri = `${rootUri}/durable/projects/fixture/unrelated.md`;
      const unrelatedContent = formatMemoryDocument(
        'MEMORY',
        {
          kind: 'durable',
          status: 'active',
          project: 'fixture',
          topic: 'unrelated',
          memoryId: 'tn_unrelatedrecallrace',
          sourceAgentClient: 'test',
          timestamp: '2026-10-24T00:00:00.000Z',
        },
        'Unrelated canonical memory.\n',
      );
      let nestedAccountLockAttempts = 0;
      let injected = false;
      const preparationLocks: number[] = [];
      const held = new Set<string>();
      const scanLocks: {name: string; held: number}[] = [];
      const observedFs = FileSystem.FileSystem.of({
        ...f.fs,
        writeFileString: (file, content, options) =>
          f.fs.writeFileString(file, content, options).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                if (
                  EffectString.startsWith(f.path.join(f.home, 'threadnote', 'memory-locks'))(file) &&
                  options?.flag === 'wx'
                )
                  held.add(file);
              }),
            ),
          ),
        remove: (file, options) =>
          f.fs.remove(file, options).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                held.delete(file);
              }),
            ),
          ),
      });
      const parent = yield* Effect.tracer;
      const tracer = Tracer.make({
        ...parent,
        span(options) {
          if (options.name === 'recall.scanSources' || options.name === 'recall.refreshDatabase')
            scanLocks.push({name: options.name, held: held.size});
          return parent.span(options);
        },
      });
      const lockPath = f.path.join(f.home, 'locks', 'resources', f.config.account, 'mutations.lock');
      const guardedFs = FileSystem.FileSystem.of({
        ...f.fs,
        writeFileString: (file, content, options) => {
          if (file === lockPath && options?.flag === 'wx') {
            nestedAccountLockAttempts++;
            return Effect.die('Nested canonical mutation lock acquisition inside writeChecked');
          }
          return f.fs.writeFileString(file, content, options);
        },
      });
      const store = yield* ResourceStore;
      const result = yield* f.call(request).pipe(
        Effect.provideService(FileSystem.FileSystem, observedFs),
        Effect.withTracer(tracer),
        Effect.provideService(ResourceStore, {
          ...store,
          read: (location, uri, options) =>
            store.read(location, uri, options).pipe(
              Effect.tap(() =>
                uri !== prior.uri
                  ? Effect.void
                  : f.fs.readDirectory(f.path.join(f.home, 'threadnote', 'memory-locks')).pipe(
                      Effect.orElseSucceed(() => []),
                      Effect.tap(locks =>
                        Effect.sync(() => {
                          preparationLocks.push(locks.length);
                        }),
                      ),
                    ),
              ),
            ),
          writeChecked: (location, uri, content, options, check) =>
            store.write(location, unrelatedUri, unrelatedContent, {mode: 'create'}).pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  injected = true;
                }),
              ),
              Effect.andThen(
                store.writeChecked(
                  location,
                  uri,
                  content,
                  options,
                  check.pipe(Effect.provideService(FileSystem.FileSystem, guardedFs)),
                ),
              ),
            ),
        }),
        Effect.result,
      );
      expect(result).toMatchObject({_tag: 'Failure', failure: {_tag: 'RecallIdentityAdmissionBusy'}});
      expect(injected).toBe(true);
      expect(nestedAccountLockAttempts).toBe(0);
      expect(preparationLocks.length).toBeGreaterThan(0);
      expect(Effect2.Array.every(preparationLocks, count => count === 0)).toBe(true);
      expect(Effect2.Array.some(scanLocks, event => event.name === 'recall.scanSources')).toBe(true);
      expect(Effect2.Array.some(scanLocks, event => event.name === 'recall.refreshDatabase')).toBe(true);
      expect(Effect2.Array.every(scanLocks, event => event.held === 0)).toBe(true);
      expect(yield* f.store.read(f.location, prior.uri)).toBe(prior.content);
      expect(yield* f.store.read(f.location, unrelatedUri)).toBe(unrelatedContent);
      const destination = `${rootUri}/durable/projects/fixture/workflow-${target.binding.bindingId}-recall-race.md`;
      expect(yield* f.store.stat(f.location, destination).pipe(Effect.result)).toMatchObject({_tag: 'Failure'});
      expect(
        yield* f.call({
          protocolVersion: 1,
          action: 'recover',
          bindingId: target.binding.bindingId,
          operationId: request.operationId,
        }),
      ).toMatchObject({status: 'ok', verifiedReadback: true, body});
    }).pipe(TestClock.withLive, provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('does not let personal cloud evidenceRefs read another private workflow', () =>
    Effect.gen(function* () {
      const f = yield* fixture(true);
      const one = yield* f.call({
        protocolVersion: 1,
        action: 'bind',
        workflowRunId: 'one',
        project: 'fixture',
        featureId: 'cloud',
        generation: 'one',
        profile: 'codex-cloud-personal',
        team: 'personal',
      });
      if (!('binding' in one)) throw new Error('Expected cloud binding');
      const privateDoc = yield* decodeWorkflowReadResult(
        yield* f.create(one.binding.bindingId, 'private', 'handoff', 'Cloud private.\n'),
      );
      const two = yield* f.call({
        protocolVersion: 1,
        action: 'bind',
        workflowRunId: 'two',
        project: 'fixture',
        featureId: 'cloud',
        generation: 'two',
        profile: 'codex-cloud-personal',
        team: 'personal',
      });
      if (!('binding' in two)) throw new Error('Expected second cloud binding');
      expect(
        yield* failure(
          f.call({
            protocolVersion: 1,
            action: 'read',
            bindingId: two.binding.bindingId,
            uri: privateDoc.canonicalUri,
            evidenceRefs: [evidence(privateDoc.canonicalUri, privateDoc.memoryId, privateDoc.revision)],
          }),
        ),
      ).toMatchObject({_tag: 'Failure'});
    }).pipe(TestClock.withLive, provideTestLayer(ApplicationLayer)),
  );
});
