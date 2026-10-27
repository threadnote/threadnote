import {it as effectIt} from '@effect/vitest';
import * as BunFileSystem from '@effect/platform-bun/BunFileSystem';
import * as BunPath from '@effect/platform-bun/BunPath';
import * as BunCrypto from '@effect/platform-bun/BunCrypto';
import {Cause, Effect, Fiber, FileSystem, Layer, Path, Queue, Stream} from 'effect';
import {TestClock} from 'effect/testing';
import {describe, expect, it} from 'vitest';
import fc from 'fast-check';
import {ChildEnvironmentPolicy} from '@threadnote/platform/child-environment-policy';
import {SystemInfo} from '@threadnote/platform/system';
import {makeSemanticAdmission} from '../../src/semantic/coordinator.js';
import {TestSystemInfoLayer} from '../helpers/system-layer.js';
import {
  LspFrameDecoder,
  LspFault,
  encodeLspFrame,
  makeLspClient,
  spawnLspWire,
  type LspWire,
} from '../../src/semantic/lsp_transport.js';

type Message = Parameters<LspWire['send']>[0];
const fakeWire = Effect.gen(function* () {
  const incoming = yield* Queue.bounded<Message, Cause.Done>(64);
  const sent = yield* Queue.bounded<Message>(128);
  let finishes = 0;
  const wire: LspWire = {
    pid: 1,
    messages: Stream.fromQueue(incoming),
    failure: () => undefined,
    beginClosing: Effect.void,
    send: message =>
      Effect.sync(() => {
        if (message.method === 'shutdown') Queue.offerUnsafe(incoming, {jsonrpc: '2.0', id: message.id, result: null});
        else Queue.offerUnsafe(sent, message);
      }),
    finish: Effect.gen(function* () {
      finishes++;
      yield* Queue.end(incoming);
      return {code: 0, drained: true, forced: false, stdioClosed: true, fault: undefined};
    }),
  };
  return {wire, sent, incoming, finishes: () => finishes};
});

const admissionLayer = Layer.mergeAll(BunFileSystem.layer, BunPath.layer, BunCrypto.layer, TestSystemInfoLayer);
const admissionFixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* fs.makeTempDirectoryScoped({prefix: 'semantic-admission-'});
  const directory = path.join(yield* fs.realPath(home), 'semantic');
  const first = yield* makeSemanticAdmission({directory});
  const second = yield* makeSemanticAdmission({directory});
  return {first, second, fs, path, directory};
});
describe.skipIf(process.platform === 'win32')('shared semantic admission', () => {
  effectIt.effect(
    'enforces the aggregate provider cap and preserves monotonic generations after release',
    () =>
      Effect.gen(function* () {
        const {first, second} = yield* admissionFixture;
        const held = [];
        for (let i = 0; i < 8; i++) {
          const reservation = yield* (i % 2 ? first : second).acquire((i < 4 ? 'a' : 'b').repeat(64), 2000);
          yield* reservation.finishImport;
          held.push(reservation);
        }
        expect(yield* first.acquire('c'.repeat(64), 100).pipe(Effect.flip)).toMatchObject({code: 'timeout'});
        expect(yield* second.status).toMatchObject({providers: 8, imports: 0, queued: 0});
        const generation = held.at(-1)!.generation;
        for (const reservation of held) yield* reservation.release(true);
        const next = yield* second.acquire('c'.repeat(64), 2000);
        expect(next.generation).toBeGreaterThan(generation);
        yield* next.release(true);
      }).pipe(
        // oxlint-disable-next-line effecttsgo/strict-effect-provide -- Narrow filesystem/process lease test entrypoint.
        Effect.provide(admissionLayer),
        TestClock.withLive,
      ),
    10000,
  );

  effectIt.effect(
    'never reclaims an uncertain instance and quarantines an unregistered child after owner reuse',
    () =>
      Effect.gen(function* () {
        const {fs, path, directory} = yield* admissionFixture;
        const system = yield* SystemInfo;
        let observed: string | undefined = 'known-instance';
        const admission = yield* makeSemanticAdmission({directory, processGroupPresent: () => false}).pipe(
          Effect.provideService(SystemInfo, {
            ...system,
            isProcessRunning: () => true,
            canonicalProcessStartIdentity: () => Effect.succeed(observed),
          }),
        );
        const reservation = yield* admission.acquire('a'.repeat(64), 2000);
        observed = undefined;
        expect(yield* admission.status).toMatchObject({providers: 1, quarantined: 0});
        observed = 'new-instance';
        expect(yield* admission.status).toMatchObject({providers: 1, quarantined: 1});
        const ledger = JSON.parse(yield* fs.readFileString(path.join(directory, 'admission-v1.json')));
        expect(ledger.slots[0].owner.identity).toBe('known-instance');
        yield* reservation.release(false);
      }).pipe(
        // oxlint-disable-next-line effecttsgo/strict-effect-provide -- Narrow filesystem/process lease test entrypoint.
        Effect.provide(admissionLayer),
        TestClock.withLive,
      ),
    10000,
  );

  effectIt.effect(
    'bounds imports across two worktree coordinators and releases FIFO capacity',
    () =>
      Effect.gen(function* () {
        const {first, second} = yield* admissionFixture;
        const a = yield* first.acquire('a'.repeat(64), 2000);
        const b = yield* second.acquire('b'.repeat(64), 2000);
        const waiting = yield* Effect.forkChild(second.acquire('c'.repeat(64), 2000));
        yield* Effect.sleep(50);
        expect(yield* first.status).toMatchObject({providers: 2, imports: 2, queued: 1});
        yield* a.finishImport;
        const c = yield* Fiber.join(waiting);
        expect(yield* second.status).toMatchObject({providers: 3, imports: 2, queued: 0});
        yield* Effect.all([a.release(true), b.release(true), c.release(true)], {concurrency: 3});
        expect(yield* first.status).toMatchObject({providers: 0, imports: 0, queued: 0});
      }).pipe(
        // oxlint-disable-next-line effecttsgo/strict-effect-provide -- Narrow filesystem/process lease test entrypoint.
        Effect.provide(admissionLayer),
        TestClock.withLive,
      ),
    10000,
  );

  effectIt.effect(
    'lets an unrelated workspace pass a saturated workspace and removes cancelled tickets',
    () =>
      Effect.gen(function* () {
        const {first, second} = yield* admissionFixture;
        const held = [];
        for (let i = 0; i < 4; i++) {
          const reservation = yield* first.acquire('a'.repeat(64), 2000);
          yield* reservation.finishImport;
          held.push(reservation);
        }
        const blocked = yield* Effect.forkChild(first.acquire('a'.repeat(64), 2000));
        yield* Effect.sleep(50);
        const unrelated = yield* second.acquire('b'.repeat(64), 2000);
        expect(yield* second.status).toMatchObject({providers: 5, queued: 1});
        yield* Fiber.interrupt(blocked);
        expect(yield* first.status).toMatchObject({providers: 5, queued: 0});
        yield* unrelated.release(true);
        for (const reservation of held) yield* reservation.release(true);
      }).pipe(
        // oxlint-disable-next-line effecttsgo/strict-effect-provide -- Narrow filesystem/process lease test entrypoint.
        Effect.provide(admissionLayer),
        TestClock.withLive,
      ),
    10000,
  );

  effectIt.effect(
    'keeps uncertain cleanup occupied and refuses corrupt ledgers',
    () =>
      Effect.gen(function* () {
        const {first, second, fs, path, directory} = yield* admissionFixture;
        const reservation = yield* first.acquire('a'.repeat(64), 2000);
        yield* reservation.release(false);
        expect(yield* second.status).toMatchObject({providers: 1, imports: 0, quarantined: 1});
        yield* fs.writeFileString(path.join(directory, 'admission-v1.json'), '{', {mode: 0o600});
        expect(yield* second.status.pipe(Effect.flip)).toMatchObject({code: 'protocol'});
        expect(yield* fs.readFileString(path.join(directory, 'admission-v1.json'))).toBe('{');
      }).pipe(
        // oxlint-disable-next-line effecttsgo/strict-effect-provide -- Narrow filesystem/process lease test entrypoint.
        Effect.provide(admissionLayer),
        TestClock.withLive,
      ),
    10000,
  );
});

describe('semantic LSP framing', () => {
  it('preserves multiple Unicode frames under arbitrary chunk boundaries', () => {
    fc.assert(
      fc.property(
        fc.jsonValue(),
        fc.array(fc.integer({min: 1, max: 64}), {minLength: 1, maxLength: 20}),
        (value, widths) => {
          const expected = [
            {jsonrpc: '2.0', id: 1, method: 'query', params: {value, text: '🧵\r\n'}},
            {jsonrpc: '2.0', id: 1, result: value},
          ];
          const parts = expected.map(encodeLspFrame);
          const bytes = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
          let offset = 0;
          for (const part of parts) {
            bytes.set(part, offset);
            offset += part.length;
          }
          const decoder = new LspFrameDecoder();
          const actual: Message[] = [];
          for (let i = 0, part = 0; i < bytes.length; part++) {
            const end = Math.min(bytes.length, i + widths[part % widths.length]);
            actual.push(...decoder.push(bytes.subarray(i, end)));
            i = end;
          }
          decoder.finish();
          expect(actual).toEqual(JSON.parse(JSON.stringify(expected)));
        },
      ),
      {numRuns: 100},
    );
  });

  it.each([
    'Content-Length: 1\r\nContent-Length: 1\r\n\r\n0',
    'Content-Length: -1\r\n\r\n',
    'Content-Length: 9999999999999\r\n\r\n',
    'Content-Length: 2\r\n\r\n[]',
    'Content-Length: 1\r\n\r\n{',
  ])('rejects malformed frames', text => {
    expect(() => new LspFrameDecoder().push(new TextEncoder().encode(text))).toThrow();
  });
  it.each([
    {jsonrpc: '2.0', id: {}, result: null},
    {jsonrpc: '2.0', id: 1, method: 'query', result: null},
    {jsonrpc: '2.0', id: 1},
    {jsonrpc: '1.0', id: 1, result: null},
  ])('rejects ambiguous or invalid JSON-RPC envelopes', message => {
    expect(() => new LspFrameDecoder().push(encodeLspFrame(message))).toThrow(LspFault);
  });
  it('rejects incomplete frames at EOF and excessive headers', () => {
    const decoder = new LspFrameDecoder();
    decoder.push(new TextEncoder().encode('Content-Length: 30\r\n\r\n{'));
    expect(() => decoder.finish()).toThrow(LspFault);
    expect(() => new LspFrameDecoder().push(new Uint8Array(8193).fill(65))).toThrow(LspFault);
  });
});

describe('semantic LSP request lifecycle', () => {
  effectIt.effect('bounds cancellation even when the provider stops draining stdin', () =>
    Effect.gen(function* () {
      const fake = yield* fakeWire;
      let stalled = true;
      const client = yield* makeLspClient({
        ...fake.wire,
        send: message =>
          fake.wire.send(message).pipe(Effect.andThen(Effect.suspend(() => (stalled ? Effect.never : Effect.void)))),
      });
      const pending = yield* Effect.forkChild(client.request('slow', {}, 20).pipe(Effect.flip));
      expect((yield* Queue.take(fake.sent)).method).toBe('slow');
      yield* TestClock.adjust(20);
      expect((yield* Queue.take(fake.sent)).method).toBe('$/cancelRequest');
      yield* TestClock.adjust(100);
      expect(yield* Fiber.join(pending)).toMatchObject({code: 'timeout'});
      stalled = false;
      expect((yield* client.close).graceful).toBe(true);
    }),
  );

  effectIt.effect('correlates out-of-order responses without sharing pending requests', () =>
    Effect.gen(function* () {
      const fake = yield* fakeWire;
      const client = yield* makeLspClient(fake.wire);
      const first = yield* Effect.forkChild(client.request('first', {}, 1000));
      const a = yield* Queue.take(fake.sent);
      const second = yield* Effect.forkChild(client.request('second', {}, 1000));
      const b = yield* Queue.take(fake.sent);
      yield* Queue.offer(fake.incoming, {jsonrpc: '2.0', id: b.id, result: 'second'});
      yield* Queue.offer(fake.incoming, {jsonrpc: '2.0', id: a.id, result: 'first'});
      expect(yield* Fiber.join(first)).toBe('first');
      expect(yield* Fiber.join(second)).toBe('second');
    }),
  );

  effectIt.effect('expires one request, sends cancellation and ignores its late response', () =>
    Effect.gen(function* () {
      const fake = yield* fakeWire;
      const client = yield* makeLspClient(fake.wire);
      const old = yield* Effect.forkChild(client.request('old', {}, 100).pipe(Effect.flip));
      const a = yield* Queue.take(fake.sent);
      yield* TestClock.adjust(100);
      expect((yield* Fiber.join(old)).code).toBe('timeout');
      expect(yield* Queue.take(fake.sent)).toEqual({jsonrpc: '2.0', method: '$/cancelRequest', params: {id: a.id}});
      const current = yield* Effect.forkChild(client.request('current', {}, 1000));
      const b = yield* Queue.take(fake.sent);
      yield* Queue.offer(fake.incoming, {jsonrpc: '2.0', id: a.id, result: 'obsolete'});
      yield* Queue.offer(fake.incoming, {jsonrpc: '2.0', id: b.id, result: 'current'});
      expect(yield* Fiber.join(current)).toBe('current');
    }),
  );

  effectIt.effect('releases bounded pending slots after interruption', () =>
    Effect.gen(function* () {
      const fake = yield* fakeWire;
      const client = yield* makeLspClient(fake.wire);
      const fibers = [];
      for (let i = 0; i < 32; i++) {
        fibers.push(yield* Effect.forkChild(client.request('hold', {}, 1000)));
        yield* Queue.take(fake.sent);
      }
      expect((yield* client.request('overflow', {}, 1000).pipe(Effect.flip)).code).toBe('capacity');
      yield* Effect.forEach(fibers, fiber => Fiber.interrupt(fiber), {concurrency: 'unbounded'});
      for (let i = 0; i < 32; i++) expect((yield* Queue.take(fake.sent)).method).toBe('$/cancelRequest');
      const next = yield* Effect.forkChild(client.request('next', {}, 1000));
      const message = yield* Queue.take(fake.sent);
      yield* Queue.offer(fake.incoming, {jsonrpc: '2.0', id: message.id, result: true});
      expect(yield* Fiber.join(next)).toBe(true);
    }),
  );

  effectIt.effect('denies provider edits and performs shutdown exactly once', () =>
    Effect.gen(function* () {
      const fake = yield* fakeWire;
      const client = yield* makeLspClient(fake.wire);
      yield* Queue.offer(fake.incoming, {
        jsonrpc: '2.0',
        id: 'server-1',
        method: 'workspace/applyEdit',
        params: {edit: {}},
      });
      expect(yield* Queue.take(fake.sent)).toMatchObject({id: 'server-1', result: {applied: false}});
      const results = yield* Effect.all([client.close, client.close], {concurrency: 2});
      expect(results.every(result => result.graceful)).toBe(true);
      expect(fake.finishes()).toBe(1);
      expect((yield* Queue.take(fake.sent)).method).toBe('exit');
      expect((yield* client.request('late', {}, 1000).pipe(Effect.flip)).code).toBe('closing');
    }),
  );
});

describe.skipIf(process.platform === 'win32')('semantic real process transport', () => {
  effectIt.effect.each([
    {mode: '', graceful: true},
    {mode: 'panic-on-exit', graceful: false},
    {mode: 'close-input-on-shutdown', graceful: false},
  ])(
    'observes actual owned process cleanup for $mode',
    ({mode, graceful}) =>
      Effect.gen(function* () {
        const wire = yield* spawnLspWire({
          command: process.execPath,
          args: ['apps/threadnote/test/fixtures/semantic/fake-provider.ts', mode],
          cwd: process.cwd(),
          environment: process.env,
        });
        const client = yield* makeLspClient(wire);
        expect(yield* client.request('echo', {text: '🧵\r\n'}, 1000)).toEqual({text: '🧵\r\n'});
        const stopped = yield* client.close;
        expect(stopped.graceful).toBe(graceful);
        expect(stopped.drained).toBe(true);
        expect(stopped.stdioClosed).toBe(true);
      }).pipe(
        TestClock.withLive,
        Effect.provideService(ChildEnvironmentPolicy, {
          sanitizeExternal: environment =>
            Object.fromEntries(
              Object.entries(environment).filter(([key]) =>
                ['PATH', 'TMPDIR', 'LANG', 'SYSTEMROOT', 'SystemRoot', 'WINDIR'].includes(key),
              ),
            ),
          preserveIntendedChild: environment => environment,
        }),
      ),
    15_000,
  );
});
