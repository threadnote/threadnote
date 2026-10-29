import * as EffectArray from 'effect/Array';
import * as EffectOption from 'effect/Option';
import {describe, it, expect} from 'vitest';
import {nativeWatchInvocation} from '../../src/workflow_automation/watch_process.js';
import {runtimeConfigForTest} from '@threadnote/workspace/test/helpers/runtime-config';
describe('native watch invocation', () => {
  const token = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
  it('uses the same binary with trusted source entrypoint only for Bun', () => {
    expect(nativeWatchInvocation('/bin/bun', '/trusted/main.ts', 'watch-1', token).arguments[0]).toBe(
      '/trusted/main.ts',
    );
    expect(nativeWatchInvocation('C:\\threadnote.exe', 'ignored', 'watch-1', token).arguments[0]).toBe(
      'workflow-automation',
    );
  });
  it('rejects paths as watch identifiers', () =>
    expect(() => nativeWatchInvocation('/bin/bun', 'main.ts', '../escape', token)).toThrow());
});

import {mkdtemp, mkdir, readFile, rm, writeFile} from '@threadnote/testing/node-fs-promises';
import {tmpdir} from '@threadnote/testing/node-os';
import {join, resolve} from '@threadnote/testing/node-path';

const eventBoundary = Schema.Struct({
  sequence: Schema.Int,
  version: Schema.String,
  at: Schema.Int,
  removed: Schema.Boolean,
  ready: Schema.optionalKey(Schema.Literal(false)),
  id: Schema.String,
  kind: Schema.String,
  source: Schema.String,
  key: Schema.String,
  url: Schema.optionalKey(Schema.String),
  head: Schema.optionalKey(Schema.String),
});
const deliveryBoundary = Schema.Struct({id: Schema.String, events: Schema.Array(eventBoundary)});
const identityBoundary = {
  protocolVersion: Schema.Literal(1),
  executorVersion: Schema.Literal(1),
  status: Schema.Literal('ok'),
  watchId: Schema.String,
  revision: Schema.String,
};
const controlFields = {
  ...identityBoundary,
  prState: Schema.Literals(['open', 'closed', 'merged']),
  collector: Schema.Struct({alive: Schema.Boolean, pid: Schema.NullOr(Schema.Int), status: Schema.String}),
  pending: Schema.Int,
  stopRequested: Schema.Boolean,
  delivery: deliveryBoundary.pipe(Schema.NullOr, Schema.optionalKey),
  work: Schema.Struct({open: Schema.Int, blocked: Schema.Int, terminal: Schema.Int}),
};
const controlBoundary = Schema.Struct(controlFields);
const healthBoundary = Schema.Struct({
  ...controlFields,
  metrics: Schema.Struct({sweeps: Schema.Int}),
  notification: Schema.Struct({notifiedThrough: Schema.Int}).pipe(Schema.NullOr, Schema.optionalKey),
});
const workRecordBoundary = Schema.Struct({
  eventId: Schema.String,
  status: Schema.String,
  reason: Schema.String,
  evidence: Schema.String,
  event: eventBoundary,
});
const workBoundary = Schema.Struct({
  ...identityBoundary,
  work: Schema.Struct({
    items: Schema.Array(
      Schema.Struct({
        eventId: Schema.String,
        status: Schema.String,
        reason: Schema.optionalKey(Schema.String),
        evidence: Schema.optionalKey(Schema.String),
        event: Schema.optionalKey(eventBoundary),
        detail: Schema.optionalKey(
          Schema.Struct({command: Schema.Literal('work-detail'), eventId: Schema.String, sourceDigest: Schema.String}),
        ),
      }),
    ),
    nextOffset: Schema.NullOr(Schema.Int),
  }),
});
const detailBoundary = Schema.Struct({
  ...identityBoundary,
  workDetail: Schema.Struct({
    eventId: Schema.String,
    text: Schema.String,
    sourceDigest: Schema.String,
    nextOffsetBytes: Schema.NullOr(Schema.Int),
  }),
});
type Command =
  'start' | 'inspect' | 'wait' | 'relay' | 'ack' | 'disposition' | 'work' | 'work-detail' | 'work-disposition' | 'stop';
type WatchResult<C extends Command> = C extends 'start' | 'inspect'
  ? typeof healthBoundary.Type
  : C extends 'work'
    ? typeof workBoundary.Type
    : C extends 'work-detail'
      ? typeof detailBoundary.Type
      : typeof controlBoundary.Type;
type Delivery = typeof deliveryBoundary.Type;
interface CliBoundary {
  exitCode: number;
  stdout: string;
  stderr: string;
  result: unknown;
}
const required = <A>(value: A | null | undefined): A => {
  expect(value).toBeDefined();
  expect(value).not.toBeNull();
  if (value === null || value === undefined) throw new Error('Required CLI response field missing.');
  return value;
};
async function realCollectorScenario(terminal: boolean, eventDriven = false) {
  const root = await mkdtemp(join(tmpdir(), 'native-watch-child-'));
  const home = join(root, 'home');
  const bin = join(root, 'bin');
  await mkdir(home);
  await mkdir(bin);
  const counter = join(root, 'gh-requests');
  await writeFile(counter, '');
  const hostCounter = join(root, 'host-requests');
  await writeFile(hostCounter, '');
  const fake = join(root, 'fake-gh.ts');
  const head = Fn.pipe('a', EffectString.repeat(40));
  await writeFile(
    fake,
    `import {appendFileSync} from 'node:fs';
const args=process.argv.slice(2); appendFileSync(${JSON.stringify(counter)},JSON.stringify(args)+'\\n');
const endpoint=args[args.indexOf('--method')+2];
if(endpoint==='graphql') await Bun.stdin.text();
let body;
if(endpoint==='graphql') body={data:{repository:{pullRequest:{reviewThreads:{pageInfo:{hasNextPage:false,endCursor:null},nodes:[{id:'thread-1',isResolved:false,isOutdated:false,path:'fixture.ts',line:1,comments:{pageInfo:{hasNextPage:false,endCursor:null},nodes:[]}}]}}},rateLimit:{cost:1,remaining:5000,resetAt:'2099-01-01T00:00:00Z'}}};
else if(endpoint.includes('/comments')) body=[{id:1,body:'fixture comment',updated_at:'2026-01-01T00:00:00Z',html_url:'https://github.com/fixture/repo/pull/1#issuecomment-1'}];
else if(endpoint.includes('/reviews')) body=[];
else if(endpoint.includes('/check-runs')) body={check_runs:[{id:2,name:'fixture check',status:'completed',conclusion:'failure',head_sha:${JSON.stringify(head)},html_url:'https://github.com/fixture/repo/pull/1/checks?check_run_id=2'}]};
else if(endpoint.includes('/status')) body={statuses:[]};
else body={state:${JSON.stringify(terminal ? 'closed' : 'open')},merged:${terminal},head:{sha:${JSON.stringify(head)}}};
process.stdout.write('HTTP/2.0 200 OK\\r\\nETag: "fixture"\\r\\nX-Poll-Interval: 60\\r\\n\\r\\n'+JSON.stringify(body));`,
  );
  const compiled = await Bun.build({
    entrypoints: [fake],
    compile: {outfile: join(bin, process.platform === 'win32' ? 'gh.exe' : 'gh')},
  });
  if (!compiled.success) throw new Error('Could not compile private fake gh: ' + JSON.stringify(compiled.logs));
  if (eventDriven) {
    const host = join(root, 'fake-codex.ts');
    await writeFile(
      host,
      `import {appendFileSync} from 'node:fs';
appendFileSync(${JSON.stringify(hostCounter)},JSON.stringify(process.argv.slice(2))+'\\n');
process.stdout.write('Queued message bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb for thread cccccccc-cccc-4ccc-cccc-cccccccccccc.\\n');`,
    );
    const built = await Bun.build({
      entrypoints: [host],
      compile: {outfile: join(bin, process.platform === 'win32' ? 'codex.exe' : 'codex')},
    });
    if (!built.success) throw new Error('Could not compile private fake codex: ' + JSON.stringify(built.logs));
  }
  const entrypoint = resolve('apps/threadnote/src/standalone.ts');
  const env = {
    ...process.env,
    PATH: bin + (process.platform === 'win32' ? ';' : ':') + (process.env.PATH ?? ''),
    THREADNOTE_HOME: home,
  };
  const base = {protocolVersion: 1, executorVersion: 1, action: 'watch', watchId: 'fixture-watch'};
  const owned = new Set<number>();
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  function cli<C extends Command>(
    command: C,
    extra?: Record<string, unknown>,
    success?: true,
  ): Promise<CliBoundary & {result: WatchResult<C>}>;
  function cli(command: string, extra: Record<string, unknown>, success: false): Promise<CliBoundary>;
  async function cli(command: string, extra: Record<string, unknown> = {}, success = true) {
    const child = Bun.spawn([process.execPath, entrypoint, 'workflow-automation'], {
      env,
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    await child.stdin.write(JSON.stringify({...base, command, ...extra}));
    await child.stdin.end();
    const timer = setTimeout(() => child.kill(), 15_000);
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]).finally(() => clearTimeout(timer));
    if (success && exitCode !== 0) throw new Error(`CLI ${command} failed (${exitCode}): ${stdout} ${stderr}`);
    expect(new TextEncoder().encode(stdout).byteLength).toBeLessThanOrEqual(8192);
    let result: unknown;
    try {
      result = JSON.parse(stdout);
    } catch {
      throw new Error(`CLI ${command} invalid JSON: ${stdout} ${stderr}`);
    }
    const selected: Schema.ConstraintDecoder<unknown> =
      command === 'start' || command === 'inspect'
        ? healthBoundary
        : command === 'work'
          ? workBoundary
          : command === 'work-detail'
            ? detailBoundary
            : controlBoundary;
    return {
      result: success ? Schema.decodeUnknownSync(selected, {onExcessProperty: 'ignore'})(result) : result,
      exitCode,
      stdout,
      stderr,
    };
  }
  const dead = async (pid: number) => {
    const deadline = Date.now() + 10_000;
    while (alive(pid) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    expect(alive(pid)).toBe(false);
  };
  const start = {
    pr: 'https://github.com/fixture/repo/pull/1',
    consumerId: 'test-consumer',
    wakeupId: 'live-test',
    ...(eventDriven
      ? {
          wakeup: {
            host: 'codex',
            executable: join(bin, process.platform === 'win32' ? 'codex.exe' : 'codex'),
            threadId: 'cccccccc-cccc-4ccc-cccc-cccccccccccc',
          },
        }
      : {}),
  };
  const hostCalls = async () =>
    EffectArray.map(
      EffectArray.filter(EffectString.split(await readFile(hostCounter, 'utf8'), '\n'), line => !!line),
      line => Schema.String.pipe(Schema.Array, Schema.fromJsonString, Schema.decodeSync)(line),
    );
  const notified = async (count: number) => {
    const deadline = Date.now() + 10_000;
    while ((await hostCalls()).length < count && Date.now() < deadline)
      await new Promise(resolve => setTimeout(resolve, 20));
    expect(await hostCalls()).toHaveLength(count);
  };
  const consumer = {consumerId: 'test-consumer'};
  try {
    const initial = (await cli('start', start)).result;
    if (terminal) {
      const pid = required(initial.collector.pid);
      owned.add(pid);
      expect(initial.status).toBe('ok');
      let terminalHealth: typeof controlBoundary.Type = initial;
      const deadline = Date.now() + 10_000;
      while (terminalHealth.prState === 'open' && Date.now() < deadline)
        terminalHealth = (await cli('wait', {...consumer, timeoutSeconds: 1})).result;
      expect(terminalHealth.prState).toBe('merged');
      expect(terminalHealth.collector.status).toBe('terminal');
      await dead(pid);
      owned.delete(pid);
      if (eventDriven) {
        await notified(1);
        expect((await hostCalls())[0][4]).toContain(JSON.stringify(home));
        expect((await hostCalls())[0][4]).toContain('fixture-watch:1:4');
      }
      const delivery = required((await cli('relay', consumer)).result.delivery);
      expect(EffectArray.map(delivery.events, event => event.kind).sort()).toEqual([
        'ci_error',
        'comment',
        'merged',
        'review_thread',
      ]);
      expect((await cli('relay', consumer)).result.delivery).toEqual(delivery);
      const requests = await readFile(counter, 'utf8');
      const dispositions = EffectArray.map(delivery.events, event => ({
        eventId: event.id,
        status: 'resolved',
        reason: 'terminal fixture reviewed',
        evidence: 'private merged fixture',
      }));
      await cli('disposition', {...consumer, deliveryId: delivery.id, dispositions});
      expect((await cli('ack', {...consumer, deliveryId: delivery.id})).result.pending).toBe(0);
      expect(
        EffectArray.every(required((await cli('work')).result.work.items), item => item.status === 'resolved'),
      ).toBe(true);
      expect((await cli('inspect')).result.collector.alive).toBe(false);
      expect(await readFile(counter, 'utf8')).toBe(requests);
      return;
    }
    expect(initial.collector.alive).toBe(true);
    const firstPid = required(initial.collector.pid);
    owned.add(firstPid);
    let candidate: Delivery | null | undefined;
    const deadline = Date.now() + 10_000;
    do {
      const waited = (await cli('wait', {...consumer, timeoutSeconds: 1})).result;
      candidate = waited.delivery;
    } while (!candidate && Date.now() < deadline);
    const delivery = required(candidate);
    expect(delivery).toBeTruthy();
    expect(EffectArray.map(delivery.events, event => event.kind).sort()).toEqual([
      'ci_error',
      'comment',
      'review_thread',
    ]);
    const requests = await readFile(counter, 'utf8');
    const duplicate = await cli('start', start, false);
    expect(duplicate.exitCode).not.toBe(0);
    expect(duplicate.stdout + duplicate.stderr).toContain('collector-busy');
    expect((await cli('inspect')).result.collector.pid).toBe(firstPid);
    expect(await readFile(counter, 'utf8')).toBe(requests);
    const replay = (await cli('relay', consumer)).result.delivery;
    expect(replay).toEqual(delivery);
    const premature = await cli('ack', {...consumer, deliveryId: delivery.id}, false);
    expect(premature.exitCode).not.toBe(0);
    expect((await cli('relay', consumer)).result.delivery).toEqual(delivery);
    expect(await readFile(counter, 'utf8')).toBe(requests);
    if (eventDriven) {
      await notified(1);
      const receiptDeadline = Date.now() + 10_000;
      let notifiedThrough = (await cli('inspect')).result.notification?.notifiedThrough ?? 0;
      while (notifiedThrough < 3 && Date.now() < receiptDeadline)
        notifiedThrough = (await cli('inspect')).result.notification?.notifiedThrough ?? 0;
      expect(notifiedThrough).toBe(3);
    }
    process.kill(firstPid, 'SIGKILL');
    await dead(firstPid);
    owned.delete(firstPid);
    const restarted = (await cli('start', start)).result;
    const nextPid = required(restarted.collector.pid);
    owned.add(nextPid);
    expect(restarted.collector.alive).toBe(true);
    expect(nextPid).not.toBe(firstPid);
    const restartDeadline = Date.now() + 10_000;
    let sweep = (await cli('inspect')).result;
    while (sweep.metrics.sweeps < 2 && Date.now() < restartDeadline) sweep = (await cli('inspect')).result;
    expect(sweep.metrics.sweeps).toBe(2);
    const restartRequests = await readFile(counter, 'utf8');
    expect((await cli('relay', consumer)).result.delivery).toEqual(delivery);
    const largeEvent = required(
      Fn.pipe(
        EffectArray.findFirst(delivery.events, event => event.kind === 'ci_error'),
        EffectOption.getOrUndefined,
      ),
    );
    const largeReason = Fn.pipe('界', EffectString.repeat(1024));
    const largeEvidence = Fn.pipe('語', EffectString.repeat(2048));
    const dispositions = EffectArray.map(delivery.events, event => ({
      eventId: event.id,
      status: 'open',
      reason: event.id === largeEvent.id ? largeReason : 'fixture needs follow-up',
      evidence: event.id === largeEvent.id ? largeEvidence : 'fixture lifecycle acceptance',
    }));
    await cli('disposition', {...consumer, deliveryId: delivery.id, dispositions});
    const acknowledged = (await cli('ack', {...consumer, deliveryId: delivery.id})).result;
    expect(acknowledged.pending).toBe(0);
    expect(acknowledged.work.open).toBe(3);
    expect((await cli('ack', {...consumer, deliveryId: delivery.id})).result.pending).toBe(0);
    const work = required((await cli('work')).result.work.items);
    expect(EffectArray.map(work, item => item.eventId).sort()).toEqual(
      EffectArray.map(dispositions, item => item.eventId).sort(),
    );
    const locator = required(
      required(
        Fn.pipe(
          EffectArray.findFirst(work, item => item.eventId === largeEvent.id),
          EffectOption.getOrUndefined,
        ),
      ).detail,
    );
    const beforeDetail = (await cli('inspect')).result.revision;
    const wrong = await cli(
      'work-detail',
      {eventId: locator.eventId, sourceDigest: Fn.pipe('f', EffectString.repeat(64))},
      false,
    );
    expect(wrong.exitCode).not.toBe(0);
    expect((await cli('inspect')).result.revision).toBe(beforeDetail);
    let offsetBytes = 0;
    let text = '';
    for (;;) {
      const page = (
        await cli('work-detail', {eventId: locator.eventId, sourceDigest: locator.sourceDigest, offsetBytes})
      ).result.workDetail;
      expect(page.sourceDigest).toBe(locator.sourceDigest);
      expect(new TextEncoder().encode(page.text).byteLength).toBeLessThanOrEqual(3000);
      text += page.text;
      if (page.nextOffsetBytes === null) break;
      expect(page.nextOffsetBytes).toBeGreaterThan(offsetBytes);
      offsetBytes = page.nextOffsetBytes;
    }
    const retained = Schema.decodeUnknownSync(workRecordBoundary, {onExcessProperty: 'ignore'})(JSON.parse(text));
    expect(retained.reason).toBe(largeReason);
    expect(retained.evidence).toBe(largeEvidence);
    expect(retained.event).toEqual(largeEvent);
    expect(retained.event.source).toBe('checks');
    expect(retained.event.key).toBe('2');
    expect(retained.event.url).toBe('https://github.com/fixture/repo/pull/1/checks?check_run_id=2');
    expect(retained.event.head).toBe(head);
    expect(
      EffectArray.every(
        EffectArray.filter(work, item => item.eventId !== largeEvent.id),
        item => item.reason === 'fixture needs follow-up' && item.evidence === 'fixture lifecycle acceptance',
      ),
    ).toBe(true);
    expect((await cli('inspect')).result.revision).toBe(beforeDetail);
    await cli('work-disposition', {
      ...consumer,
      dispositions: EffectArray.map(dispositions, item => ({...item, status: 'resolved', reason: 'fixture addressed'})),
    });
    expect(EffectArray.every(required((await cli('work')).result.work.items), item => item.status === 'resolved')).toBe(
      true,
    );
    expect(await readFile(counter, 'utf8')).toBe(restartRequests);
    if (eventDriven) {
      await notified(1);
      expect((await hostCalls())[0][4]).toContain(JSON.stringify(home));
    }
    await cli('stop');
    await dead(nextPid);
    owned.delete(nextPid);
    const stopped = (await cli('inspect')).result;
    expect(stopped.collector.alive).toBe(false);
    expect(stopped.stopRequested).toBe(true);
    if (eventDriven) await notified(2);
  } finally {
    // The private fixture state is also authoritative if startup failed after spawning.
    try {
      const state = decodeNativeWatchEnvelope(
        JSON.parse(await readFile(join(home, 'workflow-automations', 'native-watch-v1', 'fixture-watch.json'), 'utf8')),
      );
      if (state.collector && state.collector.pid > 0) owned.add(state.collector.pid);
    } catch {
      // Missing private state means startup never recorded an owned collector.
    }
    for (const pid of owned) {
      try {
        await cli('stop');
        await dead(pid);
      } catch {
        if (alive(pid)) {
          process.kill(pid, 'SIGKILL');
          await dead(pid);
        }
      }
    }
    await rm(root, {recursive: true, force: true});
  }
}
it(
  'recovers a real collector after a crash and preserves delivery and durable work',
  () => realCollectorScenario(false),
  60_000,
);
it(
  'accepts a fast terminal first sweep and retains its relay and acknowledged work',
  () => realCollectorScenario(true),
  60_000,
);

it(
  'keeps event delivery gated across real collector crash/restart and sends stop before exit',
  () => realCollectorScenario(false, true),
  60_000,
);
it(
  'sends terminal event notification before the real collector exits',
  () => realCollectorScenario(true, true),
  60_000,
);

import {it as effectIt} from '@effect/vitest';
import * as Effect from 'effect/Effect';
import * as FileSystem from 'effect/FileSystem';
import * as Schema from 'effect/Schema';
import * as EffectString from 'effect/String';
import {provideTestLayer} from '../helpers/effect-layer.js';
import * as TestClock from 'effect/testing/TestClock';
import * as BunServices from '@effect/platform-bun/BunServices';
import {CommandExecutor} from '@threadnote/platform/command';
import {SystemInfo} from '@threadnote/platform/system';

import {initializeNativeWatch} from '@threadnote/workflow-automations/watch';
import {
  decodeNativeWatchEnvelope,
  readNativeWatch,
  writeNativeWatch,
} from '../../src/workflow_automation/watch_store.js';
import {launchNativeWatchProcess} from '../../src/workflow_automation/watch_process.js';
import * as Fn from 'effect/Function';

effectIt.effect('startup failure sets stop only for its current nonce and preserves queued state', () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped({prefix: 'native-watch-startup-'});
    const config = runtimeConfigForTest({agentContextHome: home});
    const token = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
    const envelope = decodeNativeWatchEnvelope({
      format: 'threadnote-native-watch-runtime',
      version: 1,
      state: initializeNativeWatch('fixture-watch', 'https://github.com/fixture/repo/pull/1', 0),
      provider: {pages: []},
      collector: {token, pid: 0, startedAt: 0, lastSeenAt: 0, nextPollAt: 0, status: 'starting', consecutiveErrors: 0},
      stopRequested: false,
      metrics: {
        requests: 0,
        notModified: 0,
        responseBytes: 0,
        graphqlCost: 0,
        providerMilliseconds: 0,
        sweeps: 0,
        consumerReads: 0,
      },
    });
    yield* writeNativeWatch(config, envelope, null);
    const old = yield* launchNativeWatchProcess(config, 'fixture-watch', 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb').pipe(
      Effect.result,
    );
    expect(old._tag).toBe('Failure');
    expect((yield* readNativeWatch(config, 'fixture-watch'))!.envelope.stopRequested).toBe(false);
    const same = yield* launchNativeWatchProcess(config, 'fixture-watch', token).pipe(Effect.result);
    expect(same._tag).toBe('Failure');
    const failed = (yield* readNativeWatch(config, 'fixture-watch'))!.envelope;
    expect(failed.stopRequested).toBe(true);
    expect(failed.state).toEqual(envelope.state);
    expect(failed.collector?.token).toBe(token);
  }).pipe(
    Effect.provideService(CommandExecutor, {
      spawnDetached: () => Effect.succeed(false),
    } as unknown),
    Effect.provideService(SystemInfo, {
      executablePath: process.execPath,
      developmentEntrypoint: 'trusted.ts',
      environment: () => ({}),
      processId: process.pid,
      isProcessRunning: (pid: number) => pid === process.pid,
      canonicalProcessStartIdentity: () => Effect.void,
      processStartIdentity: () => Effect.void,
    } as unknown),
    provideTestLayer(BunServices.layer),
    TestClock.withLive,
  ),
);

effectIt.effect('accepts only the current nonce terminal receipt after its process already exited', () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped({prefix: 'native-watch-terminal-launch-'});
    const config = runtimeConfigForTest({agentContextHome: home});
    const token = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
    const state = initializeNativeWatch('fixture-watch', 'https://github.com/fixture/repo/pull/1', 0);
    const envelope = decodeNativeWatchEnvelope({
      format: 'threadnote-native-watch-runtime',
      version: 1,
      state: {...state, prState: 'merged'},
      provider: {pages: []},
      collector: {
        token,
        pid: 123,
        startedAt: 0,
        lastSeenAt: 0,
        nextPollAt: 0,
        status: 'terminal',
        reason: 'merged',
        consecutiveErrors: 0,
      },
      stopRequested: false,
      metrics: {
        requests: 0,
        notModified: 0,
        responseBytes: 0,
        graphqlCost: 0,
        providerMilliseconds: 0,
        sweeps: 1,
        consumerReads: 0,
      },
    });
    yield* writeNativeWatch(config, envelope, null);
    expect(yield* launchNativeWatchProcess(config, 'fixture-watch', token)).toEqual({pid: 123, token});
    const stale = yield* launchNativeWatchProcess(config, 'fixture-watch', 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb').pipe(
      Effect.result,
    );
    expect(stale._tag).toBe('Failure');
    const current = required(yield* readNativeWatch(config, 'fixture-watch'));
    expect(current.envelope.stopRequested).toBe(false);
    expect(current.envelope.collector?.token).toBe(token);
  }).pipe(
    Effect.provideService(CommandExecutor, {
      spawnDetached: () => Effect.succeed(true),
    } as unknown),
    Effect.provideService(SystemInfo, {
      executablePath: process.execPath,
      developmentEntrypoint: 'trusted.ts',
      environment: () => ({}),
      processId: process.pid,
      isProcessRunning: () => false,
      canonicalProcessStartIdentity: () => Effect.void,
      processStartIdentity: () => Effect.void,
    } as unknown),
    provideTestLayer(BunServices.layer),
    TestClock.withLive,
  ),
);
