import {Array as EffectArray, String as EffectString, Option} from 'effect';
import {dlopen, ptr, read} from 'bun:ffi';
import {writerFail as fail} from './fault.js';
import type {RuntimeWriterIdentity} from '../writer_system.js';

const fs = process.getBuiltinModule('fs');
export interface RuntimeStableOsUserIdentity {
  readonly platform: 'darwin' | 'linux';
  readonly architecture: 'arm64' | 'x64';
  readonly userId: number;
  readonly accountHome: string;
}

export function requirePosixWriterPlatform(): void {
  if (
    (process.platform !== 'darwin' && process.platform !== 'linux') ||
    (process.arch !== 'arm64' && process.arch !== 'x64')
  )
    fail('unsupported-platform');
}

/** Read the running ELF interpreter, never a caller environment flag or an installed-libc guess. */
export function linuxRuntimeLibc(): {readonly kind: 'glibc' | 'musl'; readonly library: string} {
  if (process.platform !== 'linux') return fail('unsupported-platform');
  const fd = fs.openSync('/proc/self/exe', fs.constants.O_RDONLY);
  const readAt = (length: number, offset: number) => {
    const bytes = new Uint8Array(length);
    if (fs.readSync(fd, bytes, 0, length, offset) !== length) fail('unsupported-platform');
    return bytes;
  };
  try {
    const header = readAt(64, 0),
      h = new DataView(header.buffer);
    const machine = process.arch === 'x64' ? 62 : process.arch === 'arm64' ? 183 : -1;
    if (
      h.getUint32(0, true) !== 0x464c457f ||
      header[4] !== 2 ||
      header[5] !== 1 ||
      h.getUint16(18, true) !== machine ||
      h.getUint16(54, true) !== 56
    )
      fail('unsupported-platform');
    const offset = h.getBigUint64(32, true),
      count = h.getUint16(56, true);
    if (offset > 1_048_576n || count < 1 || count > 256) fail('unsupported-platform');
    const table = readAt(count * 56, Number(offset)),
      v = new DataView(table.buffer);
    let interpreter: string | undefined;
    for (let i = 0; i < count; i++)
      if (v.getUint32(i * 56, true) === 3) {
        if (interpreter !== undefined) fail('unsupported-platform');
        const at = v.getBigUint64(i * 56 + 8, true),
          size = v.getBigUint64(i * 56 + 32, true);
        if (at > 1_048_576n || size < 2n || size > 4096n) fail('unsupported-platform');
        const bytes = readAt(Number(size), Number(at));
        if (bytes[bytes.length - 1] !== 0 || bytes.subarray(0, -1).includes(0)) fail('unsupported-platform');
        interpreter = new TextDecoder('utf-8', {fatal: true}).decode(bytes.subarray(0, -1));
      }
    const arch = process.arch === 'x64' ? 'x86_64' : 'aarch64';
    if (interpreter === `/lib/ld-musl-${arch}.so.1`) return {kind: 'musl', library: interpreter};
    if (interpreter === (process.arch === 'x64' ? '/lib64/ld-linux-x86-64.so.2' : '/lib/ld-linux-aarch64.so.1'))
      return {kind: 'glibc', library: 'libc.so.6'};
    return fail('unsupported-platform');
  } finally {
    fs.closeSync(fd);
  }
}

function libcPath(): string {
  requirePosixWriterPlatform();
  return process.platform === 'darwin' ? '/usr/lib/libSystem.B.dylib' : linuxRuntimeLibc().library;
}

/** LP64 pwd.h layouts are independently specified by Darwin, glibc and musl; no userInfo/HOME fallback. */
export function readPosixAccountIdentity(): RuntimeStableOsUserIdentity {
  requirePosixWriterPlatform();
  const lib = dlopen(libcPath(), {
    getuid: {args: [], returns: 'u32'},
    geteuid: {args: [], returns: 'u32'},
    getpwuid_r: {args: ['u32', 'buffer', 'buffer', 'u64', 'buffer'], returns: 'i32'},
  });
  try {
    const userId = lib.symbols.geteuid();
    if (userId !== lib.symbols.getuid() || userId !== process.getuid?.()) fail('identity');
    const size = process.platform === 'darwin' ? 72 : 48;
    const homeOffset = process.platform === 'darwin' ? 48 : 32;
    const storage = new BigUint64Array(32),
      structure = new Uint8Array(storage.buffer);
    structure.fill(0xa5);
    structure.fill(0, 0, size);
    const scratch = new Uint8Array(65_536 + 32);
    scratch.fill(0xa5);
    scratch.fill(0, 0, 65_536);
    const result = new BigUint64Array(1),
      record = structure.subarray(0, size),
      buffer = scratch.subarray(0, 65_536);
    const status = lib.symbols.getpwuid_r(userId, record, buffer, 65_536n, result);
    const recordAddress = ptr(record),
      bufferAddress = ptr(buffer);
    if (
      status !== 0 ||
      !Number.isSafeInteger(recordAddress) ||
      !Number.isSafeInteger(bufferAddress) ||
      result[0] !== BigInt(recordAddress) ||
      !structure.subarray(size).every(v => v === 0xa5) ||
      !scratch.subarray(65_536).every(v => v === 0xa5)
    )
      fail('identity');
    const view = new DataView(storage.buffer);
    if (view.getUint32(16, true) !== userId) fail('identity');
    const offset = view.getBigUint64(homeOffset, true) - BigInt(bufferAddress);
    if (offset < 0n || offset >= 65_536n) fail('identity');
    const start = Number(offset),
      end = buffer.indexOf(0, start);
    if (end <= start) fail('identity');
    const accountHome = new TextDecoder('utf-8', {fatal: true}).decode(buffer.subarray(start, end));
    if (!/^\//u.test(accountHome) || /[\p{Cc}]/u.test(accountHome)) fail('identity');
    const platform = process.platform,
      architecture = process.arch;
    if ((platform !== 'darwin' && platform !== 'linux') || (architecture !== 'arm64' && architecture !== 'x64'))
      return fail('unsupported-platform');
    return {
      platform,
      architecture,
      userId,
      accountHome,
    };
  } catch {
    return fail('identity');
  } finally {
    lib.close();
  }
}

export function posixWriterLibrary() {
  const path = libcPath();
  const common = {
    mkdirat: {args: ['i32', 'buffer', 'u32'], returns: 'i32'},
    renameat: {args: ['i32', 'buffer', 'i32', 'buffer'], returns: 'i32'},
    unlinkat: {args: ['i32', 'buffer', 'i32'], returns: 'i32'},
  } as const;
  // Darwin's openat is variadic. Its fixed syscall wrapper is needed on arm64.
  if (process.platform === 'darwin') {
    const lib = dlopen(path, {
      ...common,
      __openat: {args: ['i32', 'buffer', 'i32', 'u32'], returns: 'i32'},
      __fcntl: {args: ['i32', 'i32', 'i64'], returns: 'i32'},
    });
    return {
      symbols: {...lib.symbols, fcntl: (fd: number, command: number) => lib.symbols.__fcntl(fd, command, 0n)},
      close: () => lib.close(),
    };
  }
  const lib = dlopen(path, {
    ...common,
    openat: {args: ['i32', 'buffer', 'i32', 'u32'], returns: 'i32'},
    fcntl: {args: ['i32', 'i32', 'i64'], returns: 'i32'},
  });
  return {
    symbols: {
      ...lib.symbols,
      __openat: lib.symbols.openat,
      fcntl: (fd: number, command: number) => lib.symbols.fcntl(fd, command, 0n),
    },
    close: () => lib.close(),
  };
}

export const posixDirectoryFlags =
  fs.constants.O_RDONLY |
  fs.constants.O_DIRECTORY |
  fs.constants.O_NOFOLLOW |
  (process.platform === 'darwin' ? 0x01000000 : 0x00080000);
export const posixFileFlags =
  fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK | (process.platform === 'darwin' ? 0x01000000 : 0x00080000);

/** Descriptor-bound complete ACL proof. Unknown records, remote filesystems and unsupported xattrs refuse. */
export function assertPosixPrivateAcl(fd: number, privateObject: boolean, before: RuntimeWriterIdentity): void {
  requirePosixWriterPlatform();
  if (process.platform === 'linux') {
    assertLinuxPrivateAcl(fd);
    return;
  }
  const lib = dlopen(libcPath(), {
    __fstat64_extended: {args: ['i32', 'buffer', 'buffer', 'buffer'], returns: 'i32'},
    fpathconf: {args: ['i32', 'i32'], returns: 'i64'},
    // Explicit inode64 entry avoids x86_64's legacy fstatfs layout.
    fstatfs64: {args: ['i32', 'buffer'], returns: 'i32'},
  });
  try {
    if (lib.symbols.fpathconf(fd, 13) !== 1n || lib.symbols.fpathconf(fd, 14) !== 0n) fail('private-storage');
    const volume = new Uint8Array(2168 + 32);
    volume.fill(0xa5);
    if (lib.symbols.fstatfs64(fd, volume.subarray(0, 2168)) !== 0 || !volume.subarray(2168).every(v => v === 0xa5))
      fail('private-storage');
    const flags = new DataView(volume.buffer).getUint32(64, true);
    if ((flags & 0x00200000) !== 0 || (flags & 0x00001000) === 0) fail('private-storage');
    const metadata = new Uint8Array(144 + 32);
    metadata.fill(0xa5);
    const maximum = 44 + 24 * 128,
      security = new Uint8Array(maximum + 32);
    security.fill(0xa5);
    const length = new BigUint64Array([BigInt(maximum), 0xa5a5a5a5a5a5a5a5n]);
    if (
      lib.symbols.__fstat64_extended(
        fd,
        metadata.subarray(0, 144),
        security.subarray(0, maximum),
        new Uint8Array(length.buffer, 0, 8),
      ) !== 0 ||
      !metadata.subarray(144).every(v => v === 0xa5) ||
      !security.subarray(maximum).every(v => v === 0xa5) ||
      length[1] !== 0xa5a5a5a5a5a5a5a5n ||
      length[0] < 44n ||
      length[0] > BigInt(maximum)
    )
      fail('private-storage');
    const observed = new DataView(metadata.buffer);
    if (
      BigInt(observed.getInt32(0, true)) !== before.dev ||
      observed.getBigUint64(8, true) !== before.ino ||
      BigInt(observed.getUint16(4, true)) !== before.mode ||
      BigInt(observed.getUint32(16, true)) !== before.uid ||
      BigInt(observed.getUint32(20, true)) !== before.gid
    )
      fail('private-storage');
    const acl = new DataView(security.buffer),
      count = acl.getUint32(36, true);
    if (
      acl.getUint32(0, true) !== 0x012cc16d ||
      (acl.getUint32(40, true) & ~0x00020000) !== 0 ||
      (count !== 0xffffffff && count > 128) ||
      Number(length[0]) !== 44 + (count === 0xffffffff ? 0 : count * 24)
    )
      fail('private-storage');
    if (count !== 0xffffffff)
      for (let i = 0; i < count; i++) {
        const aceFlags = acl.getUint32(44 + i * 24 + 16, true),
          rights = acl.getUint32(44 + i * 24 + 20, true),
          kind = aceFlags & 0xf;
        if ((kind !== 1 && kind !== 2) || (aceFlags & ~0x1ff) !== 0 || (rights & ~0x00103ffe) !== 0)
          fail('private-storage');
        if (kind === 1 && (privateObject || (rights & 0x3574) !== 0 || (aceFlags & 0x1e0) !== 0))
          fail('private-storage');
      }
  } catch {
    fail('private-storage');
  } finally {
    lib.close();
  }
}

function assertLinuxPrivateAcl(fd: number): void {
  const lib = dlopen(libcPath(), {
    fstatfs: {args: ['i32', 'buffer'], returns: 'i32'},
    fgetxattr: {args: ['i32', 'buffer', 'buffer', 'u64'], returns: 'i64'},
    __errno_location: {args: [], returns: 'ptr'},
  });
  try {
    // Linux LP64 glibc/musl statfs: 120 bytes, type0/flags80. Node owns all stat inode layouts.
    const storage = new BigUint64Array(19),
      bytes = new Uint8Array(storage.buffer);
    bytes.fill(0xa5);
    if (lib.symbols.fstatfs(fd, bytes.subarray(0, 120)) !== 0 || !bytes.subarray(120).every(v => v === 0xa5))
      fail('private-storage');
    const view = new DataView(storage.buffer),
      type = view.getBigUint64(0, true),
      flags = view.getBigUint64(80, true);
    // An explicit local-filesystem allowlist; FUSE, network, overlay, unknown and readonly mounts refuse.
    if (![0xef53n, 0x58465342n, 0x9123683en, 0x01021994n].includes(type) || (flags & 1n) !== 0n)
      fail('private-storage');
    const errnoAddress = lib.symbols.__errno_location() ?? fail('private-storage');
    for (const name of ['system.posix_acl_access', 'system.posix_acl_default']) {
      const acl = new Uint8Array(65_536 + 32);
      acl.fill(0xa5);
      const count = lib.symbols.fgetxattr(fd, new TextEncoder().encode(`${name}\0`), acl.subarray(0, 65_536), 65_536n);
      const error = count === -1n ? read.i32(errnoAddress) : 0;
      if (!acl.subarray(65_536).every(v => v === 0xa5)) fail('private-storage');
      // Refuse every non-empty extended/default ACL. This examines the kernel ACL, not synthesized mode bits.
      // ENODATA is absence for these system ACL attributes on the explicitly selected local filesystems.
      if (count !== -1n || error !== 61) fail('private-storage');
    }
  } catch {
    fail('private-storage');
  } finally {
    lib.close();
  }
}

export function readPosixProcessIdentity(processId: number, includeZombie = false): string {
  requirePosixWriterPlatform();
  if (!Number.isSafeInteger(processId) || processId <= 0 || processId > 0x7fffffff) return fail('identity');
  if (process.platform === 'linux') {
    // procfs is a kernel channel. Bind stat and process-directory ownership on both sides of the read.
    const directory = fs.openSync(
      `/proc/${processId}`,
      fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW,
    );
    try {
      const before = fs.fstatSync(directory, {bigint: true});
      if (before.uid !== BigInt(process.getuid?.() ?? -1)) fail('identity');
      const lib = posixWriterLibrary();
      let fd = -1;
      try {
        fd = lib.symbols.__openat(
          directory,
          new TextEncoder().encode('stat\0'),
          fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | 0x00080000,
          0,
        );
        if (fd < 0) fail('identity');
        const bytes = new Uint8Array(8192),
          count = fs.readSync(fd, bytes, 0, bytes.length, 0);
        if (count < 1 || count === bytes.length) fail('identity');
        const text = new TextDecoder('utf-8', {fatal: true}).decode(bytes.subarray(0, count)),
          end = Option.getOrElse(EffectString.lastIndexOf(')')(text), () => -1);
        if (
          end < 1 ||
          EffectString.slice(
            0,
            Option.getOrElse(EffectString.indexOf(' ')(text), () => -1),
          )(text) !== String(processId)
        )
          fail('identity');
        const fields = EffectString.split(EffectString.trim(EffectString.slice(end + 2)(text)), /\s+/u),
          ticks = fields[19];
        if (!includeZombie && fields[0] === 'Z') fail('identity');
        if (!ticks || !/^\d+$/u.test(ticks) || BigInt(ticks) === 0n) fail('identity');
        const after = fs.fstatSync(directory, {bigint: true}),
          current = fs.lstatSync(`/proc/${processId}`, {bigint: true});
        if (
          before.dev !== after.dev ||
          before.ino !== after.ino ||
          before.uid !== after.uid ||
          before.dev !== current.dev ||
          before.ino !== current.ino ||
          before.uid !== current.uid
        )
          fail('identity');
        const boot = EffectString.trim(fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8'));
        if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(boot)) fail('identity');
        return `linux-proc-start-v1:${boot}:${ticks}`;
      } finally {
        if (fd >= 0) fs.closeSync(fd);
        lib.close();
      }
    } catch {
      return fail('identity');
    } finally {
      fs.closeSync(directory);
    }
  }
  const lib = dlopen('/usr/lib/libproc.dylib', {
    proc_pidinfo: {args: ['i32', 'i32', 'u64', 'buffer', 'i32'], returns: 'i32'},
  });
  try {
    const storage = new BigUint64Array(21),
      bytes = new Uint8Array(storage.buffer);
    bytes.fill(0xa5);
    if (
      lib.symbols.proc_pidinfo(processId, 3, includeZombie ? 1n : 0n, bytes.subarray(0, 136), 136) !== 136 ||
      !bytes.subarray(136).every(v => v === 0xa5)
    )
      fail('identity');
    const view = new DataView(storage.buffer),
      seconds = view.getBigUint64(120, true),
      micros = view.getBigUint64(128, true);
    if (
      view.getUint32(12, true) !== processId ||
      view.getUint32(20, true) !== process.getuid?.() ||
      seconds === 0n ||
      micros >= 1_000_000n
    )
      fail('identity');
    return `darwin-proc-bsd-v1:${seconds}:${micros}`;
  } catch {
    return fail('identity');
  } finally {
    lib.close();
  }
}

/** Independent private provider-state assertion; no writer root, target or mutation capability is minted. */
export function assertPosixPrivateProviderPath(path: string, kind: 'file' | 'directory'): void {
  requirePosixWriterPlatform();
  if (!EffectString.startsWith('/')(path) || /[\p{Cc}\\]/u.test(path) || fs.realpathSync(path) !== path)
    fail('private-storage');
  const parts = EffectString.split(EffectString.slice(1)(path), '/');
  if (EffectArray.some(parts, part => !part || part === '.' || part === '..')) fail('private-storage');
  const descriptorStat = (fd: number) => fs.fstatSync(fd, {bigint: true});
  const opened: number[] = [];
  const chain: {fd: number; identity: ReturnType<typeof descriptorStat>; name: string}[] = [];
  const lib = posixWriterLibrary();
  type Snapshot = ReturnType<typeof descriptorStat>;
  const sameCritical = (a: Snapshot, b: Snapshot) =>
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.ino !== 0n &&
    a.birthtimeNs === b.birthtimeNs &&
    a.uid === b.uid &&
    a.gid === b.gid &&
    a.mode === b.mode;
  // Directory entries can change these four fields without changing this opened edge or its security.
  const sameData = (a: Snapshot, b: Snapshot) =>
    a.ctimeNs === b.ctimeNs && a.mtimeNs === b.mtimeNs && a.size === b.size && a.nlink === b.nlink;
  try {
    const root = fs.openSync('/', posixDirectoryFlags);
    opened.push(root);
    chain.push({fd: root, identity: descriptorStat(root), name: '/'});
    for (let index = 0; index < parts.length; index++) {
      const leaf = index === parts.length - 1;
      const fd = lib.symbols.__openat(
        chain[chain.length - 1].fd,
        new TextEncoder().encode(`${parts[index]}\0`),
        leaf && kind === 'file' ? fs.constants.O_RDONLY | posixFileFlags : posixDirectoryFlags,
        0,
      );
      if (fd < 0) fail('private-storage');
      opened.push(fd);
      const identity = descriptorStat(fd);
      chain.push({fd, identity, name: parts[index]});
      if (leaf && kind === 'file' ? !identity.isFile() || identity.nlink !== 1n : !identity.isDirectory())
        fail('private-storage');
    }
    for (let index = 0; index < chain.length; index++) {
      const edge = chain[index],
        privateObject = index === chain.length - 1;
      if (
        privateObject &&
        (edge.identity.uid !== BigInt(process.getuid?.() ?? -1) || (edge.identity.mode & 0o077n) !== 0n)
      )
        fail('private-storage');
      for (let attempt = 0; attempt < 2; attempt++) {
        const before = descriptorStat(edge.fd);
        if (!sameCritical(edge.identity, before)) fail('private-storage');
        let reopened = -1;
        try {
          let namedBefore: Snapshot = before;
          if (index > 0) {
            const flags =
              privateObject && kind === 'file' ? fs.constants.O_RDONLY | posixFileFlags : posixDirectoryFlags;
            reopened = lib.symbols.__openat(chain[index - 1].fd, new TextEncoder().encode(`${edge.name}\0`), flags, 0);
            if (reopened < 0) fail('private-storage');
            namedBefore = descriptorStat(reopened);
            if (!sameCritical(edge.identity, namedBefore)) fail('private-storage');
          }
          // Unsafe/unknown ACLs and critical metadata changes are terminal, never caught for retry.
          assertPosixPrivateAcl(edge.fd, privateObject, before);
          const after = descriptorStat(edge.fd),
            namedAfter = reopened < 0 ? after : descriptorStat(reopened);
          if (!sameCritical(edge.identity, after) || !sameCritical(edge.identity, namedAfter)) fail('private-storage');
          const coherent = sameData(before, namedBefore) && sameData(before, after) && sameData(before, namedAfter);
          if (!before.isDirectory()) {
            if (!coherent || !sameData(edge.identity, before)) fail('private-storage');
            break;
          }
          if (coherent) break;
          if (attempt !== 0) fail('private-storage');
          // One fresh complete sample, still anchored to the initial inode/birth/owner/mode and parent name.
        } finally {
          if (reopened >= 0) fs.closeSync(reopened);
        }
      }
    }
  } catch {
    fail('private-storage');
  } finally {
    let closeFailed = false;
    for (const fd of opened.reverse())
      try {
        fs.closeSync(fd);
      } catch {
        closeFailed = true;
      }
    lib.close();
    if (closeFailed) fail('private-storage');
  }
}
