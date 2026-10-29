import {Array as EffectArray, Option as EffectOption} from 'effect';
import {TestError} from '@threadnote/testing/test-error';
import {access, mkdir, mkdtemp, rm} from '@threadnote/testing/node-fs-promises';
import {tmpdir} from '@threadnote/testing/node-os';
import {join} from '@threadnote/testing/node-path';
import {execFile} from '@threadnote/testing/node-child-process';
import {promisify} from '@threadnote/testing/node-util';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {MCP_PROCESS_LIFECYCLE_PROBE_ENV} from '@threadnote/threadnote/constants';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

const execute = promisify(execFile);
const root = process.cwd();
const cli = join(root, 'dist', process.platform === 'win32' ? 'threadnote.exe' : 'threadnote');
const lifecycleDeadlineMilliseconds = 15_000;
let home: string;
let temporaryRoot: string;
let userHome: string;

beforeEach(async () => {
  temporaryRoot = await mkdtemp(join(tmpdir(), 'threadnote-process-lifecycle-e2e-'));
  home = join(temporaryRoot, 'threadnote-home');
  userHome = join(temporaryRoot, 'user-home');
  await mkdir(userHome, {recursive: true});
});

afterEach(async () => {
  await rm(temporaryRoot, {force: true, recursive: true});
});

describe('packaged stdio process lifecycle', () => {
  it('exits the MCP server and its real worker when the client closes', async () => {
    const lifecycle = await startLifecycleMcpClient();
    expect(await pathExists(join(home, 'models', 'selection.json'))).toBe(false);
    try {
      await lifecycle.client.close();
      await expectProcessesToExit([lifecycle.mcpProcessId, lifecycle.workerProcessId]);
    } finally {
      await terminateProcesses([lifecycle.mcpProcessId, lifecycle.workerProcessId]);
    }
  });

  it('exits the real worker when the MCP parent is killed', async () => {
    const lifecycle = await startLifecycleMcpClient();
    expect(await pathExists(join(home, 'models', 'selection.json'))).toBe(false);
    try {
      process.kill(lifecycle.mcpProcessId, 'SIGKILL');
      await expectProcessesToExit([lifecycle.mcpProcessId, lifecycle.workerProcessId]);
    } finally {
      await lifecycle.client.close().catch(() => undefined);
      await terminateProcesses([lifecycle.mcpProcessId, lifecycle.workerProcessId]);
    }
  });
});

interface LifecycleMcpClient {
  readonly client: Client;
  readonly mcpProcessId: number;
  readonly workerProcessId: number;
}

async function startLifecycleMcpClient(): Promise<LifecycleMcpClient> {
  const environment = {...process.env};
  delete environment.THREADNOTE_HOME;
  const transport = new StdioClientTransport({
    args: ['mcp-server', '--home', home],
    command: cli,
    cwd: root,
    env: {
      ...environment,
      HOME: userHome,
      [MCP_PROCESS_LIFECYCLE_PROBE_ENV]: '1',
      THREADNOTE_LOCAL_MODEL_WORKER_IDLE_TIMEOUT_MS: '60000',
      THREADNOTE_MCP_TOOLSET: 'core',
      THREADNOTE_USER: 'e2e-user',
      USERPROFILE: userHome,
    },
    stderr: 'pipe',
  });
  const client = new Client({name: 'threadnote-lifecycle-e2e', version: '4.0.0'});
  try {
    await client.connect(transport);
    const mcpProcessId = transport.pid;
    if (!mcpProcessId) throw TestError.make({message: 'Packaged MCP transport did not expose its process ID.'});
    const workerProcessId = await waitForModelWorker(mcpProcessId);
    return {client, mcpProcessId, workerProcessId};
  } catch (cause) {
    await client.close().catch(() => undefined);
    throw cause;
  }
}

async function waitForModelWorker(parentProcessId: number): Promise<number> {
  const deadline = Date.now() + lifecycleDeadlineMilliseconds;
  while (Date.now() < deadline) {
    const diagnostics = await processDiagnostics();
    const worker = EffectOption.getOrUndefined(
      EffectArray.findFirst(
        diagnostics.processes,
        process =>
          process.parentProcessId === parentProcessId &&
          process.parentRole === 'mcp' &&
          process.role === 'local-model-worker',
      ),
    );
    if (worker) return worker.processId;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw TestError.make({
    message: `Timed out waiting for a real local-model worker below MCP process ${parentProcessId}.`,
  });
}

async function processDiagnostics(): Promise<ProcessDiagnostics> {
  const environment = {...process.env};
  delete environment.THREADNOTE_HOME;
  const result = await execute(cli, ['--home', home, 'processes', '--json'], {
    cwd: root,
    env: {
      ...environment,
      HOME: userHome,
      THREADNOTE_USER: 'e2e-user',
      USERPROFILE: userHome,
    },
    timeout: lifecycleDeadlineMilliseconds,
  });
  const raw: unknown = JSON.parse(
    Effect.pipe(result.stdout, EffectString.trim, EffectString.split('\n')).at(-1) ?? '{"processes":[]}',
  );
  if (!isProcessDiagnostics(raw)) throw TestError.make({message: 'Threadnote returned invalid process diagnostics.'});
  return raw;
}

interface ProcessDiagnostics {
  readonly processes: ReadonlyArray<{
    readonly parentProcessId: number;
    readonly parentRole?: string;
    readonly processId: number;
    readonly role: string;
  }>;
}

function isProcessDiagnostics(value: unknown): value is ProcessDiagnostics {
  if (typeof value !== 'object' || value === null || !('processes' in value) || !EffectArray.isArray(value.processes))
    return false;
  return EffectArray.every(
    value.processes,
    process =>
      typeof process === 'object' &&
      process !== null &&
      'parentProcessId' in process &&
      typeof process.parentProcessId === 'number' &&
      Number.isFinite(process.parentProcessId) &&
      (!('parentRole' in process) || process.parentRole === undefined || typeof process.parentRole === 'string') &&
      'processId' in process &&
      typeof process.processId === 'number' &&
      Number.isFinite(process.processId) &&
      'role' in process &&
      typeof process.role === 'string',
  );
}

async function expectProcessesToExit(processIds: readonly number[]): Promise<void> {
  const deadline = Date.now() + lifecycleDeadlineMilliseconds;
  while (Date.now() < deadline) {
    if (EffectArray.every(await Promise.all(EffectArray.map(processIds, isProcessRunning)), running => !running))
      return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw TestError.make({
    message: `Threadnote processes did not exit within ${lifecycleDeadlineMilliseconds} ms: ${EffectArray.join(
      EffectArray.map(processIds, item => (item === null || item === undefined ? '' : String(item))),
      ', ',
    )}`,
  });
}

async function isProcessRunning(processId: number): Promise<boolean> {
  try {
    process.kill(processId, 0);
  } catch (cause: unknown) {
    return !(
      typeof cause === 'object' &&
      cause !== null &&
      'code' in cause &&
      (cause as {readonly code?: unknown}).code === 'ESRCH'
    );
  }
  if (process.platform === 'win32') return true;
  try {
    const result = await execute('ps', ['-o', 'stat=', '-p', String(processId)], {
      timeout: 5_000,
    });
    const state = Effect.pipe(result.stdout, EffectString.trim);
    return state.length > 0 && !Effect.pipe(state, EffectString.startsWith('Z'));
  } catch {
    return false;
  }
}

async function terminateProcesses(processIds: readonly number[]): Promise<void> {
  for (const processId of processIds) {
    if (!(await isProcessRunning(processId))) continue;
    try {
      process.kill(processId, 'SIGKILL');
    } catch {
      // Best-effort cleanup after a failed assertion.
    }
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
