import {dlopen, ptr, read, type FFIFunction} from 'bun:ffi';
import {expect, it, vi} from 'vitest';
import {Array as EffectArray, String as EffectString, Schema} from 'effect';
import {linuxRuntimeLibc, posixWriterLibrary} from '../../src/writer-system/posix-native.js';
import {RuntimeWriterFault} from '../../src/writer-system/fault.js';
import {
  runtimeOpenPrivateWriterDirectory,
  runtimeClosePrivateWriterDirectory,
  runtimePublishPrivateWriterFile,
  runtimeAssertPrivateProviderPath,
} from '../../src/system.js';

interface NativeObserver {
  incomplete: number;
  before(library: number, symbol: string, args: readonly unknown[]): void;
  after(library: number, symbol: string, args: readonly unknown[], result: unknown): void;
  errno(address: unknown, value: number): void;
  exception(library: number): void;
  closed(library: number): void;
}
const observer = vi.hoisted(() => {
  const state: {librariesOpened: number; librariesClosed: number; active?: NativeObserver} = {
    librariesOpened: 0,
    librariesClosed: 0,
  };
  return state;
});
vi.mock('bun:ffi', async importOriginal => {
  const real = await importOriginal<typeof import('bun:ffi')>();
  const nativeI32 = real.read.i32;
  // Both delegates exist before observation. The syscall-to-errno interval must not allocate a wrapper/args array.
  const observedI32: typeof nativeI32 = (address, byteOffset) => {
    const value = nativeI32(address, byteOffset);
    try {
      observer.active?.errno(address, value);
    } catch {
      if (observer.active) observer.active.incomplete++;
    }
    return value;
  };
  return {
    ...real,
    dlopen: <Fns extends Record<string, FFIFunction>>(name: Parameters<typeof real.dlopen>[0], symbols: Fns) => {
      const library = real.dlopen(name, symbols);
      const id = ++observer.librariesOpened;
      const active = observer.active;
      return {
        ...library,
        symbols: active
          ? new Proxy(library.symbols, {
              get(target, key, receiver) {
                const original: unknown = Reflect.get(target, key, receiver);
                if (
                  typeof original !== 'function' ||
                  typeof key !== 'string' ||
                  !['fstatfs', 'fgetxattr', '__errno_location', 'openat', '__openat'].includes(key)
                )
                  return original;
                return (...args: unknown[]) => {
                  try {
                    active.before(id, key, args);
                  } catch {
                    active.incomplete++;
                  }
                  let result: unknown;
                  try {
                    result = Reflect.apply(original, undefined, args);
                  } catch (error) {
                    try {
                      active.exception(id);
                    } catch {
                      active.incomplete++;
                    }
                    throw error;
                  }
                  // In particular, no further native call precedes the backend's own errno read.
                  try {
                    active.after(id, key, args, result);
                  } catch {
                    active.incomplete++;
                  }
                  return result;
                };
              },
            })
          : library.symbols,
        close: () => {
          library.close();
          observer.librariesClosed++;
          try {
            active?.closed(id);
          } catch {
            if (active) active.incomplete++;
          }
        },
      };
    },
    read: new Proxy(real.read, {
      get(target, key, receiver) {
        return key === 'i32' ? observedI32 : Reflect.get(target, key, receiver);
      },
    }),
  };
});

type Role = 'root' | 'ancestor' | 'fixture' | 'other' | 'unknown';
interface Lifetime {
  generation: number;
  ordinal: number;
  role: Role;
}
function descriptorLifetimes() {
  const live = new Map<number, Lifetime>();
  let acquired = 0,
    closed = 0,
    badClose = 0,
    overlap = 0;
  return {
    live,
    acquire(fd: number, ordinal: number, role: Role) {
      if (live.has(fd)) overlap++;
      live.set(fd, {generation: ++acquired, ordinal, role});
    },
    close(fd: number) {
      if (!live.delete(fd)) badClose++;
      else closed++;
    },
    report: () => ({acquired, closed, active: live.size, badClose, overlap}),
  };
}
interface Attribute {
  kind: 'access' | 'default' | 'unknown';
  count?: unknown;
  errno?: number;
  canary?: boolean;
  buffer?: Uint8Array;
}
interface Sample {
  phase: string;
  lifetime?: Lifetime;
  result?: unknown;
  canary?: boolean;
  type?: bigint;
  flags?: bigint;
  errnoAddress?: unknown;
  attributes: Attribute[];
  stage?: string;
}
const descriptor = (value: unknown) =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
const numeric = (value: unknown) =>
  typeof value === 'bigint' || (typeof value === 'number' && Number.isFinite(value)) ? String(value) : null;

/** One synchronous fixture's actual native samples; no paths, descriptors, pointers or ACL bodies leave this closure. */
function linuxProbe(folder: string) {
  const fs = process.getBuiltinModule('fs');
  const depth = EffectArray.filter(EffectString.split('/')(folder), name => name.length > 0).length;
  const lifetimes = descriptorLifetimes(),
    live = lifetimes.live;
  const samples = new Map<number, Sample>(),
    lastByEdge = new Map<string, Sample>();
  let calls = 0;
  let defaultAclObserved = false;
  const nativeFailure = -1n;
  let phase = 'baseline';
  let pending: {sample: Sample; attribute: Attribute} | undefined, refused: Sample | undefined;
  const openedLibraries = observer.librariesOpened,
    closedLibraries = observer.librariesClosed;
  const failSample = (sample: Sample, stage: string) => {
    sample.stage ??= stage;
    refused ??= sample;
  };
  const inspectAttribute = (sample: Sample, attribute: Attribute) => {
    const bytes = attribute.buffer;
    attribute.canary =
      bytes !== undefined &&
      bytes.buffer.byteLength >= bytes.byteOffset + 65536 + 32 &&
      new Uint8Array(bytes.buffer, bytes.byteOffset + 65536, 32).every(value => value === 0xa5);
    attribute.buffer = undefined;
    if (
      sample.phase === 'default-acl-negative' &&
      sample.lifetime?.role === 'fixture' &&
      attribute.kind === 'default' &&
      attribute.canary &&
      typeof attribute.count === 'bigint' &&
      attribute.count >= 0n
    )
      defaultAclObserved = true;
    if (!attribute.canary) failSample(sample, attribute.kind + '-canary');
    else if (attribute.count !== -1n) failSample(sample, attribute.kind + '-count');
    else if (attribute.errno !== 61) failSample(sample, attribute.kind + '-errno');
  };
  const trace: NativeObserver = {
    incomplete: 0,
    before(library, symbol, args) {
      if (symbol === 'fstatfs') {
        const fd = descriptor(args[0]);
        const lifetime = fd === undefined ? undefined : live.get(fd);
        if (!lifetime) trace.incomplete++;
        samples.set(library, {phase, lifetime, attributes: []});
        calls++;
      } else if (symbol === 'fgetxattr') {
        const sample = samples.get(library);
        if (!sample) {
          trace.incomplete++;
          return;
        }
        const name = args[1] instanceof Uint8Array ? new TextDecoder().decode(args[1]) : '';
        const attribute: Attribute = {
          kind:
            name === 'system.posix_acl_access\0'
              ? 'access'
              : name === 'system.posix_acl_default\0'
                ? 'default'
                : 'unknown',
          buffer: args[2] instanceof Uint8Array ? args[2] : undefined,
        };
        if (pending || attribute.kind === 'unknown' || sample.attributes.length >= 2) trace.incomplete++;
        sample.attributes.push(attribute);
        pending = {sample, attribute};
      }
    },
    after(library, symbol, args, result) {
      if (symbol === 'openat' || symbol === '__openat') {
        const fd = descriptor(result),
          parent = descriptor(args[0]);
        if (fd === undefined) return;
        const prior = parent === undefined ? undefined : live.get(parent);
        const ordinal = prior ? prior.ordinal + 1 : -1;
        lifetimes.acquire(fd, ordinal, ordinal === depth ? 'fixture' : ordinal >= 0 ? 'ancestor' : 'unknown');
        return;
      }
      const sample = samples.get(library);
      if (!sample) return;
      if (symbol === 'fstatfs') {
        sample.result = result;
        const bytes = args[1];
        if (!(bytes instanceof Uint8Array) || bytes.buffer.byteLength < bytes.byteOffset + 152) {
          trace.incomplete++;
          return;
        }
        sample.canary = new Uint8Array(bytes.buffer, bytes.byteOffset + 120, 32).every(value => value === 0xa5);
        if (result !== 0) failSample(sample, 'fstatfs-return');
        else if (!sample.canary) failSample(sample, 'fstatfs-canary');
        else {
          const view = new DataView(bytes.buffer, bytes.byteOffset, 120);
          sample.type = view.getBigUint64(0, true);
          sample.flags = view.getBigUint64(80, true);
          if (![0xef53n, 0x58465342n, 0x9123683en, 0x01021994n].includes(sample.type)) failSample(sample, 'fs-type');
          else if ((sample.flags & 1n) !== 0n) failSample(sample, 'readonly');
        }
      } else if (symbol === '__errno_location') {
        sample.errnoAddress = result;
        if (result == null) failSample(sample, 'errno-pointer');
      } else if (symbol === 'fgetxattr') {
        if (!pending || pending.sample !== sample) {
          trace.incomplete++;
          return;
        }
        pending.attribute.count = result;
        if (result !== nativeFailure) {
          inspectAttribute(sample, pending.attribute);
          pending = undefined;
        }
      }
    },
    errno(address, value) {
      if (pending && pending.attribute.count === nativeFailure && address === pending.sample.errnoAddress) {
        pending.attribute.errno = value;
        inspectAttribute(pending.sample, pending.attribute);
        pending = undefined;
      }
    },
    exception(library) {
      const sample = samples.get(library);
      if (sample) failSample(sample, 'native-exception');
      else trace.incomplete++;
    },
    closed(library) {
      const sample = samples.get(library);
      if (!sample) return;
      if (!sample.stage && (sample.attributes.length !== 2 || pending?.sample === sample)) {
        failSample(sample, 'trace-incomplete');
        trace.incomplete++;
      }
      if (sample.lifetime) lastByEdge.set(sample.phase + ':' + sample.lifetime.ordinal, sample);
      samples.delete(library);
    },
  };
  const open = fs.openSync,
    close = fs.closeSync;
  const opening = vi.spyOn(fs, 'openSync').mockImplementation((name, flags, mode) => {
    const fd = open(name, flags, mode);
    const directory = typeof flags === 'number' && (flags & fs.constants.O_DIRECTORY) !== 0;
    const ancestor =
      typeof name === 'string' && (name === folder || EffectString.startsWith(name === '/' ? '/' : name + '/')(folder));
    const ordinal =
      directory && ancestor && typeof name === 'string'
        ? EffectArray.filter(EffectString.split('/')(name), part => part.length > 0).length
        : -1;
    lifetimes.acquire(
      fd,
      ordinal,
      name === '/' ? 'root' : name === folder ? 'fixture' : directory && ancestor ? 'ancestor' : 'other',
    );
    return fd;
  });
  const installClose = () =>
    vi.spyOn(fs, 'closeSync').mockImplementation(fd => {
      close(fd);
      lifetimes.close(fd);
    });
  const closing = (() => {
    try {
      return installClose();
    } catch (error) {
      opening.mockRestore();
      throw error;
    }
  })();
  const render = (sample: Sample) => ({
    phase: sample.phase,
    edgeOrdinal: sample.lifetime?.ordinal ?? null,
    role: sample.lifetime?.role ?? 'unknown',
    acquisitionGeneration: sample.lifetime?.generation ?? null,
    stage: sample.stage ?? 'safe',
    fstatfsStatus: numeric(sample.result),
    statfsCanary: sample.canary ?? null,
    fsMagic: sample.type?.toString(16) ?? null,
    flags: sample.flags?.toString(16) ?? null,
    readonly: sample.flags === undefined ? null : (sample.flags & 1n) !== 0n,
    errnoPointerPresent: sample.errnoAddress === undefined ? null : sample.errnoAddress !== null,
    attributes: EffectArray.map(sample.attributes, attribute => ({
      kind: attribute.kind,
      countType:
        attribute.count === undefined
          ? 'not-sampled'
          : typeof attribute.count === 'bigint'
            ? 'bigint'
            : typeof attribute.count === 'number'
              ? 'number'
              : 'unexpected',
      count: numeric(attribute.count),
      errno: attribute.errno ?? null,
      canary: attribute.canary ?? null,
    })),
  });
  const stop = () => {
    observer.active = undefined;
    opening.mockRestore();
    closing.mockRestore();
  };
  observer.active = trace;
  return {
    phase(value: 'default-acl-negative' | 'publication-negative') {
      phase = value;
    },
    stop,
    finish(faults: readonly {stage: string; kind: string; reason?: RuntimeWriterFault['reason']}[]) {
      stop();
      const cleanup = {
        ...lifetimes.report(),
        librariesOpened: observer.librariesOpened - openedLibraries,
        librariesClosed: observer.librariesClosed - closedLibraries,
      };
      const complete =
        calls > 0 &&
        trace.incomplete === 0 &&
        samples.size === 0 &&
        live.size === 0 &&
        cleanup.badClose === 0 &&
        cleanup.overlap === 0 &&
        cleanup.closed === cleanup.acquired &&
        cleanup.librariesClosed === cleanup.librariesOpened;
      const report = {
        version: 1,
        kind: 'linux-acl-native-observation',
        calls,
        incomplete: trace.incomplete,
        complete,
        defaultAclObserved,
        faults,
        firstRefusal: refused ? render(refused) : null,
        edges: EffectArray.map([...lastByEdge.values()], render),
        cleanup,
      };
      process.stdout.write(JSON.stringify(report) + '\n');
      return complete && defaultAclObserved;
    },
  };
}

it('counts reused descriptor lifetimes independently of stat visits and detects unmatched transitions', () => {
  const ledger = descriptorLifetimes();
  ledger.acquire(7, -1, 'other'); // ELF probe, without a directory stat visit.
  expect(ledger.live.get(7)?.generation).toBe(1);
  ledger.close(7);
  ledger.acquire(7, 0, 'root'); // A later retained directory can reuse that integer.
  expect(ledger.live.get(7)?.generation).toBe(2);
  ledger.close(7);
  expect(ledger.report()).toEqual({acquired: 2, closed: 2, active: 0, badClose: 0, overlap: 0});
  ledger.close(7);
  expect(ledger.report()).toEqual({acquired: 2, closed: 2, active: 0, badClose: 1, overlap: 0});
  ledger.acquire(7, 0, 'root');
  ledger.acquire(7, 1, 'ancestor');
  expect(ledger.report()).toEqual({acquired: 4, closed: 2, active: 1, badClose: 1, overlap: 1});
});

it.skipIf(process.platform !== 'darwin' && process.platform !== 'linux')(
  'observes actual backend FFI loading and release without replacing native results',
  () => {
    const opened = observer.librariesOpened,
      closed = observer.librariesClosed;
    const observed: {symbol?: string; result?: unknown; read?: number} = {};
    observer.active = {
      incomplete: 0,
      before: () => undefined,
      after: (_library, symbol, _args, result) => {
        observed.symbol = symbol;
        observed.result = result;
      },
      errno: (_address, value) => {
        observed.read = value;
      },
      exception: () => undefined,
      closed: () => undefined,
    };
    let library: ReturnType<typeof posixWriterLibrary> | undefined;
    try {
      library = posixWriterLibrary();
      expect(observer.librariesOpened).toBe(opened + 1);
      // An empty relative name and invalid dirfd cannot open or modify any filesystem object.
      expect(library.symbols.__openat(-1, new Uint8Array([0]), 0, 0)).toBe(-1);
      expect(observed.symbol).toBe(process.platform === 'linux' ? 'openat' : '__openat');
      expect(observed.result).toBe(-1);
      expect(read.i32).toBe(read.i32);
      const backing = new ArrayBuffer(8),
        value = new Int32Array(backing);
      value[0] = 7;
      value[1] = 11;
      const address = ptr(value);
      expect(read.i32(address)).toBe(7);
      expect(observed.read).toBe(7);
      expect(read.i32(address, 4)).toBe(11);
      expect(observed.read).toBe(11);
    } finally {
      library?.close();
      observer.active = undefined;
    }
    expect(observer.librariesClosed).toBe(closed + 1);
  },
);

it.skipIf(process.platform !== 'linux')(
  'refuses an actual Linux default ACL while the private directory mode remains0700',
  () => {
    const fs = process.getBuiltinModule('fs'),
      os = process.getBuiltinModule('os'),
      path = process.getBuiltinModule('path');
    const folder = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'writer-native-linux-acl-')));
    let probe: ReturnType<typeof linuxProbe> | undefined;
    let directory: ReturnType<typeof runtimeOpenPrivateWriterDirectory> | undefined;
    let release = () => undefined;
    const faults: {stage: string; kind: string; reason?: RuntimeWriterFault['reason']}[] = [];
    const retain = (stage: string, error: unknown) => {
      faults.push(
        Schema.is(RuntimeWriterFault)(error)
          ? {stage, kind: 'native-refusal', reason: error.reason}
          : {stage, kind: 'exception'},
      );
    };
    let stage = 'baseline',
      complete = false;
    try {
      probe = linuxProbe(folder);
      const lib = dlopen(linuxRuntimeLibc().library, {
        fsetxattr: {args: ['i32', 'buffer', 'buffer', 'u64', 'i32'], returns: 'i32'},
      });
      release = () => {
        lib.close();
        return undefined;
      };
      const opened = runtimeOpenPrivateWriterDirectory(folder);
      directory = opened;
      stage = 'install-default-acl';
      const fd = fs.openSync(folder, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
      try {
        const acl = new Uint8Array(28),
          view = new DataView(acl.buffer);
        view.setUint32(0, 2, true);
        for (const [index, tag] of [1, 4, 32].entries()) {
          view.setUint16(4 + index * 8, tag, true);
          view.setUint16(6 + index * 8, 7, true);
          view.setUint32(8 + index * 8, 0xffffffff, true);
        }
        expect(lib.symbols.fsetxattr(fd, new TextEncoder().encode('system.posix_acl_default\0'), acl, 28n, 0)).toBe(0);
        expect(fs.fstatSync(fd).mode & 0o777).toBe(0o700);
      } finally {
        fs.closeSync(fd);
      }
      probe.phase('default-acl-negative');
      stage = 'default-acl-negative';
      expect(() => runtimeAssertPrivateProviderPath(folder, {kind: 'directory'})).toThrow();
      probe.phase('publication-negative');
      stage = 'publication-negative';
      expect(() =>
        runtimePublishPrivateWriterFile(opened, 'private.json', new TextEncoder().encode('private fixture'), {
          mode: 'exclusive',
          nonce: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          assertCurrentSync: () => undefined,
        }),
      ).toThrow();
      expect(fs.existsSync(path.join(folder, 'private.json'))).toBe(false);
    } catch (error) {
      retain(stage, error);
    } finally {
      const cleanups: readonly (readonly [string, () => unknown])[] = [
        [
          'cleanup-directory',
          () => {
            if (directory) runtimeClosePrivateWriterDirectory(directory);
          },
        ],
        ['cleanup-library', release],
        ['trace-stop', () => probe?.stop()],
        ['cleanup-fixture', () => fs.rmSync(folder, {recursive: true, force: true})],
      ];
      for (const [label, cleanup] of cleanups) {
        try {
          cleanup();
        } catch (error) {
          retain(label, error);
        }
      }
      if (probe) complete = probe.finish(faults);
      else
        process.stdout.write(
          JSON.stringify({version: 1, kind: 'linux-acl-native-observation', complete, faults}) + '\n',
        );
    }
    if (faults.length > 0 || !complete) throw new Error('Native ACL fixture failed; bounded phase metadata retained');
  },
);
