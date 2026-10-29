import {Predicate} from 'effect';
import {Array as EffectArray} from 'effect';
/* oxlint-disable threadnote/no-node-runtime, effecttsgo/node-builtin-import -- Private release engineering owns real CLI process groups and binary payloads. */
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import type {Writable} from 'node:stream';
import {lstat, open, realpath} from 'node:fs/promises';
import {constants, type BigIntStats} from 'node:fs';
import {isAbsolute, resolve, sep} from 'node:path';
import type {Threadnote5SourceV1} from '@threadnote/threadnote/evaluation/threadnote-5-release-readiness-contract';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

export const COLLECTION_MAX_BYTES = 8 * 1024 * 1024;
const unsafeCleanupErrors = new WeakSet<Error>();
const collectionUtf8Decoder = new TextDecoder('utf-8', {fatal: true, ignoreBOM: true});

function decodeCollectionUtf8(bytes: Uint8Array, label: string): string {
  try {
    return collectionUtf8Decoder.decode(bytes);
  } catch {
    throw new Error(`${label} must be valid UTF-8.`);
  }
}

function stableRegularFile(info: BigIntStats): boolean {
  return info.isFile() && !info.isSymbolicLink() && info.dev !== 0n && info.ino !== 0n;
}

function sameStableRegularFile(left: BigIntStats, right: BigIntStats): boolean {
  return (
    stableRegularFile(left) &&
    stableRegularFile(right) &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

export interface PrivateCollectionJsonIdentity {
  readonly device: string;
  readonly inode: string;
}

interface BoundedStableRegularFile {
  readonly bytes: Uint8Array;
  readonly identity: PrivateCollectionJsonIdentity;
}

async function readBoundedStableRegularFile(path: string, maxBytes: number): Promise<BoundedStableRegularFile> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes >= Number.MAX_SAFE_INTEGER)
    throw new Error('Invalid private JSON byte bound.');
  const pathBefore = await lstat(path, {bigint: true});
  if (!stableRegularFile(pathBefore) || pathBefore.size > BigInt(maxBytes))
    throw new Error('Native capture must be a bounded regular JSON file.');
  const handle = await open(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0));
  try {
    const [openedBefore, pathOpened] = await Promise.all([handle.stat({bigint: true}), lstat(path, {bigint: true})]);
    if (!sameStableRegularFile(pathBefore, openedBefore) || !sameStableRegularFile(pathBefore, pathOpened))
      throw new Error('Private JSON changed while opening.');
    const bytes = new Uint8Array(maxBytes + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const {bytesRead} = await handle.read(bytes, offset, bytes.length - offset, null);
      if (!Number.isSafeInteger(bytesRead) || bytesRead < 0 || bytesRead > bytes.length - offset)
        throw new Error('Private JSON returned an invalid read size.');
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    const [openedAfter, pathAfter] = await Promise.all([handle.stat({bigint: true}), lstat(path, {bigint: true})]);
    if (
      !sameStableRegularFile(pathBefore, openedAfter) ||
      !sameStableRegularFile(pathBefore, pathAfter) ||
      offset > maxBytes ||
      BigInt(offset) !== pathBefore.size
    )
      throw new Error('Private JSON changed during its bounded read.');
    return {
      bytes: bytes.subarray(0, offset),
      identity: {device: String(openedBefore.dev), inode: String(openedBefore.ino)},
    };
  } finally {
    await handle.close();
  }
}

export function collectionCleanupIsUnsafe(error: unknown): boolean {
  return error instanceof Error && unsafeCleanupErrors.has(error);
}

export function collectionEnvironment(root: string, home: string): Record<string, string> {
  if (
    !isAbsolute(root) ||
    resolve(root) !== root ||
    resolve(home) !== home ||
    !Effect.pipe(home, EffectString.startsWith(`${root}${sep}`))
  )
    throw new Error('THREADNOTE_HOME must be inside the fresh collection root.');
  return {
    HOME: home,
    THREADNOTE_HOME: resolve(home, '.threadnote'),
    XDG_CONFIG_HOME: resolve(home, '.config'),
    XDG_CACHE_HOME: resolve(home, '.cache'),
    TMPDIR: resolve(home, 'tmp'),
    PATH: '/usr/bin:/bin',
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    NO_COLOR: '1',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    GIT_ALLOW_PROTOCOL: 'file',
    GIT_AUTHOR_NAME: 'Readiness collector',
    GIT_AUTHOR_EMAIL: 'collector@example.invalid',
    GIT_COMMITTER_NAME: 'Readiness collector',
    GIT_COMMITTER_EMAIL: 'collector@example.invalid',
  };
}

interface CollectionProcessInput {
  readonly failed: Promise<never>;
  readonly closed: Promise<void>;
  assertHealthy(): void;
  write(bytes: string | Uint8Array): Promise<void>;
  end(bytes?: string | Uint8Array): Promise<void>;
}

class OwnedCollectionInput implements CollectionProcessInput {
  private failure?: Error;
  private ending = false;
  private readonly pending = new Set<(error: Error) => void>();
  readonly failed: Promise<never>;
  readonly closed: Promise<void>;
  private rejectFailure!: (error: Error) => void;

  constructor(
    private readonly stream: Writable,
    private readonly stop: () => void,
  ) {
    this.failed = new Promise((_, reject) => {
      this.rejectFailure = reject;
    });
    void this.failed.catch(() => {});
    this.closed = new Promise(resolvePromise =>
      stream.once('close', () => {
        if (this.pending.size > 0) this.fail(new Error('Collection process input closed before completing.'));
        resolvePromise();
      }),
    );
    stream.on('error', error => this.fail(error));
  }

  assertHealthy(): void {
    if (this.failure !== undefined) throw this.failure;
  }

  private fail(error: Error): void {
    if (this.failure !== undefined) return;
    this.failure = error;
    this.rejectFailure(error);
    for (const reject of this.pending) reject(error);
    this.pending.clear();
    this.stop();
  }

  private async operate(bytes: string | Uint8Array, end: boolean): Promise<void> {
    this.assertHealthy();
    if (this.ending || this.stream.destroyed) throw new Error('Collection process input is closed.');
    if (Buffer.byteLength(bytes) > COLLECTION_MAX_BYTES)
      throw new Error('Collection process input exceeds the byte bound.');
    this.ending = end;
    await new Promise<void>((resolvePromise, reject) => {
      this.pending.add(reject);
      const complete = (error?: Error | null) => {
        this.pending.delete(reject);
        if (error) this.fail(error);
        try {
          this.assertHealthy();
          resolvePromise();
        } catch (failure) {
          reject(failure);
        }
      };
      try {
        if (end) this.stream.end(bytes, complete);
        else this.stream.write(bytes, complete);
      } catch (error) {
        this.fail(error instanceof Error ? error : new Error('Collection process input failed.'));
      }
    });
    if (end) {
      await Promise.race([this.closed, this.failed]);
      this.assertHealthy();
    }
  }

  write(bytes: string | Uint8Array): Promise<void> {
    return this.operate(bytes, false);
  }
  end(bytes: string | Uint8Array = ''): Promise<void> {
    return this.operate(bytes, true);
  }
}

export function ownCollectionProcess(
  executable: string,
  argv: readonly string[],
  cwd: string,
  env: Record<string, string>,
) {
  if (process.platform !== 'darwin' && process.platform !== 'linux')
    throw new Error('Collection process-group isolation requires POSIX.');
  const child = spawn(executable, [...argv], {cwd, env, stdio: ['pipe', 'pipe', 'pipe'], detached: true});
  let settled = false;
  const killGroup = async () => {
    if (settled || child.pid === undefined) return;
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch (error) {
      if ((Predicate.hasProperty(error, 'code') ? error.code : undefined) === 'ESRCH') return;
      if (
        (Predicate.hasProperty(error, 'code') ? error.code : undefined) === 'EPERM' &&
        (await collectionGroupMembers(child.pid)).length === 0
      )
        return;
      if (error instanceof Error) unsafeCleanupErrors.add(error);
      throw error;
    }
  };
  let cleanup: Promise<void> = Promise.resolve();
  const input: CollectionProcessInput = new OwnedCollectionInput(child.stdin, () => {
    cleanup = Promise.all([cleanup, killGroup()]).then(() => {});
    void cleanup.catch(() => {});
  });
  const done = new Promise<number | null>((resolvePromise, reject) => {
    child.once('error', error => {
      settled = true;
      reject(error);
    });
    child.once('exit', () => {
      cleanup = Promise.all([cleanup, killGroup().then(() => awaitCollectionGroupExit(child.pid))]).then(() => {});
      void cleanup.catch(() => {});
    });
    child.once('close', code => {
      void input.closed
        .then(() => cleanup)
        .then(
          () => {
            settled = true;
            try {
              input.assertHealthy();
              resolvePromise(code);
            } catch (error) {
              reject(error);
            }
          },
          error => {
            settled = true;
            reject(error);
          },
        );
    });
  });
  void done.catch(() => {});
  return {
    child,
    input,
    done,
    terminate: async () => {
      await killGroup();
      await done;
    },
  };
}

async function awaitCollectionGroupExit(group: number | undefined): Promise<void> {
  if (group === undefined) {
    const error = new Error('Collection process group identity is unavailable.');
    unsafeCleanupErrors.add(error);
    throw error;
  }
  const deadline = performance.now() + 5_000;
  while (true) {
    if ((await collectionGroupMembers(group)).length === 0) return;
    if (performance.now() >= deadline) {
      const error = new Error('Collection process group failed to terminate; refusing to capture or publish.');
      unsafeCleanupErrors.add(error);
      throw error;
    }
    await new Promise<void>(resolvePromise => setTimeout(resolvePromise, 20));
  }
}

export async function collectionGroupMembers(group: number): Promise<readonly number[]> {
  return await new Promise((resolvePromise, reject) => {
    const probe = spawn('/bin/ps', ['-axo', 'pid=,pgid='], {
      env: {PATH: '/usr/bin:/bin', LANG: 'C'},
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const chunks: Buffer[] = [];
    let bytes = 0;
    const timeout = setTimeout(() => probe.kill('SIGKILL'), 2_000);
    probe.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > COLLECTION_MAX_BYTES) probe.kill('SIGKILL');
      else chunks.push(chunk);
    });
    probe.once('error', error => {
      clearTimeout(timeout);
      unsafeCleanupErrors.add(error);
      reject(error);
    });
    probe.once('close', code => {
      clearTimeout(timeout);
      if (code !== 0 || bytes > COLLECTION_MAX_BYTES) {
        const error = new Error('Cannot establish collection process-group quiescence.');
        unsafeCleanupErrors.add(error);
        reject(error);
        return;
      }
      const members = EffectArray.map(
        EffectArray.filter(
          Effect.pipe(Buffer.concat(chunks).toString('utf8'), EffectString.trim, EffectString.split('\n')),
          Boolean,
        ),
        line => EffectArray.map(Effect.pipe(line, EffectString.trim, EffectString.split(/\s+/u)), Number),
      );
      if (
        EffectArray.some(
          members,
          pair => pair.length !== 2 || EffectArray.some(pair, value => !Number.isSafeInteger(value) || value < 0),
        )
      ) {
        const error = new Error('Invalid process-group observation.');
        unsafeCleanupErrors.add(error);
        reject(error);
        return;
      }
      resolvePromise(
        EffectArray.map(
          EffectArray.filter(members, ([, pgid]) => pgid === group),
          ([pid]) => pid,
        ),
      );
    });
  });
}

export async function runCollectionProcess(
  executable: string,
  argv: readonly string[],
  cwd: string,
  env: Record<string, string>,
  timeoutMs = 120_000,
) {
  const started = performance.now();
  const owned = ownCollectionProcess(executable, argv, cwd, env);
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
    if (bytes > COLLECTION_MAX_BYTES) stop();
    else target.push(chunk);
  };
  owned.child.stdout.on('data', collect(stdout));
  owned.child.stderr.on('data', collect(stderr));
  try {
    const [exitCode] = await Promise.all([owned.done, sent]);
    if (exceeded || exitCode === null)
      throw new Error('Collection process exceeded its time/output bound or was interrupted.');
    return {
      stdout: decodeCollectionUtf8(Buffer.concat(stdout), 'Collection process stdout'),
      stderr: decodeCollectionUtf8(Buffer.concat(stderr), 'Collection process stderr'),
      exitCode,
      elapsedMilliseconds: Math.max(0, Math.round(performance.now() - started)),
    };
  } finally {
    clearTimeout(timeout);
    await owned.terminate();
  }
}

export interface CollectionPayloadIdentity {
  readonly executableSha256: string;
  readonly device: string;
  readonly inode: string;
  readonly size: string;
  readonly modified: string;
  readonly changed: string;
}

/** A launcher is not a payload. Only a native ELF/Mach-O standalone binary is eligible. */
export async function readCollectionPayloadIdentity(executable: string): Promise<CollectionPayloadIdentity> {
  if (!isAbsolute(executable) || resolve(executable) !== executable || (await realpath(executable)) !== executable)
    throw new Error('Candidate must be a canonical standalone payload path.');
  const handle = await open(executable, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat({bigint: true});
    if (!before.isFile()) throw new Error('Candidate payload must be a regular file.');
    const bytes = await handle.readFile();
    const magic = bytes.subarray(0, 4).toString('hex');
    if (
      ![
        '7f454c46',
        'cffaedfe',
        'feedfacf',
        'cefaedfe',
        'feedface',
        'cafebabe',
        'bebafeca',
        'cafebabf',
        'bfbafeca',
      ].includes(magic)
    )
      throw new Error('Candidate must be a native standalone payload, never a launcher or script.');
    const after = await handle.stat({bigint: true});
    const current = await lstat(executable, {bigint: true});
    const stamp = (value: typeof before) =>
      EffectArray.join(EffectArray.map([value.dev, value.ino, value.size, value.mtimeNs, value.ctimeNs], String), ':');
    if (stamp(before) !== stamp(after) || stamp(before) !== stamp(current))
      throw new Error('Candidate payload changed while hashing.');
    return {
      executableSha256: createHash('sha256').update(bytes).digest('hex'),
      device: String(before.dev),
      inode: String(before.ino),
      size: String(before.size),
      modified: String(before.mtimeNs),
      changed: String(before.ctimeNs),
    };
  } finally {
    await handle.close();
  }
}

export async function observeCollectionRuntime(
  executable: string,
  candidate: Threadnote5SourceV1,
  cwd: string,
  env: Record<string, string>,
  expectedPayload?: CollectionPayloadIdentity,
) {
  const payload = await readCollectionPayloadIdentity(executable);
  if (
    payload.executableSha256 !== candidate.executableSha256 ||
    (expectedPayload !== undefined && JSON.stringify(payload) !== JSON.stringify(expectedPayload))
  )
    throw new Error('Candidate payload bytes/inode drift.');
  const version = await runCollectionProcess(executable, ['--version'], cwd, env, 10_000);
  if (
    version.exitCode !== 0 ||
    Effect.pipe(version.stderr, EffectString.trim) ||
    Effect.pipe(version.stdout, EffectString.trim) !== `threadnote v${candidate.version}` ||
    !Effect.pipe(candidate.version, EffectString.endsWith(`local.g${candidate.commit}`))
  )
    throw new Error('Candidate version/commit drift.');
  if (JSON.stringify(await readCollectionPayloadIdentity(executable)) !== JSON.stringify(payload))
    throw new Error('Candidate payload changed during identity observation.');
  return {executableSha256: payload.executableSha256, sourceCommit: candidate.commit};
}

export async function readPrivateCollectionJson(path: string, maxBytes = COLLECTION_MAX_BYTES): Promise<unknown> {
  return (await readPrivateCollectionJsonWithIdentity(path, maxBytes)).value;
}

export async function readPrivateCollectionJsonWithIdentity(
  path: string,
  maxBytes = COLLECTION_MAX_BYTES,
): Promise<{readonly value: unknown; readonly identity: PrivateCollectionJsonIdentity}> {
  const {bytes, identity} = await readBoundedStableRegularFile(path, maxBytes);
  return {value: JSON.parse(decodeCollectionUtf8(bytes, 'Private JSON')), identity};
}
