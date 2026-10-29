/* oxlint-disable threadnote/no-node-runtime, effecttsgo/node-builtin-import -- This reviewed evaluator verifies an explicit executable boundary. */
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {lstat, mkdtemp, readFile, realpath, rm} from 'node:fs/promises';
import {resolve} from 'node:path';
import {tmpdir} from 'node:os';
import type {CodeMemoryLinkRuntimeIdentityV1} from '@threadnote/threadnote/evaluation/code-memory-link-attestation';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

const COMMIT = /^[0-9a-f]{40}$/u;
const HASH = /^[0-9a-f]{64}$/u;

export interface CodeMemoryLinkEvaluatedSubject {
  readonly executable: string;
  readonly identity: CodeMemoryLinkRuntimeIdentityV1;
  readonly version: string;
}

export async function verifyCodeMemoryLinkEvaluatedSubject(input: {
  readonly executable: string;
  readonly executableSha256: string;
  readonly sourceCommit: string;
}): Promise<CodeMemoryLinkEvaluatedSubject> {
  if (!COMMIT.test(input.sourceCommit)) throw new Error('Evaluated subject commit is invalid.');
  if (!HASH.test(input.executableSha256)) throw new Error('Evaluated subject executable hash is invalid.');
  if (!Effect.pipe(input.executable, EffectString.startsWith('/')) || resolve(input.executable) !== input.executable) {
    throw new Error('Evaluated subject executable must be normalized and absolute.');
  }
  const metadata = await lstat(input.executable);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error('Evaluated subject executable must be a non-symlink regular file.');
  }
  if ((await realpath(input.executable)) !== input.executable) {
    throw new Error('Evaluated subject executable must be canonical.');
  }
  const executableSha256 = createHash('sha256')
    .update(await readFile(input.executable))
    .digest('hex');
  if (executableSha256 !== input.executableSha256) {
    throw new Error('Evaluated subject executable differs from its preregistered hash.');
  }
  const version = await readVersion(input.executable);
  if (
    !new RegExp(`^threadnote v[0-9]+\\.[0-9]+\\.[0-9]+(?:-[0-9A-Za-z.-]+)?-local\\.g${input.sourceCommit}$`, 'u').test(
      version,
    )
  ) {
    throw new Error('Evaluated subject version does not bind the preregistered source commit.');
  }
  return {
    executable: input.executable,
    identity: {executableSha256, sourceCommit: input.sourceCommit},
    version,
  };
}

async function readVersion(executable: string): Promise<string> {
  const temporaryRoot = await realpath(tmpdir());
  const temporaryHome = await mkdtemp(resolve(temporaryRoot, 'threadnote-evaluated-subject-'));
  try {
    return await new Promise((resolvePromise, rejectPromise) => {
      const child = spawn(executable, ['--version'], {
        env: {HOME: temporaryHome, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', NO_COLOR: '1', PATH: '/usr/bin:/bin'},
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let bytes = 0;
      const timeout = setTimeout(() => child.kill('SIGKILL'), 10_000);
      const collect = (target: Buffer[]) => (value: Uint8Array) => {
        const chunk = Buffer.from(value);
        bytes += chunk.byteLength;
        if (bytes > 64 * 1_024) child.kill('SIGKILL');
        else target.push(chunk);
      };
      child.stdout.on('data', collect(stdout));
      child.stderr.on('data', collect(stderr));
      child.once('error', cause => {
        clearTimeout(timeout);
        rejectPromise(cause);
      });
      child.once('exit', code => {
        clearTimeout(timeout);
        if (code !== 0 || bytes > 64 * 1_024) {
          rejectPromise(new Error('Could not verify the evaluated subject version.'));
          return;
        }
        if (Buffer.concat(stderr).length > 0) {
          rejectPromise(new Error('Evaluated subject version check emitted stderr.'));
          return;
        }
        resolvePromise(Effect.pipe(Buffer.concat(stdout).toString('utf8'), EffectString.trim));
      });
    });
  } finally {
    await rm(temporaryHome, {force: true, maxRetries: 3, recursive: true});
  }
}
