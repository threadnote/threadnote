import {Array as EffectArray} from 'effect';
import * as EffectString from 'effect/String';
import {mkdtemp, readFile, rm} from '@threadnote/testing/node-fs-promises';
import {tmpdir} from '@threadnote/testing/node-os';
import {join} from '@threadnote/testing/node-path';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import fc from 'fast-check';

const probes = vi.hoisted(() => ({
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

import {
  bytesSha256,
  recordUpgradeCleanupFailure,
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
});
