import {spawn, spawnSync} from '@threadnote/testing/node-child-process';
import {resolve} from '@threadnote/testing/node-path';
import {mkdir, mkdtemp, readFile, readdir, rm, writeFile} from '@threadnote/testing/node-fs-promises';
import {tmpdir} from '@threadnote/testing/node-os';
import {expect, it} from 'vitest';
import fc from 'fast-check';

// This OS/compiled CLI boundary exercises the extracted native release.
// The literal directory declares the copied fixture/helper closure to Bazel.
const nativeFixtures = ['native-release-workflows.ts', 'release-tools-fixture.ts', 'release-artifact.ts'];
const archive = process.env.THREADNOTE_RELEASE_ARCHIVE;

const collectDelayedChild = async (child: ReturnType<typeof spawn>) => {
  const output: Buffer[] = [];
  const errors: Buffer[] = [];
  let failure: Error | undefined;
  // close covers process exit and closure of both stdio streams, including after error.
  const completed = new Promise<{code: number | null; signal: string | null}>(resolve => {
    child.once('error', error => {
      failure ??= error;
    });
    child.once('close', (code, signal) => resolve({code, signal}));
  });
  const timer = setTimeout(() => child.kill(), 15_000);
  try {
    if (!child.stdout || !child.stderr) throw new Error('Expected both compiled fixture output pipes.');
    const streamFailure = (error: Error) => {
      failure ??= error;
    };
    child.stdout.once('error', streamFailure);
    child.stderr.once('error', streamFailure);
    // Hold both OS pipes unread long enough to force backpressure above their capacity.
    child.stdout.on('data', chunk => output.push(Buffer.from(chunk)));
    child.stderr.on('data', chunk => errors.push(Buffer.from(chunk)));
    child.stdout.pause();
    child.stderr.pause();
    await new Promise(resolve => setTimeout(resolve, 150));
    child.stdout.resume();
    child.stderr.resume();
    const exit = await completed;
    if (failure) throw failure;
    expect(exit.signal).toBeNull();
    return {...exit, stdout: Buffer.concat(output), stderr: Buffer.concat(errors)};
  } finally {
    clearTimeout(timer);
    if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) child.kill();
    await completed;
  }
};

it.each(['process', 'stdout', 'stderr'] as const)(
  'retains delayed child %s errors and holds cleanup until close',
  async boundary => {
    const child = spawn(
      process.execPath,
      ['-e', "process.stdout.write('ready'); process.stdin.resume(); process.stdin.on('end', () => process.exit(0));"],
      {stdio: ['pipe', 'pipe', 'pipe']},
    );
    const ready = new Promise<void>(resolve => child.stdout.once('data', () => resolve()));
    const closed = new Promise<void>(resolve => child.once('close', () => resolve()));
    const primary = new Error(`${boundary} error before close`);
    let cleanupStarted = false;
    let pipesClosedAtSettlement = false;
    let result: unknown;
    const outcome = collectDelayedChild(child)
      .finally(() => {
        cleanupStarted = true;
        pipesClosedAtSettlement = child.stdout.destroyed && child.stderr.destroyed;
      })
      .then(
        () => undefined,
        error => error,
      );
    try {
      await Promise.race([
        ready,
        outcome.then(error => {
          throw error ?? new Error('Child closed before ready.');
        }),
      ]);
      (boundary === 'process' ? child : child[boundary]).emit('error', primary);
      await new Promise<void>(resolve => globalThis.setImmediate(resolve));
      expect(cleanupStarted).toBe(false);
      expect(child.exitCode).toBeNull();
      expect(child.stdout.destroyed).toBe(false);
      expect(child.stderr.destroyed).toBe(false);
    } finally {
      child.stdin.end();
      try {
        result = await outcome;
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill();
        await closed;
      }
    }
    expect(result).toBe(primary);
    expect(cleanupStarted).toBe(true);
    expect(pipesClosedAtSettlement).toBe(true);
  },
);

it.skipIf(!archive)(
  'runs extracted native workflows without external interpreters or source access',
  async () => {
    if (!archive) throw new Error('Missing release archive.');
    const temporary = await mkdtemp(resolve(tmpdir(), 'threadnote-release-tools-'));
    try {
      const tools = resolve(temporary, process.platform === 'win32' ? 'fixture-tools.exe' : 'fixture-tools');
      const harness = resolve(temporary, process.platform === 'win32' ? 'release-artifact.exe' : 'release-artifact');
      const build = await Bun.build({
        entrypoints: [resolve('apps/threadnote/test/dev-skills/release-tools-fixture.ts')],
        compile: {outfile: tools},
      });
      expect(build.success, JSON.stringify(build.logs)).toBe(true);
      const harnessBuild = await Bun.build({
        entrypoints: [resolve('apps/threadnote/test/dev-skills/release-artifact.ts')],
        compile: {outfile: harness},
      });
      expect(harnessBuild.success, JSON.stringify(harnessBuild.logs)).toBe(true);
      const result = spawnSync(
        harness,
        [
          '--archive',
          resolve(archive),
          '--checkout',
          process.cwd(),
          '--report',
          resolve(process.env.THREADNOTE_RELEASE_REPORT ?? '.context/release-artifact/result.json'),
          '--tools',
          tools,
          ...(process.platform === 'win32' ? ['--functional-only'] : []),
        ],
        {encoding: 'utf8', timeout: 1_850_000},
      );
      expect(result.error, result.error?.message).toBeUndefined();
      expect(result.status, `${result.stdout}\n${result.stderr}\nFixtures: ${nativeFixtures.join(', ')}`).toBe(0);
    } finally {
      await rm(temporary, {recursive: true, force: true});
    }
  },
  1_860_000,
);

it('forwards complete real Git bytes through the compiled fixture to a delayed consumer', async () => {
  const temporary = await mkdtemp(resolve(tmpdir(), 'threadnote-release-pipe-'));
  let primaryFailure: {error: unknown} | undefined;
  try {
    const nativeGit = Bun.which('git');
    if (!nativeGit) throw new Error('Git is required for the compiled fixture boundary.');
    const proxy = resolve(temporary, process.platform === 'win32' ? 'git.exe' : 'git');
    const repo = resolve(temporary, 'objects.git');
    const build = await Bun.build({
      entrypoints: [resolve('apps/threadnote/test/dev-skills/release-tools-fixture.ts')],
      compile: {outfile: proxy},
    });
    expect(build.success, JSON.stringify(build.logs)).toBe(true);
    await writeFile(resolve(temporary, 'tool-paths.json'), JSON.stringify({git: nativeGit}));
    expect(spawnSync(nativeGit, ['init', '--bare', repo], {timeout: 15_000}).status).toBe(0);
    const delayed = (args: readonly string[]) =>
      collectDelayedChild(
        spawn(proxy, [...args], {
          env: {...process.env, THREADNOTE_RELEASE_FIXTURE_ROOT: temporary},
          stdio: ['ignore', 'pipe', 'pipe'],
        }),
      );
    const diagnostic = (result: Awaited<ReturnType<typeof delayed>>) =>
      JSON.stringify({
        code: result.code,
        signal: result.signal,
        stdoutBytes: result.stdout.length,
        stderr: result.stderr.toString('utf8').slice(-4000),
      });
    const repositoryArgs = ['-C', repo, 'rev-parse', '--is-bare-repository'];
    const repository = await delayed(repositoryArgs);
    const piped = spawnSync(proxy, repositoryArgs, {
      env: {...process.env, THREADNOTE_RELEASE_FIXTURE_ROOT: temporary},
      input: '',
      encoding: 'utf8',
      timeout: 15_000,
    });
    const repositoryDiagnostic = JSON.stringify({
      ignoredStdin: diagnostic(repository),
      pipeStdin: {
        code: piped.status,
        error: piped.error?.message,
        stdout: piped.stdout?.slice(-100),
        stderr: piped.stderr?.slice(-4000),
      },
    });
    expect(repository.code, repositoryDiagnostic).toBe(0);
    expect(repository.stdout.toString('utf8').trim(), repositoryDiagnostic).toBe('true');
    expect(repository.stderr.length, repositoryDiagnostic).toBe(0);
    expect(piped.error, repositoryDiagnostic).toBeUndefined();
    expect(piped.status, repositoryDiagnostic).toBe(0);
    expect(piped.stdout.trim(), repositoryDiagnostic).toBe('true');
    expect(piped.stderr.length, repositoryDiagnostic).toBe(0);
    const empty = await delayed(['-C', repo, 'config', 'fixture.empty-output', 'true']);
    expect(empty.code, diagnostic(empty)).toBe(0);
    expect(empty.stdout.length, diagnostic(empty)).toBe(0);
    expect(empty.stderr.length, diagnostic(empty)).toBe(0);
    // Bounded property: arbitrary large byte lengths retain every binary byte and UTF-8 tail.
    await fc.assert(
      fc.asyncProperty(fc.integer({min: 1_048_576, max: 4_194_304}), async size => {
        const payload = Buffer.alloc(size);
        for (let index = 0; index < size; index++) payload[index] = index % 256;
        Buffer.from('final bytes — 日本語 🌊\n').copy(payload, size - 64);
        const stored = spawnSync(nativeGit, ['-C', repo, 'hash-object', '-w', '--stdin'], {
          input: payload,
          encoding: 'utf8',
          timeout: 15_000,
        });
        expect(stored.status).toBe(0);
        const result = await delayed(['-C', repo, 'cat-file', 'blob', stored.stdout.trim()]);
        expect(result.code, diagnostic(result)).toBe(0);
        expect(result.stderr.length).toBe(0);
        expect(result.stdout.length).toBe(payload.length);
        expect(result.stdout.subarray(-64).equals(payload.subarray(-64))).toBe(true);
        expect(result.stdout.equals(payload)).toBe(true);
      }),
      {numRuns: 3, endOnFailure: true},
    );
    const args = ['-C', repo, 'cat-file', 'blob', '0'.repeat(40)];
    const expected = spawnSync(nativeGit, args, {timeout: 15_000});
    expect(expected.status).not.toBe(0);
    const failure = await delayed(args);
    expect(failure.code, diagnostic(failure)).toBe(expected.status);
    expect(failure.stdout.equals(expected.stdout)).toBe(true);
    expect(failure.stderr.equals(expected.stderr)).toBe(true);
  } catch (error) {
    primaryFailure = {error};
  }
  try {
    await rm(temporary, {recursive: true, force: true});
  } catch (cleanupError) {
    if (primaryFailure) {
      throw new AggregateError([primaryFailure.error, cleanupError], 'Release pipe fixture and cleanup both failed.', {
        cause: cleanupError,
      });
    }
    throw cleanupError;
  }
  if (primaryFailure) throw primaryFailure.error;
}, 60_000);

it('captures bounded closed producer diagnostics only when the compiled Git fixture opts in', async () => {
  const temporary = await mkdtemp(resolve(tmpdir(), 'threadnote-release-trace-'));
  let primaryFailure: {error: unknown} | undefined;
  try {
    const nativeGit = Bun.which('git');
    if (!nativeGit) throw new Error('Git is required for the compiled fixture boundary.');
    const proxy = resolve(temporary, process.platform === 'win32' ? 'git.exe' : 'git');
    const repo = resolve(temporary, 'repo');
    const trace = resolve(temporary, 'publication-producer-events');
    const ioDirectory = resolve(temporary, 'trace-io');
    await mkdir(ioDirectory);
    let observerLoaded = false;
    const build = await Bun.build({
      entrypoints: [resolve('apps/threadnote/test/dev-skills/release-tools-fixture.ts')],
      compile: {outfile: proxy},
      // Observe real filesystem calls inside independent compiled producers.
      plugins: [
        {
          name: 'observe-producer-io',
          setup(builder) {
            // Bun resolves built-ins before onResolve, so redirect this import explicitly.
            builder.onLoad({filter: /release-tools-fixture\.ts$/u}, async args => ({
              contents: (await readFile(args.path, 'utf8')).replace("from 'node:fs'", "from 'producer-fs'"),
              loader: 'ts',
            }));
            builder.onResolve({filter: /^producer-fs$/u}, () => ({path: 'producer-fs', namespace: 'producer-fs'}));
            builder.onLoad({filter: /.*/u, namespace: 'producer-fs'}, () => {
              observerLoaded = true;
              return {
                contents: `import fs from 'node:fs';
                const counts = {checks: 0, opens: 0};
                export const existsSync = (...args) => { counts.checks++; return fs.existsSync(...args); };
                export const openSync = (...args) => { counts.opens++; return fs.openSync(...args); };
                export const closeSync = fs.closeSync;
                export const writeSync = fs.writeSync;
                process.on('exit', () => fs.writeFileSync(
                  ${JSON.stringify(ioDirectory)} + '/' + process.pid + '.json', JSON.stringify(counts)));
              `,
                loader: 'js',
              };
            });
          },
        },
      ],
    });
    expect(build.success, JSON.stringify(build.logs)).toBe(true);
    expect(observerLoaded).toBe(true);
    await writeFile(resolve(temporary, 'tool-paths.json'), JSON.stringify({git: nativeGit}));
    const git = (...args: string[]) => spawnSync(nativeGit, args, {timeout: 15_000});
    expect(git('init', repo).status).toBe(0);
    const sentinel = 'private-sentinel-path.txt';
    const content = Buffer.from('private-sentinel-content 日本語\n');
    await writeFile(resolve(repo, sentinel), content);
    expect(git('-C', repo, 'add', sentinel).status).toBe(0);
    expect(
      git(
        '-C',
        repo,
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.invalid',
        '-c',
        'commit.gpgsign=false',
        'commit',
        '-m',
        'fixture',
      ).status,
    ).toBe(0);
    const sha = git('-C', repo, 'rev-parse', 'HEAD').stdout.toString('utf8').trim();
    const environment = (enabled: boolean) => ({
      ...process.env,
      THREADNOTE_RELEASE_FIXTURE_ROOT: temporary,
      THREADNOTE_RELEASE_PUBLICATION_TRACE: enabled ? '1' : '0',
    });
    const io = async (pid: number) =>
      JSON.parse(await readFile(resolve(ioDirectory, `${pid}.json`), 'utf8')) as {checks: number; opens: number};
    const invoke = (spec: string, enabled: boolean) =>
      spawnSync(proxy, ['-C', repo, 'show', spec], {
        env: environment(enabled),
        timeout: 15_000,
      });
    await mkdir(trace);
    const disabled = invoke(`${sha}:${sentinel}`, false);
    expect(disabled.status).toBe(0);
    expect(disabled.stdout.equals(content)).toBe(true);
    expect(await readdir(trace)).toEqual([]);
    expect(await io(disabled.pid)).toEqual({checks: 0, opens: 0});
    const success = invoke(`${sha}:${sentinel}`, true);
    expect(success.status).toBe(0);
    expect(success.stdout.equals(content)).toBe(true);
    expect(success.stderr.length).toBe(0);
    expect(await io(success.pid)).toEqual({checks: 3, opens: 6});
    for (const spec of [`private-missing-object:${sentinel}`, 'HEAD:private-missing-path']) {
      const expected = git('-C', repo, 'show', spec);
      const actual = invoke(spec, true);
      expect(actual.status).toBe(expected.status);
      expect(actual.stdout.equals(expected.stdout)).toBe(true);
      expect(actual.stderr.equals(expected.stderr)).toBe(true);
    }
    const files = await readdir(trace);
    const raw = (await Promise.all(files.map(file => readFile(resolve(trace, file), 'utf8')))).join('');
    for (const secret of [sentinel, 'private-sentinel-content', repo, sha, 'private-missing-path']) {
      expect(raw).not.toContain(secret);
    }
    const events = raw
      .trim()
      .split('\n')
      .map(line => JSON.parse(line) as Record<string, unknown>);
    const allowed = new Set([
      'version',
      'pid',
      'event',
      'verb',
      'argc',
      'specForm',
      'pathCharacters',
      'pathBytes',
      'pathControl',
      'pathBackslash',
      'timeMs',
      'elapsedMs',
      'exit',
      'signal',
      'success',
      'stdoutBytes',
      'stderrBytes',
      'stderrCategory',
      'stdoutWritten',
      'stderrWritten',
      'complete',
      'phase',
      'errorCode',
      'syscall',
    ]);
    expect(events).toHaveLength(9);
    for (const event of events) expect(Object.keys(event).every(key => allowed.has(key))).toBe(true);
    expect(
      events
        .filter(event => event.event === 'result')
        .map(event => event.stderrCategory)
        .sort(),
    ).toEqual(['missing-object', 'missing-path', 'none']);
    expect(events.filter(event => event.event === 'forwarded').every(event => event.complete === true)).toBe(true);
    expect(events.some(event => event.specForm === 'SHA40')).toBe(true);
    // Preserve the original sequential last-slot boundary and occupied prefix.
    for (let slot = 9; slot < 127; slot++) await writeFile(resolve(trace, `${slot}.json`), '{}\n');
    const snapshot = async () =>
      Promise.all(Array.from({length: 128}, (_, slot) => readFile(resolve(trace, `${slot}.json`), 'utf8')));
    const prefix = await Promise.all(
      Array.from({length: 127}, (_, slot) => readFile(resolve(trace, `${slot}.json`), 'utf8')),
    );
    const bounded = invoke(`${sha}:${sentinel}`, true);
    expect(bounded.status).toBe(0);
    expect(bounded.stdout.equals(content)).toBe(true);
    expect(await readdir(trace)).toHaveLength(128);
    expect(JSON.parse(await readFile(resolve(trace, '127.json'), 'utf8')).event).toBe('start');
    const saturated = await snapshot();
    expect(saturated.slice(0, 127)).toEqual(prefix);
    const concurrent = async () => {
      const child = spawn(proxy, ['-C', repo, 'show', `${sha}:${sentinel}`], {
        env: environment(true),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let failure: Error | undefined;
      // close covers process exit and closure of both stdio streams.
      const completed = new Promise<{code: number | null; signal: string | null}>(resolve => {
        child.once('error', error => {
          failure ??= error;
        });
        child.once('close', (code, signal) => resolve({code, signal}));
      });
      const output: Buffer[] = [];
      const errors: Buffer[] = [];
      const timer = setTimeout(() => child.kill(), 15_000);
      try {
        const streamFailure = (error: Error) => {
          failure ??= error;
        };
        child.stdout.once('error', streamFailure);
        child.stderr.once('error', streamFailure);
        child.stdout.on('data', chunk => output.push(Buffer.from(chunk)));
        child.stderr.on('data', chunk => errors.push(Buffer.from(chunk)));
        const exit = await completed;
        if (failure) throw failure;
        expect(exit.code).toBe(0);
        expect(exit.signal).toBeNull();
        expect(Buffer.concat(output).equals(content)).toBe(true);
        expect(Buffer.concat(errors).length).toBe(0);
        expect(child.stdout.destroyed).toBe(true);
        expect(child.stderr.destroyed).toBe(true);
        if (child.pid === undefined) throw new Error('Expected a compiled fixture process.');
        return await io(child.pid);
      } finally {
        clearTimeout(timer);
        if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) child.kill();
        await completed;
      }
    };
    const concurrentBatch = async () => {
      // A peer failure must not enter directory cleanup before every producer closes.
      const settled = await Promise.allSettled(Array.from({length: 4}, concurrent));
      return settled.map(result => {
        if (result.status === 'rejected') throw result.reason;
        return result.value;
      });
    };
    // Fresh processes observe the terminal claim once per event, with no opens.
    expect(await concurrentBatch()).toEqual(Array.from({length: 4}, () => ({checks: 3, opens: 0})));
    const exhausted = invoke(`${sha}:${sentinel}`, true);
    expect(exhausted.status).toBe(0);
    expect(exhausted.stdout.equals(content)).toBe(true);
    expect(exhausted.stderr.length).toBe(0);
    expect(await io(exhausted.pid)).toEqual({checks: 3, opens: 0});
    const expectedFailure = git('-C', repo, 'show', 'HEAD:private-missing-path');
    const saturatedFailure = invoke('HEAD:private-missing-path', true);
    expect(saturatedFailure.status).toBe(expectedFailure.status);
    expect(saturatedFailure.stdout.equals(expectedFailure.stdout)).toBe(true);
    expect(saturatedFailure.stderr.equals(expectedFailure.stderr)).toBe(true);
    expect(await io(saturatedFailure.pid)).toEqual({checks: 3, opens: 0});
    expect(await readdir(trace)).toHaveLength(128);
    expect(await snapshot()).toEqual(saturated);
    // Reset the capture, then race independent producers over the last four slots.
    await rm(trace, {recursive: true});
    await mkdir(trace);
    for (let slot = 0; slot < 124; slot++) await writeFile(resolve(trace, `${slot}.json`), saturated[slot] ?? '');
    await concurrentBatch();
    expect(await readdir(trace)).toHaveLength(128);
    const raced = await snapshot();
    expect(raced.slice(0, 124)).toEqual(saturated.slice(0, 124));
    for (const record of raced.slice(124)) {
      expect(Buffer.byteLength(record)).toBeLessThanOrEqual(480);
      expect(['start', 'result', 'forwarded']).toContain(JSON.parse(record).event);
      for (const secret of [sentinel, 'private-sentinel-content', repo, sha]) expect(record).not.toContain(secret);
    }
    await rm(trace, {recursive: true});
    await writeFile(trace, 'diagnostic I/O unavailable');
    const unavailable = invoke(`${sha}:${sentinel}`, true);
    expect(unavailable.status).toBe(0);
    expect(unavailable.stdout.equals(content)).toBe(true);
    expect(unavailable.stderr.length).toBe(0);
  } catch (error) {
    primaryFailure = {error};
  }
  try {
    // All producer calls have returned and concurrent peers have closed before OS cleanup retries.
    await rm(temporary, {recursive: true, force: true, maxRetries: 3, retryDelay: 50});
  } catch (cleanupError) {
    if (primaryFailure) {
      throw new AggregateError([primaryFailure.error, cleanupError], 'Release trace fixture and cleanup both failed.', {
        cause: cleanupError,
      });
    }
    throw cleanupError;
  }
  if (primaryFailure) throw primaryFailure.error;
}, 60_000);
