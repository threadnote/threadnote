import {Array as EffectArray, Option as EffectOption} from 'effect';
import {execFile, type ChildProcess} from '@threadnote/testing/node-child-process';
import {mkdir, mkdtemp, readFile, rm, symlink, writeFile} from '@threadnote/testing/node-fs-promises';
import {writeSync} from '@threadnote/testing/node-fs';
import {tmpdir} from '@threadnote/testing/node-os';
import {join} from '@threadnote/testing/node-path';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {sourceWorkKey} from '@threadnote/integration-runtime/coordinator';
import {Database} from 'bun:sqlite';
import {describe, expect, it} from 'vitest';
import {Schema} from 'effect';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

const fixture = 'apps/threadnote/test/integrations/coordinator-process-fixture.ts';
const JsonRecordSchema = Schema.Record(Schema.String, Schema.Unknown);
const withRest = <const S extends Schema.StructWithRest.Objects>(schema: S) =>
  Schema.StructWithRest(schema, [JsonRecordSchema]);
const WorkerEventSchema = withRest(
  Schema.Struct({
    at: Schema.Finite,
    credentialHash: Schema.optionalKey(Schema.String),
    kind: Schema.Literals(['spawn', 'start', 'end', 'credential', 'list', 'hidden-endpoint']),
    pid: Schema.Finite,
  }),
);
const ClientReplySchema = withRest(
  Schema.Struct({
    elapsedMs: Schema.Finite,
    result: Schema.optionalKey(
      withRest(Schema.Struct({sourceId: Schema.String, syncedDocuments: Schema.Array(Schema.String)})),
    ),
  }),
);
const EndpointSchema = withRest(
  Schema.Struct({
    home: Schema.optionalKey(Schema.String),
    pid: Schema.Finite,
    port: Schema.Finite,
    token: Schema.optionalKey(Schema.String),
  }),
);
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
interface ClientClose {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}
interface OwnedClient {
  readonly child: ChildProcess;
  readonly result: () => Promise<ClientReply>;
  readonly closed: () => Promise<ClientClose>;
  readonly action: string;
}
interface OwnedClientClose {
  readonly action: string;
  readonly pid: number | undefined;
  readonly wait: () => Promise<ClientClose>;
}
interface FixtureCleanupFailure {
  readonly error: unknown;
  readonly stage: string;
  readonly status?: 'failed' | 'unknown';
  readonly owner?: string;
  readonly pid?: number;
}
interface OwnedCloseCollection {
  readonly outcomes: readonly PromiseSettledResult<ClientClose>[];
  readonly failures: readonly FixtureCleanupFailure[];
  readonly fixtureDisposition: 'removed' | 'preserved' | 'removal-failed';
}

function clientObservationError(stage: string): Error & {readonly status: 'unknown'} {
  const error = new Error(`${stage} was not observed before the original client deadline; status unknown`);
  error.name = 'ClientObservationError';
  const status = 'unknown' as const;
  return Object.assign(error, {status});
}

function isClientObservationError(value: unknown): value is Error & {readonly status: 'unknown'} {
  return value instanceof Error && 'status' in value && Reflect.get(value, 'status') === 'unknown';
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

function coordinatorJob(home: string, key: string) {
  const database = new Database(join(home, 'threadnote', 'integration-coordinator', 'jobs.sqlite'), {readonly: true});
  try {
    const row = database
      .query<
        {key: string; config_json: string; descriptor_json: string; generation: number; mode: string; state: string},
        [string]
      >('SELECT key,config_json,descriptor_json,generation,mode,state FROM source_jobs WHERE key=?')
      .get(key);
    return row
      ? {
          key: row.key,
          config: JSON.parse(row.config_json) as unknown,
          descriptor: JSON.parse(row.descriptor_json) as unknown,
          generation: row.generation,
          mode: row.mode,
          state: row.state,
        }
      : undefined;
  } finally {
    database.close();
  }
}

const pause = (milliseconds: number) => new Promise(resolve => setTimeout(resolve, milliseconds));
function beforeClientDeadline<A>(promise: Promise<A>, deadline: number, stage: string): () => Promise<A> {
  const observation: Promise<
    | {readonly completedAt: number; readonly ok: true; readonly value: A}
    | {readonly completedAt: number; readonly ok: false; readonly error: unknown}
  > = promise.then(
    value => ({completedAt: Date.now(), ok: true, value}),
    error => ({completedAt: Date.now(), ok: false, error}),
  );
  return () =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(clientObservationError(stage)), Math.max(0, deadline - Date.now()));
      void observation.then(result => {
        clearTimeout(timer);
        if (result.completedAt > deadline) {
          reject(clientObservationError(stage));
        } else if (result.ok) resolve(result.value);
        else reject(result.error);
      });
    });
}

async function collectOwnedClientCloses(
  owners: readonly OwnedClientClose[],
  removeFixture: () => Promise<void>,
): Promise<OwnedCloseCollection> {
  const outcomes = await Promise.allSettled(EffectArray.map(owners, owner => Promise.resolve().then(owner.wait)));
  const failures: FixtureCleanupFailure[] = [];
  for (const [index, owner] of owners.entries()) {
    const outcome = outcomes[index];
    if (outcome?.status !== 'rejected') continue;
    failures.push({
      error: outcome.reason,
      stage: 'client-close',
      status: isClientObservationError(outcome.reason) ? 'unknown' : 'failed',
      owner: owner.action,
      ...(owner.pid === undefined ? {} : {pid: owner.pid}),
    });
  }
  if (failures.length > 0) return {outcomes, failures, fixtureDisposition: 'preserved'};
  try {
    await removeFixture();
    return {outcomes, failures, fixtureDisposition: 'removed'};
  } catch (error) {
    failures.push({error, stage: 'remove-fixture', status: 'failed'});
    return {outcomes, failures, fixtureDisposition: 'removal-failed'};
  }
}

function fixtureCleanupDiagnostic(failures: readonly FixtureCleanupFailure[]): string {
  const entries = EffectArray.map(failures, entry => ({
    name: entry.error instanceof Error ? entry.error.name : 'UnknownError',
    stage: entry.stage,
    status: entry.status,
    owner: entry.owner,
    pid: entry.pid,
    code:
      typeof entry.error === 'object' && entry.error !== null && 'code' in entry.error
        ? Reflect.get(entry.error, 'code')
        : undefined,
  }));
  return `COORDINATOR_FIXTURE_CLEANUP_FAILURE ${JSON.stringify({count: entries.length, failures: entries})}\n`;
}

function finishFixture<A>(
  outcome: {readonly ok: true; readonly value: A} | {readonly ok: false; readonly error: unknown},
  cleanupFailures: readonly FixtureCleanupFailure[],
  writeDiagnostic: (line: string) => void = line => process.stderr.write(line),
): A {
  if (!outcome.ok) {
    if (cleanupFailures.length > 0) {
      try {
        writeDiagnostic(fixtureCleanupDiagnostic(cleanupFailures));
      } catch {
        // Cleanup diagnostics are best effort and must not replace the primary failure.
      }
    }
    throw outcome.error;
  }
  if (cleanupFailures.length > 0) {
    try {
      writeDiagnostic(fixtureCleanupDiagnostic(cleanupFailures));
    } catch {
      // Cleanup diagnostics are best effort and must not replace cleanup failure evidence.
    }
    throw new AggregateError(
      EffectArray.map(cleanupFailures, failure => failure.error),
      'Coordinator fixture cleanup failed.',
    );
  }
  return outcome.value;
}

function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
async function until<A>(
  read: () => Promise<A | undefined>,
  message: string | (() => string),
  timeoutMs = 8_000,
): Promise<A> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) return value;
    await pause(25);
  }
  throw new Error(typeof message === 'string' ? message : message());
}

async function withProcesses<A>(
  run: (harness: {
    readonly home: string;
    readonly alias: string;
    readonly events: () => Promise<readonly WorkerEvent[]>;
    readonly mark: (phase: 'sync-dispatched' | 'provider-released' | 'sync-returned') => void;
    readonly client: (
      action: string,
      home?: string,
      environment?: Readonly<Record<string, string | undefined>>,
    ) => Promise<ClientReply>;
    readonly ownedClient: (
      action: string,
      home?: string,
      environment?: Readonly<Record<string, string | undefined>>,
    ) => OwnedClient;
  }) => Promise<A>,
) {
  const root = await mkdtemp(join(tmpdir(), 'threadnote-coordinator-process-'));
  const home = join(root, 'home');
  const alias = join(root, 'home-alias');
  const clients = new Set<ChildProcess>();
  let observedEvents: readonly WorkerEvent[] = [];
  const phases: {phase: 'sync-dispatched' | 'provider-released' | 'sync-returned'; at: number}[] = [];
  const clientClosures = new Map<ChildProcess, OwnedClientClose>();
  const events = async (): Promise<readonly WorkerEvent[]> => {
    const content = await readFile(join(home, 'events.jsonl'), 'utf8').catch(() => '');
    observedEvents = EffectArray.map(
      EffectArray.filter(Effect.pipe(content, EffectString.trim, EffectString.split('\n')), Boolean),
      line => Schema.decodeUnknownSync(WorkerEventSchema)(JSON.parse(line)),
    );
    return observedEvents;
  };
  await mkdir(home, {recursive: true});
  await symlink(home, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const ownedClient = (
    action: string,
    requestedHome = home,
    environment: Readonly<Record<string, string | undefined>> = {},
  ): OwnedClient => {
    const deadline = Date.now() + 12_000;
    let resolveClose!: (value: ClientClose) => void;
    const closed = new Promise<ClientClose>(resolve => {
      resolveClose = resolve;
    });
    const waitForClose = beforeClientDeadline(closed, deadline, `${action} client close`);
    let child!: ChildProcess;
    const rawResult = new Promise<ClientReply>((resolve, reject) => {
      child = execFile(
        process.execPath,
        [fixture, action, requestedHome],
        {timeout: 12_000, maxBuffer: 64 * 1024, env: {...process.env, THREADNOTE_HOME: home, ...environment}},
        (error, stdout, stderr) => {
          if (error) reject(new Error(`${action} client failed: ${stderr || error.message}`));
          else resolve(Schema.decodeUnknownSync(ClientReplySchema)(JSON.parse(Effect.pipe(stdout, EffectString.trim))));
        },
      );
      clients.add(child);
      clientClosures.set(child, {action, pid: child.pid, wait: waitForClose});
      child.once('close', (code, signal) => {
        clients.delete(child);
        resolveClose({code, signal});
      });
    });
    return {
      child,
      result: beforeClientDeadline(rawResult, deadline, `${action} client result`),
      closed: waitForClose,
      action,
    };
  };
  const client = (
    action: string,
    requestedHome = home,
    environment: Readonly<Record<string, string | undefined>> = {},
  ) => {
    const owned = ownedClient(action, requestedHome, environment);
    return owned.result();
  };
  let outcome: {readonly ok: true; readonly value: A} | {readonly ok: false; readonly error: unknown};
  try {
    outcome = {
      ok: true,
      value: await run({home, alias, events, client, ownedClient, mark: phase => phases.push({phase, at: Date.now()})}),
    };
  } catch (error) {
    try {
      // Reuse observations already made by the test; never add a read at the race boundary.
      writeSync(
        2,
        `${JSON.stringify({
          diagnostic: 'coordinator-process-failure',
          eventsObservation: 'last-completed-test-read',
          events: EffectArray.map(EffectArray.takeRight(observedEvents, 64), ({kind, pid, at}) => ({kind, pid, at})),
          omittedEvents: Math.max(0, observedEvents.length - 64),
          phases,
        })}\n`,
      );
    } catch {
      // Diagnostic output must preserve the original failure and existing teardown.
    }
    outcome = {ok: false, error};
  }
  const cleanupFailures: FixtureCleanupFailure[] = [];
  const cleanupStep = async (stage: string, action: () => Promise<void> | void) => {
    try {
      await action();
    } catch (error) {
      cleanupFailures.push({error, stage, status: 'failed'});
    }
  };
  await cleanupStep('kill-owned-clients', async () => {
    for (const child of clients) child.kill('SIGKILL');
  });
  await cleanupStep('stop-owned-workers', async () => {
    for (const event of await events()) {
      if (event.kind !== 'spawn' || !alive(event.pid)) continue;
      try {
        process.kill(event.pid, 'SIGKILL');
      } catch {
        // A worker can complete its idle shutdown during cleanup.
      }
    }
  });
  const closeCollection = await collectOwnedClientCloses([...clientClosures.values()], async () => {
    await rm(root, {force: true, recursive: true});
  });
  cleanupFailures.push(...closeCollection.failures);
  return finishFixture(outcome, cleanupFailures);
}

describe('integration coordinator process composition', () => {
  it('keeps a primary failure when the original client deadline expires before close', async () => {
    const primary = new Error('primary operation failure');
    let fixtureRemovalAttempted = false;
    const closeCollection = await collectOwnedClientCloses(
      [
        {
          action: 'expired-sync',
          pid: undefined,
          wait: beforeClientDeadline(new Promise<ClientClose>(() => undefined), Date.now() - 1, 'sync close'),
        },
      ],
      async () => {
        fixtureRemovalAttempted = true;
      },
    );
    expect(closeCollection.fixtureDisposition).toBe('preserved');
    expect(fixtureRemovalAttempted).toBe(false);
    expect(closeCollection.failures).toMatchObject([
      {stage: 'client-close', status: 'unknown', owner: 'expired-sync', error: {name: 'ClientObservationError'}},
    ]);

    let diagnostic = '';
    let observed: unknown;
    try {
      finishFixture({ok: false, error: primary}, closeCollection.failures, line => (diagnostic += line));
    } catch (error) {
      observed = error;
    }
    expect(observed).toBe(primary);
    expect(diagnostic).toContain('"stage":"client-close","status":"unknown","owner":"expired-sync"');
  });

  it('awaits every owned close after one deadline expires and preserves the fixture', async () => {
    const expired = await beforeClientDeadline(
      new Promise<ClientClose>(() => undefined),
      Date.now() - 1,
      'first client close',
    )().then(
      () => undefined,
      error => error,
    );
    expect(expired).toMatchObject({name: 'ClientObservationError', status: 'unknown'});

    let resolveSecond: (close: ClientClose) => void = () => undefined;
    const secondClose = new Promise<ClientClose>(resolve => {
      resolveSecond = resolve;
    });
    let secondCloseObserved = false;
    let fixtureRemovalAttempted = false;
    let removalSawSecondClose = false;
    let collectionFinished = false;
    const collection = collectOwnedClientCloses(
      [
        {action: 'expired-client', pid: undefined, wait: () => Promise.reject(expired)},
        {
          action: 'pending-client',
          pid: undefined,
          wait: () =>
            secondClose.then(close => {
              secondCloseObserved = true;
              return close;
            }),
        },
      ],
      async () => {
        fixtureRemovalAttempted = true;
        removalSawSecondClose = secondCloseObserved;
      },
    );
    void collection.then(() => {
      collectionFinished = true;
    });
    await Promise.resolve();
    expect(collectionFinished).toBe(false);

    resolveSecond({code: 0, signal: null});
    const result = await collection;
    expect(result.outcomes[0]?.status).toBe('rejected');
    expect(result.outcomes[1]).toEqual({status: 'fulfilled', value: {code: 0, signal: null}});
    expect(result.fixtureDisposition).toBe('preserved');
    expect(fixtureRemovalAttempted).toBe(false);
    expect(removalSawSecondClose).toBe(false);
    expect(result.failures).toMatchObject([{stage: 'client-close', status: 'unknown', owner: 'expired-client'}]);

    let diagnostic = '';
    let cleanupFailure: unknown;
    try {
      finishFixture({ok: true, value: 'run-complete'}, result.failures, line => (diagnostic += line));
    } catch (error) {
      cleanupFailure = error;
    }
    expect(cleanupFailure).toBeInstanceOf(AggregateError);
    expect(diagnostic).toContain('"owner":"expired-client"');
    expect(diagnostic).not.toContain('"owner":"pending-client"');

    let resolveFirstSuccess: (close: ClientClose) => void = () => undefined;
    let resolveSecondSuccess: (close: ClientClose) => void = () => undefined;
    const firstSuccessfulClose = new Promise<ClientClose>(resolve => {
      resolveFirstSuccess = resolve;
    });
    const secondSuccessfulClose = new Promise<ClientClose>(resolve => {
      resolveSecondSuccess = resolve;
    });
    let firstSuccessfulCloseObserved = false;
    let secondSuccessfulCloseObserved = false;
    let successfulRemovalAttempted = false;
    let removalSawAllCloseReceipts = false;
    const successfulCollection = collectOwnedClientCloses(
      [
        {
          action: 'first-success-client',
          pid: undefined,
          wait: () =>
            firstSuccessfulClose.then(close => {
              firstSuccessfulCloseObserved = true;
              return close;
            }),
        },
        {
          action: 'second-success-client',
          pid: undefined,
          wait: () =>
            secondSuccessfulClose.then(close => {
              secondSuccessfulCloseObserved = true;
              return close;
            }),
        },
      ],
      async () => {
        successfulRemovalAttempted = true;
        removalSawAllCloseReceipts = firstSuccessfulCloseObserved && secondSuccessfulCloseObserved;
      },
    );
    await Promise.resolve();
    expect(successfulRemovalAttempted).toBe(false);
    resolveFirstSuccess({code: 0, signal: null});
    await Promise.resolve();
    expect(firstSuccessfulCloseObserved).toBe(true);
    expect(successfulRemovalAttempted).toBe(false);
    resolveSecondSuccess({code: 0, signal: null});
    const successfulResult = await successfulCollection;
    expect(successfulResult.outcomes).toEqual([
      {status: 'fulfilled', value: {code: 0, signal: null}},
      {status: 'fulfilled', value: {code: 0, signal: null}},
    ]);
    expect(successfulResult.fixtureDisposition).toBe('removed');
    expect(successfulRemovalAttempted).toBe(true);
    expect(removalSawAllCloseReceipts).toBe(true);
  });

  it('distinguishes safe inventory, worker-launch, and startup-deadline failures', async () => {
    await withProcesses(async ({client, events}) => {
      for (const [action, message] of [
        ['inventory-failure-sync', 'failed during source inventory'],
        ['failed-launch-sync', 'failed during worker launch'],
        ['silent-launch-sync', 'did not publish a valid endpoint before its startup deadline'],
      ]) {
        const failure = await client(action).then(
          () => undefined,
          error => (error instanceof Error ? error : new Error(String(error))),
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
      await until(
        async () => EffectOption.getOrUndefined(EffectArray.findFirst(await events(), event => event.kind === 'start')),
        'Provider did not start',
      );
      const endpointPath = join(home, 'threadnote', 'integration-coordinator', 'endpoint.json');
      const original = Schema.decodeUnknownSync(EndpointSchema)(JSON.parse(await readFile(endpointPath, 'utf8')));
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
    await withProcesses(async ({home, alias, events, client, ownedClient, mark}) => {
      await Promise.all([client('refresh'), client('refresh', alias)]);
      const start = await until(
        async () => EffectOption.getOrUndefined(EffectArray.findFirst(await events(), event => event.kind === 'start')),
        'Provider did not start',
      );
      const warm = await client('refresh', alias);
      expect(warm.elapsedMs).toBeLessThan(800);
      await until(
        async () =>
          EffectArray.every(
            EffectArray.filter(await events(), event => event.kind === 'spawn' && event.pid !== start.pid),
            event => !alive(event.pid),
          )
            ? true
            : undefined,
        'Cold-start contender did not exit promptly after discovering the healthy worker',
      );
      expect(EffectArray.filter(await events(), event => event.kind === 'end')).toEqual([]);
      expect(await readFile(join(home, 'snapshot.txt'), 'utf8').catch(() => undefined)).toBeUndefined();
      const endpoint = Schema.decodeUnknownSync(EndpointSchema)(
        JSON.parse(await readFile(join(home, 'threadnote', 'integration-coordinator', 'endpoint.json'), 'utf8')),
      );
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

      const sync = ownedClient('sync');
      mark('sync-dispatched');
      const canonicalConfig = {
        account: 'local',
        user: 'process-test',
        agentId: 'threadnote',
        manifestPath: join(home, 'seed-manifest.yaml'),
        agentContextHome: home,
      };
      const descriptor = {provider: 'synthetic', sourceId: 'slow'};
      const canonicalKey = sourceWorkKey(canonicalConfig, descriptor);
      const aliasKey = sourceWorkKey({...canonicalConfig, manifestPath: join(alias, 'seed-manifest.yaml')}, descriptor);
      expect(aliasKey).not.toBe(canonicalKey);
      const aliasJob = coordinatorJob(home, aliasKey);
      if (!aliasJob) throw new Error(`Alias-manifest job was absent before explicit sync: key=${aliasKey}`);
      expect(aliasJob.config).toMatchObject({
        account: 'local',
        user: 'process-test',
        agentId: 'threadnote',
        agentContextHome: home,
        manifestPath: join(alias, 'seed-manifest.yaml'),
      });
      expect(aliasJob.mode).toBe('automatic');
      const baseline = coordinatorJob(home, canonicalKey);
      if (!baseline) throw new Error(`Canonical automatic job was absent before explicit sync: key=${canonicalKey}`);
      expect(baseline).toMatchObject({key: canonicalKey, mode: 'automatic'});
      expect(baseline.config).toEqual(canonicalConfig);
      expect(baseline.descriptor).toMatchObject({
        provider: 'synthetic',
        sourceId: 'slow',
        accountKey: 'test-account',
        fingerprint: 'test-fingerprint',
      });
      expect(['pending', 'queued', 'running']).toContain(baseline.state);
      const baselineGeneration = baseline.generation;

      if (sync.child.pid === undefined) throw new Error('Explicit sync client did not expose its owned child PID.');
      const syncOutcome = sync.result().then(
        reply => ({reply}),
        error => ({error: error instanceof Error ? error : new Error(String(error))}),
      );
      let lastObserved: ReturnType<typeof coordinatorJob> = undefined;
      const admitted = await until(
        async () => {
          const row = coordinatorJob(home, canonicalKey);
          lastObserved = row;
          if (!row) return undefined;
          expect(row.key).toBe(canonicalKey);
          expect(row.config).toEqual(canonicalConfig);
          expect(row.descriptor).toEqual(baseline.descriptor);
          expect(row.generation).toBe(baselineGeneration);
          expect(['pending', 'queued', 'running']).toContain(row.state);
          if (row.mode === 'automatic') return undefined;
          expect(row.mode).toBe('explicit');
          return row;
        },
        () =>
          `Explicit sync did not admit canonical job key=${canonicalKey}, generation=${baselineGeneration}; last=${JSON.stringify(lastObserved ? {key: lastObserved.key, generation: lastObserved.generation, mode: lastObserved.mode, state: lastObserved.state} : null)}; childPid=${sync.child.pid ?? 'unknown'}`,
      );
      expect(admitted.mode).toBe('explicit');
      expect(admitted.generation).toBe(baselineGeneration);
      expect(alive(start.pid)).toBe(true);
      expect(EffectArray.filter(await events(), event => event.kind === 'end' && event.pid === start.pid)).toEqual([]);
      expect(await readFile(join(home, 'snapshot.txt'), 'utf8').catch(() => undefined)).toBeUndefined();
      expect(await readFile(join(home, 'release'), 'utf8').catch(() => undefined)).toBeUndefined();
      await writeFile(join(home, 'release'), 'release provider');
      mark('provider-released');
      const [outcome, closed] = await Promise.all([syncOutcome, sync.closed()]);
      mark('sync-returned');
      if ('error' in outcome)
        throw new Error(
          `Sync client pid ${sync.child.pid ?? 'unknown'} failed: ${outcome.error.message}; close=${JSON.stringify(closed)}`,
          {cause: outcome.error},
        );
      expect(closed).toEqual({code: 0, signal: null});
      const reply = outcome.reply;
      process.stdout.write(
        `COORDINATOR_SYNC_CLIENT_RECEIPT ${JSON.stringify({
          pid: sync.child.pid,
          sourceKey: canonicalKey,
          generation: admitted.generation,
          sourceId: reply.result?.sourceId,
          syncedDocuments: reply.result?.syncedDocuments,
          closeCode: closed.code,
          closeSignal: closed.signal,
        })}\n`,
      );
      expect(reply.result).toMatchObject({sourceId: 'slow', syncedDocuments: ['synthetic://slow/document']});
      expect(await readFile(join(home, 'snapshot.txt'), 'utf8')).toBe('usable synthetic snapshot');
      expect(
        new Set(
          EffectArray.map(
            EffectArray.filter(await events(), event => event.kind === 'start'),
            event => event.pid,
          ),
        ),
      ).toEqual(new Set([start.pid]));
      expectSequentialRuns(await events());
      await until(async () => (!alive(start.pid) ? true : undefined), 'Worker did not shut down when idle');
    });
  });

  it('recovers durable in-flight demand after SIGKILL without concurrent source writers', async () => {
    await withProcesses(async ({home, events, client}) => {
      await client('refresh');
      const first = await until(
        async () => EffectOption.getOrUndefined(EffectArray.findFirst(await events(), event => event.kind === 'start')),
        'First worker did not start',
      );
      const original = persistedJob(home);
      expect(original).toEqual([{generation: 1, state: 'running'}]);
      process.kill(first.pid, 'SIGKILL');
      await until(async () => (!alive(first.pid) ? true : undefined), 'Killed worker remained alive');
      const sync = client('sync');
      const restarted = await until(
        async () =>
          EffectOption.getOrUndefined(
            EffectArray.findFirst(await events(), event => event.kind === 'start' && event.pid !== first.pid),
          ),
        'Pending source work did not restart',
      );
      expect(alive(first.pid)).toBe(false);
      expect(alive(restarted.pid)).toBe(true);
      expect(persistedJob(home)).toEqual(original);
      await writeFile(join(home, 'release'), 'release restarted provider');
      expect((await sync).result?.syncedDocuments).toEqual(['synthetic://slow/document']);
      expect(
        EffectArray.every(
          EffectArray.filter(await events(), event => event.kind === 'end'),
          event => event.pid === restarted.pid,
        ),
      ).toBe(true);
      expectSequentialRuns(EffectArray.filter(await events(), event => event.pid !== first.pid));
    });
  });

  it('bounds explicit sync waiting while a provider is blocked', async () => {
    await withProcesses(async ({home, events, client}) => {
      await client('refresh');
      await until(
        async () => EffectOption.getOrUndefined(EffectArray.findFirst(await events(), event => event.kind === 'start')),
        'Provider did not start',
      );
      const started = performance.now();
      await expect(client('deadline')).rejects.toThrow(/deadline|timed out|timeout/i);
      expect(performance.now() - started).toBeLessThan(3_000);
      expect(EffectArray.some(await events(), event => event.kind === 'end')).toBe(false);
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
      const initial = EffectOption.getOrUndefined(
        EffectArray.findFirst(await events(), event => event.kind === 'credential'),
      );
      expect(initial?.credentialHash).toBe(sha256HexSync('synthetic-token-a'));
      expect((await client('credential-sync', home, {[binding]: 'synthetic-token-b'})).result?.syncedDocuments).toEqual(
        ['synthetic://credential/document'],
      );
      await until(
        async () =>
          EffectArray.filter(await events(), event => event.credentialHash === sha256HexSync('synthetic-token-b'))
            .length >= 2
            ? true
            : undefined,
        'Rotated credential was not retained for autonomous continuation',
      );
      await expect(client('credential-sync', home, {[binding]: undefined})).rejects.toThrow(/failed/i);
      const observations = EffectArray.filter(await events(), event => event.kind === 'credential');
      expect(EffectArray.map(observations.slice(0, 3), event => event.credentialHash)).toEqual([
        sha256HexSync('synthetic-token-a'),
        sha256HexSync('synthetic-token-b'),
        sha256HexSync('synthetic-token-b'),
      ]);
      expect(observations.length).toBeGreaterThanOrEqual(4);
      expect(EffectArray.every(observations.slice(3), event => event.credentialHash === 'missing')).toBe(true);
      expect(new Set(EffectArray.map(observations, event => event.pid))).toEqual(new Set([initial?.pid]));
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
      const original = Schema.decodeUnknownSync(EndpointSchema)(JSON.parse(await readFile(endpointPath, 'utf8')));
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
          EffectArray.map(
            EffectArray.filter(await events(), event => event.kind === 'credential'),
            event => event.credentialHash,
          ),
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
        async () => EffectOption.getOrUndefined(EffectArray.findFirst(await events(), event => event.kind === 'start')),
        'First worker did not start',
      );
      await writeFile(join(home, 'release'), 'finish initial source work');
      await until(
        async () => EffectOption.getOrUndefined(EffectArray.findFirst(await events(), event => event.kind === 'end')),
        'Initial source work did not finish',
      );
      await rm(join(home, 'release'));
      await writeFile(join(home, 'source-version'), 'changed-source-fingerprint');
      const endpointPath = join(home, 'threadnote', 'integration-coordinator', 'endpoint.json');
      const original = Schema.decodeUnknownSync(EndpointSchema)(JSON.parse(await readFile(endpointPath, 'utf8')));
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
          async () =>
            EffectOption.getOrUndefined(
              EffectArray.findFirst(await events(), event => event.kind === 'spawn' && event.pid !== first.pid),
            ),
          'Accepted demand did not launch a replacement',
        );
        expect(alive(first.pid)).toBe(true);
        expect(alive(replacement.pid)).toBe(true);
        process.kill(first.pid, 'SIGKILL');
        await until(
          async () =>
            EffectOption.getOrUndefined(
              EffectArray.findFirst(await events(), event => event.kind === 'start' && event.pid === replacement.pid),
            ),
          'Replacement did not consume accepted demand after the old lock was released',
        );
        await writeFile(join(home, 'release'), 'finish accepted source work');
        await until(async () => {
          const completed = EffectOption.getOrUndefined(
            EffectArray.findFirst(await events(), event => event.kind === 'end' && event.pid === replacement.pid),
          );
          if (completed === undefined) return undefined;
          // Provider return precedes the coordinator's durable completion transaction.
          const jobs = persistedJob(home);
          return jobs.length === 1 && jobs[0].generation === 2 && jobs[0].state === 'idle' ? completed : undefined;
        }, 'Accepted demand did not finish without another client call');
        expect(persistedJob(home)).toEqual([{generation: 2, state: 'idle'}]);
      } finally {
        await proxy.stop(true);
      }
    });
  });

  it('accepts bounded many-source credential batches without enumerating providers in the handoff RPC', async () => {
    await withProcesses(async ({home, events, client}) => {
      await client('credential-sync', home, {THREADNOTE_SYNTHETIC_CREDENTIAL: 'synthetic-token-a'});
      const endpoint = Schema.decodeUnknownSync(EndpointSchema)(
        JSON.parse(await readFile(join(home, 'threadnote', 'integration-coordinator', 'endpoint.json'), 'utf8')),
      );
      const before = EffectArray.filter(
        await events(),
        event => event.kind === 'list' && event.pid === endpoint.pid,
      ).length;
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
      expect(
        EffectArray.filter(await events(), event => event.kind === 'list' && event.pid === endpoint.pid),
      ).toHaveLength(before);
    });
  });

  it('forwards cold caller credentials when a different worker appears before the post-enqueue endpoint read', async () => {
    await withProcesses(async ({home, events, client}) => {
      const binding = 'THREADNOTE_SYNTHETIC_CREDENTIAL';
      await client('credential-sync', home, {[binding]: 'synthetic-token-a'});
      const owner = EffectOption.getOrUndefined(
        EffectArray.findFirst(await events(), event => event.kind === 'credential'),
      );
      expect(owner?.credentialHash).toBe(sha256HexSync('synthetic-token-a'));
      await client('credential-cold-refresh', home, {[binding]: 'synthetic-token-b'});
      expect(EffectArray.filter(await events(), event => event.kind === 'hidden-endpoint')).toHaveLength(1);
      await until(
        async () =>
          EffectArray.some(
            await events(),
            event => event.kind === 'credential' && event.credentialHash === sha256HexSync('synthetic-token-b'),
          )
            ? true
            : undefined,
        'Accepted cold caller demand did not receive its own credential without another request',
      );
      const contender = await until(
        async () =>
          EffectOption.getOrUndefined(
            EffectArray.findFirst(await events(), event => event.kind === 'spawn' && event.pid !== owner?.pid),
          ),
        'Cold caller did not preserve its credential-carrying contender',
      );
      await until(
        async () => (!alive(contender.pid) ? true : undefined),
        'Credential-carrying contender did not exit after forwarding to the elected worker',
      );
      expect(alive(owner!.pid)).toBe(true);
      expect(
        new Set(
          EffectArray.map(
            EffectArray.filter(await events(), event => event.kind === 'credential'),
            event => event.pid,
          ),
        ),
      ).toEqual(new Set([owner?.pid]));
    });
  });
});
