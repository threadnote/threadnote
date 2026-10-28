import {Effect, Exit, FileSystem, Result} from 'effect';
import {mkdtemp, mkdir, rm, writeFile} from '@threadnote/testing/node-fs-promises';
import {existsSync} from '@threadnote/testing/node-fs';
import {tmpdir} from '@threadnote/testing/node-os';
import {join} from '@threadnote/testing/node-path';
import {it as effectIt} from '@effect/vitest';
import {TestClock} from 'effect/testing';
import {describe, expect, it} from 'vitest';
import fc from 'fast-check';
import {CodeGraphIndexer} from '@threadnote/graph/indexer';
import {readRetainedCodeGraphCitationEvidence} from '@threadnote/graph/citation/capsule';
import {resolveRepositoryIdentity} from '@threadnote/graph/repository';
import {parseMemoryDocument} from '@threadnote/memory/document';
import {CommandExecutor, runCommandEffect} from '@threadnote/platform/command';
import {SystemInfo} from '@threadnote/platform/system';
import {ResourceStore} from '@threadnote/store/resource-store';
import {decodeNativeAuthoringDocument} from '@threadnote/workflow-automations/authoring';
import {WorkflowAutomationError} from '@threadnote/workflow-automations/contracts';
import {sha256HexSync} from '../../src/workflow_memory/native_digest.js';
import {stableJson} from '../../src/workflow_memory/protocol.js';
import {decodeWorkflowJournal} from '../../src/workflow_memory/journal_codec.js';
import {decodeWorkflowJournalStorageImage} from '../../src/workflow_memory/journal_storage.js';
import {
  CurrentNativeJobAutoLaunch,
  nativeJobId,
  nativeJobStatus,
  runNativeJob,
  runNativeJobWorker,
} from '../../src/workflow_automation/native_jobs.js';
import {nativeFixture, provideNative} from './native-automation-fixture.js';
import {nativeCloseoutFixture} from './native-closeout-fixture.js';
import {runCloseout} from './native-closeout-diagnostics.js';

const run = <A, E, R>(program: Effect.Effect<A, E, R>) =>
  program.pipe(TestClock.withLive, provideNative, Effect.provideService(CurrentNativeJobAutoLaunch, false));
const object = (value: unknown): Record<string, unknown> => {
  if (typeof value !== 'object' || value === null) throw new Error('Expected a structured result.');
  return value as Record<string, unknown>;
};
const document = (
  source: {head: string; files: {path: string; sha256: string}[]} | null = null,
  codeRefs: string[] = [],
) =>
  decodeNativeAuthoringDocument({
    format: 'threadnote-native-authoring',
    schemaVersion: 1,
    kind: 'spec',
    id: 'feature',
    project: 'fixture',
    title: 'Native job fixture',
    objective: 'Retain an exact source-backed native job request.',
    requirements: [{id: 'req-save', behavior: 'Save the complete authoring document.'}],
    context: {codeRefs, evidenceRefs: [], note: 'Exact test source.'},
    source,
    ...(source ? {} : {sourceFreeReason: 'The source-free path still requires a clean committed checkout.'}),
    actors: ['author'],
    inScope: ['Save and load the complete document.'],
    outOfScope: [],
    constraints: ['Keep canonical operation identities.'],
    observations: [],
    scenarios: [
      {
        id: 'scenario-save',
        requirementIds: ['req-save'],
        given: 'A committed source.',
        when: 'A native job saves the document.',
        then: 'The original root is independently readable.',
      },
    ],
    assumptions: [],
    questions: [],
    artifacts: [],
    review: {required: true, reason: 'Source-backed writing requires exact review.'},
  });

const commit = (repo: string, message: string) =>
  Effect.gen(function* () {
    yield* runCommandEffect('git', ['-C', repo, 'add', '--all']);
    yield* runCommandEffect('git', [
      '-C',
      repo,
      '-c',
      'user.name=Native Jobs',
      '-c',
      'user.email=native@example.invalid',
      'commit',
      '-m',
      message,
    ]);
    return (yield* runCommandEffect('git', ['-C', repo, 'rev-parse', 'HEAD'])).stdout.trim();
  });
const submit = (f: Effect.Success<ReturnType<typeof nativeFixture>>, work: Record<string, unknown>, jobId?: string) =>
  f.call({...f.base('job'), command: 'submit', work, ...(jobId ? {jobId} : {})});
const readyMetadata = (f: Effect.Success<ReturnType<typeof nativeFixture>>, doc: ReturnType<typeof document>) =>
  Effect.gen(function* () {
    const packet = object(
      object(yield* f.call({...f.base('authoring'), command: 'acceptance-packet', document: doc})).authoring,
    );
    return {
      confirmation: {intentHash: packet.intentHash, decision: 'approved', response: 'Approved exact test intent.'},
      review: {documentHash: packet.documentHash, outcome: 'accepted', blockingIssueCount: 0},
    };
  });

describe('native private job lifecycle', () => {
  it('keeps derived identity and bounded status independent of request ordering and payload size', () => {
    fc.assert(
      fc.property(fc.string({minLength: 1, maxLength: 1200}), fc.string({minLength: 1, maxLength: 1200}), (a, b) => {
        const left = {action: 'authoring', command: 'save', runId: 'run', generation: 'g', document: {a, b}};
        const right = {generation: 'g', runId: 'run', document: {b, a}, command: 'save', action: 'authoring'};
        expect(nativeJobId('0'.repeat(64), left)).toBe(nativeJobId('0'.repeat(64), right));
        expect(nativeJobId('0'.repeat(64), left)).toMatch(/^job-[a-f0-9]{48}$/u);
        const summary = nativeJobStatus({
          jobId: 'job',
          runId: 'run',
          generation: 'g',
          status: 'accepted',
          stopRequested: false,
          updatedAt: 0,
        });
        expect(JSON.stringify(summary).length).toBeLessThan(300);
      }),
      {numRuns: 40},
    );
  });

  effectIt.effect('accepts only after exact source witness readback and resumes the same canonical save', () =>
    Effect.gen(function* () {
      const f = yield* nativeFixture();
      const head = yield* commit(f.repo, 'source');
      yield* (yield* CodeGraphIndexer).index({cwd: f.repo, threadnoteHome: f.home});
      yield* f.init();
      const source = {head, files: [{path: 'source.ts', sha256: sha256HexSync('export const fixture = true;\n')}]};
      const work = {
        ...f.base('authoring'),
        command: 'save',
        document: document(source, ['source.ts']),
        ready: false,
        expectedRevision: null,
      };
      const accepted = object(yield* submit(f, work));
      expect(accepted.status).toBe('accepted');
      const jobId = accepted.jobId as string;
      const receipt = f.path.join(f.home, 'workflow-automations', 'native-v1', 'jobs', 'native-run', jobId + '.json');
      const persisted = JSON.parse(yield* f.fs.readFileString(receipt)) as Record<string, unknown>;
      const retained = JSON.parse(yield* f.fs.readFileString(receipt + '.input.json')) as Record<string, unknown>;
      expect(persisted.intentDigest).toBe(sha256HexSync(stableJson(work)));
      const witness = object(retained.witness);
      expect(witness.head).toBe(head);
      expect(witness.citationRefs).toEqual(['source.ts']);
      const citations = witness.citations as Record<string, unknown>[];
      expect(citations).toHaveLength(1);
      expect(citations[0].path).toBe('source.ts');
      expect(citations[0].sourceCommit).toBe(head);
      expect(citations[0].evidenceRetention).toBe('capsule-retained');
      const retainedFile = object((witness.files as unknown[])[0]);
      expect(Buffer.from(object(retainedFile.object).bytes as string, 'base64').toString('utf8')).toBe(
        'export const fixture = true;\n',
      );
      expect((yield* f.fs.stat(receipt)).size).toBeLessThan(4096n);
      expect(object(yield* submit(f, work)).jobId).toBe(jobId);
      const alternate = yield* submit(f, work, 'alternate-job-id').pipe(Effect.result);
      expect(Result.isFailure(alternate)).toBe(true);
      const changed = yield* submit(f, {...work, ready: true}, jobId).pipe(Effect.result);
      expect(Result.isFailure(changed)).toBe(true);
      const completed = object(yield* runNativeJobWorker(f.config, 'native-run', jobId, f.call));
      expect(completed.status).toBe('completed');
      const result = object(yield* f.call({...f.base('job'), command: 'result', jobId}));
      expect(result.status).toBe('completed');
      expect(object(result.result).status).toBe('ok');
      const native = JSON.parse(yield* f.fs.readFileString(f.statePath())) as {operations: unknown[]};
      expect(native.operations.length).toBeGreaterThan(2);
      expect(new Set(native.operations.map(item => object(object(item).intent).operationId)).size).toBe(
        native.operations.length,
      );
    }).pipe(run),
  );

  effectIt.effect('refuses dirty input before acceptance and blocks changed HEAD with retained child receipts', () =>
    Effect.gen(function* () {
      const f = yield* nativeFixture();
      const head = yield* commit(f.repo, 'source');
      yield* (yield* CodeGraphIndexer).index({cwd: f.repo, threadnoteHome: f.home});
      yield* f.init();
      const source = {head, files: [{path: 'source.ts', sha256: sha256HexSync('export const fixture = true;\n')}]};
      const work = {
        ...f.base('authoring'),
        command: 'save',
        document: document(source, ['source.ts']),
        ready: false,
        expectedRevision: null,
      };
      yield* f.fs.writeFileString(f.path.join(f.repo, 'dirty.txt'), 'uncommitted');
      const refused = yield* submit(f, work).pipe(Effect.result);
      expect(Result.isFailure(refused)).toBe(true);
      yield* f.fs.remove(f.path.join(f.repo, 'dirty.txt'));
      const accepted = object(yield* submit(f, work));
      const jobId = accepted.jobId as string;
      yield* f.fs.writeFileString(f.path.join(f.repo, 'unrelated.txt'), 'unrelated');
      yield* commit(f.repo, 'unrelated');
      const blocked = object(yield* runNativeJobWorker(f.config, 'native-run', jobId, f.call));
      expect(blocked.status).toBe('blocked-with-progress');
      const native = JSON.parse(yield* f.fs.readFileString(f.statePath())) as {operations: unknown[]};
      expect(native.operations.length, JSON.stringify(blocked)).toBeGreaterThan(0);
      const root = native.operations.find(item => object(object(item).intent).role === 'authoring-root');
      expect(root).toBeDefined();
      expect(object(root).status).toBe('verified');
      expect(object(object(root).intent).body).toContain('"readiness":"draft"');
      const originalCitations = [];
      for (const item of native.operations) {
        const artifact = object(object(item).artifact);
        const content = yield* f.store.read(f.location, artifact.uri as string);
        const record = parseMemoryDocument(artifact.uri as string, content);
        originalCitations.push(...(record?.metadata.codeCitations ?? []));
      }
      expect(originalCitations.length).toBeGreaterThan(0);
      expect(originalCitations.every(citation => citation.sourceCommit === head)).toBe(true);
      expect(originalCitations.every(citation => citation.evidenceRetention === 'capsule-retained')).toBe(true);
      const status = object(yield* f.call({...f.base('job'), command: 'status', jobId}));
      expect(JSON.stringify(status).length).toBeLessThan(1024);
    }).pipe(run),
  );

  effectIt.effect('keeps admitted code evidence when its source file changes before draft work', () =>
    Effect.gen(function* () {
      const f = yield* nativeFixture();
      const originalBytes = 'export const fixture = true;\n';
      const head = yield* commit(f.repo, 'source');
      yield* (yield* CodeGraphIndexer).index({cwd: f.repo, threadnoteHome: f.home});
      const checkout = yield* resolveRepositoryIdentity(f.repo);
      yield* f.init();
      const work = {
        ...f.base('authoring'),
        command: 'save',
        document: document({head, files: [{path: 'source.ts', sha256: sha256HexSync(originalBytes)}]}, ['source.ts']),
        ready: false,
        expectedRevision: null,
      };
      const jobId = object(yield* submit(f, work)).jobId as string;
      const inputFile = f.path.join(
        f.home,
        'workflow-automations',
        'native-v1',
        'jobs',
        'native-run',
        jobId + '.json.input.json',
      );
      const retained = JSON.parse(yield* f.fs.readFileString(inputFile)) as {
        witness: {files: {object: {bytes: string}}[]};
      };
      expect(Buffer.from(retained.witness.files[0].object.bytes, 'base64').toString('utf8')).toBe(originalBytes);
      yield* f.fs.writeFileString(f.path.join(f.repo, 'source.ts'), 'export const fixture = false;\n');
      const changedHead = yield* commit(f.repo, 'changed cited source');
      expect(changedHead).not.toBe(head);
      const blocked = object(yield* runNativeJobWorker(f.config, 'native-run', jobId, f.call));
      expect(blocked.status).toBe('blocked-with-progress');
      const state = JSON.parse(yield* f.fs.readFileString(f.statePath())) as {operations: unknown[]};
      const root = state.operations.find(item => object(object(item).intent).role === 'authoring-root');
      expect(root).toBeDefined();
      expect(object(root).status).toBe('verified');
      expect(object(object(root).intent).body).toContain('"readiness":"draft"');
      const citations = [];
      for (const item of state.operations) {
        const artifact = object(object(item).artifact);
        const content = yield* f.store.read(f.location, artifact.uri as string);
        citations.push(...(parseMemoryDocument(artifact.uri as string, content)?.metadata.codeCitations ?? []));
      }
      expect(citations.length).toBeGreaterThan(0);
      expect(citations.every(citation => citation.sourceCommit === head)).toBe(true);
      expect(citations.every(citation => citation.evidenceRetention === 'capsule-retained')).toBe(true);
      const citation = citations[0];
      if (!citation) throw new Error('Expected one saved code citation.');
      const capsule = yield* readRetainedCodeGraphCitationEvidence(f.home, checkout.checkoutId, {
        extractorSet: citation.extractorSet,
        fileContentHash: citation.fileContentHash.value,
        path: citation.path,
        repositoryId: citation.repositoryId,
        sourceCommit: citation.sourceCommit,
        sourceDirty: citation.sourceDirty,
        sourceSnapshotId: citation.sourceSnapshotId,
      });
      expect(capsule).toBeDefined();
      expect(new TextDecoder().decode(capsule?.bytes)).toBe(originalBytes);
      expect(capsule?.capsule.source).toMatchObject({
        path: 'source.ts',
        repositoryId: citation.repositoryId,
        sourceCommit: head,
        sourceDirty: false,
        fileContentHash: citation.fileContentHash.value,
      });
      expect(yield* f.fs.readFileString(inputFile)).toContain(retained.witness.files[0].object.bytes);
    }).pipe(run),
  );

  effectIt.effect('reads prior native state and journal through a new job without changing older receipts', () =>
    Effect.gen(function* () {
      const f = yield* nativeFixture();
      yield* commit(f.repo, 'source');
      const initialized = yield* f.init();
      const prior = object(yield* f.call(f.write({operationId: 'historical-root', artifactKey: 'historical-root'})));
      const priorArtifact = object(prior.artifact);
      const originalContent = yield* f.store.read(f.location, priorArtifact.uri as string);
      const originalState = JSON.parse(yield* f.fs.readFileString(f.statePath())) as Record<string, unknown>;
      const originalOperation = object((originalState.operations as unknown[])[0]);
      const originalJournalBytes = yield* f.fs.readFileString(f.journalPath(initialized.bindingId));
      const originalLogical = yield* Effect.promise(() => decodeWorkflowJournal(originalJournalBytes));
      const originalJournal = decodeWorkflowJournalStorageImage(JSON.parse(originalLogical)) as {
        artifacts: Record<string, unknown>;
        operations: Record<string, {artifact: {canonicalUri: string}}>;
      };
      const priorJournalOperation = Object.entries(originalJournal.operations).find(
        ([, operation]) => operation.artifact.canonicalUri === priorArtifact.uri,
      );
      expect(originalJournal.artifacts[priorArtifact.uri as string]).toBeDefined();
      expect(priorJournalOperation).toBeDefined();
      if (!priorJournalOperation) throw new Error('Expected the original keyed journal operation.');
      const work = {
        ...f.base('authoring'),
        command: 'save',
        document: document(),
        ready: false,
        expectedRevision: null,
      };
      const jobId = object(yield* submit(f, work)).jobId as string;
      expect(object(yield* runNativeJobWorker(f.config, 'native-run', jobId, f.call)).status).toBe('completed');
      const currentState = JSON.parse(yield* f.fs.readFileString(f.statePath())) as Record<string, unknown>;
      expect(currentState.bindingId).toBe(originalState.bindingId);
      expect(currentState.generation).toBe(originalState.generation);
      expect(object((currentState.operations as unknown[])[0])).toEqual(originalOperation);
      expect(yield* f.store.read(f.location, priorArtifact.uri as string)).toBe(originalContent);
      const currentJournalBytes = yield* f.fs.readFileString(f.journalPath(initialized.bindingId));
      const currentLogical = yield* Effect.promise(() => decodeWorkflowJournal(currentJournalBytes));
      const currentJournal = decodeWorkflowJournalStorageImage(JSON.parse(currentLogical)) as typeof originalJournal;
      expect(currentJournal.artifacts[priorArtifact.uri as string]).toEqual(
        originalJournal.artifacts[priorArtifact.uri as string],
      );
      expect(currentJournal.operations[priorJournalOperation[0]]).toEqual(priorJournalOperation[1]);
      expect(
        new Set((currentState.operations as unknown[]).map(item => object(object(item).intent).operationId)).size,
      ).toBe((currentState.operations as unknown[]).length);
    }).pipe(run),
  );

  effectIt.effect('rejects unsupported nested work and stale declared source before any job receipt', () =>
    Effect.gen(function* () {
      const f = yield* nativeFixture();
      const head = yield* commit(f.repo, 'source');
      const initialized = yield* f.init();
      const base = {...f.base('authoring'), command: 'save', document: document(), ready: false};
      const invalid = [
        {...base, protocolVersion: 2},
        {...base, unrecognized: true},
        {...base, ready: true},
        {
          ...base,
          document: document({
            head: '0'.repeat(40),
            files: [{path: 'source.ts', sha256: sha256HexSync('export const fixture = true;\n')}],
          }),
        },
        {...f.base('closeout'), command: 'prepare'},
        {...f.base('closeout'), command: 'finish'},
      ];
      expect(head).not.toBe('0'.repeat(40));
      for (const work of invalid) {
        const denied = yield* submit(f, work).pipe(Effect.result);
        expect(Result.isFailure(denied), JSON.stringify(work)).toBe(true);
        const receipt = f.path.join(
          f.home,
          'workflow-automations',
          'native-v1',
          'jobs',
          'native-run',
          nativeJobId(initialized.bindingId, work) + '.json',
        );
        expect(yield* f.fs.exists(receipt)).toBe(false);
      }
      const capabilities = object(yield* f.call({protocolVersion: 1, executorVersion: 1, action: 'capabilities'}));
      expect(capabilities.operations).toContain('job');
    }).pipe(run),
  );

  effectIt.effect('stops before a child, then resumes the exact accepted operation IDs', () =>
    Effect.gen(function* () {
      const f = yield* nativeFixture();
      yield* commit(f.repo, 'source');
      yield* f.init();
      const work = {
        ...f.base('authoring'),
        command: 'save',
        document: document(),
        ready: false,
        expectedRevision: null,
      };
      const accepted = object(yield* submit(f, work));
      const jobId = accepted.jobId as string;
      const stoppedRequest = object(yield* f.call({...f.base('job'), command: 'cancel', jobId}));
      expect(stoppedRequest.stopRequested).toBe(true);
      const stopped = object(yield* runNativeJobWorker(f.config, 'native-run', jobId, f.call));
      expect(stopped.status, JSON.stringify(stopped)).toBe('stopped-with-progress');
      const empty = JSON.parse(yield* f.fs.readFileString(f.statePath())) as {operations: unknown[]};
      expect(empty.operations).toHaveLength(0);
      const resumed = object(yield* f.call({...f.base('job'), command: 'resume', jobId}));
      expect(resumed.status).toBe('accepted');
      const completed = object(yield* runNativeJobWorker(f.config, 'native-run', jobId, f.call));
      expect(completed.status).toBe('completed');
      const operationIds = (
        JSON.parse(yield* f.fs.readFileString(f.statePath())) as {operations: unknown[]}
      ).operations.map(item => object(object(item).intent).operationId);
      expect(operationIds.length).toBeGreaterThan(2);
      expect(new Set(operationIds).size).toBe(operationIds.length);
    }).pipe(run),
  );

  effectIt.effect('recovers an abandoned running receipt with the same immutable job identity', () =>
    Effect.gen(function* () {
      const f = yield* nativeFixture();
      yield* commit(f.repo, 'source');
      yield* f.init();
      const work = {...f.base('authoring'), command: 'save', document: document(), ready: false};
      const jobId = object(yield* submit(f, work)).jobId as string;
      const receipt = f.path.join(f.home, 'workflow-automations', 'native-v1', 'jobs', 'native-run', jobId + '.json');
      const state = JSON.parse(yield* f.fs.readFileString(receipt)) as Record<string, unknown>;
      yield* f.fs.writeFileString(receipt, stableJson({...state, status: 'running', started: true}) + '\n');
      const resumed = object(yield* f.call({...f.base('job'), command: 'resume', jobId}));
      expect(resumed.status).toBe('accepted');
      expect(resumed.jobId).toBe(jobId);
      expect(object(yield* runNativeJobWorker(f.config, 'native-run', jobId, f.call)).status).toBe('completed');
    }).pipe(run),
  );

  effectIt.effect('records detached-launch failure and resumes the durable input without changing identity', () =>
    Effect.gen(function* () {
      const f = yield* nativeFixture();
      yield* commit(f.repo, 'source');
      yield* f.init();
      const work = {...f.base('authoring'), command: 'save', document: document(), ready: false};
      const command = yield* CommandExecutor;
      const unavailable = CommandExecutor.of({...command, spawnDetached: () => Effect.succeed(false)});
      const failed = object(
        yield* submit(f, work).pipe(
          Effect.provideService(CurrentNativeJobAutoLaunch, true),
          Effect.provideService(CommandExecutor, unavailable),
        ),
      );
      expect(failed.status).toBe('failed');
      expect(failed.code).toBe('job-startup-failed');
      const jobId = failed.jobId as string;
      expect(object(yield* f.call({...f.base('job'), command: 'status', jobId})).code).toBe('job-startup-failed');
      expect(object(yield* f.call({...f.base('job'), command: 'result', jobId})).jobId).toBe(jobId);
      expect(object(yield* f.call({...f.base('job'), command: 'resume', jobId})).status).toBe('accepted');
      expect(object(yield* runNativeJobWorker(f.config, 'native-run', jobId, f.call)).status).toBe('completed');
    }).pipe(run),
  );

  effectIt.effect('cancels after one verified child and resumes without replacing that receipt', () =>
    Effect.gen(function* () {
      const f = yield* nativeFixture();
      yield* commit(f.repo, 'source');
      yield* f.init();
      const work = {
        ...f.base('authoring'),
        command: 'save',
        document: document(),
        ready: false,
        expectedRevision: null,
      };
      const jobId = object(yield* submit(f, work)).jobId as string;
      const original = yield* FileSystem.FileSystem;
      const stateFile = f.path.join(
        yield* f.fs.realPath(f.home),
        'workflow-automations',
        'native-v1',
        'native-run.json',
      );
      let cancelled = false;
      let liveResume: Record<string, unknown> | undefined;
      const cancelling = FileSystem.FileSystem.of({
        ...original,
        rename: (from, to) =>
          to === stateFile && !cancelled
            ? original.readFileString(from).pipe(
                Effect.flatMap(raw => {
                  const state = JSON.parse(raw) as {operations?: {status?: string}[]};
                  if (state.operations?.some(item => item.status === 'verified')) {
                    cancelled = true;
                    return original.rename(from, to).pipe(
                      Effect.tap(() =>
                        Effect.gen(function* () {
                          yield* f.call({...f.base('job'), command: 'cancel', jobId});
                          liveResume = object(yield* f.call({...f.base('job'), command: 'resume', jobId}));
                        }).pipe(provideNative, Effect.orDie),
                      ),
                    );
                  }
                  return original.rename(from, to);
                }),
              )
            : original.rename(from, to),
      });
      const stopped = object(
        yield* runNativeJobWorker(f.config, 'native-run', jobId, f.call).pipe(
          Effect.provideService(FileSystem.FileSystem, cancelling),
        ),
      );
      expect(cancelled).toBe(true);
      expect(liveResume?.status).toBe('running');
      expect(liveResume?.stopRequested).toBe(true);
      expect(stopped.status, JSON.stringify(stopped)).toBe('stopped-with-progress');
      const before = JSON.parse(yield* f.fs.readFileString(f.statePath())) as {operations: unknown[]};
      expect(before.operations.length).toBeGreaterThan(0);
      expect(before.operations.some(item => object(object(item).intent).role === 'authoring-root')).toBe(false);
      const prefix = before.operations.map(item => ({
        id: object(object(item).intent).operationId,
        revision: object(object(item).artifact).revision,
      }));
      yield* f.call({...f.base('job'), command: 'resume', jobId});
      const completed = object(yield* runNativeJobWorker(f.config, 'native-run', jobId, f.call));
      expect(completed.status).toBe('completed');
      const after = JSON.parse(yield* f.fs.readFileString(f.statePath())) as {operations: unknown[]};
      expect(
        after.operations.slice(0, prefix.length).map(item => ({
          id: object(object(item).intent).operationId,
          revision: object(object(item).artifact).revision,
        })),
      ).toEqual(prefix);
      expect(new Set(after.operations.map(item => object(object(item).intent).operationId)).size).toBe(
        after.operations.length,
      );
    }).pipe(run),
  );

  effectIt.effect('checks original HEAD inside the lower root write after outer source admission', () =>
    Effect.gen(function* () {
      const f = yield* nativeFixture();
      const head = yield* commit(f.repo, 'source');
      yield* f.init();
      const source = {head, files: [{path: 'source.ts', sha256: sha256HexSync('export const fixture = true;\n')}]};
      const doc = document(source);
      const work = {
        ...f.base('authoring'),
        command: 'save',
        document: doc,
        ready: true,
        expectedRevision: null,
        ...(yield* readyMetadata(f, doc)),
      };
      const jobId = object(yield* submit(f, work)).jobId as string;
      const original = yield* ResourceStore;
      const commands = yield* CommandExecutor;
      let drifted = false;
      const racing = ResourceStore.of({
        ...original,
        writeChecked: (location, uri, content, options, check) =>
          content.includes('threadnote-native-authoring-root') && !drifted
            ? Effect.gen(function* () {
                drifted = true;
                yield* f.fs.writeFileString(f.path.join(f.repo, 'after-admission.txt'), 'new HEAD').pipe(Effect.orDie);
                yield* commit(f.repo, 'race').pipe(Effect.provideService(CommandExecutor, commands), Effect.orDie);
                return yield* original.writeChecked(location, uri, content, options, check);
              })
            : original.writeChecked(location, uri, content, options, check),
      });
      const blocked = object(
        yield* runNativeJobWorker(f.config, 'native-run', jobId, f.call).pipe(
          Effect.provideService(ResourceStore, racing),
        ),
      );
      expect(drifted).toBe(true);
      expect(blocked.status).toBe('blocked-with-progress');
      const native = JSON.parse(yield* f.fs.readFileString(f.statePath())) as {operations: unknown[]};
      expect(native.operations.length).toBeGreaterThan(0);
      expect(native.operations.some(item => object(object(item).intent).role === 'authoring-root')).toBe(true);
      expect(
        native.operations.some(
          item => object(item).status === 'verified' && object(object(item).intent).role === 'authoring-root',
        ),
      ).toBe(false);
    }).pipe(run),
  );

  effectIt.effect('blocks a queued replacement when its original authoring target revision changes', () =>
    Effect.gen(function* () {
      const f = yield* nativeFixture();
      yield* commit(f.repo, 'source');
      yield* f.init();
      const save = (title: string, expectedRevision: string | null) =>
        f.call({
          ...f.base('authoring'),
          command: 'save',
          document: decodeNativeAuthoringDocument({...document(), title}),
          ready: false,
          expectedRevision,
        });
      const initial = object(object(yield* save('Initial target', null)).authoring);
      const initialRevision = object(initial.root).revision as string;
      const work = {
        ...f.base('authoring'),
        command: 'save',
        document: decodeNativeAuthoringDocument({...document(), title: 'Queued replacement'}),
        ready: false,
        expectedRevision: initialRevision,
      };
      const jobId = object(yield* submit(f, work)).jobId as string;
      const competing = object(object(yield* save('Competing replacement', initialRevision)).authoring);
      const competingRevision = object(competing.root).revision;
      const before = JSON.parse(yield* f.fs.readFileString(f.statePath())) as {operations: unknown[]};
      const blocked = object(yield* runNativeJobWorker(f.config, 'native-run', jobId, f.call));
      expect(blocked.status).toBe('blocked-with-progress');
      expect(blocked.code).toBe('job-target-drift');
      const after = JSON.parse(yield* f.fs.readFileString(f.statePath())) as {operations: unknown[]};
      expect(after.operations).toEqual(before.operations);
      expect(competingRevision).not.toBe(initialRevision);
    }).pipe(run),
  );

  effectIt.effect('does not acknowledge acceptance before immutable input and receipt both read back', () =>
    Effect.gen(function* () {
      const f = yield* nativeFixture();
      yield* commit(f.repo, 'source');
      const initialized = yield* f.init();
      const work = {
        ...f.base('authoring'),
        command: 'save',
        document: document(),
        ready: false,
        expectedRevision: null,
      };
      const jobId = nativeJobId(initialized.bindingId, work);
      const receipt = f.path.join(
        yield* f.fs.realPath(f.home),
        'workflow-automations',
        'native-v1',
        'jobs',
        'native-run',
        jobId + '.json',
      );
      const original = yield* FileSystem.FileSystem;
      const system = yield* SystemInfo;
      const scopedSystem = {...system, currentDirectory: () => f.repo, environment: () => ({})};
      let interrupted = false;
      const destinations: string[] = [];
      const failing = FileSystem.FileSystem.of({
        ...original,
        rename: (from, to) => {
          destinations.push(to);
          return to === receipt && !interrupted
            ? Effect.sync(() => {
                interrupted = true;
                throw new Error('Synthetic receipt commit interruption');
              })
            : original.rename(from, to);
        },
      });
      const failed = yield* runNativeJob(f.config, {...f.base('job'), command: 'submit', work}, f.call).pipe(
        Effect.provideService(SystemInfo, scopedSystem),
        Effect.provideService(FileSystem.FileSystem, failing),
        Effect.exit,
      );
      expect(Exit.isFailure(failed), JSON.stringify({receipt, destinations})).toBe(true);
      expect(interrupted, JSON.stringify({destinations, failed})).toBe(true);
      expect(yield* f.fs.exists(receipt)).toBe(false);
      expect(yield* f.fs.exists(receipt + '.input.json')).toBe(true);
      const accepted = object(yield* submit(f, work));
      expect(accepted.status).toBe('accepted');
      expect(accepted.jobId).toBe(jobId);
      expect(yield* f.fs.exists(receipt)).toBe(true);
    }).pipe(run),
  );

  effectIt.effect('rejects a changed immutable input after acceptance before any child effect', () =>
    Effect.gen(function* () {
      const f = yield* nativeFixture();
      yield* commit(f.repo, 'source');
      yield* f.init();
      const work = {
        ...f.base('authoring'),
        command: 'save',
        document: document(),
        ready: false,
        expectedRevision: null,
      };
      const jobId = object(yield* submit(f, work)).jobId as string;
      const inputFile = f.path.join(
        yield* f.fs.realPath(f.home),
        'workflow-automations',
        'native-v1',
        'jobs',
        'native-run',
        jobId + '.json.input.json',
      );
      const original = yield* f.fs.readFileString(inputFile);
      yield* f.fs.writeFileString(inputFile, original.replace('Native job fixture', 'Changed job fixture'));
      const failed = object(yield* runNativeJobWorker(f.config, 'native-run', jobId, f.call));
      expect(failed).toMatchObject({status: 'failed', code: 'invalid-job-state'});
      const native = JSON.parse(yield* f.fs.readFileString(f.statePath())) as {operations: unknown[]};
      expect(native.operations).toHaveLength(0);
    }).pipe(run),
  );

  effectIt.effect('reconciles a verified canonical root after a lost worker acknowledgment and restart', () =>
    Effect.gen(function* () {
      const f = yield* nativeFixture();
      yield* commit(f.repo, 'source');
      yield* f.init();
      const work = {
        ...f.base('authoring'),
        command: 'save',
        document: document(),
        ready: false,
        expectedRevision: null,
      };
      const jobId = object(yield* submit(f, work)).jobId as string;
      let interrupted = false;
      const lostAck = (request: unknown) =>
        f.call(request).pipe(
          Effect.flatMap(result => {
            if (!interrupted && object(request).action === 'authoring') {
              interrupted = true;
              return Effect.fail(
                WorkflowAutomationError.make({
                  code: 'synthetic-ack-loss',
                  message: 'Canonical writes finished before the job result was acknowledged.',
                }),
              );
            }
            return Effect.succeed(result);
          }),
        );
      const failed = object(yield* runNativeJobWorker(f.config, 'native-run', jobId, lostAck));
      expect(failed.status).toBe('failed');
      expect(interrupted).toBe(true);
      const before = JSON.parse(yield* f.fs.readFileString(f.statePath())) as {operations: unknown[]};
      const ids = before.operations.map(item => object(object(item).intent).operationId);
      const revisions = before.operations.map(item => object(object(item).artifact).revision);
      expect(ids.length).toBeGreaterThan(2);
      yield* f.call({...f.base('job'), command: 'resume', jobId});
      const completed = object(yield* runNativeJobWorker(f.config, 'native-run', jobId, f.call));
      expect(completed.status).toBe('completed');
      const replay = object(yield* runNativeJobWorker(f.config, 'native-run', jobId, f.call));
      expect(replay.status).toBe('completed');
      const after = JSON.parse(yield* f.fs.readFileString(f.statePath())) as {operations: unknown[]};
      expect(after.operations.map(item => object(object(item).intent).operationId)).toEqual(ids);
      expect(after.operations.map(item => object(object(item).artifact).revision)).toEqual(revisions);
    }).pipe(run),
  );

  effectIt.effect('records a bounded completed summary after an oversized successful canonical response', () =>
    Effect.gen(function* () {
      const f = yield* nativeFixture();
      yield* commit(f.repo, 'source');
      yield* f.init();
      const work = {...f.base('authoring'), command: 'save', document: document(), ready: false};
      const jobId = object(yield* submit(f, work)).jobId as string;
      let dispatched = 0;
      const oversized = (request: unknown) =>
        f.call(request).pipe(
          Effect.tap(() => Effect.sync(() => dispatched++)),
          Effect.map(result => ({...object(result), largeField: 'x'.repeat(33_000)})),
        );
      const completed = object(yield* runNativeJobWorker(f.config, 'native-run', jobId, oversized));
      expect(completed.status).toBe('completed');
      expect(completed.nextAction).toContain('canonical authoring work completed');
      expect(dispatched).toBe(1);
      const result = object(yield* f.call({...f.base('job'), command: 'result', jobId}));
      expect(result.result).toEqual({status: 'ok', resultOmitted: true});
      expect(object(yield* runNativeJobWorker(f.config, 'native-run', jobId, oversized)).status).toBe('completed');
      expect(dispatched).toBe(1);
    }).pipe(run),
  );

  effectIt.effect('rejects an unsupported native state version without modifying its historical bytes', () =>
    Effect.gen(function* () {
      const f = yield* nativeFixture();
      yield* commit(f.repo, 'source');
      yield* f.init();
      const path = f.statePath();
      const state = JSON.parse(yield* f.fs.readFileString(path)) as Record<string, unknown>;
      const unsupported = JSON.stringify({...state, stateVersion: 999}) + '\n';
      yield* f.fs.writeFileString(path, unsupported);
      const work = {
        ...f.base('authoring'),
        command: 'save',
        document: document(),
        ready: false,
        expectedRevision: null,
      };
      const result = yield* submit(f, work).pipe(Effect.result);
      expect(Result.isFailure(result)).toBe(true);
      expect(yield* f.fs.readFileString(path)).toBe(unsupported);
      expect(yield* f.fs.exists(f.path.join(f.home, 'workflow-automations', 'native-v1', 'jobs'))).toBe(false);
    }).pipe(run),
  );

  effectIt.effect(
    'reuses the exact closeout reservation after a stop before its journal commit',
    () =>
      Effect.gen(function* () {
        const f = yield* nativeCloseoutFixture(false);
        const validation = object(yield* f.closeout('validation-input'));
        const phases = validation.phases as {id: string; acceptanceCriteria: string[]}[];
        const decisions = validation.decisions as {id: string; selected: string}[];
        const proposal = {
          architecture: {
            summary: 'The completed reader returns all saved data.',
            components: ['Reader', 'Store'],
            contracts: ['Preserve complete results.'],
            diagram: 'flowchart TD\n Reader --> Store',
            invariants: ['Complete reads retain all fields.'],
            unknowns: ['No full load measurement.'],
            deviations: [],
            codeRefs: ['source.ts'],
          },
          architectureVerification: 'Inspected committed source and complete result.',
          combinedChecks: [{command: 'private combined check', result: 'passed', evidence: 'Observed complete read.'}],
          phaseEvidence: phases.map(phase => ({
            id: phase.id,
            acceptance: phase.acceptanceCriteria.map(criterion => ({criterion, evidence: 'Observed ' + criterion})),
          })),
          scenarios: [],
          decisions: decisions.map(item => ({
            id: item.id,
            implemented: item.selected,
            rationale: 'Applied the approved choice with complete evidence: ' + item.id,
          })),
        };
        const work = {...f.base('closeout', f.controllerRunId), command: 'prepare', proposal};
        const jobId = object(yield* f.call({...f.base('job', f.controllerRunId), command: 'submit', work}))
          .jobId as string;
        const original = yield* FileSystem.FileSystem;
        const journalFile = f.path.join(
          yield* f.fs.realPath(f.home),
          'workflow-automations',
          'native-v1',
          f.controllerRunId + '.json.closeout.json',
        );
        let interrupted = false;
        const failing = FileSystem.FileSystem.of({
          ...original,
          rename: (from, to) =>
            to === journalFile && !interrupted
              ? Effect.sync(() => {
                  interrupted = true;
                  throw new Error('Synthetic closeout journal interruption after capacity reserve');
                })
              : original.rename(from, to),
        });
        const first = object(
          yield* runNativeJobWorker(f.config, f.controllerRunId, jobId, f.call).pipe(
            Effect.provideService(FileSystem.FileSystem, failing),
          ),
        );
        expect(interrupted, JSON.stringify(first)).toBe(true);
        expect(first.status).toBe('failed');
        const reserved = JSON.parse(yield* f.fs.readFileString(f.statePath(f.controllerRunId))) as {
          closeoutSave?: {transactionId: string; operationIds: string[]};
        };
        expect(reserved.closeoutSave).toBeDefined();
        expect(yield* f.fs.exists(journalFile)).toBe(false);
        yield* f.call({...f.base('job', f.controllerRunId), command: 'resume', jobId});
        const second = object(yield* runNativeJobWorker(f.config, f.controllerRunId, jobId, f.call));
        expect(second.status).toBe('completed');
        const prepared = JSON.parse(yield* f.fs.readFileString(journalFile)) as {
          transactionId: string;
          status: string;
          archives: Record<string, unknown>;
          outputs: Record<string, unknown>;
        };
        expect(prepared.transactionId).toBe(reserved.closeoutSave?.transactionId);
        expect(prepared.status).toBe('prepared');
        expect(Object.keys(prepared.archives)).toHaveLength(0);
        expect(Object.keys(prepared.outputs)).toHaveLength(0);
        const finishWork = {...f.base('closeout', f.controllerRunId), command: 'finish'};
        const finishJobId = object(
          yield* f.call({...f.base('job', f.controllerRunId), command: 'submit', work: finishWork}),
        ).jobId as string;
        expect(finishJobId).not.toBe(jobId);
        expect(object(yield* runNativeJobWorker(f.config, f.controllerRunId, finishJobId, f.call)).status).toBe(
          'completed',
        );
        const final = JSON.parse(yield* f.fs.readFileString(journalFile)) as {transactionId: string; status: string};
        expect(final.transactionId).toBe(prepared.transactionId);
        expect(final.status).toBe('complete');
        expect(new Set(reserved.closeoutSave?.operationIds).size).toBe(reserved.closeoutSave?.operationIds.length);
      }).pipe(Effect.provideService(CurrentNativeJobAutoLaunch, false), runCloseout),
    // This private fixture executes a failed reservation, full prepare replay, and a separate finish.
    process.platform === 'win32' ? {timeout: 120_000} : {timeout: 60_000},
  );
});

describe('native private job CLI process', () => {
  it(
    'runs an admitted job in a separate same-executable process with bounded status',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'threadnote-native-job-cli-'));
      const repo = join(root, 'repo');
      const home = join(root, 'threadnote-home');
      const userHome = join(root, 'user-home');
      const manifest = join(home, 'custom-manifest.yaml');
      const entrypoint = join(process.cwd(), 'apps', 'threadnote', 'src', 'standalone.ts');
      const environment = {...process.env};
      for (const key of Object.keys(environment))
        if (/^(?:THREADNOTE_|CODEX_|CURSOR_|BUN_)/u.test(key) || /^(?:https?|all)_proxy$/iu.test(key))
          delete environment[key];
      Object.assign(environment, {
        HOME: userHome,
        USERPROFILE: userHome,
        THREADNOTE_HOME: home,
        THREADNOTE_ACCOUNT: 'local',
        THREADNOTE_USER: 'cli-job-test',
        THREADNOTE_AGENT_ID: 'test',
        XDG_CONFIG_HOME: join(userHome, '.config'),
        XDG_DATA_HOME: join(userHome, '.local', 'share'),
        XDG_STATE_HOME: join(userHome, '.local', 'state'),
        LOCALAPPDATA: join(userHome, 'AppData', 'Local'),
        APPDATA: join(userHome, 'AppData', 'Roaming'),
        BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0',
        NO_COLOR: '1',
      });
      const git = (args: string[]) => {
        const result = Bun.spawnSync(['git', '-C', repo, ...args], {cwd: repo, stdout: 'pipe', stderr: 'pipe'});
        if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
      };
      const ownedChildren = new Set<ReturnType<typeof Bun.spawn>>();
      const cli = async (request: unknown) => {
        const child = Bun.spawn(
          [process.execPath, entrypoint, 'workflow-automation', '--home', home, '--manifest', manifest],
          {
            cwd: repo,
            env: environment,
            stdin: 'pipe',
            stdout: 'pipe',
            stderr: 'pipe',
          },
        );
        ownedChildren.add(child);
        try {
          return await Promise.race([
            (async () => {
              await child.stdin.write(JSON.stringify(request) + '\n');
              await child.stdin.end();
              const [code, output, error] = await Promise.all([
                child.exited,
                new Response(child.stdout).text(),
                new Response(child.stderr).text(),
              ]);
              if (code !== 0) throw new Error(`Native CLI failed: ${error.slice(0, 1500)}`);
              expect(error).toBe('');
              expect(output.endsWith('\n')).toBe(true);
              const lines = output.trim().split(/\r?\n/u);
              expect(lines).toHaveLength(1);
              expect(lines[0].length).toBeLessThan(32_768);
              return JSON.parse(lines[0]) as Record<string, unknown>;
            })(),
            Bun.sleep(15_000).then(() => {
              throw new Error('Private native CLI child exceeded 15 seconds.');
            }),
          ]);
        } finally {
          try {
            if (child.exitCode === null) child.kill();
            await Promise.race([child.exited, Bun.sleep(2_000)]);
          } catch {
            // The CLI assertion or timeout remains the primary failure.
          }
          if (child.exitCode !== null) ownedChildren.delete(child);
        }
      };
      let workerLock: string | undefined;
      let jobId: string | undefined;
      let cleanupError: unknown;
      try {
        await Promise.all([
          mkdir(repo, {recursive: true}),
          mkdir(home, {recursive: true}),
          mkdir(userHome, {recursive: true}),
        ]);
        await writeFile(manifest, 'version: 1\nprojects: []\n');
        await writeFile(join(repo, 'source.ts'), 'export const fixture = true;\n');
        git(['init', '--initial-branch=main']);
        git(['config', 'user.name', 'Native Job CLI']);
        git(['config', 'user.email', 'native-cli@example.invalid']);
        git(['add', 'source.ts']);
        git(['-c', 'commit.gpgsign=false', 'commit', '-m', 'Committed source']);
        const base = {protocolVersion: 1, executorVersion: 1, runId: 'cli-run', generation: 'cli-generation'};
        const initialized = await cli({
          ...base,
          action: 'init',
          project: 'fixture',
          featureId: 'feature',
          profile: 'desktop',
        });
        expect(initialized.status).toBe('ok');
        const work = {
          ...base,
          action: 'authoring',
          command: 'save',
          document: document(),
          ready: false,
          expectedRevision: null,
        };
        const accepted = await cli({...base, action: 'job', command: 'submit', work});
        expect(accepted.status).toBe('accepted');
        jobId = accepted.jobId as string;
        workerLock = join(home, 'workflow-automations', 'native-v1', 'jobs', 'cli-run', jobId + '.json.worker.lock');
        let status = accepted;
        const deadline = Date.now() + 90_000;
        while (Date.now() < deadline && status.status !== 'completed') {
          await Bun.sleep(250);
          status = await cli({...base, action: 'job', command: 'status', jobId});
          expect(status.jobId).toBe(jobId);
          if (status.status === 'failed' || status.status === 'blocked-with-progress')
            throw new Error(`Native worker stopped: ${JSON.stringify(status)}`);
        }
        expect(status.status).toBe('completed');
        expect(JSON.stringify(status).length).toBeLessThan(1024);
        const result = await cli({...base, action: 'job', command: 'result', jobId});
        expect(result.jobId).toBe(jobId);
        expect(object(result.result).status).toBe('ok');
        const rootRef = object(object(object(result.result).authoring).root);
        const loaded = await cli({...base, action: 'authoring', command: 'load', uri: rootRef.uri, detail: 'document'});
        expect(object(object(loaded.authoring).root)).toEqual(rootRef);
        expect(object(loaded.authoring).document).toEqual(work.document);
        for (let attempt = 0; attempt < 40 && existsSync(workerLock); attempt++) await Bun.sleep(100);
        expect(existsSync(workerLock)).toBe(false);
        expect(ownedChildren.size).toBe(0);
      } finally {
        for (const child of ownedChildren) {
          try {
            if (child.exitCode === null) child.kill();
            await Promise.race([child.exited, Bun.sleep(2_000)]);
          } catch {
            // Preserve the assertion or timeout that led here.
          }
          if (child.exitCode !== null) ownedChildren.delete(child);
        }
        if (workerLock && existsSync(workerLock)) {
          if (jobId) {
            try {
              await cli({
                protocolVersion: 1,
                executorVersion: 1,
                action: 'job',
                command: 'cancel',
                runId: 'cli-run',
                generation: 'cli-generation',
                jobId,
              });
            } catch {
              // The original assertion or child failure remains the primary evidence.
            }
          }
          for (let attempt = 0; attempt < 40 && existsSync(workerLock); attempt++) await Bun.sleep(100);
        }
        if (ownedChildren.size === 0 && (!workerLock || !existsSync(workerLock))) {
          try {
            await rm(root, {recursive: true, force: true});
          } catch (error) {
            cleanupError = error;
          }
        }
      }
      if (cleanupError) throw cleanupError instanceof Error ? cleanupError : new Error(String(cleanupError));
    },
    process.platform === 'win32' ? 150_000 : 120_000,
  );
});
