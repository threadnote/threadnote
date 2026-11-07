import * as EffectArray from 'effect/Array';
import * as EffectString from 'effect/String';
import {Effect, FileSystem, Path, Schema} from 'effect';
import {createScanner, ScanError, SyntaxKind} from 'jsonc-parser';
import {CommandExecutor} from '@threadnote/platform/command';
import {LspFault, type LspClient} from '../lsp_transport.js';
import {boundedFileDigest} from '../fingerprint.js';
import {makeLspSession, type LspSessionOptions} from '../provider.js';
export const goProviderVersion = 'v0.24.0';
export const goExecutableDigest = '701228f3770992e76ba343b3855b0c164064a4225c699f1e5b765b274c7836af';
export const goToolDigest = 'aa355b078a81158d418079a3f8c776719eb99cc6f527e39ffa3250c66566aafb';
const fail = () => LspFault.make({code: 'prerequisite'});
/** Go emits a sequence of JSON objects, including nested replacement metadata. */
export function parseGoModuleStream(text: string): readonly unknown[] {
  if (text.length > 4 * 1024 * 1024) throw fail();
  const scanner = createScanner(text, false);
  const modules: unknown[] = [];
  let start = -1;
  let depth = 0;
  for (let token = scanner.scan(); token !== SyntaxKind.EOF; token = scanner.scan()) {
    if (scanner.getTokenError() !== ScanError.None) throw fail();
    if (token === SyntaxKind.Trivia || token === SyntaxKind.LineBreakTrivia) {
      if (!/^[\t\r\n ]+$/u.test(EffectString.slice(scanner.getTokenOffset(), scanner.getPosition())(text)))
        throw fail();
      continue;
    }
    if (token === SyntaxKind.LineCommentTrivia || token === SyntaxKind.BlockCommentTrivia) throw fail();
    if (start < 0) {
      if (token !== SyntaxKind.OpenBraceToken || modules.length >= 128) throw fail();
      start = scanner.getTokenOffset();
    }
    if (token === SyntaxKind.OpenBraceToken) depth++;
    else if (token === SyntaxKind.CloseBraceToken) depth--;
    if (depth === 0) {
      modules.push(JSON.parse(EffectString.slice(start, scanner.getPosition())(text)) as unknown);
      start = -1;
    }
  }
  if (start >= 0 || !modules.length) throw fail();
  return modules;
}
const staticPath = (value: string) =>
  value.length > 0 && value.length <= 8192 && !/[\p{Cc}:\\$]/u.test(value) && !EffectString.startsWith('~')(value);
const Module = Schema.Struct({
  Use: Schema.optional(Schema.NullOr(Schema.Array(Schema.Struct({DiskPath: Schema.String})))),
  Replace: Schema.optional(
    Schema.NullOr(
      Schema.Array(Schema.Struct({New: Schema.Struct({Path: Schema.String, Version: Schema.optional(Schema.String)})})),
    ),
  ),
});
/** Complete child environment, including Go hooks that apply even when CGO is disabled. */
export const goEnvironment = (sdk: string, directory: string, workspace: string): Record<string, string> => ({
  PATH: sdk + '/bin:/usr/bin:/bin',
  HOME: directory + '/home',
  GOROOT: sdk,
  GOENV: 'off',
  GOTOOLCHAIN: 'local',
  GOWORK: workspace,
  GOFLAGS: '-mod=readonly',
  GOPACKAGESDRIVER: 'off',
  GOCACHEPROG: '',
  GOPROXY: 'off',
  GOSUMDB: 'off',
  GOVCS: '*:off',
  CGO_ENABLED: '0',
  GOTELEMETRY: 'off',
  GOPATH: directory + '/gopath',
  GOMODCACHE: directory + '/modules',
  GOCACHE: directory + '/cache',
  XDG_CACHE_HOME: directory + '/cache',
  XDG_CONFIG_HOME: directory + '/config',
  TMPDIR: directory + '/tmp',
});
export const makeGoProject = Effect.fn('semantic.makeGoProject')(function* (options: {
  readonly project: string;
  readonly worktree: string;
  readonly sdk: string;
  readonly privateDirectory: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const command = yield* CommandExecutor;
  yield* fs.makeDirectory(options.privateDirectory, {recursive: true, mode: 0o700});
  if (
    (yield* fs.realPath(options.privateDirectory)) !== options.privateDirectory ||
    (yield* fs.stat(options.privateDirectory)).mode & 0o077
  )
    return yield* fail();
  const directory = yield* fs.makeTempDirectoryScoped({directory: options.privateDirectory, prefix: 'go-'});
  for (const child of ['home', 'gopath', 'modules', 'cache', 'config', 'tmp'])
    yield* fs.makeDirectory(path.join(directory, child), {mode: 0o700});
  const work = path.join(options.project, 'go.work');
  const workspace = (yield* fs.exists(work)) ? work : 'off';
  const environment = goEnvironment(options.sdk, directory, workspace);
  const files = new Map<string, string>();
  const pending = [workspace === 'off' ? path.join(options.project, 'go.mod') : work];
  while (pending.length) {
    const file = pending.pop()!;
    if (files.has(file)) continue;
    if (
      files.size >= 64 ||
      !EffectString.startsWith(options.worktree + path.sep)(file) ||
      EffectString.split(path.sep)(file).includes('.git') ||
      (yield* fs.realPath(file)) !== file
    )
      return yield* fail();
    const digest = yield* boundedFileDigest(file, 1024 * 1024);
    const result = yield* command.execute(
      path.join(options.sdk, 'bin/go'),
      [EffectString.endsWith('go.work')(file) ? 'work' : 'mod', 'edit', '-json', file],
      {
        cwd: options.project,
        env: {...environment, GOFLAGS: ''},
        maxOutputBytes: 1024 * 1024,
        timeoutMs: 10000,
      },
    );
    const value = yield* Effect.try({try: () => JSON.parse(result.stdout) as unknown, catch: fail}).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Module)),
    );
    files.set(file, digest);
    for (const target of [
      ...EffectArray.map(value.Use ?? [], use => use.DiskPath),
      ...EffectArray.map(
        EffectArray.filter(value.Replace ?? [], replace => !replace.New.Version),
        replace => replace.New.Path,
      ),
    ]) {
      if (!staticPath(target)) return yield* fail();
      const resolved = path.resolve(path.dirname(file), target);
      if (
        !(resolved === options.worktree || EffectString.startsWith(options.worktree + path.sep)(resolved)) ||
        (yield* fs.realPath(resolved)) !== resolved
      )
        return yield* fail();
      pending.push(path.join(resolved, 'go.mod'));
    }
  }
  const verify = Effect.gen(function* () {
    for (const [file, digest] of files)
      if ((yield* boundedFileDigest(file, 1024 * 1024)) !== digest) return yield* fail();
  });
  yield* verify;
  // The module graph must resolve offline before a provider slot is acquired; this never builds repository code.
  const listed = yield* command.execute(path.join(options.sdk, 'bin/go'), ['list', '-m', '-json', 'all'], {
    cwd: options.project,
    env: environment,
    maxOutputBytes: 4 * 1024 * 1024,
    timeoutMs: 10000,
  });
  const graph = yield* Schema.decodeUnknownEffect(
    Schema.Array(
      Schema.Struct({
        Path: Schema.String.check(Schema.isBetweenLength(1, 8192)),
        Version: Schema.optional(Schema.String.check(Schema.isMaxLength(1024))),
        Main: Schema.optional(Schema.Boolean),
        GoMod: Schema.optional(Schema.String),
        Replace: Schema.optional(Schema.Struct({GoMod: Schema.optional(Schema.String)})),
      }),
    ).check(Schema.isBetweenLength(1, 128)),
  )(
    yield* Effect.try({
      try: () => parseGoModuleStream(listed.stdout),
      catch: fail,
    }),
  );
  for (const module of graph) if (!files.has(module.GoMod ?? module.Replace?.GoMod ?? '')) return yield* fail();
  yield* verify;
  return {
    verify,
    ready: Effect.void,
    environment,
    roots: [options.sdk],
    settings: {gopls: {telemetryPrompt: false, env: environment}},
    initializationOptions: {telemetryPrompt: false, env: environment},
    profile: {
      kind: 'go-offline',
      version: '1.27.3',
      workspace,
      modules: [...files.keys()],
      moduleGraph: EffectArray.map(graph, module => ({
        path: module.Path,
        version: module.Version ?? null,
        main: module.Main ?? false,
        manifest: module.GoMod ?? module.Replace?.GoMod ?? null,
      })),
      repositoryExecution: false,
      dependencyAcquisition: false,
    },
  };
});
export const makeGoSession = Effect.fn('semantic.makeGoSession')(function* (
  client: LspClient,
  options: Omit<LspSessionOptions, 'policy'> & {
    readonly initializationOptions: Schema.Json;
  },
) {
  return yield* makeLspSession(client, {
    ...options,
    policy: {
      language: 'go',
      editSourceQualification: 'versioned-text-document-v1',
      resolveCodeActions: true,
      unopenedDocumentVersion: 0,
      workspaceName: 'semantic-go-project',
      initializationOptions: options.initializationOptions,
      acceptsServer: server => {
        if (server?.name !== 'gopls') return false;
        try {
          const info = JSON.parse(server.version);
          return info.Version === goProviderVersion && info.GoVersion === 'go1.27.3';
        } catch {
          return false;
        }
      },
      limitations: [
        'Experimental Go offline module/workspace profile',
        'Selected project and offline module graph only',
        'CGO, generation, commands, package drivers, cache programs and dependency acquisition disabled',
      ],
    },
  });
});
