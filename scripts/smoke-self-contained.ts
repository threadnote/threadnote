import {Array as EffectArray} from 'effect';
import {ScriptCommandExecutorLayer} from './effect/system-layer.js';
import {ScriptSystemInfoLayer} from './effect/system-layer.js';
import {provideScriptLayer, scriptError, ScriptError} from './effect/errors.js';
import * as BunRuntime from '@effect/platform-bun/BunRuntime';
import * as BunServices from '@effect/platform-bun/BunServices';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {getDefaultEnvironment} from '@modelcontextprotocol/sdk/client/stdio.js';
import {commandEnvironment} from '@threadnote/platform/command';
import {ChildEnvironmentPolicy} from '@threadnote/platform/child-environment-policy';
import {FixtureProcesses, FixtureStdioTransport, runFixtureCommand} from './fixture-owned-process.js';
import {fixtureCleanup, fixtureLifecycle, fixtureRemovalDeadline} from './fixture-lifecycle.js';
import {
  createRecallEmbeddingWorkerFixtureDrain,
  drainRecallEmbeddingWorkerFixture,
} from '@threadnote/threadnote/recall/embedding_worker_process';
import {fixturePipelineReceiptProvesExit} from '@threadnote/testing/fixture-pipeline-receipt';
import {sha256Hex} from '@threadnote/platform/digest';
import {runtimeReadBoundedStableRegularFile} from '@threadnote/platform/system';
import {SecureRandom} from 'effect/crypto';
import {Clock, Console, Effect, FileSystem, Layer, Option, Path} from 'effect';
import {SystemInfo} from '@threadnote/platform/system';
import {recallIndexDatabaseFilename} from '@threadnote/recall/index';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

const ROOT_URL = new URL('..', import.meta.url);
const COMMAND_TIMEOUT_MILLISECONDS = 300_000;
const TOTAL_TIMEOUT_MILLISECONDS = 600_000;
const CLEANUP_RESERVE_MILLISECONDS = 30_000;
const SMOKE_MARKER = 'QZ9-standalone-bun-smoke';
const LARGE_OUTPUT_START = 'QZ9-standalone-large-output-start';
const LARGE_OUTPUT_END = 'QZ9-standalone-large-output-end';

const smokeSelfContained = Effect.scoped(
  Effect.gen(function* () {
    const deadline = (yield* Clock.currentTimeMillis) + TOTAL_TIMEOUT_MILLISECONDS;
    const monotonicDeadline = performance.now() + TOTAL_TIMEOUT_MILLISECONDS;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* path.fromFileUrl(ROOT_URL);
    const executable = path.join(root, 'dist', process.platform === 'win32' ? 'threadnote.exe' : 'threadnote');
    const packageManifest: unknown = JSON.parse(yield* fs.readFileString(path.join(root, 'package.json')));
    if (
      typeof packageManifest !== 'object' ||
      packageManifest === null ||
      !('version' in packageManifest) ||
      typeof packageManifest.version !== 'string' ||
      packageManifest.version.length === 0
    ) {
      return yield* ScriptError.make({message: 'package.json does not declare a release version.'});
    }
    if (!(yield* fs.exists(executable))) {
      return yield* ScriptError.make({message: 'Standalone executable is missing; run bun run build first.'});
    }

    const bodyDeadline = monotonicDeadline - CLEANUP_RESERVE_MILLISECONDS;
    const temporaryRoot = yield* fs.makeTempDirectory({prefix: 'threadnote-standalone-smoke-'});
    const threadnoteHome = path.join(temporaryRoot, 'home');
    const userHome = path.join(temporaryRoot, 'user-home');
    const invocationDirectory = path.join(temporaryRoot, 'repo');
    for (const directory of [threadnoteHome, userHome, invocationDirectory]) {
      yield* fs.makeDirectory(directory, {recursive: true});
    }
    // This measures the CI-built file, rather than attesting its provenance or signing identity.
    const candidate = yield* fs.realPath(executable);
    if ((yield* fs.stat(candidate)).type !== 'File')
      return yield* ScriptError.make({message: 'Standalone candidate is not a file.'});
    const fingerprint = yield* sha256Hex(yield* fs.readFile(candidate));
    const capability = yield* createRecallEmbeddingWorkerFixtureDrain(threadnoteHome, temporaryRoot, {
      executablePath: candidate,
      version: packageManifest.version,
    });
    const processes = new FixtureProcesses(undefined, deadline, monotonicDeadline);
    const body = Effect.gen(function* () {
      if (
        (yield* fs.realPath(executable)) !== candidate ||
        (yield* sha256Hex(yield* fs.readFile(candidate))) !== fingerprint
      )
        return yield* ScriptError.make({message: 'Standalone candidate changed before launch.'});
      const gitExecutable = Option.fromNullishOr(Bun.which('git'));
      if (Option.isNone(gitExecutable)) {
        return yield* ScriptError.make({message: 'Standalone graph smoke requires Git on the build host.'});
      }
      const policy = yield* ChildEnvironmentPolicy;
      const system = yield* SystemInfo;
      const gitEnvironment = commandEnvironment(gitExecutable.value, undefined, system.environment(), policy) ?? {};
      yield* writePolyglotRepository(
        fs,
        path,
        invocationDirectory,
        gitExecutable.value,
        processes,
        bodyDeadline,
        gitEnvironment,
      );

      const environment: NodeJS.ProcessEnv = {
        HOME: userHome,
        LOCALAPPDATA: path.join(userHome, 'AppData', 'Local'),
        PATH: path.dirname(gitExecutable.value),
        THREADNOTE_BIN_DIR: path.join(temporaryRoot, 'bin'),
        THREADNOTE_CALLER_CWD: invocationDirectory,
        THREADNOTE_HOME: threadnoteHome,
        THREADNOTE_USER: 'standalone-smoke',
        USER: 'standalone-smoke',
        USERPROFILE: userHome,
      };
      const run = (arguments_: readonly string[]) =>
        Effect.tryPromise({
          try: () =>
            runFixtureCommand(processes, candidate, arguments_, {
              cwd: invocationDirectory,
              env: environment,
              maxOutputBytes: 512 * 1024,
              deadline: Math.min(bodyDeadline, performance.now() + COMMAND_TIMEOUT_MILLISECONDS),
            }),
          catch: cause => scriptError(cause, 'Standalone command failed.'),
        }).pipe(Effect.map(result => `${result.stdout}\n${result.stderr}`));

      const version = yield* run(['--version']);
      if (!Effect2.pipe(version, EffectString.includes(`threadnote v${packageManifest.version}`))) {
        return yield* ScriptError.make({message: `Standalone release reported an unexpected version:\n${version}`});
      }

      yield* run(['install', '--dry-run', '--no-start']);

      const runtime = yield* run(['models', 'runtime']);
      if (!/node-llama-cpp:\s+prebuilt/i.test(runtime)) {
        return yield* ScriptError.make({
          message: `Native runtime was not loaded from the release payload:\n${runtime}`,
        });
      }

      yield* run([
        'remember',
        '--kind',
        'durable',
        '--project',
        'threadnote',
        '--topic',
        'standalone-bun-smoke',
        '--text',
        `${SMOKE_MARKER} stores and recalls without Node or an external Bun installation.`,
      ]);
      const recall = yield* run(['recall', '--query', `${SMOKE_MARKER} standalone recall`]);
      if (!Effect2.pipe(recall, EffectString.includes('standalone-bun-smoke.md'))) {
        return yield* ScriptError.make({message: `Standalone lexical recall missed the stored memory:\n${recall}`});
      }

      const storedMemoryPath = path.join(
        threadnoteHome,
        'data',
        'local',
        'user',
        'standalone-smoke',
        'memories',
        'durable',
        'projects',
        'threadnote',
        'standalone-bun-smoke.md',
      );
      const storedMemory = yield* fs.readFileString(storedMemoryPath);
      yield* fs.writeFileString(
        storedMemoryPath,
        `${Effect2.pipe(storedMemory, EffectString.trimEnd)}\n\n${LARGE_OUTPUT_START}\n${Effect2.pipe('x', EffectString.repeat(96 * 1024))}\n${LARGE_OUTPUT_END}\n`,
      );
      const largeRead = yield* readLargeOutputThroughPlatformPipe({
        consumer: path.join(root, 'apps', 'threadnote', 'test', 'fixtures', 'cli-output-consumer.ts'),
        relay: path.join(root, 'scripts', 'fixtures', 'owned-pipeline-relay.ts'),
        cwd: invocationDirectory,
        environment,
        executable: candidate,
        fs,
        path,
        temporaryRoot,
        uri: 'threadnote://user/standalone-smoke/memories/durable/projects/threadnote/standalone-bun-smoke.md',
        processes,
        bodyDeadline,
      });
      if (largeRead.bytes <= 65_536 || largeRead.hasStart !== true || largeRead.hasEnd !== true) {
        return yield* ScriptError.make({
          message:
            `Standalone large memory read was truncated before stdout drained: ${largeRead.bytes} bytes; ` +
            `start=${largeRead.hasStart}; end=${largeRead.hasEnd}.`,
        });
      }

      // The large-output fixture bypasses canonical writes and changes the indexed
      // body. Prepare its derived state explicitly before later indexed retrieval.
      yield* run(['repair', '--core-only', '--no-post-update']);
      const lexicalDatabase = path.join(threadnoteHome, 'indexes', 'lexical', recallIndexDatabaseFilename(false));
      const lexicalInfo = yield* fs.stat(lexicalDatabase);
      if (lexicalInfo.type !== 'File' || lexicalInfo.size <= 0) {
        return yield* ScriptError.make({message: 'Standalone recall did not create a populated Bun SQLite index.'});
      }

      const doctor = yield* run(['doctor', '--dry-run']);
      if (!/bun runtime:\s+v1\.4\.4;\s+embedded/i.test(doctor) || /Node runtime/i.test(doctor)) {
        return yield* ScriptError.make({message: `Doctor did not report the embedded Bun runtime:\n${doctor}`});
      }

      const indexed = yield* run(['graph', 'index']);
      if (!/14 symbols|symbols/i.test(indexed)) {
        return yield* ScriptError.make({message: `Standalone graph index did not complete:\n${indexed}`});
      }
      const graphOperations = yield* Effect.all(
        [
          run(['graph', 'query', '--query', 'Greeter', '--json']),
          run(['graph', 'explain', '--symbol', 'KotlinApp', '--json']),
          run(['graph', 'path', '--from', 'typescriptBoot', '--to', 'typescriptHelper', '--json']),
          run(['graph', 'impact', '--query', 'makeService', '--json']),
        ],
        {concurrency: 1},
      );
      for (const [index, expected] of ['java', 'KotlinApp', 'typescriptHelper', 'swiftBoot'].entries()) {
        if (!Effect2.pipe(graphOperations[index], EffectString.includes(expected))) {
          return yield* ScriptError.make({
            message: `Standalone graph operation ${index + 1} missed ${expected}:\n${graphOperations[index]}`,
          });
        }
      }

      yield* verifyMcp(candidate, invocationDirectory, environment, processes, bodyDeadline);
    });
    const remaining = Effect.gen(function* () {
      return Math.min(deadline - (yield* Clock.currentTimeMillis), monotonicDeadline - performance.now());
    });
    const cleanup = fixtureCleanup({
      producers: Effect.tryPromise({
        try: () => processes.closeAndObserve(monotonicDeadline),
        catch: cause => scriptError(cause),
      }),
      drain: drainRecallEmbeddingWorkerFixture(capability, deadline),
      remove: fs.remove(temporaryRoot, {recursive: true, force: true}),
      remaining,
    });
    const remainingBody = Math.max(0, processes.remaining(bodyDeadline));
    yield* fixtureLifecycle(
      body.pipe(
        Effect.timeoutOrElse({
          duration: remainingBody,
          orElse: () => Effect.fail(ScriptError.make({message: 'Standalone smoke body deadline expired.'})),
        }),
      ),
      cleanup,
    );
    yield* fixtureRemovalDeadline(remaining);
    yield* Console.log(
      'Self-contained Bun executable smoke passed with polyglot CLI/MCP graph operations and Node/Bun absent from PATH.',
    );
  }),
);

interface LargeOutputPipeOptions {
  readonly consumer: string;
  readonly relay: string;
  readonly cwd: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly executable: string;
  readonly fs: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly temporaryRoot: string;
  readonly uri: string;
  readonly processes: FixtureProcesses;
  readonly bodyDeadline: number;
}

const readLargeOutputThroughPlatformPipe = Effect.fn('smokeSelfContained.readLargeOutputThroughPlatformPipe')(
  function* (options: LargeOutputPipeOptions) {
    const windows = process.platform === 'win32';
    const inheritedEnvironment = (yield* SystemInfo).environment();
    const quote = (value: string): string =>
      windows
        ? `"${Effect2.pipe(value, EffectString.replaceAll('%', '%%'), EffectString.replaceAll('"', '""'))}"`
        : `'${Effect2.pipe(value, EffectString.replaceAll("'", `'\\''`))}'`;
    const producerToken = yield* (yield* SecureRandom.SecureRandom).uuidV4();
    const consumerToken = yield* (yield* SecureRandom.SecureRandom).uuidV4();
    const producerReceipt = options.path.join(options.temporaryRoot, 'producer-exit.json');
    const consumerReceipt = options.path.join(options.temporaryRoot, 'consumer-exit.json');
    const producerObservation = options.processes.registry.register();
    const consumerObservation = options.processes.registry.register();
    const producer = EffectArray.join(
      EffectArray.map(
        [process.execPath, options.relay, producerReceipt, producerToken, options.executable, 'read', options.uri],
        quote,
      ),
      ' ',
    );
    const consumer = EffectArray.join(
      EffectArray.map(
        [
          process.execPath,
          options.relay,
          consumerReceipt,
          consumerToken,
          process.execPath,
          options.consumer,
          'text',
          LARGE_OUTPUT_START,
          LARGE_OUTPUT_END,
        ],
        quote,
      ),
      ' ',
    );
    const scriptPath = options.path.join(options.temporaryRoot, windows ? 'large-output.cmd' : 'large-output.sh');
    yield* options.fs.writeFileString(
      scriptPath,
      windows ? `@echo off\r\n${producer} | ${consumer}\r\n` : `set -eu\n${producer} | ${consumer}\n`,
    );
    const shell = windows ? (inheritedEnvironment.ComSpec ?? inheritedEnvironment.COMSPEC ?? 'cmd.exe') : '/bin/sh';
    const shellArguments = windows ? ['/d', '/s', '/c', scriptPath] : [scriptPath];
    const result = yield* Effect.tryPromise({
      try: () =>
        runFixtureCommand(options.processes, shell, shellArguments, {
          cwd: options.cwd,
          env: options.environment,
          maxOutputBytes: 128 * 1024,
          deadline: Math.min(options.bodyDeadline, performance.now() + COMMAND_TIMEOUT_MILLISECONDS),
        }),
      catch: cause => scriptError(cause, 'Standalone pipeline failed.'),
    });
    for (const [receipt, token, observation] of [
      [producerReceipt, producerToken, producerObservation],
      [consumerReceipt, consumerToken, consumerObservation],
    ] as const) {
      const text = yield* Effect.tryPromise({
        try: async () => new TextDecoder().decode(await runtimeReadBoundedStableRegularFile(receipt, 8192)),
        catch: cause => scriptError(cause, 'Standalone pipeline exit receipt unavailable.'),
      });
      if (!fixturePipelineReceiptProvesExit(text, token))
        return yield* ScriptError.make({message: 'Standalone pipeline exit receipt invalid.'});
      const decoded: unknown = JSON.parse(text);
      if (typeof decoded !== 'object' || decoded === null || !('code' in decoded) || decoded.code !== 0)
        return yield* ScriptError.make({message: 'Standalone pipeline child failed.'});
      observation.spawned();
      observation.exited(0, null);
      observation.closed();
    }
    const parsed: unknown = yield* Effect.try({
      try: () => JSON.parse(result.stdout),
      catch: cause => ScriptError.make({message: 'Standalone large-output pipe returned invalid JSON.', cause}),
    });
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      !('bytes' in parsed) ||
      typeof parsed.bytes !== 'number' ||
      !('hasEnd' in parsed) ||
      typeof parsed.hasEnd !== 'boolean' ||
      !('hasStart' in parsed) ||
      typeof parsed.hasStart !== 'boolean'
    ) {
      return yield* ScriptError.make({message: 'Standalone large-output pipe returned invalid JSON.'});
    }
    return {bytes: parsed.bytes, hasEnd: parsed.hasEnd, hasStart: parsed.hasStart};
  },
);

const writePolyglotRepository = Effect.fn('smokeSelfContained.writePolyglotRepository')(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  root: string,
  gitExecutable: string,
  processes: FixtureProcesses,
  bodyDeadline: number,
  gitEnvironment: NodeJS.ProcessEnv,
) {
  const files: Readonly<Record<string, string>> = {
    'Package.swift': EffectArray.join(
      [
        'import PackageDescription',
        'let package = Package(name: "SwiftWorkspace", targets: [',
        '  .target(name: "SwiftCore"),',
        '  .target(name: "SwiftApp", dependencies: ["SwiftCore"])',
        '])',
        '',
      ],
      '\n',
    ),
    'Sources/SwiftApp/Main.swift': 'import SwiftCore\npublic func swiftBoot() -> String { makeService() }\n',
    'Sources/SwiftCore/Service.swift': 'public func makeService() -> String { "ready" }\n',
    'app/build.gradle.kts': 'dependencies { implementation(project(":shared")) }\n',
    'app/src/main/kotlin/com/acme/KotlinApp.kt':
      'package com.acme\nimport com.acme.Greeter\nclass KotlinApp { fun start() = Greeter() }\n',
    'settings.gradle.kts': 'include(":shared", ":app")\n',
    'shared/build.gradle.kts': '',
    'shared/src/main/java/com/acme/Greeter.java': 'package com.acme; public class Greeter { public Greeter() {} }\n',
    'src/helper.ts': 'export function typescriptHelper(): string { return "ready"; }\n',
    'src/main.ts':
      'import {typescriptHelper} from "./helper.js";\nexport function typescriptBoot() { return typescriptHelper(); }\n',
  };
  for (const [relative, content] of EffectRecord.toEntries(files)) {
    const target = path.join(root, ...Effect2.pipe(relative, EffectString.split('/')));
    yield* fs.makeDirectory(path.dirname(target), {recursive: true});
    yield* fs.writeFileString(target, content);
  }
  const git = (arguments_: readonly string[]) =>
    Effect.tryPromise({
      try: () =>
        runFixtureCommand(processes, gitExecutable, arguments_, {
          cwd: root,
          env: gitEnvironment,
          maxOutputBytes: 128 * 1024,
          deadline: Math.min(bodyDeadline, performance.now() + 30_000),
        }),
      catch: cause => scriptError(cause, 'Fixture git command failed.'),
    });
  yield* git(['init', '-q']);
  yield* git(['remote', 'add', 'origin', 'https://github.com/threadnote/threadnote.git']);
  yield* git(['config', 'user.email', 'threadnote@example.test']);
  yield* git(['config', 'user.name', 'Threadnote Test']);
  yield* git(['add', '.']);
  yield* git(['commit', '-qm', 'polyglot standalone fixture']);
});

const verifyMcp = Effect.fn('smokeSelfContained.verifyMcp')(function* (
  executable: string,
  cwd: string,
  environment: NodeJS.ProcessEnv,
  processes: FixtureProcesses,
  bodyDeadline: number,
) {
  const transport = new FixtureStdioTransport(processes, {
    args: ['mcp-server'],
    command: executable,
    cwd,
    env: {...getDefaultEnvironment(), ...environment},
    deadline: bodyDeadline,
    shutdownMode: 'effect-mcp-stdio-eof-130',
  });
  const client = new Client({name: 'threadnote-standalone-smoke', version: '1.0.0'});
  yield* Effect.acquireUseRelease(
    Effect.tryPromise({
      try: async () => {
        await client.connect(transport);
        transport.markMcpInitialized();
      },
      catch: cause => ScriptError.make({message: 'Could not start the standalone MCP server.', cause}),
    }),
    () =>
      Effect.tryPromise({
        try: async () => {
          const tools = await client.listTools();
          if (!EffectArray.some(tools.tools, tool => tool.name === 'recall_context')) {
            throw ScriptError.make({message: 'Standalone MCP server did not expose recall_context.'});
          }
          if (!EffectArray.some(tools.tools, tool => tool.name === 'inspect_code_graph')) {
            throw ScriptError.make({message: 'Standalone MCP server did not expose inspect_code_graph.'});
          }
          const recalled = await client.callTool(
            {
              arguments: {
                query: `${SMOKE_MARKER} standalone recall`,
                threshold: 0.1,
                uri: 'threadnote://user/standalone-smoke/memories/durable/projects/threadnote',
              },
              name: 'recall_context',
            },
            undefined,
            {timeout: Math.max(1, Math.min(COMMAND_TIMEOUT_MILLISECONDS, processes.remaining(bodyDeadline)))},
          );
          const text = contentText(recalled.content);
          if (recalled.isError === true || !Effect2.pipe(text, EffectString.includes('standalone-bun-smoke.md'))) {
            throw ScriptError.make({message: `Standalone MCP recall missed the stored memory:\n${text}`});
          }
          const graphOperations = [
            {arguments: {callerCwd: cwd, operation: 'query', query: 'Greeter'}, expected: 'Greeter'},
            {arguments: {callerCwd: cwd, operation: 'explain', symbol: 'KotlinApp'}, expected: 'KotlinApp'},
            {
              arguments: {
                callerCwd: cwd,
                from: 'typescriptBoot',
                operation: 'path',
                to: 'typescriptHelper',
              },
              expected: 'typescriptHelper',
            },
            {
              arguments: {callerCwd: cwd, operation: 'impact', query: 'makeService'},
              expected: 'swiftBoot',
            },
          ] as const;
          for (const graph of graphOperations) {
            const inspected = await client.callTool(
              {arguments: graph.arguments, name: 'inspect_code_graph'},
              undefined,
              {timeout: Math.max(1, Math.min(COMMAND_TIMEOUT_MILLISECONDS, processes.remaining(bodyDeadline)))},
            );
            const graphText = contentText(inspected.content);
            if (inspected.isError === true || !Effect2.pipe(graphText, EffectString.includes(graph.expected))) {
              throw ScriptError.make({
                message: `Standalone MCP graph inspection missed ${graph.expected}:\n${graphText}`,
              });
            }
          }
        },
        catch: cause => scriptError(cause, 'Standalone MCP smoke failed.'),
      }),
    () =>
      Effect.tryPromise({
        try: () => processes.wait(bodyDeadline, client.close()),
        catch: cause => ScriptError.make({message: 'Could not close the standalone MCP smoke client.', cause}),
      }),
  );
});

function contentText(content: unknown): string {
  if (!EffectArray.isArray(content)) return '';
  return EffectArray.join(
    EffectArray.map(content, (item: unknown) =>
      typeof item === 'object' && item !== null && 'text' in item && typeof item.text === 'string' ? item.text : '',
    ),
    '\n',
  );
}

const systemLayer = ScriptSystemInfoLayer;
const commandLayer = ScriptCommandExecutorLayer.pipe(Layer.provide(systemLayer));
const smokeLayer = Layer.merge(systemLayer, commandLayer).pipe(Layer.provideMerge(BunServices.layer));

BunRuntime.runMain(provideScriptLayer(smokeSelfContained, smokeLayer));
