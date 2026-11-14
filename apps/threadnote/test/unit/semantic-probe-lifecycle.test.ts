import {isJsonObject} from '@threadnote/platform/json';
import {sha256HexSync} from '@threadnote/platform/sha256';
import * as Schema from 'effect/Schema';
import * as EffectArray from 'effect/Array';
import * as EffectOption from 'effect/Option';
import * as EffectString from 'effect/String';
import {Effect} from 'effect';
import * as BunServices from '@effect/platform-bun/BunServices';
/* oxlint-disable effecttsgo/node-builtin-import -- Integration regressions exercise actual runner processes and OS signals. */
import {spawn} from 'node:child_process';
import {access, chmod, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {expect, it, vi} from 'vitest';
import fc from 'fast-check';
import {
  candidateFailure,
  candidateFailureEvidence,
  verifiedJavaGradleCandidateCleanup,
  candidateDispatchInputBinding,
} from '../evaluation/semantic-qualification/candidate.js';
import {LspFault} from '../../src/semantic/lsp_transport.js';
import {makeJavaWorkspace} from '../../src/semantic/providers/java_runtime.js';
import {
  withinProbeDeadline,
  installProbeSignalCleanup,
  ownedProbeGroup,
  releaseProbeHandles,
} from '../../../../tools/semantic/semantic_probe_process.js';
const fixture = resolve('apps/threadnote/test/fixtures/semantic/fake-provider.ts');
it.each(['timeout', 'protocol', 'prerequisite'] as const)(
  'retains the production %s fault code despite its empty Error message',
  async code => {
    const error = LspFault.make({code});
    // Promise rejection identity is the candidate runner boundary under test, not an Effect service.
    // oxlint-disable-next-line threadnote/no-effect-runtime-in-tests -- Exercises the actual runner Effect-to-Promise rejection boundary, an explicit Promise contract.
    const observed = await Effect.runPromise(Effect.fail(error)).catch((failure: unknown) => failure);
    expect(observed).toBe(error);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe('');
    expect(candidateFailure(observed)).toBe('Semantic provider fault: ' + code);
  },
);
it('preserves bounded typed preparation refusal context through the actual Promise boundary', async () => {
  const diagnostic = {
    reason: 'unexpected-copied-project-entry' as const,
    entryType: 'Directory' as const,
    relativePath: '.settings/unexpected-import-output',
  };
  const error = LspFault.make({code: 'prerequisite', preparationDiagnostic: diagnostic});
  // oxlint-disable-next-line threadnote/no-effect-runtime-in-tests -- Actual runner Effect-to-Promise rejection identity is this boundary contract.
  const observed = await Effect.runPromise(Effect.fail(error)).catch((failure: unknown) => failure);
  expect(observed).toBe(error);
  expect(error.message).toBe('');
  expect(candidateFailure(observed)).toBe('Semantic provider fault: prerequisite');
  expect(candidateFailureEvidence(observed)).toEqual({
    code: 'prerequisite',
    sourceFrames: [],
    preparationDiagnostic: diagnostic,
  });
});
it('omits malformed or unsafe preparation context without changing the original fault', () => {
  const error = LspFault.make({code: 'prerequisite'});
  const valid = {reason: 'unexpected-copied-project-entry', entryType: 'File'};
  for (const malformed of [
    {...valid, reason: 'unknown-reason'},
    {...valid, entryType: 'SymbolicLink'},
    ...EffectArray.map(
      [
        '/external/root',
        'C:/private/root',
        '\\\\host\\share',
        '../escape',
        'a/../escape',
        'a//b',
        '.',
        '',
        'a\nsecret',
        'hidden\u202Ename',
        EffectString.repeat(513)('x'),
      ],
      relativePath => ({...valid, relativePath}),
    ),
  ]) {
    // A mutable genuine class instance must not make unvalidated fields trusted.
    Object.defineProperty(error, 'preparationDiagnostic', {value: malformed, configurable: true});
    expect(candidateFailure(error)).toBe('Semantic provider fault: prerequisite');
    expect(candidateFailureEvidence(error)).toEqual({code: 'prerequisite', sourceFrames: []});
  }
  Object.defineProperty(error, 'preparationDiagnostic', {value: valid, configurable: true});
  expect(candidateFailureEvidence(error)?.preparationDiagnostic).toEqual(valid);
  Object.defineProperty(error, 'preparationDiagnostic', {
    value: {...valid, relativePath: EffectString.repeat(512)('x'), secret: '/external/cause'},
    configurable: true,
  });
  expect(candidateFailureEvidence(error)?.preparationDiagnostic).toEqual({
    ...valid,
    relativePath: EffectString.repeat(512)('x'),
  });
  let reads = 0;
  const changing = {
    ...valid,
    get relativePath() {
      return ++reads === 1 ? 'bounded-entry' : '/external/secret';
    },
  };
  Object.defineProperty(error, 'preparationDiagnostic', {value: changing, configurable: true});
  expect(candidateFailureEvidence(error)?.preparationDiagnostic).toEqual({...valid, relativePath: 'bounded-entry'});
  expect(reads).toBe(1);
  expect(
    candidateFailureEvidence({_tag: 'LspFault', code: 'prerequisite', preparationDiagnostic: valid}),
  ).toBeUndefined();
});
it('projects only closed actual production codes and preserves the unexpected-error fallback', () => {
  fc.assert(
    fc.property(fc.string({maxLength: 512}), text => {
      const unexpected = new Error(text, {cause: new Error('/private/secret-cause')});
      expect(candidateFailure(unexpected)).toBe(text);
      expect(candidateFailure({_tag: 'LspFault', code: 'timeout', message: text})).toBe('Unknown failure');
      const actual = LspFault.make({code: 'timeout'});
      Object.defineProperty(actual, 'message', {value: text});
      expect(candidateFailure(actual)).toBe('Semantic provider fault: timeout');
      const malformed = Object.assign(LspFault.make({code: 'timeout'}), {code: text + '-not-a-code'});
      expect(candidateFailure(malformed)).toBe(malformed.message);
    }),
    {numRuns: 40},
  );
});
it('retains the actual pure production guard source coordinate through the Promise boundary', async () => {
  // The nonabsolute parent refuses before filesystem/native acquisition; only the Promise error contract is tested.
  // oxlint-disable-next-line threadnote/no-effect-runtime-in-tests -- Exercises the runner's actual Effect-to-Promise error boundary, not an Effect service test.
  const error = await Effect.runPromise(
    makeJavaWorkspace('not-an-absolute-parent').pipe(
      Effect.scoped,
      // oxlint-disable-next-line effecttsgo/strict-effect-provide -- This Promise-boundary test entry point supplies only filesystem/path services, no application layer.
      Effect.provide(BunServices.layer),
    ),
  ).catch((failure: unknown) => failure);
  const evidence = candidateFailureEvidence(error, {
    '../../../src/semantic/providers/java_runtime.ts': sha256HexSync(
      await readFile(resolve('apps/threadnote/src/semantic/providers/java_runtime.ts')),
    ),
  });
  expect(evidence?.code).toBe('prerequisite');
  expect(evidence?.sourceFrames).toContainEqual({
    path: 'apps/threadnote/src/semantic/providers/java_runtime.ts',
    line: expect.any(Number),
    column: expect.any(Number),
  });
  expect(evidence?.sourceFrames.length).toBeLessThanOrEqual(4);
});
it('bounds allowlisted source coordinates and excludes malformed, external and late stack data', () => {
  const source = resolve('apps/threadnote/src/semantic/providers/java_runtime.ts');
  const hashes = {'../../../src/semantic/providers/java_runtime.ts': EffectString.repeat(64)('a')};
  const error = LspFault.make({code: 'prerequisite'});
  error.stack = EffectArray.join(
    [
      'Error: secret header',
      '    at secretFunction (/external/secret.ts:1:2)',
      `    at prefix (/external${source}:3:4)`,
      `    at bad (${source}:0:4)`,
      ...EffectArray.map([1, 2, 3, 4, 5], line => `    at hiddenFunction (${source}:${line}:9)`),
    ],
    '\n',
  );
  expect(candidateFailureEvidence(error, hashes)).toEqual({
    code: 'prerequisite',
    sourceFrames: EffectArray.map([1, 2, 3, 4], line => ({
      path: 'apps/threadnote/src/semantic/providers/java_runtime.ts',
      line,
      column: 9,
    })),
  });
  expect(candidateFailureEvidence(error, {})).toEqual({code: 'prerequisite', sourceFrames: []});
  error.stack = EffectString.repeat(4096)('x') + `\n    at late (${source}:99:9)`;
  expect(candidateFailureEvidence(error, hashes)).toEqual({code: 'prerequisite', sourceFrames: []});
  expect(candidateFailureEvidence({_tag: 'LspFault', code: 'prerequisite', stack: source}, hashes)).toBeUndefined();
});
const quote = (value: string) => `'${EffectString.replaceAll("'", "'\\''")(value)}'`;
const observe = async (path: string) => {
  const deadline = performance.now() + 5000;
  while (performance.now() < deadline) {
    try {
      return Schema.decodeUnknownSync(
        Schema.Struct({
          pid: Schema.Finite,
          descendant: Schema.optional(Schema.Finite),
          cwd: Schema.String,
        }),
      )(JSON.parse(await readFile(path, 'utf8')));
    } catch {
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  }
  throw new Error('Owned process did not report startup');
};
const gone = (pid: number) => {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    if (isJsonObject(error) && error.code === 'ESRCH') return true;
    throw error;
  }
};
const reap = (pid: number) => {
  try {
    process.kill(-pid, 'SIGKILL');
  } catch (error) {
    if (!isJsonObject(error) || error.code !== 'ESRCH') throw error;
  }
};
it.skipIf(process.platform === 'win32')(
  'returns an unknown-exit receipt and releases handles when group signals are denied',
  async () => {
    const scratch = await mkdtemp(join(tmpdir(), 'semantic-denied-exit-test-'));
    const pidReceipt = join(scratch, 'pid.json');
    const output = join(scratch, 'result.json');
    const config = join(scratch, 'config.json');
    await writeFile(
      config,
      JSON.stringify({
        id: 'uncooperative-fixture',
        version: 'test',
        language: 'python',
        command: process.execPath,
        args: [fixture, 'deny-exit', pidReceipt],
      }),
    );
    const child = spawn(
      process.execPath,
      [
        '--preload',
        resolve('apps/threadnote/test/fixtures/semantic/deny-process-kill.ts'),
        'scripts/qualify-semantic-providers.ts',
        '--probe',
        '--config',
        config,
        '--output',
        output,
      ],
      {stdio: 'ignore', detached: true},
    );
    const exited = new Promise<number | null>(resolve => child.once('exit', resolve));
    const group = ownedProbeGroup(child);
    let owned: Awaited<ReturnType<typeof observe>> | undefined;
    try {
      owned = await observe(pidReceipt);
      expect(await withinProbeDeadline(exited, 10000)).toBe(1);
      const report = JSON.parse(await readFile(output, 'utf8'));
      expect(report).toMatchObject({
        scratchRetained: true,
        stop: {exitObserved: false, exitTimedOut: true, code: null, signal: null, cleanup: {drained: false}},
      });
      expect(gone(owned.pid)).toBe(false);
      await access(owned.cwd);
    } finally {
      if (owned) {
        reap(owned.pid);
        await rm(owned.cwd, {recursive: true, force: true});
      }
      await group.cleanup();
      releaseProbeHandles(child);
      await rm(scratch, {recursive: true, force: true});
    }
  },
  15000,
);
it.skipIf(process.platform === 'win32').each([
  ['provider', 'SIGINT'],
  ['provider', 'SIGTERM'],
  ['editor', 'SIGINT'],
  ['editor', 'SIGTERM'],
] as const)(
  'cleans the live owned %s group on %s',
  async (kind, signal) => {
    const scratch = await mkdtemp(join(tmpdir(), 'semantic-interrupt-test-'));
    const pidReceipt = join(scratch, 'pid.json');
    const output = join(scratch, 'result.json');
    let args: string[];
    if (kind === 'provider') {
      const config = join(scratch, 'config.json');
      await writeFile(
        config,
        JSON.stringify({
          id: 'interrupt-fixture',
          version: 'test',
          language: 'python',
          command: process.execPath,
          args: [fixture, 'interrupt-provider', pidReceipt],
        }),
      );
      args = ['scripts/qualify-semantic-providers.ts', '--probe', '--config', config, '--output', output];
    } else {
      const editor = join(scratch, 'editor');
      await writeFile(
        editor,
        `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(fixture)} interrupt-editor ${quote(pidReceipt)} "$@"\n`,
      );
      await chmod(editor, 0o755);
      args = ['scripts/qualify-semantic-editors.ts', '--probe', '--editor', editor, '--output', output];
    }
    const child = spawn(process.execPath, args, {stdio: 'ignore', detached: true});
    const exited = new Promise<number | null>(resolve => child.once('exit', resolve));
    const group = ownedProbeGroup(child);
    let owned: Awaited<ReturnType<typeof observe>> | undefined;
    try {
      owned = await observe(pidReceipt);
      expect(gone(owned.pid)).toBe(false);
      child.kill(signal);
      expect(await withinProbeDeadline(exited, 10000)).toBe(signal === 'SIGINT' ? 130 : 143);
      const report = JSON.parse(await readFile(output, 'utf8'));
      expect(report).toMatchObject({status: 'interrupted', signal, scratchRetained: false});
      expect(kind === 'provider' ? report.stop.cleanup.drained : report.cleanup.drained).toBe(true);
      expect(gone(owned.pid)).toBe(true);
      expect(gone(owned.descendant!)).toBe(true);
      await expect(access(owned.cwd)).rejects.toThrow();
    } finally {
      if (owned) reap(owned.pid);
      await group.cleanup();
      releaseProbeHandles(child);
      await rm(scratch, {recursive: true, force: true});
    }
  },
  15000,
);

const captureProcessExit = () => {
  const original = Object.getOwnPropertyDescriptor(process, 'exit');
  if (!original) throw new Error('Missing OS exit boundary');
  const exit = vi.fn();
  Object.defineProperty(process, 'exit', {...original, value: exit});
  return {exit, restoreExit: () => Object.defineProperty(process, 'exit', original)};
};

it.each([
  {milliseconds: undefined, expected: 8000},
  {milliseconds: 40000, expected: 40000},
  {milliseconds: 45000, expected: 45000},
])(
  'keeps the finite cleanup deadline at $expected milliseconds and starts cleanup once',
  async ({milliseconds, expected}) => {
    vi.useFakeTimers();
    // Capture the OS exit boundary so this unit test cannot terminate its owning runner.
    const {exit, restoreExit} = captureProcessExit();
    const beforeInt = new Set(process.listeners('SIGINT'));
    const beforeTerm = new Set(process.listeners('SIGTERM'));
    const cleanup = vi.fn(() => new Promise<void>(() => {}));
    const signals = installProbeSignalCleanup(cleanup, {milliseconds});
    try {
      const interrupt = EffectOption.getOrUndefined(
        EffectArray.findFirst(process.listeners('SIGINT'), listener => !beforeInt.has(listener)),
      );
      const terminate = EffectOption.getOrUndefined(
        EffectArray.findFirst(process.listeners('SIGTERM'), listener => !beforeTerm.has(listener)),
      );
      expect(interrupt).toBeTypeOf('function');
      expect(terminate).toBeTypeOf('function');
      interrupt!('SIGINT');
      terminate!('SIGTERM');
      expect(cleanup).toHaveBeenCalledExactlyOnceWith('SIGINT');
      await vi.advanceTimersByTimeAsync(expected - 1);
      expect(exit).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(exit).toHaveBeenCalledExactlyOnceWith(130);
      expect(signals.interrupted).toBe('SIGINT');
    } finally {
      signals.dispose();
      restoreExit();
      vi.useRealTimers();
    }
  },
);
it('awaits asynchronous cleanup before the hard exit', async () => {
  vi.useFakeTimers();
  // This Promise/OS-boundary unit captures exit without creating any engine or native ownership receipt.
  const {exit, restoreExit} = captureProcessExit();
  let complete = () => {};
  const stopped = new Promise<void>(resolve => {
    complete = resolve;
  });
  const before = new Set(process.listeners('SIGTERM'));
  const signals = installProbeSignalCleanup(() => stopped, {milliseconds: 40000});
  try {
    EffectOption.getOrUndefined(
      EffectArray.findFirst(process.listeners('SIGTERM'), listener => !before.has(listener)),
    )!('SIGTERM');
    await vi.advanceTimersByTimeAsync(30000);
    expect(exit).not.toHaveBeenCalled();
    complete();
    await vi.advanceTimersByTimeAsync(0);
    expect(exit).toHaveBeenCalledExactlyOnceWith(143);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    signals.dispose();
    restoreExit();
    vi.useRealTimers();
  }
});
it('refuses invalid cleanup policies without registering listeners', () => {
  const invalid = fc.oneof(
    fc.integer({min: -100000, max: 0}),
    fc.integer({min: 45001, max: 100000}),
    fc.constantFrom(NaN, Infinity, -Infinity, 0.5),
  );
  fc.assert(
    fc.property(invalid, milliseconds => {
      const before = [process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')];
      expect(() => installProbeSignalCleanup(async () => {}, {milliseconds})).toThrow(
        'Invalid finite signal cleanup deadline',
      );
      expect([process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')]).toEqual(before);
    }),
    {numRuns: 32},
  );
});
it('never lets raw argv select a longer candidate cleanup policy', async () => {
  await fc.assert(
    fc.asyncProperty(fc.integer({min: -100000, max: 100000}), async milliseconds => {
      expect(
        await verifiedJavaGradleCandidateCleanup([
          '--candidate-manifest',
          '/not-a-candidate',
          '--provider-inputs',
          '/not-inputs',
          '--writer-fixture',
          '--output',
          '/not-output',
          '--cleanup-milliseconds',
          String(milliseconds),
        ]),
      ).toBeUndefined();
    }),
    {numRuns: 24},
  );
  expect(await verifiedJavaGradleCandidateCleanup(['--inventory', '--output', '/not-output'])).toBeUndefined();
});

it('conserves exact dispatcher metadata bytes and detects either input changing', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'semantic-input-binding-'));
  const candidate = join(scratch, 'candidate.json'),
    provider = join(scratch, 'provider.json');
  const args = [
    '--candidate-manifest',
    candidate,
    '--provider-inputs',
    provider,
    '--writer-fixture',
    '--output',
    join(scratch, 'report.json'),
  ];
  try {
    await fc.assert(
      fc.asyncProperty(
        fc.uint8Array({maxLength: 128}),
        fc.uint8Array({maxLength: 128}),
        async (candidateBytes, providerBytes) => {
          await writeFile(candidate, candidateBytes);
          await writeFile(provider, providerBytes);
          const original = await candidateDispatchInputBinding(args);
          expect(await candidateDispatchInputBinding(args)).toEqual(original);
          await writeFile(provider, new Uint8Array([...providerBytes, 0]));
          const changedProvider = await candidateDispatchInputBinding(args);
          expect(changedProvider?.candidateSha256).toBe(original?.candidateSha256);
          expect(changedProvider?.providerSha256).not.toBe(original?.providerSha256);
          await writeFile(candidate, new Uint8Array([...candidateBytes, 0]));
          expect((await candidateDispatchInputBinding(args))?.candidateSha256).not.toBe(original?.candidateSha256);
        },
      ),
      {numRuns: 24},
    );
  } finally {
    await rm(scratch, {recursive: true, force: true});
  }
});
