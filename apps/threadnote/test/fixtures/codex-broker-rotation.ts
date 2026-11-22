import {spawn, spawnSync} from '@threadnote/testing/node-child-process';
import {mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile} from '@threadnote/testing/node-fs-promises';
import {createServer} from '@threadnote/testing/node-http';
import {createServer as createTcpServer} from '@threadnote/testing/node-net';
import {tmpdir} from '@threadnote/testing/node-os';
import {join} from '@threadnote/testing/node-path';
import {Array as EffectArray, Option, Predicate, Record as EffectRecord, String as EffectString} from 'effect';

const fixtureProgram = String.raw`
import {appendFileSync, existsSync, writeSync} from 'node:fs';
import {createInterface} from 'node:readline';
import {join} from 'node:path';

const [root, name] = process.argv.slice(2);
const release = process.env.PROBE_RELEASE;
const identity = {pid: process.pid, release};
const send = (id, result) => writeSync(1, JSON.stringify({jsonrpc: '2.0', id, result})+'\n');
const record = (event, token) => appendFileSync(join(root, 'events'), JSON.stringify({...identity, name, event, token})+'\n');
record('launch');
const incoming = createInterface({input: process.stdin});
let closed = false;
incoming.on('close', () => { closed = true; });

for await (const line of incoming) {
  const {id, method, params} = JSON.parse(line);
  if (id === undefined) continue;
  if (method === 'initialize') {
    send(id, {protocolVersion: params.protocolVersion, capabilities: {tools: {}}, serverInfo: {name, version: '1'}});
  } else if (method === 'tools/list') {
    send(id, {tools: [{name: 'identity', inputSchema: {type: 'object', properties: {token: {type: 'string'}}}}]});
  } else if (method === 'tools/call') {
    const token = params.arguments.token;
    if (token) {
      record('entered', token);
      const deadline = Date.now() + 18000;
      while (!closed && !existsSync(join(root, 'release-'+token)) && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      if (closed) break;
      if (!existsSync(join(root, 'release-'+token))) throw new Error('Held fixture call timed out');
      record('returned', token);
    }
    send(id, {content: [{type: 'text', text: JSON.stringify({...identity, token})}]});
  }
}
`;

const deadlineMs = 7000;

function jsonObject(input: unknown): Record<string, unknown> {
  if (!Predicate.isObject(input)) throw new Error('Expected an object in the probe protocol');
  return input;
}

export async function until<T>(read: () => Promise<T | undefined>, label: string): Promise<T> {
  const end = Date.now() + deadlineMs;
  while (Date.now() < end) {
    const result = await read();
    if (result !== undefined) return result;
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

export function isLive(pid: number): boolean {
  const {stdout} = spawnSync('ps', ['-p', String(pid), '-o', 'pid='], {timeout: 1000, encoding: 'utf8'});
  return EffectString.trim(stdout ?? '') === String(pid);
}

class CodexClient {
  private nextId = 0;
  private failure: Error | undefined;
  private readonly responses = new Map<number, Record<string, unknown>[]>();
  private readonly notifications: Record<string, unknown>[] = [];
  constructor(private readonly write: (message: string) => void) {}

  fail(error: Error) {
    this.failure = error;
  }

  receive(line: string) {
    try {
      const message = jsonObject(JSON.parse(line));
      const id = message.id;
      if (typeof id === 'number') {
        const previous = this.responses.get(id) ?? [];
        previous.push(message);
        this.responses.set(id, previous);
      } else {
        this.notifications.push(message);
      }
    } catch (error) {
      this.fail(new Error('Invalid app-server output', {cause: error}));
    }
  }

  send(method: string, params?: unknown, id?: number) {
    this.write(JSON.stringify({method, params, id}));
  }

  call(method: string, params?: unknown) {
    const id = ++this.nextId;
    this.send(method, params, id);
    return id;
  }

  count(id: number) {
    return this.responses.get(id)?.length ?? 0;
  }

  async reply(id: number, label: string) {
    const message = await until(async () => {
      if (this.failure) throw this.failure;
      return this.responses.get(id)?.[0];
    }, label);
    if (message.error !== undefined) throw new Error(`${label}: ${JSON.stringify(message.error)}`);
    return jsonObject(message.result);
  }

  rpc(method: string, params?: unknown) {
    return this.reply(this.call(method, params), method);
  }

  async initialize() {
    await this.rpc('initialize', {
      clientInfo: {name: 'rotation-probe', version: '1'},
      capabilities: {experimentalApi: true},
    });
    this.send('initialized');
  }

  async start(cwd: string) {
    const result = await this.rpc('thread/start', {
      cwd,
      ephemeral: true,
      approvalPolicy: 'never',
      sandbox: 'read-only',
    });
    const id = jsonObject(result.thread).id;
    if (typeof id !== 'string') throw new Error('Missing started thread identity');
    return id;
  }

  async turn(threadId: string) {
    const result = await this.rpc('turn/start', {threadId, input: [{type: 'text', text: 'End the local probe turn'}]});
    const id = jsonObject(result.turn).id;
    const turn = await until(async () => {
      for (const event of this.notifications) {
        if (event.method !== 'turn/completed') continue;
        const params = jsonObject(event.params);
        const candidate = jsonObject(params.turn);
        if (params.threadId === threadId && candidate.id === id) return candidate;
      }
      return undefined;
    }, 'local mock turn');
    if (turn.status !== 'completed') throw new Error('Local mock turn failed');
  }

  tool(threadId: string, server: string, token?: string) {
    return this.call('mcpServer/tool/call', {threadId, server, tool: 'identity', arguments: {token}});
  }

  async identity(id: number) {
    const result = await this.reply(id, 'MCP tool result');
    if (!EffectArray.isArray(result.content)) throw new Error('Missing tool content');
    const item = jsonObject(result.content[0]);
    if (typeof item.text !== 'string') throw new Error('Missing tool result text');
    const identity = jsonObject(JSON.parse(item.text));
    if (typeof identity.pid !== 'number' || typeof identity.release !== 'string') {
      throw new Error('Missing fixture identity');
    }
    return {pid: identity.pid, release: identity.release, token: identity.token};
  }

  async catalog(threadId: string, serverName: string) {
    const result = await this.rpc('mcpServerStatus/list', {threadId, serverName, detail: 'toolsAndAuthOnly'});
    if (!EffectArray.isArray(result.data)) throw new Error('Missing MCP catalog');
    const row = EffectArray.findFirst(EffectArray.map(result.data, jsonObject), entry => entry.name === serverName);
    return EffectRecord.keys(jsonObject(Option.getOrUndefined(row)?.tools));
  }
}

async function closeChild(child: ReturnType<typeof spawn>) {
  if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return;
  await new Promise<void>((resolve, reject) => {
    const signal = setTimeout(() => child.kill('SIGKILL'), 1000);
    const closed = () => {
      clearTimeout(signal);
      clearTimeout(deadline);
      resolve();
    };
    const deadline = setTimeout(() => {
      child.off('close', closed);
      child.unref();
      child.stdin?.destroy();
      child.stdout?.destroy();
      child.stderr?.destroy();
      reject(new Error(`Owned Codex process ${child.pid} did not close after SIGKILL`));
    }, 2000);
    child.once('close', closed);
    child.stdin?.end();
    child.kill('SIGTERM');
  });
}

export async function withRotationProbe(
  codex: string,
  probe: (fixture: Awaited<ReturnType<typeof openRotationProbe>>) => Promise<void>,
) {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'tn-r-'));
  try {
    const fixture = await openRotationProbe(root, codex);
    const [result] = await Promise.allSettled([probe(fixture)]);
    try {
      await fixture.close();
    } catch (cleanupError) {
      if (result.status === 'rejected') {
        throw new AggregateError([result.reason, cleanupError], 'Codex probe and cleanup both failed', {
          cause: cleanupError,
        });
      }
      throw cleanupError;
    }
    if (result.status === 'rejected') throw result.reason;
  } finally {
    await rm(root, {recursive: true, force: true});
  }
}

async function openRotationProbe(root: string, codex: string) {
  const model = createServer((request, response) => {
    request.resume();
    response.writeHead(200, {'Content-Type': 'text/event-stream'});
    const frame = (status: string, type: string) => ({
      type,
      response: {
        id: 'resp-probe',
        object: 'response',
        status,
        output: [],
        usage: {input_tokens: 0, output_tokens: 0, total_tokens: 0},
      },
    });
    const events = [frame('in_progress', 'response.created'), frame('completed', 'response.completed')];
    response.end(
      EffectArray.join(
        EffectArray.map(events, event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`),
        '',
      ),
    );
  });
  await writeFile(join(root, 'fixture.mjs'), fixtureProgram);
  await new Promise<void>((resolve, reject) => {
    model.once('error', reject);
    model.listen(0, '127.0.0.1', resolve);
  });
  const address = model.address();
  if (address === null || typeof address === 'string') throw new Error('Missing loopback model address');
  const modelPort = address.port;

  const cleanup: Array<() => Promise<void>> = [];
  const checkExited: Array<() => Promise<void>> = [];
  async function profile(name: string) {
    const home = join(root, name);
    const cwd = join(home, 'workspace');
    await mkdir(cwd, {recursive: true});
    const socket = join(home, 'owner.sock');
    const env = {
      HOME: home,
      XDG_RUNTIME_DIR: join(home, 'tmp'),
      CODEX_HOME: home,
      TMPDIR: join(home, 'tmp'),
      PATH: process.env.PATH,
      DO_NOT_TRACK: '1',
      THREADNOTE_TELEMETRY: 'off',
      THREADNOTE_NO_UPDATE_CHECK: '1',
    };
    await mkdir(env.TMPDIR);
    const mcpConfig = (server: string, version: string) => [
      `[mcp_servers.${server}]`,
      `command = ${JSON.stringify(process.execPath)}`,
      `args = ${JSON.stringify([join(root, 'fixture.mjs'), home, server])}`,
      `[mcp_servers.${server}.env]`,
      `PROBE_RELEASE = ${JSON.stringify(version)}`,
    ];
    const config = (release: string, unrelated = 'unrelated') =>
      writeFile(
        join(home, 'config.toml'),
        EffectArray.join(
          [
            'model_provider = "probe"',
            'model = "probe"',
            '[model_providers.probe]',
            'name = "probe"',
            `base_url = "http://127.0.0.1:${modelPort}/v1"`,
            'wire_api = "responses"',
            ...mcpConfig('threadnote', release),
            ...mcpConfig('unrelated', unrelated),
          ],
          '\n',
        ),
      );
    const launch = (...args: string[]) => {
      const child = spawn(codex, ['app-server', ...args], {cwd, env, stdio: ['pipe', 'pipe', 'pipe']});
      let stderr = '';
      let spawnError: Error | undefined;
      let stdinError: Error | undefined;
      child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
        stderr = EffectString.slice(-2000)(stderr + chunk);
      });
      child.on('error', error => {
        spawnError = error;
      });
      child.stdin.on('error', error => {
        stdinError = error;
      });
      cleanup.push(() => closeChild(child));
      const failed = () => spawnError !== undefined || child.exitCode !== null || child.signalCode !== null;
      const diagnostic = (message: string) => {
        const detail = EffectString.trim(stderr);
        return new Error(
          `${message} [codex app-server ${EffectArray.join(args, ' ')}, exit=${child.exitCode}, signal=${child.signalCode}]${detail ? '\n' + detail : ''}`,
          {cause: spawnError ?? stdinError},
        );
      };
      return {child, diagnostic, failed};
    };
    const start = (...args: string[]) => {
      const {child, diagnostic} = launch(...args);
      const client = new CodexClient(message => child.stdin.write(message + '\n'));
      child.on('close', () => client.fail(diagnostic('Stdio client exited')));
      let buffer = '';
      child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
        const lines = EffectString.split(buffer + chunk, '\n');
        buffer = lines.pop() ?? '';
        EffectArray.forEach(lines, line => client.receive(line));
      });
      return client;
    };
    const proxy = async (endpoint?: string) => {
      // Codex forwards raw bytes to the Unix control socket. Bridge the proxy's stdio
      // into a loopback stream so the standard WebSocket client can frame the RPCs.
      const {child, diagnostic, failed} =
        endpoint === undefined ? launch('proxy') : launch('proxy', '--sock', endpoint);
      const bridge = createTcpServer();
      let destroySocket: (() => void) | undefined;
      cleanup.push(
        () =>
          new Promise<void>(resolve => {
            destroySocket?.();
            bridge.close(() => resolve());
          }),
      );
      await new Promise<void>((resolve, reject) => {
        bridge.once('error', reject);
        bridge.listen(0, '127.0.0.1', resolve);
      });
      const port = bridge.address();
      if (port === null || typeof port === 'string') throw new Error('Missing loopback bridge address');
      bridge.once('connection', socket => {
        destroySocket = () => socket.destroy();
        bridge.close();
        if (failed()) {
          socket.destroy();
          return;
        }
        socket.on('error', () => socket.destroy());
        child.stdout.pipe(socket);
        socket.pipe(child.stdin);
        child.once('close', () => socket.destroy());
      });
      const websocket = new WebSocket(`ws://127.0.0.1:${port.port}`);
      const client = new CodexClient(message => websocket.send(message));
      cleanup.push(async () => websocket.close());
      websocket.addEventListener('message', event => {
        if (typeof event.data === 'string') client.receive(event.data);
      });
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(diagnostic('Timed out opening WebSocket control channel')), deadlineMs);
        const complete = (error?: Error) => {
          clearTimeout(timer);
          if (error) reject(error);
          else resolve();
        };
        websocket.addEventListener('open', () => complete(), {once: true});
        websocket.addEventListener('error', () => complete(diagnostic('Unavailable WebSocket control channel')), {
          once: true,
        });
        websocket.addEventListener(
          'close',
          () => {
            const error = diagnostic('WebSocket control channel closed');
            client.fail(error);
            complete(error);
          },
          {once: true},
        );
      });
      return client;
    };
    const events = async () => {
      const data = await readFile(join(home, 'events'), 'utf8').catch(() => '');
      const lines = EffectArray.filter(EffectString.split(EffectString.trim(data), '\n'), Boolean);
      return EffectArray.map(lines, line => jsonObject(JSON.parse(line)));
    };
    const listen = async () => {
      const {child: owner, diagnostic, failed} = launch('--listen', `unix://${socket}`);
      await until(async () => {
        if (failed()) throw diagnostic('Unix app-server exited during startup');
        return (await stat(socket).catch(() => undefined))?.isSocket() || undefined;
      }, 'owner socket');
      return owner;
    };
    const serveIncompatibleProtocol = async () => {
      const server = createServer();
      let rejectedUpgrade = false;
      let destroyClient: (() => void) | undefined;
      server.on('upgrade', (request, client) => {
        destroyClient = () => client.destroy();
        client.on('error', () => client.destroy());
        client.end('HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\nContent-Length: 0\r\n\r\n', () => {
          rejectedUpgrade = EffectString.toLowerCase(request.headers.upgrade ?? '') === 'websocket';
        });
      });
      cleanup.push(
        () =>
          new Promise<void>(resolve => {
            destroyClient?.();
            server.closeAllConnections();
            server.close(() => resolve());
          }),
      );
      const endpoint = join(home, 'incompatible.sock');
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(endpoint, resolve);
      });
      return {
        endpoint,
        witness: () => until(async () => rejectedUpgrade || undefined, 'incompatible endpoint to reject the upgrade'),
      };
    };
    checkExited.push(async () => {
      const launches = EffectArray.filter(await events(), event => event.event === 'launch');
      const pids = EffectArray.map(launches, event => event.pid);
      await until(
        async () => EffectArray.every(pids, pid => typeof pid === 'number' && !isLive(pid)) || undefined,
        'owned fixture processes to exit',
      );
    });
    return {
      cwd,
      socket,
      serveIncompatibleProtocol,
      config,
      start,
      listen,
      proxy,
      events,
      release: (token: string) => writeFile(join(home, `release-${token}`), ''),
    };
  }
  return {
    profile,
    close: async () => {
      model.closeAllConnections();
      const stopped = await Promise.allSettled([
        ...EffectArray.map(cleanup, close => close()),
        new Promise<void>((resolve, reject) => model.close(error => (error ? reject(error) : resolve()))),
      ]);
      const checked = await Promise.allSettled(EffectArray.map(checkExited, check => check()));
      const failures = EffectArray.flatMap([...stopped, ...checked], result =>
        result.status === 'rejected' ? [result.reason] : [],
      );
      if (failures.length > 0) throw new AggregateError(failures, 'Could not clean up the isolated Codex probe');
    },
  };
}
