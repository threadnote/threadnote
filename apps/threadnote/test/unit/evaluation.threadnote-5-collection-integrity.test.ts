/* oxlint-disable effecttsgo/node-builtin-import -- Regression tests exercise owned OS process boundaries. */
import {appendFile, link, mkdtemp, realpath, rename, rm, symlink, writeFile} from 'node:fs/promises';
import {EventEmitter} from 'node:events';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {PassThrough} from 'node:stream';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {describe, expect, it} from 'vitest';
import fc from 'fast-check';
import {collectionTranscriptFixture} from '../helpers/threadnote-5-collection-transcripts.js';
import {
  parseThreadnote5CollectionPlan,
  projectNativeCapture,
  projectNativeRecord,
} from '@threadnote/threadnote/evaluation/threadnote-5-release-collection';
import {
  deriveThreadnote5PrivateCollection,
  threadnote5CollectionAuthorityBindingHash,
  verifyThreadnote5CollectionAuthorityBinding,
  verifyThreadnote5PrivateCollection,
} from '@threadnote/threadnote/evaluation/threadnote-5-release-collection-envelope';
import {
  COLLECTION_MAX_BYTES,
  collectionEnvironment,
  collectionCleanupIsUnsafe,
  ownCollectionProcess,
  readPrivateCollectionJson,
  readPrivateCollectionJsonWithIdentity,
  runCollectionProcess,
} from '../../../../scripts/threadnote-5-collection-process.js';
import {CollectionMcpTransport} from '../../../../scripts/threadnote-5-collection-transport.js';

function controlledMcpTransport(cleanupError?: Error) {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const stdin = new PassThrough();
  const child = new EventEmitter() as unknown as ReturnType<typeof ownCollectionProcess>['child'];
  Object.assign(child, {stdout, stderr, stdin});
  let finish!: (code: number | null) => void;
  const done = new Promise<number | null>(resolvePromise => {
    finish = resolvePromise;
  });
  const transport = new CollectionMcpTransport({
    executable: 'controlled-mcp',
    cwd: process.cwd(),
    env: {},
    processFactory: () => {
      queueMicrotask(() => child.emit('spawn'));
      return {
        child,
        done,
        input: {
          failed: new Promise<never>(() => {}),
          closed: Promise.resolve(),
          assertHealthy: () => {},
          write: async () => {},
          end: async () => {},
        },
        terminate: async () => {
          stdout.end();
          stderr.end();
          finish(0);
          await done;
          if (cleanupError !== undefined) throw cleanupError;
        },
      };
    },
  });
  return {
    transport,
    stdout,
    stderr,
    finish: () => {
      stdout.end();
      stderr.end();
      finish(0);
    },
  };
}

describe('collection provenance and process integrity regressions', () => {
  it('rejects one-batch measured selection, uneven flattened contributions, and reused observations', () => {
    const source = collectionTranscriptFixture();
    const plan = structuredClone(source.plan);
    const recipe = plan.recipes[0];
    expect(() =>
      parseThreadnote5CollectionPlan({
        ...plan,
        recipes: [
          {
            ...recipe,
            exports: {...recipe.exports, activation: {select: 'native', pointer: '/json/activation', trial: 0}},
          },
          ...plan.recipes.slice(1),
        ],
      }),
    ).toThrow('every independent trial');
    expect(() =>
      projectNativeCapture(
        {collect: 'native', pointer: '', flatten: true},
        Array.from({length: 10}, (_, index) => ({native: index === 0 ? Array(10).fill({observed: true}) : []})),
      ),
    ).toThrow('exactly one');
    const duplicate = Array.from({length: 10}, () => ({native: {json: {activation: {trials: [{same: true}]}}}}));
    expect(() => projectNativeRecord(plan, recipe, 'activation', duplicate)).toThrow('reused');
  });

  it('preserves one distinct digest and identity per contributor under bounded mutations', () => {
    const source = collectionTranscriptFixture();
    const plan = source.plan;
    const recipe = {
      ...plan.recipes[0],
      exports: {
        ...plan.recipes[0].exports,
        activation: {object: {trials: {collect: 'native', pointer: '', flatten: false}}} as const,
      },
    };
    fc.assert(
      fc.property(fc.integer({min: 0, max: 9}), fc.integer(), (changedIndex, value) => {
        const trials = Array.from({length: 10}, (_, trial) => ({
          native: {trial, value: trial === changedIndex ? value : 0},
        }));
        const result = projectNativeRecord(plan, recipe, 'activation', trials);
        expect(result.provenance).toHaveLength(10);
        expect(new Set(result.provenance.map(item => item.trialId)).size).toBe(10);
        expect(new Set(result.provenance.map(item => item.observationDigest)).size).toBe(10);
      }),
      {numRuns: 25},
    );
  });

  it('recomputes the approved plan, raw transcript, record projections, and complete envelope at seal', () => {
    const source = collectionTranscriptFixture();
    expect(verifyThreadnote5PrivateCollection(source)).toEqual(source.collection);
    for (const field of ['planHash', 'transcriptDigest', 'collectionHash'] as const)
      expect(() =>
        verifyThreadnote5PrivateCollection({...source, collection: {...source.collection, [field]: '0'.repeat(64)}}),
      ).toThrow('recomputed');
    expect(() =>
      verifyThreadnote5PrivateCollection({...source, collection: {...source.collection, unexpected: 'private text'}}),
    ).toThrow('extra');
    expect(() => verifyThreadnote5PrivateCollection({...source, plan: {...source.plan, runId: 'different'}})).toThrow();
    const transcript = structuredClone(source.transcripts) as {steps: {output: {stdout: string}}[]}[];
    transcript[0].steps[0].output.stdout = '{}';
    expect(() => verifyThreadnote5PrivateCollection({...source, transcripts: transcript})).toThrow('raw stdout');
    expect(() => verifyThreadnote5PrivateCollection({...source, transcripts: source.transcripts.slice(1)})).toThrow();
    expect(() =>
      verifyThreadnote5PrivateCollection({
        ...source,
        collection: {...source.collection, records: source.collection.records.slice(1)},
      }),
    ).toThrow('recomputed');
    expect(() =>
      verifyThreadnote5PrivateCollection({
        ...source,
        collection: {...source.collection, provenance: source.collection.provenance.slice(1)},
      }),
    ).toThrow('recomputed');
  });

  it('rejects a rehashed changed run unless its independently reviewed collection-authority binding also matches', () => {
    const source = collectionTranscriptFixture();
    const binding = {
      version: 1,
      collectionHash: source.collection.collectionHash,
      authorityManifestHash: 'a'.repeat(64),
    };
    const expectedBindingSha256 = threadnote5CollectionAuthorityBindingHash(binding);
    verifyThreadnote5CollectionAuthorityBinding({
      binding,
      expectedBindingSha256,
      collectionHash: source.collection.collectionHash,
      authorityManifestHash: binding.authorityManifestHash,
    });
    const changedPlan = {...source.plan, retentionHours: 2};
    const changed = deriveThreadnote5PrivateCollection(
      changedPlan,
      source.transcripts,
      source.collection.runtimeBoundaries,
    );
    expect(() =>
      verifyThreadnote5CollectionAuthorityBinding({
        binding,
        expectedBindingSha256,
        collectionHash: changed.collectionHash,
        authorityManifestHash: binding.authorityManifestHash,
      }),
    ).toThrow('independently reviewed');
    expect(() =>
      verifyThreadnote5CollectionAuthorityBinding({
        binding: {...binding, collectionHash: changed.collectionHash},
        expectedBindingSha256,
        collectionHash: changed.collectionHash,
        authorityManifestHash: binding.authorityManifestHash,
      }),
    ).toThrow('independently reviewed');
  });

  it('does not share temporary storage between trials or surfaces', () => {
    const homes = ['/isolated/trial-a/primary', '/isolated/trial-a/secondary', '/isolated/trial-b/primary'];
    const environments = homes.map(home => collectionEnvironment('/isolated', home));
    expect(new Set(environments.map(env => env.TMPDIR)).size).toBe(homes.length);
    expect(environments.every((env, index) => env.TMPDIR === `${homes[index]}/tmp`)).toBe(true);
    expect(() => collectionEnvironment('/isolated', '/isolated/../personal')).toThrow();
  });

  it('preserves the first input failure across bounded callback, error, finish and close schedules', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.shuffledSubarray(['callback', 'first error', 'second error', 'finish', 'close'] as const, {
          minLength: 5,
          maxLength: 5,
        }),
        async events => {
          const owned = ownCollectionProcess('/bin/cat', [], process.cwd(), {PATH: '/usr/bin:/bin'});
          let callback!: (error?: Error | null) => void;
          owned.child.stdin.end = ((_bytes: unknown, complete: typeof callback) => {
            callback = complete;
            return owned.child.stdin;
          }) as typeof owned.child.stdin.end;
          const result = owned.input.end('request').then(
            () => undefined,
            error => error,
          );
          const first = new Error('first error');
          const second = new Error('second error');
          let expected: Error | undefined;
          let callbackSeen = false;
          for (const event of events) {
            if (event === 'callback') {
              callbackSeen = true;
              callback();
            } else if (event === 'finish') owned.child.stdin.emit('finish');
            else if (event === 'close') {
              if (!callbackSeen && expected === undefined)
                expected = new Error('Collection process input closed before completing.');
              owned.child.stdin.emit('close');
            } else {
              const error = event === 'first error' ? first : second;
              expected ??= error;
              owned.child.stdin.emit('error', error);
            }
          }
          try {
            expect((await result)?.message).toBe(expected?.message);
            expect(() => owned.input.assertHealthy()).toThrow(expected?.message);
            await expect(owned.done).rejects.toThrow(expected?.message);
          } finally {
            owned.child.stdin.destroy();
            await owned.terminate().catch(() => {});
          }
        },
      ),
      {numRuns: 20, seed: 20261025},
    );
  });

  it('rejects every pending input write with the first callback or emitted error', async () => {
    const owned = ownCollectionProcess('/bin/cat', [], process.cwd(), {PATH: '/usr/bin:/bin'});
    const callbacks: ((error?: Error | null) => void)[] = [];
    owned.child.stdin.write = ((_bytes: unknown, callback: (error?: Error | null) => void) => {
      callbacks.push(callback);
      return true;
    }) as typeof owned.child.stdin.write;
    const writes = [owned.input.write('first'), owned.input.write('second')];
    const observed = Promise.all(writes.map(write => write.catch(error => error)));
    const first = new Error('callback failure');
    callbacks[0](first);
    callbacks[1](new Error('later callback failure'));
    owned.child.stdin.emit('error', new Error('later emitted error'));
    expect(await observed).toEqual([first, first]);
    await expect(owned.done).rejects.toBe(first);
    await expect(owned.terminate()).rejects.toBe(first);
  });

  it('reports input failure consistently through MCP send, onerror and close after cleanup', async () => {
    let owned!: ReturnType<typeof ownCollectionProcess>;
    const transport = new CollectionMcpTransport({
      executable: '/bin/cat',
      cwd: process.cwd(),
      env: {PATH: '/usr/bin:/bin'},
      processFactory: () => {
        owned = ownCollectionProcess('/bin/cat', [], process.cwd(), {PATH: '/usr/bin:/bin'});
        return owned;
      },
    });
    const errors: Error[] = [];
    let closes = 0;
    transport.onerror = error => errors.push(error);
    transport.onclose = () => {
      closes += 1;
    };
    await transport.start();
    const first = new Error('input failed');
    owned.child.stdin.emit('error', first);
    await expect(transport.send({jsonrpc: '2.0', method: 'probe'})).rejects.toBe(first);
    await expect(transport.close()).rejects.toBe(first);
    expect(errors).toEqual([first]);
    expect(closes).toBe(1);
    await expect(owned.done).rejects.toBe(first);
  });

  it('handles real early-reader-close finalization in an isolated Bun process and preserves normal input bytes', async () => {
    const module = resolve('scripts/threadnote-5-collection-process.ts');
    for (const early of [true, false]) {
      const program = `
        import {ownCollectionProcess} from ${JSON.stringify(module)};
        const early = ${early};
        const peer = early
          ? 'import os,signal;os.close(0);os.write(1,bytes([82]));signal.pause()'
          : 'import sys;sys.stdout.buffer.write(sys.stdin.buffer.read())';
        const owned = ownCollectionProcess('/usr/bin/python3', ['-I','-S','-c',peer], process.cwd(), {PATH:'/usr/bin:/bin'});
        const output = [];
        owned.child.stdout.on('data', chunk => output.push(chunk));
        if (early) await new Promise(resolve => owned.child.stdout.once('data', resolve));
        const bytes = Buffer.from("private input");
        let failure;
        try { await owned.input.write(bytes); await owned.input.end(); await owned.done; } catch (error) { failure = error; }
        try { await owned.terminate(); } catch (error) { failure ??= error; }
        if (early && !failure) throw new Error('false successful capture');
        if (!early && (failure || !Buffer.concat(output).equals(bytes))) throw new Error('normal bytes changed');
        console.log(early ? 'handled input failure' : 'exact bytes');
      `;
      const result = await runCollectionProcess(
        process.execPath,
        ['-e', program],
        process.cwd(),
        {...process.env} as Record<string, string>,
        10_000,
      );
      expect(result.stderr).toBe('');
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe(early ? 'handled input failure' : 'exact bytes');
    }
  });

  it('terminates successful leaders descendants before returning the native capture', async () => {
    const root = await realpath(await mkdtemp(resolve(tmpdir(), 'tn-group-regression-')));
    try {
      const result = await runCollectionProcess(
        '/bin/sh',
        ['-c', 'sleep 30 >/dev/null 2>&1 & printf "%s" "$!"'],
        root,
        collectionEnvironment(root, resolve(root, 'home')),
      );
      expect(result.exitCode).toBe(0);
      expect(() => process.kill(Number(result.stdout), 0)).toThrow();
    } finally {
      await rm(root, {recursive: true, force: true});
    }
  });

  it('rejects malformed UTF-8 emitted inside otherwise valid native JSON', async () => {
    const root = await realpath(await mkdtemp(resolve(tmpdir(), 'tn-native-utf8-')));
    try {
      await expect(
        runCollectionProcess(
          process.execPath,
          ['-e', 'process.stdout.write(Buffer.from([123,34,118,34,58,34,128,34,125]))'],
          root,
          collectionEnvironment(root, resolve(root, 'home')),
        ),
      ).rejects.toThrow('valid UTF-8');
    } finally {
      await rm(root, {recursive: true, force: true});
    }
  });

  it('never follows a private JSON path swapped between a regular file and a symlink', async () => {
    const root = await realpath(await mkdtemp(resolve(tmpdir(), 'tn-json-swap-')));
    const capture = resolve(root, 'capture.json');
    const safe = resolve(root, 'safe.json');
    const secret = resolve(root, 'secret.json');
    await writeFile(safe, '{"safe":true}');
    await writeFile(secret, '{"secret":true}');
    await link(safe, capture);
    try {
      const attack = async () => {
        for (let index = 0; index < 128; index += 1) {
          const stagedLink = resolve(root, `capture-link-${index}`);
          const stagedFile = resolve(root, `capture-file-${index}`);
          await symlink(secret, stagedLink);
          await rename(stagedLink, capture);
          await link(safe, stagedFile);
          await rename(stagedFile, capture);
        }
      };
      const attempts = Array.from({length: 256}, async () => {
        try {
          return await readPrivateCollectionJson(capture, 64);
        } catch {
          return undefined;
        }
      });
      const [, observed] = await Promise.all([attack(), Promise.all(attempts)]);
      expect(
        observed.filter(value => value !== undefined).every(value => JSON.stringify(value) === '{"safe":true}'),
      ).toBe(true);
      await expect(readPrivateCollectionJson(capture, 64)).resolves.toEqual({safe: true});
      const [original, alias] = await Promise.all([
        readPrivateCollectionJsonWithIdentity(safe, 64),
        readPrivateCollectionJsonWithIdentity(capture, 64),
      ]);
      expect(alias.value).toEqual({safe: true});
      expect(alias.identity).toEqual(original.identity);
      expect(alias.identity.device).toMatch(/^\d+$/u);
      expect(alias.identity.inode).toMatch(/^\d+$/u);
    } finally {
      await rm(root, {recursive: true, force: true});
    }
  });

  it('rejects FIFO and growing private JSON inputs without an unbounded read', async () => {
    const root = await realpath(await mkdtemp(resolve(tmpdir(), 'tn-json-bound-')));
    const fifo = resolve(root, 'capture.fifo');
    const growing = resolve(root, 'growing.json');
    const maximumBytes = 4 * 1024 * 1024;
    try {
      const madeFifo = await runCollectionProcess(
        '/usr/bin/mkfifo',
        [fifo],
        root,
        collectionEnvironment(root, resolve(root, 'home')),
      );
      expect(madeFifo.exitCode).toBe(0);
      await expect(readPrivateCollectionJson(fifo, 64)).rejects.toThrow('bounded regular JSON file');

      const initial = Buffer.alloc(maximumBytes, 0x20);
      initial.write('{"value":true}');
      await writeFile(growing, initial);
      const reading = readPrivateCollectionJson(growing, maximumBytes);
      const growth = appendFile(growing, ' ');
      await expect(reading).rejects.toThrow(/byte bound|bounded regular|changed/u);
      await growth;
    } finally {
      await rm(root, {recursive: true, force: true});
    }
  });

  it('rejects every standalone UTF-8 continuation byte in private JSON strings', async () => {
    const root = await realpath(await mkdtemp(resolve(tmpdir(), 'tn-json-utf8-property-')));
    const capture = resolve(root, 'capture.json');
    try {
      await fc.assert(
        fc.asyncProperty(fc.integer({min: 0x80, max: 0xbf}), async malformedByte => {
          await writeFile(capture, Buffer.from([123, 34, 118, 34, 58, 34, malformedByte, 34, 125]));
          await expect(readPrivateCollectionJson(capture, 64)).rejects.toThrow('valid UTF-8');
        }),
        {numRuns: 16},
      );
    } finally {
      await rm(root, {recursive: true, force: true});
    }
  });

  it('kills an oversized unframed MCP stream before JSON materialization and drains its process group', async () => {
    const root = await realpath(await mkdtemp(resolve(tmpdir(), 'tn-mcp-bound-')));
    const transport = new CollectionMcpTransport({
      executable: process.execPath,
      argv: ['-e', `process.stdout.write(Buffer.alloc(${COLLECTION_MAX_BYTES + 1}, 97));setInterval(()=>{},1000)`],
      cwd: root,
      env: collectionEnvironment(root, resolve(root, 'home')),
    });
    let messages = 0;
    transport.onmessage = () => {
      messages += 1;
    };
    const failure = new Promise<Error>(resolvePromise => {
      transport.onerror = resolvePromise;
    });
    try {
      await transport.start();
      expect((await failure).message).toContain('before parsing');
      await transport.close().catch(() => {});
      expect(messages).toBe(0);
      expect(() => transport.assertHealthy()).toThrow('byte limit');
    } finally {
      await transport.close().catch(() => {});
      await rm(root, {recursive: true, force: true});
    }
  });

  it('rejects malformed UTF-8 inside an otherwise valid MCP JSON-RPC frame', async () => {
    const root = await realpath(await mkdtemp(resolve(tmpdir(), 'tn-mcp-utf8-frame-')));
    const transport = new CollectionMcpTransport({
      executable: process.execPath,
      argv: [
        '-e',
        `const frame=Buffer.concat([Buffer.from(${JSON.stringify('{"jsonrpc":"2.0","method":"probe","params":{"text":"')}),Buffer.from([255]),Buffer.from(${JSON.stringify('"}}\n')})]);process.stdout.write(frame);setInterval(()=>{},1000)`,
      ],
      cwd: root,
      env: collectionEnvironment(root, resolve(root, 'home')),
    });
    let messages = 0;
    transport.onmessage = () => {
      messages += 1;
    };
    const failure = new Promise<Error>(resolvePromise => {
      transport.onerror = resolvePromise;
    });
    try {
      await transport.start();
      expect((await failure).message).toContain('valid UTF-8');
      expect(messages).toBe(0);
      expect(() => transport.assertHealthy()).toThrow('valid UTF-8');
    } finally {
      await transport.close().catch(() => {});
      await rm(root, {recursive: true, force: true});
    }
  });

  it('keeps unsafe cleanup observable ahead of an ordinary MCP failure and closes once', async () => {
    const owned = ownCollectionProcess('/bin/sh', ['-c', 'exit 0'], process.cwd(), {PATH: '/usr/bin:/bin'});
    owned.child.prependOnceListener('exit', () => Object.defineProperty(owned.child, 'pid', {value: undefined}));
    const unsafe = await owned.done.catch(error => error);
    expect(collectionCleanupIsUnsafe(unsafe)).toBe(true);
    const {transport, stderr} = controlledMcpTransport(unsafe);
    let closes = 0;
    const errors: Error[] = [];
    transport.onclose = () => {
      closes += 1;
    };
    transport.onerror = error => errors.push(error);
    await transport.start();
    stderr.write(Buffer.from([0xff]));
    await expect(transport.close()).rejects.toBe(unsafe);
    await expect(transport.close()).rejects.toBe(unsafe);
    await expect(transport.send({jsonrpc: '2.0', method: 'probe'})).rejects.toBe(unsafe);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('UTF-8');
    expect(closes).toBe(1);
  });

  it('fails closed for a truncated stdout frame during normal close after clean EOF', async () => {
    const {transport, stdout} = controlledMcpTransport();
    const failure = new Promise<Error>(resolvePromise => {
      transport.onerror = resolvePromise;
    });
    await transport.start();
    stdout.write(Buffer.from('{"jsonrpc":"2.0","method":"probe"'));
    await expect(transport.close()).rejects.toThrow('Incomplete private MCP protocol frame');
    await expect(failure).resolves.toMatchObject({
      message: expect.stringContaining('Incomplete private MCP protocol frame'),
    });
  });

  it('finalizes incomplete stderr and preserves the first failure through SDK close', async () => {
    const {transport, stderr} = controlledMcpTransport();
    Object.assign(transport, {sessionId: 'controlled-regression'});
    const client = new Client({name: 'collection-transport-regression', version: '1'});
    const reported = new Promise<Error>(resolvePromise => {
      client.onerror = resolvePromise;
    });
    await client.connect(transport);
    stderr.write(Buffer.from([0xe2]));
    await expect(client.close()).rejects.toThrow('MCP stderr must be valid UTF-8');
    expect((await reported).message).toContain('MCP stderr must be valid UTF-8');
  });

  it('preserves valid multibyte stderr across deterministically separate chunks and rejects malformed stderr', async () => {
    const {transport: split, stderr, finish} = controlledMcpTransport();
    const chunks: Buffer[] = [];
    stderr.on('data', chunk => chunks.push(Buffer.from(chunk)));
    const closed = new Promise<void>((resolvePromise, rejectPromise) => {
      split.onclose = resolvePromise;
      split.onerror = rejectPromise;
    });
    try {
      await split.start();
      stderr.write(Buffer.from([0xe2]));
      expect(chunks).toEqual([Buffer.from([0xe2])]);
      stderr.write(Buffer.from([0x82, 0xac, 0x0a]));
      expect(chunks).toEqual([Buffer.from([0xe2]), Buffer.from([0x82, 0xac, 0x0a])]);
      finish();
      await closed;
      expect(split.stderr.join('')).toBe('€\n');
      split.assertHealthy();
    } finally {
      await split.close().catch(() => {});
    }

    const {transport: malformed, stderr: malformedStderr} = controlledMcpTransport();
    const failure = new Promise<Error>(resolvePromise => {
      malformed.onerror = resolvePromise;
    });
    try {
      await malformed.start();
      malformedStderr.write(Buffer.from([0xff]));
      expect((await failure).message).toContain('UTF-8');
      expect(() => malformed.assertHealthy()).toThrow('UTF-8');
    } finally {
      await malformed.close().catch(() => {});
    }
  });
});
