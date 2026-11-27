import * as HostProfile from '../../src/semantic/host_profile.js';
import * as AgentQueries from '../../src/semantic/agent_queries.js';
import * as Coordinator from '../../src/semantic/coordinator.js';
import * as BunServices from '@effect/platform-bun/BunServices';
import {it as effectIt} from '@effect/vitest';
import {Array as EffectArray, Effect, FileSystem, Layer, Path, String as EffectString} from 'effect';
import {TestClock} from 'effect/testing';
import {describe, expect, it, vi} from 'vitest';
import {canonicalFileUri} from '@threadnote/semantic/contracts';
import {makeReadDeadline} from '@threadnote/platform/read_deadline';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {navigationSourceId, type NavigationInput, type NavigationScope} from '@threadnote/context/navigation/model';
import type {NavigationSemanticDependency, NavigationSemanticRequestV1} from '@threadnote/context/navigation/semantic';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {
  makeNavigationSemanticDependency,
  navigationAnchorPosition,
  navigationLineConvention,
  navigationSemanticLanguage,
  navigationSemanticReady,
  type NavigationSemanticHost,
  type NavigationSemanticServices,
} from '../../src/context_brief/navigation_semantic_adapter.js';
import {makeSemanticAgentDiskQueries} from '../../src/semantic/agent_query_store.js';
import {semanticAgentQueryKey, type SemanticAgentQueryResult} from '../../src/semantic/agent_query_protocol.js';
import {SemanticProviderNotRunning} from '../../src/semantic/source_evidence.js';
import {LspFault} from '../../src/semantic/lsp_transport.js';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {TestCommandExecutorLayer, TestSystemInfoLayer} from '../helpers/system-layer.js';

const platformIo = Layer.merge(BunServices.layer, TestSystemInfoLayer);
const io = Layer.merge(platformIo, TestCommandExecutorLayer.pipe(Layer.provide(platformIo)));
const encode = (text: string) => new TextEncoder().encode(text);

describe('navigation semantic anchor positions', () => {
  it('places the position on the declared name in UTF-16 characters', () => {
    const text = "const mark = '\u{1F600}'; export function target() {}\n";
    const span = {line: 1, column: 1, endLine: 1, endColumn: text.length};
    // The emoji is two UTF-16 code units, as LSP counts characters.
    expect(navigationAnchorPosition(text, span, 'target')).toEqual({line: 0, character: 35});
    const method = 'export class Alpha {\n  run() { return 1; }\n}\n';
    expect(navigationAnchorPosition(method, {line: 2, column: 3, endLine: 2, endColumn: 22}, 'run')).toEqual({
      line: 1,
      character: 2,
    });
  });

  it('refuses an absent, partial or repeated name instead of a guess', () => {
    const line = (text: string) => ({line: 1, column: 1, endLine: 1, endColumn: text.length});
    const repeated = 'function run() { return this.run(); }';
    expect(navigationAnchorPosition(repeated, line(repeated), 'run')).toBeUndefined();
    expect(navigationAnchorPosition('function running() {}', line('function running() {}'), 'run')).toBeUndefined();
    expect(navigationAnchorPosition('function other() {}', line('function other() {}'), 'run')).toBeUndefined();
    expect(navigationAnchorPosition(repeated, {line: 9, column: 1, endLine: 9, endColumn: 2}, 'run')).toBeUndefined();
  });

  it('refuses a name in an annotation, string or comment of the declaration span', () => {
    const whole = (text: string) => {
      const lines = EffectString.split('\n')(text);
      return {line: 1, column: 1, endLine: lines.length, endColumn: (lines.at(-1)?.length ?? 0) + 1};
    };
    // A Java method span includes its annotations; the name also occurs in the mapping string.
    const java = '@GetMapping("/save")\npublic void save() {}';
    expect(navigationAnchorPosition(java, whole(java), 'save')).toBeUndefined();
    const annotation = '@Save\npublic void store() {}';
    expect(navigationAnchorPosition(annotation, whole(annotation), 'Save')).toBeUndefined();
    // A doc comment inside the span names the declaration again.
    const documented = '/** Calls run once. */\nfunction run() {}';
    expect(navigationAnchorPosition(documented, whole(documented), 'run')).toBeUndefined();
    const block = '/* helper */ function other() {}';
    expect(navigationAnchorPosition(block, whole(block), 'helper')).toBeUndefined();
    const quoted = "const label = 'target'; function other() {}";
    expect(navigationAnchorPosition(quoted, whole(quoted), 'target')).toBeUndefined();
    const python = '# load\ndef save(): pass';
    expect(navigationAnchorPosition(python, whole(python), 'load', '#')).toBeUndefined();
    expect(navigationAnchorPosition(python, whole(python), 'save', '#')).toEqual({line: 1, character: 4});
  });

  it('refuses line conventions where LSP and graph line numbers can differ', () => {
    expect(navigationLineConvention(encode('a\r\nb\n'))).toBe('supported');
    expect(navigationLineConvention(encode('a\rb'))).toBe('unsupported');
    expect(navigationLineConvention(encode('a\u2028b'))).toBe('unsupported');
    expect(navigationLineConvention(encode('a\u2029b'))).toBe('unsupported');
    expect(navigationLineConvention(new Uint8Array([0xff]))).toBe('invalid');
  });

  it('selects a language by the last path extension only', () => {
    expect(navigationSemanticLanguage('src/view.tsx')).toBe('typescriptreact');
    expect(navigationSemanticLanguage('pkg/main.go')).toBe('go');
    expect(navigationSemanticLanguage('app/Main.kt')).toBe('kotlin');
    expect(navigationSemanticLanguage('.bashrc')).toBeUndefined();
    expect(navigationSemanticLanguage('Makefile')).toBeUndefined();
  });
});

const source = 'package main\n\nfunc Save() {}\n\nfunc Load() { Save() }\n';

const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fs.makeTempDirectoryScoped({prefix: 'tn-navigation-semantic-'});
  const root = yield* fs.realPath(path.join(directory));
  const home = path.join(root, '.home');
  yield* fs.makeDirectory(home, {mode: 0o700});
  yield* fs.writeFileString(path.join(root, 'main.go'), source);
  const contentHash = sha256HexSync(encode(source));
  const worktree = canonicalFileUri((yield* path.toFileUrl(root)).href);
  const config: RuntimeConfig = {
    account: 'local',
    user: 'tester',
    agentId: 'navigation-test',
    agentContextHome: home,
    manifestPath: path.join(root, 'manifest.json'),
  };
  const scope: NavigationScope = {
    repository: 'graph-repository',
    worktree: 'graph-worktree',
    project: 'graph-project',
    view: {kind: 'disk', id: 'disk', owner: 'graph', epoch: 0},
  };
  const sourceId = navigationSourceId(scope, 'main.go', contentHash);
  const input: NavigationInput = {
    scope,
    target: {kind: 'anchors', candidateIds: ['save', 'load']},
    sources: [
      {...scope, id: sourceId, path: 'main.go', contentHash, freshness: 'verified-current', snapshot: 'snapshot'},
    ],
    candidates: [
      {
        id: 'save',
        sourceId,
        startLine: 3,
        endLine: 3,
        roles: ['implementation'],
        reason: 'Structural declaration',
        relevance: 1,
        basis: ['structural'],
        support: 'evidenced',
      },
      {
        id: 'load',
        sourceId,
        startLine: 5,
        endLine: 5,
        roles: ['entrypoint'],
        reason: 'Structural caller',
        relevance: 1,
        basis: ['structural'],
        support: 'evidenced',
      },
    ],
    links: [
      {
        from: 'load',
        to: 'save',
        relation: 'calls',
        basis: 'structural',
        compatibility: 'unknown',
        reason: 'Structural call',
      },
    ],
    coverage: {status: 'complete', description: 'Structural fixture'},
    gaps: ['structural-fixture-gap'],
  };
  const commit = EffectString.repeat(40)('a');
  const request: NavigationSemanticRequestV1 = {
    callerCwd: root,
    scope,
    identity: {
      caseMode: 'sensitive',
      checkoutId: 'checkout',
      displayName: 'fixture',
      gitCommonDirectory: path.join(root, '.git'),
      headCommit: commit,
      objectFormat: 'sha1',
      repoRoot: root,
      repositoryId: 'graph-repository',
      worktreeId: 'graph-worktree-id',
    },
    observation: {
      repository: {displayName: 'fixture', repositoryId: 'graph-repository'},
      snapshot: {commit, dirty: false, id: 'snapshot', worktreeId: 'graph-worktree-id'},
      freshness: 'current',
    },
    input,
    anchors: [
      {
        candidateId: 'save',
        path: 'main.go',
        contentHash,
        name: 'Save',
        span: {line: 3, column: 1, endLine: 3, endColumn: 15},
      },
      {
        candidateId: 'load',
        path: 'main.go',
        contentHash,
        name: 'Load',
        span: {line: 5, column: 1, endLine: 5, endColumn: 23},
      },
    ],
    deadline: yield* makeReadDeadline(20_000),
  };
  const profile = {
    version: 1 as const,
    enabled: true,
    worktree,
    catalog: {
      go: {
        executable: '/host/gopls',
        executableDigest: sha256HexSync('gopls'),
        sdkDirectory: '/host/go',
        sdkTreeDigest: sha256HexSync('go'),
      },
    },
  };
  return {config, request, input, profile, home, worktree};
});

/** Keep the host profile boundary narrow: the fixture returns the selected profile or the given fault. */
const withProfile = (selected: ReturnType<typeof HostProfile.readSemanticHostProfile>) =>
  Effect.acquireRelease(
    Effect.sync(() => vi.spyOn(HostProfile, 'readSemanticHostProfile').mockImplementation(() => selected)),
    spy => Effect.sync(() => spy.mockRestore()),
  );

const host = (attach: NavigationSemanticHost['attach']): NavigationSemanticHost => ({
  runtimeIdentity: Effect.succeed(sha256HexSync('runtime')),
  attach,
});

describe('navigation semantic adapter', () => {
  effectIt.effect('answers not-running from one probe and starts nothing when no coordinator runs', () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* withProfile(Effect.succeed({home: f.home, profile: f.profile, digest: sha256HexSync('profile')}));
      const results: SemanticAgentQueryResult[] = [];
      const original = AgentQueries.runSemanticAgentQueryWith;
      yield* Effect.acquireRelease(
        Effect.sync(() =>
          vi
            .spyOn(AgentQueries, 'runSemanticAgentQueryWith')
            .mockImplementation((services, config, input) =>
              original(services, config, input).pipe(Effect.tap(result => Effect.sync(() => results.push(result)))),
            ),
        ),
        spy => Effect.sync(() => spy.mockRestore()),
      );
      let attaches = 0;
      const dependency: NavigationSemanticDependency<NavigationSemanticServices> = makeNavigationSemanticDependency(
        f.config,
        host(() =>
          Effect.sync(() => {
            attaches++;
            return undefined;
          }),
        ),
      );
      const enriched = yield* dependency(f.request);
      expect(attaches).toBe(1);
      // Two anchors and two operations, but only the first query reaches the host after the not-running answer.
      expect(results).toEqual([
        {version: 1, status: 'unavailable', reason: 'semantic-provider-not-running', evidence: null},
      ]);
      expect(enriched.candidates).toEqual(f.input.candidates);
      expect(enriched.sources).toEqual(f.input.sources);
      expect(enriched.links).toEqual(f.input.links);
      expect(enriched.gaps).toEqual(
        expect.arrayContaining(['structural-fixture-gap', 'semantic-provider-not-running']),
      );
    }).pipe(Effect.scoped, provideTestLayer(io), TestClock.withLive),
  );

  effectIt.effect('keeps the structural input with a gap when a port dies or no profile authorizes it', () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* withProfile(Effect.succeed({home: f.home, profile: f.profile, digest: sha256HexSync('profile')}));
      // An attachment that fails or dies is the outcome for the whole answer: there is no second probe.
      for (const outcome of [Effect.die('fixture attach defect'), Effect.fail(LspFault.make({code: 'prerequisite'}))]) {
        let attaches = 0;
        const dependency = makeNavigationSemanticDependency(
          f.config,
          host(() => Effect.suspend(() => (attaches++, outcome))),
        );
        const failed = yield* dependency(f.request);
        expect(attaches).toBe(1);
        expect(failed.candidates).toEqual(f.input.candidates);
        expect(failed.links).toEqual(f.input.links);
        expect(failed.gaps).toEqual(expect.arrayContaining(['structural-fixture-gap', 'semantic-unavailable']));
        expect(failed.gaps).not.toContain('semantic-provider-not-running');
      }
    }).pipe(Effect.scoped, provideTestLayer(io), TestClock.withLive),
  );

  effectIt.effect('keeps the other anchor when one anchor source cannot be read', () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* withProfile(Effect.succeed({home: f.home, profile: f.profile, digest: sha256HexSync('profile')}));
      let attaches = 0;
      const dependency = makeNavigationSemanticDependency(
        f.config,
        host(() =>
          Effect.sync(() => {
            attaches++;
            return undefined;
          }),
        ),
      );
      // A path outside the repository is an invalid source request, not an absent file.
      const [save, load] = f.request.anchors;
      const enriched = yield* dependency({...f.request, anchors: [{...save, path: '../escape.go'}, load]});
      expect(attaches).toBe(1);
      expect(enriched.gaps).toEqual(
        expect.arrayContaining([
          'structural-fixture-gap',
          'semantic-anchor-position-unresolved',
          'semantic-provider-not-running',
        ]),
      );
    }).pipe(Effect.scoped, provideTestLayer(io), TestClock.withLive),
  );

  effectIt.effect('needs the worktree host profile and never attaches without it', () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* withProfile(Effect.fail(HostProfile.SemanticHostProfileFault.make({reason: 'missing'})));
      let attaches = 0;
      const dependency = makeNavigationSemanticDependency(
        f.config,
        host(() =>
          Effect.sync(() => {
            attaches++;
            return undefined;
          }),
        ),
      );
      const enriched = yield* dependency(f.request);
      expect(attaches).toBe(0);
      expect(enriched.candidates).toEqual(f.input.candidates);
      expect(enriched.gaps).toEqual(['structural-fixture-gap', 'semantic-unavailable']);
    }).pipe(Effect.scoped, provideTestLayer(io), TestClock.withLive),
  );
});

describe('navigation semantic readiness probe', () => {
  /** A bootstrap next to a plain file named rpc.sock: a probe that connected to it could not answer ready. */
  const bootstrap = (f: Effect.Success<typeof fixture>) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = path.join(f.home, 'semantic', EffectString.repeat(20)('a'));
      yield* fs.makeDirectory(directory, {recursive: true, mode: 0o700});
      yield* fs.writeFileString(
        path.join(directory, 'host.json'),
        JSON.stringify({
          version: 1,
          runtimeIdentity: sha256HexSync('runtime'),
          token: sha256HexSync('token'),
          worktree: f.worktree,
          dataHome: f.home,
          ...f.profile.catalog,
        }),
        {mode: 0o600},
      );
      yield* fs.writeFileString(path.join(directory, 'rpc.sock'), '');
    });
  const neverConnects = Effect.acquireRelease(
    Effect.sync(() => [
      vi.spyOn(Coordinator, 'attachSemanticEndpoint'),
      vi.spyOn(Coordinator, 'inspectSemanticEndpoint'),
      vi.spyOn(AgentQueries, 'runSemanticAgentQueryWith'),
    ]),
    spies => Effect.sync(() => EffectArray.forEach(spies, spy => spy.mockRestore())),
  );

  effectIt.effect('is ready only with a profile slot for an anchor language and an endpoint bootstrap', () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const spies = yield* neverConnects;
      const ready = (paths: readonly string[]) => navigationSemanticReady(f.config, f.request.identity.repoRoot, paths);
      yield* withProfile(Effect.fail(HostProfile.SemanticHostProfileFault.make({reason: 'missing'})));
      expect(yield* ready(['main.go'])).toBe(false);
      yield* withProfile(Effect.succeed({home: f.home, profile: f.profile, digest: sha256HexSync('profile')}));
      expect(yield* ready(['main.go'])).toBe(false);
      yield* bootstrap(f);
      expect(yield* ready(['main.go'])).toBe(true);
      expect(yield* ready(['store.py', 'main.go'])).toBe(true);
      for (const paths of [[], ['store.py'], ['Main.kt'], ['notes.txt']]) expect(yield* ready(paths)).toBe(false);
      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    }).pipe(Effect.scoped, provideTestLayer(io), TestClock.withLive),
  );
});

describe('attach-only saved-disk queries', () => {
  effectIt.effect('answer not-running without a session and never ask the coordinator to create one', () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const path = yield* Path.Path;
      const existingOnly: boolean[] = [];
      const coordinator: Parameters<typeof makeSemanticAgentDiskQueries>[0] = {
        observe: () => Effect.die('Attach-only queries do not observe'),
        use: () => Effect.die('Attach-only queries without a session do not use one'),
        attach: (_observation, _text, _language, _environment, _control, only = false) => {
          existingOnly.push(only);
          return only
            ? Effect.fail(SemanticProviderNotRunning.make({}))
            : Effect.die('An attach-only query must not start a session');
        },
      };
      const runtime = sha256HexSync('runtime');
      const disk = yield* makeSemanticAgentDiskQueries(coordinator, f.worktree, runtime);
      const scope = {
        worktree: f.worktree,
        project: f.worktree,
        uri: canonicalFileUri((yield* path.toFileUrl(path.join(f.request.identity.repoRoot, 'main.go'))).href),
        language: 'go' as const,
        operation: 'references' as const,
        position: {line: 2, character: 5},
      };
      const profile = sha256HexSync('profile');
      const result = yield* disk.query({
        ...scope,
        profile,
        query: semanticAgentQueryKey(runtime, profile, scope),
        maxItems: 20,
        maxBytes: 8192,
        milliseconds: 1000,
        attachOnly: true,
      });
      expect(result).toEqual({
        version: 1,
        status: 'unavailable',
        reason: 'semantic-provider-not-running',
        evidence: null,
      });
      expect(existingOnly).toEqual([true]);
    }).pipe(Effect.scoped, provideTestLayer(io)),
  );
});
