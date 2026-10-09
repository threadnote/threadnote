import {execFile, type ChildProcess} from '@threadnote/testing/node-child-process';
import {mkdir, mkdtemp, readFile, rm, symlink, writeFile} from '@threadnote/testing/node-fs-promises';
import {tmpdir} from '@threadnote/testing/node-os';
import {join} from '@threadnote/testing/node-path';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {Database} from 'bun:sqlite';
import {describe, expect, it} from 'vitest';

const fixture = 'apps/threadnote/test/integrations/coordinator-process-fixture.ts';
interface WorkerEvent {
  readonly kind: 'spawn' | 'start' | 'end' | 'credential' | 'list' | 'hidden-endpoint';
  readonly pid: number;
  readonly at: number;
  readonly credentialHash?: string;
}
interface ClientReply {
  readonly elapsedMs: number;
  readonly result?: {readonly sourceId: string; readonly syncedDocuments: readonly string[]};
}

function expectSequentialRuns(events: readonly WorkerEvent[]) {
  let active: number | undefined;
  for (const event of events) {
    if (event.kind === 'start') {
      expect(active, 'The same source acquired two simultaneous writers').toBeUndefined();
      active = event.pid;
    } else if (event.kind === 'end') {
      expect(active).toBe(event.pid);
      active = undefined;
    }
  }
}

function persistedJob(home: string) {
  const database = new Database(join(home, 'threadnote', 'integration-coordinator', 'jobs.sqlite'), {readonly: true});
  try {
    return database.query<{generation: number; state: string}, []>('SELECT generation,state FROM source_jobs').all();
  } finally {
    database.close();
  }
}

const pause = (milliseconds: number) => new Promise(resolve => setTimeout(resolve, milliseconds));
function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
async function until<A>(read: () => Promise<A | undefined>, message: string, timeoutMs = 8_000): Promise<A> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) return value;
    await pause(25);
  }
  throw new Error(message);
}

async function withProcesses<A>(
  run: (harness: {
    readonly home: string;
    readonly alias: string;
    readonly events: () => Promise<readonly WorkerEvent[]>;
    readonly client: (
      action: string,
      home?: string,
      environment?: Readonly<Record<string, string | undefined>>,
    ) => Promise<ClientReply>;
  }) => Promise<A>,
) {
  const root = await mkdtemp(join(tmpdir(), 'threadnote-coordinator-process-'));
  const home = join(root, 'home');
  const alias = join(root, 'home-alias');
  const clients = new Set<ChildProcess>();
  const events = async (): Promise<readonly WorkerEvent[]> => {
    const content = await readFile(join(home, 'events.jsonl'), 'utf8').catch(() => '');
    return content
      .trim()
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line) as WorkerEvent);
  };
  await mkdir(home, {recursive: true});
  await symlink(home, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const client = (
    action: string,
    requestedHome = home,
    environment: Readonly<Record<string, string | undefined>> = {},
  ) =>
    new Promise<ClientReply>((resolve, reject) => {
      const child = execFile(
        process.execPath,
        [fixture, action, requestedHome],
        {timeout: 12_000, maxBuffer: 64 * 1024, env: {...process.env, THREADNOTE_HOME: home, ...environment}},
        (error, stdout, stderr) => {
          clients.delete(child);
          if (error) reject(new Error(`${action} client failed: ${stderr || error.message}`));
          else resolve(JSON.parse(stdout.trim()) as ClientReply);
        },
      );
      clients.add(child);
    });
  try {
    return await run({home, alias, events, client});
  } finally {
    for (const child of clients) child.kill('SIGKILL');
    for (const event of await events()) {
      if (event.kind !== 'spawn' || !alive(event.pid)) continue;
      try {
        process.kill(event.pid, 'SIGKILL');
      } catch {
        // A worker can complete its idle shutdown during cleanup.
      }
    }
    await Promise.all([...clients].map(child => new Promise(resolve => child.once('exit', resolve))));
    await rm(root, {force: true, recursive: true});
  }
}

describe('integration coordinator process composition', () => {
  it('distinguishes safe inventory, worker-launch, and startup-deadline failures', async () => {
    await withProcesses(async ({client, events}) => {
      for (const [action, message] of [
        ['inventory-failure-sync', 'failed during source inventory'],
        ['failed-launch-sync', 'failed during worker launch'],
        ['silent-launch-sync', 'did not publish a valid endpoint before its startup deadline'],
      ]) {
        const failure = await client(action).then(
          () => undefined,
          error => error as Error,
        );
        expect(failure?.message).toContain(message);
        expect(failure?.message).not.toContain('synthetic-private');
      }
      expect(await events()).toEqual([]);
    });
  });

  it('distinguishes a discoverable worker that rejects requests from a missing endpoint', async () => {
    await withProcesses(async ({home, client, events}) => {
      await client('refresh');
      await until(async () => (await events()).find(event => event.kind === 'start'), 'Provider did not start');
      const endpointPath = join(home, 'threadnote', 'integration-coordinator', 'endpoint.json');
      const original = JSON.parse(await readFile(endpointPath, 'utf8')) as {port: number; pid: number};
      const proxy = Bun.serve({hostname: '127.0.0.1', port: 0, fetch: () => new Response(null, {status: 409})});
      try {
        await writeFile(endpointPath, JSON.stringify({...original, port: proxy.port}));
        await expect(client('silent-launch-sync')).rejects.toThrow(
          'did not accept requests before its startup deadline',
        );
      } finally {
        await writeFile(endpointPath, JSON.stringify(original));
        await proxy.stop(true);
      }
    });
  });

  it('shares one canonical-home worker across CLI clients and returns recall demand before provider IO', async () => {
    await withProcesses(async ({home, alias, events, client}) => {
      await Promise.all([client('refresh'), client('refresh', alias)]);
      const start = await until(
        async () => (await events()).find(event => event.kind === 'start'),
        'Provider did not start',
      );
      const warm = await client('refresh', alias);
      expect(warm.elapsedMs).toBeLessThan(800);
      await until(
        async () =>
          (await events())
            .filter(event => event.kind === 'spawn' && event.pid !== start.pid)
            .every(event => !alive(event.pid))
            ? true
            : undefined,
        'Cold-start contender did not exit promptly after discovering the healthy worker',
      );
      expect((await events()).filter(event => event.kind === 'end')).toEqual([]);
      expect(await readFile(join(home, 'snapshot.txt'), 'utf8').catch(() => undefined)).toBeUndefined();
      const endpoint = JSON.parse(
        await readFile(join(home, 'threadnote', 'integration-coordinator', 'endpoint.json'), 'utf8'),
      ) as {port: number; token: string};
      const url = `http://127.0.0.1:${endpoint.port}/v1/bindings`;
      const headers = {authorization: `Bearer ${endpoint.token}`, 'content-type': 'application/json'};
      expect(
        (await fetch(url, {method: 'POST', headers: {'content-type': 'application/json'}, body: '{}'})).status,
      ).toBe(403);
      expect(
        (await fetch(url, {method: 'POST', headers: {...headers, origin: 'http://example.invalid'}, body: '{}'}))
          .status,
      ).toBe(403);
      expect((await fetch(url, {method: 'POST', headers, body: '{'})).status).toBe(409);
      expect(
        (
          await fetch(url, {
            method: 'POST',
            headers,
            body: JSON.stringify({
              config: {
                account: 'local',
                user: 'process-test',
                agentId: 'threadnote',
                manifestPath: join(home, 'seed-manifest.yaml'),
                agentContextHome: join(home, 'other-home'),
              },
              bindings: [],
            }),
          })
        ).status,
      ).toBe(409);

      const sync = client('sync');
      await writeFile(join(home, 'release'), 'release provider');
      const reply = await sync;
      expect(reply.result).toMatchObject({sourceId: 'slow', syncedDocuments: ['synthetic://slow/document']});
      expect(await readFile(join(home, 'snapshot.txt'), 'utf8')).toBe('usable synthetic snapshot');
      expect(new Set((await events()).filter(event => event.kind === 'start').map(event => event.pid))).toEqual(
        new Set([start.pid]),
      );
      expectSequentialRuns(await events());
      await until(async () => (!alive(start.pid) ? true : undefined), 'Worker did not shut down when idle');
    });
  });

  it('recovers durable in-flight demand after SIGKILL without concurrent source writers', async () => {
    await withProcesses(async ({home, events, client}) => {
      await client('refresh');
      const first = await until(
        async () => (await events()).find(event => event.kind === 'start'),
        'First worker did not start',
      );
      const original = persistedJob(home);
      expect(original).toEqual([{generation: 1, state: 'running'}]);
      process.kill(first.pid, 'SIGKILL');
      await until(async () => (!alive(first.pid) ? true : undefined), 'Killed worker remained alive');
      const sync = client('sync');
      const restarted = await until(
        async () => (await events()).find(event => event.kind === 'start' && event.pid !== first.pid),
        'Pending source work did not restart',
      );
      expect(alive(first.pid)).toBe(false);
      expect(alive(restarted.pid)).toBe(true);
      expect(persistedJob(home)).toEqual(original);
      await writeFile(join(home, 'release'), 'release restarted provider');
      expect((await sync).result?.syncedDocuments).toEqual(['synthetic://slow/document']);
      expect((await events()).filter(event => event.kind === 'end').every(event => event.pid === restarted.pid)).toBe(
        true,
      );
      expectSequentialRuns((await events()).filter(event => event.pid !== first.pid));
    });
  });

  it('bounds explicit sync waiting while a provider is blocked', async () => {
    await withProcesses(async ({home, events, client}) => {
      await client('refresh');
      await until(async () => (await events()).find(event => event.kind === 'start'), 'Provider did not start');
      const started = performance.now();
      await expect(client('deadline')).rejects.toThrow(/deadline|timed out|timeout/i);
      expect(performance.now() - started).toBeLessThan(3_000);
      expect((await events()).some(event => event.kind === 'end')).toBe(false);
      await writeFile(join(home, 'release'), 'release after caller deadline');
      expect((await client('sync')).result?.syncedDocuments).toEqual(['synthetic://slow/document']);
    });
  });

  it('uses rotated caller credentials for subsequent work and continuation, and clears omitted bindings', async () => {
    await withProcesses(async ({home, events, client}) => {
      const binding = 'THREADNOTE_SYNTHETIC_CREDENTIAL';
      expect((await client('credential-sync', home, {[binding]: 'synthetic-token-a'})).result?.syncedDocuments).toEqual(
        ['synthetic://credential/document'],
      );
      const initial = (await events()).find(event => event.kind === 'credential');
      expect(initial?.credentialHash).toBe(sha256HexSync('synthetic-token-a'));
      expect((await client('credential-sync', home, {[binding]: 'synthetic-token-b'})).result?.syncedDocuments).toEqual(
        ['synthetic://credential/document'],
      );
      await until(
        async () =>
          (await events()).filter(event => event.credentialHash === sha256HexSync('synthetic-token-b')).length >= 2
            ? true
            : undefined,
        'Rotated credential was not retained for autonomous continuation',
      );
      await expect(client('credential-sync', home, {[binding]: undefined})).rejects.toThrow(/failed/i);
      const observations = (await events()).filter(event => event.kind === 'credential');
      expect(observations.slice(0, 3).map(event => event.credentialHash)).toEqual([
        sha256HexSync('synthetic-token-a'),
        sha256HexSync('synthetic-token-b'),
        sha256HexSync('synthetic-token-b'),
      ]);
      expect(observations.length).toBeGreaterThanOrEqual(4);
      expect(observations.slice(3).every(event => event.credentialHash === 'missing')).toBe(true);
      expect(new Set(observations.map(event => event.pid))).toEqual(new Set([initial?.pid]));
      for (const filename of ['jobs.sqlite', 'jobs.sqlite-wal', 'jobs.sqlite-shm']) {
        const bytes = await readFile(join(home, 'threadnote', 'integration-coordinator', filename)).catch(
          () => undefined,
        );
        for (const value of ['synthetic-token-a', 'synthetic-token-b']) expect(bytes?.includes(value)).not.toBe(true);
      }
    });
  });

  it('surfaces failed or timed-out warm credential handoff before publishing rotated demand', async () => {
    await withProcesses(async ({home, events, client}) => {
      const binding = 'THREADNOTE_SYNTHETIC_CREDENTIAL';
      await client('credential-sync', home, {[binding]: 'synthetic-token-a'});
      const endpointPath = join(home, 'threadnote', 'integration-coordinator', 'endpoint.json');
      const original = JSON.parse(await readFile(endpointPath, 'utf8')) as {port: number; pid: number};
      let delayMs = 0;
      let bindingAttempts = 0;
      const proxy = Bun.serve({
        hostname: '127.0.0.1',
        port: 0,
        fetch: async request => {
          if (new URL(request.url).pathname === '/v1/bindings') bindingAttempts++;
          await pause(delayMs);
          return new Response(null, {status: 409});
        },
      });
      try {
        await writeFile(endpointPath, JSON.stringify({...original, port: proxy.port}));
        for (const delay of [0, 300]) {
          delayMs = delay;
          const attemptsBefore = bindingAttempts;
          const started = performance.now();
          await expect(client('credential-refresh', home, {[binding]: 'synthetic-token-b'})).rejects.toThrow(
            /unavailable|retry/i,
          );
          expect(performance.now() - started).toBeLessThan(2_000);
          expect(bindingAttempts).toBeGreaterThan(attemptsBefore);
          expect(persistedJob(home)).toEqual([{generation: 1, state: 'idle'}]);
        }
        expect(
          (await events()).filter(event => event.kind === 'credential').map(event => event.credentialHash),
        ).toEqual([sha256HexSync('synthetic-token-a')]);
      } finally {
        await writeFile(endpointPath, JSON.stringify(original));
        await proxy.stop(true);
      }
    });
  });

  it('launches a waiting replacement after failed post-enqueue wake and consumes demand after retirement', async () => {
    await withProcesses(async ({home, events, client}) => {
      await client('race-refresh');
      const first = await until(
        async () => (await events()).find(event => event.kind === 'start'),
        'First worker did not start',
      );
      await writeFile(join(home, 'release'), 'finish initial source work');
      await until(
        async () => (await events()).find(event => event.kind === 'end'),
        'Initial source work did not finish',
      );
      await rm(join(home, 'release'));
      await writeFile(join(home, 'source-version'), 'changed-source-fingerprint');
      const endpointPath = join(home, 'threadnote', 'integration-coordinator', 'endpoint.json');
      const original = JSON.parse(await readFile(endpointPath, 'utf8')) as {port: number; pid: number};
      let wakeAttempts = 0;
      const proxy = Bun.serve({
        hostname: '127.0.0.1',
        port: 0,
        fetch: request => {
          if (new URL(request.url).pathname === '/v1/wake') wakeAttempts++;
          return new Response(null, {status: 409});
        },
      });
      try {
        await writeFile(endpointPath, JSON.stringify({...original, port: proxy.port}));
        await client('race-refresh');
        expect(wakeAttempts).toBeGreaterThan(0);
        const replacement = await until(
          async () => (await events()).find(event => event.kind === 'spawn' && event.pid !== first.pid),
          'Accepted demand did not launch a replacement',
        );
        expect(alive(first.pid)).toBe(true);
        expect(alive(replacement.pid)).toBe(true);
        process.kill(first.pid, 'SIGKILL');
        await until(
          async () => (await events()).find(event => event.kind === 'start' && event.pid === replacement.pid),
          'Replacement did not consume accepted demand after the old lock was released',
        );
        await writeFile(join(home, 'release'), 'finish accepted source work');
        await until(
          async () => (await events()).find(event => event.kind === 'end' && event.pid === replacement.pid),
          'Accepted demand did not finish without another client call',
        );
        expect(persistedJob(home)).toEqual([{generation: 2, state: 'idle'}]);
      } finally {
        await proxy.stop(true);
      }
    });
  });

  it('accepts bounded many-source credential batches without enumerating providers in the handoff RPC', async () => {
    await withProcesses(async ({home, events, client}) => {
      await client('credential-sync', home, {THREADNOTE_SYNTHETIC_CREDENTIAL: 'synthetic-token-a'});
      const endpoint = JSON.parse(
        await readFile(join(home, 'threadnote', 'integration-coordinator', 'endpoint.json'), 'utf8'),
      ) as {home: string; port: number; token: string; pid: number};
      const before = (await events()).filter(event => event.kind === 'list' && event.pid === endpoint.pid).length;
      const bindings = Array.from({length: 129}, (_, index) => ({
        descriptor: {
          sourceId: `credential-${index}`,
          provider: 'synthetic',
          accountKey: sha256HexSync('synthetic-token-a'),
          fingerprint: 'credential-fingerprint',
          refreshIntervalMs: 60_000,
          credentialEnv: 'THREADNOTE_SYNTHETIC_CREDENTIAL',
        },
        values: {THREADNOTE_SYNTHETIC_CREDENTIAL: 'synthetic-token-a'},
      }));
      for (let offset = 0; offset < bindings.length; offset += 64) {
        const batch = bindings.slice(offset, offset + 64);
        const response = await fetch(`http://127.0.0.1:${endpoint.port}/v1/bindings`, {
          method: 'POST',
          headers: {authorization: `Bearer ${endpoint.token}`, 'content-type': 'application/json'},
          body: JSON.stringify({
            config: {
              account: 'local',
              user: 'process-test',
              agentId: 'threadnote',
              agentContextHome: endpoint.home,
              manifestPath: join(home, 'seed-manifest.yaml'),
            },
            bindings: batch,
          }),
        });
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ok: true, accepted: batch.length});
      }
      expect((await events()).filter(event => event.kind === 'list' && event.pid === endpoint.pid)).toHaveLength(
        before,
      );
    });
  });

  it('forwards cold caller credentials when a different worker appears before the post-enqueue endpoint read', async () => {
    await withProcesses(async ({home, events, client}) => {
      const binding = 'THREADNOTE_SYNTHETIC_CREDENTIAL';
      await client('credential-sync', home, {[binding]: 'synthetic-token-a'});
      const owner = (await events()).find(event => event.kind === 'credential');
      expect(owner?.credentialHash).toBe(sha256HexSync('synthetic-token-a'));
      await client('credential-cold-refresh', home, {[binding]: 'synthetic-token-b'});
      expect((await events()).filter(event => event.kind === 'hidden-endpoint')).toHaveLength(1);
      await until(
        async () =>
          (await events()).some(
            event => event.kind === 'credential' && event.credentialHash === sha256HexSync('synthetic-token-b'),
          )
            ? true
            : undefined,
        'Accepted cold caller demand did not receive its own credential without another request',
      );
      const contender = await until(
        async () => (await events()).find(event => event.kind === 'spawn' && event.pid !== owner?.pid),
        'Cold caller did not preserve its credential-carrying contender',
      );
      await until(
        async () => (!alive(contender.pid) ? true : undefined),
        'Credential-carrying contender did not exit after forwarding to the elected worker',
      );
      expect(alive(owner!.pid)).toBe(true);
      expect(new Set((await events()).filter(event => event.kind === 'credential').map(event => event.pid))).toEqual(
        new Set([owner?.pid]),
      );
    });
  });
});
