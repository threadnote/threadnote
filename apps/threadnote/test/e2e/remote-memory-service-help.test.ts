import {Array as EffectArray, Predicate} from 'effect';
import {execFile} from '@threadnote/testing/node-child-process';
import {promisify} from '@threadnote/testing/node-util';
import {describe, expect, it} from 'vitest';
import {join} from '@threadnote/testing/node-path';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

const execute = promisify(execFile);
const root = process.cwd();
const sourceEntry = join(root, 'apps', 'threadnote', 'src', 'standalone.ts');

function serviceEnvironment(): NodeJS.ProcessEnv {
  return EffectRecord.fromEntries(
    EffectArray.filter(
      EffectRecord.toEntries(process.env),
      ([name]) => !Effect.pipe(name, EffectString.startsWith('THREADNOTE_REMOTE_')),
    ),
  );
}

describe('remote memory service standalone entrypoint', () => {
  it.each(['--help', '-h'])('prints bounded help without loading service configuration (%s)', async argument => {
    const result = await execute(process.execPath, [sourceEntry, 'remote-memory-service', argument], {
      cwd: root,
      env: serviceEnvironment(),
      encoding: 'utf8',
      maxBuffer: 8 * 1024,
    });

    expect(result.stderr).toBe('');
    expect(result.stdout).toBe(
      EffectArray.join(
        [
          'Threadnote remote memory service',
          '',
          'Usage: threadnote remote-memory-service',
          '',
          'Starts the remote memory HTTP service using THREADNOTE_REMOTE_* environment variables.',
          '',
        ],
        '\n',
      ),
    );
    expect(result.stdout.length).toBeLessThan(2048);
  });

  it('keeps normal startup on the service path when configuration is missing', async () => {
    const result = await execute(process.execPath, [sourceEntry, 'remote-memory-service'], {
      cwd: root,
      env: serviceEnvironment(),
      encoding: 'utf8',
      maxBuffer: 8 * 1024,
    }).catch(error => {
      if (!Predicate.isObject(error)) return {code: undefined, stderr: undefined, stdout: undefined};
      return {
        code: Predicate.hasProperty(error, 'code') && typeof error.code === 'number' ? error.code : undefined,
        stderr: Predicate.hasProperty(error, 'stderr') && typeof error.stderr === 'string' ? error.stderr : undefined,
        stdout: Predicate.hasProperty(error, 'stdout') && typeof error.stdout === 'string' ? error.stdout : undefined,
      };
    });

    expect(result).toMatchObject({
      code: 1,
      stderr: 'Remote memory service failed: RemoteMemoryError.\n',
      stdout: '',
    });
  });
});
