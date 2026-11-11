import * as EffectString from 'effect/String';
import {Array as EffectArray} from 'effect';
import {Effect, FileSystem, Predicate, Result, Schema} from 'effect';
import {it as effectIt} from '@effect/vitest';
import {TestClock} from 'effect/testing';
import {describe, expect} from 'vitest';
import {ResourceIoFailed, ResourceStore} from '@threadnote/store/resource-store';
import {runCommandEffect} from '@threadnote/platform/command';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {SystemInfo} from '@threadnote/platform/system';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {stableJson, WorkflowMemoryError} from '../../src/workflow_memory/protocol.js';
import {runWorkflowMemory} from '../../src/workflow_memory/index.js';
import {nativeFixture, provideNative} from './native-automation-fixture.js';
import * as EffectRecord from 'effect/Record';

const failure = <A, E, R>(effect: Effect.Effect<A, E, R>) => effect.pipe(Effect.result);
const run = <A, E, R>(effect: Effect.Effect<A, E, R>) => effect.pipe(TestClock.withLive, provideNative);
function record(value: unknown, label: string): Record<string, unknown> {
  if (!Predicate.isObject(value)) throw new Error(`Expected ${label} to be an object.`);
  return value;
}
function textField(value: Record<string, unknown>, key: string, label: string): string {
  const field = value[key];
  if (typeof field !== 'string') throw new Error(`Expected ${label}.${key} to be text.`);
  return field;
}

describe('native workflow automation', () => {
  effectIt.effect('rejects a graph selector on ordinary memory bind before any state exists', () =>
    Effect.gen(function* () {
      const f = yield* nativeFixture();
      const privateValue = `private-selector:${f.root}`;
      const result = yield* runWorkflowMemory(f.config, {
        protocolVersion: 1,
        action: 'bind',
        workflowRunId: 'ordinary-v1',
        project: 'fixture',
        featureId: 'feature',
        generation: 'skill-generation-v1',
        graphProject: privateValue,
      }).pipe(Effect.result);
      expect(result).toMatchObject({failure: {code: 'invalid-request'}});
      if (result._tag !== 'Failure') throw new Error('Expected an invalid ordinary bind.');
      if (!Schema.is(WorkflowMemoryError)(result.failure)) throw new Error('Expected a typed workflow error.');
      expect(new TextEncoder().encode(result.failure.message).byteLength).toBeLessThanOrEqual(256);
      expect(result.failure.message).not.toContain(privateValue);
      expect(result.failure.message).not.toContain(f.root);
      expect(result.failure.message).not.toContain('ParseError');
      expect(yield* f.fs.exists(f.path.join(f.home, 'workflow-memory'))).toBe(false);
      const ordinary = yield* runWorkflowMemory(f.config, {
        protocolVersion: 1,
        action: 'bind',
        workflowRunId: 'ordinary-v1',
        project: 'fixture',
        featureId: 'feature',
        generation: 'skill-generation-v1',
      });
      expect(ordinary).not.toHaveProperty('graphProject');
    }).pipe(run),
  );

  effectIt.effect('binds a configured graph project canonically and preserves unselected identity', () =>
    Effect.gen(function* () {
      const f = yield* nativeFixture();
      const bundledConfig: RuntimeConfig = {...f.config, manifestSource: 'bundled-example'};
      yield* runCommandEffect('git', [
        '-C',
        f.repo,
        '-c',
        'user.name=Test',
        '-c',
        'user.email=test@example.invalid',
        'commit',
        '--allow-empty',
        '-m',
        'fixture',
      ]);
      const bundled = yield* failure(
        f.call(
          {
            ...f.base('init'),
            project: 'fixture',
            featureId: 'feature',
            graphProject: 'Alpha',
          },
          bundledConfig,
        ),
      );
      expect(bundled).toMatchObject({failure: {code: 'graph-scope-invalid'}});
      expect(yield* f.fs.exists(f.statePath())).toBe(false);
      const foreign = f.path.join(f.root, 'foreign');
      yield* f.fs.makeDirectory(foreign);
      yield* runCommandEffect('git', ['init', '--initial-branch=main', foreign]);
      yield* f.fs.writeFileString(
        f.config.manifestPath,
        JSON.stringify({
          version: 1,
          projects: [
            ...EffectArray.map(['Alpha', 'Beta'], name => ({
              name,
              path: f.repo,
              seed: [],
              uri: `threadnote://resources/repos/${EffectString.toLowerCase(name)}`,
              graph: {closure: 'dependencies', roots: [EffectString.toLowerCase(name)]},
            })),
            {name: 'Full', path: f.repo, seed: [], uri: 'threadnote://resources/repos/full'},
            {
              name: 'Named',
              path: f.repo,
              seed: [],
              uri: 'threadnote://resources/repos/named',
              graph: {closure: 'dependencies', roots: ['alias']},
            },
            {
              name: 'Outside',
              path: foreign,
              seed: [],
              uri: 'threadnote://resources/repos/outside',
              graph: {closure: 'dependencies', roots: ['src']},
            },
          ],
        }),
      );
      const invalid = yield* failure(
        f.call({...f.base('init'), project: 'fixture', featureId: 'feature', graphProject: 'unknown'}),
      );
      expect(invalid).toMatchObject({failure: {code: 'graph-scope-invalid'}});
      for (const graphProject of ['alias', 'Outside'])
        expect(
          yield* failure(f.call({...f.base('init'), project: 'fixture', featureId: 'feature', graphProject})),
        ).toMatchObject({failure: {code: 'graph-scope-invalid'}});
      expect(yield* f.fs.exists(f.statePath())).toBe(false);
      const unselected = yield* f.init('unselected');
      const unselectedState = JSON.parse(yield* f.fs.readFileString(f.statePath('unselected')));
      const unselectedJournal = JSON.parse(yield* f.fs.readFileString(f.journalPath(unselected.bindingId)));
      expect(unselectedState).not.toHaveProperty('graphProject');
      expect(unselectedJournal.binding).not.toHaveProperty('graphProject');
      const {bindingId, ...identity} = unselectedJournal.binding;
      expect(bindingId).toBe(sha256HexSync(stableJson(identity)));
      const unselectedBytes = yield* f.fs.readFileString(f.statePath('unselected'));
      expect(
        yield* failure(
          f.call({
            ...f.base('init', 'unselected'),
            project: 'fixture',
            featureId: 'feature',
            graphProject: 'Alpha',
          }),
        ),
      ).toMatchObject({failure: {code: 'graph-scope-conflict'}});
      expect(yield* f.fs.readFileString(f.statePath('unselected'))).toBe(unselectedBytes);
      expect(yield* failure(f.call(f.base('graph-ready', 'unselected')))).toMatchObject({
        failure: {code: 'graph-scope-required'},
      });
      const selectedRequest = {
        ...f.base('init'),
        project: 'fixture',
        featureId: 'feature',
        profile: 'desktop',
        graphProject: ' alpha ',
      };
      const selected = yield* f.call(selectedRequest);
      if (!('bindingId' in selected)) throw new Error('Expected selected native binding');
      expect(selected).toMatchObject({graphProject: 'Alpha'});
      const selectedState = JSON.parse(yield* f.fs.readFileString(f.statePath()));
      const selectedJournal = JSON.parse(yield* f.fs.readFileString(f.journalPath(selected.bindingId)));
      expect(selectedState.graphProject).toBe('Alpha');
      expect(selectedJournal.binding.graphProject).toBe('Alpha');
      const replay = yield* f.call({...selectedRequest, graphProject: 'ALPHA'});
      expect(replay).toMatchObject({bindingId: selected.bindingId, graphProject: 'Alpha'});
      const before = yield* f.fs.readFileString(f.statePath());
      expect(yield* failure(f.call({...selectedRequest, graphProject: 'Beta'}))).toMatchObject({
        failure: {code: 'graph-scope-conflict'},
      });
      expect(yield* f.fs.readFileString(f.statePath())).toBe(before);
      for (const command of ['status', 'result', 'cancel', 'resume'] as const)
        expect(yield* failure(f.call({...f.base('job'), command, jobId: 'missing-job'}))).toMatchObject({
          failure: {code: 'job-not-found'},
        });
      const full = yield* f.call({...selectedRequest, runId: 'full-run', graphProject: 'Full'});
      expect(full).toMatchObject({graphProject: 'Full'});
      expect(yield* f.call(f.base('graph-ready', 'full-run'))).toMatchObject({status: 'ok', graph: {state: 'ready'}});
      expect(yield* failure(f.call(f.base('graph-ready'), bundledConfig))).toMatchObject({
        failure: {code: 'graph-scope-unavailable'},
      });
      const written = yield* f.call(f.write());
      if (!('artifact' in written)) throw new Error('Expected selected workflow artifact');
      yield* f.fs.writeFileString(
        f.config.manifestPath,
        JSON.stringify({
          version: 1,
          projects: [{name: 'Beta', path: f.repo, seed: [], uri: 'threadnote://resources/repos/beta'}],
        }),
      );
      expect(yield* failure(f.call(f.base('graph-ready')))).toMatchObject({failure: {code: 'graph-scope-unavailable'}});
      expect(yield* f.call(f.base('inspect'))).toMatchObject({status: 'ok', graphProject: 'Alpha'});
      expect(yield* f.call({...f.base('read'), uri: written.artifact.uri})).toMatchObject({status: 'ok'});
      yield* f.fs.writeFileString(
        f.config.manifestPath,
        JSON.stringify({
          version: 1,
          projects: [{name: 'ALPHA', path: f.repo, seed: [], uri: 'threadnote://resources/repos/alpha'}],
        }),
      );
      expect(yield* failure(f.call(f.base('graph-ready')))).toMatchObject({failure: {code: 'graph-scope-unavailable'}});
      yield* f.fs.writeFileString(
        f.config.manifestPath,
        JSON.stringify({
          version: 1,
          projects: [{name: 'Alpha', path: foreign, seed: [], uri: 'threadnote://resources/repos/alpha'}],
        }),
      );
      const relocated = yield* failure(f.call(f.base('graph-ready')));
      expect(relocated).toMatchObject({failure: {code: 'graph-scope-unavailable'}});
      if (relocated._tag === 'Failure') expect(relocated.failure.message).not.toContain(f.root);
      yield* f.fs.remove(f.config.manifestPath);
      expect(yield* failure(f.call(f.base('graph-ready')))).toMatchObject({failure: {code: 'graph-scope-unavailable'}});
      expect(yield* f.call(f.base('inspect'))).toMatchObject({status: 'ok'});
    }).pipe(run),
  );

  effectIt.effect('does not defer selected-run citation capture', () =>
    Effect.gen(function* () {
      const f = yield* nativeFixture();
      yield* runCommandEffect('git', [
        '-C',
        f.repo,
        '-c',
        'user.name=Test',
        '-c',
        'user.email=test@example.invalid',
        'commit',
        '--allow-empty',
        '-m',
        'fixture',
      ]);
      yield* f.fs.writeFileString(
        f.config.manifestPath,
        JSON.stringify({
          version: 1,
          projects: [{name: 'Alpha', path: f.repo, seed: [], uri: 'threadnote://resources/repos/alpha'}],
        }),
      );
      const selected = yield* f.call({
        ...f.base('init'),
        project: 'fixture',
        featureId: 'feature',
        graphProject: 'Alpha',
      });
      if (!('bindingId' in selected)) throw new Error('Expected selected native binding');
      const journalPath = f.journalPath(selected.bindingId);
      const before = yield* f.fs.readFileString(journalPath);
      const system = yield* SystemInfo;
      const result = yield* runWorkflowMemory(f.config, {
        protocolVersion: 1,
        action: 'create',
        bindingId: selected.bindingId,
        operationId: 'selected-defer',
        artifactKey: 'root',
        sourceRunId: 'native-run',
        role: 'root',
        body: 'Selected citation.\n',
        bodySha256: sha256HexSync('Selected citation.\n'),
        expectedRevision: null,
        storageKind: 'durable',
        codeRefs: ['source.ts'],
        citationPolicy: 'defer',
      }).pipe(Effect.provideService(SystemInfo, {...system, currentDirectory: () => f.repo}), Effect.result);
      expect(result).toMatchObject({failure: {_tag: 'MemoryCodeCitationCaptureError'}});
      expect(yield* f.fs.readFileString(journalPath)).toBe(before);
    }).pipe(run),
  );

  effectIt.effect('creates and resumes a stable native run without rewriting verified bytes', () =>
    Effect.gen(function* () {
      const f = yield* nativeFixture();
      const initialized = yield* f.init();
      expect(initialized).toMatchObject({status: 'ok', runId: 'native-run', generation: 'skill-generation-v1'});
      const bindingId = initialized.bindingId;
      const initialState = yield* f.fs.readFileString(f.statePath());
      const journalPath = f.journalPath(bindingId);
      const firstJournal = yield* f.fs.readFileString(journalPath);
      const write = f.write();
      const writeResult = yield* f.call(write).pipe(Effect.result);
      const writtenState = yield* f.fs.readFileString(f.statePath());
      expect(Result.isSuccess(writeResult), writtenState).toBe(true);
      if (Result.isFailure(writeResult)) return;
      const written = writeResult.success;
      if (!('artifact' in written)) throw new Error('Expected verified native artifact');
      expect(written).toMatchObject({status: 'ok', operationId: 'write-1', artifact: {body: write.body}});
      const artifactUri = textField(record(written.artifact, 'written artifact'), 'uri', 'written artifact');
      const artifactBytes = yield* f.store.read(f.location, artifactUri);
      const journalAfterWrite = yield* f.fs.readFileString(journalPath);
      const journalValue = record(JSON.parse(journalAfterWrite), 'journal');
      const manifestUri = textField(journalValue, 'manifestUri', 'journal');
      const manifestBytes = yield* f.store.read(f.location, manifestUri);
      const stateAfterWrite = yield* f.fs.readFileString(f.statePath());
      const read = yield* f.call({...f.base('read'), uri: artifactUri});
      expect(read).toMatchObject({status: 'ok', artifact: {body: write.body, uri: artifactUri}});
      const inspected = yield* f.call(f.base('inspect'));
      expect(JSON.stringify(inspected)).not.toContain(write.body);
      expect(inspected).toMatchObject({operations: [{operationId: 'write-1', status: 'verified'}]});
      yield* f.init();
      const replayPreflight = yield* f.call({...write, action: 'preflight'}).pipe(Effect.result);
      expect(Result.isSuccess(replayPreflight), JSON.stringify(replayPreflight)).toBe(true);
      const replayWrite = yield* f.call(write).pipe(Effect.result);
      expect(
        Result.isSuccess(replayWrite),
        'same verified write intent should replay without creating a duplicate',
      ).toBe(true);
      const replayRecovery = yield* f.call({...f.base('recover'), operationId: 'write-1'}).pipe(Effect.result);
      expect(Result.isSuccess(replayRecovery), 'verified operation recovery should be a read-only confirmation').toBe(
        true,
      );
      expect(yield* f.fs.readFileString(f.statePath())).toBe(stateAfterWrite);
      expect(yield* f.fs.readFileString(journalPath)).toBe(journalAfterWrite);
      expect(yield* f.store.read(f.location, artifactUri)).toBe(artifactBytes);
      expect(yield* f.store.read(f.location, manifestUri)).toBe(manifestBytes);
      expect(initialState).not.toBe(stateAfterWrite);
      expect(firstJournal).not.toBe(journalAfterWrite);
      expect(yield* failure(f.call(f.write({body: 'Changed intent.\n'})))).toMatchObject({
        failure: {code: 'operation-intent-conflict'},
      });
      const changedGeneration = yield* failure(f.call(f.base('inspect', 'native-run', 'other-generation')));
      expect(changedGeneration).toMatchObject({failure: {code: 'generation-conflict'}});
      expect(yield* f.fs.readFileString(f.statePath())).toBe(stateAfterWrite);
    }).pipe(run),
  );

  effectIt.effect('recovers a prepared receipt after checked native memory write fails', () =>
    Effect.gen(function* () {
      const f = yield* nativeFixture();
      const initialized = yield* f.init();
      const statePath = f.statePath();
      const journalPath = f.journalPath(initialized.bindingId);
      const existing = yield* f.call(f.write());
      const existingArtifact = record(record(existing, 'write result').artifact, 'written artifact');
      const existingArtifactUri = textField(existingArtifact, 'uri', 'written artifact');
      const existingArtifactRevision = textField(existingArtifact, 'revision', 'written artifact');
      const replace = f.write({
        action: 'write',
        operationId: 'replace-interrupted',
        artifactKey: 'plan-root',
        uri: existingArtifactUri,
        expectedRevision: existingArtifactRevision,
        body: 'Replacement after interruption.\n',
      });
      const beforeJournal = yield* f.fs.readFileString(journalPath);
      const store = f.store;
      let failed = false;
      const guardedStore = {
        ...store,
        writeChecked: (...args: Parameters<typeof store.writeChecked>) => {
          if (!failed) {
            failed = true;
            return Effect.fail(
              ResourceIoFailed.make({
                uri: args[1],
                operation: 'write',
                message: 'Synthetic interrupted native artifact write',
                cause: new Error('Synthetic interrupted native artifact write'),
              }),
            );
          }
          return store.writeChecked(...args);
        },
      };
      const interrupted = yield* failure(f.call(replace).pipe(Effect.provideService(ResourceStore, guardedStore)));
      expect(Result.isFailure(interrupted)).toBe(true);
      expect(failed).toBe(true);
      expect(record(JSON.parse(yield* f.fs.readFileString(statePath)), 'native state')).toMatchObject({
        operations: expect.arrayContaining([
          expect.objectContaining({
            status: 'prepared',
            intent: expect.objectContaining({operationId: 'replace-interrupted'}),
          }),
        ]),
      });
      expect(yield* f.fs.readFileString(journalPath)).not.toBe(beforeJournal);
      const recovered = yield* f.call({...f.base('recover'), operationId: 'replace-interrupted'});
      expect(recovered).toMatchObject({
        status: 'ok',
        operationId: 'replace-interrupted',
        artifact: {body: replace.body},
      });
      const journalAfter = record(JSON.parse(yield* f.fs.readFileString(journalPath)), 'journal');
      expect(EffectRecord.keys(record(journalAfter.artifacts, 'journal artifacts'))).toHaveLength(1);
      expect(record(JSON.parse(yield* f.fs.readFileString(statePath)), 'native state')).toMatchObject({
        operations: expect.arrayContaining([
          expect.objectContaining({
            status: 'verified',
            intent: expect.objectContaining({operationId: 'replace-interrupted'}),
          }),
        ]),
      });
    }).pipe(run),
  );

  effectIt.effect('recovers native success when the local verified receipt rename is interrupted', () =>
    Effect.gen(function* () {
      const f = yield* nativeFixture();
      const initialized = yield* f.init();
      const stateFile = f.path.join(
        yield* f.fs.realPath(f.home),
        'workflow-automations',
        'native-v1',
        'native-run.json',
      );
      const journalFile = f.journalPath(initialized.bindingId);
      const originalFs = yield* FileSystem.FileSystem;
      let stateCommits = 0;
      const interruptedFs = FileSystem.FileSystem.of({
        ...originalFs,
        rename: (from, to) =>
          to === stateFile && ++stateCommits === 2
            ? Effect.sync(() => {
                throw new Error('Synthetic native receipt rename interruption');
              })
            : originalFs.rename(from, to),
      });
      const result = yield* failure(
        f.call(f.write()).pipe(Effect.provideService(FileSystem.FileSystem, interruptedFs)),
      );
      expect(Result.isFailure(result)).toBe(true);
      const nativeState = record(JSON.parse(yield* f.fs.readFileString(stateFile)), 'native state');
      expect(nativeState.operations).toMatchObject([{status: 'prepared'}]);
      const pendingStateBytes = yield* f.fs.readFileString(stateFile);
      const verifiedJournal = yield* f.fs.readFileString(journalFile);
      expect(record(JSON.parse(verifiedJournal), 'journal')).toMatchObject({
        operations: {'write-1': {status: 'verified'}},
      });
      const inspection = yield* f.call(f.base('inspect'));
      expect(inspection).toMatchObject({operations: [{status: 'prepared'}]});
      expect(yield* f.fs.readFileString(stateFile)).toBe(pendingStateBytes);
      const recovered = yield* f.call({...f.base('recover'), operationId: 'write-1'});
      expect(recovered).toMatchObject({status: 'ok', operationId: 'write-1'});
      expect(record(JSON.parse(yield* f.fs.readFileString(stateFile)), 'native state')).toMatchObject({
        operations: [{status: 'verified'}],
      });
      expect(yield* f.fs.readFileString(journalFile)).toBe(verifiedJournal);
    }).pipe(run),
  );
});
