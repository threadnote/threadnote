// Test-only Bun preload: substitute external I/O while the compiled application remains intact.
// oxlint-disable-next-line effecttsgo/node-builtin-import -- Compiled-runtime preloads cannot resolve workspace test aliases; this is the fixture's native filesystem boundary.
import {appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
// oxlint-disable-next-line effecttsgo/node-builtin-import -- The independently bundled preload needs the native path boundary.
import {join} from 'node:path';
import {Array as EffectArray, pipe} from 'effect';
import * as EffectString from 'effect/String';

const root = process.env.THREADNOTE_E2E_ROOT;
if (!root || process.env.THREADNOTE_HOME !== join(root, 'home') || process.env.HOME !== join(root, 'home'))
  throw new Error('Manager E2E child lost its isolated home.');

const processes = join(root, 'processes');
const processStartIdentity = pid =>
  pipe(
    new TextDecoder().decode(Bun.spawnSync(['/bin/ps', '-p', String(pid), '-o', 'lstart=']).stdout),
    EffectString.trim,
  );
mkdirSync(processes, {recursive: true});
writeFileSync(
  join(processes, `${process.pid}.json`),
  JSON.stringify({
    pid: process.pid,
    ppid: process.ppid,
    home: process.env.HOME,
    processStartIdentity: processStartIdentity(process.pid),
    argv: process.argv,
  }),
);

const nativeFetch = globalThis.fetch;
function ownsCoordinator(url, method, input, init) {
  if (
    url.hostname !== '127.0.0.1' ||
    method !== 'POST' ||
    !EffectArray.contains(
      ['/v1/wake', '/v1/bindings', '/v1/credentials', '/v1/result', '/v1/admit', '/v1/cooldown'],
      url.pathname,
    )
  )
    return false;
  try {
    const endpoint = JSON.parse(
      readFileSync(join(root, 'home/threadnote/integration-coordinator/endpoint.json'), 'utf8'),
    );
    const worker = JSON.parse(readFileSync(join(processes, `${endpoint.pid}.json`), 'utf8'));
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    return (
      endpoint.protocol === 1 &&
      endpoint.home === process.env.THREADNOTE_HOME &&
      url.origin === `http://127.0.0.1:${endpoint.port}` &&
      worker.home === process.env.HOME &&
      worker.argv.includes('--threadnote-integration-sync-worker') &&
      headers.get('authorization') === `Bearer ${endpoint.token}`
    );
  } catch {
    return false;
  }
}

globalThis.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  const method = EffectString.toUpperCase(init?.method ?? (input instanceof Request ? input.method : 'GET'));
  const fixtures = JSON.parse(readFileSync(join(root, 'network.json'), 'utf8'));
  const body = typeof init?.body === 'string' ? init.body : '';
  const route = fixtures.routes.find(
    route =>
      route.origin === url.origin &&
      route.path === url.pathname &&
      (route.method ?? 'GET') === method &&
      (!route.bodyContains || pipe(body, EffectString.includes(route.bodyContains))),
  );
  const allowed = fixtures.localOrigins.includes(url.origin) || ownsCoordinator(url, method, input, init);
  appendFileSync(
    join(root, 'network.jsonl'),
    JSON.stringify({
      pid: process.pid,
      origin: url.origin,
      path: url.pathname,
      method,
      matched: Boolean(route) || allowed,
    }) + '\n',
  );
  if (route) {
    if (route.gate) {
      if (!/^[a-z][a-z0-9.-]{0,63}$/u.test(route.gate)) throw new Error('Invalid fixture response gate.');
      const deadline = Date.now() + 20_000;
      while (!existsSync(join(root, route.gate))) {
        init?.signal?.throwIfAborted();
        if (Date.now() > deadline) throw new Error('Fixture response gate timed out.');
        await Bun.sleep(10);
      }
    }
    const headers = {'content-type': 'application/json', ...route.headers};
    return new Response(JSON.stringify(route.body), {status: route.status ?? 200, headers});
  }
  if (allowed && (url.hostname === '127.0.0.1' || url.hostname === 'localhost')) return nativeFetch(input, init);
  throw new Error(`Unexpected Manager E2E outbound request: ${method} ${url.origin}${url.pathname}`);
};

const nativeSpawn = Bun.spawn;
Bun.spawn = (...args) => {
  const command = EffectArray.isArray(args[0]) ? args[0] : args[0].cmd;
  const options = EffectArray.isArray(args[0]) ? args[1] : args[0];
  const environment = options?.env ?? process.env;
  appendFileSync(
    join(root, 'spawn-attempts.jsonl'),
    JSON.stringify({command, home: environment.HOME, dataHome: environment.THREADNOTE_HOME}) + '\n',
  );
  if (environment.HOME !== join(root, 'home') || environment.THREADNOTE_HOME !== join(root, 'home'))
    throw new Error('Manager E2E subprocess escaped its fixture home.');
  const child = nativeSpawn(...args);
  appendFileSync(
    join(root, 'spawn.jsonl'),
    JSON.stringify({
      pid: child.pid,
      parent: process.pid,
      command,
      home: environment.HOME,
      processStartIdentity: processStartIdentity(child.pid),
    }) + '\n',
  );
  return child;
};
