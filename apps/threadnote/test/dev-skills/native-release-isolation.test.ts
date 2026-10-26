import {mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync} from '@threadnote/testing/node-fs';
import {spawnSync} from '@threadnote/testing/node-child-process';
import {constants, tmpdir} from '@threadnote/testing/node-os';
import {join, resolve} from '@threadnote/testing/node-path';
import {afterAll, beforeAll, expect, it} from 'vitest';
import fc from 'fast-check';
import {
  connectNativeSocket,
  nativeSocketAddress,
  NETWORK_PROBE_TIMEOUT_MS,
  requireNativeNetworkDenial,
  type NativeSocketApi,
  type NativeConnectResult,
} from './native-release-network-probe.js';
import {verifyIsolation} from './release-artifact.js';

const errno = constants.errno;
const address = nativeSocketAddress('linux', '192.0.2.1', 443);
function fixture(overrides: Partial<NativeSocketApi> = {}) {
  let closed = 0;
  const api: NativeSocketApi = {
    nonblocking: 4,
    socket: () => ({value: 7, errno: 0}),
    flags: () => ({value: 0, errno: 0}),
    setFlags: () => ({value: 0, errno: 0}),
    connect: () => ({value: -1, errno: errno.EINPROGRESS}),
    poll: () => ({value: 1, errno: 0}),
    socketError: () => ({value: 0, errno: 0, socketError: 0}),
    close: descriptor => {
      expect(descriptor).toBe(7);
      closed++;
      return {value: 0, errno: 0};
    },
    ...overrides,
  };
  return {api, closed: () => closed};
}

it('accepts only raw connection denial errno, preserving immediate and SO_ERROR observations', () => {
  for (const expected of [errno.EPERM, errno.EACCES, errno.ENETUNREACH]) {
    for (const deferred of [false, true]) {
      const f = fixture(
        deferred
          ? {socketError: () => ({value: 0, errno: 0, socketError: expected})}
          : {connect: () => ({value: -1, errno: expected})},
      );
      const result = connectNativeSocket(f.api, address);
      expect(result.syscall).toBe(deferred ? 'getsockopt' : 'connect');
      expect(requireNativeNetworkDenial(result)).toBe(expected);
      expect(f.closed()).toBe(1);
    }
  }
});

it('rejects connected, refused, timeout and unknown errno as isolation proof', () => {
  for (const observed of [0, errno.ECONNREFUSED, errno.ETIMEDOUT, 99999]) {
    const f = fixture({connect: () => ({value: observed === 0 ? 0 : -1, errno: observed})});
    const result = connectNativeSocket(f.api, address);
    expect(result.errno).toBe(observed);
    expect(() => requireNativeNetworkDenial(result)).toThrow('Outbound network was not denied');
    expect(f.closed()).toBe(1);
  }
  expect(() => requireNativeNetworkDenial({errno: errno.EPERM, syscall: 'poll', elapsedMs: 0})).toThrow();
});

it('fails closed on socket/setup/poll/SO_ERROR/close failures and preserves a primary error', () => {
  for (const step of ['socket', 'flags', 'setFlags', 'poll', 'socketError', 'close'] as const) {
    const f = fixture({[step]: () => ({value: -1, errno: errno.EACCES, socketError: errno.EPERM})});
    expect(() => connectNativeSocket(f.api, address)).toThrow('Native socket probe');
    if (step !== 'close') expect(f.closed()).toBe(step === 'socket' ? 0 : 1);
  }
  const primary = new Error('original connect failure');
  const f = fixture({
    connect: () => {
      throw primary;
    },
    close: () => {
      throw new Error('secondary close failure');
    },
  });
  let caught: unknown;
  try {
    connectNativeSocket(f.api, address);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBe(primary);
});

it('keeps a single two-second monotonic deadline across interrupted operations and native initialization', () => {
  let time = 0;
  const budgets: number[] = [];
  let interruptions = 0;
  const f = fixture({
    poll: (_descriptor, budget) => {
      budgets.push(budget);
      if (interruptions++ < 2) {
        time += 750;
        return {value: -1, errno: errno.EINTR};
      }
      time += budget;
      return {value: 0, errno: 0};
    },
  });
  const result = connectNativeSocket(f.api, address, {now: () => time});
  expect(budgets).toEqual([2000, 1250, 500]);
  expect(result).toEqual({errno: errno.ETIMEDOUT, syscall: 'poll', elapsedMs: 2000});
  expect(() => requireNativeNetworkDenial(result)).toThrow();
  expect(f.closed()).toBe(1);
  const expired = fixture();
  expect(() => connectNativeSocket(expired.api, address, {now: () => 2000, startedAt: 0})).toThrow(
    'timed out during socket',
  );
  expect(expired.closed()).toBe(0);
  time = 0;
  const setupInterrupted = fixture({
    flags: () => {
      time = 2000;
      return {value: -1, errno: errno.EINTR};
    },
  });
  expect(() => connectNativeSocket(setupInterrupted.api, address, {now: () => time})).toThrow('timed out during fcntl');
  expect(setupInterrupted.closed()).toBe(1);
  time = 0;
  const lateError = fixture({
    socketError: () => {
      time = 2000;
      return {value: 0, errno: 0, socketError: errno.EPERM};
    },
  });
  expect(connectNativeSocket(lateError.api, address, {now: () => time}).errno).toBe(errno.ETIMEDOUT);
});

it('retries interrupted setup and SO_ERROR within the remaining budget and closes once', () => {
  let time = 0;
  let flags = 0;
  let socketErrors = 0;
  const budgets: number[] = [];
  const f = fixture({
    flags: () => {
      if (flags++ === 0) {
        time += 100;
        return {value: -1, errno: errno.EINTR};
      }
      return {value: 0, errno: 0};
    },
    connect: () => ({value: -1, errno: errno.EINTR}),
    poll: (_descriptor, budget) => {
      budgets.push(budget);
      return {value: 1, errno: 0};
    },
    socketError: () => {
      if (socketErrors++ === 0) {
        time += 100;
        return {value: -1, errno: errno.EINTR, socketError: 0};
      }
      return {value: 0, errno: 0, socketError: errno.EPERM};
    },
  });
  expect(requireNativeNetworkDenial(connectNativeSocket(f.api, address, {now: () => time}))).toBe(errno.EPERM);
  expect(budgets).toEqual([1900]);
  expect(flags).toBe(2);
  expect(socketErrors).toBe(2);
  expect(f.closed()).toBe(1);
});

it('bounds arbitrary EINTR schedules without resetting the deadline or leaking the socket', () => {
  fc.assert(
    fc.property(fc.array(fc.integer({min: 1, max: 500}), {maxLength: 12}), steps => {
      let time = 0;
      let index = 0;
      const budgets: number[] = [];
      const f = fixture({
        poll: (_descriptor, budget) => {
          budgets.push(budget);
          const step = steps[index++];
          if (step === undefined) {
            time += budget;
            return {value: 0, errno: 0};
          }
          time += Math.min(step, budget);
          return {value: -1, errno: errno.EINTR};
        },
      });
      const result = connectNativeSocket(f.api, address, {now: () => time});
      expect(result).toEqual({errno: errno.ETIMEDOUT, syscall: 'poll', elapsedMs: NETWORK_PROBE_TIMEOUT_MS});
      expect(budgets.every(budget => budget > 0 && budget <= NETWORK_PROBE_TIMEOUT_MS)).toBe(true);
      expect(budgets.every((budget, at) => at === 0 || budget < budgets[at - 1])).toBe(true);
      expect(f.closed()).toBe(1);
    }),
    {numRuns: 16},
  );
});

it('encodes the fixed IPv4 destination in both supported native sockaddr layouts', () => {
  const linux = nativeSocketAddress('linux', '192.0.2.1', 443);
  const mac = nativeSocketAddress('darwin', '192.0.2.1', 443);
  expect(new Uint16Array(linux.buffer, 0, 1)[0]).toBe(2);
  expect([...mac.subarray(0, 2)]).toEqual([16, 2]);
  for (const bytes of [linux, mac]) {
    expect(bytes).toHaveLength(16);
    expect([...bytes.subarray(2, 8)]).toEqual([1, 187, 192, 0, 2, 1]);
    expect([...bytes.subarray(8)]).toEqual(Array(8).fill(0));
  }
  expect(() => nativeSocketAddress('win32', '192.0.2.1', 443)).toThrow();
});

it('retains the explicit functional-only path without native socket initialization', async () => {
  await expect(verifyIsolation('/unreadable/unused', false)).resolves.toEqual({
    enforced: false,
    reason: 'Functional native Windows lane; OS isolation acceptance is pending.',
  });
});

const posix = process.platform === 'darwin' || process.platform === 'linux';
const enforceable = process.platform === 'darwin' || (process.platform === 'linux' && Boolean(Bun.which('bwrap')));
let root = '';
let binary = '';
let checkout = '';
beforeAll(async () => {
  if (!posix) return;
  root = realpathSync(mkdtempSync(join(tmpdir(), 'threadnote-network-probe-test-')));
  checkout = join(root, 'synthetic-checkout');
  mkdirSync(join(checkout, 'config/agent-skills/dev-plan'), {recursive: true});
  writeFileSync(join(checkout, 'config/agent-skills/dev-plan/SKILL.md'), 'synthetic source denial fixture');
  mkdirSync(join(root, 'user'));
  binary = join(root, 'native-probe');
  const build = await Bun.build({
    entrypoints: [resolve('apps/threadnote/test/dev-skills/native-release-network-probe.ts')],
    compile: {outfile: binary},
  });
  expect(build.success, JSON.stringify(build.logs)).toBe(true);
}, 15_000);
afterAll(() => {
  if (root) rmSync(root, {recursive: true, force: true});
});
const isolated = (args: string[]) => {
  if (process.platform === 'darwin') {
    const policy =
      '(version 1)(allow default)(deny network*)' +
      '(allow network-inbound (local ip "localhost:*"))' +
      '(allow network-outbound (remote ip "localhost:*"))' +
      '(allow process-exec (literal "/bin/ps") (with no-sandbox))' +
      '(deny file-read* (subpath ' +
      JSON.stringify(checkout) +
      '))';
    return ['/usr/bin/sandbox-exec', '-p', policy, binary, ...args];
  }
  return [
    'bwrap',
    '--unshare-net',
    '--die-with-parent',
    '--ro-bind',
    '/',
    '/',
    '--bind',
    root,
    root,
    '--tmpfs',
    checkout,
    '--dev',
    '/dev',
    '--proc',
    '/proc',
    '--chdir',
    root,
    binary,
    ...args,
  ];
};
const invoke = (command: string[]) => {
  const result = spawnSync(command[0], command.slice(1), {
    encoding: 'utf8',
    cwd: root,
    timeout: 6000,
    env: {
      ...process.env,
      HOME: join(root, 'user'),
      USERPROFILE: join(root, 'user'),
      TMPDIR: root,
      TMP: root,
      TEMP: root,
    },
  });
  expect(result.error, result.error?.message).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as NativeConnectResult & {
    enforced: boolean;
    sourceReadErrno: number;
    outboundConnectErrno: number;
  };
};

it.skipIf(!enforceable)(
  'proves actual native connect denial and source denial inside the unchanged compiled OS sandbox',
  () => {
    const result = invoke(isolated([checkout]));
    expect(result.enforced).toBe(true);
    expect([errno.EPERM, errno.EACCES, errno.ENOENT]).toContain(result.sourceReadErrno);
    expect([errno.EPERM, errno.EACCES, errno.ENETUNREACH]).toContain(result.outboundConnectErrno);
  },
);

it.skipIf(!posix)('refuses readable source before attempting any outbound socket', async () => {
  await expect(verifyIsolation(checkout, true)).rejects.toThrow('The source checkout is readable');
});

it.skipIf(!posix)(
  'observes real loopback connection and refusal as non-denial controls through the compiled raw socket API',
  () => {
    // A listener bound only to loopback supplies a controlled successful connection.
    const listener = Bun.listen({
      hostname: '127.0.0.1',
      port: 0,
      socket: {
        data() {},
        open(socket) {
          socket.end();
        },
      },
    });
    const port = listener.port;
    const command = (value: number) =>
      process.platform === 'darwin' ? isolated(['--loopback', String(value)]) : [binary, '--loopback', String(value)];
    try {
      const connected = invoke(command(port));
      expect(connected.errno).toBe(0);
      expect(connected.elapsedMs).toBeLessThan(NETWORK_PROBE_TIMEOUT_MS);
      expect(() => requireNativeNetworkDenial(connected)).toThrow();
    } finally {
      listener.stop(true);
    }
    const refused = invoke(command(port));
    expect(refused.errno).toBe(errno.ECONNREFUSED);
    expect(refused.elapsedMs).toBeLessThan(NETWORK_PROBE_TIMEOUT_MS);
    expect(() => requireNativeNetworkDenial(refused)).toThrow();
  },
);
