import {Array as EffectArray} from 'effect';
import {Database} from 'bun:sqlite';
import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from '@threadnote/testing/node-fs';
import {tmpdir} from '@threadnote/testing/node-os';
import {join} from '@threadnote/testing/node-path';
import {
  parseStage3Arguments,
  scanStage3Observations,
  stage3Plan,
  stage3Refresh,
  type Stage3Observation,
} from '../../../../scripts/support/code-graph-stage3-contract.js';
import {
  classifyStage3OutputParentGitResult,
  Stage3Driver,
  stage3Fixture,
  type Stage3CommandResult,
} from '../../../../scripts/support/code-graph-stage3-driver.js';
import {runStage3Gate} from '../../../../scripts/run-code-graph-stage3-gate.js';
import '../../../../scripts/support/code-graph-stage3-lock-child.js';
import {withStage3Cleanup} from '../../../../scripts/support/code-graph-stage3-lifecycle.js';
import {assertStage3StrictStateEnvelope} from '../../../../scripts/support/code-graph-stage3-scenarios.js';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

const planArguments = ['--mode', 'plan'];

const executeArguments = [
  '--mode',
  'execute',
  '--candidate-commit',
  Effect.pipe('a', EffectString.repeat(40)),
  '--candidate-ref',
  'candidate',
  '--candidate-executable',
  '/not-an-executable',
  '--candidate-executable-sha256',
  Effect.pipe('b', EffectString.repeat(64)),
  '--output',
  '/not-a-directory/gate.json',
];

function executeOptions() {
  const options = parseStage3Arguments(executeArguments);
  if (options.mode !== 'execute') throw new Error('Expected execute options.');
  return options;
}

async function gitResult(directory: string): Promise<Stage3CommandResult> {
  const child = Bun.spawn(['git', '-C', directory, 'rev-parse', '--show-toplevel'], {stdout: 'pipe', stderr: 'pipe'});
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return {exitCode, stdout, stderr, timedOut: false};
}

function cleanupStatus(processId: number, processStartIdentity = 'identity') {
  return {
    buildId: `build-${processId}`,
    identity: {worktreeId: 'stage3-tree'},
    observation: {liveness: 'active'},
    owner: {processId, processStartIdentity},
  };
}

function cleanupDriver(
  events: string[],
  statuses: readonly ReturnType<typeof cleanupStatus>[],
  closeFails = false,
  observedIdentity = 'identity',
) {
  const driver = new Stage3Driver(executeOptions());
  const system = {
    isProcessRunning: (processId: number) => processId >= 3,
    signalProcess: (processId: number) => events.push(`signal-${processId}`),
    canonicalProcessStartIdentity: () => undefined,
    processStartIdentity: () => undefined,
  };
  const cleanupHosts = [
    {
      dead: false,
      processId: 1,
      client: {
        close: async () => {
          events.push('close-a');
          if (closeFails) throw new Error('close failed');
        },
      },
    },
    {
      dead: false,
      processId: 2,
      client: {
        close: async () => {
          events.push('close-b');
        },
      },
    },
  ];
  // @ts-expect-error -- The cleanup scenario supplies only the process and close fields it exercises.
  driver.hosts.push(...cleanupHosts);
  // @ts-expect-error -- This minimal worktree sentinel targets cleanup by identity without a checkout runtime.
  driver.worktrees.push({identity: {worktreeId: 'stage3-tree'}});
  driver.locks.push({
    // @ts-expect-error -- The lock sentinel contains only the process field observed by cleanup.
    process: {exitCode: null, kill: () => events.push('lock-kill'), exited: Promise.resolve(0)},
  });
  Object.assign(driver, {
    root: 'retained-fixture',
    runtime: {runPromise: async () => observedIdentity},
    services: async () => ({
      fs: {remove: () => undefined},
      system,
    }),
    rawStatuses: async () => statuses,
    until: async () => {
      events.push('wait');
      return true;
    },
  });
  return driver;
}

describe('Stage 3 live release gate contract', () => {
  it('plans the real phases without executing or writing evidence', async () => {
    expect(parseStage3Arguments(planArguments)).toEqual({mode: 'plan'});
    expect(await runStage3Gate(planArguments)).toEqual(stage3Plan());
    expect(stage3Plan()).toMatchObject({executed: false, linkedWorktrees: 3, simultaneousMcpHosts: 2});
    const runbook = readFileSync(join(import.meta.dirname, '../../../../docs/code-graph-readiness.md'), 'utf8');
    expect(runbook).toContain('bun run gate:code-graph:stage3 -- --mode plan');
    expect(runbook).toContain('  --mode execute \\');
  });

  it('refuses observation imports, implicit execution, duplicate flags, and unpinned identities', () => {
    for (const invalid of [
      [...planArguments, '--observations', '/fake.json'],
      [...planArguments, '--candidate-ref', 'candidate'],
      [...planArguments, '--mode', 'execute'],
      executeArguments.slice(2),
      EffectArray.map(executeArguments, value =>
        value === Effect.pipe('a', EffectString.repeat(40)) ? 'HEAD' : value,
      ),
      EffectArray.map(executeArguments, value =>
        value === Effect.pipe('b', EffectString.repeat(64)) ? 'unknown' : value,
      ),
      EffectArray.map(executeArguments, value => (value === '/not-an-executable' ? './threadnote' : value)),
    ])
      expect(() => parseStage3Arguments(invalid)).toThrow();
  });

  it('fails execute preflight on a mismatching HEAD before running a candidate', async () => {
    await expect(runStage3Gate(executeArguments)).rejects.toThrow('candidate-head');
  });

  it('pins programmatic graph calls to dual when consuming structured content', async () => {
    const driver = new Stage3Driver(executeOptions());
    const calls: unknown[] = [];
    const host = {
      client: {
        callTool: async (request: unknown) => {
          calls.push(request);
          return {isError: false, structuredContent: {operation: 'query'}};
        },
      },
    };
    const tree = {cwd: '/fixture'};
    try {
      // @ts-expect-error -- The call test provides only the host and checkout fields it exercises.
      await expect(driver.call(host, tree, {operation: 'query', responseFormat: 'agent'})).resolves.toEqual({
        operation: 'query',
      });
      expect(calls).toEqual([
        {
          arguments: {callerCwd: '/fixture', operation: 'query', responseFormat: 'dual'},
          name: 'inspect_code_graph',
        },
      ]);
    } finally {
      await driver.runtime.dispose();
    }
  });

  it('keeps fixture anchors stable while every target changes source', () => {
    const variants = EffectArray.map(['f1', 'f2', 'f3'], stage3Fixture);
    expect(new Set(variants).size).toBe(3);
    expect(
      new Set(
        EffectArray.map(variants, value =>
          EffectArray.join(Effect.pipe(value, EffectString.split('\n')).slice(0, 2), '\n'),
        ),
      ).size,
    ).toBe(1);
  });

  it.each(['path', 'impact'] as const)(
    'rejects stale graph evidence and wrong state envelopes for strict %s',
    operation => {
      const indexing = {type: 'code-graph-index-state', version: 3, operation, state: 'indexing', phase: 'waiting'};
      expect(() => assertStage3StrictStateEnvelope(operation, indexing)).not.toThrow();
      for (const response of [
        {...indexing, snapshot: {id: 'stale'}},
        {...indexing, nodes: []},
        {...indexing, edges: []},
        {...indexing, type: 'code-graph-inspection'},
        {...indexing, operation: operation === 'path' ? 'impact' : 'path'},
      ])
        expect(() => assertStage3StrictStateEnvelope(operation, response)).toThrow();
    },
  );

  it('classifies only a marker-free outside directory and rejects worktree or corrupt Git markers', async () => {
    const outsideDirectory = mkdtempSync(join(tmpdir(), 'threadnote-stage3-outside-'));
    const worktree = mkdtempSync(join(tmpdir(), 'threadnote-stage3-worktree-'));
    const corruptDirectory = mkdtempSync(join(tmpdir(), 'threadnote-stage3-corrupt-directory-'));
    const corruptFile = mkdtempSync(join(tmpdir(), 'threadnote-stage3-corrupt-file-'));
    const corruptDirectoryOutput = join(corruptDirectory, 'output');
    const corruptFileOutput = join(corruptFile, 'output');
    const markerDriver = new Stage3Driver(executeOptions());
    try {
      expect(Bun.spawnSync(['git', '-C', worktree, 'init', '-q']).exitCode).toBe(0);
      mkdirSync(join(corruptDirectory, '.git'));
      writeFileSync(join(corruptFile, '.git'), 'not a gitdir\n');
      mkdirSync(corruptDirectoryOutput);
      mkdirSync(corruptFileOutput);
      for (const directory of [outsideDirectory, worktree, corruptDirectoryOutput, corruptFileOutput]) {
        const result = await gitResult(directory);
        const markers = await markerDriver.inspectOutputParentMarkers(directory);
        const expected =
          directory === outsideDirectory ? 'outside-worktree' : directory === worktree ? 'inside-worktree' : 'unknown';
        expect(classifyStage3OutputParentGitResult(result, markers)).toBe(expected);
      }
    } finally {
      await markerDriver.runtime.dispose();
      rmSync(outsideDirectory, {recursive: true, force: true});
      rmSync(worktree, {recursive: true, force: true});
      rmSync(corruptDirectory, {recursive: true, force: true});
      rmSync(corruptFile, {recursive: true, force: true});
    }
    const outside: Stage3CommandResult = {
      exitCode: 128,
      stdout: '',
      stderr: 'fatal: not a git repository (or any of the parent directories): .git\n',
      timedOut: false,
    };
    expect(
      classifyStage3OutputParentGitResult(
        {...outside, stderr: 'fatal: detected dubious ownership in repository\n'},
        'clear',
      ),
    ).toBe('unknown');
    expect(classifyStage3OutputParentGitResult({...outside, timedOut: true}, 'clear')).toBe('unknown');
    expect(classifyStage3OutputParentGitResult(outside, 'marker')).toBe('unknown');
    expect(classifyStage3OutputParentGitResult(outside, 'unknown')).toBe('unknown');
  });

  it('rejects paths, native causes, PIDs, fingerprints, and unbounded retry guidance', () => {
    const observation: Stage3Observation = {phase: 'privacy-scan', state: 'observed'};
    for (const [key, value] of EffectRecord.toEntries({
      path: '/private/repo',
      cause: 'SQLITE_BUSY',
      processId: 12345,
      fingerprint: Effect.pipe('a', EffectString.repeat(64)),
    })) {
      expect(() => scanStage3Observations([{...observation, [key]: value}], [])).toThrow('privacy-field');
    }
    expect(() => scanStage3Observations([{...observation, retryAfterMilliseconds: 60_001}], [])).toThrow('retry-bound');
    expect(() =>
      stage3Refresh({
        type: 'code-graph-refresh-continuity',
        version: 1,
        state: 'active',
        currentTargetToken: '/private/repo',
      }),
    ).toThrow('refresh-token');
  });

  it('does not confuse a decimal PID substring with an opaque token or bounded retry interval', () => {
    const observation: Stage3Observation = {
      phase: 'blocked-writer-discovery',
      state: 'stale',
      retryAfterMilliseconds: 12345,
      refresh: {state: 'active', currentTargetToken: `cgdq_${Effect.pipe('12345', EffectString.padEnd(32, '0'))}`},
    };
    expect(() => scanStage3Observations([observation], ['12345'])).not.toThrow();
  });

  it('preserves arbitrary opaque tokens and refuses every extra free-text field', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({min: 0, max: 15}), {minLength: 32, maxLength: 32}),
        fc.string({minLength: 1, maxLength: 64}),
        (digits, injected) => {
          const token = `cgdq_${EffectArray.join(
            EffectArray.map(digits, value => value.toString(16)),
            '',
          )}`;
          const refresh = {
            type: 'code-graph-refresh-continuity',
            version: 1,
            state: 'active',
            currentTargetToken: token,
          };
          expect(stage3Refresh(refresh).currentTargetToken).toBe(token);
          expect(() => stage3Refresh({...refresh, diagnostic: injected})).toThrow('refresh-private-field');
          const observations: Stage3Observation[] = [
            {phase: 'blocked-writer-discovery', state: 'stale', refresh: stage3Refresh(refresh)},
          ];
          expect(() => scanStage3Observations(observations, [])).not.toThrow();
          expect(() => scanStage3Observations(observations, [token])).toThrow('privacy-literal');
        },
      ),
      {numRuns: 100},
    );
  });
});

describe('Stage 3 production lock helper OS boundary', () => {
  it('holds a real WAL writer and production file lock until explicitly released', async () => {
    const root = mkdtempSync(join(tmpdir(), 'threadnote-stage3-lock-test-'));
    const databasePath = join(root, 'graph.sqlite');
    const marker = join(root, 'ready');
    const release = join(root, 'release');
    const lock = join(root, 'writer.lock');
    const database = new Database(databasePath);
    database.exec("PRAGMA journal_mode = WAL; CREATE TABLE fixture(value TEXT); INSERT INTO fixture VALUES ('ready');");
    const child = Bun.spawn(
      [process.execPath, 'scripts/support/code-graph-stage3-lock-child.ts', lock, marker, release, databasePath],
      {
        stdout: 'ignore',
        stderr: 'pipe',
        env: {...process.env, HOME: root, THREADNOTE_HOME: root, THREADNOTE_TELEMETRY: '0'},
      },
    );
    try {
      const deadline = Date.now() + 15_000;
      while (!existsSync(marker) && Date.now() < deadline && child.exitCode === null) await Bun.sleep(25);
      expect(
        existsSync(marker),
        child.exitCode === null ? 'Lock marker deadline' : await new Response(child.stderr).text(),
      ).toBe(true);
      expect(JSON.parse(readFileSync(lock, 'utf8')).processId).toBe(child.pid);
      expect(database.query('SELECT value FROM fixture').get()).toEqual({value: 'ready'});
      expect(() => database.exec('BEGIN IMMEDIATE')).toThrow();
      writeFileSync(release, 'release\n');
      expect(await child.exited).toBe(0);
      expect(existsSync(lock)).toBe(false);
      database.exec('BEGIN IMMEDIATE; ROLLBACK;');
    } finally {
      if (child.exitCode === null) child.kill('SIGKILL');
      await child.exited;
      database.close();
      rmSync(root, {recursive: true, force: true});
    }
  }, 20_000);
});

describe('Stage 3 artifact lifecycle', () => {
  it('cleans up before publication and disposes exactly once after publication', async () => {
    const events: string[] = [];
    let disposed = false;
    await withStage3Cleanup(
      async () => {
        events.push('work');
        return 'result';
      },
      async () => {
        events.push('cleanup');
      },
      async value => {
        expect(disposed).toBe(false);
        expect(value).toBe('result');
        events.push('publish');
      },
      async () => {
        disposed = true;
        events.push('dispose');
      },
    );
    expect(events).toEqual(['work', 'cleanup', 'publish', 'dispose']);
  });

  it('continues every later cleanup action after a close failure and suppresses publication', async () => {
    const events: string[] = [];
    const driver = cleanupDriver(events, [cleanupStatus(3)], true);
    let published = false;
    await expect(
      withStage3Cleanup(
        async () => 'result',
        () => driver.cleanup(),
        async () => {
          published = true;
        },
        async () => {
          events.push('dispose');
        },
      ),
    ).rejects.toThrow('cleanup-incomplete');
    expect(events).toEqual(expect.arrayContaining(['close-a', 'close-b', 'signal-3', 'wait', 'lock-kill', 'dispose']));
    expect(events).not.toContain('remove');
    expect(published).toBe(false);
  });

  it('uses the raw cleanup inventory to terminate every duplicate active child', async () => {
    const events: string[] = [];
    const driver = cleanupDriver(events, [cleanupStatus(3), cleanupStatus(4)]);
    await driver.cleanup();
    expect(events).toEqual(expect.arrayContaining(['signal-3', 'signal-4']));
  });

  it('terminates a live Darwin child when its status predates canonical process identities', async () => {
    const events: string[] = [];
    const status = cleanupStatus(3, 'darwin:Tue Sep 22 05:54:18 2026');
    const driver = cleanupDriver(events, [status], false, 'darwin-v2:Tue Sep 22 05:54:18 2026');
    await driver.cleanup();
    expect(events).toContain('signal-3');
  });

  it.each(['work', 'cleanup', 'publish'])(
    'fails closed when %s fails and still disposes exactly once',
    async failure => {
      const events: string[] = [];
      const step = async (name: string) => {
        events.push(name);
        if (name === failure) throw new Error('bounded test failure');
      };
      await expect(
        withStage3Cleanup(
          () => step('work'),
          () => step('cleanup'),
          () => step('publish'),
          () => step('dispose'),
        ),
      ).rejects.toThrow('bounded test failure');
      expect(EffectArray.filter(events, event => event === 'dispose')).toHaveLength(1);
      if (failure !== 'publish') expect(events).not.toContain('publish');
    },
  );
});
