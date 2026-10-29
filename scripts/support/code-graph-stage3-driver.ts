import {Array as EffectArray} from 'effect';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {Effect, FileSystem, ManagedRuntime, Path, PlatformError, Schema} from 'effect';
import {readCodeGraphBuildStatuses, type ObservedCodeGraphBuildStatus} from '@threadnote/graph/build_status';
import {codeGraphLayout, codeGraphRefreshDemandPath, codeGraphWorktreeSpawnLockPath} from '@threadnote/graph/layout';
import {validCodeGraphRefreshDemand} from '@threadnote/graph/refresh/demand_scheduler';
import {resolveRepositoryIdentity} from '@threadnote/graph/repository';
import {StandaloneBrokerLayer} from '@threadnote/threadnote/effect/runtime';
import {SystemInfo} from '@threadnote/platform/system';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {
  resolveManagedDevelopmentExecutableForSource,
  verifyManagedDevelopmentRuntimeForSourceCheckout,
} from '../development-runtime.js';
import {processInstanceIdentityMatches} from '@threadnote/threadnote/process/process_identity';
import {assertStage3, stage3Record, type Stage3ExecuteOptions} from './code-graph-stage3-contract.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

export const stage3SourceRoot = Effect2.pipe(
  Bun.fileURLToPath(new URL('../../', import.meta.url)),
  EffectString.replace(/\/$/u, ''),
);
export const STAGE3_DEADLINE = 120_000;
export const STAGE3_POLL = 250;
const DemandTarget = {
  targetKey: Schema.String,
  targetToken: Schema.String,
  attachmentCount: Schema.Natural,
  requestedAt: Schema.Natural,
  updatedAt: Schema.Natural,
  retry: Schema.optionalKey(Schema.Struct({attempt: Schema.Natural, notBefore: Schema.Natural})),
};
const Demand = Schema.Struct({
  version: Schema.Literal(1),
  checkoutId: Schema.String,
  worktreeId: Schema.String,
  revision: Schema.Natural,
  desired: Schema.optionalKey(Schema.Struct(DemandTarget)),
  active: Schema.optionalKey(
    Schema.Struct({
      ...DemandTarget,
      claimStartedAt: Schema.Natural,
      phase: Schema.Literals(['claimed', 'preparing', 'publishing']),
      claimOwner: Schema.optionalKey(
        Schema.Struct({processId: Schema.Natural, processStartIdentity: Schema.optionalKey(Schema.String)}),
      ),
    }),
  ),
});

export interface Stage3Host {
  readonly label: 'a' | 'b';
  readonly client: Client;
  readonly transport: StdioClientTransport;
  readonly processId: number;
  dead: boolean;
}

export interface Stage3Lock {
  readonly process: Bun.Subprocess;
  readonly releasePath: string;
  released: boolean;
}

export type Stage3Worktree = Awaited<ReturnType<Stage3Driver['worktree']>>;

export interface Stage3CommandResult {
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
  readonly timedOut: boolean;
}

export type Stage3OutputParentMarkerInspection = 'clear' | 'marker' | 'unknown';

/** Refuse every visible Git marker; only a complete marker-free canonical ancestor walk is clear. */
function stage3MarkerInspection(fs: FileSystem.FileSystem, marker: string) {
  const missing = (cause: unknown) => cause instanceof PlatformError.PlatformError && cause.reason._tag === 'NotFound';
  return fs.stat(marker).pipe(
    Effect.as('marker' as const),
    Effect.catchIf(missing, () =>
      fs.readLink(marker).pipe(
        Effect.as('marker' as const),
        Effect.catchIf(missing, () => Effect.succeed('clear' as const)),
        Effect.orElseSucceed(() => 'unknown' as const),
      ),
    ),
    Effect.orElseSucceed(() => 'unknown' as const),
  );
}

/** Only an isolated Git diagnostic plus a clear canonical marker chain proves an output parent is outside a worktree. */
export function classifyStage3OutputParentGitResult(
  result: Stage3CommandResult,
  markers: Stage3OutputParentMarkerInspection,
): 'inside-worktree' | 'outside-worktree' | 'unknown' {
  if (result.timedOut || result.exitCode === 0) return result.exitCode === 0 ? 'inside-worktree' : 'unknown';
  return markers === 'clear' &&
    result.exitCode === 128 &&
    Effect2.pipe(result.stdout, EffectString.trim) === '' &&
    /^fatal: not a git repository \(or any of the parent directories\): \.git\s*$/u.test(result.stderr)
    ? 'outside-worktree'
    : 'unknown';
}

/** OS/MCP boundary driver. All observations come from owned processes and production sidecars. */
export class Stage3Driver {
  readonly runtime = ManagedRuntime.make(StandaloneBrokerLayer);
  readonly hosts: Stage3Host[] = [];
  readonly locks: Stage3Lock[] = [];
  readonly history = new Map<string, ObservedCodeGraphBuildStatus>();
  readonly forbidden = new Set<string>();
  readonly worktrees: Stage3Worktree[] = [];
  root = '';
  home = '';
  environment: Record<string, string> = {};
  private lockOrdinal = 0;

  constructor(readonly options: Stage3ExecuteOptions) {}

  async services() {
    return {
      fs: await this.runtime.runPromise(FileSystem.FileSystem),
      path: await this.runtime.runPromise(Path.Path),
      system: await this.runtime.runPromise(SystemInfo),
    };
  }

  async preflight() {
    const {fs, path, system} = await this.services();
    assertStage3(system.platform === 'darwin' || system.platform === 'linux', 'posix-runner-required');
    assertStage3(
      (await this.git(stage3SourceRoot, ['rev-parse', '--verify', 'HEAD'])) === this.options.candidateCommit,
      'candidate-head',
    );
    assertStage3(
      (await this.git(stage3SourceRoot, ['rev-parse', '--verify', `${this.options.candidateRef}^{commit}`])) ===
        this.options.candidateCommit,
      'candidate-ref',
    );
    assertStage3(
      (await this.git(stage3SourceRoot, ['status', '--porcelain', '--untracked-files=all'])) === '',
      'candidate-dirty',
    );
    const runtime = await this.runtime.runPromise(
      verifyManagedDevelopmentRuntimeForSourceCheckout(stage3SourceRoot, this.options.candidateCommit),
    );
    const resolved = await this.runtime.runPromise(
      resolveManagedDevelopmentExecutableForSource(this.options.candidateCommit),
    );
    assertStage3(resolved.executable === this.options.candidateExecutable, 'candidate-executable');
    assertStage3(runtime.executableSha256 === this.options.candidateExecutableSha256, 'candidate-executable-hash');
    assertStage3(JSON.stringify(runtime) === JSON.stringify(resolved.evidence), 'candidate-runtime-change');
    const outputParent = await this.runtime.runPromise(fs.realPath(path.dirname(this.options.output)));
    assertStage3(
      path.join(outputParent, path.basename(this.options.output)) === this.options.output,
      'output-canonical',
    );
    assertStage3(!(await this.runtime.runPromise(fs.exists(this.options.output))), 'output-exists');
    const outputParentGit = await this.command(
      'git',
      ['-C', outputParent, 'rev-parse', '--show-toplevel'],
      this.outputParentGitEnvironment(system),
      true,
      true,
    );
    assertStage3(
      classifyStage3OutputParentGitResult(outputParentGit, await this.inspectOutputParentMarkers(outputParent)) ===
        'outside-worktree',
      'output-must-be-outside-source-control',
    );
    this.forbidden.add(stage3SourceRoot).add(system.homeDirectory).add(resolved.installRoot);
    return runtime;
  }

  async setup() {
    const {fs, path, system} = await this.services();
    this.root = await this.runtime.runPromise(fs.makeTempDirectory({prefix: 'threadnote-stage3-'}));
    await this.runtime.runPromise(fs.chmod(this.root, 0o700));
    this.home = path.join(this.root, 'home');
    await this.runtime.runPromise(fs.makeDirectory(this.home, {mode: 0o700}));
    const inherited = system.environment();
    this.environment = {};
    for (const key of ['PATH', 'LANG', 'LC_ALL']) {
      const value = inherited[key];
      if (value !== undefined) this.environment[key] = value;
    }
    Object.assign(this.environment, {
      HOME: path.join(this.root, 'process-home'),
      TMPDIR: path.join(this.root, 'tmp'),
      XDG_CONFIG_HOME: path.join(this.root, 'config'),
      XDG_CACHE_HOME: path.join(this.root, 'cache'),
      XDG_DATA_HOME: path.join(this.root, 'data'),
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      THREADNOTE_HOME: this.home,
      THREADNOTE_MANIFEST: path.join(this.home, 'seed-manifest.yaml'),
      THREADNOTE_ACCOUNT: 'local',
      THREADNOTE_USER: 'stage3-gate',
      THREADNOTE_TELEMETRY: '0',
      THREADNOTE_MCP_TOOLSET: 'core',
      THREADNOTE_CODE_GRAPH_PREWARM: '0',
    });
    for (const key of ['HOME', 'TMPDIR', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME']) {
      await this.runtime.runPromise(fs.makeDirectory(this.environment[key], {mode: 0o700}));
    }
    await this.write(this.environment.THREADNOTE_MANIFEST, 'version: 1\nprojects: []\n');
    this.forbidden.add(this.root).add(this.home);
    const repository = path.join(this.root, 'repository');
    await this.runtime.runPromise(fs.makeDirectory(repository, {mode: 0o700}));
    await this.git(repository, ['init', '-q']);
    await this.write(
      path.join(repository, 'package.json'),
      '{"name":"stage3-fixture","private":true,"type":"module"}\n',
    );
    await this.write(path.join(repository, 'graph.ts'), stage3Fixture('f0'));
    await this.commit(repository);
    for (const label of ['a', 'b', 'c']) {
      const cwd = path.join(this.root, `worktree-${label}`);
      await this.git(repository, ['worktree', 'add', '--detach', cwd, 'HEAD']);
      this.worktrees.push(await this.worktree(cwd));
    }
    assertStage3(
      new Set(EffectArray.map(this.worktrees, tree => tree.identity.checkoutId)).size === 1,
      'linked-checkout',
    );
    assertStage3(
      new Set(EffectArray.map(this.worktrees, tree => tree.identity.worktreeId)).size === 3,
      'linked-worktree-identity',
    );
    for (const tree of this.worktrees)
      await this.command(
        this.options.candidateExecutable,
        ['graph', 'index', '--no-vectors', '--cwd', tree.cwd],
        this.environment,
      );
  }

  async worktree(cwd: string) {
    const {path} = await this.services();
    const identity = await this.runtime.runPromise(resolveRepositoryIdentity(cwd));
    const layout = codeGraphLayout(path, this.home, identity.checkoutId, identity.worktreeId);
    this.forbidden.add(cwd).add(identity.checkoutId).add(identity.worktreeId).add(identity.repositoryId);
    return {
      cwd,
      identity,
      layout,
      demandPath: codeGraphRefreshDemandPath(path, this.home, identity.checkoutId, identity.worktreeId),
      spawnLockPath: codeGraphWorktreeSpawnLockPath(path, this.home, identity.checkoutId, identity.worktreeId),
    };
  }

  async write(path: string, value: string) {
    const {fs} = await this.services();
    await this.runtime.runPromise(fs.writeFileString(path, value, {mode: 0o600}));
  }

  async change(tree: Stage3Worktree, target: string, commit = false) {
    const {path} = await this.services();
    const content = stage3Fixture(target);
    this.forbidden.add(content).add(sha256HexSync(content));
    await this.write(path.join(tree.cwd, 'graph.ts'), content);
    if (commit) await this.commit(tree.cwd);
  }

  async commit(cwd: string) {
    await this.git(cwd, ['add', '.']);
    await this.git(cwd, [
      '-c',
      'user.name=Stage3 Gate',
      '-c',
      'user.email=gate@threadnote.local',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-qm',
      'gate fixture',
    ]);
  }

  async host(label: 'a' | 'b') {
    const transport = new StdioClientTransport({
      command: this.options.candidateExecutable,
      args: ['mcp-server'],
      cwd: this.root,
      env: this.environment,
      stderr: 'ignore',
    });
    const client = new Client({name: 'threadnote-stage3-gate', version: '1'});
    try {
      await client.connect(transport, {timeout: 30_000});
      assertStage3(transport.pid !== null, 'mcp-process');
      const host: Stage3Host = {label, transport, client, processId: transport.pid, dead: false};
      this.hosts.push(host);
      this.forbidden.add(String(host.processId));
      return host;
    } catch (cause) {
      await transport.close();
      throw cause;
    }
  }

  async call(host: Stage3Host, tree: Stage3Worktree, arguments_: Record<string, unknown>) {
    const response = await host.client.callTool(
      {
        name: 'inspect_code_graph',
        arguments: {callerCwd: tree.cwd, ...arguments_, responseFormat: 'dual'},
      },
      undefined,
      {timeout: 30_000},
    );
    assertStage3(response.isError !== true, 'mcp-tool-error');
    const data = stage3Record(response.structuredContent);
    assertStage3(JSON.stringify(response).length < 128 * 1024, 'mcp-response-bound');
    return data;
  }

  async demand(tree: Stage3Worktree) {
    const {fs} = await this.services();
    if (!(await this.runtime.runPromise(fs.exists(tree.demandPath)))) return undefined;
    const info = await this.runtime.runPromise(fs.stat(tree.demandPath));
    assertStage3(info.type === 'File' && Number(info.size) <= 8192, 'demand-bound');
    const value: unknown = JSON.parse(await this.runtime.runPromise(fs.readFileString(tree.demandPath)));
    const state = Schema.decodeUnknownSync(Demand)(value);
    assertStage3(
      validCodeGraphRefreshDemand(state) &&
        state.checkoutId === tree.identity.checkoutId &&
        state.worktreeId === tree.identity.worktreeId,
      'demand-identity',
    );
    for (const target of [state.active, state.desired]) if (target) this.forbidden.add(target.targetKey);
    return state;
  }

  async rawStatuses(tree: Stage3Worktree) {
    return EffectArray.filter(
      await this.runtime.runPromise(readCodeGraphBuildStatuses(tree.layout)),
      status => status.identity.worktreeId === tree.identity.worktreeId,
    );
  }

  async statuses(tree: Stage3Worktree) {
    const statuses = await this.rawStatuses(tree);
    assertStage3(
      EffectArray.filter(statuses, status => status.observation.liveness === 'active').length <= 1,
      'duplicate-active-build',
    );
    for (const status of statuses) {
      this.history.set(status.buildId, status);
      this.forbidden.add(String(status.owner.processId));
      if (status.request) this.forbidden.add(status.request.key);
    }
    return statuses;
  }

  async lock(tree: Stage3Worktree, mode: 'writer' | 'spawn') {
    const {path, system, fs} = await this.services();
    const ordinal = ++this.lockOrdinal;
    const marker = path.join(this.root, `lock-${ordinal}.ready`);
    const releasePath = path.join(this.root, `lock-${ordinal}.release`);
    const process_ = Bun.spawn(
      [
        system.executablePath,
        path.join(stage3SourceRoot, 'scripts/support/code-graph-stage3-lock-child.ts'),
        mode === 'writer' ? tree.layout.databaseWriteLockPath : tree.spawnLockPath,
        marker,
        releasePath,
        ...(mode === 'writer' ? [tree.layout.databasePath] : []),
      ],
      {cwd: stage3SourceRoot, env: this.environment, stdin: 'ignore', stdout: 'ignore', stderr: 'ignore'},
    );
    const lock = {process: process_, releasePath, released: false};
    this.locks.push(lock);
    await this.until(
      async () => {
        assertStage3(process_.exitCode === null, 'lock-helper-exited');
        return (await this.runtime.runPromise(fs.exists(marker))) ? true : undefined;
      },
      'lock-acquisition',
      15_000,
    );
    return lock;
  }

  held(lock: Stage3Lock) {
    assertStage3(!lock.released && lock.process.exitCode === null, 'writer-not-held');
  }

  async release(lock: Stage3Lock) {
    this.held(lock);
    await this.write(lock.releasePath, 'release\n');
    const timeout = setTimeout(() => lock.process.kill('SIGKILL'), 10_000);
    try {
      assertStage3((await lock.process.exited) === 0, 'lock-release');
      lock.released = true;
    } finally {
      clearTimeout(timeout);
    }
  }

  async killHost(host: Stage3Host) {
    const {system} = await this.services();
    assertStage3(!host.dead && host.transport.pid === host.processId, 'mcp-kill-identity');
    system.signalProcess(host.processId, 'SIGKILL');
    await this.until(async () => (!system.isProcessRunning(host.processId) ? true : undefined), 'mcp-kill', 10_000);
    host.dead = true;
    await host.client.close();
  }

  async until<A>(read: () => Promise<A | undefined>, code: string, timeout = STAGE3_DEADLINE): Promise<A> {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const value = await read();
      if (value !== undefined) return value;
      await Bun.sleep(STAGE3_POLL);
    }
    assertStage3(false, code);
  }

  async git(cwd: string, arguments_: readonly string[]) {
    return Effect2.pipe(
      (await this.command('git', ['-C', cwd, ...arguments_], this.root ? this.environment : undefined)).stdout,
      EffectString.trim,
    );
  }

  async inspectOutputParentMarkers(outputParent: string): Promise<Stage3OutputParentMarkerInspection> {
    const {fs, path} = await this.services();
    let current = outputParent;
    while (true) {
      const inspection = await this.runtime.runPromise(stage3MarkerInspection(fs, path.join(current, '.git')));
      if (inspection !== 'clear') return inspection;
      const parent = path.dirname(current);
      if (parent === current) return 'clear';
      current = parent;
    }
  }

  outputParentGitEnvironment(system: {environment(): Record<string, string | undefined>}) {
    const inherited = system.environment();
    return {
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0',
      HOME: '/nonexistent',
      LANG: 'C',
      LC_ALL: 'C',
      PATH: inherited.PATH ?? '/usr/bin:/bin',
    };
  }

  async command(
    executable: string,
    arguments_: readonly string[],
    environment?: Record<string, string>,
    allowFailure = false,
    captureStderr = false,
  ) {
    const child = Bun.spawn([executable, ...arguments_], {
      env: environment,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: captureStderr ? 'pipe' : 'ignore',
    });
    const output = new Response(child.stdout).text();
    const errorOutput = captureStderr ? new Response(child.stderr).text() : Promise.resolve('');
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, STAGE3_DEADLINE);
    try {
      const exitCode = await child.exited;
      const stdout = await output;
      const stderr = await errorOutput;
      assertStage3(stdout.length <= 1024 * 1024, 'command-output-bound');
      assertStage3(stderr.length <= 1024 * 1024, 'command-output-bound');
      assertStage3(allowFailure || exitCode === 0, 'command-failed');
      return {exitCode, stdout, stderr, timedOut};
    } finally {
      clearTimeout(timeout);
    }
  }

  async cleanup() {
    const {fs, system} = await this.services();
    let cleanupFailed = false;
    const attempt = async <A>(action: () => Promise<A> | A): Promise<A | undefined> => {
      try {
        return await action();
      } catch {
        cleanupFailed = true;
        return undefined;
      }
    };
    // Stop request producers before discovering and terminating their detached graph children.
    for (const host of this.hosts) {
      if (host.dead) continue;
      const running = await attempt(() => system.isProcessRunning(host.processId));
      if (running) {
        const signaled = await attempt(() => {
          system.signalProcess(host.processId, 'SIGKILL');
          return true;
        });
        if (signaled !== undefined)
          await attempt(() =>
            this.until(
              async () => (!system.isProcessRunning(host.processId) ? true : undefined),
              'mcp-cleanup',
              10_000,
            ),
          );
      }
      host.dead = true;
      await attempt(() => host.client.close());
    }
    for (const tree of this.worktrees) {
      const statuses = await attempt(() => this.rawStatuses(tree));
      if (statuses === undefined) continue;
      for (const status of statuses) {
        const running = await attempt(() => system.isProcessRunning(status.owner.processId));
        if (!running) continue;
        const identity = await attempt(() =>
          this.runtime.runPromise(
            system.canonicalProcessStartIdentity?.(status.owner.processId) ??
              system.processStartIdentity(status.owner.processId),
          ),
        );
        if (identity === undefined || !processInstanceIdentityMatches(status.owner.processStartIdentity, identity)) {
          cleanupFailed = true;
          continue;
        }
        const signaled = await attempt(() => {
          system.signalProcess(status.owner.processId, 'SIGKILL');
          return true;
        });
        if (signaled !== undefined)
          await attempt(() =>
            this.until(
              async () => (!system.isProcessRunning(status.owner.processId) ? true : undefined),
              'child-cleanup',
              10_000,
            ),
          );
      }
    }
    for (const lock of this.locks)
      if (lock.process.exitCode === null) {
        const killed = await attempt(() => {
          lock.process.kill('SIGKILL');
          return true;
        });
        if (killed !== undefined) await attempt(() => lock.process.exited);
      }
    if (this.root && !cleanupFailed)
      await attempt(() => this.runtime.runPromise(fs.remove(this.root, {recursive: true})));
    assertStage3(!cleanupFailed, 'cleanup-incomplete');
  }
}

export function stage3Fixture(target: string) {
  assertStage3(/^[a-z0-9-]+$/u.test(target), 'fixture-target');
  return `export function stage3Leaf(value: number) { return value + 1; }\nexport function stage3Entry(value: number) { return stage3Leaf(value); }\nexport const stage3Target_${Effect2.pipe(target, EffectString.replaceAll('-', '_'))} = '${target}';\n`;
}
