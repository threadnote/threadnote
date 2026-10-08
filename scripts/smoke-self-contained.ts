import {ScriptCommandExecutorLayer} from './effect/system-layer.js';
import {ScriptSystemInfoLayer} from './effect/system-layer.js';
import {provideScriptLayer, scriptError, ScriptError} from './effect/errors.js';
import * as BunRuntime from '@effect/platform-bun/BunRuntime';
import * as BunServices from '@effect/platform-bun/BunServices';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {Console, Effect, FileSystem, Layer, Option, Path} from 'effect';
import {runCommandEffect} from '@threadnote/platform/command';
import {SystemInfo} from '@threadnote/platform/system';
import {recallIndexDatabaseFilename} from '@threadnote/recall/index';

const ROOT_URL = new URL('..', import.meta.url);
const COMMAND_TIMEOUT_MILLISECONDS = 300_000;
const SMOKE_MARKER = 'QZ9-standalone-bun-smoke';
const LARGE_OUTPUT_START = 'QZ9-standalone-large-output-start';
const LARGE_OUTPUT_END = 'QZ9-standalone-large-output-end';

const smokeSelfContained = Effect.scoped(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* path.fromFileUrl(ROOT_URL);
    const executable = path.join(root, 'dist', process.platform === 'win32' ? 'threadnote.exe' : 'threadnote');
    const packageManifest = JSON.parse(yield* fs.readFileString(path.join(root, 'package.json'))) as {
      readonly version?: unknown;
    };
    if (typeof packageManifest.version !== 'string' || packageManifest.version.length === 0) {
      return yield* ScriptError.make({message: 'package.json does not declare a release version.'});
    }
    if (!(yield* fs.exists(executable))) {
      return yield* ScriptError.make({message: 'Standalone executable is missing; run bun run build first.'});
    }

    const temporaryRoot = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-standalone-smoke-'});
    const threadnoteHome = path.join(temporaryRoot, 'home');
    const userHome = path.join(temporaryRoot, 'user-home');
    const invocationDirectory = path.join(temporaryRoot, 'repo');
    for (const directory of [threadnoteHome, userHome, invocationDirectory]) {
      yield* fs.makeDirectory(directory, {recursive: true});
    }
    const gitExecutable = Option.fromNullishOr(Bun.which('git'));
    if (Option.isNone(gitExecutable)) {
      return yield* ScriptError.make({message: 'Standalone graph smoke requires Git on the build host.'});
    }
    yield* writePolyglotRepository(fs, path, invocationDirectory, gitExecutable.value);

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
      runCommandEffect(executable, arguments_, {
        cwd: invocationDirectory,
        env: environment,
        maxOutputBytes: 512 * 1024,
        timeoutMs: COMMAND_TIMEOUT_MILLISECONDS,
      }).pipe(Effect.map(result => `${result.stdout}\n${result.stderr}`));

    const version = yield* run(['--version']);
    if (!version.includes(`threadnote v${packageManifest.version}`)) {
      return yield* ScriptError.make({message: `Standalone release reported an unexpected version:\n${version}`});
    }

    yield* run(['install', '--dry-run', '--no-start']);

    const runtime = yield* run(['models', 'runtime']);
    if (!/node-llama-cpp:\s+prebuilt/i.test(runtime)) {
      return yield* ScriptError.make({message: `Native runtime was not loaded from the release payload:\n${runtime}`});
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
    if (!recall.includes('standalone-bun-smoke.md')) {
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
      `${storedMemory.trimEnd()}\n\n${LARGE_OUTPUT_START}\n${'x'.repeat(96 * 1024)}\n${LARGE_OUTPUT_END}\n`,
    );
    const largeRead = yield* readLargeOutputThroughPlatformPipe({
      consumer: path.join(root, 'apps', 'threadnote', 'test', 'fixtures', 'cli-output-consumer.ts'),
      cwd: invocationDirectory,
      environment,
      executable,
      fs,
      path,
      temporaryRoot,
      uri: 'threadnote://user/standalone-smoke/memories/durable/projects/threadnote/standalone-bun-smoke.md',
    });
    if (largeRead.bytes <= 65_536 || largeRead.hasStart !== true || largeRead.hasEnd !== true) {
      return yield* ScriptError.make({
        message:
          `Standalone large memory read was truncated before stdout drained: ${largeRead.bytes} bytes; ` +
          `start=${largeRead.hasStart}; end=${largeRead.hasEnd}.`,
      });
    }

    const lexicalDatabase = path.join(threadnoteHome, 'indexes', 'lexical', recallIndexDatabaseFilename(false));
    const lexicalInfo = yield* fs.stat(lexicalDatabase);
    if (lexicalInfo.type !== 'File' || lexicalInfo.size <= 0) {
      return yield* ScriptError.make({message: 'Standalone recall did not create a populated Bun SQLite index.'});
    }

    const doctor = yield* run(['doctor', '--dry-run']);
    if (!/bun runtime:\s+v1\.4\.2;\s+embedded/i.test(doctor) || /Node runtime/i.test(doctor)) {
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
      if (!graphOperations[index].includes(expected)) {
        return yield* ScriptError.make({
          message: `Standalone graph operation ${index + 1} missed ${expected}:\n${graphOperations[index]}`,
        });
      }
    }

    yield* verifyMcp(executable, invocationDirectory, environment);
    yield* Console.log(
      'Self-contained Bun executable smoke passed with polyglot CLI/MCP graph operations and Node/Bun absent from PATH.',
    );
  }),
);

interface LargeOutputPipeOptions {
  readonly consumer: string;
  readonly cwd: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly executable: string;
  readonly fs: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly temporaryRoot: string;
  readonly uri: string;
}

const readLargeOutputThroughPlatformPipe = Effect.fn('smokeSelfContained.readLargeOutputThroughPlatformPipe')(
  function* (options: LargeOutputPipeOptions) {
    const windows = process.platform === 'win32';
    const inheritedEnvironment = (yield* SystemInfo).environment();
    const quote = (value: string): string =>
      windows ? `"${value.replaceAll('%', '%%').replaceAll('"', '""')}"` : `'${value.replaceAll("'", `'\\''`)}'`;
    const producer = [options.executable, 'read', options.uri].map(quote).join(' ');
    const consumer = [process.execPath, options.consumer, 'text', LARGE_OUTPUT_START, LARGE_OUTPUT_END]
      .map(quote)
      .join(' ');
    const scriptPath = options.path.join(options.temporaryRoot, windows ? 'large-output.cmd' : 'large-output.sh');
    yield* options.fs.writeFileString(
      scriptPath,
      windows ? `@echo off\r\n${producer} | ${consumer}\r\n` : `set -eu\n${producer} | ${consumer}\n`,
    );
    const shell = windows ? (inheritedEnvironment.ComSpec ?? inheritedEnvironment.COMSPEC ?? 'cmd.exe') : '/bin/sh';
    const shellArguments = windows ? ['/d', '/s', '/c', scriptPath] : [scriptPath];
    const result = yield* runCommandEffect(shell, shellArguments, {
      cwd: options.cwd,
      env: options.environment,
      maxOutputBytes: 128 * 1024,
      timeoutMs: COMMAND_TIMEOUT_MILLISECONDS,
    });
    return yield* Effect.try({
      try: () =>
        JSON.parse(result.stdout) as {
          readonly bytes: number;
          readonly hasEnd: boolean;
          readonly hasStart: boolean;
        },
      catch: cause => ScriptError.make({message: 'Standalone large-output pipe returned invalid JSON.', cause}),
    });
  },
);

const writePolyglotRepository = Effect.fn('smokeSelfContained.writePolyglotRepository')(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  root: string,
  gitExecutable: string,
) {
  const files: Readonly<Record<string, string>> = {
    'Package.swift': [
      'import PackageDescription',
      'let package = Package(name: "SwiftWorkspace", targets: [',
      '  .target(name: "SwiftCore"),',
      '  .target(name: "SwiftApp", dependencies: ["SwiftCore"])',
      '])',
      '',
    ].join('\n'),
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
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(root, ...relative.split('/'));
    yield* fs.makeDirectory(path.dirname(target), {recursive: true});
    yield* fs.writeFileString(target, content);
  }
  const git = (arguments_: readonly string[]) =>
    runCommandEffect(gitExecutable, arguments_, {
      cwd: root,
      maxOutputBytes: 128 * 1024,
      timeoutMs: 30_000,
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
) {
  const transport = new StdioClientTransport({
    args: ['mcp-server'],
    command: executable,
    cwd,
    env: environment,
    stderr: 'pipe',
  });
  const client = new Client({name: 'threadnote-standalone-smoke', version: '1.0.0'});
  yield* Effect.acquireUseRelease(
    Effect.tryPromise({
      try: () => client.connect(transport),
      catch: cause => ScriptError.make({message: 'Could not start the standalone MCP server.', cause}),
    }),
    () =>
      Effect.tryPromise({
        try: async () => {
          const tools = await client.listTools();
          if (!tools.tools.some(tool => tool.name === 'recall_context')) {
            throw ScriptError.make({message: 'Standalone MCP server did not expose recall_context.'});
          }
          if (!tools.tools.some(tool => tool.name === 'inspect_code_graph')) {
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
            {timeout: COMMAND_TIMEOUT_MILLISECONDS},
          );
          const text = (recalled.content ?? []).map(item => ('text' in item ? item.text : '')).join('\n');
          if (recalled.isError === true || !text.includes('standalone-bun-smoke.md')) {
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
              {timeout: COMMAND_TIMEOUT_MILLISECONDS},
            );
            const graphText = (inspected.content ?? []).map(item => ('text' in item ? item.text : '')).join('\n');
            if (inspected.isError === true || !graphText.includes(graph.expected)) {
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
        try: () => client.close(),
        catch: cause => ScriptError.make({message: 'Could not close the standalone MCP smoke client.', cause}),
      }).pipe(Effect.ignore),
  );
});

const systemLayer = ScriptSystemInfoLayer;
const commandLayer = ScriptCommandExecutorLayer.pipe(Layer.provide(systemLayer));
const smokeLayer = Layer.merge(systemLayer, commandLayer).pipe(Layer.provideMerge(BunServices.layer));

BunRuntime.runMain(provideScriptLayer(smokeSelfContained, smokeLayer));
