import {isJsonObject} from '@threadnote/platform/json';
import {it as effectIt} from '@effect/vitest';
import {Effect, FileSystem, Path, Schema} from 'effect';
import {TestClock} from 'effect/testing';
import {describe, expect} from 'vitest';
import {runCommandEffect} from '@threadnote/platform/command';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {SystemInfo} from '@threadnote/platform/system';
import {ResourceIoFailed, ResourceStore} from '@threadnote/store/resource-store';
import {ApplicationLayer} from '../../src/effect/runtime.js';
import {runWorkflowMemory} from '../../src/workflow_memory/index.js';
import {stableJson, type WorkflowBinding} from '../../src/workflow_memory/protocol.js';
import {provideTestLayer} from '../helpers/effect-layer.js';

import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

// These tests compose the public protocol, native binding/journal and real ResourceStore.
// No CLI process, model, graph preparation or normal user home is involved.

function requireJournalRecord(text: string): Record<string, unknown> {
  const value: unknown = JSON.parse(text);
  if (!isJsonObject(value)) throw new Error('Expected a workflow journal object.');
  return value;
}

function requireManifestUri(journal: Record<string, unknown>): string {
  if (typeof journal.manifestUri !== 'string') throw new Error('Expected a workflow manifest URI.');
  return journal.manifestUri;
}

function requireOperationStatus(journal: Record<string, unknown>, operationId: string): string {
  if (!isJsonObject(journal.operations)) throw new Error('Expected workflow journal operations.');
  const operation = journal.operations[operationId];
  if (!isJsonObject(operation) || typeof operation.status !== 'string')
    throw new Error('Expected the workflow operation status in its journal.');
  return operation.status;
}

const provide = <A, E, R>(program: Effect.Effect<A, E, R>) =>
  program.pipe(TestClock.withLive, provideTestLayer(ApplicationLayer));

const fixture = Effect.fn('test.workflowInspection.fixture')(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const system = yield* SystemInfo;
  const store = yield* ResourceStore;
  const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-workflow-inspection-'});
  const home = path.join(root, 'home');
  const repo = path.join(root, 'repo');
  yield* fs.makeDirectory(home);
  yield* fs.makeDirectory(repo);
  yield* fs.writeFileString(path.join(repo, 'source.ts'), 'export const preserved = true;\n');
  yield* runCommandEffect('git', ['init', '--initial-branch=main', repo]);
  const config = {
    account: 'local',
    user: 'tester',
    agentId: 'test',
    agentContextHome: home,
    manifestPath: path.join(home, 'manifest.json'),
  };
  const scopedSystem = {...system, currentDirectory: () => repo, environment: () => ({})};
  const call = (input: unknown, current = config) =>
    runWorkflowMemory(current, input).pipe(Effect.provideService(SystemInfo, scopedSystem));
  const manifestUris = new Map<string, string>();
  const bind = (workflowRunId: string, generation: string) =>
    call({
      protocolVersion: 1,
      action: 'bind',
      workflowRunId,
      generation,
      project: 'fixture',
      featureId: 'feature',
    }).pipe(
      Effect.map(result => {
        if (!('binding' in result)) throw new Error('Expected native binding');
        return result.binding;
      }),
      Effect.tap(binding =>
        fs.readFileString(path.join(home, 'workflow-memory', `${binding.bindingId}.json`)).pipe(
          Effect.map(text => {
            const journal = requireJournalRecord(text);
            if (typeof journal.manifestUri !== 'string') throw new Error('Expected a workflow manifest URI.');
            return manifestUris.set(binding.bindingId, journal.manifestUri);
          }),
        ),
      ),
    );
  const binding = yield* bind('original-writer', 'source-immutable-legacy-fixture');
  const journalPath = path.join(home, 'workflow-memory', `${binding.bindingId}.json`);
  const journal = () => fs.readFileString(journalPath).pipe(Effect.map(requireJournalRecord));
  const body = 'Private inspection fixture — 仕様\n';
  const write = {
    protocolVersion: 1 as const,
    action: 'create' as const,
    bindingId: binding.bindingId,
    operationId: 'create-1',
    artifactKey: 'plan-root',
    sourceRunId: 'source-writer',
    role: 'root',
    body,
    bodySha256: sha256HexSync(body),
    expectedRevision: null,
  };
  const request = (selected: WorkflowBinding = binding, operationId = write.operationId) => ({
    protocolVersion: 1 as const,
    action: 'inspect-operation' as const,
    bindingId: selected.bindingId,
    generation: selected.generation,
    bindingHash: sha256HexSync(stableJson(selected)),
    operationId,
    intentDigest: sha256HexSync(stableJson(write)),
  });
  const seed = (state: 'absent' | 'prepared' | 'verified') =>
    Effect.gen(function* () {
      if (state === 'absent') return;
      if (state === 'verified') {
        yield* call(write);
        return;
      }
      const result = yield* call(write).pipe(
        Effect.provideService(ResourceStore, {
          ...store,
          writeChecked: (_location, uri) =>
            Effect.fail(
              ResourceIoFailed.make({
                uri,
                operation: 'write',
                message: 'Synthetic checked-write refusal',
                cause: new Error('Synthetic checked-write refusal'),
              }),
            ),
        }),
        Effect.result,
      );
      expect(result).toMatchObject({_tag: 'Failure', failure: {_tag: 'ResourceIoFailed'}});
      expect(requireOperationStatus(yield* journal(), write.operationId)).toBe('prepared');
    });
  const inspect = (input: unknown, current = config) =>
    Effect.gen(function* () {
      const manifestUri =
        input !== null && typeof input === 'object' && 'bindingId' in input && typeof input.bindingId === 'string'
          ? manifestUris.get(input.bindingId)
          : undefined;
      const denied = () => Effect.die('Inspection attempted a canonical mutation');
      const guardedStore = {
        ...store,
        makeDirectory: denied,
        mutate: denied,
        mutateChecked: denied,
        remove: denied,
        write: denied,
        writeChecked: denied,
        read: (location: Parameters<typeof store.read>[0], uri: string) => {
          expect(uri, 'Inspection must read only the selected binding manifest, never an artifact').toBe(manifestUri);
          return store.read(location, uri);
        },
      };
      const guardedFs = FileSystem.FileSystem.of({
        ...fs,
        writeFileString: (file, ...args) =>
          Effect2.pipe(file, EffectString.endsWith('.lock')) ? fs.writeFileString(file, ...args) : denied(),
        writeFile: denied,
        rename: denied,
        remove: (file, options) =>
          Effect2.pipe(file, EffectString.endsWith('.lock')) ? fs.remove(file, options) : denied(),
      });
      return yield* call(input, current).pipe(
        Effect.provideService(ResourceStore, guardedStore),
        Effect.provideService(FileSystem.FileSystem, guardedFs),
      );
    });
  return {fs, path, root, home, repo, config, call, bind, binding, journalPath, journal, write, request, seed, inspect};
});

const snapshot = Effect.fn('test.workflowInspection.snapshot')(function* (root: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const files: Record<string, string> = {};
  const pending = [''];
  while (pending.length) {
    const relative = pending.pop()!;
    const absolute = path.join(root, relative);
    const info = yield* fs.stat(absolute);
    if (info.type === 'Directory') {
      for (const child of yield* fs.readDirectory(absolute)) pending.push(relative ? `${relative}/${child}` : child);
    } else if (info.type === 'File' && !Effect2.pipe(relative, EffectString.endsWith('.lock'))) {
      files[relative] = Buffer.from(yield* fs.readFile(absolute)).toString('base64');
    }
  }
  return files;
});

const expected = (
  request: ReturnType<Effect.Success<ReturnType<typeof fixture>>['request']>,
  operationState: string,
) => ({
  protocolVersion: 1,
  status: 'ok',
  bindingId: request.bindingId,
  generation: request.generation,
  bindingHash: request.bindingHash,
  operationId: request.operationId,
  intentDigest: request.intentDigest,
  operationState,
});

describe('non-reconciling workflow operation inspection', () => {
  effectIt.effect('reports absence only from a valid bound journal without changing canonical bytes', () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const before = yield* snapshot(f.root);
      const input = Object.freeze(f.request());
      expect(yield* f.inspect(input)).toEqual(expected(input, 'absent'));
      expect(yield* f.inspect(input)).toEqual(expected(input, 'absent'));
      for (const operationId of ['constructor', 'toString']) {
        const prototypeName = f.request(f.binding, operationId);
        expect(yield* f.inspect(prototypeName)).toEqual(expected(prototypeName, 'absent'));
      }
      expect(yield* snapshot(f.root)).toEqual(before);
      expect((yield* f.journal()).binding).toEqual(f.binding);
      expect(yield* f.call({protocolVersion: 1, action: 'capabilities'})).toMatchObject({
        operations: expect.arrayContaining(['inspect-operation']),
      });
    }).pipe(provide),
  );

  for (const state of ['prepared', 'verified'] as const) {
    effectIt.effect(`reports ${state} without executing, reading or replaying the artifact`, () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* f.seed(state);
        const before = yield* snapshot(f.root);
        const input = f.request();
        const result = yield* f.inspect(input);
        expect(result).toEqual(expected(input, state));
        // oxlint-disable-next-line effecttsgo/prefer-effect-record -- This value is not a total homogeneous readonly record accepted by Effect Record.
        expect(Object.keys(result).sort()).toEqual(Object.keys(expected(input, state)).sort());
        expect(JSON.stringify(result)).not.toContain(Effect2.pipe(f.write.body, EffectString.trim));
        expect(yield* snapshot(f.root)).toEqual(before);
      }).pipe(provide),
    );
  }

  effectIt.effect('refuses changed expected identity and intent while preserving the valid old binding', () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.seed('verified');
      const before = yield* snapshot(f.root);
      for (const change of [
        {generation: 'new-helper-generation'},
        {bindingHash: Effect2.pipe('0', EffectString.repeat(64))},
        {intentDigest: Effect2.pipe('0', EffectString.repeat(64))},
      ]) {
        expect(yield* f.inspect({...f.request(), ...change}).pipe(Effect.result)).toMatchObject({
          _tag: 'Failure',
          failure: {code: 'intentDigest' in change ? 'operation-intent-conflict' : 'binding-drift'},
        });
        expect(yield* snapshot(f.root)).toEqual(before);
      }
      expect(
        yield* f.inspect({...f.request(), bindingId: Effect2.pipe('0', EffectString.repeat(64))}).pipe(Effect.result),
      ).toMatchObject({
        _tag: 'Failure',
        failure: {code: 'task-state-lost'},
      });
      for (const change of [{account: 'other-account'}, {user: 'other-user'}, {agentId: 'other-agent'}]) {
        expect(yield* f.inspect(f.request(), {...f.config, ...change}).pipe(Effect.result)).toMatchObject({
          _tag: 'Failure',
          failure: {code: 'binding-drift'},
        });
      }
      expect(yield* snapshot(f.root)).toEqual(before);
    }).pipe(provide),
  );

  effectIt.effect('strictly rejects missing, extra and malformed inspection fields', () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const before = yield* snapshot(f.root);
      const valid = f.request();
      const invalid: unknown[] = [
        null,
        {...valid, body: 'must not be accepted'},
        {...valid, generation: ''},
        {...valid, operationId: '../escape'},
        {...valid, operationId: ''},
        {...valid, bindingId: 'not-a-binding'},
        {...valid, operationId: 'a\n'},
        {...valid, generation: '\n'},
        {...valid, generation: 1},
        {...valid, bindingHash: Effect2.pipe('A', EffectString.repeat(64))},
        {...valid, intentDigest: Effect2.pipe('g', EffectString.repeat(64))},
        {...valid, intentDigest: Effect2.pipe('a', EffectString.repeat(63))},
        {...valid, intentDigest: Effect2.pipe('a', EffectString.repeat(64)) + '\n'},
      ];
      for (const key of ['bindingId', 'generation', 'bindingHash', 'operationId', 'intentDigest'] as const) {
        const missing = {...valid} as Record<string, unknown>;
        delete missing[key];
        invalid.push(missing);
      }
      for (const input of invalid) expect((yield* f.inspect(input).pipe(Effect.result))._tag).toBe('Failure');
      expect(yield* snapshot(f.root)).toEqual(before);
    }).pipe(provide),
  );

  for (const damage of [
    'missing-journal',
    'corrupt-journal',
    'missing-manifest',
    'changed-manifest',
    'unfinished-manifest',
  ] as const) {
    effectIt.effect(`refuses ${damage} without treating it as absence or repairing it`, () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        const state = yield* f.journal();
        const manifestUri = requireManifestUri(state);
        const store = yield* ResourceStore;
        const location = {home: f.home, account: f.config.account, user: f.config.user};
        if (damage === 'missing-journal') yield* f.fs.remove(f.journalPath);
        else if (damage === 'corrupt-journal') yield* f.fs.writeFileString(f.journalPath, '{');
        else if (damage === 'missing-manifest') yield* store.remove(location, manifestUri);
        else if (damage === 'changed-manifest') yield* store.write(location, manifestUri, 'changed', {mode: 'replace'});
        else {
          const failed = yield* f.call(f.write).pipe(
            Effect.provideService(ResourceStore, {
              ...store,
              write: (current, uri, content, options) =>
                uri === manifestUri
                  ? Effect.fail(
                      ResourceIoFailed.make({
                        uri,
                        operation: 'write',
                        message: 'Synthetic manifest write refusal',
                        cause: new Error('Synthetic manifest write refusal'),
                      }),
                    )
                  : store.write(current, uri, content, options),
            }),
            Effect.result,
          );
          expect(failed).toMatchObject({_tag: 'Failure', failure: {_tag: 'ResourceIoFailed'}});
          expect((yield* f.journal()).manifestCommitted).toBe(false);
          expect(requireOperationStatus(yield* f.journal(), f.write.operationId)).toBe('verified');
        }
        const before = yield* snapshot(f.root);
        // Corrupt/missing journals cannot be read by the fixture guard either: query the public route directly.
        const result = yield* f.inspect(f.request()).pipe(Effect.result);
        expect(result._tag).toBe('Failure');
        if (damage === 'unfinished-manifest')
          expect(result).toMatchObject({_tag: 'Failure', failure: {code: 'binding-recovery-needed'}});
        expect(yield* snapshot(f.root)).toEqual(before);
      }).pipe(provide),
    );
  }

  effectIt.effect.prop(
    'keeps operation namespaces and identity expectations independent without mutating snapshots or inputs',
    {
      state: Schema.Literals(['absent', 'prepared', 'verified']),
      otherNamespace: Schema.Boolean,
      operationId: Schema.Literals(['create-1', 'constructor', 'toString']),
      identity: Schema.Literals(['exact', 'generation', 'binding-hash', 'intent']),
    },
    ({state, otherNamespace, operationId, identity}) =>
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* f.seed(state);
        const other = yield* f.bind('independent-writer', 'different-immutable-generation');
        const input = {
          ...f.request(otherNamespace ? other : f.binding, operationId),
          ...(identity === 'generation' ? {generation: 'changed'} : {}),
          ...(identity === 'binding-hash' ? {bindingHash: Effect2.pipe('0', EffectString.repeat(64))} : {}),
          ...(identity === 'intent' ? {intentDigest: Effect2.pipe('0', EffectString.repeat(64))} : {}),
        };
        const originalInput = JSON.stringify(input);
        Object.freeze(input);
        const before = yield* snapshot(f.root);
        const result = yield* f.inspect(input).pipe(Effect.result);
        const operationState = otherNamespace || operationId !== 'create-1' ? 'absent' : state;
        if (identity === 'generation' || identity === 'binding-hash') {
          expect(result).toMatchObject({_tag: 'Failure', failure: {code: 'binding-drift'}});
        } else if (identity === 'intent' && operationState !== 'absent') {
          expect(result).toMatchObject({_tag: 'Failure', failure: {code: 'operation-intent-conflict'}});
        } else {
          expect(result._tag).toBe('Success');
          if (result._tag === 'Success') expect(result.success).toEqual(expected(input, operationState));
        }
        expect(yield* snapshot(f.root)).toEqual(before);
        expect(JSON.stringify(input)).toBe(originalInput);
      }).pipe(provide),
    {arbitrary: {runs: 6}},
  );
});
