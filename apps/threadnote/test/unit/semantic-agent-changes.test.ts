import * as HostProfile from '../../src/semantic/host_profile.js';
import {ChildEnvironmentPolicy} from '@threadnote/platform/child-environment-policy';
import {CommandExecutor} from '@threadnote/platform/command';
import {cryptoLayer} from '@threadnote/platform/crypto';
import {LspFault} from '../../src/semantic/lsp_transport.js';
import {it} from '@effect/vitest';
import {Array as EffectArray, Effect, FileSystem, Layer, Path, Schema, String as EffectString} from 'effect';
import * as BunFileSystem from '@effect/platform-bun/BunFileSystem';
import * as BunPath from '@effect/platform-bun/BunPath';
import {expect, vi} from 'vitest';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {canonicalFileUri, type Observation, type QueryOutcome} from '@threadnote/semantic/contracts';
import type {SemanticSession} from '../../src/semantic/provider.js';
import {makeSemanticAgentChanges, runSemanticAgentChangeWith} from '../../src/semantic/agent_changes.js';
import {semanticHostProfileName} from '../../src/semantic/host_profile.js';
import type {SemanticAgentQueryHost} from '../../src/semantic/agent_queries.js';
import {TestSystemInfoLayer} from '../helpers/system-layer.js';

// This fixture grants protocol tests only their own current profile bytes; native ACL proof is tested separately.
const protocolProfiles = new Map<
  string,
  {readonly account: string; readonly user: string; readonly worktree: string}
>();
const protocolProfileKey = (config: RuntimeConfig, worktree: string) =>
  JSON.stringify([config.agentContextHome, config.account, config.user, worktree]);
const nativeReadProfile = HostProfile.readSemanticHostProfile;
let restoreProtocolProfiles: (() => void) | undefined;
const trustProtocolProfile = (config: RuntimeConfig, worktree: string) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      if (!restoreProtocolProfiles) {
        const spy = vi.spyOn(HostProfile, 'readSemanticHostProfile').mockImplementation((current, requested) => {
          const owned = protocolProfiles.get(protocolProfileKey(current, requested));
          if (!owned) return nativeReadProfile(current, requested);
          const reject = (reason: typeof HostProfile.SemanticHostProfileFault.prototype.reason) =>
            HostProfile.SemanticHostProfileFault.make({reason});
          return Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const path = yield* Path.Path;
            if (current.account !== owned.account || current.user !== owned.user) return yield* reject('untrusted');
            if (requested !== owned.worktree) return yield* reject('incompatible');
            if ((yield* fs.realPath(current.agentContextHome)) !== current.agentContextHome)
              return yield* reject('untrusted');
            const file = path.join(
              current.agentContextHome,
              'semantic',
              'profiles',
              semanticHostProfileName(current, requested),
            );
            if (!(yield* fs.exists(file))) return yield* reject('missing');
            const bytes = yield* fs.readFile(file);
            if (bytes.length > 16384) return yield* reject('invalid');
            const text = yield* Effect.try({
              try: () => new TextDecoder('utf-8', {fatal: true}).decode(bytes),
              catch: () => reject('invalid'),
            });
            const value = yield* Effect.try({try: () => JSON.parse(text), catch: () => reject('invalid')});
            const profile = yield* Schema.decodeUnknownEffect(HostProfile.SemanticHostProfile, {
              onExcessProperty: 'error',
            })(value).pipe(Effect.mapError(() => reject('invalid')));
            if (profile.worktree !== requested) return yield* reject('incompatible');
            if (!profile.enabled) return yield* reject('disabled');
            return {home: current.agentContextHome, profile, digest: sha256HexSync(text)};
          }).pipe(
            Effect.mapError(error =>
              Schema.is(HostProfile.SemanticHostProfileFault)(error) ? error : reject('untrusted'),
            ),
          );
        });
        restoreProtocolProfiles = () => spy.mockRestore();
      }
      protocolProfiles.set(protocolProfileKey(config, worktree), {
        account: config.account,
        user: config.user,
        worktree,
      });
    }),
    () =>
      Effect.sync(() => {
        protocolProfiles.delete(protocolProfileKey(config, worktree));
        if (protocolProfiles.size === 0) {
          restoreProtocolProfiles?.();
          restoreProtocolProfiles = undefined;
        }
      }),
  );

const io = Layer.mergeAll(
  BunFileSystem.layer,
  BunPath.layer,
  TestSystemInfoLayer,
  cryptoLayer,
  Layer.succeed(ChildEnvironmentPolicy, {sanitizeExternal: env => env, preserveIntendedChild: env => env}),
  Layer.succeed(
    CommandExecutor,
    CommandExecutor.of({
      execute: () => Effect.die('Unexpected command'),
      executeStreaming: () => Effect.die('Unexpected command'),
    }),
  ),
);
const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({prefix: 'tn-proposal-auth-'}));
  const root = path.join(directory, 'repository');
  const home = path.join(directory, 'private');
  yield* fs.makeDirectory(root);
  yield* fs.writeFileString(path.join(root, 'a.ts'), 'export const target = 1;');
  yield* fs.makeDirectory(path.join(home, 'semantic', 'profiles'), {recursive: true, mode: 0o700});
  const config: RuntimeConfig = {
    account: 'local',
    user: 'tester',
    agentId: 'test',
    agentContextHome: home,
    manifestPath: path.join(home, 'manifest.json'),
  };
  const worktree = (yield* path.toFileUrl(root)).href;
  yield* trustProtocolProfile(config, worktree);
  const profileFile = path.join(home, 'semantic', 'profiles', semanticHostProfileName(config, worktree));
  const profile = {
    version: 1,
    enabled: true,
    worktree,
    catalog: {
      candidate: {
        runtime: '/fixture/node',
        runtimeDigest: sha256HexSync('node'),
        runtimeVersion: '24.19.0',
        sdkDirectory: '/fixture/typescript',
        sdkTreeDigest: sha256HexSync('sdk'),
        serverDirectory: '/fixture/server',
        serverTreeDigest: sha256HexSync('server'),
      },
    },
  };
  yield* fs.writeFileString(profileFile, JSON.stringify(profile), {mode: 0o600});
  const request = {
    version: 1,
    action: 'prepare',
    callerCwd: root,
    file: 'a.ts',
    language: 'typescript',
    operation: 'rename',
    position: {line: 0, character: 13},
    newName: 'renamed',
  };
  return {fs, path, home, worktree, config, request, profile, profileFile};
});
it.effect('rejects caller-supplied authority and unqualified code actions before provider dispatch', () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    let calls = 0;
    const host: SemanticAgentQueryHost = {
      runtimeIdentity: Effect.succeed(sha256HexSync('runtime')),
      connect: () =>
        Effect.sync(() => {
          calls++;
          return {request: () => Effect.succeed({status: 'unexpected'})};
        }),
    };
    for (const extra of [{writeAuthorized: true}, {operations: []}, {principal: 'administrator'}]) {
      expect(yield* runSemanticAgentChangeWith(host, f.config, {...f.request, ...extra})).toMatchObject({
        status: 'invalid-request',
        applicable: false,
      });
    }
    expect(yield* runSemanticAgentChangeWith(host, f.config, {...f.request, operation: 'code-action'})).toMatchObject({
      status: 'invalid-request',
      applicable: false,
    });
    expect(calls).toBe(0);
  }).pipe(
    // oxlint-disable-next-line effecttsgo/strict-effect-provide -- Scoped filesystem/profile boundary test.
    Effect.provide(io),
  ),
);
it.effect('explicit saved-disk selector and omitted default dispatch the same canonical request', () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const requests: unknown[] = [];
    const host: SemanticAgentQueryHost = {
      runtimeIdentity: Effect.succeed(sha256HexSync('runtime')),
      connect: () =>
        Effect.succeed({
          request: body =>
            Effect.sync(() => {
              requests.push(body);
              return {version: 1, status: 'ok'};
            }),
        }),
    };
    expect(yield* runSemanticAgentChangeWith(host, f.config, f.request)).toEqual(
      yield* runSemanticAgentChangeWith(host, f.config, {...f.request, view: 'disk'}),
    );
    expect(requests).toHaveLength(2);
    expect(requests[0]).toEqual(requests[1]);
  }).pipe(
    // oxlint-disable-next-line effecttsgo/strict-effect-provide -- Scoped filesystem/profile boundary test.
    Effect.provide(io),
  ),
);
it.effect('rechecks protected read authorization after retrieval before exposing retained source', () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const host: SemanticAgentQueryHost = {
      runtimeIdentity: Effect.succeed(sha256HexSync('runtime')),
      connect: () =>
        Effect.succeed({
          request: () =>
            f.fs.writeFileString(f.profileFile, JSON.stringify({...f.profile, enabled: false})).pipe(
              Effect.as({version: 1, status: 'ok', retainedSource: 'PRIVATE_SOURCE_SENTINEL'}),
              Effect.mapError(() => LspFault.make({code: 'protocol'})),
            ),
        }),
    };
    const handle = {
      id: sha256HexSync('id'),
      digest: sha256HexSync('digest'),
      capability: sha256HexSync('read-capability'),
    };
    const result = yield* runSemanticAgentChangeWith(host, f.config, {
      version: 1,
      action: 'status',
      callerCwd: f.request.callerCwd,
      handle,
    });
    expect(result).toMatchObject({applicable: false});
    expect(JSON.stringify(result)).not.toContain('PRIVATE_SOURCE_SENTINEL');
    expect(JSON.stringify(result)).not.toContain(handle.capability);
  }).pipe(
    // oxlint-disable-next-line effecttsgo/strict-effect-provide -- Scoped filesystem/profile boundary test.
    Effect.provide(io),
  ),
);

it.effect('rolls back failed publication quotas and fences the initiating view after provider use', () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const path = yield* Path.Path;
    const worktree = canonicalFileUri((yield* path.toFileUrl(f.request.callerCwd)).href);
    const uri = canonicalFileUri((yield* path.toFileUrl(path.join(f.request.callerCwd, 'a.ts'))).href);
    const text = 'export const target = 1;';
    const observed: Observation = {
      version: 1,
      repository: 'repo',
      worktree,
      project: worktree,
      uri,
      configuration: sha256HexSync('config'),
      toolchain: sha256HexSync('tools'),
      provider: {id: 'typescript-language-server', version: '6.0.2', generation: 1},
      view: {kind: 'disk', id: 'disk', owner: 'test', epoch: 0},
      content: sha256HexSync(text),
      documentVersion: null,
      projectEpoch: 0,
    };
    const outcome: QueryOutcome = {
      version: 1,
      status: 'ok',
      evidence: {basis: 'semantic', observation: observed, scope: 'project', completeness: 'complete', limitations: []},
      items: [
        {
          kind: 'prepared-edit',
          operation: 'rename',
          sourceBasis: 'pre-request-synchronized-text-v1',
          files: [
            {
              observation: observed,
              beforeText: text,
              edits: [{range: {start: {line: 0, character: 13}, end: {line: 0, character: 19}}, newText: 'renamed'}],
              precondition: {
                sourceKind: 'disk',
                rawDigest: observed.content,
                encoding: 'utf-8',
                physicalIdentity: 'inode',
                owner: 'test',
                documentVersion: null,
              },
            },
          ],
        },
      ],
    };
    let actionCalls = 0;
    const blockedChoice = {
      kind: 'action-choice',
      title: 'Opaque command',
      actionKind: 'quickfix',
      disabled: null,
      command: true,
      qualified: false,
      selector: sha256HexSync('command'),
      queryDigest: sha256HexSync('query'),
      blocker: 'command',
    };
    const session: SemanticSession = {
      actions: (_observation, _query, _milliseconds, selection) =>
        Effect.sync(() => {
          actionCalls++;
          return {
            ...outcome,
            items: selection
              ? [{kind: 'action-result', status: 'unsupported', reason: 'command'}, blockedChoice]
              : [blockedChoice],
          };
        }),
      prepare: () => Effect.succeed(outcome),
      upsert: () => Effect.die('Unexpected upsert'),
      query: () => Effect.die('Unexpected query'),
      diagnostics: () => Effect.die('Unexpected diagnostics'),
      project: () => Effect.succeed({configuration: '/unused/tsconfig.json'}),
      observation: () => Effect.succeed(observed),
      available: Effect.succeed(true),
      invalidate: Effect.void,
      close: Effect.succeed({
        code: 0,
        drained: true,
        forced: false,
        stdioClosed: true,
        fault: undefined,
        graceful: true,
      }),
    };
    let stale = false;
    let invalidateAfterUse = false;
    const directory = path.join(f.request.callerCwd, 'private-preview');
    const changes = yield* makeSemanticAgentChanges(
      {
        attach: () => Effect.succeed({observation: observed}),
        use: (_observation, _milliseconds, run) =>
          run(session).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                if (invalidateAfterUse) stale = true;
              }),
            ),
          ),
        observe: () => Effect.succeed(stale ? undefined : observed),
      },
      {directory, profileHome: f.home, worktree, runtimeIdentity: sha256HexSync('runtime')},
    );
    const request = {
      version: 1 as const,
      worktree,
      profile: sha256HexSync(JSON.stringify(f.profile)),
      principal: EffectString.slice(0, -5)(semanticHostProfileName(f.config, worktree)),
      action: 'prepare' as const,
      project: worktree,
      uri,
      language: 'typescript' as const,
      operation: 'rename' as const,
      position: {line: 0, character: 14},
      newName: 'renamed',
      milliseconds: 10000,
      maxBytes: 1024,
    };
    for (let attempt = 0; attempt < 33; attempt++)
      expect(yield* changes.execute(request, observed)).toMatchObject({status: 'budget-exceeded', applicable: false});
    const blobs = () =>
      f.fs
        .readDirectory(path.join(directory, 'proposals'))
        .pipe(Effect.map(names => EffectArray.filter(names, name => /^[a-f0-9]{64}\.json$/u.test(name))));
    expect(yield* blobs()).toEqual([]);
    invalidateAfterUse = true;
    expect(yield* changes.execute({...request, maxBytes: 8192}, observed)).toMatchObject({
      status: 'stale',
      applicable: false,
    });
    expect(yield* blobs()).toEqual([]);
    stale = false;
    invalidateAfterUse = false;
    const prepared = yield* changes.execute({...request, maxBytes: 8192}, observed);
    expect(prepared).toMatchObject({status: 'ok', applicable: false, writerAuthorityRequired: true});
    const {handle} = yield* Schema.decodeUnknownEffect(
      Schema.Struct({handle: Schema.Struct({id: Schema.String, capability: Schema.String, digest: Schema.String})}),
    )(prepared);
    const otherConfig = {...f.config, user: 'other-user'};
    const otherFile = path.join(f.home, 'semantic', 'profiles', semanticHostProfileName(otherConfig, worktree));
    yield* f.fs.writeFileString(otherFile, JSON.stringify(f.profile), {mode: 0o600});
    yield* trustProtocolProfile(otherConfig, worktree);
    const changeContext = yield* Effect.context<Effect.Services<ReturnType<typeof changes.execute>>>();
    const endpointHost: SemanticAgentQueryHost = {
      runtimeIdentity: Effect.succeed(sha256HexSync('runtime')),
      connect: () =>
        Effect.succeed({
          request: body =>
            body.operation === 'agent-change'
              ? changes.execute(body.request, observed).pipe(
                  Effect.provideContext(changeContext),
                  Effect.flatMap(Schema.decodeUnknownEffect(Schema.Json)),
                  Effect.mapError(() => LspFault.make({code: 'protocol'})),
                )
              : Effect.die('Unexpected operation'),
        }),
    };
    const foreign = yield* runSemanticAgentChangeWith(endpointHost, otherConfig, {
      version: 1,
      callerCwd: f.request.callerCwd,
      action: 'status',
      handle,
    });
    expect(foreign).toMatchObject({status: 'stale', applicable: false, writerAuthorityRequired: true});
    expect(foreign).not.toHaveProperty('page');
    const action = {
      version: 1,
      callerCwd: f.request.callerCwd,
      action: 'prepare',
      operation: 'code-action',
      file: 'a.ts',
      language: 'typescript',
      range: {start: {line: 0, character: 0}, end: {line: 0, character: 0}},
    };
    const listed = yield* runSemanticAgentChangeWith(endpointHost, f.config, action);
    const {choices} = yield* Schema.decodeUnknownEffect(
      Schema.Struct({choices: Schema.Array(Schema.Struct({choiceHandle: Schema.String}))}),
    )(listed);
    expect(actionCalls).toBe(1);
    const selected = {...action, choiceHandle: choices[0].choiceHandle};
    expect(yield* runSemanticAgentChangeWith(endpointHost, otherConfig, selected)).toMatchObject({status: 'stale'});
    expect(actionCalls).toBe(1);
    expect(yield* runSemanticAgentChangeWith(endpointHost, f.config, selected)).toMatchObject({
      status: 'unsupported',
      reason: 'command',
    });
    expect(actionCalls).toBe(2);
    expect(yield* blobs()).toHaveLength(1);
    expect(yield* f.fs.readFileString(path.join(f.request.callerCwd, 'a.ts'))).toBe(text);
  }).pipe(
    // oxlint-disable-next-line effecttsgo/strict-effect-provide -- Narrow publication filesystem and coordinator seam.
    Effect.provide(io),
  ),
);

it.effect('retains every ordered raw resource effect, refuses the whole preflight and rejects escaped targets', () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const uri = f.worktree + '/a.ts';
    const text = yield* f.fs.readFileString(f.path.join(f.request.callerCwd, 'a.ts'));
    const observed: Observation = {
      version: 1,
      repository: 'repo',
      worktree: f.worktree,
      project: f.worktree,
      uri,
      configuration: sha256HexSync('config'),
      toolchain: sha256HexSync('tools'),
      provider: {id: 'typescript-language-server', version: '6.0.2', generation: 1},
      view: {kind: 'disk', id: 'disk', owner: 'test', epoch: 0},
      content: sha256HexSync(text),
      documentVersion: null,
      projectEpoch: 0,
    };
    const evidence = {
      basis: 'semantic' as const,
      observation: observed,
      scope: 'project',
      completeness: 'partial' as const,
      limitations: [],
    };
    const edit = {
      range: {start: {line: 0, character: 0}, end: {line: 0, character: 0}},
      newText: '// preview\n',
      annotationId: 'review',
    };
    let operations: Schema.Json[] = [
      {kind: 'text', uri, version: 1, edits: [edit], target: null},
      {kind: 'create', uri: f.worktree + '/new.ts', options: {ignoreIfExists: true}, annotationId: 'review'},
      {kind: 'text', uri: f.worktree + '/new.ts', version: null, edits: [edit], target: null},
      {kind: 'rename', oldUri: f.worktree + '/new.ts', newUri: f.worktree + '/renamed.ts', options: {overwrite: false}},
      {kind: 'delete', uri, options: {ignoreIfNotExists: false}},
      {kind: 'text', uri, version: 2, edits: [edit], target: null},
    ];
    const annotation = {review: {label: 'Review complete unsupported effect', needsConfirmation: true}};
    const choice = {
      kind: 'action-choice',
      title: 'Move resource',
      actionKind: 'refactor',
      disabled: null,
      command: false,
      qualified: false,
      selector: sha256HexSync('raw'),
      queryDigest: sha256HexSync('query'),
      blocker: 'unsupported-operation-sequence',
    };
    const session: SemanticSession = {
      actions: (_observation, _query, _milliseconds, selected) =>
        Effect.succeed({
          version: 1,
          status: 'ok',
          evidence,
          items: selected
            ? [
                {
                  kind: 'prepared-edit',
                  operation: 'code-action',
                  sourceBasis: 'unqualified-operation-sequence-v1',
                  qualification: 'unsupported-operation-sequence',
                  files: [],
                  operations,
                  changeAnnotations: annotation,
                },
              ]
            : [choice],
        }),
      prepare: () => Effect.die('Unexpected rename'),
      upsert: () => Effect.die('Unexpected upsert'),
      query: () => Effect.die('Unexpected query'),
      diagnostics: () => Effect.die('Unexpected diagnostics'),
      project: () => Effect.succeed({configuration: observed.configuration}),
      observation: () => Effect.succeed(observed),
      available: Effect.succeed(true),
      invalidate: Effect.void,
      close: Effect.succeed({
        code: 0,
        drained: true,
        forced: false,
        stdioClosed: true,
        fault: undefined,
        graceful: true,
      }),
    };
    const changes = yield* makeSemanticAgentChanges(
      {
        attach: () => Effect.succeed({observation: observed}),
        use: (_observation, _milliseconds, run) => run(session),
        observe: () => Effect.succeed(observed),
      },
      {
        directory: f.path.join(f.home, 'previews'),
        profileHome: f.home,
        worktree: f.worktree,
        runtimeIdentity: sha256HexSync('runtime'),
      },
    );
    const request = {
      version: 1 as const,
      action: 'prepare' as const,
      worktree: f.worktree,
      project: f.worktree,
      uri,
      profile: sha256HexSync(JSON.stringify(f.profile)),
      principal: EffectString.slice(0, -5)(semanticHostProfileName(f.config, f.worktree)),
      operation: 'code-action' as const,
      language: 'typescript' as const,
      position: {line: 0, character: 0},
      range: {start: {line: 0, character: 0}, end: {line: 0, character: 0}},
      milliseconds: 10000,
      maxBytes: 8192,
    };
    const listing = yield* changes.execute(request, observed);
    const {choices} = yield* Schema.decodeUnknownEffect(
      Schema.Struct({choices: Schema.Array(Schema.Struct({choiceHandle: Schema.String}))}),
    )(listing);
    expect(JSON.stringify(listing)).not.toContain('preview\\n');
    const selected = {...request, choiceHandle: choices[0].choiceHandle};
    const prepared = yield* changes.execute(selected, observed);
    expect(prepared).toMatchObject({
      status: 'unsupported',
      qualification: 'unsupported-operation-sequence',
      targetCount: 0,
      operationCount: 6,
      applicable: false,
      writerAuthorityRequired: true,
    });
    const {handle, page} = yield* Schema.decodeUnknownEffect(
      Schema.Struct({
        handle: Schema.Struct({id: Schema.String, capability: Schema.String, digest: Schema.String}),
        page: Schema.Struct({
          chunks: Schema.Array(Schema.Struct({kind: Schema.String, text: Schema.String})),
          next: Schema.NullOr(Schema.Finite),
        }),
      }),
    )(prepared);
    const chunks = [...page.chunks];
    let next = page.next;
    while (next !== null) {
      const result = yield* changes.execute({...request, action: 'status', handle, offset: next});
      const {page} = yield* Schema.decodeUnknownEffect(
        Schema.Struct({
          page: Schema.Struct({
            chunks: Schema.Array(Schema.Struct({kind: Schema.String, text: Schema.String})),
            next: Schema.NullOr(Schema.Finite),
          }),
        }),
      )(result);
      chunks.push(...page.chunks);
      next = page.next;
    }
    const manifest = JSON.parse(
      EffectArray.join(
        EffectArray.map(chunks, chunk => chunk.text),
        '',
      ),
    );
    expect(manifest.operations).toEqual(operations);
    expect(manifest.changeAnnotations).toEqual(annotation);
    expect(EffectArray.every(chunks, chunk => chunk.kind === 'manifest')).toBe(true);
    expect(yield* changes.execute({...request, action: 'preflight', handle})).toMatchObject({
      status: 'unsupported',
      applicable: false,
      writerAuthorityRequired: true,
      conflicts: [{uri, reason: 'unsupported-operation-sequence'}],
    });
    expect(yield* f.fs.readFileString(f.path.join(f.request.callerCwd, 'a.ts'))).toBe(text);
    expect(yield* f.fs.exists(f.path.join(f.request.callerCwd, 'new.ts'))).toBe(false);
    operations = [{kind: 'delete', uri: 'file:///outside.ts'}];
    expect(yield* changes.execute(selected, observed)).toMatchObject({status: 'conflict', applicable: false});
  }).pipe(
    // oxlint-disable-next-line effecttsgo/strict-effect-provide -- Narrow private-profile, proposal and coordinator test.
    Effect.provide(io),
  ),
);
