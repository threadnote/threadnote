import {dlopen, type FFIFunction} from 'bun:ffi';
import {expect, it, vi} from 'vitest';
import fc from 'fast-check';
import {Array as EffectArray, Record as EffectRecord, Schema} from 'effect';
import {commitWriterTransaction, type WriterTransactionTarget} from '../../src/writer-system/writer-transaction.js';
import {RuntimeWriterFault, writerFail} from '../../src/writer-system/fault.js';
import {
  runtimeOpenWriterRoot,
  runtimeCloseWriterRoot,
  runtimeOpenGuardedDiskTarget,
  runtimeInspectGuardedDiskTarget,
  runtimeCommitGuardedDiskTarget,
  runtimeCloseGuardedDiskTarget,
  type RuntimeGuardedDiskTarget,
  type RuntimeWriterRoot,
} from '../../src/writer_system.js';
import {runtimeNativePlatformSupport} from '../../src/system.js';
import {windowsTokenPrincipal, windowsSystemLibrary, windowsWide} from '../../src/writer-system/windows-native.js';

// This final negative control forwards one real close, then withholds its success.
// It proves conservative close-UNKNOWN retention without leaking a fixture HANDLE.
const releaseControl = vi.hoisted(() => ({
  armed: false,
  writable: 0n,
  withheld: false,
  closes: 0,
  libraries: 0,
  failCompletedWrite: false,
  writes: 0,
  setLastError: undefined as ((code: number) => void) | undefined,
}));
vi.mock('bun:ffi', async importOriginal => {
  const real = await importOriginal<typeof import('bun:ffi')>();
  return {
    ...real,
    dlopen: <Fns extends Record<string, FFIFunction>>(name: Parameters<typeof real.dlopen>[0], symbols: Fns) => {
      releaseControl.libraries++;
      const library = real.dlopen(name, symbols);
      return {
        ...library,
        symbols: new Proxy(library.symbols, {
          get(target, key, receiver) {
            const original: unknown = Reflect.get(target, key, receiver);
            if (typeof original !== 'function') return original;
            if (key === 'NtCreateFile')
              return (...args: unknown[]) => {
                const result: unknown = Reflect.apply(original, undefined, args);
                if (result === 0 && args[1] === 0x00120183 && args[0] instanceof BigUint64Array)
                  releaseControl.writable = args[0][0];
                return result;
              };
            if (key === 'WriteFile')
              return (handle: bigint, bytes: Uint8Array, length: number, count: Uint32Array, overlapped: null) => {
                const result: unknown = Reflect.apply(original, undefined, [handle, bytes, length, count, overlapped]);
                if (releaseControl.failCompletedWrite && handle === releaseControl.writable) {
                  releaseControl.writes++;
                  if (result === 1) {
                    releaseControl.setLastError?.(5);
                    return 0;
                  }
                }
                return result;
              };
            if (key === 'CloseHandle')
              return (handle: bigint) => {
                const result: unknown = Reflect.apply(original, undefined, [handle]);
                if (releaseControl.armed && handle === releaseControl.writable) {
                  releaseControl.closes++;
                  if (!releaseControl.withheld && result === 1) {
                    releaseControl.withheld = true;
                    return 0;
                  }
                }
                return result;
              };
            return original;
          },
        }),
      };
    },
  };
});

interface Observation {
  readonly bytes: Uint8Array;
  readonly version: number;
}
function memoryTarget(initial: Uint8Array, chunk: number) {
  let bytes = initial.slice(),
    attempted = false;
  const events: string[] = [];
  const target: WriterTransactionTarget<Observation> = {
    maximumBytes: 64,
    get attempted() {
      return attempted;
    },
    inspect() {
      events.push('inspect');
      return {bytes: bytes.slice(), version: 1};
    },
    sameIdentity(a, b) {
      return a.version === b.version;
    },
    beginAttempt() {
      attempted = true;
      events.push('attempt');
    },
    writeAt(input, offset) {
      events.push('write');
      const count = Math.min(chunk, input.length - offset),
        next = new Uint8Array(Math.max(bytes.length, offset + count));
      next.set(bytes);
      next.set(input.subarray(offset, offset + count), offset);
      bytes = next;
      return count;
    },
    truncate(length) {
      events.push('truncate');
      bytes = bytes.slice(0, length);
    },
    flush() {
      events.push('flush');
    },
    refreshBaseline() {
      events.push('baseline');
    },
  };
  return {target, events, read: () => bytes.slice(), before: {bytes: bytes.slice(), version: 1}};
}
it('preserves the single-attempt protocol over bounded payloads and partial native writes', () => {
  fc.assert(
    fc.property(
      fc.uint8Array({maxLength: 32}),
      fc.uint8Array({maxLength: 32}),
      fc.integer({min: 1, max: 8}),
      (before, after, chunk) => {
        const state = memoryTarget(before, chunk);
        const input = {
          before: state.before,
          afterBytes: after,
          assertCurrentSync: () => {
            state.events.push('assert');
          },
        };
        expect(commitWriterTransaction(input, () => state.target).status).toBe('applied');
        expect(state.read()).toEqual(after);
        expect(state.events.slice(-5)).toEqual(['truncate', 'flush', 'baseline', 'inspect', 'assert']);
        expect(EffectArray.filter(state.events, event => event === 'write')).toHaveLength(
          Math.ceil(after.length / chunk),
        );
        const writes = EffectArray.filter(state.events, event => event === 'write').length;
        expect(commitWriterTransaction(input, () => state.target)).toEqual({
          status: 'conflict',
          reason: 'source-changed',
        });
        expect(EffectArray.filter(state.events, event => event === 'write')).toHaveLength(writes);
        expect(state.read()).toEqual(after);
      },
    ),
    {numRuns: 40},
  );
});
it('preserves the completed prefix and never replays after generated lease-loss cut points', () => {
  fc.assert(
    fc.property(fc.uint8Array({minLength: 1, maxLength: 32}), fc.integer({min: 1, max: 8}), (after, chunk) => {
      const writes = Math.ceil(after.length / chunk);
      for (let lossAt = 2; lossAt <= writes + 3; lossAt++) {
        const initial = new Uint8Array(after.length + 1).fill(255);
        const state = memoryTarget(initial, chunk);
        let assertions = 0;
        const outcome = commitWriterTransaction(
          {
            before: state.before,
            afterBytes: after,
            assertCurrentSync() {
              if (++assertions === lossAt) writerFail('source-changed');
            },
          },
          () => state.target,
        );
        const completedWrites = Math.min(writes, lossAt - 2);
        const prefix = Math.min(after.length, completedWrites * chunk);
        const expected = lossAt === writes + 3 ? after.slice() : initial.slice();
        expected.set(after.subarray(0, prefix));
        expect(state.read()).toEqual(expected);
        expect(outcome.status).toBe(lossAt === 2 ? 'conflict' : 'unknown');
        const beforeRetry = state.read();
        expect(
          commitWriterTransaction(
            {before: state.before, afterBytes: after, assertCurrentSync() {}},
            () => state.target,
          ),
        ).toEqual({status: 'conflict', reason: 'source-changed'});
        expect(state.read()).toEqual(beforeRetry);
        expect(EffectArray.filter(state.events, event => event === 'write')).toHaveLength(completedWrites);
      }
    }),
    {numRuns: 30},
  );
});

it('keeps pre-mutation conflicts intact and refuses invalid counts or late failures without replay', () => {
  const state = memoryTarget(new Uint8Array([1, 2]), 1);
  expect(
    commitWriterTransaction(
      {
        before: {...state.before, bytes: new Uint8Array([9])},
        afterBytes: new Uint8Array([3]),
        assertCurrentSync() {},
      },
      () => state.target,
    ),
  ).toEqual({status: 'conflict', reason: 'source-changed'});
  expect(state.read()).toEqual(new Uint8Array([1, 2]));
  expect(state.events).toEqual(['inspect']);
  for (const invalidCount of [0, -1, 3, 0.5, Number.NaN]) {
    const broken = memoryTarget(new Uint8Array([1]), 1);
    broken.target.writeAt = () => invalidCount;
    const input = {before: broken.before, afterBytes: new Uint8Array([4, 5]), assertCurrentSync() {}};
    expect(commitWriterTransaction(input, () => broken.target)).toEqual({status: 'unknown'});
    expect(commitWriterTransaction(input, () => broken.target)).toEqual({status: 'conflict', reason: 'source-changed'});
  }
  const late = memoryTarget(new Uint8Array([1]), 1);
  late.target.flush = () => writerFail('io');
  expect(
    commitWriterTransaction(
      {before: late.before, afterBytes: new Uint8Array([8]), assertCurrentSync() {}},
      () => late.target,
    ),
  ).toEqual({status: 'unknown'});
  expect(late.read()).toEqual(new Uint8Array([8]));
});

const fs = process.getBuiltinModule('fs'),
  path = process.getBuiltinModule('path'),
  os = process.getBuiltinModule('os');
function ownedFixture<A>(use: (directory: string) => A): A {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tn-windows-writer-')));
  try {
    return use(directory);
  } finally {
    fs.rmSync(directory, {recursive: true, force: true});
  }
}
const invalid = 0xffffffffffffffffn;
it.skipIf(process.platform !== 'win32')(
  'proves rooted NTFS source I/O, strict compatibility, sharing exclusion and close-UNKNOWN refusal',
  () =>
    ownedFixture(temporary => {
      const directory = path.join(temporary, 'owned'),
        file = path.join(directory, 'source.txt');
      const principal = windowsTokenPrincipal();
      const security = windowsSystemLibrary('advapi32.dll', {
        ConvertStringSecurityDescriptorToSecurityDescriptorW: {
          args: ['buffer', 'u32', 'buffer', 'ptr'],
          returns: 'i32',
        },
      });
      const setup = dlopen('kernel32.dll', {
        CreateDirectoryW: {args: ['buffer', 'buffer'], returns: 'i32'},
        CreateFileW: {args: ['buffer', 'u32', 'u32', 'ptr', 'u32', 'u32', 'u64'], returns: 'u64'},
        CloseHandle: {args: ['u64'], returns: 'i32'},
        LocalFree: {args: ['u64'], returns: 'u64'},
        GetLastError: {args: [], returns: 'u32'},
        SetLastError: {args: ['u32'], returns: 'void'},
        GetFileAttributesW: {args: ['buffer'], returns: 'u32'},
        SetFileAttributesW: {args: ['buffer', 'u32'], returns: 'i32'},
        GetFileInformationByHandle: {args: ['u64', 'buffer'], returns: 'i32'},
        GetFileInformationByHandleEx: {args: ['u64', 'u32', 'buffer', 'u32'], returns: 'i32'},
      });
      let root: RuntimeWriterRoot | undefined, target: RuntimeGuardedDiskTarget | undefined;
      let closeUnknown = false;
      const openRoots: RuntimeWriterRoot[] = [];
      const open = () => {
        const info = fs.statSync(directory, {bigint: true});
        expect(info.isDirectory()).toBe(true);
        expect(info.size).toBe(0n);
        const current = runtimeOpenWriterRoot(fs.realpathSync(directory), {dev: info.dev, ino: info.ino});
        openRoots.push(current);
        return current;
      };
      const physical = () => {
        const info = fs.statSync(file, {bigint: true});
        return JSON.stringify([String(info.dev), String(info.ino)]);
      };
      const sd = new BigUint64Array(1);
      releaseControl.setLastError = setup.symbols.SetLastError;
      try {
        expect(runtimeNativePlatformSupport().writer).toBe(false);
        expect(
          security.symbols.ConvertStringSecurityDescriptorToSecurityDescriptorW(
            windowsWide(`O:${principal.sid}D:P(A;OICI;FA;;;${principal.sid})`),
            1,
            sd,
            null,
          ),
        ).toBe(1);
        const attributes = new BigUint64Array(3);
        new DataView(attributes.buffer).setUint32(0, 24, true);
        attributes[1] = sd[0];
        expect(setup.symbols.CreateDirectoryW(windowsWide(directory), attributes)).toBe(1);
        fs.writeFileSync(file, 'old source');
        const probe = setup.symbols.CreateFileW(windowsWide(file), 0x80000000, 7, null, 3, 0x00200000, 0n);
        expect(probe !== 0n && probe !== invalid).toBe(true);
        let representable = false;
        try {
          const legacy = new Uint8Array(84),
            full = new Uint8Array(56),
            basic = new Uint8Array(72);
          legacy.fill(0xa5);
          full.fill(0xa5);
          basic.fill(0xa5);
          expect(setup.symbols.GetFileInformationByHandle(probe, legacy.subarray(0, 52))).toBe(1);
          expect(setup.symbols.GetFileInformationByHandleEx(probe, 18, full.subarray(0, 24), 24)).toBe(1);
          expect(setup.symbols.GetFileInformationByHandleEx(probe, 0, basic.subarray(0, 40), 40)).toBe(1);
          expect(
            legacy.subarray(52).every(value => value === 0xa5) &&
              full.subarray(24).every(value => value === 0xa5) &&
              basic.subarray(40).every(value => value === 0xa5),
          ).toBe(true);
          const l = new DataView(legacy.buffer),
            f = new DataView(full.buffer),
            t = new DataView(basic.buffer),
            observed = fs.statSync(file, {bigint: true}),
            index = BigInt(l.getUint32(44, true)) * 0x100000000n + BigInt(l.getUint32(48, true)),
            epoch = 116_444_736_000_000_000n;
          expect(observed.isFile()).toBe(true);
          expect(observed.size).toBe(BigInt(new TextEncoder().encode('old source').byteLength));
          const projection = {
            volume: f.getUint32(0, true) === l.getUint32(28, true) && observed.dev === BigInt(l.getUint32(28, true)),
            fileId:
              f.getBigUint64(16, true) === 0n &&
              f.getBigUint64(8, true) === index &&
              observed.ino === index &&
              index !== 0n,
            birth: observed.birthtimeNs === (t.getBigInt64(0, true) - epoch) * 100n,
            modified: observed.mtimeNs === (t.getBigInt64(16, true) - epoch) * 100n,
            changed: observed.ctimeNs === (t.getBigInt64(24, true) - epoch) * 100n,
          };
          const volumeRelations = {
            nativeVolume64EqualsLegacySerial32: f.getBigUint64(0, true) === BigInt(l.getUint32(28, true)),
            legacySerial32EqualsBunBigintDev: BigInt(l.getUint32(28, true)) === observed.dev,
            nativeVolume64EqualsBunBigintDev: f.getBigUint64(0, true) === observed.dev,
            nativeVolume64Low32EqualsLegacySerial32: f.getUint32(0, true) === l.getUint32(28, true),
          };
          const previousVolumeProjection =
            volumeRelations.nativeVolume64EqualsLegacySerial32 && volumeRelations.nativeVolume64EqualsBunBigintDev;
          representable = EffectArray.every(EffectRecord.values(projection), Boolean);
          process.stdout.write(
            'WINDOWS_WRITER_PROJECTION ' +
              JSON.stringify({projection, volumeRelations, previousVolumeProjection, representable, qualified: false}) +
              String.fromCharCode(10),
          );
        } finally {
          expect(setup.symbols.CloseHandle(probe)).toBe(1);
        }
        if (!representable) {
          expect(() => {
            const candidate = open();
            const acquired = runtimeOpenGuardedDiskTarget(candidate, ['source.txt'], physical(), 1024);
            runtimeCloseGuardedDiskTarget(acquired);
          }).toThrow();
          throw new Error('Lossless native identity projection is unsupported on this actual host.');
        }
        try {
          root = open();
        } catch (error) {
          expect(Schema.is(RuntimeWriterFault)(error)).toBe(true);
          if (Schema.is(RuntimeWriterFault)(error)) {
            expect(error.reason).toBe('unsupported-platform');
            expect(error.message).toMatch(
              /^windows-projection:(fileIdEncoding|symbolicLink|directoryType|fileType|volumeLow32|volumeDev|fileIdHigh|fileIdNonzero|fileIdLegacy|fileIdBun|birth|changed|modified|links|size)$/,
            );
            process.stdout.write(
              'WINDOWS_WRITER_ROOT_PROJECTION_REFUSAL ' +
                JSON.stringify({reason: error.reason, message: error.message}) +
                String.fromCharCode(10),
            );
          }
          throw error;
        }
        expect(() => runtimeOpenGuardedDiskTarget(root!, ['..', 'source.txt'], physical(), 1024)).toThrow();
        expect(() => Reflect.apply(runtimeInspectGuardedDiskTarget, undefined, [{}])).toThrow();
        // A preexisting compatible foreign read/write or delete HANDLE must block source acquisition.
        for (const access of [0xc0000000, 0x10000]) {
          const foreign = setup.symbols.CreateFileW(windowsWide(file), access, 7, null, 3, 0x80, 0n);
          expect(foreign !== 0n && foreign !== invalid).toBe(true);
          try {
            expect(() => runtimeOpenGuardedDiskTarget(root!, ['source.txt'], physical(), 1024)).toThrow();
          } finally {
            expect(setup.symbols.CloseHandle(foreign)).toBe(1);
          }
          expect(fs.readFileSync(file, 'utf8')).toBe('old source');
        }
        target = runtimeOpenGuardedDiskTarget(root, ['source.txt'], physical(), 1024);
        for (const access of [0xc0000000, 0x10000]) {
          const foreign = setup.symbols.CreateFileW(windowsWide(file), access, 7, null, 3, 0x80, 0n),
            error = setup.symbols.GetLastError();
          if (foreign !== 0n && foreign !== invalid) expect(setup.symbols.CloseHandle(foreign)).toBe(1);
          expect(foreign).toBe(invalid);
          expect(error).toBe(32);
        }
        const before = runtimeInspectGuardedDiskTarget(target);
        expect(before.identity).toEqual(fs.lstatSync(file, {bigint: true}));
        expect(new TextDecoder().decode(before.bytes)).toBe('old source');
        const forged = {...before, bytes: before.bytes.slice()};
        expect(
          runtimeCommitGuardedDiskTarget(target, {
            before: forged,
            afterBytes: new Uint8Array([9]),
            assertCurrentSync() {},
          }),
        ).toEqual({status: 'conflict', reason: 'source-changed'});
        let assertions = 0;
        expect(
          runtimeCommitGuardedDiskTarget(target, {
            before,
            afterBytes: new TextEncoder().encode('new'),
            assertCurrentSync() {
              assertions++;
            },
          }).status,
        ).toBe('applied');
        expect(assertions).toBeGreaterThanOrEqual(4);
        expect(fs.readFileSync(file, 'utf8')).toBe('new');
        runtimeCloseGuardedDiskTarget(target);
        target = undefined;
        const attributesBefore = setup.symbols.GetFileAttributesW(windowsWide(file));
        expect(attributesBefore).not.toBe(0xffffffff);
        expect(setup.symbols.SetFileAttributesW(windowsWide(file), attributesBefore | 1)).toBe(1);
        try {
          expect(() => runtimeOpenGuardedDiskTarget(root!, ['source.txt'], physical(), 1024)).toThrow();
        } finally {
          expect(setup.symbols.SetFileAttributesW(windowsWide(file), attributesBefore)).toBe(1);
        }
        expect(fs.readFileSync(file, 'utf8')).toBe('new');
        const nested = path.join(directory, 'nested'),
          junction = path.join(directory, 'junction');
        fs.mkdirSync(nested);
        fs.writeFileSync(path.join(nested, 'data.txt'), 'unchanged');
        fs.symlinkSync(nested, junction, 'junction');
        try {
          const linked = fs.statSync(path.join(nested, 'data.txt'), {bigint: true});
          const linkedPhysical = JSON.stringify([String(linked.dev), String(linked.ino)]);
          expect(() => runtimeOpenGuardedDiskTarget(root!, ['junction', 'data.txt'], linkedPhysical, 1024)).toThrow();
          expect(fs.readFileSync(path.join(nested, 'data.txt'), 'utf8')).toBe('unchanged');
        } finally {
          fs.unlinkSync(junction);
        }
        const alias = path.join(directory, 'alias.txt');
        fs.linkSync(file, alias);
        try {
          expect(() => runtimeOpenGuardedDiskTarget(root!, ['source.txt'], physical(), 1024)).toThrow();
        } finally {
          fs.unlinkSync(alias);
        }
        const originalPhysical = physical();
        fs.renameSync(file, path.join(directory, 'retired.txt'));
        fs.writeFileSync(file, 'foreign replacement');
        expect(() => runtimeOpenGuardedDiskTarget(root!, ['source.txt'], originalPhysical, 1024)).toThrow();
        expect(fs.readFileSync(file, 'utf8')).toBe('foreign replacement');
        target = runtimeOpenGuardedDiskTarget(root, ['source.txt'], physical(), 1024);
        const uncertainBefore = runtimeInspectGuardedDiskTarget(target);
        releaseControl.failCompletedWrite = true;
        try {
          const input = {
            before: uncertainBefore,
            afterBytes: new TextEncoder().encode('uncertain'),
            assertCurrentSync() {},
          };
          expect(runtimeCommitGuardedDiskTarget(target, input)).toEqual({status: 'unknown'});
          expect(releaseControl.writes).toBe(1);
          expect(() => runtimeCommitGuardedDiskTarget(target!, input)).toThrow();
          expect(releaseControl.writes).toBe(1);
        } finally {
          releaseControl.failCompletedWrite = false;
          runtimeCloseGuardedDiskTarget(target);
          target = undefined;
        }
        // Only the actual completed prefix changed; no rollback, truncate, or publication was claimed.
        expect(fs.readFileSync(file, 'utf8')).toBe('uncertaineplacement');
        // Final controlled negative: actual close succeeds; its observed success is withheld once.
        target = runtimeOpenGuardedDiskTarget(root, ['source.txt'], physical(), 1024);
        releaseControl.armed = true;
        expect(() => runtimeCloseGuardedDiskTarget(target!)).toThrow();
        closeUnknown = true;
        expect(releaseControl.withheld).toBe(true);
        expect(() => runtimeCloseGuardedDiskTarget(target!)).toThrow();
        expect(releaseControl.closes).toBe(1);
        expect(() => runtimeInspectGuardedDiskTarget(target!)).toThrow();
        const acquisitions = releaseControl.libraries;
        expect(open).toThrow();
        expect(releaseControl.libraries).toBe(acquisitions);
        expect(releaseControl.closes).toBe(1);
        expect(runtimeNativePlatformSupport().writer).toBe(false);
      } finally {
        releaseControl.armed = false;
        releaseControl.failCompletedWrite = false;
        releaseControl.setLastError = undefined;
        if (target && !closeUnknown) runtimeCloseGuardedDiskTarget(target);
        for (const current of openRoots) runtimeCloseWriterRoot(current);
        if (sd[0] !== 0n) expect(setup.symbols.LocalFree(sd[0])).toBe(0n);
        security.close();
        setup.close();
      }
    }),
);
