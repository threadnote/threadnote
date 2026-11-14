import {it as effectIt} from '@effect/vitest';
import {Array as EffectArray, Effect} from 'effect';
import {expect, vi} from 'vitest';
import {readWindowsProcessStartIdentity} from '../src/windows_system.js';

const native = vi.hoisted(() => ({dlopen: vi.fn<(path: string, symbols: unknown) => unknown>()}));
vi.mock('bun:ffi', () => ({dlopen: native.dlopen}));

const openedHandle = 0xfedc_ba98_7654_3210n;
const kernelFixture = (handle: bigint, read: 'success' | 'zero' | 'throw' = 'success') => {
  const OpenProcess = vi.fn((_access: number, _inherit: number, _processId: number) => handle);
  const GetProcessTimes = vi.fn(
    (
      _handle: bigint,
      creationTime: BigUint64Array,
      _exitTime: BigUint64Array,
      _kernelTime: BigUint64Array,
      _userTime: BigUint64Array,
    ) => {
      if (read === 'throw') throw new Error('Synthetic native read failure');
      creationTime[0] = 123_456_789n;
      return read === 'zero' ? 0 : 1;
    },
  );
  const CloseHandle = vi.fn((_handle: bigint) => 1);
  const close = vi.fn();
  native.dlopen.mockReset().mockReturnValue({symbols: {OpenProcess, GetProcessTimes, CloseHandle}, close});
  return {OpenProcess, GetProcessTimes, CloseHandle, close};
};
const expectNativeAbi = () =>
  expect(native.dlopen).toHaveBeenCalledExactlyOnceWith('kernel32.dll', {
    CloseHandle: {args: ['u64'], returns: 'i32'},
    GetProcessTimes: {args: ['u64', 'buffer', 'buffer', 'buffer', 'buffer'], returns: 'i32'},
    OpenProcess: {args: ['u32', 'i32', 'u32'], returns: 'u64'},
  });
const resetNative = Effect.sync(() => native.dlopen.mockReset());

effectIt.effect('preserves an opaque 64-bit process handle through identity observation and release', () =>
  Effect.gen(function* () {
    const kernel = kernelFixture(openedHandle);
    expect(yield* readWindowsProcessStartIdentity(42)).toBe('win32:504911232123456789');
    expectNativeAbi();
    expect(kernel.OpenProcess).toHaveBeenCalledExactlyOnceWith(0x1000, 0, 42);
    expect(kernel.GetProcessTimes).toHaveBeenCalledTimes(1);
    const [handle, ...times] = kernel.GetProcessTimes.mock.calls[0];
    expect(handle).toBe(openedHandle);
    expect(EffectArray.map(times, value => value.byteLength)).toEqual([8, 8, 8, 8]);
    expect(new Set(times).size).toBe(4);
    expect(kernel.CloseHandle).toHaveBeenCalledExactlyOnceWith(openedHandle);
    expect(kernel.close).toHaveBeenCalledTimes(1);
    expect(kernel.CloseHandle.mock.invocationCallOrder[0]).toBeLessThan(kernel.close.mock.invocationCallOrder[0]);
  }).pipe(Effect.ensuring(resetNative)),
);

effectIt.effect('treats a zero process handle as unavailable without reading or closing it', () =>
  Effect.gen(function* () {
    const kernel = kernelFixture(0n);
    expect(yield* readWindowsProcessStartIdentity(42)).toBeUndefined();
    expectNativeAbi();
    expect(kernel.GetProcessTimes).not.toHaveBeenCalled();
    expect(kernel.CloseHandle).not.toHaveBeenCalled();
    expect(kernel.close).toHaveBeenCalledTimes(1);
  }).pipe(Effect.ensuring(resetNative)),
);

for (const read of ['zero', 'throw'] as const)
  effectIt.effect(`releases the exact acquired handle once after a ${read} process-time result`, () =>
    Effect.gen(function* () {
      const kernel = kernelFixture(openedHandle, read);
      expect(yield* readWindowsProcessStartIdentity(42)).toBeUndefined();
      expectNativeAbi();
      expect(kernel.GetProcessTimes).toHaveBeenCalledTimes(1);
      expect(kernel.GetProcessTimes.mock.calls[0][0]).toBe(openedHandle);
      expect(kernel.CloseHandle).toHaveBeenCalledExactlyOnceWith(openedHandle);
      expect(kernel.close).toHaveBeenCalledTimes(1);
      expect(kernel.CloseHandle.mock.invocationCallOrder[0]).toBeLessThan(kernel.close.mock.invocationCallOrder[0]);
    }).pipe(Effect.ensuring(resetNative)),
  );
