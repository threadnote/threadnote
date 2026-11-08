import {dlopen} from 'bun:ffi';
import {Array as EffectArray, String as EffectString} from 'effect';
import {expect, it} from 'vitest';
import fc from 'fast-check';
import {assertWindowsDaclBytes} from '../../src/writer-system/windows-files.js';
import {runtimeAssertPrivateProviderPath, runtimeNativePlatformSupport} from '../../src/system.js';
import {windowsTokenPrincipal, windowsWide} from '../../src/writer-system/windows-native.js';
import {windowsProviderCommandLine} from '../../src/writer-system/provider-windows.js';

const native = process.getBuiltinModule('fs'),
  path = process.getBuiltinModule('path'),
  os = process.getBuiltinModule('os');
const windows = process.platform === 'win32';
const invalid = 0xffffffffffffffffn;
function fixture<A>(run: (directory: string) => A): A {
  const directory = native.realpathSync(native.mkdtempSync(path.join(os.tmpdir(), 'threadnote-native-win-')));
  try {
    return run(directory);
  } finally {
    native.rmSync(directory, {recursive: true, force: true});
  }
}
function sid(last: number): Uint8Array {
  const bytes = new Uint8Array(28),
    view = new DataView(bytes.buffer);
  bytes[0] = 1;
  bytes[1] = 5;
  bytes[7] = 5;
  for (const [index, value] of [21, 11, 22, 33, last].entries()) view.setUint32(8 + index * 4, value, true);
  return bytes;
}
function descriptor(other: number, rights: number): Uint8Array {
  const owner = sid(1001),
    ace = sid(other),
    size = 8 + 8 + ace.length,
    bytes = new Uint8Array(20 + owner.length + size),
    view = new DataView(bytes.buffer);
  bytes[0] = 1;
  view.setUint16(2, 0x8004, true);
  view.setUint32(4, 20, true);
  view.setUint32(16, 48, true);
  bytes.set(owner, 20);
  bytes[48] = 2;
  view.setUint16(50, size, true);
  view.setUint16(52, 1, true);
  view.setUint16(58, 8 + ace.length, true);
  view.setUint32(60, rights, true);
  bytes.set(ace, 64);
  return bytes;
}
it('refuses every generated nonzero foreign private DACL grant and every truncated security record', () => {
  const principal = 'S-1-5-21-11-22-33-1001';
  expect(() => assertWindowsDaclBytes(descriptor(1001, 0x1f01ff), 20, 48, principal, true)).not.toThrow();
  fc.assert(
    fc.property(fc.integer({min: 1002, max: 100000}), fc.integer({min: 1, max: 0xffffffff}), (other, rights) => {
      expect(() => assertWindowsDaclBytes(descriptor(other, rights), 20, 48, principal, true)).toThrow();
    }),
    {numRuns: 30},
  );
  const valid = descriptor(1001, 0x1f01ff);
  fc.assert(
    fc.property(fc.integer({min: 0, max: valid.length - 1}), length => {
      expect(() => assertWindowsDaclBytes(valid.subarray(0, length), 20, 48, principal, true)).toThrow();
    }),
    {numRuns: 30},
  );
});
it('quotes fixed Windows argv boundaries and rejects NUL and unpaired UTF-16 before native creation', () => {
  expect(windowsProviderCommandLine('C:\\tool.exe', ['', 'space value', 'quote"value', 'tail\\'])).toBe(
    '"C:\\tool.exe" "" "space value" "quote\\"value" "tail\\\\"',
  );
  for (const value of ['a\0b', '\ud800', '\udc00'])
    expect(() => windowsProviderCommandLine('C:\\tool.exe', [value])).toThrow();
});

it.skipIf(!windows)('checks actual native SID/DACL, full file ID and exact Bun metadata on one owned NTFS tree', () =>
  fixture(directory => {
    const principal = windowsTokenPrincipal();
    expect(principal.sid).toMatch(/^S-1-[0-9]+(?:-[0-9]+)+$/u);
    const file = path.join(directory, 'identity.txt');
    native.writeFileSync(file, 'owned fixture');
    const k = dlopen('kernel32.dll', {
      CreateFileW: {args: ['buffer', 'u32', 'u32', 'ptr', 'u32', 'u32', 'u64'], returns: 'u64'},
      CloseHandle: {args: ['u64'], returns: 'i32'},
      GetFileInformationByHandle: {args: ['u64', 'buffer'], returns: 'i32'},
      GetFileInformationByHandleEx: {args: ['u64', 'u32', 'buffer', 'u32'], returns: 'i32'},
    });
    const handle = k.symbols.CreateFileW(windowsWide(file), 0x80000000, 7, null, 3, 0x00200000, 0n);
    expect(handle !== 0n && handle !== invalid).toBe(true);
    try {
      const info = new Uint8Array(84),
        id = new Uint8Array(56),
        basic = new Uint8Array(72);
      info.fill(0xa5);
      id.fill(0xa5);
      basic.fill(0xa5);
      expect(k.symbols.GetFileInformationByHandle(handle, info.subarray(0, 52))).toBe(1);
      expect(k.symbols.GetFileInformationByHandleEx(handle, 18, id.subarray(0, 24), 24)).toBe(1);
      expect(k.symbols.GetFileInformationByHandleEx(handle, 0, basic.subarray(0, 40), 40)).toBe(1);
      expect(
        info.subarray(52).every(v => v === 0xa5) &&
          id.subarray(24).every(v => v === 0xa5) &&
          basic.subarray(40).every(v => v === 0xa5),
      ).toBe(true);
      const b = native.statSync(file, {bigint: true}),
        v = new DataView(info.buffer),
        t = new DataView(basic.buffer),
        full = new DataView(id.buffer);
      const ino = (BigInt(v.getUint32(44, true)) << 32n) | BigInt(v.getUint32(48, true)),
        epoch = 116_444_736_000_000_000n;
      expect(b.dev).toBe(BigInt(v.getUint32(28, true)));
      expect(b.ino).toBe(ino);
      expect(full.getBigUint64(8, true)).toBe(ino);
      expect(full.getBigUint64(16, true)).toBe(0n);
      expect(b.birthtimeNs).toBe((t.getBigInt64(0, true) - epoch) * 100n);
      expect(b.mtimeNs).toBe((t.getBigInt64(16, true) - epoch) * 100n);
      expect(b.ctimeNs).toBe((t.getBigInt64(24, true) - epoch) * 100n);
      expect(runtimeNativePlatformSupport().writer).toBe(false);
      runtimeAssertPrivateProviderPath(directory, {kind: 'directory'});
      runtimeAssertPrivateProviderPath(file, {kind: 'file'});
      native.linkSync(file, path.join(directory, 'alias.txt'));
      expect(() => runtimeAssertPrivateProviderPath(file, {kind: 'file'})).toThrow();
    } finally {
      expect(k.symbols.CloseHandle(handle)).toBe(1);
      k.close();
    }
  }),
);

it.skipIf(!windows)(
  'proves actual prior and later foreign writer/delete handles conflict with a retained source HANDLE',
  () =>
    fixture(directory => {
      const file = path.join(directory, 'source.txt');
      native.writeFileSync(file, 'old');
      const k = dlopen('kernel32.dll', {
        CreateFileW: {args: ['buffer', 'u32', 'u32', 'ptr', 'u32', 'u32', 'u64'], returns: 'u64'},
        CloseHandle: {args: ['u64'], returns: 'i32'},
        GetLastError: {args: [], returns: 'u32'},
        ReadFile: {args: ['u64', 'buffer', 'u32', 'buffer', 'ptr'], returns: 'i32'},
        WriteFile: {args: ['u64', 'buffer', 'u32', 'buffer', 'ptr'], returns: 'i32'},
        SetFilePointerEx: {args: ['u64', 'i64', 'ptr', 'u32'], returns: 'i32'},
        SetEndOfFile: {args: ['u64'], returns: 'i32'},
        FlushFileBuffers: {args: ['u64'], returns: 'i32'},
      });
      const expectRefused = (access: number, share: number) => {
        const candidate = k.symbols.CreateFileW(windowsWide(file), access, share, null, 3, 0x80, 0n),
          error = k.symbols.GetLastError();
        if (candidate !== 0n && candidate !== invalid) expect(k.symbols.CloseHandle(candidate)).toBe(1);
        expect(candidate).toBe(invalid);
        expect(error).toBe(32);
      };
      try {
        for (const access of [0xc0000000, 0x00010000]) {
          const foreign = k.symbols.CreateFileW(windowsWide(file), access, 7, null, 3, 0x80, 0n);
          expect(foreign !== 0n && foreign !== invalid).toBe(true);
          try {
            expectRefused(0xc0010000, 1);
          } finally {
            expect(k.symbols.CloseHandle(foreign)).toBe(1);
          }
          expect(native.readFileSync(file, 'utf8')).toBe('old');
        }
        const owned = k.symbols.CreateFileW(windowsWide(file), 0xc0010000, 1, null, 3, 0x80, 0n);
        expect(owned !== 0n && owned !== invalid).toBe(true);
        try {
          for (const access of [0xc0000000, 0x00010000]) {
            expectRefused(access, 7);
          }
          const bytes = new TextEncoder().encode('new'),
            count = new Uint32Array(1);
          expect(k.symbols.WriteFile(owned, bytes, bytes.length, count, null)).toBe(1);
          expect(count[0]).toBe(3);
          expect(k.symbols.SetEndOfFile(owned)).toBe(1);
          expect(k.symbols.FlushFileBuffers(owned)).toBe(1);
          expect(k.symbols.SetFilePointerEx(owned, 0n, null, 0)).toBe(1);
          const read = new Uint8Array(3);
          expect(k.symbols.ReadFile(owned, read, 3, count, null)).toBe(1);
          expect(new TextDecoder().decode(read)).toBe('new');
        } finally {
          expect(k.symbols.CloseHandle(owned)).toBe(1);
        }
        expect(native.readFileSync(file, 'utf8')).toBe('new');
      } finally {
        k.close();
      }
    }),
);

it.skipIf(!windows)(
  'records ordinary-user NTFS file/rename/parent-flush feasibility without claiming conditional replacement or power-loss proof',
  () =>
    fixture(directory => {
      const k = dlopen('kernel32.dll', {
        CreateFileW: {args: ['buffer', 'u32', 'u32', 'ptr', 'u32', 'u32', 'u64'], returns: 'u64'},
        CloseHandle: {args: ['u64'], returns: 'i32'},
        GetLastError: {args: [], returns: 'u32'},
        GetVolumeInformationByHandleW: {
          args: ['u64', 'ptr', 'u32', 'ptr', 'ptr', 'ptr', 'buffer', 'u32'],
          returns: 'i32',
        },
        FlushFileBuffers: {args: ['u64'], returns: 'i32'},
      });
      const n = dlopen('ntdll.dll', {
        NtFlushBuffersFileEx: {args: ['u64', 'u32', 'ptr', 'u32', 'buffer'], returns: 'i32'},
        NtSetInformationFile: {args: ['u64', 'buffer', 'buffer', 'u32', 'u32'], returns: 'i32'},
      });
      const records: {
        access: number;
        opened: boolean;
        win32Error?: number;
        ntStatus?: number;
        ioStatus?: number;
        win32Flush?: number;
        win32FlushError?: number;
        namespace?: {operation: string; status: number}[];
      }[] = [];
      try {
        for (const access of [0x001200a1, 0x001200a3]) {
          const parent = k.symbols.CreateFileW(windowsWide(directory), access, 7, null, 3, 0x02000000 | 0x00200000, 0n);
          if (parent === 0n || parent === invalid) {
            records.push({access, opened: false, win32Error: k.symbols.GetLastError()});
            continue;
          }
          try {
            const name = new Uint16Array(16);
            expect(k.symbols.GetVolumeInformationByHandleW(parent, null, 0, null, null, null, name, name.length)).toBe(
              1,
            );
            expect(EffectString.replace(/\0.*$/u, '')(String.fromCharCode(...name))).toBe('NTFS');
            const guarded = new BigUint64Array(6);
            guarded.fill(0xa5a5a5a5a5a5a5a5n);
            const result = n.symbols.NtFlushBuffersFileEx(parent, 0, null, 0, new Uint8Array(guarded.buffer, 0, 16));
            expect(guarded.subarray(2).every(v => v === 0xa5a5a5a5a5a5a5a5n)).toBe(true);
            const win32Flush = k.symbols.FlushFileBuffers(parent),
              win32FlushError = win32Flush === 0 ? k.symbols.GetLastError() : 0;
            const record = {
              access,
              opened: true,
              ntStatus: result,
              ioStatus: new DataView(guarded.buffer).getInt32(0, true),
              win32Flush,
              win32FlushError,
              namespace: [] as {operation: string; status: number}[],
            };
            records.push(record);
            if (access === 0x001200a3 && result === 0) {
              const temporary = path.join(directory, 'stage.tmp');
              native.writeFileSync(temporary, 'complete private fixture');
              const file = k.symbols.CreateFileW(windowsWide(temporary), 0xc0010000, 1, null, 3, 0x80, 0n);
              expect(file !== 0n && file !== invalid).toBe(true);
              let fileOpen = true;
              const step = (operation: string, status: number) => {
                record.namespace.push({operation, status});
                expect(status).toBe(0);
              };
              try {
                const io = new BigUint64Array(2);
                step('file-flush', n.symbols.NtFlushBuffersFileEx(file, 0, null, 0, io));
                const name = windowsWide('receipt.json'),
                  rename = new Uint8Array(20 + name.byteLength - 2),
                  view = new DataView(rename.buffer);
                view.setBigUint64(8, parent, true);
                view.setUint32(16, name.byteLength - 2, true);
                rename.set(new Uint8Array(name.buffer, 0, name.byteLength - 2), 20);
                step(
                  'root-relative-create-new-rename',
                  n.symbols.NtSetInformationFile(file, io, rename, rename.length, 10),
                );
                step('parent-after-rename', n.symbols.NtFlushBuffersFileEx(parent, 0, null, 0, io));
                expect(native.readFileSync(path.join(directory, 'receipt.json'), 'utf8')).toBe(
                  'complete private fixture',
                );
                step('mark-delete', n.symbols.NtSetInformationFile(file, io, new Uint8Array([1]), 1, 13));
                fileOpen = false;
                expect(k.symbols.CloseHandle(file)).toBe(1);
                step('parent-after-delete', n.symbols.NtFlushBuffersFileEx(parent, 0, null, 0, io));
                expect(native.existsSync(path.join(directory, 'receipt.json'))).toBe(false);
              } finally {
                if (fileOpen) expect(k.symbols.CloseHandle(file)).toBe(1);
              }
            }
          } finally {
            expect(k.symbols.CloseHandle(parent)).toBe(1);
          }
        }
        expect(
          EffectArray.some(
            records,
            record => record.opened && record.access === 0x001200a3 && record.ntStatus === 0 && record.ioStatus === 0,
          ),
        ).toBe(true);
      } finally {
        process.stdout.write(
          JSON.stringify({
            probe: 'ordinary-user-ntfs-directory-flush',
            architecture: process.arch,
            bun: Bun.version,
            os: os.release(),
            records,
          }) + '\n',
        );
        n.close();
        k.close();
      }
    }),
);
