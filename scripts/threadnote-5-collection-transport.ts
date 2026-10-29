/* oxlint-disable threadnote/no-node-runtime, effecttsgo/node-builtin-import -- Private release engineering validates a protected system executable. */
import type {Transport} from '@modelcontextprotocol/sdk/shared/transport.js';
import type {EventEmitter} from 'node:events';
import {Predicate} from 'effect';
import {deserializeMessage, serializeMessage} from '@modelcontextprotocol/sdk/shared/stdio.js';
import type {JSONRPCMessage} from '@modelcontextprotocol/sdk/types.js';
import {lstat, realpath} from 'node:fs/promises';
import {canonicalJson} from '@threadnote/graph/checkpoint/canonical_json';
import type {Threadnote5SourceV1} from '@threadnote/threadnote/evaluation/threadnote-5-release-readiness-contract';
import {
  COLLECTION_MAX_BYTES,
  collectionCleanupIsUnsafe,
  ownCollectionProcess,
  readCollectionPayloadIdentity,
  type CollectionPayloadIdentity,
} from './threadnote-5-collection-process.js';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

const MACOS_PROTECTED_PYTHON = '/usr/bin/python3';
const collectionUtf8Decoder = new TextDecoder('utf-8', {fatal: true, ignoreBOM: true});

type CollectionTransportUtf8Error = Error & {readonly collectionUtf8: true};
type CollectionTransportProcess = Pick<ReturnType<typeof ownCollectionProcess>, 'done' | 'terminate'> & {
  readonly child: EventEmitter & Pick<ReturnType<typeof ownCollectionProcess>['child'], 'stdin' | 'stdout' | 'stderr'>;
  readonly input: Pick<ReturnType<typeof ownCollectionProcess>['input'], 'failed' | 'write'>;
};
type CollectionProcessFactory = () => CollectionTransportProcess;
type CollectionMcpTransportOptions =
  | ({launch: CollectionVerifiedLaunch; cwd: string; env: Record<string, string>; argv?: readonly string[]} & {
      readonly processFactory?: CollectionProcessFactory;
    })
  | ({executable: string; cwd: string; env: Record<string, string>; argv?: readonly string[]} & {
      readonly processFactory?: CollectionProcessFactory;
    });

function collectionTransportUtf8Error(message: string): CollectionTransportUtf8Error {
  const error = new Error(message);
  Object.defineProperty(error, 'collectionUtf8', {value: true});
  if (!isCollectionTransportUtf8Error(error)) throw new Error('Could not brand the private UTF-8 boundary error.');
  return error;
}

function isCollectionTransportUtf8Error(error: unknown): error is CollectionTransportUtf8Error {
  return error instanceof Error && Predicate.hasProperty(error, 'collectionUtf8') && error.collectionUtf8 === true;
}
const MACOS_VERIFIED_SPAWN_OBSERVER = String.raw`
import ctypes
import hashlib
import os
import signal
import stat
import sys
import time

POSIX_SPAWN_START_SUSPENDED = 0x0080
PROC_PIDREGIONPATHINFO = 8
VM_PROT_EXECUTE = 0x04

class ProcRegionInfo(ctypes.Structure):
    _fields_ = [
        ("protection", ctypes.c_uint32), ("max_protection", ctypes.c_uint32),
        ("inheritance", ctypes.c_uint32), ("flags", ctypes.c_uint32),
        ("offset", ctypes.c_uint64), ("behavior", ctypes.c_uint32),
        ("user_wired_count", ctypes.c_uint32), ("user_tag", ctypes.c_uint32),
        ("pages_resident", ctypes.c_uint32), ("pages_shared_now_private", ctypes.c_uint32),
        ("pages_swapped_out", ctypes.c_uint32), ("pages_dirtied", ctypes.c_uint32),
        ("ref_count", ctypes.c_uint32), ("shadow_depth", ctypes.c_uint32),
        ("share_mode", ctypes.c_uint32), ("private_pages_resident", ctypes.c_uint32),
        ("shared_pages_resident", ctypes.c_uint32), ("obj_id", ctypes.c_uint32),
        ("depth", ctypes.c_uint32), ("address", ctypes.c_uint64), ("size", ctypes.c_uint64),
    ]

class VinfoStat(ctypes.Structure):
    _fields_ = [
        ("device", ctypes.c_uint32), ("mode", ctypes.c_uint16), ("nlink", ctypes.c_uint16),
        ("inode", ctypes.c_uint64), ("uid", ctypes.c_uint32), ("gid", ctypes.c_uint32),
        ("atime", ctypes.c_int64), ("atimensec", ctypes.c_int64),
        ("mtime", ctypes.c_int64), ("mtimensec", ctypes.c_int64),
        ("ctime", ctypes.c_int64), ("ctimensec", ctypes.c_int64),
        ("birthtime", ctypes.c_int64), ("birthtimensec", ctypes.c_int64),
        ("size", ctypes.c_int64), ("blocks", ctypes.c_int64), ("blksize", ctypes.c_int32),
        ("flags", ctypes.c_uint32), ("generation", ctypes.c_uint32), ("rdevice", ctypes.c_uint32),
        ("qspare", ctypes.c_int64 * 2),
    ]

class VnodeInfo(ctypes.Structure):
    _fields_ = [("stat", VinfoStat), ("type", ctypes.c_int), ("pad", ctypes.c_int), ("fsid", ctypes.c_int32 * 2)]

class VnodeInfoPath(ctypes.Structure):
    _fields_ = [("vnode", VnodeInfo), ("path", ctypes.c_char * 1024)]

class ProcRegionWithPathInfo(ctypes.Structure):
    _fields_ = [("region", ProcRegionInfo), ("vnode_path", VnodeInfoPath)]

def fail(message, child=0):
    if child:
        try:
            os.kill(child, signal.SIGKILL)
            os.waitpid(child, 0)
        except OSError:
            pass
    os.write(2, (message + "\n").encode("ascii"))
    raise SystemExit(125)

def identity(info):
    return (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns)

def mapped_candidate(libc, child, expected):
    address = 0
    for _ in range(16384):
        region = ProcRegionWithPathInfo()
        count = libc.proc_pidinfo(child, PROC_PIDREGIONPATHINFO, address, ctypes.byref(region), ctypes.sizeof(region))
        if count != ctypes.sizeof(region):
            return False
        vnode = region.vnode_path.vnode.stat
        observed = (vnode.device, vnode.inode, vnode.size,
                    vnode.mtime * 1000000000 + vnode.mtimensec,
                    vnode.ctime * 1000000000 + vnode.ctimensec)
        if region.region.protection & VM_PROT_EXECUTE and observed == expected:
            return True
        next_address = region.region.address + region.region.size
        if next_address <= address:
            return False
        address = next_address
    return False

def wait_for_test_barrier():
    ready = os.environ.get("THREADNOTE_COLLECTION_TEST_OBSERVER_READY")
    release = os.environ.get("THREADNOTE_COLLECTION_TEST_OBSERVER_RELEASE")
    if bool(ready) != bool(release):
        fail("Invalid collection observer barrier.")
    if not ready:
        return
    marker = os.open(ready, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    os.close(marker)
    for _ in range(500):
        try:
            if stat.S_ISREG(os.lstat(release).st_mode):
                return
        except FileNotFoundError:
            pass
        time.sleep(0.01)
    fail("Collection observer barrier timed out.")

def main():
    if len(sys.argv) < 8:
        fail("Invalid collection observer invocation.")
    expected = tuple(int(value) for value in sys.argv[1:6])
    expected_digest = sys.argv[6]
    path = sys.argv[7]
    arguments = sys.argv[7:]
    if any(value < 0 for value in expected) or len(expected_digest) != 64:
        fail("Invalid collection observer identity.")
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    child = 0
    try:
        before = os.fstat(descriptor)
        if not stat.S_ISREG(before.st_mode) or identity(before) != expected:
            fail("Candidate object verification failed.")
        digest = hashlib.sha256()
        while True:
            chunk = os.read(descriptor, 65536)
            if not chunk:
                break
            digest.update(chunk)
        if identity(os.fstat(descriptor)) != expected or digest.hexdigest() != expected_digest:
            fail("Candidate object verification failed.")
        wait_for_test_barrier()
        libc = ctypes.CDLL("/usr/lib/libSystem.B.dylib")
        libc.proc_pidinfo.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_uint64, ctypes.c_void_p, ctypes.c_int]
        libc.proc_pidinfo.restype = ctypes.c_int
        attribute = ctypes.c_void_p()
        if libc.posix_spawnattr_init(ctypes.byref(attribute)) != 0:
            fail("Suspended candidate launch is unavailable.")
        try:
            if libc.posix_spawnattr_setflags(ctypes.byref(attribute), POSIX_SPAWN_START_SUSPENDED) != 0:
                fail("Suspended candidate launch is unavailable.")
            encoded_arguments = [os.fsencode(value) for value in arguments]
            argv = (ctypes.c_char_p * (len(encoded_arguments) + 1))(*encoded_arguments, None)
            encoded_environment = [os.fsencode(key + "=" + value) for key, value in os.environ.items()]
            environment = (ctypes.c_char_p * (len(encoded_environment) + 1))(*encoded_environment, None)
            child_holder = ctypes.c_int()
            spawned = libc.posix_spawn(ctypes.byref(child_holder), os.fsencode(path), None,
                                       ctypes.byref(attribute), argv, environment)
            child = child_holder.value
        finally:
            libc.posix_spawnattr_destroy(ctypes.byref(attribute))
        if spawned != 0 or child <= 0:
            fail("Could not spawn the suspended candidate object.", child)
        if identity(os.fstat(descriptor)) != expected or not mapped_candidate(libc, child, expected):
            fail("Spawned candidate executable identity mismatch.", child)
        os.close(descriptor)
        descriptor = -1
        os.kill(child, signal.SIGCONT)
        _, status = os.waitpid(child, 0)
        if os.WIFEXITED(status):
            raise SystemExit(os.WEXITSTATUS(status))
        if os.WIFSIGNALED(status):
            raise SystemExit(128 + os.WTERMSIG(status))
        fail("Candidate process returned an invalid status.")
    finally:
        if descriptor >= 0:
            os.close(descriptor)

try:
    main()
except SystemExit:
    raise
except BaseException:
    fail("Verified collection observer failed closed.")
`;

export interface CollectionVerifiedLaunch {
  readonly candidate: string;
  readonly candidatePayload: CollectionPayloadIdentity;
}

export function collectionVerifiedLaunchCommand(binding: CollectionVerifiedLaunch, argv: readonly string[]) {
  const identity = (payload: CollectionPayloadIdentity) => [
    payload.device,
    payload.inode,
    payload.size,
    payload.modified,
    payload.changed,
  ];
  return {
    executable: MACOS_PROTECTED_PYTHON,
    argv: [
      '-I',
      '-S',
      '-E',
      '-c',
      MACOS_VERIFIED_SPAWN_OBSERVER,
      ...identity(binding.candidatePayload),
      binding.candidatePayload.executableSha256,
      binding.candidate,
      ...argv,
    ],
  };
}

export async function createCollectionVerifiedLaunch(
  candidate: string,
  candidatePayload: CollectionPayloadIdentity,
): Promise<CollectionVerifiedLaunch> {
  if (process.platform !== 'darwin')
    throw new Error('Verified collection execution currently requires the protected macOS system interpreter.');
  const observer = await lstat(MACOS_PROTECTED_PYTHON, {bigint: true});
  if (
    !observer.isFile() ||
    observer.isSymbolicLink() ||
    observer.uid !== 0n ||
    (observer.mode & 0o22n) !== 0n ||
    (await realpath(MACOS_PROTECTED_PYTHON)) !== MACOS_PROTECTED_PYTHON
  )
    throw new Error('Verified collection execution requires an immutable protected system interpreter.');
  return {candidate, candidatePayload};
}

export async function runVerifiedCollectionProcess(
  launch: CollectionVerifiedLaunch,
  argv: readonly string[],
  cwd: string,
  env: Record<string, string>,
  limits: {readonly timeoutMs?: number; readonly maximumCaptureBytes?: number} = {},
) {
  const command = collectionVerifiedLaunchCommand(launch, argv);
  const timeoutMs = limits.timeoutMs ?? 120_000;
  const maximumCaptureBytes = limits.maximumCaptureBytes ?? COLLECTION_MAX_BYTES;
  if (!Number.isSafeInteger(maximumCaptureBytes) || maximumCaptureBytes < 0)
    throw new Error('Invalid verified process capture byte bound.');
  const started = performance.now();
  const owned = ownCollectionProcess(command.executable, command.argv, cwd, env);
  const sent = owned.input.end();
  void sent.catch(() => {});
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let bytes = 0;
  let exceeded = false;
  const stop = () => {
    exceeded = true;
    void owned.terminate().catch(() => {});
  };
  const timeout = setTimeout(stop, timeoutMs);
  const collect = (target: Buffer[]) => (chunk: Buffer) => {
    bytes += chunk.byteLength;
    if (bytes > maximumCaptureBytes) stop();
    else target.push(chunk);
  };
  owned.child.stdout.on('data', collect(stdout));
  owned.child.stderr.on('data', collect(stderr));
  try {
    const [exitCode] = await Promise.all([owned.done, sent]);
    if (exceeded || exitCode === null)
      throw new Error('Verified collection process exceeded its time/output bound or was interrupted.');
    return {
      stdout: decodeCollectionUtf8(Buffer.concat(stdout), 'Verified collection process stdout'),
      stderr: decodeCollectionUtf8(Buffer.concat(stderr), 'Verified collection process stderr'),
      exitCode,
      elapsedMilliseconds: Math.max(0, Math.round(performance.now() - started)),
    };
  } finally {
    clearTimeout(timeout);
    await owned.terminate();
  }
}

export async function observeVerifiedCollectionRuntime(
  launch: CollectionVerifiedLaunch,
  candidate: Threadnote5SourceV1,
  cwd: string,
  env: Record<string, string>,
) {
  if (canonicalJson(await readCollectionPayloadIdentity(launch.candidate)) !== canonicalJson(launch.candidatePayload))
    throw new Error('Candidate payload bytes/inode drift.');
  const version = await runVerifiedCollectionProcess(launch, ['--version'], cwd, env, {timeoutMs: 10_000});
  if (
    version.exitCode !== 0 ||
    Effect.pipe(version.stderr, EffectString.trim) ||
    Effect.pipe(version.stdout, EffectString.trim) !== `threadnote v${candidate.version}` ||
    !Effect.pipe(candidate.version, EffectString.endsWith(`local.g${candidate.commit}`))
  )
    throw new Error('Candidate version/commit drift.');
  if (canonicalJson(await readCollectionPayloadIdentity(launch.candidate)) !== canonicalJson(launch.candidatePayload))
    throw new Error('Candidate payload changed during identity observation.');
  return {executableSha256: launch.candidatePayload.executableSha256, sourceCommit: candidate.commit};
}

function decodeCollectionUtf8(bytes: Uint8Array, label: string): string {
  try {
    return collectionUtf8Decoder.decode(bytes);
  } catch {
    throw collectionTransportUtf8Error(`${label} must be valid UTF-8.`);
  }
}

export class CollectionMcpTransport implements Transport {
  onclose?: Transport['onclose'];
  onerror?: Transport['onerror'];
  onmessage?: Transport['onmessage'];
  private process?: CollectionTransportProcess;
  private failure?: Error;
  private bytes = 0;
  private captureBytes = 0;
  private captureLimit = COLLECTION_MAX_BYTES;
  private retainedStderrBytes = 0;
  private closing = false;
  private closed = false;
  private stdoutBuffer = Buffer.alloc(0);
  private readonly stderrDecoder = new TextDecoder('utf-8', {fatal: true, ignoreBOM: true});
  private stderrFinalized = false;
  private closePromise?: Promise<void>;
  readonly stderr: string[] = [];

  constructor(private readonly options: CollectionMcpTransportOptions) {}

  async start(): Promise<void> {
    if (this.process !== undefined) throw new Error('Collection MCP transport already started.');
    const argv = this.options.argv ?? ['mcp-server'];
    const command =
      'launch' in this.options
        ? collectionVerifiedLaunchCommand(this.options.launch, argv)
        : {executable: this.options.executable, argv};
    const owned =
      this.options.processFactory?.() ??
      ownCollectionProcess(command.executable, command.argv, this.options.cwd, this.options.env);
    this.process = owned;
    void owned.input.failed.catch(error => this.fail(error));
    owned.child.stdout.on('data', (chunk: Buffer) => {
      if (!this.accept(chunk, false)) return;
      try {
        this.appendStdout(chunk);
      } catch (error) {
        this.fail(
          isCollectionTransportUtf8Error(error) ? error : new Error('Invalid or oversized private MCP protocol frame.'),
        );
      }
    });
    owned.child.stderr.on('data', (chunk: Buffer) => {
      if (!this.accept(chunk, true)) return;
      try {
        this.stderr.push(this.stderrDecoder.decode(chunk, {stream: true}));
      } catch {
        this.fail(new Error('Invalid private MCP stderr UTF-8.'));
      }
    });
    void owned.done.then(
      code => {
        if (!this.closing) {
          try {
            this.finishCapture();
          } catch (error) {
            this.fail(error instanceof Error ? error : new Error('Incomplete or malformed private MCP capture.'));
          }
          if (this.failure === undefined && code !== 0)
            this.fail(new Error('Candidate MCP process exited unsuccessfully.'));
          this.notifyClosed();
        }
      },
      error => {
        if (this.failure === undefined)
          this.fail(error instanceof Error ? error : new Error('Candidate MCP process failed.'));
        if (!this.closing) this.notifyClosed();
      },
    );
    await new Promise<void>((resolvePromise, reject) => {
      owned.child.once('spawn', resolvePromise);
      owned.child.once('error', reject);
    });
  }

  async send(message: JSONRPCMessage): Promise<void> {
    if (this.failure !== undefined) await this.close();
    this.assertHealthy();
    const input = this.process?.input;
    if (input === undefined) throw new Error('Collection MCP transport is not running.');
    const bytes = serializeMessage(message);
    if (Buffer.byteLength(bytes) > COLLECTION_MAX_BYTES) throw new Error('MCP request exceeds the byte bound.');
    try {
      await input.write(bytes);
      this.assertHealthy();
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error('Candidate MCP input failed.'));
      await this.close();
    }
  }

  async close(): Promise<void> {
    if (this.closePromise === undefined) {
      this.closing = true;
      const process = this.process;
      this.closePromise = (async () => {
        let cleanupError: Error | undefined;
        try {
          await process?.terminate();
        } catch (error) {
          cleanupError = error instanceof Error ? error : new Error('Candidate MCP process cleanup failed.');
        }
        if (cleanupError === undefined) {
          try {
            this.finishCapture();
          } catch (error) {
            this.fail(error instanceof Error ? error : new Error('Incomplete or malformed private MCP capture.'));
          }
        }
        this.notifyClosed();
        if (cleanupError !== undefined && collectionCleanupIsUnsafe(cleanupError)) throw cleanupError;
        if (this.failure !== undefined) throw this.failure;
        if (cleanupError !== undefined) throw cleanupError;
      })();
    }
    try {
      await this.closePromise;
    } catch (error) {
      if (collectionCleanupIsUnsafe(error)) throw error;
      if (this.failure !== undefined) throw this.failure;
      throw error;
    }
    if (this.failure !== undefined) throw this.failure;
  }

  assertHealthy(): void {
    if (this.failure !== undefined) throw this.failure;
  }

  beginCapture(remainingBytes: number): void {
    this.assertHealthy();
    if (!Number.isSafeInteger(remainingBytes) || remainingBytes < 0) throw new Error('Invalid MCP capture byte bound.');
    this.captureBytes = 0;
    this.captureLimit = Math.min(COLLECTION_MAX_BYTES, Math.max(0, remainingBytes - this.retainedStderrBytes));
  }

  private accept(chunk: Buffer, stderr: boolean): boolean {
    if (this.failure !== undefined) return false;
    this.bytes += chunk.byteLength;
    this.captureBytes += chunk.byteLength;
    if (stderr) this.retainedStderrBytes += chunk.byteLength;
    if (this.bytes > COLLECTION_MAX_BYTES || this.captureBytes > this.captureLimit) {
      this.fail(new Error('MCP protocol/stderr byte limit exceeded before parsing.'));
      return false;
    }
    return true;
  }

  private appendStdout(chunk: Buffer): void {
    this.stdoutBuffer = this.stdoutBuffer.length === 0 ? Buffer.from(chunk) : Buffer.concat([this.stdoutBuffer, chunk]);
    while (true) {
      const newline = this.stdoutBuffer.indexOf(0x0a);
      if (newline < 0) return;
      const frame = this.stdoutBuffer.subarray(0, newline);
      this.stdoutBuffer = this.stdoutBuffer.subarray(newline + 1);
      const decoded = decodeCollectionUtf8(frame, 'MCP stdout');
      const line = Effect.pipe(decoded, EffectString.endsWith('\r'))
        ? Effect.pipe(decoded, EffectString.slice(0, -1))
        : decoded;
      this.onmessage?.(deserializeMessage(line));
    }
  }

  private finishCapture(): void {
    let failure: Error | undefined;
    if (this.stdoutBuffer.length !== 0) {
      failure = new Error('Incomplete private MCP protocol frame.');
    }
    if (!this.stderrFinalized) {
      this.stderrFinalized = true;
      try {
        const trailing = this.stderrDecoder.decode();
        if (trailing.length > 0) this.stderr.push(trailing);
      } catch {
        failure ??= collectionTransportUtf8Error('MCP stderr must be valid UTF-8.');
      }
    }
    if (failure !== undefined) throw failure;
  }

  private fail(error: Error): void {
    if (this.failure !== undefined) return;
    this.failure = error;
    this.stdoutBuffer = Buffer.alloc(0);
    this.onerror?.(error);
    void this.close().catch(() => {});
  }

  private notifyClosed(): void {
    if (this.closed) return;
    this.closed = true;
    this.onclose?.();
  }
}
