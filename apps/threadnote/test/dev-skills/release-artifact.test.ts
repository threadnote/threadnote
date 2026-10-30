import {Schema} from 'effect';
import {parseWatchResponse, parseWatchWorkResponse} from './release-artifact.js';
import {Array as EffectArray} from 'effect';
import {spawn, spawnSync} from '@threadnote/testing/node-child-process';
import {resolve} from '@threadnote/testing/node-path';
import {mkdir, mkdtemp, readFile, readdir, rm, writeFile} from '@threadnote/testing/node-fs-promises';
import {tmpdir} from '@threadnote/testing/node-os';
import {expect, it} from 'vitest';
import fc from 'fast-check';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

// This OS/compiled CLI boundary exercises the extracted native release.
// The literal directory declares the copied fixture/helper closure to Bazel.
const nativeFixtures = ['native-release-workflows.ts', 'release-tools-fixture.ts', 'release-artifact.ts'];
const archive = process.env.THREADNOTE_RELEASE_ARCHIVE;
it.skipIf(!archive)(
  'runs extracted native workflows without external interpreters or source access',
  async () => {
    if (!archive) throw new Error('Missing release archive.');
    const temporary = await mkdtemp(resolve(tmpdir(), 'threadnote-release-tools-'));
    let bodyFailure: {readonly error: unknown} | undefined;
    let cleanupFailure: {readonly error: unknown} | undefined;
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
          ...(process.env.THREADNOTE_RELEASE_PROFILE ? ['--profile', process.env.THREADNOTE_RELEASE_PROFILE] : []),
          ...(process.platform === 'win32' ? ['--functional-only'] : []),
        ],
        {encoding: 'utf8', timeout: 1_850_000},
      );
      expect(result.error, result.error?.message).toBeUndefined();
      expect(
        result.status,
        `${result.stdout}\n${result.stderr}\nFixtures: ${EffectArray.join(nativeFixtures, ', ')}`,
      ).toBe(0);
    } catch (error) {
      bodyFailure = {error};
    } finally {
      try {
        await rm(temporary, {recursive: true, force: true, maxRetries: 10, retryDelay: 50});
      } catch (error) {
        cleanupFailure = {error};
      }
    }
    if (bodyFailure && cleanupFailure) {
      throw new AggregateError(
        [bodyFailure.error, cleanupFailure.error],
        'Release workflow and fixture cleanup both failed.',
        {
          cause: bodyFailure.error,
        },
      );
    }
    if (bodyFailure) throw bodyFailure.error;
    if (cleanupFailure) throw cleanupFailure.error;
  },
  1_860_000,
);

it('forwards complete real Git bytes through the compiled fixture to a delayed consumer', async () => {
  const temporary = await mkdtemp(resolve(tmpdir(), 'threadnote-release-pipe-'));
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
    const delayed = async (args: readonly string[]) => {
      const child = spawn(proxy, [...args], {
        env: {...process.env, THREADNOTE_RELEASE_FIXTURE_ROOT: temporary},
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const output: Buffer[] = [];
      const errors: Buffer[] = [];
      const timer = setTimeout(() => child.kill(), 15_000);
      const completed = new Promise<{code: number | null; signal: string | null}>((resolve, reject) => {
        child.once('error', reject);
        child.once('close', (code, signal) => resolve({code, signal}));
      });
      // Hold both OS pipes unread long enough to force backpressure above their capacity.
      child.stdout.on('data', chunk => output.push(Buffer.from(chunk)));
      child.stderr.on('data', chunk => errors.push(Buffer.from(chunk)));
      child.stdout.pause();
      child.stderr.pause();
      try {
        await new Promise(resolve => setTimeout(resolve, 150));
        child.stdout.resume();
        child.stderr.resume();
        const exit = await completed;
        expect(exit.signal).toBeNull();
        return {...exit, stdout: Buffer.concat(output), stderr: Buffer.concat(errors)};
      } finally {
        clearTimeout(timer);
        child.kill();
      }
    };
    const diagnostic = (result: Awaited<ReturnType<typeof delayed>>) =>
      JSON.stringify({
        code: result.code,
        signal: result.signal,
        stdoutBytes: result.stdout.length,
        stderr: Effect.pipe(result.stderr.toString('utf8'), EffectString.slice(-4000)),
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
        stdout: Effect.pipe(piped.stdout, effectOptionalString =>
          effectOptionalString == null ? undefined : Effect.pipe(effectOptionalString, EffectString.slice(-100)),
        ),
        stderr: Effect.pipe(piped.stderr, effectOptionalString =>
          effectOptionalString == null ? undefined : Effect.pipe(effectOptionalString, EffectString.slice(-4000)),
        ),
      },
    });
    expect(repository.code, repositoryDiagnostic).toBe(0);
    expect(Effect.pipe(repository.stdout.toString('utf8'), EffectString.trim), repositoryDiagnostic).toBe('true');
    expect(repository.stderr.length, repositoryDiagnostic).toBe(0);
    expect(piped.error, repositoryDiagnostic).toBeUndefined();
    expect(piped.status, repositoryDiagnostic).toBe(0);
    expect(Effect.pipe(piped.stdout, EffectString.trim), repositoryDiagnostic).toBe('true');
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
        const result = await delayed(['-C', repo, 'cat-file', 'blob', Effect.pipe(stored.stdout, EffectString.trim)]);
        expect(result.code, diagnostic(result)).toBe(0);
        expect(result.stderr.length).toBe(0);
        expect(result.stdout.length).toBe(payload.length);
        expect(result.stdout.subarray(-64).equals(payload.subarray(-64))).toBe(true);
        expect(result.stdout.equals(payload)).toBe(true);
      }),
      {numRuns: 3, endOnFailure: true},
    );
    const args = ['-C', repo, 'cat-file', 'blob', Effect.pipe('0', EffectString.repeat(40))];
    const expected = spawnSync(nativeGit, args, {timeout: 15_000});
    expect(expected.status).not.toBe(0);
    const failure = await delayed(args);
    expect(failure.code, diagnostic(failure)).toBe(expected.status);
    expect(failure.stdout.equals(expected.stdout)).toBe(true);
    expect(failure.stderr.equals(expected.stderr)).toBe(true);
  } finally {
    await rm(temporary, {recursive: true, force: true, maxRetries: 10, retryDelay: 50});
  }
}, 60_000);

it('captures bounded closed producer diagnostics only when the compiled Git fixture opts in', async () => {
  const temporary = await mkdtemp(resolve(tmpdir(), 'threadnote-release-trace-'));
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
              contents: Effect.pipe(
                await readFile(args.path, 'utf8'),
                EffectString.replace("from 'node:fs'", "from 'producer-fs'"),
              ),
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
    const sha = Effect.pipe(git('-C', repo, 'rev-parse', 'HEAD').stdout.toString('utf8'), EffectString.trim);
    const environment = (enabled: boolean) => ({
      ...process.env,
      THREADNOTE_RELEASE_FIXTURE_ROOT: temporary,
      THREADNOTE_RELEASE_PUBLICATION_TRACE: enabled ? '1' : '0',
    });
    const io = async (pid: number) =>
      Schema.decodeUnknownSync(Schema.Struct({checks: Schema.Finite, opens: Schema.Finite}))(
        JSON.parse(await readFile(resolve(ioDirectory, `${pid}.json`), 'utf8')),
      );
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
    const raw = EffectArray.join(
      await Promise.all(EffectArray.map(files, file => readFile(resolve(trace, file), 'utf8'))),
      '',
    );
    for (const secret of [sentinel, 'private-sentinel-content', repo, sha, 'private-missing-path']) {
      expect(raw).not.toContain(secret);
    }
    const events = EffectArray.map(Effect.pipe(raw, EffectString.trim, EffectString.split('\n')), line =>
      Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown))(JSON.parse(line)),
    );
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
    for (const event of events) expect(EffectArray.every(EffectRecord.keys(event), key => allowed.has(key))).toBe(true);
    expect(
      EffectArray.map(
        EffectArray.filter(events, event => event.event === 'result'),
        event => event.stderrCategory,
      ).sort(),
    ).toEqual(['missing-object', 'missing-path', 'none']);
    expect(
      EffectArray.every(
        EffectArray.filter(events, event => event.event === 'forwarded'),
        event => event.complete === true,
      ),
    ).toBe(true);
    expect(EffectArray.some(events, event => event.specForm === 'SHA40')).toBe(true);
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
      const child = Bun.spawn([proxy, '-C', repo, 'show', `${sha}:${sentinel}`], {
        env: environment(true),
        stdout: 'pipe',
        stderr: 'pipe',
        timeout: 15_000,
      });
      const [status, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).arrayBuffer(),
        new Response(child.stderr).text(),
      ]);
      expect(status).toBe(0);
      expect(Buffer.from(stdout).equals(content)).toBe(true);
      expect(stderr).toBe('');
      return io(child.pid);
    };
    // Fresh processes observe the terminal claim once per event, with no opens.
    expect(await Promise.all(Array.from({length: 4}, concurrent))).toEqual(
      Array.from({length: 4}, () => ({checks: 3, opens: 0})),
    );
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
    await Promise.all(Array.from({length: 4}, concurrent));
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
  } finally {
    await rm(temporary, {recursive: true, force: true, maxRetries: 10, retryDelay: 50});
  }
}, 60_000);

// Watch mutations return common health fields; only inspect/work return their detail arrays.
it('parses command-specific native watch details without inventing absent arrays', () => {
  const base = {
    status: 'ok',
    collector: {alive: true},
    sourceErrors: [],
    pending: 0,
    work: {open: 0},
    revision: Effect.pipe('a', EffectString.repeat(64)),
  };
  expect(parseWatchResponse(base)).toEqual(base);
  expect(parseWatchResponse({...base, collector: null}).collector).toBeNull();
  expect(() => parseWatchResponse({...base, collector: undefined})).toThrow('Native watch collector');
  expect(parseWatchResponse({...base, delivery: null})).toEqual(base);
  expect(parseWatchResponse({...base, sources: []}).sources).toEqual([]);
  expect(parseWatchResponse({...base, work: {open: 0, items: []}}).work.items).toEqual([]);
  expect(() => parseWatchResponse({...base, sources: null})).toThrow('arrays are malformed');
  expect(() => parseWatchResponse({...base, work: {open: 0, items: {}}})).toThrow('arrays are malformed');
  expect(() => parseWatchResponse({...base, revision: 1})).toThrow('Native watch revision');

  const workResponse = {
    status: 'ok',
    watchId: 'extracted-release',
    revision: Effect.pipe('b', EffectString.repeat(64)),
    work: {items: [{eventId: 'event-1', status: 'open'}], offset: 0, nextOffset: null},
  };
  expect(parseWatchWorkResponse(workResponse)).toEqual(workResponse);
  expect(() => parseWatchWorkResponse({...workResponse, work: {...workResponse.work, items: null}})).toThrow(
    'Native watch work items must be an array.',
  );
});
