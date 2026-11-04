import {describe, expect, it} from '@effect/vitest';
import {
  Array as EffectArray,
  Cause,
  Deferred,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Layer,
  Path,
  Schema,
  String as EffectString,
} from 'effect';
import {TestClock} from 'effect/testing';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {memoryLaunchUri} from '@threadnote/memory/navigation-link';
import {ApplicationLayer} from '../../src/effect/runtime.js';
import {createMemoryPreviewHandler, MemoryPreviewRead, runMemoryPreview} from '../../src/preview/server.js';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {readManagedMemory} from '../../src/manager/server.js';
import {DeferredCodeAnchorRefreshScheduler} from '../../src/memory/deferred/code_anchor_scheduler.js';
import {recordMemoryRelocation} from '@threadnote/memory/relocation';
import {parseMemoryDocument} from '@threadnote/memory/document';
import {sha256Hex} from '@threadnote/platform/digest';
import {resolvePreviewMemoryIdentity} from '../../src/manager/memory/read.js';

const origin = 'http://127.0.0.1:41377';
const token = 'private-test-token';
const node = {
  isDir: false,
  isShared: false,
  isSystem: false,
  name: 'preview.md',
  relativePath: 'durable/projects/test/preview.md',
  uri: 'threadnote://user/alice/memories/durable/projects/test/preview.md',
};

describe('fixed-target memory preview HTTP handler', () => {
  it('re-reads the fixed memory on each authorized reload and never caches unavailable content', async () => {
    let content = '# Original';
    let reads = 0;
    const handler = createMemoryPreviewHandler({
      token,
      port: () => 41377,
      read: async () => {
        reads++;
        if (!content) throw new Error('missing');
        return {content, node};
      },
    });
    const request = () => new Request(`${origin}/`, {headers: {cookie: `threadnote_preview_41377=${token}`}});
    const read = async () => {
      expect((await handler(request())).status).toBe(202);
      await new Promise(resolve => setTimeout(resolve, 0));
      return handler(request());
    };
    const first = await read();
    expect(first.status).toBe(200);
    expect(await first.text()).toContain('Original');
    content = '# Changed';
    const second = await read();
    expect(await second.text()).toContain('Changed');
    expect(second.headers.get('Cache-Control')).toContain('no-store');
    expect(second.headers.get('Content-Security-Policy')).toContain("default-src 'none'");
    content = '';
    const third = await read();
    expect(third.status).toBe(404);
    expect(await third.text()).not.toContain('Changed');
    expect(reads).toBe(3);
  });

  it('rejects other paths, origins, methods, and cross-site requests before reading', async () => {
    let reads = 0;
    const handler = createMemoryPreviewHandler({
      token,
      port: () => 41377,
      read: async () => {
        reads++;
        return {content: '# Hidden', node};
      },
    });
    const requests = [
      new Request(`${origin}/wrong`),
      new Request(`${origin}/${token}?uri=threadnote://memory/tn_other`),
      new Request(`http://example.test:41377/${token}`),
      new Request(`${origin}/${token}`, {method: 'POST'}),
      new Request(`${origin}/${token}`, {headers: {Origin: 'https://evil.example'}}),
      new Request(`${origin}/${token}`, {headers: {'Sec-Fetch-Site': 'cross-site'}}),
    ];
    for (const request of requests) {
      const response = await handler(request);
      expect(response.status).toBe(404);
      expect(await response.text()).not.toContain('Hidden');
    }
    expect(reads).toBe(0);
  });

  it('bootstraps from a fragment, clears it, and reloads with a private session', async () => {
    let content = '# First';
    const handler = createMemoryPreviewHandler({
      token,
      port: () => 41377,
      read: async () => ({content, node}),
    });
    const bootstrap = await handler(new Request(`${origin}/`));
    const markup = await bootstrap.text();
    expect(markup).toContain('history.replaceState');
    expect(markup).toContain("fetch('/session'");
    expect(markup).not.toContain(token);
    const post = (secret: string, originHeader = origin) =>
      handler(
        new Request(`${origin}/session`, {
          method: 'POST',
          headers: {
            origin: originHeader,
            'sec-fetch-site': 'same-origin',
            'content-type': 'text/plain',
            'content-length': String(token.length),
          },
          body: secret,
        }),
      );
    expect((await post(token, 'https://evil.example')).status).toBe(404);
    expect((await post('wrong-test-token!')).status).toBe(404);
    const established = await post(token);
    expect(established.status).toBe(204);
    const cookie = established.headers.get('set-cookie') ?? '';
    expect(cookie).toContain('HttpOnly; SameSite=Strict');
    const request = () => new Request(`${origin}/`, {headers: {cookie: EffectString.split(';')(cookie)[0]}});
    expect((await handler(request())).status).toBe(202);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(await (await handler(request())).text()).toContain('First');
    content = '# Updated';
    expect((await handler(request())).status).toBe(202);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(await (await handler(request())).text()).toContain('Updated');
  });

  it('limits concurrent authorized reads', async () => {
    let finish!: (value: {content: string; node: typeof node}) => void;
    const handler = createMemoryPreviewHandler({
      token,
      port: () => 41377,
      read: () =>
        new Promise(resolve => {
          finish = resolve;
        }),
    });
    const request = () => new Request(`${origin}/`, {headers: {cookie: `threadnote_preview_41377=${token}`}});
    expect((await handler(request())).status).toBe(202);
    await new Promise(resolve => setTimeout(resolve, 0));
    const pending = handler(request());
    const busy = await handler(request());
    expect(busy.status).toBe(503);
    expect(busy.headers.get('retry-after')).toBe('1');
    expect(await busy.text()).toContain('reload this page');
    finish({content: '# First', node});
    expect((await pending).status).toBe(200);
  });

  it('polls one scan without returning content before it completes', async () => {
    let finish!: (read: () => Promise<{content: string; node: typeof node}>) => void;
    let starts = 0;
    let touches = 0;
    const handler = createMemoryPreviewHandler({
      token,
      port: () => 41377,
      touched: () => {
        touches++;
      },
      prepare: () => {
        starts++;
        return new Promise(resolve => {
          finish = resolve;
        });
      },
    });
    const request = () => new Request(`${origin}/`, {headers: {cookie: `threadnote_preview_41377=${token}`}});
    const first = await handler(request());
    expect(first.status).toBe(202);
    expect(first.headers.get('cache-control')).toContain('no-store');
    expect(await first.text()).toContain('retry automatically');
    await Promise.resolve();
    expect((await handler(request())).status).toBe(202);
    expect(starts).toBe(1);
    expect(touches).toBe(2);
    finish(async () => ({content: '# Ready', node}));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(await (await handler(request())).text()).toContain('Ready');
    expect((await handler(request())).status).toBe(202);
  });
});

it('rejects raw preview flags before parsing the selector or configuration', async () => {
  const secret = 'secret-example';
  const child = Bun.spawn(
    [
      process.execPath,
      'apps/threadnote/src/standalone.ts',
      'memory-preview',
      `threadnote://open/v1#${secret}`,
      '--manifest',
      '/tmp/threadnote-preview-nonexistent-manifest.yaml',
      '--home',
      '/tmp/threadnote-preview-nonexistent-home',
    ],
    {stdout: 'pipe', stderr: 'pipe'},
  );
  const [output, error, exit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(exit).not.toBe(0);
  expect(error).toContain('Invalid memory preview invocation');
  expect(error).toContain('Retry the memory link');
  expect(error).toContain('threadnote memory-preview <launch-uri>');
  expect(error).toContain('exactly one launch URI');
  expect(output + error).not.toContain(secret);
  expect(output + error).not.toContain('nonexistent');
  const valid = memoryLaunchUri({kind: 'id', ref: 'tn_test'});
  for (const args of [
    ['memory-preview', valid, '--home', '/tmp/threadnote-preview-nonexistent-home'],
    ['--home', '/tmp/threadnote-preview-nonexistent-home', 'memory-preview', valid],
  ]) {
    const process = Bun.spawn([globalThis.process.execPath, 'apps/threadnote/src/standalone.ts', ...args], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [stdout, stderr, status] = await Promise.all([
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
      process.exited,
    ]);
    expect(status).not.toBe(0);
    expect(stdout + stderr).toContain('Invalid memory preview invocation');
    expect(stderr).toContain('Retry the memory link');
    expect(stderr).toContain('exactly one launch URI');
    expect(stdout + stderr).not.toContain(valid);
  }
});

const launchUri = memoryLaunchUri({kind: 'id', ref: 'tn_startup_test'});
const unusedConfig: RuntimeConfig = {
  account: 'local',
  agentContextHome: '/tmp/threadnote-preview-startup-test',
  agentId: 'threadnote',
  manifestPath: '/tmp/threadnote-preview-startup-test/seed-manifest.yaml',
  user: 'tester',
};
const provide = provideTestLayer(
  Layer.merge(
    ApplicationLayer,
    Layer.succeed(MemoryPreviewRead, {
      prepare: async () => {
        throw new Error('unused');
      },
    }),
  ),
);

it.effect('redacts malformed decoded selectors from the formatted CLI cause', () =>
  Effect.gen(function* () {
    const payload = Buffer.from(JSON.stringify({kind: 'uri', ref: 'secret-example'})).toString('base64url');
    const exit = yield* runMemoryPreview(unusedConfig, `threadnote://open/v1#v1.${payload}`).pipe(Effect.exit);
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) expect(Cause.pretty(exit.cause)).not.toContain('secret-example');
  }).pipe(provide),
);

it.effect('reads live stable identities without creating a recall index and fails closed on conflicts', () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = yield* fs.makeTempDirectoryScoped({prefix: 'preview-identity-'});
    const config = {...unusedConfig, agentContextHome: home};
    const root = path.join(home, 'data', 'local', 'user', 'tester', 'memories');
    yield* fs.makeDirectory(root, {recursive: true});
    const source = path.join(root, 'first.md');
    const shared = path.join(root, 'shared', 'team');
    yield* fs.makeDirectory(shared, {recursive: true});
    const moved = path.join(shared, 'moved.md');
    const content = (body: string) =>
      `MEMORY\nkind: durable\nstatus: active\nvisibility: personal\nproject: test\ntopic: test\nmemory_id: tn_preview_test\n\n${body}\n`;
    yield* fs.writeFileString(source, content('Original'));
    const alias = 'threadnote://memory/tn_preview_test';
    let scheduled = 0;
    const read = () =>
      readManagedMemory(config, alias, {preview: true}).pipe(
        Effect.provideService(DeferredCodeAnchorRefreshScheduler, {
          schedule: () =>
            Effect.sync(() => {
              scheduled++;
            }),
        }),
      );
    const before = yield* fs.readFileString(source);
    const first = yield* read();
    expect(first.node.uri).toBe('threadnote://user/tester/memories/first.md');
    expect(first.content).toContain('Original');
    expect(yield* fs.readFileString(source)).toBe(before);
    expect(yield* fs.readDirectory(home)).toEqual(['data']);
    yield* fs.rename(source, moved);
    yield* fs.writeFileString(moved, content('Changed'));
    const second = yield* read();
    expect(second.node.uri).toBe('threadnote://user/tester/memories/shared/team/moved.md');
    expect(second.node.isShared).toBe(true);
    expect(second.content).toContain('Changed');
    yield* fs.writeFileString(source, content('Conflict'));
    expect(Exit.isFailure(yield* Effect.exit(read()))).toBe(true);
    yield* fs.remove(source);
    yield* fs.remove(moved);
    expect(Exit.isFailure(yield* Effect.exit(read()))).toBe(true);
    expect(yield* fs.readDirectory(home)).toEqual(['data']);
    expect(yield* fs.readDirectory(root)).toEqual(['shared']);
    expect(scheduled).toBe(0);
  }).pipe(provide),
);

it.effect('excludes oversized and packed files without hiding eligible memories', () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = yield* fs.makeTempDirectoryScoped({prefix: 'preview-eligibility-'});
    const config = {...unusedConfig, agentContextHome: home};
    const root = path.join(home, 'data', 'local', 'user', 'tester', 'memories');
    const packs = path.join(root, 'agent-artifacts', 'packs', 'example');
    yield* fs.makeDirectory(packs, {recursive: true});
    const document = (id: string, body = 'content') =>
      `MEMORY\nkind: durable\nstatus: active\nmemory_id: ${id}\n\n${body}\n`;
    yield* fs.writeFileString(path.join(root, 'active.md'), document('tn_live'));
    yield* fs.writeFileString(path.join(root, 'large.md'), document('tn_large', EffectString.repeat(512 * 1024)('x')));
    yield* fs.writeFileString(path.join(packs, 'duplicate.md'), document('tn_live'));
    yield* fs.writeFileString(path.join(packs, 'only.md'), document('tn_packed'));
    expect((yield* readManagedMemory(config, 'threadnote://memory/tn_live', {preview: true})).content).toContain(
      'tn_live',
    );
    expect(
      Exit.isFailure(yield* Effect.exit(readManagedMemory(config, 'threadnote://memory/tn_large', {preview: true}))),
    ).toBe(true);
    expect(
      Exit.isFailure(yield* Effect.exit(readManagedMemory(config, 'threadnote://memory/tn_packed', {preview: true}))),
    ).toBe(true);
  }).pipe(provide),
);

it.effect('resolves a small identity and detects conflicts beyond 16 MiB of unrelated eligible files', () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = yield* fs.makeTempDirectoryScoped({prefix: 'preview-budget-'});
    const root = path.join(home, 'data', 'local', 'user', 'tester', 'memories');
    yield* fs.makeDirectory(root, {recursive: true});
    const body = EffectString.repeat(512 * 1024 - 100)('x');
    for (let index = 0; index < 34; index++)
      yield* fs.writeFileString(
        path.join(root, `${index}.md`),
        `MEMORY\nkind: durable\nstatus: active\nmemory_id: tn_other_${index}\n\n${body}`,
      );
    const config = {...unusedConfig, agentContextHome: home};
    const target = path.join(root, 'target.md');
    yield* fs.writeFileString(target, 'MEMORY\nkind: durable\nstatus: active\nmemory_id: tn_target\n\nTiny target\n');
    const read = () => readManagedMemory(config, 'threadnote://memory/tn_target', {preview: true});
    expect((yield* read()).content).toContain('Tiny target');
    let slices = 0;
    const resolved = yield* resolvePreviewMemoryIdentity(config, 'threadnote://memory/tn_target', {
      entriesPerSlice: 2,
      bytesPerSlice: 16384,
      yieldNow: () =>
        Effect.sync(() => {
          slices++;
        }),
    });
    expect(resolved.canonicalUri).toContain('target.md');
    expect(slices).toBeGreaterThan(2);
    yield* fs.writeFileString(
      path.join(root, '32.md'),
      'MEMORY\nkind: durable\nstatus: active\nmemory_id: tn_target\n\nConflict\n',
    );
    expect(Exit.isFailure(yield* Effect.exit(read()))).toBe(true);
    let visited = 0;
    const lateConflict = yield* Effect.exit(
      resolvePreviewMemoryIdentity(config, 'threadnote://memory/tn_target', {
        directoryNames: async function* () {
          yield 'target.md';
          for (let index = 0; index < 34; index++) {
            if (index === 32) continue;
            visited++;
            yield `${index}.md`;
          }
          yield '32.md';
        },
      }),
    );
    expect(Exit.isFailure(lateConflict)).toBe(true);
    expect(visited).toBe(33);
  }).pipe(provide),
);

it.effect('finds long CRLF headers and ignores identity-like body text', () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = yield* fs.makeTempDirectoryScoped({prefix: 'preview-header-'});
    const root = path.join(home, 'data', 'local', 'user', 'tester', 'memories');
    yield* fs.makeDirectory(root, {recursive: true});
    yield* fs.writeFileString(
      path.join(root, 'target.md'),
      `  MEMORY\r\nkind: durable\r\nnotes: ${EffectString.repeat(33000)('x')}\r\nmemory_id: tn_long\r\n\r\nBody`,
    );
    yield* fs.writeFileString(
      path.join(root, 'body.md'),
      'MEMORY\nkind: durable\nmemory_id: tn_other\n\nmemory_id: tn_long\n',
    );
    const result = yield* readManagedMemory({...unusedConfig, agentContextHome: home}, 'threadnote://memory/tn_long', {
      preview: true,
    });
    expect(result.node.name).toBe('target.md');
  }).pipe(provide),
);

it.effect('closes an active streamed directory when the scan is interrupted', () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = yield* fs.makeTempDirectoryScoped({prefix: 'preview-scan-cancel-'});
    const root = path.join(home, 'data', 'local', 'user', 'tester', 'memories');
    yield* fs.makeDirectory(root, {recursive: true});
    yield* fs.writeFileString(path.join(root, 'file.md'), 'MEMORY\nkind: durable\nmemory_id: tn_other\n\nBody');
    const entered = yield* Deferred.make<void>();
    let closed = false;
    const fiber = yield* resolvePreviewMemoryIdentity(
      {...unusedConfig, agentContextHome: home},
      'threadnote://memory/tn_target',
      {
        entriesPerSlice: 2,
        yieldNow: () => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
        directoryNames: async function* () {
          try {
            yield 'file.md';
            yield 'other.md';
          } finally {
            closed = true;
          }
        },
      },
    ).pipe(Effect.forkChild);
    yield* Deferred.await(entered);
    yield* Fiber.interrupt(fiber);
    expect(closed).toBe(true);
  }).pipe(provide),
);

it.effect('fails closed when a scanned directory changes between batches', () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = yield* fs.makeTempDirectoryScoped({prefix: 'preview-scan-change-'});
    const root = path.join(home, 'data', 'local', 'user', 'tester', 'memories');
    yield* fs.makeDirectory(root, {recursive: true});
    yield* fs.writeFileString(path.join(root, 'file.md'), 'MEMORY\nkind: durable\nmemory_id: tn_target\n\nBody');
    yield* fs.utimes(root, 0, 0);
    let changed = false;
    const result = yield* Effect.exit(
      resolvePreviewMemoryIdentity({...unusedConfig, agentContextHome: home}, 'threadnote://memory/tn_target', {
        entriesPerSlice: 2,
        yieldNow: () => {
          if (changed) return Effect.void;
          changed = true;
          return fs.writeFileString(path.join(root, 'new.md'), 'unrelated').pipe(Effect.orDie);
        },
      }),
    );
    expect(Exit.isFailure(result)).toBe(true);
  }).pipe(provide),
);

it.effect('revalidates the chosen identity when reading after a completed scan', () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = yield* fs.makeTempDirectoryScoped({prefix: 'preview-final-read-'});
    const root = path.join(home, 'data', 'local', 'user', 'tester', 'memories');
    yield* fs.makeDirectory(root, {recursive: true});
    const file = path.join(root, 'file.md');
    const content = (id: string) => `MEMORY\nkind: durable\nstatus: active\nmemory_id: ${id}\n\nBody`;
    yield* fs.writeFileString(file, content('tn_target'));
    const config = {...unusedConfig, agentContextHome: home};
    const alias = 'threadnote://memory/tn_target';
    const resolved = yield* resolvePreviewMemoryIdentity(config, alias);
    yield* fs.writeFileString(file, content('tn_other'));
    expect(Exit.isFailure(yield* Effect.exit(readManagedMemory(config, alias, {preview: true, resolved})))).toBe(true);
  }).pipe(provide),
);

it.effect.prop(
  'header filtering agrees with the full memory parser across line endings and boundaries',
  {
    ending: Schema.Literals(['\n', '\r', '\r\n']),
    padding: Schema.Literals([0, 16377, 32769]),
    matching: Schema.Boolean,
    separator: Schema.Boolean,
  },
  ({ending, padding, matching, separator}) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({prefix: 'preview-header-property-'});
      const root = path.join(home, 'data', 'local', 'user', 'tester', 'memories');
      yield* fs.makeDirectory(root, {recursive: true});
      const content =
        EffectArray.join(
          [
            'MEMORY',
            'kind: durable',
            `notes: ${EffectString.repeat(padding)('x')}`,
            `memory_id: ${matching ? 'tn_target' : 'tn_other'}`,
          ],
          ending,
        ) + (separator ? `${ending}${ending}memory_id: tn_target` : '');
      const uri = 'threadnote://user/tester/memories/file.md';
      yield* fs.writeFileString(path.join(root, 'file.md'), content);
      const expected = parseMemoryDocument(uri, content)?.metadata.memoryId === 'tn_target';
      const actual = yield* Effect.exit(
        readManagedMemory({...unusedConfig, agentContextHome: home}, 'threadnote://memory/tn_target', {preview: true}),
      );
      expect(Exit.isSuccess(actual)).toBe(expected);
    }).pipe(provide),
  {arbitrary: {runs: 24}},
);

it.effect.prop(
  'stable identity succeeds exactly when one eligible file claims it',
  {claims: Schema.Array(Schema.Boolean).check(Schema.isMinLength(1), Schema.isMaxLength(6))},
  ({claims}) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({prefix: 'preview-property-'});
      const root = path.join(home, 'data', 'local', 'user', 'tester', 'memories');
      yield* fs.makeDirectory(root, {recursive: true});
      for (const [index, claim] of claims.entries()) {
        const id = claim ? 'tn_target' : `tn_other_${index}`;
        yield* fs.writeFileString(
          path.join(root, `${index}.md`),
          `MEMORY\nkind: durable\nstatus: active\nmemory_id: ${id}\n\nBody ${index}\n`,
        );
      }
      const result = yield* Effect.exit(
        readManagedMemory({...unusedConfig, agentContextHome: home}, 'threadnote://memory/tn_target', {preview: true}),
      );
      expect(Exit.isSuccess(result)).toBe(EffectArray.filter(claims, Boolean).length === 1);
    }).pipe(provide),
  {arbitrary: {runs: 20}},
);

it.effect('rejects symlinked path ancestors while allowing ordinary private and shared paths', () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = yield* fs.makeTempDirectoryScoped({prefix: 'preview-symlink-'});
    const outside = yield* fs.makeTempDirectoryScoped({prefix: 'preview-outside-'});
    const root = path.join(home, 'data', 'local', 'user', 'tester', 'memories');
    yield* fs.makeDirectory(path.join(root, 'shared', 'team'), {recursive: true});
    yield* fs.writeFileString(path.join(outside, 'secret.md'), 'outside secret');
    yield* fs.symlink(outside, path.join(root, 'escape'));
    yield* fs.writeFileString(path.join(root, 'private.md'), 'private');
    yield* fs.writeFileString(path.join(root, 'shared', 'team', 'shared.md'), 'shared');
    const config = {...unusedConfig, agentContextHome: home};
    const read = (relative: string) =>
      readManagedMemory(config, `threadnote://user/tester/memories/${relative}`, {preview: true});
    expect(Exit.isFailure(yield* Effect.exit(read('escape/secret.md')))).toBe(true);
    expect((yield* read('private.md')).content).toBe('private');
    expect((yield* read('shared/team/shared.md')).content).toBe('shared');
  }).pipe(provide),
);

it.effect('follows a real relocation receipt without changing the corpus on reads and unavailable reloads', () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = yield* fs.makeTempDirectoryScoped({prefix: 'preview-receipt-'});
    const config = {...unusedConfig, agentContextHome: home};
    const root = path.join(home, 'data', 'local', 'user', 'tester', 'memories');
    yield* fs.makeDirectory(path.join(root, 'shared', 'team'), {recursive: true});
    const fromUri = 'threadnote://user/tester/memories/durable/old.md';
    const toUri = 'threadnote://user/tester/memories/shared/team/moved.md';
    const withId = 'MEMORY\nkind: durable\nstatus: active\nmemory_id: tn_receipt\n\nOriginal\n';
    const withoutId = 'MEMORY\nkind: durable\nstatus: active\n\nShared live bytes\n';
    yield* recordMemoryRelocation(config, {fromUri, toUri, fromContent: withId, toContent: withId});
    const destination = path.join(root, 'shared', 'team', 'moved.md');
    yield* fs.writeFileString(destination, withoutId);
    yield* fs.writeFileString(path.join(root, 'other.md'), 'independent content');
    const snapshot = Effect.fn(function* () {
      const files: string[] = [];
      const visit = (dir: string): Effect.Effect<void, unknown> =>
        Effect.gen(function* () {
          for (const name of (yield* fs.readDirectory(dir)).sort()) {
            const entry = path.join(dir, name);
            const stat = yield* fs.lstat(entry);
            if (stat.type === 'Directory') yield* visit(entry);
            else if (stat.type === 'File')
              files.push(`${path.relative(home, entry)}:${yield* sha256Hex(yield* fs.readFile(entry))}`);
          }
        });
      yield* visit(home);
      return files;
    });
    const before = yield* snapshot();
    const read = () => readManagedMemory(config, 'threadnote://memory/tn_receipt', {preview: true});
    expect((yield* read()).content).toBe(withoutId);
    expect((yield* read()).node.uri).toBe(toUri);
    expect(yield* snapshot()).toEqual(before);
    yield* fs.writeFileString(destination, `${withoutId}${EffectString.repeat(512 * 1024)('x')}`);
    const oversized = yield* snapshot();
    expect(Exit.isFailure(yield* Effect.exit(read()))).toBe(true);
    expect(yield* snapshot()).toEqual(oversized);
    yield* fs.remove(destination);
    const unavailable = yield* snapshot();
    expect(Exit.isFailure(yield* Effect.exit(read()))).toBe(true);
    expect(yield* snapshot()).toEqual(unavailable);
  }).pipe(provide),
);

it.effect('reports a bounded bind error without exposing its cause in the user message', () =>
  Effect.gen(function* () {
    const error = yield* runMemoryPreview(unusedConfig, launchUri, {
      listen: () => {
        throw new Error('sensitive bind detail');
      },
    }).pipe(Effect.flip);
    expect(error).toBeInstanceOf(Error);
    if (!(error instanceof Error)) return;
    expect(error.message).toContain('Retry');
    expect(error.message).not.toContain('sensitive bind detail');
    expect(error.cause).toBeUndefined();
  }).pipe(provide),
);

it.effect('closes a bound listener when the OS opener fails', () =>
  Effect.gen(function* () {
    let stopped = false;
    let openedUrl = '';
    const exit = yield* runMemoryPreview(unusedConfig, launchUri, {
      listen: () => ({
        port: 43118,
        stop: () => {
          stopped = true;
        },
      }),
      openUrl: url => {
        openedUrl = url;
        return Effect.die(new Error(`sensitive opener detail: ${url}`));
      },
    }).pipe(Effect.exit);
    expect(Exit.isFailure(exit)).toBe(true);
    if (!Exit.isFailure(exit)) return;
    expect(openedUrl).toMatch(/^http:\/\/127\.0\.0\.1:/u);
    const formatted = Cause.pretty(exit.cause);
    expect(formatted).toContain('threadnote doctor');
    expect(formatted).not.toContain('sensitive opener detail');
    expect(formatted).not.toContain(openedUrl);
    expect(stopped).toBe(true);
  }).pipe(provide),
);

it.effect('stops the preview listener at its idle deadline', () =>
  Effect.gen(function* () {
    let stopped = false;
    yield* runMemoryPreview(unusedConfig, launchUri, {
      listen: () => ({
        port: 43119,
        stop: () => {
          stopped = true;
        },
      }),
      openUrl: () => Effect.void,
      idleMs: 5,
    });
    expect(stopped).toBe(true);
  }).pipe(TestClock.withLive, provide),
);

it.effect('cancels an abandoned scan when the listener expires', () =>
  Effect.gen(function* () {
    let handler: ((request: Request) => Promise<Response>) | undefined;
    let aborted = false;
    yield* runMemoryPreview(unusedConfig, launchUri, {
      listen: fetch => {
        handler = fetch;
        return {port: 43120, stop: () => {}};
      },
      openUrl: url =>
        Effect.promise(async () => {
          const token = EffectString.slice(1)(new URL(url).hash);
          const response = await handler!(
            new Request('http://127.0.0.1:43120/', {headers: {cookie: `threadnote_preview_43120=${token}`}}),
          );
          expect(response.status).toBe(202);
        }),
      idleMs: 10,
    }).pipe(
      Effect.provideService(MemoryPreviewRead, {
        prepare: async (_config, _uri, signal) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener(
              'abort',
              () => {
                aborted = true;
                reject(new Error('cancelled'));
              },
              {once: true},
            );
          }),
      }),
    );
    expect(aborted).toBe(true);
  }).pipe(TestClock.withLive, provide),
);
