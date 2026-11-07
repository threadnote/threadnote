import {cryptoLayer} from '@threadnote/platform/crypto';
import * as EffectArray from 'effect/Array';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
/* oxlint-disable effecttsgo/strict-effect-provide -- Scoped Effect test entrypoints provide narrow OS layers. */
import {it as effectIt} from '@effect/vitest';
import * as BunServices from '@effect/platform-bun/BunServices';
import {Deferred, Effect, Fiber, FileSystem, Layer, Path, Schema} from 'effect';
import {TestClock} from 'effect/testing';
import {describe, expect, it} from 'vitest';
import fc from 'fast-check';
import {Observation} from '@threadnote/semantic/contracts';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {sha256FileHex} from '@threadnote/platform/digest';
import {CommandExecutor} from '@threadnote/platform/command';
import {ChildEnvironmentPolicy} from '@threadnote/platform/child-environment-policy';
import {makePythonSession, makePythonNotifications} from '../../src/semantic/providers/python.js';
import {makePythonProject, pythonMetadataResponder} from '../../src/semantic/providers/python_project.js';
import {makeLspClient, spawnLspWire, type LspClient} from '../../src/semantic/lsp_transport.js';
import {semanticTreeDigest, semanticCatalogKey, makeSemanticCoordinator} from '../../src/semantic/coordinator.js';
import {TestCommandExecutorLayer, TestSystemInfoLayer} from '../helpers/system-layer.js';
const io = Layer.merge(BunServices.layer, cryptoLayer);
const commands = TestCommandExecutorLayer.pipe(Layer.provide(Layer.merge(io, TestSystemInfoLayer)));
const initial = (uri: string, text: string, root: string): Observation => ({
  version: 1,
  repository: 'python-fixture',
  worktree: root,
  project: root,
  configuration: EffectString.repeat(64)('a'),
  toolchain: EffectString.repeat(64)('b'),
  provider: {id: 'basedpyright', version: '1.40.2', generation: 0},
  view: {kind: 'overlay', id: 'python-view', owner: 'test', epoch: 0},
  uri,
  content: sha256HexSync(text),
  documentVersion: 1,
  projectEpoch: 0,
});
const capabilities = {
  positionEncoding: 'utf-16',
  definitionProvider: true,
  referencesProvider: true,
  hoverProvider: true,
  documentSymbolProvider: true,
  renameProvider: true,
  codeActionProvider: true,
};
const fake = (
  request: LspClient['request'] = () => Effect.succeed(null),
  advertised: Record<string, Schema.Json> = capabilities,
): LspClient => ({
  pid: 1,
  request: (method, params, ms) =>
    method === 'initialize'
      ? Effect.succeed({capabilities: advertised, serverInfo: {name: 'basedpyright', version: '1.40.2'}})
      : method === 'textDocument/documentSymbol'
        ? Effect.succeed([])
        : request(method, params, ms),
  notify: () => Effect.void,
  close: Effect.succeed({code: 0, drained: true, forced: false, stdioClosed: true, fault: undefined, graceful: true}),
});
const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({prefix: 'tn-python-'}));
  const project = path.join(root, 'project');
  yield* fs.makeDirectory(project);
  const uri = (yield* path.toFileUrl(path.join(project, 'main.py'))).href;
  const projectUri = (yield* path.toFileUrl(project)).href;
  const text = 'value = 1\nprint(value)\n';
  yield* fs.writeFileString(path.join(project, 'main.py'), text);
  const basis = initial(uri, text, projectUri);
  const notifications = makePythonNotifications();
  const options = {
    basis,
    notifications,
    roots: [],
    profile: {kind: 'static'},
    environmentReady: Effect.void,
    startupMilliseconds: 1000,
  };
  return {fs, path, root, project, uri, text, basis, notifications, options};
});
const diagnostic = {
  range: {start: {line: 0, character: 0}, end: {line: 0, character: 5}},
  code: 'reportAssignmentType',
  message: 'Type mismatch',
  severity: 1,
};
describe('Python session fences and preparation', () => {
  effectIt.effect('fences a multi-request hierarchy when the source changes before incoming calls finish', () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const entered = yield* Deferred.make<void>();
      const incoming = yield* Deferred.make<Schema.Json>();
      const root = {name: 'value', kind: 12, uri: f.uri, range: diagnostic.range, selectionRange: diagnostic.range};
      const client = fake(
        method =>
          method === 'textDocument/prepareCallHierarchy'
            ? Effect.succeed([root])
            : method === 'callHierarchy/incomingCalls'
              ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(incoming)))
              : Effect.die('Obsolete hierarchy continued: ' + method),
        {...capabilities, callHierarchyProvider: true},
      );
      const session = yield* makePythonSession(client, f.options);
      const first = yield* session.upsert(f.basis, f.text, 'python', 1000);
      const pending = yield* Effect.forkChild(session.query('call-hierarchy', first, {line: 0, character: 1}, 1000));
      yield* Deferred.await(entered);
      const text = f.text + '# changed\n';
      yield* session.upsert({...f.basis, content: sha256HexSync(text), documentVersion: 2}, text, 'python', 1000);
      yield* Deferred.succeed(incoming, []);
      expect((yield* Fiber.join(pending)).status).toBe('stale');
    }).pipe(Effect.provide(io)),
  );
  effectIt.effect('rejects an incompatible provider before opening a source view', () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const ordinary = fake();
      const client: LspClient = {
        ...ordinary,
        request: (method, params, ms) =>
          method === 'initialize'
            ? Effect.succeed({capabilities, serverInfo: {name: 'basedpyright', version: '0.0.0'}})
            : ordinary.request(method, params, ms),
      };
      expect((yield* Effect.exit(makePythonSession(client, f.options)))._tag).toBe('Failure');
    }).pipe(Effect.provide(io)),
  );
  effectIt.effect(
    'keeps observation identity on supported completion and hierarchy reads and makes missing features explicit',
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const root = {
          name: 'value',
          kind: 12,
          uri: f.uri,
          range: {start: {line: 0, character: 0}, end: {line: 1, character: 12}},
          selectionRange: diagnostic.range,
          data: {providerCookie: 'fixture'},
        };
        const ordinary = fake(method => {
          if (method === 'textDocument/completion')
            return Effect.succeed({
              isIncomplete: true,
              items: [
                {
                  label: 'value',
                  insertText: 'value',
                  command: {command: 'unsafe'},
                  textEdit: {range: diagnostic.range, newText: 'unsafe'},
                },
              ],
            });
          if (method === 'textDocument/prepareCallHierarchy') return Effect.succeed([root]);
          if (method === 'callHierarchy/incomingCalls')
            return Effect.succeed([{from: root, fromRanges: [diagnostic.range]}]);
          if (method === 'callHierarchy/outgoingCalls') return Effect.succeed([]);
          return Effect.die('Unexpected optional method ' + method);
        });
        const client: LspClient = {
          ...ordinary,
          request: (method, params, ms) =>
            method === 'initialize'
              ? Effect.succeed({
                  capabilities: {
                    ...capabilities,
                    completionProvider: {},
                    callHierarchyProvider: true,
                    typeHierarchyProvider: false,
                  },
                  serverInfo: {name: 'basedpyright', version: '1.40.2'},
                })
              : ordinary.request(method, params, ms),
        };
        const session = yield* makePythonSession(client, f.options);
        const observation = yield* session.upsert(f.basis, f.text, 'python', 1000);
        const completion = yield* session.query('completion', observation, {line: 0, character: 1}, 1000);
        expect(completion.status).toBe('ok');
        if (completion.status === 'ok') {
          expect(completion.evidence.observation).toEqual(observation);
          expect(completion.items).toEqual([
            {
              kind: 'completion-list',
              readOnly: true,
              isIncomplete: true,
              suggestions: [{label: 'value', insertText: 'value'}],
            },
          ]);
        }
        const hierarchy = yield* session.query('call-hierarchy', observation, {line: 0, character: 1}, 1000);
        expect(hierarchy.status).toBe('ok');
        if (hierarchy.status === 'ok') {
          expect(hierarchy.evidence.observation).toEqual(observation);
          expect(hierarchy.items).toMatchObject([{root: {uri: f.uri}, incoming: [{from: {uri: f.uri}}], outgoing: []}]);
        }
        const missing = yield* session.query('type-hierarchy', observation, {line: 0, character: 1}, 1000);
        expect(missing.status).toBe('unsupported');
        expect(missing.evidence?.observation).toEqual(observation);
      }).pipe(Effect.provide(io)),
  );
  effectIt.effect('hashes original closed-file bytes when the provider text has a UTF-8 BOM', () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const uri = f.basis.project + '/bom.py';
      const bytes = new TextEncoder().encode('\uFEFFvalue = "Ω"\r\n');
      yield* f.fs.writeFile(f.path.join(f.project, 'bom.py'), bytes);
      const session = yield* makePythonSession(
        fake(() =>
          Effect.succeed({
            changes: {
              [uri]: [{range: {start: {line: 0, character: 1}, end: {line: 0, character: 6}}, newText: 'renamed'}],
            },
          }),
        ),
        f.options,
      );
      const observation = yield* session.upsert(f.basis, f.text, 'python', 1000);
      const result = yield* session.prepare('rename', observation, {line: 0, character: 1}, 'renamed', 1000);
      expect(result.status).toBe('ok');
      if (result.status === 'ok')
        expect(result.items).toMatchObject([{files: [{content: sha256HexSync(bytes), source: 'disk'}]}]);
      expect(Array.from(yield* f.fs.readFile(f.path.join(f.project, 'bom.py')))).toEqual(Array.from(bytes));
    }).pipe(Effect.provide(io)),
  );
  effectIt.effect('announces a changed dependency before advancing unchanged document diagnostic versions', () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const events: {
        uri: string;
        version: number;
      }[] = [];
      const client = {
        ...fake(),
        notify: (method: string, params: Schema.Json) =>
          Effect.gen(function* () {
            if (method === 'textDocument/didOpen' || method === 'textDocument/didChange') {
              const event = yield* Schema.decodeUnknownEffect(
                Schema.Struct({
                  textDocument: Schema.Struct({uri: Schema.String, version: Schema.Finite}),
                }),
              )(params).pipe(Effect.orDie);
              events.push(event.textDocument);
            }
          }),
      };
      const session = yield* makePythonSession(client, f.options);
      yield* session.upsert(f.basis, f.text, 'python', 1000);
      const b = {...f.basis, uri: f.basis.project + '/b.py'};
      yield* session.upsert(b, f.text, 'python', 1000);
      events.length = 0;
      const text = f.text + '# changed\n';
      yield* session.upsert({...b, content: sha256HexSync(text), documentVersion: 2}, text, 'python', 1000);
      expect(EffectArray.map(events, event => event.uri)).toEqual([b.uri, f.uri]);
    }).pipe(Effect.provide(io)),
  );
  effectIt.effect.prop(
    'prepares non-overlapping edits deterministically in source order without changing bytes',
    [Schema.Int.check(Schema.isBetween({minimum: 2, maximum: 12}))],
    ([count]) =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const text = EffectString.repeat(count)('x\n');
        const edits = Array.from({length: count}, (_, line) => ({
          range: {start: {line, character: 0}, end: {line, character: 1}},
          newText: 'renamed',
        }));
        const session = yield* makePythonSession(
          fake(() => Effect.succeed({changes: {[f.uri]: [...edits].reverse()}})),
          f.options,
        );
        const observation = yield* session.upsert({...f.basis, content: sha256HexSync(text)}, text, 'python', 1000);
        const result = yield* session.prepare('rename', observation, {line: 0, character: 0}, 'renamed', 1000);
        expect(result.status).toBe('ok');
        if (result.status === 'ok') expect(result.items).toMatchObject([{files: [{edits}]}]);
        expect(yield* f.fs.readFileString(f.path.join(f.project, 'main.py'))).toBe(f.text);
      }).pipe(Effect.provide(io)),
    {arbitrary: {runs: 30}},
  );
  effectIt.effect('retains string diagnostic codes and original observations in resolved deltas', () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const session = yield* makePythonSession(fake(), f.options);
      const first = yield* session.upsert(f.basis, f.text, 'python', 1000);
      f.notifications.receive('textDocument/publishDiagnostics', {uri: f.uri, version: 1, diagnostics: [diagnostic]});
      const a = yield* session.diagnostics(first, 1000);
      expect(EffectArray.map(a.added, item => item.code)).toEqual(['reportAssignmentType']);
      const same = yield* session.diagnostics(first, 1000);
      expect(same.remaining).toEqual(a.items);
      expect(same.added).toEqual([]);
      expect(same.resolved).toEqual([]);
      const nextText = f.text + '# fixed\n';
      const next = yield* session.upsert(
        {...f.basis, content: sha256HexSync(nextText), documentVersion: 2},
        nextText,
        'python',
        1000,
      );
      for (const version of [undefined, 0, 1, 3])
        f.notifications.receive('textDocument/publishDiagnostics', {uri: f.uri, version, diagnostics: [diagnostic]});
      const pending = yield* Effect.forkChild(session.diagnostics(next, 1000));
      yield* Effect.yieldNow;
      f.notifications.receive('textDocument/publishDiagnostics', {uri: f.uri, version: 2, diagnostics: []});
      const b = yield* Fiber.join(pending);
      expect(b.items).toEqual([]);
      expect(b.resolved).toMatchObject([{item: {code: diagnostic.code}, observation: first, resolvedIn: next}]);
      expect((yield* session.query('hover', first, {line: 0, character: 1}, 1000)).status).toBe('stale');
    }).pipe(Effect.provide(io)),
  );
  effectIt.effect('rejects delayed reads when another document changes and resynchronizes diagnostic versions', () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const entered = yield* Deferred.make<void>();
      const response = yield* Deferred.make<Schema.Json>();
      const session = yield* makePythonSession(
        fake(() => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(response)))),
        f.options,
      );
      const a = yield* session.upsert(f.basis, f.text, 'python', 1000);
      const query = yield* Effect.forkChild(session.query('hover', a, {line: 0, character: 1}, 1000));
      yield* Deferred.await(entered);
      const other = {...f.basis, uri: f.basis.project + '/other.py'};
      yield* session.upsert(other, f.text, 'python', 1000);
      yield* Deferred.succeed(response, {contents: 'int'});
      expect((yield* Fiber.join(query)).status).toBe('stale');
      const rebound = yield* session.upsert(a, f.text, 'python', 1000);
      f.notifications.receive('textDocument/publishDiagnostics', {uri: f.uri, version: 1, diagnostics: [diagnostic]});
      f.notifications.receive('textDocument/publishDiagnostics', {uri: f.uri, version: 2, diagnostics: []});
      expect((yield* session.diagnostics(rebound, 1000)).items).toEqual([]);
    }).pipe(Effect.provide(io)),
  );
  effectIt.effect('prepares all cross-file edits with source preconditions and never mutates files', () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const second = f.basis.project + '/other.py';
      yield* f.fs.writeFileString(f.path.join(f.project, 'other.py'), 'value = 2\n');
      const edit = {range: diagnostic.range, newText: 'renamed'};
      const session = yield* makePythonSession(
        fake(() =>
          Effect.succeed({
            documentChanges: [
              {textDocument: {uri: f.uri, version: null}, edits: [edit]},
              {textDocument: {uri: second, version: null}, edits: [edit]},
            ],
          }),
        ),
        f.options,
      );
      const observation = yield* session.upsert(f.basis, f.text, 'python', 1000);
      const result = yield* session.prepare('rename', observation, {line: 0, character: 1}, 'renamed', 1000);
      expect(result.status).toBe('ok');
      if (result.status === 'ok')
        expect(result.items).toMatchObject([
          {
            applied: false,
            files: [
              {uri: f.uri, content: sha256HexSync(f.text), documentVersion: 1, source: 'overlay'},
              {uri: second, content: sha256HexSync('value = 2\n'), documentVersion: null, source: 'disk'},
            ],
          },
        ]);
      expect(yield* f.fs.readFileString(f.path.join(f.project, 'main.py'))).toBe(f.text);
      expect(yield* f.fs.readFileString(f.path.join(f.project, 'other.py'))).toBe('value = 2\n');
    }).pipe(Effect.provide(io)),
  );
  for (const [name, payload] of EffectRecord.toEntries({
    'resource operations': {documentChanges: [{kind: 'rename', oldUri: 'file:///a', newUri: 'file:///b'}]},
    'outside targets': {changes: {'file:///etc/passwd': [{range: diagnostic.range, newText: 'x'}]}},
    'overlapping edits': {
      changes: {
        $URI: [
          {range: diagnostic.range, newText: 'x'},
          {range: diagnostic.range, newText: 'y'},
        ],
      },
    },
    'stale provider versions': {
      documentChanges: [{textDocument: {uri: '$URI', version: 20}, edits: [{range: diagnostic.range, newText: 'x'}]}],
    },
  }))
    effectIt.effect('rejects ' + name + ' without partial preparation', () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const raw = JSON.parse(EffectString.replaceAll('$URI', f.uri)(JSON.stringify(payload)));
        const session = yield* makePythonSession(
          fake(() => Effect.succeed(raw)),
          f.options,
        );
        const observation = yield* session.upsert(f.basis, f.text, 'python', 1000);
        expect(
          (yield* Effect.exit(session.prepare('rename', observation, {line: 0, character: 1}, 'renamed', 1000)))._tag,
        ).toBe('Failure');
      }).pipe(Effect.provide(io)),
    );
  effectIt.effect('drops command-bearing actions and preserves the complete safe inline action', () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const edit = {
        changes: {[f.uri]: [{range: {start: {line: 0, character: 0}, end: {line: 0, character: 0}}, newText: '_ = '}]},
      };
      const methods: string[] = [];
      const session = yield* makePythonSession(
        fake(method =>
          Effect.sync<Schema.Json>(() => {
            methods.push(method);
            const actions: Schema.Json[] = [
              {title: 'unsafe', command: {command: 'basedpyright.writeBaseline'}, edit},
              {title: 'organize', command: 'basedpyright.organizeimports'},
              {title: 'safe', edit},
            ];
            return actions;
          }),
        ),
        f.options,
      );
      const observation = yield* session.upsert(f.basis, f.text, 'python', 1000);
      const result = yield* session.prepare('code-action', observation, {line: 0, character: 0}, undefined, 1000);
      expect(result.status).toBe('ok');
      if (result.status === 'ok') expect(result.items).toMatchObject([{title: 'safe', applied: false}]);
      expect(methods).toEqual(['textDocument/codeAction']);
      expect((yield* Effect.exit(session.prepare('rename', observation, {line: 0, character: 0}, '', 1000)))._tag).toBe(
        'Failure',
      );
    }).pipe(Effect.provide(io)),
  );
  effectIt.effect.prop(
    'never accepts a diagnostic version other than the current wire version',
    [Schema.Int.check(Schema.isBetween({minimum: 2, maximum: 2000}))],
    ([wrong]) =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const session = yield* makePythonSession(fake(), f.options);
        const current = yield* session.upsert(f.basis, f.text, 'python', 1000);
        f.notifications.receive('textDocument/publishDiagnostics', {
          uri: f.uri,
          version: wrong,
          diagnostics: [diagnostic],
        });
        f.notifications.receive('textDocument/publishDiagnostics', {uri: f.uri, version: 1, diagnostics: []});
        expect((yield* session.diagnostics(current, 1000)).items).toEqual([]);
      }).pipe(Effect.provide(io)),
    {arbitrary: {runs: 30}},
  );
});
const environmentFixture = Effect.gen(function* () {
  const f = yield* fixture;
  const library = f.path.join(f.root, 'library');
  yield* f.fs.makeDirectory(library);
  yield* f.fs.writeFileString(f.path.join(library, 'dependency.pyi'), 'def selected() -> int: ...\n');
  const metadataFile = f.path.join(f.root, 'environment.json');
  const body = JSON.stringify({
    format: 'threadnote-static-python-environment-v1',
    version: [3, 12, 13],
    provenance: 'Test fixture static metadata',
    prefix: f.root,
    roots: [{directory: library, digest: yield* semanticTreeDigest(library)}],
  });
  yield* f.fs.writeFileString(metadataFile, body);
  return {...f, library, environment: {id: 'test-env', metadataFile, metadataDigest: sha256HexSync(body)}};
});
const noExecute = CommandExecutor.of({
  execute: () => Effect.die('Unexpected execution'),
  executeStreaming: () => Effect.die('Unexpected execution'),
});
describe('Python static environment qualification', () => {
  effectIt.effect('rejects config and static analysis roots inside the excluded Git namespace', () =>
    Effect.gen(function* () {
      const f = yield* environmentFixture;
      yield* f.fs.makeDirectory(f.path.join(f.project, '.git'));
      yield* f.fs.writeFileString(f.path.join(f.project, '.git', 'HEAD'), 'ref: refs/heads/main\n');
      yield* f.fs.writeFileString(f.path.join(f.project, '.git', 'python.json'), '{}');
      const options = {
        project: f.project,
        worktree: f.project,
        privateDirectory: f.path.join(f.root, 'private'),
        runtime: process.execPath,
        environment: f.environment,
      };
      for (const config of [{extends: '.git/python.json'}, {extraPaths: ['.git']}, {include: ['.git']}]) {
        yield* f.fs.writeFileString(f.path.join(f.project, 'pyrightconfig.json'), JSON.stringify(config));
        expect((yield* Effect.exit(makePythonProject(options)))._tag).toBe('Failure');
      }
      yield* f.fs.remove(f.path.join(f.project, 'pyrightconfig.json'));
      yield* f.fs.writeFileString(f.path.join(f.project, 'unsafe.pth'), '.git\n');
      expect((yield* Effect.exit(makePythonProject(options)))._tag).toBe('Failure');
    }).pipe(Effect.provide(io)),
  );
  effectIt.effect.prop(
    'verifies immutable configuration idempotently under concurrent readers',
    [Schema.Int.check(Schema.isBetween({minimum: 2, maximum: 6}))],
    ([readers]) =>
      Effect.gen(function* () {
        const f = yield* environmentFixture;
        yield* f.fs.writeFileString(f.path.join(f.project, 'pyrightconfig.json'), '{"extends":"base.json"}');
        yield* f.fs.writeFileString(f.path.join(f.project, 'base.json'), '{"typeCheckingMode":"strict"}');
        const project = yield* makePythonProject({
          project: f.project,
          worktree: f.project,
          privateDirectory: f.path.join(f.root, 'private'),
          runtime: process.execPath,
          environment: f.environment,
        });
        yield* Effect.all(
          Array.from({length: readers}, () => project.verify),
          {concurrency: 'unbounded'},
        );
        expect(project.profile.environment).toBe(f.environment.id);
      }).pipe(Effect.provide(io)),
    {arbitrary: {runs: 8}},
  );
  effectIt.effect('rejects URI and backslash paths even when POSIX lookalike directories exist', () =>
    Effect.gen(function* () {
      const f = yield* environmentFixture;
      for (const value of ['file:///outside/libs', '..\\outside']) {
        yield* f.fs.makeDirectory(f.path.resolve(f.project, value), {recursive: true});
        yield* f.fs.writeFileString(
          f.path.join(f.project, 'pyrightconfig.json'),
          JSON.stringify({extraPaths: [value]}),
        );
        expect(
          (yield* Effect.exit(
            makePythonProject({
              project: f.project,
              worktree: f.project,
              privateDirectory: f.path.join(f.root, 'private'),
              runtime: process.execPath,
              environment: f.environment,
            }),
          ))._tag,
        ).toBe('Failure');
      }
      yield* f.fs.remove(f.path.join(f.project, 'pyrightconfig.json'));
      yield* f.fs.writeFileString(f.path.join(f.project, 'unsafe.pth'), '..\\outside\n');
      expect(
        (yield* Effect.exit(
          makePythonProject({
            project: f.project,
            worktree: f.project,
            privateDirectory: f.path.join(f.root, 'private'),
            runtime: process.execPath,
            environment: f.environment,
          }),
        ))._tag,
      ).toBe('Failure');
    }).pipe(Effect.provide(io)),
  );
  effectIt.effect('rejects ancestor fallback, conflicting TOML sections and cyclic extends', () =>
    Effect.gen(function* () {
      const f = yield* environmentFixture;
      const options = {
        project: f.project,
        worktree: f.project,
        privateDirectory: f.path.join(f.root, 'private'),
        runtime: process.execPath,
        environment: f.environment,
      };
      yield* f.fs.writeFileString(f.path.join(f.project, 'pyproject.toml'), '[project]\nname = "fixture"\n');
      yield* f.fs.writeFileString(f.path.join(f.root, 'pyrightconfig.json'), '{"extraPaths":["/outside"]}');
      expect((yield* Effect.exit(makePythonProject(options)))._tag).toBe('Failure');
      yield* f.fs.remove(f.path.join(f.root, 'pyrightconfig.json'));
      yield* f.fs.writeFileString(f.path.join(f.project, 'pyproject.toml'), '[tool.pyright]\n[tool.basedpyright]\n');
      expect((yield* Effect.exit(makePythonProject(options)))._tag).toBe('Failure');
      yield* f.fs.remove(f.path.join(f.project, 'pyproject.toml'));
      yield* f.fs.writeFileString(f.path.join(f.project, 'pyrightconfig.json'), '{"extends":"base.json"}');
      yield* f.fs.writeFileString(f.path.join(f.project, 'base.json'), '{"extends":"pyrightconfig.json"}');
      expect((yield* Effect.exit(makePythonProject(options)))._tag).toBe('Failure');
    }).pipe(Effect.provide(io)),
  );
  effectIt.effect('rejects a symlink inserted after the first project fingerprint pass', () =>
    Effect.gen(function* () {
      const f = yield* environmentFixture;
      let projectReads = 0;
      let outsideRead = false;
      const guarded = {
        ...f.fs,
        readDirectory: (directory: string) =>
          Effect.gen(function* () {
            if (directory === f.project && ++projectReads === 2)
              yield* f.fs.symlink(f.root, f.path.join(f.project, 'late-link'));
            if (EffectString.endsWith('/late-link')(directory)) outsideRead = true;
            return yield* f.fs.readDirectory(directory);
          }),
      };
      const result = yield* Effect.exit(
        makePythonProject({
          project: f.project,
          worktree: f.project,
          privateDirectory: f.path.join(f.root, 'private'),
          runtime: process.execPath,
          environment: f.environment,
        }).pipe(Effect.provideService(FileSystem.FileSystem, guarded)),
      );
      expect(result._tag).toBe('Failure');
      expect(projectReads).toBe(2);
      expect(outsideRead).toBe(false);
    }).pipe(Effect.provide(io)),
  );
  for (const [name, config] of EffectRecord.toEntries({
    'venv override': {venvPath: '/outside', venv: 'unsafe'},
    'execution environment': {executionEnvironments: [{root: '.'}]},
    'external extraPaths': {extraPaths: ['/outside']},
    'different Python version': {pythonVersion: '3.13'},
    'external extends': {extends: '../outside.json'},
    'unknown path authority': {customPath: '/outside'},
  }))
    effectIt.effect('rejects ' + name, () =>
      Effect.gen(function* () {
        const f = yield* environmentFixture;
        yield* f.fs.writeFileString(f.path.join(f.project, 'pyrightconfig.json'), JSON.stringify(config));
        const result = yield* Effect.exit(
          makePythonProject({
            project: f.project,
            worktree: f.project,
            privateDirectory: f.path.join(f.root, 'private'),
            runtime: process.execPath,
            environment: f.environment,
          }),
        );
        expect(result._tag).toBe('Failure');
      }).pipe(Effect.provide(io), Effect.provideService(CommandExecutor, noExecute)),
    );
  for (const [name, body] of EffectRecord.toEntries({
    'executable pth': 'import malicious\n',
    'escaping pth': '../../outside\n',
  }))
    effectIt.effect('rejects ' + name + ' without launching an interpreter', () =>
      Effect.gen(function* () {
        const f = yield* environmentFixture;
        yield* f.fs.writeFileString(f.path.join(f.project, 'unsafe.pth'), body);
        expect(
          (yield* Effect.exit(
            makePythonProject({
              project: f.project,
              worktree: f.project,
              privateDirectory: f.path.join(f.root, 'private'),
              runtime: process.execPath,
              environment: f.environment,
            }),
          ))._tag,
        ).toBe('Failure');
      }).pipe(Effect.provide(io), Effect.provideService(CommandExecutor, noExecute)),
    );
  effectIt.effect('fences dependency and metadata changes after selection', () =>
    Effect.gen(function* () {
      const f = yield* environmentFixture;
      const project = yield* makePythonProject({
        project: f.project,
        worktree: f.project,
        privateDirectory: f.path.join(f.root, 'private'),
        runtime: process.execPath,
        environment: f.environment,
      });
      yield* project.verify;
      yield* f.fs.writeFileString(f.path.join(f.library, 'dependency.pyi'), 'def selected() -> str: ...\n');
      expect((yield* Effect.exit(project.verify))._tag).toBe('Failure');
      expect(project.profile.interpreterExecution).toBe(false);
    }).pipe(Effect.provide(io), Effect.provideService(CommandExecutor, noExecute)),
  );
  it('canonicalizes catalog ordering without merging different environments', () => {
    const envs = EffectArray.map(['a', 'b', 'c'], id => ({
      id,
      metadataFile: '/host/' + id,
      metadataDigest: EffectString.repeat(64)(id),
    }));
    const python = {
      runtime: '/host/node',
      runtimeDigest: EffectString.repeat(64)('d'),
      runtimeVersion: '24.19.0' as const,
      serverDirectory: '/host/server',
      serverTreeDigest: EffectString.repeat(64)('e'),
      environments: envs,
    };
    fc.assert(
      fc.property(fc.shuffledSubarray(envs, {minLength: 3, maxLength: 3}), environments => {
        expect(semanticCatalogKey({python: {...python, environments}})).toBe(semanticCatalogKey({python}));
      }),
      {numRuns: 50},
    );
    expect(semanticCatalogKey({python: {...python, environments: [envs[0]]}})).not.toBe(semanticCatalogKey({python}));
  });
  effectIt.effect('rejects unrecognized metadata probe argv without running its payload', () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const file = f.path.join(f.root, 'responder.mjs');
      yield* f.fs.writeFileString(
        file,
        pythonMetadataResponder({path: ['/host/libs'], prefix: '/host/env', version: [3, 12, 13]}),
      );
      const command = yield* CommandExecutor;
      for (const args of [
        [],
        ['--version'],
        ['-c', 'process.stdout.write("EXECUTED")'],
        ['-I', '-c', 'raise RuntimeError()'],
        ['-c', 'import json', 'extra'],
      ]) {
        const result = yield* command.execute(process.execPath, [file, ...args], {
          env: {},
          allowFailure: true,
          timeoutMs: 2000,
        });
        expect(result.exitCode).toBe(64);
        expect(result.stdout).toBe('');
      }
      expect(yield* f.fs.exists(f.path.join(f.root, 'paths.ok'))).toBe(false);
    }).pipe(Effect.provide(Layer.merge(io, commands)), TestClock.withLive),
  );
});
const serverDirectory = process.env.THREADNOTE_PYTHON_PROVIDER_DIRECTORY;
const node = process.env.THREADNOTE_PYTHON_NODE;
describe.skipIf(!serverDirectory || !node || process.platform === 'win32')('pinned basedpyright static profile', () => {
  effectIt.effect(
    'shares admission across environment switches and never reserves a slot for rejected project configuration',
    () =>
      Effect.gen(function* () {
        const f = yield* environmentFixture;
        const runtime = yield* f.fs.realPath(node!);
        const server = yield* f.fs.realPath(serverDirectory!);
        const libraryB = f.path.join(f.root, 'library-b');
        yield* f.fs.makeDirectory(libraryB);
        yield* f.fs.writeFileString(f.path.join(libraryB, 'dependency.pyi'), 'def selected() -> str: ...\n');
        const metadataFile = f.path.join(f.root, 'environment-b.json');
        const metadata = JSON.stringify({
          format: 'threadnote-static-python-environment-v1',
          version: [3, 12, 13],
          provenance: 'Test fixture second dependency version',
          prefix: f.root,
          roots: [{directory: libraryB, digest: yield* semanticTreeDigest(libraryB)}],
        });
        yield* f.fs.writeFileString(metadataFile, metadata);
        const second = {id: 'environment-b', metadataFile, metadataDigest: sha256HexSync(metadata)};
        const coordinator = yield* makeSemanticCoordinator({
          enabled: true,
          dataHome: f.root,
          python: {
            runtime,
            runtimeDigest: yield* sha256FileHex(runtime),
            runtimeVersion: '24.19.0',
            serverDirectory: server,
            serverTreeDigest: yield* semanticTreeDigest(server),
            environments: [f.environment, second],
          },
        });
        yield* f.fs.writeFileString(
          f.path.join(f.project, 'pyrightconfig.json'),
          JSON.stringify({venv: 'unsupported'}),
        );
        for (let i = 0; i < 3; i++) {
          const observation = {...f.basis, view: {...f.basis.view, id: 'invalid-' + i}};
          expect((yield* Effect.exit(coordinator.attach(observation, f.text, 'python', f.environment.id)))._tag).toBe(
            'Failure',
          );
          expect((yield* coordinator.status).providers).toBe(0);
        }
        yield* f.fs.remove(f.path.join(f.project, 'pyrightconfig.json'));
        const text = 'from dependency import selected\nresult = selected()\n';
        const firstRoot = f.path.join(f.project, 'first-root');
        yield* f.fs.makeDirectory(firstRoot);
        yield* f.fs.writeFileString(f.path.join(firstRoot, 'main.py'), text);
        const firstUri = (yield* f.path.toFileUrl(firstRoot)).href;
        const otherRoot = f.path.join(f.project, 'second-root');
        yield* f.fs.makeDirectory(otherRoot);
        yield* f.fs.writeFileString(f.path.join(otherRoot, 'main.py'), text);
        const basis = {...f.basis, project: firstUri, uri: firstUri + '/main.py', content: sha256HexSync(text)};
        const a = yield* coordinator.attach(basis, text, 'python', f.environment.id);
        const hoverA = yield* coordinator.use(a.observation, 10000, api =>
          api.query('hover', a.observation, {line: 1, character: 12}, 10000),
        );
        expect(JSON.stringify(hoverA)).toContain('int');
        expect((yield* coordinator.status).providers).toBe(1);
        expect((yield* Effect.exit(coordinator.attach(basis, text, 'python', second.id)))._tag).toBe('Failure');
        expect((yield* coordinator.status).providers).toBe(0);
        const b = yield* coordinator.attach(basis, text, 'python', second.id);
        expect(b.observation.toolchain).not.toBe(a.observation.toolchain);
        const hoverB = yield* coordinator.use(b.observation, 10000, api =>
          api.query('hover', b.observation, {line: 1, character: 12}, 10000),
        );
        expect(JSON.stringify(hoverB)).toContain('str');
        const otherUri = (yield* f.path.toFileUrl(otherRoot)).href;
        const c = yield* coordinator.attach(
          {...basis, project: otherUri, uri: otherUri + '/main.py', view: {...basis.view, id: 'second-root-view'}},
          text,
          'python',
          f.environment.id,
        );
        expect(c.observation.project).toBe(otherUri);
        expect(c.observation.toolchain).not.toBe(b.observation.toolchain);
        const navigation = yield* coordinator.use(c.observation, 10000, api =>
          api.query('definition', c.observation, {line: 1, character: 12}, 10000),
        );
        expect(navigation.status).toBe('ok');
        if (navigation.status === 'ok')
          expect(navigation.items).toMatchObject([
            {uri: (yield* f.path.toFileUrl(f.path.join(f.library, 'dependency.pyi'))).href},
          ]);
        const references = yield* coordinator.use(c.observation, 10000, api =>
          api.query('references', c.observation, {line: 1, character: 12}, 10000),
        );
        expect(references.status).toBe('ok');
        if (references.status === 'ok') {
          expect(references.evidence.observation.project).toBe(otherUri);
          if (hoverB.status === 'ok') expect(references.evidence.scope).not.toBe(hoverB.evidence.scope);
          expect(
            EffectArray.some(
              references.items,
              item =>
                Schema.decodeUnknownSync(
                  Schema.Struct({
                    uri: Schema.String,
                  }),
                )(item).uri ===
                otherUri + '/main.py',
            ),
          ).toBe(true);
          expect(
            EffectArray.every(
              references.items,
              item =>
                Schema.decodeUnknownSync(
                  Schema.Struct({
                    uri: Schema.String,
                  }),
                )(item).uri !== a.observation.uri,
            ),
          ).toBe(true);
        }
        expect((yield* coordinator.status).providers).toBe(2);
        yield* coordinator.closeView(c.observation);
        yield* coordinator.closeView(b.observation);
        expect((yield* coordinator.status).providers).toBe(0);
      }).pipe(
        Effect.provide(Layer.mergeAll(io, commands, TestSystemInfoLayer)),
        Effect.provideService(ChildEnvironmentPolicy, {
          sanitizeExternal: env => env,
          preserveIntendedChild: env => env,
        }),
        TestClock.withLive,
      ),
    60000,
  );
  effectIt.effect(
    'runs real reads, diagnostics, cross-file rename and an inline quick fix without executing Python',
    () =>
      Effect.gen(function* () {
        const f = yield* environmentFixture;
        const runtime = yield* f.fs.realPath(node!);
        const server = yield* f.fs.realPath(serverDirectory!);
        const source =
          'from model import Alpha, Beta\r\nalias = Alpha()\r\nalias.run()\r\nBeta().run()\r\n# 😀 café Ω\r\nfrom bom import first\r\nprint(first)\r\n';
        const modelSource =
          'class Alpha:\n    def run(self) -> int:\n        return 1\n\n\nclass Beta:\n    def run(self) -> int:\n        return 2\n';
        yield* f.fs.writeFileString(f.path.join(f.project, 'model.py'), modelSource);
        yield* f.fs.writeFileString(f.path.join(f.project, 'main.py'), source);
        const bomSource = '\uFEFFfirst = 1\r\n';
        yield* f.fs.writeFile(f.path.join(f.project, 'bom.py'), new TextEncoder().encode(bomSource));
        yield* f.fs.writeFileString(
          f.path.join(f.project, 'pyrightconfig.json'),
          JSON.stringify({typeCheckingMode: 'strict', reportUnusedCallResult: 'warning'}),
        );
        // These would execute at Python startup or through a repository-selected wrapper.
        for (const name of ['sitecustomize.py', 'usercustomize.py', 'json.py', 'os.py'])
          yield* f.fs.writeFileString(
            f.path.join(f.project, name),
            'from pathlib import Path\nPath("executed-sentinel").write_text("executed")\n',
          );
        yield* f.fs.makeDirectory(f.path.join(f.project, '.venv', 'bin'), {recursive: true});
        yield* f.fs.writeFileString(
          f.path.join(f.project, '.venv', 'bin', 'python'),
          '#!/bin/sh\necho executed > executed-sentinel\nexit 1\n',
          {mode: 0o700},
        );
        const basis = initial(f.uri, source, f.basis.project);
        const before = yield* semanticTreeDigest(f.project);
        const project = yield* makePythonProject({
          project: f.project,
          worktree: f.project,
          privateDirectory: f.path.join(f.root, "private space ' quote Ω"),
          runtime,
          environment: f.environment,
        });
        const wire = yield* spawnLspWire({
          command: runtime,
          args: [f.path.join(server, 'langserver.index.js'), '--stdio'],
          cwd: f.project,
          environment: {},
        });
        const notifications = makePythonNotifications();
        const client = yield* makeLspClient(wire, notifications.receive, project.settings);
        const session = yield* makePythonSession(client, {
          basis,
          notifications,
          roots: [f.library, server],
          profile: project.profile,
          environmentReady: project.ready,
          startupMilliseconds: 10000,
        });
        const observation = yield* session.upsert(basis, source, 'python', 10000);
        expect((yield* session.query('definition', observation, {line: 2, character: 7}, 10000)).status).toBe('ok');
        expect((yield* session.query('hover', observation, {line: 2, character: 7}, 10000)).status).toBe('ok');
        expect((yield* session.query('symbols', observation, undefined, 10000)).status).toBe('ok');
        const completion = yield* session.query('completion', observation, {line: 2, character: 6}, 10000);
        expect(completion.status).toBe('ok');
        if (completion.status === 'ok') {
          expect(completion.evidence.observation).toEqual(observation);
          expect(
            EffectArray.some(
              (yield* Schema.decodeUnknownEffect(
                Schema.Struct({
                  suggestions: Schema.Array(
                    Schema.Struct({
                      label: Schema.String,
                    }),
                  ),
                }),
              )(completion.items[0])).suggestions,
              item => item.label === 'run',
            ),
          ).toBe(true);
        }
        const hierarchy = yield* session.query('call-hierarchy', observation, {line: 2, character: 7}, 10000);
        expect(hierarchy.status).toBe('ok');
        if (hierarchy.status === 'ok') {
          expect(hierarchy.evidence.observation).toEqual(observation);
          expect(hierarchy.items).toMatchObject([
            {root: {uri: f.basis.project + '/model.py'}, incoming: expect.any(Array), outgoing: expect.any(Array)},
          ]);
        }
        expect((yield* session.query('type-hierarchy', observation, {line: 2, character: 7}, 10000)).status).toBe(
          'unsupported',
        );
        const references = yield* session.query('references', observation, {line: 2, character: 7}, 10000);
        expect(references.status).toBe('ok');
        if (references.status === 'ok')
          expect(
            EffectArray.map(
              references.items,
              item =>
                Schema.decodeUnknownSync(
                  Schema.Struct({
                    range: Schema.Struct({
                      start: Schema.Struct({
                        line: Schema.Finite,
                      }),
                    }),
                  }),
                )(item).range.start.line,
            ).sort(),
          ).toEqual([1, 2]);
        const rename = yield* session.prepare('rename', observation, {line: 2, character: 7}, 'exécute', 10000);
        expect(rename.status).toBe('ok');
        if (rename.status === 'ok') {
          expect(rename.items).toHaveLength(1);
          const files = (yield* Schema.decodeUnknownEffect(
            Schema.Struct({
              files: Schema.Array(
                Schema.Struct({
                  uri: Schema.String,
                }),
              ),
            }),
          )(rename.items[0])).files;
          expect([...files].sort((a, b) => EffectString.localeCompare(b.uri)(a.uri))).toEqual(
            [
              {
                uri: f.uri,
                content: sha256HexSync(source),
                documentVersion: 1,
                source: 'overlay',
                edits: [{range: {start: {line: 2, character: 6}, end: {line: 2, character: 9}}, newText: 'exécute'}],
              },
              {
                uri: f.basis.project + '/model.py',
                content: sha256HexSync(modelSource),
                documentVersion: null,
                source: 'disk',
                edits: [{range: {start: {line: 1, character: 8}, end: {line: 1, character: 11}}, newText: 'exécute'}],
              },
            ].sort((a, b) => EffectString.localeCompare(b.uri)(a.uri)),
          );
        }
        const bomRename = yield* session.prepare('rename', observation, {line: 6, character: 7}, 'initial', 10000);
        expect(bomRename.status).toBe('ok');
        if (bomRename.status === 'ok') {
          expect(bomRename.items).toHaveLength(1);
          const files = (yield* Schema.decodeUnknownEffect(
            Schema.Struct({
              files: Schema.Array(
                Schema.Struct({
                  uri: Schema.String,
                }),
              ),
            }),
          )(bomRename.items[0])).files;
          expect([...files].sort((a, b) => EffectString.localeCompare(b.uri)(a.uri))).toEqual(
            [
              {
                uri: f.uri,
                content: sha256HexSync(source),
                documentVersion: 1,
                source: 'overlay',
                edits: [
                  {range: {start: {line: 5, character: 16}, end: {line: 5, character: 21}}, newText: 'initial'},
                  {range: {start: {line: 6, character: 6}, end: {line: 6, character: 11}}, newText: 'initial'},
                ],
              },
              {
                uri: f.basis.project + '/bom.py',
                content: sha256HexSync(bomSource),
                documentVersion: null,
                source: 'disk',
                edits: [{range: {start: {line: 0, character: 1}, end: {line: 0, character: 6}}, newText: 'initial'}],
              },
            ].sort((a, b) => EffectString.localeCompare(b.uri)(a.uri)),
          );
        }
        const diagnostics = yield* session.diagnostics(observation, 10000);
        expect(EffectArray.some(diagnostics.items, d => d.code === 'reportUnusedCallResult')).toBe(true);
        const actions = yield* session.prepare('code-action', observation, {line: 2, character: 0}, undefined, 10000);
        expect(actions.status).toBe('ok');
        if (actions.status === 'ok') expect(actions.items.length).toBeGreaterThan(0);
        expect(yield* semanticTreeDigest(f.project)).toBe(before);
        expect((yield* session.close).drained).toBe(true);
        yield* project.verify;
        expect(project.profile).toMatchObject({interpreterExecution: false, environment: 'test-env'});
      }).pipe(
        Effect.provide(Layer.merge(io, commands)),
        Effect.provideService(ChildEnvironmentPolicy, {
          sanitizeExternal: env => env,
          preserveIntendedChild: env => env,
        }),
        TestClock.withLive,
      ),
    30000,
  );
});

describe('Python foreground-source qualification barrier', () => {
  for (const accepted of [true, false]) {
    effectIt.effect(`requires a current versioned diagnostic acknowledgment: ${accepted}`, () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const requested = yield* Deferred.make<void>();
        let renames = 0;
        const client = fake(method =>
          Effect.gen(function* () {
            if (method !== 'textDocument/rename') return null;
            renames++;
            yield* Deferred.succeed(requested, undefined);
            return {changes: {[f.uri]: [{range: diagnostic.range, newText: 'next'}]}};
          }),
        );
        const session = yield* makePythonSession(client, {
          ...f.options,
          captureEditSource: () => Effect.die('Owned overlay must not be read from disk'),
        });
        const view = yield* session.upsert(f.basis, f.text, 'python', 1000);
        // Wrong and unversioned publications never authorize the foreground rename.
        f.notifications.receive('textDocument/publishDiagnostics', {uri: f.uri, version: 0, diagnostics: []});
        f.notifications.receive('textDocument/publishDiagnostics', {uri: f.uri, diagnostics: []});
        const pending = yield* Effect.forkChild(
          Effect.exit(session.prepare('rename', view, {line: 0, character: 1}, 'next', 1000)),
        );
        yield* Deferred.await(requested);
        if (accepted)
          f.notifications.receive('textDocument/publishDiagnostics', {
            uri: f.uri,
            version: 1,
            diagnostics: [diagnostic],
          });
        else yield* TestClock.adjust(1001);
        const result = yield* Fiber.join(pending);
        expect(renames).toBe(accepted ? 2 : 1);
        expect(result._tag).toBe(accepted ? 'Success' : 'Failure');
        if (accepted) expect((yield* session.diagnostics(view, 1000)).added).toHaveLength(1);
        if (accepted && result._tag === 'Success')
          expect(result.value).toMatchObject({
            status: 'ok',
            items: [
              {sourceBasis: 'pre-request-synchronized-text-v1', files: [{beforeText: f.text, observation: view}]},
            ],
          });
      }).pipe(Effect.provide(io)),
    );
  }
});
