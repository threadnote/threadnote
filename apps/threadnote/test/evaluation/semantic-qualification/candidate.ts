import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {Array as EffectArray, Record as EffectRecord, Schema, String as EffectString} from 'effect';
import {isJsonObject} from '@threadnote/platform/json';
import {runtimeNativePlatformTarget} from '@threadnote/platform/system';
import {BUN_STANDALONE_TARGETS} from '../../../../../scripts/release-targets.js';
/* oxlint-disable effecttsgo/node-builtin-import -- Candidate qualification owns explicit process and private evidence-file boundaries. */
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp, mkdir, writeFile, readFile, realpath, readdir, rm} from 'node:fs/promises';
import {tmpdir, release} from 'node:os';
import {dirname, isAbsolute, join, resolve} from 'node:path';
import {parseArgs} from 'node:util';
import {pathToFileURL} from 'node:url';
import {observeCandidateTransport} from './transport-lifecycle.js';
import {installProbeSignalCleanup} from '../../../../../tools/semantic/semantic_probe_process.js';
import {qualificationInventory} from './inventory.js';
import {
  readProviderInputs,
  selectedFixture,
  providerCatalog,
  runProviderNavigation,
  runOwnedBufferFixture,
  runProviderPreview,
  redactCapabilities,
  protocolCapabilities,
} from './provider-fixture.js';
import {runContextFixture} from './context-fixture.js';
import {runProviderApplication, type WriterFixtureRecord} from './writer-fixture.js';
import {shutdownFixtureProviders} from './provider-shutdown.js';
import {checkMissingProfileTransportParity} from './transport-oracle.js';

const digest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));
const gitId = Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/u));
export const Candidate = Schema.Struct({
  binary: Schema.String,
  binarySha256: digest,
  releaseSha256: digest,
  sourceCommit: gitId,
  sourceTree: gitId,
});
/** Compare exact release identities; unknown libc/CPU and non-baseline aliases cannot qualify a host. */
export function candidateTargetMatchesHost(target: string, nativeHostTarget: string | undefined): boolean {
  return (
    nativeHostTarget !== undefined &&
    EffectArray.some(
      BUN_STANDALONE_TARGETS,
      releaseTarget => releaseTarget === target && releaseTarget === `bun-${nativeHostTarget}`,
    )
  );
}
const execute = promisify(execFile);
const repository = new URL('../../../../../', import.meta.url);
const hash = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const failure = (error: unknown) => (error instanceof Error ? error.message : 'Unknown failure');
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (isJsonObject(error) && error.code === 'ESRCH') return false;
    if (isJsonObject(error) && error.code === 'EPERM') return true;
    throw error;
  }
};
const within = async <A>(promise: Promise<A>, milliseconds: number): Promise<A> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Deadline')), Math.max(1, milliseconds));
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};
const streamText = async (stream: ReadableStream<Uint8Array>, capacity: number) => {
  let bytes = 0,
    text = '';
  const decoder = new TextDecoder('utf-8', {fatal: true});
  for await (const chunk of stream) {
    bytes += chunk.length;
    if (bytes > capacity) throw new Error('Output capacity exceeded');
    text += decoder.decode(chunk, {stream: true});
  }
  return text + decoder.decode();
};
interface SmokeReport {
  schemaVersion: number;
  kind: string;
  status: 'passed' | 'failed';
  scenario: string;
  branch: string;
  fullScenarioQualified: false;
  cost: {modelCalls: number; providerLaunches: number | null; downloads: number};
  candidate?: unknown;
  sourceHashes?: Record<string, string>;
  sourceResult?: unknown;
  releaseGate?: ReturnType<typeof qualificationInventory>;
  provider: {started: boolean | null; artifact: unknown; runtime: unknown};
  providerChecks?: unknown;
  operations?: unknown[];
  writerRecords?: WriterFixtureRecord[];
  harnessSha256?: string;
  manifestSha256?: string;
  fixture?: unknown;
  request?: unknown;
  environment?: unknown;
  cli?: unknown;
  mcp?: unknown;
  homeInventory?: string[];
  failure?: string;
  checks?: unknown;
  elapsedMilliseconds?: number;
  cleanup: {
    mcpCloseObserved?: boolean;
    mcpCloseCompleted?: boolean;
    closeFailure?: string;
    ownedProcesses?: {pid: number; absent: boolean}[];
    ownedProcessesGone?: boolean;
    fixtureRemoved?: boolean;
    fixtureRetained?: string;
    semantic?: Awaited<ReturnType<typeof shutdownFixtureProviders>>;
  };
}

/** One real transport branch. No configured provider, proposal, or whole scenario is qualified. */
export async function runCandidateChecks(
  manifestPath: string,
  output: string,
  providerInputsPath?: string,
  writerFixture = false,
) {
  // Reserve before launching; an existing receipt is never overwritten or rerun.
  await writeFile(
    output,
    JSON.stringify({schemaVersion: 1, kind: 'candidate-transport-branch', status: 'started'}) + '\n',
    {mode: 0o600, flag: 'wx'},
  );
  const started = Date.now(),
    deadline = started + (providerInputsPath ? 180_000 : 42_000);
  let root = '',
    home = '';
  let transport: StdioClientTransport | undefined, client: Client | undefined;
  let close: ReturnType<typeof observeCandidateTransport> | undefined;
  const privateCapabilities = new Set<string>();
  const children = new Map<number, {kill: () => unknown; exited?: Promise<number>}>();
  const report: SmokeReport = {
    schemaVersion: 1,
    kind: 'candidate-transport-branch',
    status: 'failed',
    scenario: 'S33',
    branch: 'unavailable-provider',
    fullScenarioQualified: false,
    cost: {modelCalls: 0, providerLaunches: 0, downloads: 0},
    cleanup: {},
    provider: {started: false, artifact: null, runtime: null},
  };
  let finishing: Promise<void> | undefined;
  const finish = () =>
    (finishing ??= (async () => {
      // Stop request producers before withdrawing our bootstrap, so timed-out CLI calls cannot relaunch it.
      for (const [pid, child] of children)
        if (pid !== close?.pid && alive(pid)) {
          try {
            child.kill();
          } catch {
            /* Checked below. */
          }
        }
      const semanticCleanup =
        providerInputsPath && home ? shutdownFixtureProviders(home, join(root, 'project')) : undefined;
      try {
        await within(close?.close() ?? Promise.resolve(), 4500);
        report.cleanup.mcpCloseCompleted = true;
        if (close) await close.waitForCloseIfStarted(AbortSignal.timeout(500));
        report.cleanup.mcpCloseObserved = close?.closeObserved ?? false;
      } catch (error) {
        report.cleanup.closeFailure = failure(error);
        report.status = 'failed';
      }
      for (const [pid, child] of children)
        if (alive(pid)) {
          try {
            child.kill();
          } catch {
            /* Absence checked below. */
          }
        }
      for (const child of children.values()) if (child.exited) await within(child.exited, 500).catch(() => undefined);
      report.cleanup.ownedProcesses = EffectArray.map([...children.keys()], pid => ({pid, absent: !alive(pid)}));
      report.cleanup.ownedProcessesGone = EffectArray.every(report.cleanup.ownedProcesses, process => process.absent);
      let semanticDrained = true;
      if (semanticCleanup) {
        try {
          report.cleanup.semantic = await semanticCleanup;
          if (report.cleanup.semantic.providers.length > 0) report.provider.started = true;
          semanticDrained = report.cleanup.semantic.drained;
        } catch (error) {
          semanticDrained = false;
          report.cleanup.closeFailure = failure(error);
        }
      }
      const writerRetired = EffectArray.every(report.writerRecords ?? [], record => record.retired);
      const mcpCleanupKnown = close?.pid == null || (report.cleanup.mcpCloseCompleted && close.closeObserved);
      if (!mcpCleanupKnown || !semanticDrained || !writerRetired) report.status = 'failed';
      if (root && report.cleanup.ownedProcessesGone && mcpCleanupKnown && semanticDrained && writerRetired) {
        await rm(root, {recursive: true, force: true});
        report.cleanup.fixtureRemoved = true;
      } else if (root) {
        report.cleanup.fixtureRetained = root;
        report.status = 'failed';
      }
      report.elapsedMilliseconds = Date.now() - started;
      const serialized = JSON.stringify(report, null, 2) + '\n';
      if (
        EffectArray.some(
          [...privateCapabilities],
          capability => capability.length > 0 && EffectString.includes(capability)(serialized),
        )
      ) {
        report.status = 'failed';
        report.failure = 'Private capability detected in attempted receipt; detailed content withheld';
        await writeFile(
          output,
          JSON.stringify(
            {
              schemaVersion: 1,
              kind: report.kind,
              status: report.status,
              failure: report.failure,
              cleanup: report.cleanup,
              fullScenarioQualified: false,
            },
            null,
            2,
          ) + '\n',
          {mode: 0o600},
        );
      } else await writeFile(output, serialized, {mode: 0o600});
    })());
  const signals = installProbeSignalCleanup(async signal => {
    report.status = 'failed';
    report.failure = `Interrupted: ${signal}`;
    await finish();
  });
  try {
    report.releaseGate = qualificationInventory(
      JSON.parse(
        await readFile(
          new URL('../../../../../config/semantic-providers/qualification-lock.json', import.meta.url),
          'utf8',
        ),
      ),
    );
    const manifestBytes = await readFile(manifestPath);
    const candidate = Schema.decodeUnknownSync(Candidate, {onExcessProperty: 'error'})(
      JSON.parse(manifestBytes.toString()),
    );
    if (!isAbsolute(candidate.binary)) throw new Error('Candidate binary must be absolute');
    const binary = resolve(candidate.binary),
      releaseBytes = await readFile(join(dirname(binary), 'release.json'));
    if (hash(await readFile(binary)) !== candidate.binarySha256 || hash(releaseBytes) !== candidate.releaseSha256)
      throw new Error('Candidate hash mismatch');
    const built = Schema.decodeUnknownSync(
      Schema.Struct({version: Schema.String, runtime: Schema.String, target: Schema.String}),
    )(JSON.parse(releaseBytes.toString()));
    const git = await execute('git', ['rev-parse', `${candidate.sourceCommit}^{tree}`], {
      cwd: repository,
      timeout: 5000,
      maxBuffer: 4096,
    });
    if (
      EffectString.trim(git.stdout) !== candidate.sourceTree ||
      !EffectString.endsWith(`.g${candidate.sourceCommit}`)(built.version)
    )
      throw new Error('Candidate source/release binding mismatch');
    const nativeHostTarget = runtimeNativePlatformTarget();
    if (!candidateTargetMatchesHost(built.target, nativeHostTarget))
      throw new Error('Candidate target does not match a proven native host target');
    report.candidate = {
      ...candidate,
      release: built,
      nativeHostTarget,
      sourceBinding: 'operator-captured-build-manifest; git-tree-and-release-commit-verified',
      finalCombinedCandidate: false,
    };
    const provider = providerInputsPath ? await readProviderInputs(providerInputsPath) : undefined;
    if (provider) {
      report.branch = writerFixture ? 'pinned-provider-authorized-writer-fixture' : 'pinned-provider-read-fixture';
      report.provider = {
        started: null,
        artifact: provider,
        runtime:
          provider.input.language === 'go'
            ? {
                version: provider.input.goVersion,
                sha256: provider.input.goExecutableDigest,
                sdkTreeDigest: provider.input.sdkTreeDigest,
              }
            : {version: provider.input.runtimeVersion, sha256: provider.input.runtimeDigest},
      };
      report.cost.providerLaunches = null;
    }
    report.operations = [];
    report.writerRecords = [];
    report.sourceHashes = {};
    for (const path of [
      'candidate.ts',
      'entrypoint.ts',
      'provider-fixture.ts',
      'context-fixture.ts',
      'provider-shutdown.ts',
      'writer-fixture.ts',
      '../../../src/semantic/fingerprint.ts',
      '../../../../../tools/semantic/semantic_provider_fixture.ts',
      '../../../../../tools/semantic/semantic_probe_assertions.ts',
      'inventory.ts',
      'transport-oracle.ts',
      'transport-lifecycle.ts',
      'scenario-contracts.json',
      '../../helpers/stdio-client-transport-close.ts',
      '../../../../../tools/semantic/semantic_probe_process.ts',
      '../../../../../scripts/release-targets.ts',
      '../../../../../scripts/qualify-semantic-providers.ts',
      '../../../../../scripts/qualify-semantic-editors.ts',
      '../../../../../config/semantic-providers/qualification-lock.json',
      '../../../../../bun.lock',
      '../../../../../node_modules/@modelcontextprotocol/sdk/package.json',
    ])
      report.sourceHashes[path] = hash(await readFile(new URL(path, import.meta.url)));
    report.manifestSha256 = hash(manifestBytes);
    report.harnessSha256 = hash(await readFile(import.meta.path));
    root = await realpath(
      await mkdtemp(
        join(
          provider && process.platform === 'darwin' ? '/tmp' : tmpdir(),
          provider ? 'tn11-provider-' : 'tn11-transport-',
        ),
      ),
    );
    home = join(root, 'home');
    const project = join(root, 'project');
    await mkdir(home, {mode: 0o700});
    await mkdir(project, {mode: 0o700});
    const fixture = provider
      ? selectedFixture(provider.input)
      : {
          sources: {'a.ts': 'export const selected = "🧵 private-fixture";\r\n'},
          projectFiles: {'tsconfig.json': '{"files":["a.ts"]}\n'},
        };
    const files = {...fixture.sources, ...fixture.projectFiles};
    let expectedFiles = files;
    for (const [name, text] of EffectRecord.toEntries(files)) {
      await mkdir(dirname(join(project, name)), {recursive: true});
      await writeFile(join(project, name), text);
    }
    const environment = {
      HOME: home,
      USERPROFILE: home,
      PATH: process.platform === 'win32' ? (process.env.SystemRoot ?? 'C:\\Windows') + '\\System32' : '/usr/bin:/bin',
      ...(process.platform === 'win32' ? {SystemRoot: process.env.SystemRoot ?? 'C:\\Windows'} : {}),
      THREADNOTE_HOME: home,
      THREADNOTE_ACCOUNT: 'local',
      THREADNOTE_USER: 'synthetic-p11-smoke',
      THREADNOTE_AGENT_ID: 'threadnote',
      THREADNOTE_MANIFEST: join(home, 'manifest.yaml'),
      THREADNOTE_MCP_TOOLSET: 'full',
      THREADNOTE_MODEL_SETUP: 'off',
      THREADNOTE_EFFECT_AI: 'off',
    };
    const sdk = Schema.decodeUnknownSync(Schema.Struct({version: Schema.String}))(
      JSON.parse(
        await readFile(
          new URL('../../../../../node_modules/@modelcontextprotocol/sdk/package.json', import.meta.url),
          'utf8',
        ),
      ),
    );
    report.environment = {
      sdkVersion: sdk.version,
      os: process.platform,
      osRelease: release(),
      architecture: process.arch,
      harnessBun: Bun.version,
      variables: environment,
    };
    report.fixture = {
      id: provider ? 'pinned-provider-unicode-crlf' : 'missing-profile-unicode-crlf',
      version: 1,
      root,
      files: EffectRecord.fromEntries(
        EffectArray.map(EffectRecord.toEntries(files), ([name, text]) => [name, hash(text)]),
      ),
    };
    const run = async (args: readonly string[], request: object) => {
      const cli = Bun.spawn([binary, ...args], {
        cwd: project,
        env: environment,
        stdin: new Blob([JSON.stringify(request)]),
        stdout: 'pipe',
        stderr: 'pipe',
      });
      children.set(cli.pid, {kill: () => cli.kill('SIGKILL'), exited: cli.exited});
      const [stdout, stderr, code] = await within(
        Promise.all([streamText(cli.stdout, 2 * 1024 * 1024), streamText(cli.stderr, 65536), cli.exited]),
        deadline - Date.now(),
      );
      if (code !== 0) throw new Error('CLI returned nonzero');
      const value: unknown = args[0] === 'remember' ? {text: stdout} : JSON.parse(stdout);
      for (const capability of protocolCapabilities(value)) privateCapabilities.add(capability);
      report.operations?.push({
        args,
        request: redactCapabilities(request),
        pid: cli.pid,
        code,
        stderr,
        canonical: redactCapabilities(value),
      });
      return {pid: cli.pid, code, stdout, stderr, value};
    };
    const request = {
      callerCwd: project,
      file: join(project, 'a.ts'),
      language: 'typescript',
      operation: 'definition',
      position: {line: 0, character: 14},
      milliseconds: 1000,
      maxBytes: 8192,
      maxItems: 8,
    };
    if (provider) {
      const selected = await providerCatalog(provider.input, root);
      const setup = await run(['semantic', 'setup', '--json'], {
        version: 1,
        callerCwd: project,
        language: provider.input.language,
        profile: {version: 1, enabled: true, worktree: pathToFileURL(project).href, catalog: selected.catalog},
        apply: true,
      });
      report.providerChecks = {setup: setup.value, environment: selected.environment};
      if (!isJsonObject(setup.value) || setup.value.state !== 'configured')
        throw new Error('Pinned provider setup refused');
    }
    const cli = provider ? undefined : await run(['semantic', 'query', '--json'], request);
    if (cli) {
      report.cli = cli;
      report.request = request;
    }
    transport = new StdioClientTransport({
      command: binary,
      args: ['mcp-server'],
      cwd: project,
      env: environment,
      stderr: 'pipe',
      maxBufferSize: 2 * 1024 * 1024,
    });
    close = observeCandidateTransport(transport, pid => {
      children.set(pid, {kill: () => process.kill(pid, 'SIGKILL')});
    });
    let stderrBytes = 0,
      diagnostics = '',
      stderrExceeded = false;
    transport.stderr?.on('data', (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes <= 65536) diagnostics += chunk.toString();
      else {
        stderrExceeded = true;
        void close?.close().catch(() => undefined);
      }
    });
    client = new Client({name: 'threadnote-p11-qualification', version: '1.0.0'});
    await within(client.connect(transport), deadline - Date.now());
    if (provider) {
      const branches: unknown[] = [];
      const setup = report.providerChecks;
      report.providerChecks = {setup, navigation: {status: 'observing', branches, fullScenarioQualified: false}};
      await runProviderNavigation(provider.input, project, fixture.sources, run, client, within, deadline, branches);
      await runOwnedBufferFixture(provider.input, project, fixture.sources, run, client, within, deadline, branches);
      const prepared = await runProviderPreview(
        provider.input,
        project,
        fixture.sources,
        run,
        client,
        within,
        deadline,
        branches,
      );
      if (!writerFixture)
        await runContextFixture(provider.input, project, fixture.sources, run, within, deadline, branches, async () => {
          const gitOptions = {
            cwd: project,
            timeout: 5000,
            env: {...environment, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null'},
          };
          await execute('git', ['init', '--quiet', '--object-format=sha1'], gitOptions);
          await execute('git', ['add', '--', ...EffectRecord.keys(files)], gitOptions);
          await execute(
            'git',
            [
              '-c',
              'core.hooksPath=/dev/null',
              '-c',
              'commit.gpgsign=false',
              '-c',
              'user.name=Threadnote Fixture',
              '-c',
              'user.email=fixture@example.invalid',
              'commit',
              '-qm',
              'P11 authored fixture',
            ],
            gitOptions,
          );
        });
      if (writerFixture) {
        branches.push({
          operation: 'semantic-context-graph-memory-join',
          status: 'not-run',
          reason: 'This writer fixture does not exercise the separate context branch',
          fullScenarioQualified: false,
        });
        const written = await runProviderApplication(
          home,
          project,
          fixture.sources,
          prepared,
          run,
          client,
          within,
          deadline,
          branches,
          report.writerRecords,
        );
        expectedFiles = {...files, ...written};
      }
      report.providerChecks = {setup, navigation: {status: 'passed', branches, fullScenarioQualified: false}};
      report.provider.started = true;
    } else {
      const response = await within(
        client.callTool({name: 'semantic_query', arguments: {request, responseFormat: 'dual'}}, undefined, {
          timeout: Math.max(1, Math.min(5000, deadline - Date.now())),
        }),
        deadline - Date.now(),
      );
      report.mcp = {pid: transport.pid, response, stderr: diagnostics, stderrBytes};
      if (!cli || stderrExceeded || !checkMissingProfileTransportParity(cli.value, response))
        throw new Error('Missing-profile transport contract mismatch');
    }
    const finalHashes: Record<string, string> = {};
    for (const [name, text] of EffectRecord.toEntries(expectedFiles)) {
      const observed = await readFile(join(project, name), 'utf8');
      if (observed !== text) throw new Error('Source changed');
      finalHashes[name] = hash(observed);
    }
    report.sourceResult = {files: finalHashes, onlyExpectedAuthoredChanges: writerFixture};
    if (provider && providerInputsPath) {
      const after = await readProviderInputs(providerInputsPath);
      if (after.manifestSha256 !== provider.manifestSha256) throw new Error('Provider input manifest changed');
    }
    const paths: string[] = [];
    const visit = async (directory: string, prefix = '') => {
      for (const entry of await readdir(directory, {withFileTypes: true})) {
        const key = prefix + entry.name;
        paths.push(key);
        if (entry.isDirectory()) await visit(join(directory, entry.name), key + '/');
      }
    };
    await visit(home);
    report.homeInventory = paths;
    if (!provider && EffectArray.some(paths, path => path === 'semantic' || EffectString.startsWith('semantic/')(path)))
      throw new Error('Unexpected semantic runtime state');
    report.checks = {
      ...(provider
        ? {sameCanonicalEvidence: true}
        : {sameCanonicalFailure: true, noSemanticProfileAdmissionBootstrapOrSocket: true}),
      ...(writerFixture ? {onlyExpectedAuthoredSourceChanges: true} : {sourceUnchanged: true}),
    };
    report.status = 'passed';
  } catch (error) {
    report.failure = failure(error);
  } finally {
    await finish();
    signals.dispose();
  }
  return report;
}

export async function runQualificationCommand(arguments_: readonly string[] = process.argv.slice(2)) {
  const {values} = parseArgs({
    args: [...arguments_],
    options: {
      inventory: {type: 'boolean'},
      'candidate-manifest': {type: 'string'},
      'provider-inputs': {type: 'string'},
      'writer-fixture': {type: 'boolean'},
      output: {type: 'string'},
    },
    strict: true,
  });
  if (!values.output || Boolean(values.inventory) === Boolean(values['candidate-manifest']))
    throw new Error('Use --inventory OR --candidate-manifest <manifest.json>, and --output <new-report.json>');
  if (
    (values['writer-fixture'] && !values['provider-inputs']) ||
    (values.inventory && (values['provider-inputs'] || values['writer-fixture']))
  )
    throw new Error(
      'Provider/writer fixture requires candidate-manifest; writer-fixture also requires provider-inputs',
    );
  const ledger = JSON.parse(
    await readFile(
      new URL('../../../../../config/semantic-providers/qualification-lock.json', import.meta.url),
      'utf8',
    ),
  );
  const inventory = qualificationInventory(ledger);
  if (values.inventory) {
    await writeFile(values.output, JSON.stringify(inventory, null, 2) + '\n', {mode: 0o600, flag: 'wx'});
    process.stdout.write(JSON.stringify(inventory.counts) + '\n');
  } else if (values['candidate-manifest']) {
    const report = await runCandidateChecks(
      values['candidate-manifest'],
      values.output,
      values['provider-inputs'],
      values['writer-fixture'],
    );
    // A branch receipt is not a complete scenario or family/platform/client receipt.
    // There is intentionally no input that promotes caller assertions into qualification.
    process.stdout.write(
      JSON.stringify({
        status: report.status === 'passed' ? 'blocked' : 'failed',
        receipt: values.output,
        branch: report.status,
        fullScenarioQualified: false,
        ...inventory.counts,
      }) + '\n',
    );
    process.exitCode = report.status === 'passed' ? 2 : 1;
  }
}

if (import.meta.main) await runQualificationCommand();
