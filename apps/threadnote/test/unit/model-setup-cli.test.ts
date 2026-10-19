import {execFile} from '@threadnote/testing/node-child-process';
import {mkdir, mkdtemp, readFile, rm, stat, writeFile} from '@threadnote/testing/node-fs-promises';
import {tmpdir} from '@threadnote/testing/node-os';
import {join, resolve} from '@threadnote/testing/node-path';
import {promisify} from '@threadnote/testing/node-util';
import {afterEach, describe, expect, it} from 'vitest';

const execute = promisify(execFile);
const checkout = resolve(import.meta.dirname, '../../../..');
const standalone = join(checkout, 'apps/threadnote/src/standalone.ts');
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, {recursive: true, force: true})));
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'threadnote-model-setup-cli-'));
  roots.push(root);
  const userHome = join(root, 'user');
  await mkdir(userHome);
  const home = join(root, 'data');
  const env = {
    ...process.env,
    HOME: userHome,
    USERPROFILE: userHome,
    XDG_CONFIG_HOME: join(userHome, '.config'),
    THREADNOTE_HOME: home,
    THREADNOTE_INSTALL_ROOT: join(root, 'installation'),
    NO_COLOR: '1',
    OPENAI_API_KEY: 'dummy-unused-openai',
    ANTHROPIC_API_KEY: 'dummy-unused-anthropic',
    CI: '1',
  };
  return {root, home, env};
}
async function run(args: readonly string[], env: NodeJS.ProcessEnv) {
  return execute('bun', [standalone, ...args], {cwd: checkout, env, timeout: 15_000, maxBuffer: 64 * 1024});
}
async function exists(path: string) {
  return stat(path).then(
    () => true,
    () => false,
  );
}
async function until(check: () => Promise<boolean>, timeout = 8_000) {
  const started = Date.now();
  while (!(await check())) {
    if (Date.now() - started > timeout) throw new Error('Timed out waiting for isolated worker evidence.');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

const harnessSource = (home: string, entry: string, gate: string, entered: string) => `
import {Effect, Layer} from 'effect';
import {BunServices, BunRuntime} from '@effect/platform-bun';
import {FileSystem} from 'effect';
import {SystemInfo} from '@threadnote/platform/system';
import {HttpService} from '@threadnote/platform/http';
import {CommandExecutor} from '@threadnote/platform/command';
import {sha256Hex} from '@threadnote/platform/digest';
import {LocalModelCatalog} from '@threadnote/inference/models/catalog';
import {LocalModelStore} from '@threadnote/inference/models/store';
import {systemLayer, commandLayer} from ${JSON.stringify(join(checkout, 'apps/threadnote/src/effect/runtime-bootstrap.ts'))};
import {requestModelSetup, runModelSetupWorker, parseModelSetupWorkerArguments} from ${JSON.stringify(join(checkout, 'apps/threadnote/src/models/setup.ts'))};
const home = ${JSON.stringify(home)};
const bytes = new TextEncoder().encode('actual detached process fixture');
const catalog = Layer.effect(LocalModelCatalog, Effect.gen(function* () {
 const sha256 = yield* sha256Hex(bytes);
 const manifest = {architecture:'fixture',contextLimit:32,file:'fixture.gguf',id:'gemma-4-e4b-it-q4',license:'Apache-2.0',minimumRamBytes:1,
 quantization:'Q4_0',repository:'fixture/model',revision:'a'.repeat(40),role:'generation',runtime:{nodeLlamaCpp:'3.22.1'},sha256,size:bytes.length,version:1};
 return {get:()=>Effect.succeed(manifest),list:()=>Effect.succeed([manifest]),selected:()=>Effect.succeed(manifest)};
}));
const http = Layer.effect(HttpService, Effect.gen(function* () {
 const fs = yield* FileSystem.FileSystem;
 return {downloadToFile:(_url,target,options)=>Effect.gen(function* () {
   yield* fs.writeFileString(${JSON.stringify(entered)}, JSON.stringify({providerCredentials:Boolean(process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY),hasPath:Boolean(process.env.PATH)}));
   while (!(yield* fs.exists(${JSON.stringify(gate)}))) yield* Effect.sleep(20);
   yield* fs.writeFile(target,bytes.slice(options?.offset??0),{flag:(options?.offset??0)>0?'a':'w'});
   return {resumed:false,status:200};
 }),getJson:()=>Effect.die('No JSON'),getText:()=>Effect.die('No text'),getStatus:()=>Effect.die('No HTTP status')};
}));
const customSystem = Layer.effect(SystemInfo, Effect.gen(function*(){
 const system=yield* SystemInfo;
 return {...system,developmentEntrypoint:${JSON.stringify(entry)}};
})).pipe(Layer.provide(systemLayer));
const base = Layer.mergeAll(BunServices.layer,customSystem,commandLayer.pipe(Layer.provide(BunServices.layer)),catalog);
const store = LocalModelStore.layer.pipe(Layer.provide(Layer.merge(base,http.pipe(Layer.provide(base)))));
const layers=Layer.merge(base,store);
const args=process.argv.slice(2);
const parsed=args[0]==='model-setup-worker'?parseModelSetupWorkerArguments(args.slice(1)):undefined;
const program=parsed?runModelSetupWorker(parsed.home,parsed.intentEpoch,parsed.nonce):requestModelSetup(home).pipe(Effect.tap(status=>Effect.sync(()=>console.log(JSON.stringify(status)))),Effect.asVoid);
BunRuntime.runMain(program.pipe(Effect.provide(layers)),{disableErrorReporting:true});
`;

async function prepareHarness(f: Awaited<ReturnType<typeof fixture>>) {
  // Keep dependency resolution in this checkout while all mutable data remains in the isolated home.
  const entry = join(f.root, 'worker.ts');
  const gate = join(f.root, 'release-download');
  const entered = join(f.root, 'download-started');
  let source = harnessSource(f.home, entry, gate, entered);
  for (const name of [
    'effect',
    '@effect/platform-bun',
    '@threadnote/platform/system',
    '@threadnote/platform/http',
    '@threadnote/platform/command',
    '@threadnote/platform/digest',
    '@threadnote/inference/models/catalog',
    '@threadnote/inference/models/store',
  ]) {
    source = source.replaceAll(`from '${name}'`, `from ${JSON.stringify(import.meta.resolve(name))}`);
  }
  await writeFile(entry, source);
  return {entry, gate, entered};
}

describe('public background model setup CLI boundary', () => {
  it('status, dry-run and environment off stay read-only in an absent home', async () => {
    const f = await fixture();
    for (const args of [
      ['models', 'setup', '--status', '--json'],
      ['--home', f.home, 'models', 'setup', '--dry-run', '--json'],
    ]) {
      const result = await run(args, f.env);
      expect(JSON.parse(result.stdout)).toMatchObject({version: 1, phase: 'not-requested', artifactReady: false});
      expect(result.stderr).toBe('');
      expect(await exists(f.home)).toBe(false);
    }
    const result = await run(['models', 'setup', '--json'], {...f.env, THREADNOTE_MODEL_SETUP: 'off'});
    expect(JSON.parse(result.stdout)).toMatchObject({environmentOff: true, phase: 'not-requested'});
    expect(await exists(f.home)).toBe(false);
  });

  it('returns a bounded actionable error without exposing home paths from filesystem failures', async () => {
    const f = await fixture();
    await writeFile(f.home, 'private fixture bytes');
    const error = await run(['models', 'setup', '--json'], f.env).then(
      () => undefined,
      cause => cause as {stderr: string},
    );
    expect(error).toBeDefined();
    expect(error?.stderr).toContain('Check home permissions and retry');
    expect(error?.stderr).not.toContain(f.home);
    expect(error?.stderr).not.toContain('private fixture bytes');
  });

  it('rejects conflicting controls and stale private children without creating a home', async () => {
    const f = await fixture();
    await expect(run(['models', 'setup', '--status', '--retry'], f.env)).rejects.toThrow(/Use one of/);
    expect(await exists(f.home)).toBe(false);
    for (const args of [[], ['--home', f.home, '--epoch', '0', '--nonce', 'old-queued-child']]) {
      const result = await run(['model-setup-worker', ...args], f.env);
      expect(result.stdout).toBe('');
      expect(await exists(f.home)).toBe(false);
    }
  });

  it('a real detached worker survives parent exit and public off stops it without native initialization', async () => {
    const f = await fixture();
    const h = await prepareHarness(f);
    try {
      await execute('bun', [h.entry], {cwd: checkout, env: f.env, timeout: 10_000});
      await until(() => exists(h.entered)).catch(async error => {
        throw new Error(`${error.message}; state=${await readFile(join(f.home, 'models/setup.json'), 'utf8')}`);
      });
      expect(JSON.parse(await readFile(h.entered, 'utf8'))).toEqual({providerCredentials: false, hasPath: true});
      const state = JSON.parse(await readFile(join(f.home, 'models/setup.json'), 'utf8'));
      expect(state).toMatchObject({phase: 'downloading', owner: {token: state.owner.token}});
      expect(state.owner.processId).toBeGreaterThan(0);
      const result = await run(['models', 'setup', '--auto', 'off', '--json'], f.env);
      expect(JSON.parse(result.stdout)).toMatchObject({phase: 'off', effectiveDefault: false});
      const stopped = JSON.parse(await readFile(join(f.home, 'models/setup.json'), 'utf8'));
      expect(stopped.drainingOwner).toBeUndefined();
      await writeFile(h.gate, 'release');
      expect(await exists(join(f.home, 'models/generation/gemma-4-e4b-it-q4', state.job.sha256 + '.gguf'))).toBe(false);
    } finally {
      await rm(h.entry, {force: true});
    }
  }, 20_000);

  it.each([
    ['local-ai', 'disable'],
    ['models', 'remove', 'gemma-4-e4b-it-q4'],
    ['local-ai', 'uninstall', '--erase-model'],
  ])(
    'public %j control stops background setup before changing selection or model files',
    async (...args) => {
      const f = await fixture();
      const h = await prepareHarness(f);
      try {
        await execute('bun', [h.entry], {cwd: checkout, env: f.env, timeout: 10_000});
        await until(() => exists(h.entered));
        await run(args, f.env);
        const state = JSON.parse(await readFile(join(f.home, 'models/setup.json'), 'utf8'));
        expect(state.policy).toBe('off');
        expect(state.drainingOwner).toBeUndefined();
        await writeFile(h.gate, 'release');
      } finally {
        await rm(h.entry, {force: true});
      }
    },
    20_000,
  );

  it('F002 stops setup before reporting an unavailable explicit model during local-ai uninstall', async () => {
    const f = await fixture();
    const h = await prepareHarness(f);
    try {
      await execute('bun', [h.entry], {cwd: checkout, env: f.env, timeout: 10_000});
      await until(() => exists(h.entered));
      const selection = JSON.stringify({version: 1, roles: {generation: 'retired-explicit-model'}});
      await writeFile(join(f.home, 'models/selection.json'), selection);
      await run(['local-ai', 'uninstall', '--erase-model'], f.env).catch(() => undefined);
      const state = JSON.parse(await readFile(join(f.home, 'models/setup.json'), 'utf8'));
      expect(state.policy).toBe('off');
      expect(state.drainingOwner).toBeUndefined();
      expect(await readFile(join(f.home, 'models/selection.json'), 'utf8')).toBe(selection);
    } finally {
      await run(['models', 'setup', '--auto', 'off', '--json'], f.env).catch(() => undefined);
      await rm(h.entry, {force: true});
    }
  }, 20_000);

  it('public uninstall drains a blocked worker and a queued stale child cannot recreate the erased home', async () => {
    const f = await fixture();
    const h = await prepareHarness(f);
    try {
      await execute('bun', [h.entry], {cwd: checkout, env: f.env, timeout: 10_000});
      await until(() => exists(h.entered)).catch(async error => {
        throw new Error(`${error.message}; state=${await readFile(join(f.home, 'models/setup.json'), 'utf8')}`);
      });
      const state = JSON.parse(await readFile(join(f.home, 'models/setup.json'), 'utf8'));
      await writeFile(join(f.home, 'layout.json'), JSON.stringify({createdBy: 'threadnote', version: 2}));
      const result = await run(['uninstall', '--erase-memories', '--mcp', 'none'], f.env);
      expect(result.stdout).toContain('Uninstall complete');
      expect(await exists(f.home)).toBe(false);
      await run(
        ['model-setup-worker', '--home', f.home, '--epoch', String(state.intentEpoch), '--nonce', state.owner.token],
        f.env,
      );
      await writeFile(h.gate, 'release');
      expect(await exists(f.home)).toBe(false);
    } finally {
      await rm(h.entry, {force: true});
    }
  }, 25_000);
});
