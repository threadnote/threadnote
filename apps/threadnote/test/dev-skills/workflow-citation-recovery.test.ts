import {Array as EffectArray} from 'effect';
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
import type {WorkflowRequest} from '../../src/workflow_memory/protocol.js';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {
  executionDiagnosticPhase,
  workflowExecutionDiagnostics,
  withWorkflowExecutionDiagnostics,
  type WorkflowExecutionDiagnostics,
} from './workflow-execution-diagnostics.js';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';
import {Option as EffectOption} from 'effect';

const fixture = Effect.fn('test.workflowCitationRecovery.fixture')(function* (
  codeRefs = ['src/value.ts'],
  diagnostics?: WorkflowExecutionDiagnostics,
) {
  executionDiagnosticPhase(diagnostics, 'fixture-filesystem');
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const system = yield* SystemInfo;
  const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-workflow-citation-'}));
  const home = path.join(root, 'home');
  const repo = path.join(root, 'repo');
  yield* fs.makeDirectory(home);
  yield* fs.makeDirectory(path.join(repo, 'src'), {recursive: true});
  const git = (args: readonly string[]) => runCommandEffect('git', ['-C', repo, ...args]);
  executionDiagnosticPhase(diagnostics, 'fixture-git');
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
      EffectRecord.fromEntries(
        EffectArray.filter(
          EffectRecord.toEntries(system.environment()),
          ([key]) => !Effect2.pipe(key, EffectString.startsWith('THREADNOTE_')),
        ),
      ),
  };
  const call = (request: WorkflowRequest) =>
    runWorkflowMemory(config, request).pipe(Effect.provideService(SystemInfo, context));
  executionDiagnosticPhase(diagnostics, 'bind');
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
  executionDiagnosticPhase(diagnostics, 'create');
  const writtenResult = yield* call(create);
  if (writtenResult.status !== 'ok' || !('codeCitations' in writtenResult))
    return yield* Effect.die('Expected a successful workflow read result.');
  const written = writtenResult;
  expect(written.codeCitations).toEqual([]);
  executionDiagnosticPhase(diagnostics, 'journal-before-index');
  const original = yield* loadWorkflowJournal(config, binding.bindingId).pipe(
    Effect.provideService(SystemInfo, context),
  );
  executionDiagnosticPhase(diagnostics, 'graph-index');
  yield* (yield* CodeGraphIndexer).index({threadnoteHome: home, cwd: repo, ensureVectors: false});
  // Exercise the real native finalizer after real graph preparation. The
  // indexer's automatic hook may already have completed this same transition.
  executionDiagnosticPhase(diagnostics, 'deferred-finalization');
  yield* finalizeDeferredCodeAnchors(config, {uris: [written.canonicalUri]});
  executionDiagnosticPhase(diagnostics, 'fixture-readback');
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
      expect(
        EffectOption.getOrUndefined(
          EffectOption.map(EffectOption.fromNullishOr(record.metadata.codeCitations), __effectArrayReceiver =>
            EffectArray.map(__effectArrayReceiver, citation => citation.path),
          ),
        ),
      ).toEqual(['src/value.ts']);
      const recovered = yield* f.call({
        protocolVersion: 1,
        action: 'recover',
        bindingId: f.binding.bindingId,
        operationId: 'create',
      });
      if (recovered.status !== 'ok' || !('codeCitations' in recovered))
        return yield* Effect.die('Expected a successful workflow read result.');
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
          codeCitations: EffectArray.map(record.metadata.codeCitations!, citation => {
            const {id: _id, ...input} = citation;
            return createMemoryCodeCitation({
              ...input,
              fileContentHash: {...input.fileContentHash, value: Effect2.pipe('0', EffectString.repeat(64))},
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

  effectIt.effect('recovers the same operation after actual native graph-index citation enrichment', context => {
    const diagnostics = workflowExecutionDiagnostics(context);
    return withWorkflowExecutionDiagnostics(
      Effect.gen(function* () {
        const f = yield* fixture(undefined, diagnostics);
        executionDiagnosticPhase(diagnostics, 'citation-reconcile');
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
        executionDiagnosticPhase(diagnostics, 'recover');
        const recovered = yield* f.call({
          protocolVersion: 1,
          action: 'recover',
          bindingId: f.binding.bindingId,
          operationId: 'create',
        });
        if (recovered.status !== 'ok' || !('codeCitations' in recovered))
          return yield* Effect.die('Expected a successful workflow read result.');
        expect(recovered).toMatchObject({
          canonicalUri: f.written.canonicalUri,
          memoryId: f.written.memoryId,
          body: f.written.body,
          bodySha256: f.written.bodySha256,
          revision: sha256HexSync(f.content),
        });
        expect(recovered.codeCitations).toHaveLength(1);
        executionDiagnosticPhase(diagnostics, 'create-replay');
        expect(yield* f.call(f.create)).toEqual(recovered);
        executionDiagnosticPhase(diagnostics, 'journal-after-recovery');
        const after = yield* loadWorkflowJournal(f.config, f.binding.bindingId).pipe(
          Effect.provideService(SystemInfo, f.context),
        );
        expect(after.operations.create.intentDigest).toBe(f.original.operations.create.intentDigest);
        expect(after.operations.create.desired).toBe(f.content);
        expect(after.artifacts[f.written.canonicalUri].revision).toBe(sha256HexSync(f.content));
        executionDiagnosticPhase(diagnostics, 'archive');
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
        executionDiagnosticPhase(diagnostics, 'retired-replay');
        expect(yield* f.call(f.create).pipe(Effect.result)).toMatchObject({
          _tag: 'Failure',
          failure: {code: 'operation-superseded'},
        });
      }).pipe(
        Effect.onExit(() => Effect.sync(() => executionDiagnosticPhase(diagnostics, 'teardown'))),
        TestClock.withLive,
        provideTestLayer(ApplicationLayer),
      ),
      diagnostics,
    );
  });

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
          Effect2.pipe(f.content, EffectString.replace('\n\n', '\nunknown_header: unexpected\n\n')),
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
