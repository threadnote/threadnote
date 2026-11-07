import {spawn, spawnSync, type ChildProcess} from '@threadnote/testing/node-child-process';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from '@threadnote/testing/node-fs-promises';
import {tmpdir} from '@threadnote/testing/node-os';
import {join} from '@threadnote/testing/node-path';
import {isJsonObject} from '@threadnote/platform/json';
import {candidateBinary, findExecutable, fixtureEnvironment, repositoryRoot} from './environment.js';
import {Array as EffectArray, pipe} from 'effect';
import * as EffectString from 'effect/String';
import {releaseRoutes} from './releases.js';

export interface NetworkRoute {
  readonly origin: string;
  readonly path: string;
  readonly method?: string;
  readonly bodyContains?: string;
  readonly status?: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body: unknown;
  readonly gate?: string;
}

export function redactManagerLog(text: string): string {
  return pipe(
    text,
    EffectString.replace(/(token=)[^\s&]+/gu, '$1<redacted>'),
    EffectString.replace(/Bearer [^\s"']+/gu, 'Bearer <redacted>'),
  );
}

export class ManagerRuntime {
  readonly expectedRequestErrors: {readonly path: string; readonly error: string}[] = [];
  readonly expectedErrors: {
    readonly path: string;
    readonly status: number;
    readonly error: string;
    readonly code?: string;
    readonly retryAfterMilliseconds?: number;
  }[] = [];
  readonly environment: NodeJS.ProcessEnv;
  readonly home: string;
  readonly manifest: string;
  private manager: ChildProcess | undefined;
  private address = '';
  private logs = '';
  private readonly children = new Set<ChildProcess>();

  private constructor(
    readonly root: string,
    readonly expectedVersion: string,
  ) {
    this.home = join(root, 'home');
    this.manifest = join(root, 'manifest.json');
    this.environment = fixtureEnvironment(root);
  }

  static async create(): Promise<ManagerRuntime> {
    const temporary = await mkdtemp(join(tmpdir(), 'threadnote-manager-e2e-'));
    try {
      const root = await realpath(temporary);
      const manifest: unknown = JSON.parse(await readFile(join(repositoryRoot, 'package.json'), 'utf8'));
      if (!isJsonObject(manifest) || typeof manifest.version !== 'string')
        throw new Error('Expected a versioned workspace manifest.');
      const runtime = new ManagerRuntime(root, manifest.version);
      for (const directory of ['home', 'bin', 'config', 'cache', 'tmp', 'processes'])
        await mkdir(join(root, directory), {recursive: true});
      await writeFile(join(root, 'gitconfig'), '[user]\nname = Manager E2E\nemail = manager-e2e@example.invalid\n');
      await writeFile(runtime.manifest, JSON.stringify({version: 1, projects: []}));
      await symlink(findExecutable('bun'), join(root, 'bin', process.platform === 'win32' ? 'bun.exe' : 'bun'));
      await runtime.setNetwork(releaseRoutes(runtime.expectedVersion));
      return runtime;
    } catch (error) {
      await rm(temporary, {recursive: true, force: true});
      throw error;
    }
  }

  get url(): string {
    if (!this.address) throw new Error('Manager fixture is not running.');
    return this.address;
  }

  get origin(): string {
    return new URL(this.url).origin;
  }

  get token(): string {
    return new URL(this.url).searchParams.get('token') ?? '';
  }

  get output(): string {
    return redactManagerLog(this.logs);
  }

  async setNetwork(routes: readonly NetworkRoute[], localOrigins: readonly string[] = []): Promise<void> {
    await writeFile(join(this.root, 'network.json'), JSON.stringify({routes, localOrigins}));
  }

  async start(mode: 'compiled' | 'source' = 'compiled'): Promise<void> {
    if (this.manager) throw new Error('Stop the owned Manager before restarting it.');
    const before = await readdir(join(this.root, 'processes'));
    await this.cli(['--version']);
    const after = await readdir(join(this.root, 'processes'));
    if (after.length <= before.length)
      throw new Error('The compiled candidate did not activate the E2E isolation preload.');
    const command = mode === 'compiled' ? candidateBinary : findExecutable('bun');
    const args = [
      ...(mode === 'source' ? [join(repositoryRoot, 'apps/threadnote/src/standalone.ts')] : []),
      '--home',
      this.home,
      '--manifest',
      this.manifest,
      'manage',
      '--ui-port',
      '0',
      '--no-open',
    ];
    const child = this.launch(command, args);
    this.manager = child;
    this.address = await new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`Manager startup timed out.\n${this.output}`)), 20_000);
      const consume = (chunk: Buffer) => {
        const match = /Threadnote manager: (http:\/\/127\.0\.0\.1:\d+\/\?token=\S+)/u.exec(chunk.toString());
        if (match?.[1]) {
          clearTimeout(timeout);
          resolve(match[1]);
        }
      };
      child.stdout?.on('data', consume);
      child.stderr?.on('data', consume);
      child.once('error', error => {
        clearTimeout(timeout);
        reject(error);
      });
      child.once('exit', (code, signal) => {
        clearTimeout(timeout);
        reject(new Error(`Manager exited before readiness (${code}, ${signal}).\n${this.output}`));
      });
    });
    const state = await this.api('/api/state');
    await readFile(join(this.root, 'processes', `${child.pid}.json`), 'utf8');
    if (
      !isJsonObject(state.config) ||
      state.config.agentContextHome !== this.home ||
      state.config.user !== 'playwright'
    )
      throw new Error('Manager did not bind to its disposable fixture identity.');
  }

  launch(command: string, args: readonly string[], cwd = this.root): ChildProcess {
    const child = spawn(command, [...args], {cwd, env: this.environment, stdio: ['pipe', 'pipe', 'pipe']});
    this.children.add(child);
    const consume = (chunk: Buffer) => {
      this.logs = pipe(this.logs + chunk.toString(), EffectString.slice(-24_000));
    };
    child.stdout?.on('data', consume);
    child.stderr?.on('data', consume);
    child.once('close', () => this.children.delete(child));
    return child;
  }

  async cli(args: readonly string[], input?: string, timeoutMs = 30_000, cwd = this.root): Promise<string> {
    const child = this.launch(candidateBinary, ['--home', this.home, '--manifest', this.manifest, ...args], cwd);
    return new Promise((resolve, reject) => {
      let output = '';
      const timeout = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error('Fixture CLI timed out.'));
      }, timeoutMs);
      child.stdout?.on('data', (chunk: Buffer) => {
        output += chunk.toString();
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        output += chunk.toString();
      });
      child.once('error', error => {
        clearTimeout(timeout);
        reject(error);
      });
      child.once('exit', code => {
        clearTimeout(timeout);
        if (code === 0) resolve(output);
        else reject(new Error(`Fixture CLI failed (${code}).\n${redactManagerLog(output)}`));
      });
      child.stdin?.end(input);
    });
  }

  async remember(
    text: string,
    topic = 'fixture-memory',
    project = 'manager-e2e',
    kind: 'handoff' | 'durable' = 'handoff',
  ): Promise<string> {
    const output = await this.cli(
      ['remember', '--kind', kind, '--project', project, '--topic', topic, '--stdin'],
      text,
    );
    const uri = /Stored memory: (threadnote:\/\/\S+)/u.exec(output)?.[1];
    if (!uri) throw new Error(`Fixture remember returned no memory URI: ${redactManagerLog(output)}`);
    return uri;
  }

  async api(path: string, body?: Record<string, unknown>): Promise<Record<string, unknown>> {
    const response = await fetch(this.origin + path, {
      method: body ? 'POST' : 'GET',
      headers: {authorization: `Bearer ${this.token}`, 'content-type': 'application/json'},
      ...(body ? {body: JSON.stringify(body)} : {}),
      signal: AbortSignal.timeout(10_000),
    });
    const data: unknown = await response.json();
    if (!response.ok || !isJsonObject(data))
      throw new Error(`Fixture API ${path} failed (${response.status}): ${redactManagerLog(JSON.stringify(data))}`);
    return data;
  }

  async stop(): Promise<void> {
    const manager = this.manager;
    this.manager = undefined;
    if (manager) await stopChild(manager);
  }

  async networkJournal(): Promise<readonly Record<string, unknown>[]> {
    return this.journal('network');
  }

  async journal(name: 'network' | 'spawn-attempts' | 'spawn'): Promise<readonly Record<string, unknown>[]> {
    const text = await readFile(join(this.root, `${name}.jsonl`), 'utf8').catch(() => '');
    return pipe(
      text,
      EffectString.trim,
      EffectString.split('\n'),
      EffectArray.filter(line => line.length > 0),
      EffectArray.map(line => {
        const value: unknown = JSON.parse(line);
        if (!isJsonObject(value)) throw new Error('Invalid fixture request journal.');
        return value;
      }),
    );
  }

  async dispose(): Promise<void> {
    const errors: unknown[] = [];
    try {
      await this.stop().catch(error => {
        errors.push(error);
      });
      for (const child of this.children)
        await stopChild(child).catch(error => {
          errors.push(error);
        });
      const markers: unknown[] = await Promise.all(
        EffectArray.map(await readdir(join(this.root, 'processes')), async name =>
          JSON.parse(await readFile(join(this.root, 'processes', name), 'utf8')),
        ),
      );
      for (const value of [...markers, ...(await this.journal('spawn'))]) {
        if (
          !isJsonObject(value) ||
          typeof value.pid !== 'number' ||
          value.pid === process.pid ||
          value.home !== this.home ||
          typeof value.processStartIdentity !== 'string' ||
          !value.processStartIdentity
        )
          continue;
        const identity = spawnSync('/bin/ps', ['-p', String(value.pid), '-o', 'lstart='], {
          encoding: 'utf8',
          env: this.environment,
        }).stdout;
        if (pipe(identity, EffectString.trim) === value.processStartIdentity) {
          try {
            process.kill(value.pid, 'SIGKILL');
          } catch {
            /* Already stopped. */
          }
          await waitForExit(value.pid);
        }
      }
    } finally {
      await rm(this.root, {recursive: true, force: true});
    }
    if (errors.length) throw new AggregateError(errors, 'Fixture cleanup encountered child shutdown errors.');
  }
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve, reject) => {
    let finalTimeout: ReturnType<typeof setTimeout> | undefined;
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      finalTimeout = setTimeout(
        () => reject(new Error(`Owned fixture child ${child.pid} did not close after SIGKILL.`)),
        1_000,
      );
    }, 5_000);
    child.once('exit', () => {
      clearTimeout(timeout);
      clearTimeout(finalTimeout);
      resolve();
    });
    child.kill('SIGINT');
  });
}

async function waitForExit(pid: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const state = spawnSync('ps', ['-p', String(pid), '-o', 'stat='], {encoding: 'utf8'}).stdout;
    if (!state || pipe(state, EffectString.trim, EffectString.startsWith('Z'))) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`Owned fixture process ${pid} survived cleanup.`);
}
