import {Array as EffectArray} from 'effect';
import * as EffectString from 'effect/String';
import {mkdtemp, readFile, rm} from '@threadnote/testing/node-fs-promises';
import {tmpdir} from '@threadnote/testing/node-os';
import {join} from '@threadnote/testing/node-path';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import fc from 'fast-check';

const probes = vi.hoisted(() => ({
  realpath: vi.fn<(file: string) => Promise<string>>(),
  lstat: vi.fn<(file: string) => Promise<unknown>>(),
  read: vi.fn<(file: string, limit: number) => Promise<Uint8Array>>(),
  open: vi.fn(),
  ps: vi.fn<
    (executable: string, args: readonly string[], options: unknown) => Promise<{stdout: string; stderr: string}>
  >(),
}));

vi.mock('@threadnote/platform/system', async importOriginal => ({
  ...(await importOriginal<typeof import('@threadnote/platform/system')>()),
  runtimeReadBoundedStableRegularFile: probes.read,
  runtimeOpenTextDirectoryNameReader: probes.open,
}));
vi.mock('@threadnote/testing/node-util', () => ({promisify: () => probes.ps}));
vi.mock('@threadnote/testing/node-fs-promises', async importOriginal => ({
  ...(await importOriginal<typeof import('@threadnote/testing/node-fs-promises')>()),
  realpath: probes.realpath,
  lstat: probes.lstat,
}));

import {
  bytesSha256,
  observeUpgradeProcesses,
  recordUpgradeCleanupFailure,
  requestOwnedUpgradeRecallRetirement,
  withUpgradeCleanupObservation,
} from '../helpers/model-setup-upgrade.js';

describe('predecessor upgrade cleanup diagnostics', () => {
  let root: string;
  let input: Parameters<typeof recordUpgradeCleanupFailure>[0];
  let files: Map<string, Uint8Array>;
  let directories: Map<string, readonly string[]>;
  let pageLimits: number[];
  let closed: number;
  const start = 'Mon Nov  2 19:08:28 2026';
  const identity = `darwin-v2:${start}`;
  const processCommand = '/fixture/threadnote'; // The mocked ps protocol is macOS, independent of the test host.
  const json = (file: string, value: unknown) => files.set(file, new TextEncoder().encode(JSON.stringify(value)));
  const leaseRoot = () => join(input.installation, 'leases', input.version);
  const demandRoot = () => join(input.home, 'recall', 'embedding-demand-v1');
  const receipt = () => join(input.home, 'locks', 'recall', 'embedding-worker-v1.json');
  const candidate = () => join(input.installation, 'versions', input.version, 'threadnote');
  const read = async () => JSON.parse(await readFile(input.file, 'utf8'));

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'threadnote-upgrade-diagnostics-'));
    input = {
      file: join(root, 'observation.json'),
      scenario: 'hosted-predecessor',
      installation: join(root, 'installation'),
      home: join(root, 'data'),
      version: '5.3.2',
      sourceCommit: EffectString.repeat(40)('a'),
      sourceTree: EffectString.repeat(40)('b'),
      candidateSha256: EffectString.repeat(64)('c'),
      manager: {pid: 2020, exitCode: null, signalCode: 'SIGTERM'},
      stage: 'release-leases-empty',
      bodyFailure: undefined,
      bodyFailed: false,
      cleanupFailure: new Error('fixture cleanup failure'),
    };
    files = new Map();
    probes.realpath.mockReset().mockImplementation(async file => file);
    probes.lstat.mockReset().mockImplementation(async file => {
      if (files.has(file)) return {};
      throw Object.assign(new Error('fixture absent'), {code: 'ENOENT'});
    });
    directories = new Map([
      [leaseRoot(), []],
      [demandRoot(), []],
    ]);
    pageLimits = [];
    closed = 0;
    probes.read.mockReset().mockImplementation(async file => {
      const bytes = files.get(file);
      if (!bytes) throw Object.assign(new Error('fixture unavailable'), {code: 'ENOENT'});
      return bytes;
    });
    probes.open.mockReset().mockImplementation(async (directory: string) => {
      const names = directories.get(directory);
      if (!names) throw new Error('fixture directory unavailable');
      return {
        readPage: async (limit: number) => {
          pageLimits = EffectArray.append(pageLimits, limit);
          return {names: EffectArray.take(names, limit), done: names.length < limit};
        },
        close: async () => {
          closed++;
        },
      };
    });
    probes.ps.mockReset().mockResolvedValue({stdout: `2016 1 ${start} ${processCommand}\n`, stderr: ''});
    vi.spyOn(process, 'kill').mockReturnValue(true);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(root, {recursive: true, force: true});
  });

  const seed = (marker = 'fixture-private', reason = 'foreground') => {
    directories.set(leaseRoot(), ['2016.json']);
    json(join(leaseRoot(), '2016.json'), {
      processId: 2016,
      processStartIdentity: identity,
      executable: candidate(),
      version: input.version,
      retirementPolicy: 'terminate',
      token: marker,
      rawMemory: marker,
    });
    json(receipt(), {
      processId: 2016,
      processStartIdentity: identity,
      version: input.version,
      protocol: 1,
      token: marker,
    });
    json(receipt() + '.launch-v2.json', {
      version: 1,
      runtimeVersion: input.version,
      protocol: 1,
      wakeSequence: 7,
      active: {nonce: marker, owner: {processId: 2016, processStartIdentity: identity, token: marker}},
    });
    const name = EffectString.repeat(64)('d') + '.json';
    directories.set(demandRoot(), [name]);
    json(join(demandRoot(), name), {
      version: 2,
      account: marker,
      user: marker,
      desired: {revision: 'revision', token: marker, manifestPath: marker},
      observation: {
        revision: 'revision',
        state: 'deferred-foreground',
        reason,
        failures: 2,
        notBefore: 123,
        owner: {processId: 2016, processStartIdentity: identity},
        model: marker,
      },
    });
  };

  it('preserves the concrete lease, error boundary and unknown detached exit without raw error contents', async () => {
    seed();
    const bodyFailure = new Error('private body text');
    bodyFailure.stack = 'Error: private body text\n at fixture (model-setup-upgrade.e2e.ts:350:9)';
    await recordUpgradeCleanupFailure({...input, bodyFailed: true, bodyFailure});
    const result = await read();
    expect(result.bodyFailure).toEqual({present: true, kind: 'Error', code: null, sourceLine: 350, sourceColumn: 9});
    expect(result.cleanupStage).toBe('release-leases-empty');
    expect(result.leases.processes).toEqual([
      expect.objectContaining({
        filenamePid: 2016,
        processId: 2016,
        processStartIdentity: identity,
        canonicalStartIdentity: identity,
        leaseIdentityMatches: true,
        liveness: 'present',
        parentProcessId: 1,
        executableMatchesCandidate: true,
        commBasename: 'threadnote',
        commSha256: bytesSha256(processCommand),
      }),
    ]);
    expect(result.recall.exit).toEqual({status: 'unobserved', reason: 'detached-child-no-owned-process-handle'});
    expect(result.recall.control.activeOwner).toEqual({processId: 2016, processStartIdentity: identity});
    expect(result.atomicSnapshot).toBe(false);
    expect(process.kill).toHaveBeenCalledExactlyOnceWith(2016, 0);
    expect(await readFile(input.file, 'utf8')).not.toContain('private body text');
  });

  it.each([
    'embedding-model-unavailable',
    'retry-backoff',
    'native-authority-deferred',
    'source-changed',
    'index-storage-requires-repair',
    'embedding-preparation-failed',
    'cpu-busy',
    'cpu-unknown',
    'foreground',
    'foreground-quiet',
    'inference-active',
    'fair-turn',
    'identity-unavailable',
    'admission-unavailable',
    'batch-deadline',
    'checkpoint',
  ])('retains the current fixed persisted reason %s', async reason => {
    seed('fixture-private', reason);
    await recordUpgradeCleanupFailure(input);
    expect((await read()).recall.demand.observations[0].observationReason).toBe(reason);
  });

  it.each(['foreground-active', 'unexpected-private-reason'])(
    'does not retain non-contract reason %s',
    async reason => {
      seed('fixture-private', reason);
      await recordUpgradeCleanupFailure(input);
      expect((await read()).recall.demand.observations[0].observationReason).toBeNull();
    },
  );

  it('keeps unavailable metadata and denied process probes unknown rather than mismatched or empty', async () => {
    directories.set(leaseRoot(), ['2016.json']);
    directories.delete(demandRoot());
    vi.mocked(process.kill).mockImplementation(() => {
      throw Object.assign(new Error('fixture denied'), {code: 'EPERM'});
    });
    probes.ps.mockRejectedValue(new Error('fixture ps denied'));
    await recordUpgradeCleanupFailure(input);
    const result = await read();
    expect(result.leases.processes[0]).toMatchObject({
      readStatus: 'unavailable',
      liveness: 'unknown',
      executableMatchesCandidate: null,
      processStartIdentity: null,
      leaseIdentityMatches: null,
    });
    expect(result.processProbe).toBe('unavailable');
    expect(result.recall.control.startingPresent).toBeNull();
    expect(result.recall.demand).toMatchObject({readStatus: 'unavailable', truncated: null});
  });

  it('distinguishes an absent PID, canonical mismatch and legacy identity', async () => {
    seed();
    vi.mocked(process.kill).mockImplementation(() => {
      throw Object.assign(new Error('fixture absent'), {code: 'ESRCH'});
    });
    probes.ps.mockRejectedValue(new Error('fixture absent'));
    await recordUpgradeCleanupFailure(input);
    expect((await read()).leases.processes[0].liveness).toBe('absent');
    vi.mocked(process.kill).mockReturnValue(true);
    probes.ps.mockResolvedValue({stdout: `2016 1 Tue Nov  3 19:08:28 2026 ${processCommand}\n`, stderr: ''});
    await recordUpgradeCleanupFailure(input);
    expect((await read()).leases.processes[0].leaseIdentityMatches).toBe(false);
    json(join(leaseRoot(), '2016.json'), {processId: 2016, processStartIdentity: `darwin:${start}`});
    await recordUpgradeCleanupFailure(input);
    expect((await read()).leases.processes[0].leaseIdentityMatches).toBeNull();
  });

  it.each(['malformed', 'oversized'] as const)(
    'reports %s reads as unavailable and keeps thrown undefined errors present',
    async mode => {
      seed();
      if (mode === 'malformed') probes.read.mockResolvedValue(new TextEncoder().encode('{'));
      else
        probes.read.mockImplementation(async () => {
          throw new Error('fixture bounded read refused');
        });
      await recordUpgradeCleanupFailure({
        ...input,
        bodyFailed: true,
        bodyFailure: undefined,
        cleanupFailure: undefined,
      });
      const result = await read();
      expect(result.bodyFailure.present).toBe(true);
      expect(result.cleanupFailure.present).toBe(true);
      expect(result.leases.processes[0].readStatus).toBe('unavailable');
      expect(result.recall.demand.observations[0]).toMatchObject({readStatus: 'unavailable', desiredPresent: null});
    },
  );

  it('caps physical observations and process output without taking another page', async () => {
    seed();
    directories.set(
      leaseRoot(),
      EffectArray.map(EffectArray.range(2016, 2035), pid => `${pid}.json`),
    );
    directories.set(
      demandRoot(),
      EffectArray.map(EffectArray.range(0, 19), value => EffectString.padStart(64, '0')(value.toString(16)) + '.json'),
    );
    await recordUpgradeCleanupFailure(input);
    const result = await read();
    expect(result.leases.truncated).toBe(true);
    expect(result.recall.demand.truncated).toBe(true);
    expect(result.leases.processes).toHaveLength(16);
    expect(result.recall.demand.observations).toHaveLength(16);
    expect(pageLimits).toEqual([16, 16]);
    expect(closed).toBe(2);
    expect(EffectArray.every(probes.read.mock.calls, call => call[1] === 8192)).toBe(true);
    expect(probes.ps).toHaveBeenCalledExactlyOnceWith(
      '/bin/ps',
      expect.any(Array),
      expect.objectContaining({timeout: 1000, maxBuffer: 16_384}),
    );
    expect(Buffer.byteLength(await readFile(input.file, 'utf8'))).toBeLessThanOrEqual(65_536);
  });

  it('labels a candidate-only control without predecessor invocation or Manager metadata', async () => {
    await recordUpgradeCleanupFailure({
      ...input,
      scenario: 'candidate-only',
      manager: undefined,
      ownedRecallChild: {pid: 2016, exitCode: 0, signalCode: null},
    });
    const result = await read();
    expect(result.scenario).toBe('candidate-only');
    expect(result.predecessor).toEqual({status: 'not-invoked'});
    expect(result.manager).toBeNull();
    expect(result.recall.exit).toEqual({status: 'observed', pid: 2016, exitCode: 0, signalCode: null});
    expect(probes.ps).not.toHaveBeenCalled();
  });

  it('does not collect failure observations after successful cleanup', async () => {
    const cleanup = vi.fn(async () => {});
    const observe = vi.fn(async () => {});
    await withUpgradeCleanupObservation(cleanup, observe);
    expect(cleanup).toHaveBeenCalledOnce();
    expect(observe).not.toHaveBeenCalled();
  });

  it.each(['resolve', 'reject', 'throw'] as const)(
    'observes cleanup failure exactly once and preserves its identity when diagnostics %s',
    async mode => {
      const original = new Error('fixture cleanup');
      const observe = vi.fn((cause: unknown): Promise<void> => {
        expect(cause).toBe(original);
        if (mode === 'throw') throw new Error('fixture diagnostic synchronous failure');
        return mode === 'reject' ? Promise.reject(new Error('fixture diagnostic rejection')) : Promise.resolve();
      });
      await expect(
        withUpgradeCleanupObservation(async () => {
          throw original;
        }, observe),
      ).rejects.toBe(original);
      expect(observe).toHaveBeenCalledExactlyOnceWith(original);
    },
  );

  it('preserves cleanup failure over an earlier body failure through the actual caller boundary', async () => {
    const body = new Error('fixture body');
    const cleanup = new Error('fixture cleanup');
    const run = async () => {
      try {
        throw body;
      } finally {
        await withUpgradeCleanupObservation(
          async () => {
            throw cleanup;
          },
          async () => {
            throw new Error('fixture diagnostic');
          },
        );
      }
    };
    await expect(run()).rejects.toBe(cleanup);
  });

  it('preserves an undefined thrown value from both the body and cleanup', async () => {
    const observe = vi.fn(async () => {
      throw new Error('fixture diagnostic');
    });
    await expect(
      withUpgradeCleanupObservation(async () => {
        await Promise.reject();
      }, observe),
    ).rejects.toBeUndefined();
    expect(observe).toHaveBeenCalledExactlyOnceWith(undefined);
    const run = async () => {
      try {
        await Promise.reject();
      } finally {
        await withUpgradeCleanupObservation(async () => {}, observe);
      }
    };
    await expect(run()).rejects.toBeUndefined();
    expect(observe).toHaveBeenCalledOnce();
  });

  it('never discloses arbitrary wider process objects, extra JSON or error text', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uuid(),
        fc.dictionary(
          fc.string({maxLength: 12}),
          fc.oneof(fc.string({maxLength: 40}), fc.integer({min: -5, max: 5}), fc.boolean(), fc.constant(null)),
          {maxKeys: 4},
        ),
        async (id, extra) => {
          const marker = `PRIVATE_${id}`;
          seed(marker);
          const wider = {
            pid: 2016,
            exitCode: 0,
            signalCode: null,
            status: marker,
            spawnargs: [marker],
            env: {AUTH: marker},
            extra,
          };
          (wider as Record<string, unknown>).cycle = wider;
          await recordUpgradeCleanupFailure({
            ...input,
            scenario: 'candidate-only',
            manager: wider,
            ownedRecallChild: wider,
            bodyFailed: true,
            bodyFailure: new Error(marker),
            cleanupFailure: new Error(marker),
          });
          const text = await readFile(input.file, 'utf8');
          const result = JSON.parse(text);
          expect(text).not.toContain(marker);
          expect(result.manager).toEqual({pid: 2016, exitCode: 0, signalCode: null});
          expect(result.recall.exit).toEqual({status: 'observed', pid: 2016, exitCode: 0, signalCode: null});
          expect(result.predecessor).toEqual({status: 'not-invoked'});
        },
      ),
      {numRuns: 20},
    );
  });
  describe('fixture-owned recall retirement', () => {
    const launchNonce = '11111111-1111-4111-8111-111111111111';
    const ownerToken = '22222222-2222-4222-8222-222222222222';
    const lockToken = '33333333-3333-4333-8333-333333333333';
    const leaseToken = '44444444-4444-4444-8444-444444444444';
    const seedRetirement = () => {
      const legacy = `darwin:${start}`;
      json(receipt(), {
        processId: 1964,
        processStartIdentity: legacy,
        token: ownerToken,
        protocol: 1,
        version: input.version,
      });
      json(receipt() + '.launch-v2.json', {
        version: 1,
        protocol: 1,
        runtimeVersion: input.version,
        wakeSequence: 2,
        active: {nonce: launchNonce, owner: {processId: 1964, processStartIdentity: legacy, token: ownerToken}},
      });
      json(join(input.home, 'locks', 'recall', 'embedding-worker.lock'), {
        processId: 1964,
        processStartIdentity: legacy,
        token: lockToken,
      });
      json(join(leaseRoot(), '1964.json'), {
        processId: 1964,
        processStartIdentity: identity,
        executable: candidate(),
        version: input.version,
        retirementPolicy: 'terminate',
        token: leaseToken,
      });
      probes.ps.mockImplementation(async (_executable, args) => ({
        stdout: EffectArray.contains(args, 'lstart=') ? `${start}\n` : `1964 1 ${start} ${candidate()}\n`,
        stderr: '',
      }));
      const updater = join(input.installation, 'versions', '5.3.0-beta.4', 'threadnote');
      return {
        run: root,
        installation: input.installation,
        home: input.home,
        version: input.version,
        candidate: candidate(),
        legacyEnvironment: {LANG: 'C'},
        observationComplete: true,
        observedSnapshots: [
          [
            `1822 ${process.pid} ${start} ${updater} update --home ${input.home} --source http://127.0.0.1:9999/releases --beta --yes`,
            `1909 1822 ${start} ${candidate()} repair --no-post-update`,
            `1964 1909 ${start} ${candidate()} --threadnote-recall-embedding-worker-v1 --home ${input.home} --protocol 1 --version ${input.version} --launch-nonce ${launchNonce}`,
          ],
          [
            `1964 1 ${start} ${candidate()} --threadnote-recall-embedding-worker-v1 --home ${input.home} --protocol 1 --version ${input.version} --launch-nonce ${launchNonce}`,
          ],
        ],
      };
    };
    const realSignals = () => EffectArray.filter(vi.mocked(process.kill).mock.calls, call => call[1] !== 0);
    const isFixtureRecord = (value: unknown): value is Record<string, unknown> =>
      typeof value === 'object' && value !== null && !EffectArray.isArray(value);
    const fixtureRecord = (value: unknown) => {
      if (!isFixtureRecord(value)) throw new Error('Invalid fixture record.');
      return value;
    };
    const change = (path: string, mutate: (value: Record<string, unknown>) => void) => {
      const value: Record<string, unknown> = JSON.parse(new TextDecoder().decode(files.get(path)));
      mutate(value);
      json(path, value);
    };

    it('signals the proven private recall instance once and requires real return without deleting state', async () => {
      const options = seedRetirement();
      const before = EffectArray.map(EffectArray.fromIterable(files), ([path, bytes]) => [path, bytesSha256(bytes)]);
      const retired = await requestOwnedUpgradeRecallRetirement(options);
      expect(retired).toMatchObject({pid: 1964, canonicalStartIdentity: identity, signalRequested: true});
      expect(realSignals()).toEqual([[1964, 'SIGTERM']]);
      expect(await retired?.hasReturned()).toBe(false); // A successful signal is not a successful return.
      vi.mocked(process.kill).mockImplementation((_pid, signal) => {
        if (signal === 0) throw Object.assign(new Error('fixture returned'), {code: 'ESRCH'});
        throw new Error('No second signal is allowed.');
      });
      expect(await retired?.hasReturned()).toBe(true);
      expect(realSignals()).toEqual([[1964, 'SIGTERM']]);
      expect(EffectArray.map(EffectArray.fromIterable(files), ([path, bytes]) => [path, bytesSha256(bytes)])).toEqual(
        before,
      );
    });

    it('checks legacy local time separately from canonical UTC for the same original instance', async () => {
      const options = seedRetirement();
      const localStart = 'Mon Nov  2 20:08:28 2026';
      const localIdentity = `darwin:${localStart}`;
      for (const path of [receipt(), join(input.home, 'locks', 'recall', 'embedding-worker.lock')])
        change(path, value => {
          value.processStartIdentity = localIdentity;
        });
      change(receipt() + '.launch-v2.json', value => {
        const active = fixtureRecord(value.active);
        value.active = {...active, owner: {...fixtureRecord(active.owner), processStartIdentity: localIdentity}};
      });
      probes.ps.mockImplementation(async (_executable, args, options) => {
        if (EffectArray.contains(args, 'lstart=')) {
          expect(options).toMatchObject({env: {LANG: 'C'}});
          return {stdout: `${localStart}\n`, stderr: ''};
        }
        expect(options).toMatchObject({env: {LANG: 'C', LC_ALL: 'C', TZ: 'UTC'}});
        return {stdout: `1964 1 ${start} ${candidate()}\n`, stderr: ''};
      });
      const retired = await requestOwnedUpgradeRecallRetirement(options);
      expect(retired?.signalRequested).toBe(true);
      expect(await retired?.hasReturned()).toBe(false);
      expect(realSignals()).toEqual([[1964, 'SIGTERM']]);
    });

    it('refuses an unavailable legacy channel without inferring original-instance return', async () => {
      const options = seedRetirement();
      probes.ps.mockImplementation(async (_executable, args) => {
        if (EffectArray.contains(args, 'lstart=')) throw new Error('fixture legacy channel denied');
        return {stdout: `1964 1 ${start} ${candidate()}\n`, stderr: ''};
      });
      await expect(requestOwnedUpgradeRecallRetirement(options)).rejects.toBeDefined();
      expect(realSignals()).toEqual([]);
    });

    it('does not signal an exited or reused original PID', async () => {
      const options = seedRetirement();
      probes.ps.mockResolvedValue({stdout: `1964 1 Tue Nov  3 20:59:01 2026 /unowned/threadnote\n`, stderr: ''});
      const replaced = await requestOwnedUpgradeRecallRetirement(options);
      expect(replaced?.signalRequested).toBe(false);
      expect(await replaced?.hasReturned()).toBe(true);
      expect(realSignals()).toEqual([]);
      vi.mocked(process.kill).mockImplementation(() => {
        throw Object.assign(new Error('fixture absent'), {code: 'ESRCH'});
      });
      const gone = await requestOwnedUpgradeRecallRetirement(options);
      expect(gone?.signalRequested).toBe(false);
      expect(realSignals()).toEqual([]);
    });

    it.each([
      'home',
      'installation',
      'candidate',
      'version',
      'physical-home',
      'lineage',
      'nonce',
      'receipt',
      'lock',
      'lease-start',
      'command',
      'identity',
    ] as const)('refuses %s ownership mismatch without a signal', async mismatch => {
      const options = seedRetirement();
      if (mismatch === 'home') options.home = join(root, 'other-home');
      if (mismatch === 'installation') options.installation = join(root, 'other-installation');
      if (mismatch === 'candidate') options.candidate = join(root, 'other-threadnote');
      if (mismatch === 'version') options.version = '../outside';
      if (mismatch === 'physical-home')
        probes.realpath.mockImplementation(async path => (path === input.home ? '/unowned/home' : path));
      if (mismatch === 'lineage')
        options.observedSnapshots = EffectArray.map(options.observedSnapshots, rows => EffectArray.drop(rows, 1));
      if (mismatch === 'nonce')
        change(receipt() + '.launch-v2.json', value => {
          value.active = {...fixtureRecord(value.active), nonce: lockToken};
        });
      if (mismatch === 'receipt')
        change(receipt(), value => {
          value.processId = 1965;
        });
      if (mismatch === 'lock')
        change(join(input.home, 'locks', 'recall', 'embedding-worker.lock'), value => {
          value.processStartIdentity = 'unknown';
        });
      if (mismatch === 'lease-start')
        change(join(leaseRoot(), '1964.json'), value => {
          value.processStartIdentity = 'unknown';
        });
      if (mismatch === 'command')
        probes.ps.mockResolvedValue({stdout: `1964 1 ${start} /unowned/threadnote\n`, stderr: ''});
      if (mismatch === 'identity') probes.ps.mockRejectedValue(new Error('fixture denied'));
      await expect(requestOwnedUpgradeRecallRetirement(options)).rejects.toBeDefined();
      expect(realSignals()).toEqual([]);
    });

    it('does not adopt an unobserved active worker or choose between multiple original children', async () => {
      const options = seedRetirement();
      await expect(requestOwnedUpgradeRecallRetirement({...options, observedSnapshots: []})).rejects.toBeDefined();
      expect(realSignals()).toEqual([]);
      options.observedSnapshots = EffectArray.map(options.observedSnapshots, rows =>
        EffectArray.append(
          rows,
          `1965 1909 ${start} ${candidate()} --threadnote-recall-embedding-worker-v1 --home ${input.home} --protocol 1 --version ${input.version} --launch-nonce ${lockToken}`,
        ),
      );
      await expect(requestOwnedUpgradeRecallRetirement(options)).rejects.toBeDefined();
      expect(realSignals()).toEqual([]);
    });

    it('retains separate bounded ps samples while preserving the existing flat command evidence', async () => {
      const options = seedRetirement();
      probes.ps
        .mockResolvedValueOnce({stdout: EffectArray.join(options.observedSnapshots[0], '\n'), stderr: ''})
        .mockResolvedValue({stdout: EffectArray.join(options.observedSnapshots[1], '\n'), stderr: ''});
      vi.useFakeTimers();
      try {
        const stop = await observeUpgradeProcesses(join(input.installation, 'versions'));
        await vi.advanceTimersByTimeAsync(25);
        const observed = await stop();
        expect(observed.complete).toBe(true);
        expect(observed.snapshots).toEqual(options.observedSnapshots);
        expect(observed.commands).toEqual(EffectArray.flatten(options.observedSnapshots));
      } finally {
        vi.useRealTimers();
      }
    });

    it('marks a saturated original sample incomplete and grants no signal authority', async () => {
      const options = seedRetirement();
      const rows = EffectArray.makeBy(
        256,
        index => `${2000 + index} ${process.pid} ${start} ${candidate()} ${EffectString.repeat(2200)('x')}`,
      );
      probes.ps.mockResolvedValue({stdout: EffectArray.join(rows, '\n'), stderr: ''});
      const stop = await observeUpgradeProcesses(join(input.installation, 'versions'));
      const observed = await stop();
      expect(observed.complete).toBe(false);
      expect(
        EffectArray.every(
          observed.snapshots,
          rows => rows.length < 256 && EffectArray.every(rows, line => line.length < 2048),
        ),
      ).toBe(true);
      await expect(
        requestOwnedUpgradeRecallRetirement({
          ...options,
          observedSnapshots: observed.snapshots,
          observationComplete: observed.complete,
        }),
      ).rejects.toBeDefined();
      expect(realSignals()).toEqual([]);
    });

    it('does not combine parent PIDs across different original snapshots or incomplete observations', async () => {
      const options = seedRetirement();
      const rows = options.observedSnapshots[0];
      const separated = [[rows[0]], [rows[1], rows[2]]];
      await expect(
        requestOwnedUpgradeRecallRetirement({...options, observedSnapshots: separated}),
      ).rejects.toBeDefined();
      await expect(requestOwnedUpgradeRecallRetirement({...options, observationComplete: false})).rejects.toBeDefined();
      await expect(
        requestOwnedUpgradeRecallRetirement({...options, observedSnapshots: [[...rows, rows[0]]]}),
      ).rejects.toBeDefined();
      expect(realSignals()).toEqual([]);
    });

    it.each([
      'missing-sequence',
      'fractional-sequence',
      'negative-sequence',
      'large-sequence',
      'extra-control',
      'extra-active',
      'extra-owner',
    ] as const)('rejects %s control with all other ownership fields preserved', async malformed => {
      const options = seedRetirement();
      change(receipt() + '.launch-v2.json', value => {
        if (malformed === 'missing-sequence') delete value.wakeSequence;
        if (malformed === 'fractional-sequence') value.wakeSequence = 0.5;
        if (malformed === 'negative-sequence') value.wakeSequence = -1;
        if (malformed === 'large-sequence') value.wakeSequence = Number.MAX_SAFE_INTEGER + 1;
        if (malformed === 'extra-control') value.unknown = true;
        if (malformed === 'extra-active') value.active = {...fixtureRecord(value.active), unknown: true};
        if (malformed === 'extra-owner') {
          const active = fixtureRecord(value.active);
          value.active = {...active, owner: {...fixtureRecord(active.owner), unknown: true}};
        }
      });
      await expect(requestOwnedUpgradeRecallRetirement(options)).rejects.toBeDefined();
      expect(realSignals()).toEqual([]);
    });

    it('validates the closed supported idle control when there is no observed owner', async () => {
      const options = seedRetirement();
      files.delete(receipt());
      files.delete(join(input.home, 'locks', 'recall', 'embedding-worker.lock'));
      json(receipt() + '.launch-v2.json', {version: 1, protocol: 1, runtimeVersion: input.version, wakeSequence: 2});
      await expect(requestOwnedUpgradeRecallRetirement({...options, observedSnapshots: []})).resolves.toBeUndefined();
      change(receipt() + '.launch-v2.json', value => {
        delete value.wakeSequence;
      });
      await expect(requestOwnedUpgradeRecallRetirement({...options, observedSnapshots: []})).rejects.toBeDefined();
      expect(realSignals()).toEqual([]);
    });

    it('retains denied or malformed evidence rather than falling back to a stronger signal', async () => {
      const options = seedRetirement();
      probes.read.mockRejectedValue(new Error('fixture bounded read refused'));
      await expect(requestOwnedUpgradeRecallRetirement(options)).rejects.toBeDefined();
      expect(realSignals()).toEqual([]);
    });

    it('does not claim return or escalate when the owned SIGTERM is denied', async () => {
      const options = seedRetirement();
      vi.mocked(process.kill).mockImplementation((_pid, signal) => {
        if (signal === 0) return true;
        throw Object.assign(new Error('fixture signal denied'), {code: 'EPERM'});
      });
      await expect(requestOwnedUpgradeRecallRetirement(options)).rejects.toBeDefined();
      expect(realSignals()).toEqual([[1964, 'SIGTERM']]);
    });

    it('never signals a mismatched authority tuple', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.constantFrom('receipt', 'control', 'lock', 'lease'),
          fc.integer({min: 2000, max: 10000}),
          async (part, differentPid) => {
            const options = seedRetirement();
            vi.mocked(process.kill).mockClear().mockReturnValue(true);
            const filename =
              part === 'receipt'
                ? receipt()
                : part === 'control'
                  ? receipt() + '.launch-v2.json'
                  : part === 'lock'
                    ? join(input.home, 'locks', 'recall', 'embedding-worker.lock')
                    : join(leaseRoot(), '1964.json');
            change(filename, value => {
              if (part === 'control') {
                const active = fixtureRecord(value.active);
                value.active = {...active, owner: {...fixtureRecord(active.owner), processId: differentPid}};
              } else value.processId = differentPid;
            });
            await expect(requestOwnedUpgradeRecallRetirement(options)).rejects.toBeDefined();
            expect(realSignals()).toEqual([]);
          },
        ),
        {numRuns: 20},
      );
    });
  });
});
