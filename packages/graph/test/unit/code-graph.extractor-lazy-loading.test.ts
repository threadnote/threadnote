import {Array as EffectArray, Option, Schema} from 'effect';
import {afterAll, expect, it, vi} from 'vitest';
import * as FC from 'fast-check';
import {extractNativeFileFacts} from '@threadnote/graph/extractor';
import {
  connectNativeTypeScriptLanguageServerSession,
  connectNativeTypeScriptPipeSession,
  nativeTypeScriptOwnershipUnknown,
  nativeTypeScriptSessionOwnership,
  createNativeTypeScriptSession,
  NativeTypeScriptUnavailable,
  type NativeTypeScriptSession,
} from '@threadnote/graph/typescript_runtime';
import {
  nativeTypeScriptHostKey,
  nativeTypeScriptReviewedBinarySha256,
} from '@threadnote/graph/typescript_native_asset_pins';
import {
  createNativeTypeScriptTestSession,
  native,
  nativeTypeScriptTestAssetDirectory,
  skipWithoutNativeTypeScript,
} from '../helpers/native-typescript-session.js';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {runtimeCurrentUserPrimaryGroup, runtimeTerminateOwnedProviderTree} from '@threadnote/platform/system';
import type {CodeGraphInventoryFile} from '@threadnote/graph/types';
import {
  chmodSync,
  chownSync,
  cpSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from '@threadnote/testing/node-fs';
import {tmpdir} from '@threadnote/testing/node-os';
import {join} from '@threadnote/testing/node-path';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

const refusal = (error: unknown) => (Schema.is(NativeTypeScriptUnavailable)(error) ? error.reason : error);
/** Admission refusals need no asset, so they run on every host. */

it('refuses a missing or aliased asset with distinct value-free reasons before any process starts', async () => {
  const start = (assetDirectory: string | undefined) =>
    createNativeTypeScriptSession({cwd: process.cwd(), deadline: Date.now() + 5_000, assetDirectory}).then(
      () => 'started',
      refusal,
    );
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'threadnote-native-refusal-')));
  try {
    const alias = join(root, 'alias');
    symlinkSync(root, alias);
    expect(await start(undefined)).toBe('missing-asset');
    expect(await start(join(root, 'absent'))).toBe('missing-asset');
    expect(await start(alias)).toBe('non-canonical-path');
    const pinned = nativeTypeScriptReviewedBinarySha256(nativeTypeScriptHostKey(process.platform, process.arch));
    expect(await start(root)).toBe(pinned === undefined ? 'no-reviewed-pin' : 'missing-manifest');
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});

// One session serves every test in this file; each operation has its own budget.
let sharedSession: Promise<NativeTypeScriptSession> | undefined;
const getNativeSession = () => (sharedSession ??= createNativeTypeScriptTestSession());
afterAll(async () => {
  await (await sharedSession)?.close();
});

native(it)('admits only a private, sticky or own user-private-group ancestor above the asset', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'threadnote-native-ancestry-')));
  try {
    const shared = join(root, 'shared');
    const asset = join(shared, 'prepared');
    cpSync(nativeTypeScriptTestAssetDirectory(), asset, {recursive: true, preserveTimestamps: true});
    const start = () =>
      createNativeTypeScriptSession({cwd: process.cwd(), deadline: Date.now() + 30_000, assetDirectory: asset}).then(
        async session => {
          await session.close();
          return 'started';
        },
        refusal,
      );
    // The umask 002 layout: a group-writable directory of the user's own user-private group (Ubuntu, Fedora). It is
    // admitted only where the local account files prove that group private; otherwise it is refused with a hint.
    chmodSync(shared, 0o775);
    const primary = runtimeCurrentUserPrimaryGroup();
    const privateGroup = primary?.kind === 'private' && statSync(shared).gid === primary.gid;
    expect(await start()).toBe(privateGroup ? 'started' : 'group-writable-ancestor');
    // A group-writable directory of any other group lets its members swap the asset root out from under the verifier.
    const foreign = EffectArray.findFirst(process.getgroups?.() ?? [], gid => gid !== primary?.gid);
    if (Option.isSome(foreign)) {
      chownSync(shared, -1, foreign.value);
      expect(await start()).toBe('group-writable-ancestor');
    }
    // Other-writable without the sticky bit is refused whoever owns the group.
    chmodSync(shared, 0o777);
    expect(await start()).toBe('unsafe-asset');
    // A sticky shared directory (like /tmp) cannot have another user's entries renamed away.
    chmodSync(shared, 0o1777);
    expect(await start()).toBe('started');
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});

native(it)('refuses a self-consistent manifest naming a substituted executable', async () => {
  // Reviewer reproduction: a shell wrapper around the real tsc plus a manifest that names the wrapper's digest.
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'threadnote-native-wrapper-')));
  try {
    const asset = join(root, 'prepared');
    cpSync(nativeTypeScriptTestAssetDirectory(), asset, {recursive: true});
    const manifestPath = join(asset, 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const wrapper = `#!/bin/sh\nexec ${JSON.stringify(join(nativeTypeScriptTestAssetDirectory(), manifest.executable))} "$@"\n`;
    writeFileSync(join(asset, manifest.executable), wrapper);
    chmodSync(join(asset, manifest.executable), 0o755);
    writeFileSync(manifestPath, `${JSON.stringify({...manifest, sha256: sha256HexSync(wrapper)}, null, 2)}\n`);
    expect(
      await createNativeTypeScriptSession({
        cwd: process.cwd(),
        deadline: Date.now() + 30_000,
        assetDirectory: asset,
      }).then(() => 'started', refusal),
    ).toBe('pin-mismatch');
    // The pinned digest in the manifest cannot vouch for the substituted bytes either.
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    expect(
      await createNativeTypeScriptSession({
        cwd: process.cwd(),
        deadline: Date.now() + 30_000,
        assetDirectory: asset,
      }).then(() => 'started', refusal),
    ).toBe('pin-mismatch');
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});

native(it)('admits only the compiled-in signed compiler image in a signed macOS release', async context => {
  if (process.platform !== 'darwin') context.skip('Darwin signed release identity');
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'threadnote-native-signed-')));
  const host = nativeTypeScriptHostKey(process.platform, process.arch);
  const start = (assetDirectory: string) =>
    createNativeTypeScriptSession({cwd: process.cwd(), deadline: Date.now() + 30_000, assetDirectory}).then(
      async session => {
        await session.close();
        return 'started';
      },
      refusal,
    );
  try {
    // A private copy signed ad-hoc the way publish signs it: hardened runtime and the explicit identifier.
    const asset = join(root, 'prepared');
    cpSync(nativeTypeScriptTestAssetDirectory(), asset, {recursive: true});
    const compiler = join(asset, 'tsc');
    const sign = ['--force', '-s', '-', '--options', 'runtime', '--identifier', 'dev.threadnote.typescript-native'];
    expect(Bun.spawnSync(['/usr/bin/codesign', ...sign, compiler]).exitCode).toBe(0);
    const sha256 = sha256HexSync(readFileSync(compiler));
    const shown = Bun.spawnSync(['/usr/bin/codesign', '-dvvv', compiler], {stderr: 'pipe'}).stderr.toString();
    const cdhash = /^CDHash=([0-9a-f]{40})$/mu.exec(shown)?.[1];
    // Source mode and unsigned builds accept only the reviewed bytes.
    expect(await start(asset)).toBe('pin-mismatch');
    vi.stubGlobal('THREADNOTE_SIGNED_NATIVE_TYPESCRIPT', {host, sha256, cdhash});
    expect(await start(asset)).toBe('started');
    // A signed release accepts only its signed bytes, never the reviewed unsigned original.
    expect(await start(nativeTypeScriptTestAssetDirectory())).toBe('pin-mismatch');
    // The kernel must report the compiled-in image: the same bytes running as another cdhash never run.
    vi.stubGlobal('THREADNOTE_SIGNED_NATIVE_TYPESCRIPT', {
      host,
      sha256,
      cdhash: '0000000000000000000000000000000000000000',
    });
    expect(await start(asset)).toBe('image-mismatch');
    vi.stubGlobal('THREADNOTE_SIGNED_NATIVE_TYPESCRIPT', {host, sha256: 'signed', cdhash});
    expect(await start(asset)).toBe('pin-mismatch');
  } finally {
    vi.unstubAllGlobals();
    rmSync(root, {recursive: true, force: true});
  }
});

it('loads the TypeScript compiler only for TypeScript extraction, preserving its identity and repeated facts', context => {
  skipWithoutNativeTypeScript(context);
  // This contract is process-global module loading, so an isolated CLI boundary is intentional.
  const child = Bun.spawnSync(
    [
      process.execPath,
      '--eval',
      `
const compilerPaths = [require.resolve('typescript/async'), process.env.THREADNOTE_TYPESCRIPT_NATIVE_PREPARED_ASSET_DIR + '/frontend/api/async/api.js'];
const loaded = () => compilerPaths.some(path => Object.hasOwn(require.cache, path));
await import('./apps/threadnote/src/effect/runtime.ts');
const {extractFileFacts, extractNativeFileFacts, createRepositoryFactAttributor} = await import('@threadnote/graph/extractor');
const {codeGraphLanguagePack} = await import('@threadnote/graph/languages/typescript/pack');
const states = [loaded()];
const file = (path, language, content) => ({
  blobId: 'b'.repeat(40), content, contentHash: 'a'.repeat(64), language,
  mode: '100644', path, size: Buffer.byteLength(content), source: 'commit',
});
const manifest = file('package.json', 'npm-manifest', '{"name":"@test/lazy"}');
const documentation = file('README.md', 'markdown', '# Lazy loading');
const nonTypeScriptFacts = [extractFileFacts(manifest), extractFileFacts(documentation)];
const attributed = createRepositoryFactAttributor([manifest, documentation])(nonTypeScriptFacts);
states.push(loaded());
const identityBefore = codeGraphLanguagePack.extractor.version;
const source = file('src/example.ts', 'typescript', 'export function example(value: number) { return value + 1; }');
const {createNativeTypeScriptSession} = await import('@threadnote/graph/typescript_runtime');
const native = await createNativeTypeScriptSession({cwd:process.cwd(), deadline:Date.now()+30000, assetDirectory: process.env.THREADNOTE_TYPESCRIPT_NATIVE_PREPARED_ASSET_DIR});
const {nativeTypeScriptAssetPins} = await import('@threadnote/graph/typescript_native_asset_pins');
const first = await extractNativeFileFacts(source, native);
states.push(loaded());
const second = await extractNativeFileFacts(source, native);
await native.close();
states.push(loaded());
const packageVersion = (await import('typescript/package.json')).default.version;
const compilerVersion = packageVersion;
const expectedIdentity = new Bun.CryptoHasher('sha256')
  .update('typescript-native-7.1-v2-full-utf16-finite-navigation-proofs\\ntypescript:' + compilerVersion + '\\nasset:' + JSON.stringify(nativeTypeScriptAssetPins))
  .digest('hex');
process.stdout.write(JSON.stringify({
  states, compilerVersion, packageVersion, expectedIdentity, identityBefore,
  identityAfter: codeGraphLanguagePack.extractor.version,
  repeatedFactsEqual: JSON.stringify(first) === JSON.stringify(second),
  declarations: first.symbols.map(symbol => symbol.name),
  nonTypeScriptNames: attributed.flatMap(facts => facts.symbols.map(symbol => symbol.name)),
}) + '\\n');
`,
    ],
    {cwd: Bun.fileURLToPath(new URL('../../../..', import.meta.url)), stderr: 'pipe', stdout: 'pipe'},
  );
  expect(child.exitCode, child.stderr.toString()).toBe(0);
  const observed = JSON.parse(child.stdout.toString());
  expect(observed.states).toEqual([false, false, true, true]);
  expect(observed.compilerVersion).toBe(observed.packageVersion);
  expect(observed.identityBefore).toBe(observed.expectedIdentity);
  expect(observed.identityAfter).toBe(observed.identityBefore);
  expect(observed.repeatedFactsEqual).toBe(true);
  expect(observed.declarations).toContain('example');
  expect(observed.nonTypeScriptNames).toEqual(expect.arrayContaining(['@test/lazy', 'Lazy loading']));
});

native(it)('preserves facts and caller inputs across repeated cached-compiler extraction', async () => {
  const native = await getNativeSession();
  await FC.assert(
    FC.asyncProperty(FC.integer({min: 0, max: 1_000}), FC.integer({min: -100, max: 100}), async (suffix, increment) => {
      const content = `export function example${suffix}(value: number) { return value + ${increment}; }`;
      const file: CodeGraphInventoryFile = {
        blobId: Effect.pipe('b', EffectString.repeat(40)),
        content,
        contentHash: Effect.pipe('a', EffectString.repeat(64)),
        language: 'typescript',
        mode: '100644',
        path: `src/example-${suffix}.ts`,
        size: Buffer.byteLength(content),
        source: 'commit',
      };
      const before = structuredClone(file);
      const first = await extractNativeFileFacts(file, native);
      await extractNativeFileFacts({...file, content: 'export const unrelated = 1;', path: 'src/unrelated.ts'}, native);
      expect(await extractNativeFileFacts(file, native)).toEqual(first);
      expect(file).toEqual(before);
    }),
    {numRuns: 25},
  );
});

native(it.each([false, true]))(
  'bundles the lazy compiler outside the dependency checkout (compiled: %s)',
  async compiled => {
    // The program under test is the Bun bundler and its child-process module boundary.
    // Canonical: admission refuses an asset below a symlinked temporary path such as macOS /var/folders.
    const directory = realpathSync(mkdtempSync(join(tmpdir(), 'threadnote-lazy-extractor-')));
    let retainUnknownNative = false;
    try {
      const executable = join(directory, process.platform === 'win32' ? 'extractor.exe' : 'extractor');
      const result = await Bun.build({
        ...(compiled ? {bytecode: true, compile: {outfile: executable}} : {outdir: directory}),
        entrypoints: [
          Bun.fileURLToPath(
            new URL('../../../../apps/threadnote/test/fixtures/code-graph-lazy-extractor.ts', import.meta.url),
          ),
        ],
        format: 'esm',
        minify: true,
        target: 'bun',
      });
      expect(
        result.success,
        EffectArray.join(
          EffectArray.map(result.logs, log => log.message),
          '\n',
        ),
      ).toBe(true);
      const prepared = nativeTypeScriptTestAssetDirectory();
      const assets = join(directory, 'runtime', 'typescript');
      cpSync(prepared, assets, {recursive: true});
      const manifest = JSON.parse(readFileSync(join(assets, 'manifest.json'), 'utf8'));
      expect(manifest.version).toBe('7.1.0-beta');
      expect(sha256HexSync(readFileSync(join(assets, manifest.executable)))).toBe(manifest.sha256);
      retainUnknownNative = true;
      const child = Bun.spawnSync(
        compiled ? [executable] : [process.execPath, join(directory, 'code-graph-lazy-extractor.js'), assets],
        {
          cwd: directory,
          stderr: 'pipe',
          stdout: 'pipe',
          env: {
            ...process.env,
            THREADNOTE_TYPESCRIPT_NATIVE_ASSET_DIR: undefined,
            // Explicit source composition wins; a compiled user needs no SDK override at all.
            THREADNOTE_TYPESCRIPT_NATIVE_PREPARED_ASSET_DIR: compiled ? undefined : join(directory, 'missing-override'),
          },
        },
      );
      expect(child.exitCode, child.stderr.toString()).toBe(0);
      expect(JSON.parse(child.stdout.toString())).toContain('bundledExample');
      retainUnknownNative = false;
    } finally {
      // A failed child cannot attest its original API owner's native completion.
      if (!retainUnknownNative) rmSync(directory, {recursive: true, force: true});
    }
  },
);

native(it)(
  'keeps the session usable after a caller callback fails, disposing its lease without mutating input',
  async () => {
    const native = await getNativeSession();
    const input = {fileName: 'lease.ts', text: 'export const lease = 1;'};
    const before = structuredClone(input);
    const failure = new Error('owned callback failure');
    await expect(
      native.withSourceFileAndTranspile(input, {reportDiagnostics: true}, async () => {
        if (process.platform === 'darwin') {
          const original = nativeTypeScriptSessionOwnership(native);
          const alias = EffectString.replace(/^\/private\/tmp\//u, '/tmp/')(original.endpointDirectory);
          expect(alias).not.toBe(original.endpointDirectory);
          // Metadata-only acquisition on the actual original socket; no LSP snapshot,
          // project authority, client connection or additional native child is asserted.
          const borrowed = await connectNativeTypeScriptLanguageServerSession({
            assertOriginalCurrent: original.assertCurrent,
            pipe: alias + '/socket',
            endpointDirectory: alias,
            sdkDirectory: original.sdkDirectory,
            deadline: Date.now() + 30_000,
          });
          await borrowed.close();
          await expect(
            connectNativeTypeScriptLanguageServerSession({
              assertOriginalCurrent: original.assertCurrent,
              pipe: alias + '/other',
              endpointDirectory: alias,
              sdkDirectory: original.sdkDirectory,
              deadline: Date.now() + 30_000,
            }),
          ).rejects.toThrow();
        }
        throw failure;
      }),
    ).rejects.toBe(failure);
    // A per-file callback failure is not a transport failure: the next file still extracts on the same session.
    const content = 'export function afterFailure() { return 1; }';
    const facts = await extractNativeFileFacts(
      {
        blobId: Effect.pipe('b', EffectString.repeat(40)),
        content,
        contentHash: sha256HexSync(content),
        language: 'typescript',
        mode: '100644',
        path: 'src/after-failure.ts',
        size: Buffer.byteLength(content),
        source: 'commit',
      },
      native,
    );
    expect(EffectArray.map(facts.symbols, symbol => symbol.name)).toContain('afterFailure');
    expect(input).toEqual(before);
  },
);

native(it)('refuses oversized and expired requests before sending them, leaving the session healthy', async () => {
  const session = await getNativeSession();
  const refusal = (promise: Promise<unknown>) =>
    promise.then(
      () => undefined,
      (error: unknown) => error,
    );
  for (const input of [
    {fileName: 'oversized.ts', text: Effect.pipe('x', EffectString.repeat(16 * 1_048_576 + 1))},
    {fileName: 'expired.ts', text: 'export const expired = 1;', deadline: Date.now() - 1},
  ]) {
    const refused = await refusal(session.withSourceFile(input, () => 'parsed'));
    expect(Schema.is(NativeTypeScriptUnavailable)(refused) && refused.reason).toBe('input-budget');
  }
  expect(
    await session.withSourceFile({fileName: 'healthy.ts', text: 'export const healthy = 1;'}, () => 'parsed'),
  ).toBe('parsed');
});

native(it)(
  'fails a borrowed in-flight request promptly when its owner closes, without unhandled rejections',
  async () => {
    const owner = await createNativeTypeScriptTestSession();
    const original = nativeTypeScriptSessionOwnership(owner);
    // A parser worker's view: a pipe client borrowing the owner's socket, with only the long per-request cap.
    const borrowed = await connectNativeTypeScriptPipeSession({
      pipe: original.pipe,
      endpointDirectory: original.endpointDirectory,
      sdkDirectory: original.sdkDirectory,
      deadline: Date.now() + 30_000,
    });
    // No warm-up: the first operation connects and attaches the watch before its own request.
    // Large enough that parsing is still in flight when the owner closes underneath it.
    const text = Effect.pipe('export const value = [1, 2, 3].map(item => item * 2);\n', EffectString.repeat(200_000));
    const started = Date.now();
    const inFlight = borrowed
      .withSourceFile({fileName: 'slow.ts', text}, () => 'parsed')
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    await new Promise(resolve => setTimeout(resolve, 20));
    await owner.close().catch(() => undefined);
    const failure = await inFlight;
    // Owner loss surfaces at once as the typed session failure, not after the 60-second request cap.
    expect(failure === undefined || Schema.is(NativeTypeScriptUnavailable)(failure)).toBe(true);
    expect(Date.now() - started).toBeLessThan(10_000);
    await borrowed.close().catch(() => undefined);
    await new Promise(resolve => setTimeout(resolve, 200));
    // The owner drained, so the process still admits a new native session.
    expect(nativeTypeScriptOwnershipUnknown()).toBe(false);
    const next = await createNativeTypeScriptTestSession();
    try {
      expect(await next.withSourceFile({fileName: 'next.ts', text: 'export const next = 1;'}, () => 'parsed')).toBe(
        'parsed',
      );
    } finally {
      await next.close();
    }
  },
);

native(it)('fails its own first in-flight request when closed from outside, without unhandled rejections', async () => {
  const session = await createNativeTypeScriptTestSession();
  const text = Effect.pipe('export const value = [1, 2, 3].map(item => item * 2);\n', EffectString.repeat(200_000));
  const inFlight = session
    .withSourceFile({fileName: 'first.ts', text}, () => 'parsed')
    .then(
      () => undefined,
      (error: unknown) => error,
    );
  await new Promise(resolve => setTimeout(resolve, 20));
  const started = Date.now();
  await session.close().catch(() => undefined);
  const failure = await inFlight;
  expect(failure === undefined || Schema.is(NativeTypeScriptUnavailable)(failure)).toBe(true);
  expect(Date.now() - started).toBeLessThan(10_000);
  await new Promise(resolve => setTimeout(resolve, 200));
  expect(nativeTypeScriptOwnershipUnknown()).toBe(false);
});

native(it)(
  'lets a process exit promptly after a borrowed session lost its owner, also mid- and late-response, and every session closed',
  () => {
    // The process boundary is the contract: no socket, timer or child handle may outlive the closed sessions.
    const runtime = Bun.fileURLToPath(new URL('../../src/typescript_runtime.ts', import.meta.url));
    const script = `
    const runtime = await import(${JSON.stringify(runtime)});
    const assetDirectory = ${JSON.stringify(nativeTypeScriptTestAssetDirectory())};
    const open = () => runtime.createNativeTypeScriptSession({cwd: process.cwd(), deadline: Date.now() + 60_000, assetDirectory});
    const borrow = owner => {
      const original = runtime.nativeTypeScriptSessionOwnership(owner);
      return runtime.connectNativeTypeScriptPipeSession({
        pipe: original.pipe, endpointDirectory: original.endpointDirectory, sdkDirectory: original.sdkDirectory,
        deadline: Date.now() + 30_000,
      });
    };
    // A large response streams for a while, so a late close can land while a frame is only partly received.
    const text = Array.from({length: 120_000}, (_, index) =>
      'export function f' + index + '(a: number, b: string): Promise<Map<string, number[]>> { return g(a, b, [1, 2, 3].map(x => x * a)); }',
    ).join('\\n');
    const measuredOwner = await open();
    const measured = await borrow(measuredOwner);
    const started = Date.now();
    await measured.withSourceFile({fileName: 'measure.ts', text}, () => 'parsed');
    const duration = Date.now() - started;
    await measured.close();
    await measuredOwner.close();
    // Early, mid-response, and just before the response completes (the owner's FIN then races the lease release).
    for (const delay of [20, Math.floor(duration * 0.9), Math.floor(duration * 0.95), Math.floor(duration * 0.98)]) {
      const owner = await open();
      const borrowed = await borrow(owner);
      await borrowed.withSourceFile({fileName: 'warm.ts', text: 'export {};'}, () => 'warm');
      const inFlight = borrowed.withSourceFile({fileName: 'slow.ts', text}, () => 'parsed').catch(error => error);
      await new Promise(resolve => setTimeout(resolve, delay));
      await owner.close().catch(() => undefined);
      await inFlight;
      await borrowed.close().catch(() => undefined);
    }
    const third = await open();
    await third.withSourceFile({fileName: 'third.ts', text: 'export const third = 1;'}, () => 'parsed');
    await third.close();
  `;
    const started = Date.now();
    const result = Bun.spawnSync([process.execPath, '--eval', script], {
      stderr: 'pipe',
      stdout: 'pipe',
      timeout: 60_000,
    });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    // Well under the reader's ten-second partial-frame timer plus the work itself.
    expect(Date.now() - started).toBeLessThan(60_000);
  },
  90_000,
);

native(it)('charges a killed but drained owner to its own session only, never to the process', async () => {
  const session = await createNativeTypeScriptTestSession();
  // An externally killed owner drains with a nonzero exit: a known-gone anomaly, not unknown ownership.
  runtimeTerminateOwnedProviderTree(nativeTypeScriptSessionOwnership(session).owner, 'kill');
  await expect(session.close()).rejects.toThrow();
  expect(nativeTypeScriptOwnershipUnknown()).toBe(false);
  const next = await createNativeTypeScriptTestSession();
  try {
    expect(await next.withSourceFile({fileName: 'next.ts', text: 'export const next = 1;'}, () => 'parsed')).toBe(
      'parsed',
    );
  } finally {
    await next.close();
  }
});

native(it)('round-trips every UTF-16 code unit through the staged frontend codec without dropping BOMs', async () => {
  const asset = nativeTypeScriptTestAssetDirectory();
  const loaded: unknown = await import(Bun.pathToFileURL(join(asset, 'sdk/dist/api/node/wtf8.js')).href);
  const isCodec = (
    value: unknown,
  ): value is {Wtf8Decoder: new () => TextDecoder; encodeWtf8(text: string): Uint8Array} =>
    value !== null &&
    typeof value === 'object' &&
    'Wtf8Decoder' in value &&
    typeof value.Wtf8Decoder === 'function' &&
    'encodeWtf8' in value &&
    typeof value.encodeWtf8 === 'function';
  if (!isCodec(loaded)) throw new Error('Invalid staged native TypeScript codec');
  const codec = loaded;
  const check = (text: string) => {
    const original = text;
    expect(new codec.Wtf8Decoder().decode(codec.encodeWtf8(text))).toBe(original);
    expect(text).toBe(original);
  };
  for (const text of ['\ufeffexport const x = 1;', '\ufeff\ufeffx', '\ud800\ufeffx', '\udc00\ufeffx', '😀\ufeff'])
    check(text);
  FC.assert(
    FC.property(FC.array(FC.integer({min: 0, max: 0xffff}), {maxLength: 128}), units => {
      check(String.fromCharCode(...units));
    }),
    {numRuns: 64},
  );
});

native(it)('retains BOM-prefixed source text and native UTF-16 identifier offsets in a real source lease', async () => {
  const nativeSession = await getNativeSession();
  const text = '\ufeff// 😀 UTF-16 prefix\nexport const example = "\ufeffinside";';
  const input = {fileName: 'bom-offset.ts', text};
  const before = structuredClone(input);
  await nativeSession.withSourceFile(input, source => {
    expect(source.text).toBe(text);
    expect(source.getFullText()).toBe(text);
    const expected = Effect.Option.getOrThrow(EffectString.indexOf('example')(text));
    let matches = 0;
    let literals = 0;
    const visit = (node: import('typescript/ast').Node): void => {
      if (nativeSession.ast.isIdentifier(node) && node.text === 'example') {
        expect(node.getStart(source)).toBe(expected);
        expect(node.end).toBe(expected + 'example'.length);
        expect(node.getText(source)).toBe('example');
        expect(EffectString.slice(node.getStart(source), node.end)(text)).toBe('example');
        matches++;
      }
      if (nativeSession.ast.isStringLiteralLikeNode(node)) {
        expect(node.text).toBe('\ufeffinside');
        literals++;
      }
      node.forEachChild(visit);
    };
    visit(source);
    expect(matches).toBe(1);
    expect(literals).toBe(1);
  });
  expect(input).toEqual(before);
});
