import {it as effectIt} from '@effect/vitest';
import {Effect, FileSystem, Path} from 'effect';
import {TestClock} from 'effect/testing';
import {describe, expect} from 'vitest';
import {CodeGraphIndexer} from '@threadnote/graph/indexer';
import {createMemoryCodeCitation} from '@threadnote/memory/code/citation';
import {formatMemoryDocument, parseMemoryDocument} from '@threadnote/memory/document';
import {runCommandEffect} from '@threadnote/platform/command';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {SystemInfo} from '@threadnote/platform/system';
import {ResourceStore} from '@threadnote/store/resource-store';
import {ApplicationLayer} from '../../src/effect/runtime.js';
import {finalizeDeferredCodeAnchors} from '../../src/memory/deferred/code_anchor.js';
import {runWorkflowMemory} from '../../src/workflow_memory/index.js';
import {loadWorkflowJournal, workflowLocation} from '../../src/workflow_memory/journal.js';
import {reconcileWorkflowCitationEnrichment} from '../../src/workflow_memory/citation_recovery.js';
import type {WorkflowRequest, WorkflowReadResult} from '../../src/workflow_memory/protocol.js';
import {provideTestLayer} from '../helpers/effect-layer.js';

const fixture = Effect.fn('test.workflowCitationRecovery.fixture')(function* (codeRefs = ['src/value.ts']) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const system = yield* SystemInfo;
  const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-workflow-citation-'}));
  const home = path.join(root, 'home');
  const repo = path.join(root, 'repo');
  yield* fs.makeDirectory(home);
  yield* fs.makeDirectory(path.join(repo, 'src'), {recursive: true});
  const git = (args: readonly string[]) => runCommandEffect('git', ['-C', repo, ...args]);
  yield* git(['init', '--initial-branch=main']);
  yield* git(['config', 'user.email', 'test@example.invalid']);
  yield* git(['config', 'user.name', 'Citation Recovery Test']);
  yield* git(['remote', 'add', 'origin', 'https://example.invalid/workflow-recovery.git']);
  yield* fs.writeFileString(path.join(repo, 'src/value.ts'), 'export const value = 1;\n');
  yield* git(['add', '.']);
  yield* git(['commit', '-m', 'fixture']);
  const config = {
    account: 'local',
    agentContextHome: home,
    agentId: 'test',
    user: 'tester',
    manifestPath: path.join(home, 'manifest.yaml'),
    manifestSource: 'bundled-example' as const,
  };
  const context = {
    ...system,
    currentDirectory: () => repo,
    environment: () =>
      Object.fromEntries(Object.entries(system.environment()).filter(([key]) => !key.startsWith('THREADNOTE_'))),
  };
  const call = (request: WorkflowRequest) =>
    runWorkflowMemory(config, request).pipe(Effect.provideService(SystemInfo, context));
  const bound = yield* call({
    protocolVersion: 1,
    action: 'bind',
    workflowRunId: 'citation-recovery',
    project: 'fixture',
    featureId: 'feature',
    generation: 'v1',
  });
  if (!('binding' in bound)) return yield* Effect.die('Expected binding');
  const binding = bound.binding;
  const body = 'Draft source analysis — 仕様.\n';
  const create: WorkflowRequest = {
    protocolVersion: 1,
    action: 'create',
    bindingId: binding.bindingId,
    operationId: 'create',
    artifactKey: 'draft',
    sourceRunId: 'writer',
    role: 'current',
    body,
    bodySha256: sha256HexSync(body),
    codeRefs,
    citationPolicy: 'defer',
    expectedRevision: null,
  };
  const written = (yield* call(create)) as WorkflowReadResult;
  expect(written.codeCitations).toEqual([]);
  const original = yield* loadWorkflowJournal(config, binding.bindingId).pipe(
    Effect.provideService(SystemInfo, context),
  );
  yield* (yield* CodeGraphIndexer).index({threadnoteHome: home, cwd: repo, ensureVectors: false});
  // Exercise the real native finalizer after real graph preparation. The
  // indexer's automatic hook may already have completed this same transition.
  yield* finalizeDeferredCodeAnchors(config, {uris: [written.canonicalUri]});
  const content = yield* (yield* ResourceStore).read(workflowLocation(config), written.canonicalUri);
  expect(parseMemoryDocument(written.canonicalUri, content)?.metadata.codeCitations).toHaveLength(1);
  return {fs, path, config, binding, repo, context, call, create, written, original, content};
});

describe('workflow deferred citation recovery', () => {
  effectIt.effect('recovers exact native partial enrichment when an original reference is absent', () =>
    Effect.gen(function* () {
      const codeRefs = ['src/value.ts', 'src/removed.ts'];
      const f = yield* fixture(codeRefs);
      const record = parseMemoryDocument(f.written.canonicalUri, f.content)!;
      expect(f.original.operations.create.request.codeRefs).toEqual(codeRefs);
      expect(record.metadata.codeCitations?.map(citation => citation.path)).toEqual(['src/value.ts']);
      const recovered = (yield* f.call({
        protocolVersion: 1,
        action: 'recover',
        bindingId: f.binding.bindingId,
        operationId: 'create',
      })) as WorkflowReadResult;
      expect(recovered).toMatchObject({
        canonicalUri: f.written.canonicalUri,
        memoryId: f.written.memoryId,
        body: f.written.body,
        bodySha256: f.written.bodySha256,
        revision: sha256HexSync(f.content),
      });
      expect(recovered.codeCitations).toEqual(record.metadata.codeCitations);
      const forged = formatMemoryDocument(
        record.headerTitle,
        {
          ...record.metadata,
          codeCitations: record.metadata.codeCitations!.map(citation => {
            const {id: _id, ...input} = citation;
            return createMemoryCodeCitation({
              ...input,
              fileContentHash: {...input.fileContentHash, value: '0'.repeat(64)},
            });
          }),
        },
        record.body,
      );
      for (const changed of [
        forged,
        formatMemoryDocument(record.headerTitle, {...record.metadata, sourceSessionId: 'another-run'}, record.body),
      ])
        expect(
          yield* reconcileWorkflowCitationEnrichment(f.config, f.binding, f.original.operations.create, changed),
        ).toBeUndefined();
      expect(yield* f.call(f.create)).toEqual(recovered);
      const after = yield* loadWorkflowJournal(f.config, f.binding.bindingId).pipe(
        Effect.provideService(SystemInfo, f.context),
      );
      expect(after.operations.create.intentDigest).toBe(f.original.operations.create.intentDigest);
      expect(after.operations.create.request.codeRefs).toEqual(codeRefs);
      expect(after.operations.create.desired).toBe(f.content);
    }).pipe(TestClock.withLive, provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('recovers the same operation after actual native graph-index citation enrichment', () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const adopted = yield* reconcileWorkflowCitationEnrichment(
        f.config,
        f.binding,
        f.original.operations.create,
        f.content,
      );
      expect(adopted).toMatchObject({
        intentDigest: f.original.operations.create.intentDigest,
        desired: f.content,
        artifact: {memoryId: f.written.memoryId, revision: sha256HexSync(f.content)},
      });
      const recovered = (yield* f.call({
        protocolVersion: 1,
        action: 'recover',
        bindingId: f.binding.bindingId,
        operationId: 'create',
      })) as WorkflowReadResult;
      expect(recovered).toMatchObject({
        canonicalUri: f.written.canonicalUri,
        memoryId: f.written.memoryId,
        body: f.written.body,
        bodySha256: f.written.bodySha256,
        revision: sha256HexSync(f.content),
      });
      expect(recovered.codeCitations).toHaveLength(1);
      expect(yield* f.call(f.create)).toEqual(recovered);
      const after = yield* loadWorkflowJournal(f.config, f.binding.bindingId).pipe(
        Effect.provideService(SystemInfo, f.context),
      );
      expect(after.operations.create.intentDigest).toBe(f.original.operations.create.intentDigest);
      expect(after.operations.create.desired).toBe(f.content);
      expect(after.artifacts[f.written.canonicalUri].revision).toBe(sha256HexSync(f.content));
      yield* f.call({
        protocolVersion: 1,
        action: 'archive',
        bindingId: f.binding.bindingId,
        operationId: 'archive',
        artifactKey: 'draft',
        sourceRunId: 'writer',
        role: 'current',
        uri: f.written.canonicalUri,
        expectedRevision: recovered.revision,
      });
      expect(yield* f.call(f.create).pipe(Effect.result)).toMatchObject({
        _tag: 'Failure',
        failure: {code: 'operation-superseded'},
      });
    }).pipe(TestClock.withLive, provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect(
    'rejects noncitation edits and changed source evidence instead of adopting arbitrary postimages',
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        const record = parseMemoryDocument(f.written.canonicalUri, f.content)!;
        for (const changed of [
          formatMemoryDocument(record.headerTitle, record.metadata, 'Changed body'),
          formatMemoryDocument(record.headerTitle, {...record.metadata, memoryId: 'tn_foreign_identity'}, record.body),
          formatMemoryDocument(record.headerTitle, {...record.metadata, sourceSessionId: 'another-run'}, record.body),
          formatMemoryDocument(
            record.headerTitle,
            {...record.metadata, timestamp: '2020-01-01T00:00:00.000Z'},
            record.body,
          ),
          f.content.replace('\n\n', '\nunknown_header: unexpected\n\n'),
        ])
          expect(
            yield* reconcileWorkflowCitationEnrichment(f.config, f.binding, f.original.operations.create, changed),
          ).toBeUndefined();
        const store = yield* ResourceStore;
        const changedBody = formatMemoryDocument(record.headerTitle, record.metadata, 'Concurrent edit');
        yield* store.write(workflowLocation(f.config), f.written.canonicalUri, changedBody, {mode: 'replace'});
        expect(
          yield* f
            .call({protocolVersion: 1, action: 'recover', bindingId: f.binding.bindingId, operationId: 'create'})
            .pipe(Effect.result),
        ).toMatchObject({_tag: 'Failure', failure: {code: 'revision-conflict'}});
        expect(yield* store.read(workflowLocation(f.config), f.written.canonicalUri)).toBe(changedBody);
        yield* f.fs.writeFileString(f.path.join(f.repo, 'src/value.ts'), 'export const value = 2;\n');
        expect(
          yield* reconcileWorkflowCitationEnrichment(f.config, f.binding, f.original.operations.create, f.content).pipe(
            Effect.result,
          ),
        ).toMatchObject({_tag: 'Failure'});
      }).pipe(TestClock.withLive, provideTestLayer(ApplicationLayer)),
  );
});
