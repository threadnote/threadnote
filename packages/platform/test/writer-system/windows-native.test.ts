import {dlopen, toArrayBuffer, type FFIFunction} from 'bun:ffi';
import {Array as EffectArray, String as EffectString, Schema} from 'effect';
import {expect, it, vi} from 'vitest';
import fc from 'fast-check';
import {
  assertWindowsDaclBytes,
  windowsCreatePrivateAt,
  windowsFileIdentity,
  windowsFileLibrary,
  windowsReadFileSecurity,
  windowsSecurityLibrary,
  type WindowsPrivateCreateResources,
} from '../../src/writer-system/windows-files.js';
import {RuntimeWriterFault} from '../../src/writer-system/fault.js';
import {runtimeAssertPrivateProviderPath, runtimeNativePlatformSupport} from '../../src/system.js';
import {
  windowsAddress,
  windowsSystemLibrary,
  windowsTokenPrincipal,
  windowsWide,
} from '../../src/writer-system/windows-native.js';
import {windowsProviderCommandLine} from '../../src/writer-system/provider-windows.js';

// Observe the actual security record while the production call still owns it; never reopen a substitute.
const securitySample = vi.hoisted(() => ({
  active: undefined as
    | {
        incomplete: boolean;
        getLastError(): number;
        setLastError(code: number): void;
        security(code: number, owner: BigUint64Array, dacl: BigUint64Array, descriptor: BigUint64Array): void;
        length(descriptor: bigint, bytes: number): void;
      }
    | undefined,
}));
// Final native negative control closes its owned HANDLE, then withholds the acknowledgement once.
const privateClose = vi.hoisted(() => ({handle: 0n, calls: 0}));
vi.mock('bun:ffi', async importOriginal => {
  const real = await importOriginal<typeof import('bun:ffi')>();
  return {
    ...real,
    dlopen: <Fns extends Record<string, FFIFunction>>(name: Parameters<typeof real.dlopen>[0], symbols: Fns) => {
      const library = real.dlopen(name, symbols);
      return {
        ...library,
        symbols: new Proxy(library.symbols, {
          get(target, key, receiver) {
            const original: unknown = Reflect.get(target, key, receiver);
            if (key === 'CloseHandle' && typeof original === 'function')
              return (handle: bigint) => {
                const result: unknown = Reflect.apply(original, undefined, [handle]);
                if (handle === privateClose.handle) {
                  privateClose.calls++;
                  return 0;
                }
                return result;
              };
            if (typeof original !== 'function' || (key !== 'GetSecurityInfo' && key !== 'GetSecurityDescriptorLength'))
              return original;
            return (...args: unknown[]) => {
              const result: unknown = Reflect.apply(original, undefined, args);
              const active = securitySample.active;
              if (active && typeof result === 'number') {
                let lastError: number | undefined;
                try {
                  lastError = active.getLastError();
                  if (
                    key === 'GetSecurityInfo' &&
                    args[3] instanceof BigUint64Array &&
                    args[5] instanceof BigUint64Array &&
                    args[7] instanceof BigUint64Array
                  )
                    active.security(result, args[3], args[5], args[7]);
                  if (key === 'GetSecurityDescriptorLength' && typeof args[0] === 'bigint')
                    active.length(args[0], result);
                } catch {
                  active.incomplete = true;
                } finally {
                  try {
                    if (lastError !== undefined) active.setLastError(lastError);
                  } catch {
                    active.incomplete = true;
                  }
                }
              }
              return result;
            };
          },
        }),
      };
    },
  };
});

const native = process.getBuiltinModule('fs'),
  path = process.getBuiltinModule('path'),
  os = process.getBuiltinModule('os');
const windows = process.platform === 'win32';
const invalid = 0xffffffffffffffffn;
const uncertainPrivateResources = new Set<unknown>();
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
function securityRecord(owner: Uint8Array, ace: Uint8Array, rights: number, flags = 0) {
  const size = 8 + 8 + ace.length,
    daclOffset = 20 + owner.length,
    bytes = new Uint8Array(daclOffset + size),
    view = new DataView(bytes.buffer);
  bytes[0] = 1;
  view.setUint16(2, 0x8004, true);
  view.setUint32(4, 20, true);
  view.setUint32(16, daclOffset, true);
  bytes.set(owner, 20);
  bytes[daclOffset] = 2;
  view.setUint16(daclOffset + 2, size, true);
  view.setUint16(daclOffset + 4, 1, true);
  bytes[daclOffset + 9] = flags;
  view.setUint16(daclOffset + 10, 8 + ace.length, true);
  view.setUint32(daclOffset + 12, rights, true);
  bytes.set(ace, daclOffset + 16);
  return {bytes, daclOffset};
}
function descriptor(other: number, rights: number): Uint8Array {
  return securityRecord(sid(1001), sid(other), rights).bytes;
}
type PrincipalClass = 'current' | 'SYSTEM' | 'builtin-admins' | 'trusted-installer' | 'other' | 'unknown';
function boundedSidBytes(bytes: Uint8Array, offset: number, end: number): number {
  if (offset < 0 || offset + 8 > end || end > bytes.length || bytes[offset] !== 1 || bytes[offset + 1] > 15)
    throw new Error('Incomplete observed SID header.');
  const size = 8 + bytes[offset + 1] * 4;
  if (offset + size > end) throw new Error('Incomplete observed SID span.');
  return size;
}
// Metadata only. Unknown layouts remain incomplete and never reach a native SID reader.
function sampleDacl(bytes: Uint8Array, offset: number, classify: (offset: number, size: number) => PrincipalClass) {
  if (bytes.length < 20 || bytes.length > 65536 || bytes[0] !== 1 || offset < 20 || offset + 8 > bytes.length)
    throw new Error('Incomplete observed DACL header.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    control = view.getUint16(2, true),
    revision = bytes[offset],
    size = view.getUint16(offset + 2, true),
    count = view.getUint16(offset + 4, true);
  if (
    (control & 0x8004) !== 0x8004 ||
    view.getUint32(16, true) !== offset ||
    (revision !== 2 && revision !== 4) ||
    bytes[offset + 1] !== 0 ||
    view.getUint16(offset + 6, true) !== 0 ||
    size < 8 ||
    offset + size > bytes.length ||
    count > 128
  )
    throw new Error('Incomplete observed DACL bounds.');
  const aces: {
    kind: 'allow' | 'deny' | 'unsupported';
    kindCode: number;
    flags: number;
    inheritOnly: boolean;
    inherited: boolean;
    rights: number | null;
    dangerousRights: number | null;
    principal: PrincipalClass;
  }[] = [];
  let cursor = offset + 8,
    complete = true;
  for (let index = 0; index < count; index++) {
    if (cursor + 4 > offset + size) throw new Error('Incomplete observed ACE header.');
    const kind = bytes[cursor],
      flags = bytes[cursor + 1],
      aceSize = view.getUint16(cursor + 2, true);
    if (aceSize < 4 || aceSize % 4 !== 0 || cursor + aceSize > offset + size)
      throw new Error('Incomplete observed ACE bounds.');
    let rights: number | null = null,
      principal: PrincipalClass = 'unknown';
    if (kind === 0 || kind === 1) {
      if (aceSize < 16) throw new Error('Incomplete observed ordinary ACE.');
      const sidBytes = boundedSidBytes(bytes, cursor + 8, cursor + aceSize);
      if (aceSize !== 8 + sidBytes) throw new Error('Unsupported observed ACE trailing data.');
      rights = view.getUint32(cursor + 4, true);
      principal = classify(cursor + 8, sidBytes);
      if (principal === 'unknown') complete = false;
    } else complete = false;
    if ((flags & ~0x1f) !== 0) complete = false;
    aces.push({
      kind: kind === 0 ? 'allow' : kind === 1 ? 'deny' : 'unsupported',
      kindCode: kind,
      flags,
      inheritOnly: (flags & 8) !== 0,
      inherited: (flags & 16) !== 0,
      rights,
      dangerousRights: rights === null ? null : (rights & 0x500d0040) >>> 0,
      principal,
    });
    cursor += aceSize;
  }
  return {control, revision, bytes: size, declaredAceCount: count, complete, aces};
}
it('observes bounded ACE metadata without reading truncated or unsupported SID layouts', () => {
  fc.assert(
    fc.property(
      fc.integer({min: 0, max: 1}),
      fc.integer({min: 0, max: 31}),
      fc.integer({min: 0, max: 0xffffffff}),
      fc.integer({min: 0, max: descriptor(1002, 0).length - 1}),
      (kind, flags, rights, cut) => {
        const bytes = descriptor(1002, rights);
        bytes[56] = kind;
        bytes[57] = flags;
        const observed = sampleDacl(bytes, 48, (offset, size) => {
          expect([offset, size]).toEqual([64, 28]);
          return 'other';
        });
        const dangerousBits = [0x40, 0x10000, 0x40000, 0x80000, 0x10000000, 0x40000000];
        expect(observed.complete).toBe(true);
        expect(observed.declaredAceCount).toBe(1);
        expect(observed.aces).toEqual([
          {
            kind: kind === 0 ? 'allow' : 'deny',
            kindCode: kind,
            flags,
            inheritOnly: (flags & 8) !== 0,
            inherited: (flags & 16) !== 0,
            rights,
            dangerousRights: EffectArray.reduce(dangerousBits, 0, (sum, bit) => sum + ((rights & bit) !== 0 ? bit : 0)),
            principal: 'other',
          },
        ]);
        let truncatedReads = 0;
        expect(() =>
          sampleDacl(bytes.subarray(0, cut), 48, () => {
            truncatedReads++;
            return 'unknown';
          }),
        ).toThrow();
        expect(truncatedReads).toBe(0);
      },
    ),
    {numRuns: 30},
  );
  const unknown = descriptor(1002, 1);
  unknown[56] = 2;
  expect(
    sampleDacl(unknown, 48, () => {
      throw new Error('Unsupported ACE reached a SID reader.');
    }).complete,
  ).toBe(false);
  unknown[56] = 0;
  unknown[57] = 0x20;
  expect(sampleDacl(unknown, 48, () => 'other').complete).toBe(false);
  unknown[57] = 0;
  expect(sampleDacl(unknown, 48, () => 'unknown').complete).toBe(false);
});
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
it('recognizes only the resolved servicing ancestor owner while preserving every ACE and final-owner rule', () => {
  const principal = 'S-1-5-21-11-22-33-1001',
    // Synthetic pure-decoder input, not a claim to resolve a real service or qualify a Windows host.
    servicingOwner = 'S-1-5-80-11-22-33-44-55',
    service = new Uint8Array(32),
    view = new DataView(service.buffer);
  service[0] = 1;
  service[1] = 6;
  service[7] = 5;
  for (const [index, value] of [80, 11, 22, 33, 44, 55].entries()) view.setUint32(8 + index * 4, value, true);
  const safe = securityRecord(service, sid(1001), 0x1f01ff);
  expect(() => assertWindowsDaclBytes(safe.bytes, 20, safe.daclOffset, principal, false, servicingOwner)).not.toThrow();
  expect(() => assertWindowsDaclBytes(safe.bytes, 20, safe.daclOffset, principal, false)).toThrow();
  expect(() =>
    assertWindowsDaclBytes(safe.bytes, 20, safe.daclOffset, principal, false, 'S-1-5-80-11-22-33-44-56'),
  ).toThrow();
  expect(() => assertWindowsDaclBytes(safe.bytes, 20, safe.daclOffset, principal, true, servicingOwner)).toThrow();
  const serviceGrant = securityRecord(service, service, 0x1f01ff),
    privateServiceGrant = securityRecord(sid(1001), service, 0x1f01ff);
  expect(() =>
    assertWindowsDaclBytes(serviceGrant.bytes, 20, serviceGrant.daclOffset, principal, false, servicingOwner),
  ).toThrow();
  expect(() =>
    assertWindowsDaclBytes(
      privateServiceGrant.bytes,
      20,
      privateServiceGrant.daclOffset,
      principal,
      true,
      servicingOwner,
    ),
  ).toThrow();
  fc.assert(
    fc.property(
      fc.integer({min: 1002, max: 100000}),
      fc.constantFrom(0x40, 0x10000, 0x40000, 0x80000, 0x10000000, 0x40000000),
      fc.boolean(),
      (other, dangerousRight, inheritOnly) => {
        const record = securityRecord(service, sid(other), dangerousRight, inheritOnly ? 8 : 0),
          checkAncestor = () =>
            assertWindowsDaclBytes(record.bytes, 20, record.daclOffset, principal, false, servicingOwner);
        if (inheritOnly) expect(checkAncestor).not.toThrow();
        else expect(checkAncestor).toThrow();
        expect(() =>
          assertWindowsDaclBytes(record.bytes, 20, record.daclOffset, principal, true, servicingOwner),
        ).toThrow();
        const unknownOwner = securityRecord(sid(other), sid(1001), 0x1f01ff);
        expect(() =>
          assertWindowsDaclBytes(unknownOwner.bytes, 20, unknownOwner.daclOffset, principal, false, servicingOwner),
        ).toThrow();
      },
    ),
    {numRuns: 30},
  );
  const unknownAce = securityRecord(service, sid(1001), 0x1f01ff);
  unknownAce.bytes[unknownAce.daclOffset + 8] = 9;
  expect(() =>
    assertWindowsDaclBytes(unknownAce.bytes, 20, unknownAce.daclOffset, principal, false, servicingOwner),
  ).toThrow();
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
    expect(/^S-1-[0-9]+(?:-[0-9]+)+$/u.test(principal.sid)).toBe(true);
    const security = windowsSystemLibrary('advapi32.dll', {
      ConvertStringSidToSidW: {args: ['buffer', 'buffer'], returns: 'i32'},
      EqualSid: {args: ['u64', 'u64'], returns: 'i32'},
      IsValidSid: {args: ['u64'], returns: 'i32'},
      GetLengthSid: {args: ['u64'], returns: 'u32'},
      OpenProcessToken: {args: ['u64', 'u32', 'buffer'], returns: 'i32'},
      GetTokenInformation: {args: ['u64', 'u32', 'buffer', 'u32', 'buffer'], returns: 'i32'},
      LookupAccountNameW: {
        args: ['buffer', 'buffer', 'buffer', 'buffer', 'buffer', 'buffer', 'buffer'],
        returns: 'i32',
      },
      ConvertStringSecurityDescriptorToSecurityDescriptorW: {args: ['buffer', 'u32', 'buffer', 'ptr'], returns: 'i32'},
    });
    const setup = dlopen('kernel32.dll', {
      GetCurrentProcess: {args: [], returns: 'u64'},
      GetComputerNameW: {args: ['buffer', 'buffer'], returns: 'i32'},
      GetLastError: {args: [], returns: 'u32'},
      SetLastError: {args: ['u32'], returns: 'void'},
      CloseHandle: {args: ['u64'], returns: 'i32'},
      LocalFree: {args: ['u64'], returns: 'u64'},
      CreateDirectoryW: {args: ['buffer', 'buffer'], returns: 'i32'},
      CreateFileW: {args: ['buffer', 'u32', 'u32', 'buffer', 'u32', 'u32', 'u64'], returns: 'u64'},
    });
    const sids = [new BigUint64Array(1), new BigUint64Array(1), new BigUint64Array(1)];
    let token = 0n,
      privateDirectory: string | undefined,
      privateDirectoryCreated = false;
    const prior = securitySample.active;
    try {
      for (const [index, value] of [principal.sid, 'S-1-5-18', 'S-1-5-32-544'].entries())
        expect(security.symbols.ConvertStringSidToSidW(windowsWide(value), sids[index])).toBe(1);
      const tokenOut = new BigUint64Array(1);
      expect(security.symbols.OpenProcessToken(setup.symbols.GetCurrentProcess(), 8, tokenOut)).toBe(1);
      token = tokenOut[0];
      // TOKEN_OWNER contains an absolute SID pointer. Materialize and retain every backing/view before native writes.
      const ownerBuffer = new ArrayBuffer(1024 + 32),
        owner = new Uint8Array(ownerBuffer),
        ownerView = new DataView(ownerBuffer),
        ownerCanary = owner.subarray(1024),
        ownerLength = new Uint32Array(1),
        ownerStart = windowsAddress(owner);
      owner.fill(0xa5);
      expect(security.symbols.GetTokenInformation(token, 4, owner, 1024, ownerLength)).toBe(1);
      if (ownerLength[0] < 16 || ownerLength[0] > 1024 || !ownerCanary.every(value => value === 0xa5))
        throw new Error('Native token owner record is incomplete.');
      const ownerSid = ownerView.getBigUint64(0, true),
        ownerEnd = ownerStart + BigInt(ownerLength[0]);
      if (ownerSid < ownerStart + 8n || ownerSid + 8n > ownerEnd)
        throw new Error('Native token owner SID is outside its retained record.');
      const ownerOffset = Number(ownerSid - ownerStart),
        ownerSidBytes = 8 + owner[ownerOffset + 1] * 4;
      if (owner[ownerOffset] !== 1 || owner[ownerOffset + 1] > 15 || ownerSid + BigInt(ownerSidBytes) > ownerEnd)
        throw new Error('Native token owner SID span is incomplete.');
      if (security.symbols.IsValidSid(ownerSid) === 0 || security.symbols.GetLengthSid(ownerSid) !== ownerSidBytes)
        throw new Error('Native token owner SID validity is unproved.');
      const defaultOwnerIsUser = security.symbols.EqualSid(ownerSid, sids[0][0]) !== 0;
      // Resolve only the fixed service on this actual computer; this observation grants no storage authority.
      const computer = new Uint16Array(256),
        computerLength = new Uint32Array([computer.length]),
        serviceStorage = new ArrayBuffer(68 + 32),
        serviceSid = new Uint8Array(serviceStorage, 0, 68),
        serviceCanary = new Uint8Array(serviceStorage, 68),
        serviceSidLength = new Uint32Array([serviceSid.length]),
        serviceDomain = new Uint16Array(256),
        serviceDomainLength = new Uint32Array([serviceDomain.length]),
        serviceKind = new Uint32Array(1),
        serviceAddress = windowsAddress(serviceSid);
      serviceCanary.fill(0xa5);
      let serviceResolved = false,
        serviceLookupCode = 0;
      let serviceValidationStage:
        'computer' | 'lookup' | 'canary' | 'header' | 'bounds' | 'native-validity' | 'native-length' | 'resolved' =
        'computer';
      if (setup.symbols.GetComputerNameW(computer, computerLength) === 0)
        serviceLookupCode = setup.symbols.GetLastError();
      else if (computerLength[0] > 0 && computerLength[0] < computer.length && computer[computerLength[0]] === 0) {
        serviceValidationStage = 'lookup';
        if (
          security.symbols.LookupAccountNameW(
            computer,
            windowsWide('NT SERVICE\\TrustedInstaller'),
            serviceSid,
            serviceSidLength,
            serviceDomain,
            serviceDomainLength,
            serviceKind,
          ) === 0
        )
          serviceLookupCode = setup.symbols.GetLastError();
        else {
          // cbSid is input capacity; only insufficient-buffer failure promises a required output size.
          // Authenticate the actual SID span from the retained header before either native SID reader.
          serviceValidationStage = 'canary';
          if (serviceCanary.every(value => value === 0xa5)) {
            serviceValidationStage = 'header';
            if (serviceSid[0] === 1 && serviceSid[1] <= 15) {
              const sidBytes = 8 + serviceSid[1] * 4;
              serviceValidationStage = 'bounds';
              if (sidBytes <= serviceSid.length) {
                serviceValidationStage = 'native-validity';
                if (security.symbols.IsValidSid(serviceAddress) !== 0) {
                  serviceValidationStage = 'native-length';
                  if (security.symbols.GetLengthSid(serviceAddress) === sidBytes) {
                    serviceResolved = true;
                    serviceValidationStage = 'resolved';
                  }
                }
              }
            }
          }
        }
      }
      type Sample = {
        edge: number;
        role: 'root' | 'ancestor' | 'final';
        owner: PrincipalClass;
        privateObject: boolean;
        nativeStage: 'security' | 'descriptor';
        nativeCode: number;
        privateAccepted?: boolean;
        dacl?: ReturnType<typeof sampleDacl>;
      };
      const inspect = (value: string, kind: 'file' | 'directory') => {
        const samples: Sample[] = [],
          expectedEdges = EffectString.split(EffectString.slice(3)(value), '\\').length + 1;
        let record: {owner: bigint; dacl: bigint; descriptor: bigint} | undefined;
        const observation: NonNullable<typeof securitySample.active> = {
          incomplete: false,
          getLastError: setup.symbols.GetLastError,
          setLastError: setup.symbols.SetLastError,
          security(code, owner, dacl, descriptor) {
            if (samples.length >= 64) {
              observation.incomplete = true;
              record = undefined;
              return;
            }
            const edge = samples.length;
            samples.push({
              edge,
              role: edge === 0 ? 'root' : edge === expectedEdges - 1 ? 'final' : 'ancestor',
              owner: 'unknown',
              privateObject: edge === expectedEdges - 1,
              nativeStage: 'security',
              nativeCode: code,
            });
            record = code === 0 ? {owner: owner[0], dacl: dacl[0], descriptor: descriptor[0]} : undefined;
          },
          length(descriptor, length) {
            if (
              !record ||
              descriptor !== record.descriptor ||
              length < 20 ||
              length > 65536 ||
              record.owner < descriptor ||
              record.owner + 8n > descriptor + BigInt(length) ||
              record.dacl < descriptor ||
              record.dacl + 8n > descriptor + BigInt(length)
            ) {
              observation.incomplete = true;
              return;
            }
            const sample = samples[samples.length - 1];
            sample.nativeStage = 'descriptor';
            const bytes = new Uint8Array(toArrayBuffer(descriptor, 0, length)).slice();
            const classify = (offset: number, size: number): PrincipalClass => {
              const address = descriptor + BigInt(offset);
              if (security.symbols.IsValidSid(address) === 0 || security.symbols.GetLengthSid(address) !== size)
                throw new Error('Observed native SID validity is unproved.');
              return security.symbols.EqualSid(address, sids[0][0]) !== 0
                ? 'current'
                : security.symbols.EqualSid(address, sids[1][0]) !== 0
                  ? 'SYSTEM'
                  : security.symbols.EqualSid(address, sids[2][0]) !== 0
                    ? 'builtin-admins'
                    : serviceResolved && security.symbols.EqualSid(address, serviceAddress) !== 0
                      ? 'trusted-installer'
                      : 'other';
            };
            const ownerOffset = Number(record.owner - descriptor);
            sample.owner = classify(ownerOffset, boundedSidBytes(bytes, ownerOffset, bytes.length));
            sample.dacl = sampleDacl(bytes, Number(record.dacl - descriptor), classify);
            if (!sample.dacl.complete) observation.incomplete = true;
            try {
              assertWindowsDaclBytes(
                bytes,
                Number(record.owner - descriptor),
                Number(record.dacl - descriptor),
                principal.sid,
                true,
              );
              sample.privateAccepted = true;
            } catch (error) {
              if (Schema.is(RuntimeWriterFault)(error) && error.reason === 'private-storage')
                sample.privateAccepted = false;
              else observation.incomplete = true;
            }
          },
        };
        securitySample.active = observation;
        let outcome: {samples: Sample[]; failed: false} | {samples: Sample[]; failed: true; error: unknown};
        try {
          runtimeAssertPrivateProviderPath(value, {kind});
          outcome = {samples, failed: false};
        } catch (error) {
          outcome = {samples, failed: true, error};
        } finally {
          securitySample.active = prior;
        }
        // The real operation has finalized every native descriptor before secondary observation can fail the test.
        if (outcome.failed || observation.incomplete)
          process.stdout.write(
            'WINDOWS_PRIVATE_SAMPLE ' +
              JSON.stringify({
                defaultOwnerIsUser,
                serviceResolved,
                serviceLookupCode,
                serviceValidationStage,
                incomplete: observation.incomplete,
                samples,
              }) +
              String.fromCharCode(10),
          );
        if (observation.incomplete) {
          if (outcome.failed) throw outcome.error;
          throw new Error('Native security observation is incomplete.');
        }
        return outcome;
      };
      let ownedDirectory = directory,
        file = path.join(directory, 'identity.txt');
      native.writeFileSync(file, 'owned fixture');
      const initialDirectory = inspect(directory, 'directory');
      const initial = initialDirectory.failed ? initialDirectory : inspect(file, 'file');
      if (initial.failed) {
        const final = initial.samples.at(-1);
        if (!final?.privateObject || final.nativeStage !== 'descriptor' || final.privateAccepted !== false)
          throw initial.error;
        // Repair only this owned fixture's proven final-object premise; ancestors and production policy stay unchanged.
        privateDirectory = directory + '-explicit-private';
        const sd = new BigUint64Array(1);
        expect(
          security.symbols.ConvertStringSecurityDescriptorToSecurityDescriptorW(
            windowsWide(`O:${principal.sid}D:P(A;OICI;FA;;;${principal.sid})`),
            1,
            sd,
            null,
          ),
        ).toBe(1);
        try {
          const attributes = new BigUint64Array(3);
          new DataView(attributes.buffer).setUint32(0, 24, true);
          attributes[1] = sd[0];
          expect(setup.symbols.CreateDirectoryW(windowsWide(privateDirectory), attributes)).toBe(1);
          privateDirectoryCreated = true;
          ownedDirectory = native.realpathSync(privateDirectory);
          file = path.join(ownedDirectory, 'identity.txt');
          const created = setup.symbols.CreateFileW(windowsWide(file), 0x40000000, 0, attributes, 1, 0x80, 0n);
          expect(created !== 0n && created !== invalid).toBe(true);
          expect(setup.symbols.CloseHandle(created)).toBe(1);
        } finally {
          if (sd[0] !== 0n) setup.symbols.LocalFree(sd[0]);
        }
        native.writeFileSync(file, 'owned fixture');
      }
      const directoryProof = inspect(ownedDirectory, 'directory');
      if (directoryProof.failed) throw directoryProof.error;
      const fileProof = inspect(file, 'file');
      if (fileProof.failed) throw fileProof.error;
      expect(directoryProof.samples.at(-1)?.owner).toBe('current');
      expect(fileProof.samples.at(-1)?.owner).toBe('current');
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
        runtimeAssertPrivateProviderPath(ownedDirectory, {kind: 'directory'});
        runtimeAssertPrivateProviderPath(file, {kind: 'file'});
        native.linkSync(file, path.join(ownedDirectory, 'alias.txt'));
        expect(() => runtimeAssertPrivateProviderPath(file, {kind: 'file'})).toThrow();
      } finally {
        expect(k.symbols.CloseHandle(handle)).toBe(1);
        k.close();
      }
    } finally {
      securitySample.active = prior;
      if (token !== 0n) setup.symbols.CloseHandle(token);
      for (const sid of sids) if (sid[0] !== 0n) setup.symbols.LocalFree(sid[0]);
      security.close();
      setup.close();
      if (privateDirectoryCreated && privateDirectory) native.rmSync(privateDirectory, {recursive: true, force: true});
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

it.skipIf(!windows)(
  'atomically creates protected private children and retains an exclusive delete-on-close lease without replacing occupied names',
  () =>
    fixture(directory => {
      const k = windowsFileLibrary(),
        security = windowsSecurityLibrary(),
        releases = new Set<() => void>();
      let unknown = false;
      const retained = new Set<readonly ArrayBufferView[]>();
      const resources: WindowsPrivateCreateResources = {
        kernel: k,
        security,
        captureNative(release) {
          const close = () => {
            if (unknown) throw RuntimeWriterFault.make({reason: 'io'});
            if (!releases.has(close)) return;
            if (!release()) throw RuntimeWriterFault.make({reason: 'io'});
            releases.delete(close);
          };
          releases.add(close);
          return close;
        },
        ownDescriptor: descriptor => resources.captureNative(() => k.symbols.LocalFree(descriptor) === 0n),
        uncertain(backing) {
          unknown = true;
          retained.add(backing);
          uncertainPrivateResources.add({resources, releases, retained});
          throw RuntimeWriterFault.make({reason: 'io'});
        },
      };
      const principal = windowsTokenPrincipal().sid;
      const parent = k.symbols.CreateFileW(windowsWide(directory), 0x001201a3, 7, null, 3, 0x02200000, 0n);
      expect(parent !== 0n && parent !== invalid).toBe(true);
      try {
        const initial = windowsFileIdentity(k, parent);
        const assertParent = () => {
          const current = windowsFileIdentity(k, parent);
          expect(current.fileId).toBe(initial.fileId);
          expect(current.volumeId).toBe(initial.volumeId);
          expect(current.birthtime).toBe(initial.birthtime);
          // Authenticate the actual owned fixture name and ACL; its namespace epochs may advance after our creates.
          expect(native.lstatSync(directory, {bigint: true}).ino).toBe(current.ino);
          windowsReadFileSecurity(parent, principal, false, undefined);
        };
        const writeAndRead = (handle: bigint, text: string) => {
          const bytes = new TextEncoder().encode(text),
            count = new Uint32Array(1),
            read = new Uint8Array(bytes.length);
          expect(k.symbols.WriteFile(handle, bytes, bytes.length, count, null)).toBe(1);
          expect(count[0]).toBe(bytes.length);
          expect(k.symbols.FlushFileBuffers(handle)).toBe(1);
          expect(k.symbols.SetFilePointerEx(handle, 0n, new BigUint64Array(1), 0)).toBe(1);
          expect(k.symbols.ReadFile(handle, read, read.length, count, null)).toBe(1);
          expect(count[0]).toBe(bytes.length);
          expect(read).toEqual(bytes);
        };
        assertParent(); // Basic real native setup precedes the first protected create.
        const owned = windowsCreatePrivateAt(parent, 'private', 'directory', resources, assertParent);
        const directoryIdentity = owned.identity;
        const assertPrivate = () => {
          assertParent();
          const current = windowsFileIdentity(k, owned.handle);
          expect(current.fileId).toBe(directoryIdentity.fileId);
          expect(current.volumeId).toBe(directoryIdentity.volumeId);
          expect(current.birthtime).toBe(directoryIdentity.birthtime);
          expect(native.lstatSync(path.join(directory, 'private'), {bigint: true}).ino).toBe(current.ino);
          windowsReadFileSecurity(owned.handle, principal, true, undefined);
        };
        const assertProtected = (bytes: Uint8Array) => {
          const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
            dacl = view.getUint32(16, true);
          expect((view.getUint16(2, true) & 0x1000) !== 0).toBe(true);
          expect(view.getUint16(dacl + 4, true)).toBe(1);
          expect(bytes[dacl + 8]).toBe(0);
          expect(bytes[dacl + 9]).toBe(0);
          expect(view.getUint32(dacl + 12, true)).toBe(0x1f01ff);
        };
        expect(owned.security.owner).toBe(principal);
        assertProtected(owned.security.bytes);
        const lease = windowsCreatePrivateAt(owned.handle, 'lease', 'lease', resources, assertPrivate);
        assertProtected(lease.security.bytes);
        writeAndRead(lease.handle, 'first lease token');
        // A real second acquisition and independent native open cannot obtain the retained lease.
        expect(() => windowsCreatePrivateAt(owned.handle, 'lease', 'lease', resources, assertPrivate)).toThrow();
        const contender = k.symbols.CreateFileW(
          windowsWide(path.join(directory, 'private', 'lease')),
          0x80000000,
          7,
          null,
          3,
          0x00200000,
          0n,
        );
        const contenderError = k.symbols.GetLastError();
        if (contender !== 0n && contender !== invalid) k.symbols.CloseHandle(contender);
        expect(contender).toBe(invalid);
        expect([32, 5, 303]).toContain(contenderError); // sharing violation or delete-pending mapping; never success.
        expect(windowsFileIdentity(k, lease.handle).fileId).toBe(lease.identity.fileId);
        lease.close();
        lease.close(); // A known successful release is idempotent.
        expect(native.existsSync(path.join(directory, 'private', 'lease'))).toBe(false);
        const successor = windowsCreatePrivateAt(owned.handle, 'lease', 'lease', resources, assertPrivate);
        writeAndRead(successor.handle, 'successor token');
        successor.close();
        const receipt = windowsCreatePrivateAt(owned.handle, 'receipt', 'file', resources, assertPrivate);
        writeAndRead(receipt.handle, 'complete immutable receipt');
        assertProtected(receipt.security.bytes);
        receipt.close();
        const occupied = path.join(directory, 'private', 'occupied');
        native.writeFileSync(occupied, 'independently authored bytes');
        const before = native.lstatSync(occupied, {bigint: true});
        expect(() => windowsCreatePrivateAt(owned.handle, 'occupied', 'file', resources, assertPrivate)).toThrow();
        expect(native.lstatSync(occupied, {bigint: true})).toEqual(before);
        expect(native.readFileSync(occupied, 'utf8')).toBe('independently authored bytes');
        const failedClose = windowsCreatePrivateAt(owned.handle, 'last-lease', 'lease', resources, assertPrivate);
        owned.close();
        // This is the final operation on this ledger: lost close acknowledgement is sticky UNKNOWN, no retry/delete.
        privateClose.handle = failedClose.handle;
        privateClose.calls = 0;
        expect(() => failedClose.close()).toThrow(RuntimeWriterFault);
        expect(unknown).toBe(true);
        expect(() => failedClose.close()).toThrow(RuntimeWriterFault);
        expect(privateClose.calls).toBe(1);
        expect(retained.size).toBeGreaterThan(0);
        expect(runtimeNativePlatformSupport().writer).toBe(false);
      } finally {
        privateClose.handle = 0n;
        if (!unknown) for (const close of EffectArray.reverse(Array.from(releases))) close();
        expect(k.symbols.CloseHandle(parent)).toBe(1);
        if (!unknown) {
          security.close();
          k.close();
        }
      }
    }),
);
