import {ChildEnvironmentPolicy} from '@threadnote/platform/child-environment-policy';
import {CommandExecutor} from '@threadnote/platform/command';
import {cryptoLayer} from '@threadnote/platform/crypto';
import {LspFault} from '../../src/semantic/lsp_transport.js';
import {it} from '@effect/vitest';
import {Array as EffectArray, Effect, FileSystem, Layer, Path} from 'effect';
import * as BunFileSystem from '@effect/platform-bun/BunFileSystem';
import * as BunPath from '@effect/platform-bun/BunPath';
import {expect} from 'vitest';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {canonicalFileUri, type Observation, type QueryOutcome} from '@threadnote/semantic/contracts';
import type {SemanticSession} from '../../src/semantic/provider.js';
import {makeSemanticAgentChanges, runSemanticAgentChangeWith} from '../../src/semantic/agent_changes.js';
import {semanticHostProfileName} from '../../src/semantic/host_profile.js';
import type {SemanticAgentQueryHost} from '../../src/semantic/agent_queries.js';
import {TestSystemInfoLayer} from '../helpers/system-layer.js';
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
  return {fs, config, request, profile, profileFile};
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
      status: 'unsupported',
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
    const session: SemanticSession = {
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
      {directory, worktree, runtimeIdentity: sha256HexSync('runtime')},
    );
    const request = {
      version: 1 as const,
      worktree,
      profile: sha256HexSync('profile'),
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
    expect(yield* changes.execute({...request, maxBytes: 8192}, observed)).toMatchObject({
      status: 'ok',
      applicable: false,
      writerAuthorityRequired: true,
    });
    expect(yield* blobs()).toHaveLength(1);
    expect(yield* f.fs.readFileString(path.join(f.request.callerCwd, 'a.ts'))).toBe(text);
  }).pipe(
    // oxlint-disable-next-line effecttsgo/strict-effect-provide -- Narrow publication filesystem and coordinator seam.
    Effect.provide(io),
  ),
);
