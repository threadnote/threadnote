import {Array as EffectArray} from 'effect';
import {createHash} from '@threadnote/testing/node-crypto';
import {chmod, mkdtemp, readFile, realpath, rm, symlink, writeFile} from '@threadnote/testing/node-fs-promises';
import {tmpdir} from '@threadnote/testing/node-os';
import {join} from '@threadnote/testing/node-path';
import {afterEach, describe, expect, it} from 'vitest';
import {verifyCodeMemoryLinkEvaluatedSubject} from '../../../../scripts/code-memory-link-evaluated-subject.js';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

const COMMIT = Effect.pipe('a', EffectString.repeat(40));

describe('Code Memory Link evaluated subject', () => {
  const temporaryRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(EffectArray.map(temporaryRoots.splice(0), root => rm(root, {force: true, recursive: true})));
  });

  it('binds one canonical executable to its exact bytes, version, and source commit', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'threadnote-evaluated-subject-')));
    temporaryRoots.push(root);
    const executable = join(root, 'threadnote');
    await writeFile(executable, `#!/bin/sh\nprintf 'threadnote v4.6.0-local.g${COMMIT}\\n'\n`);
    await chmod(executable, 0o700);
    const executableSha256 = createHash('sha256')
      .update(await readFile(executable))
      .digest('hex');

    await expect(
      verifyCodeMemoryLinkEvaluatedSubject({executable, executableSha256, sourceCommit: COMMIT}),
    ).resolves.toMatchObject({
      executable,
      identity: {executableSha256, sourceCommit: COMMIT},
      version: `threadnote v4.6.0-local.g${COMMIT}`,
    });
    await expect(
      verifyCodeMemoryLinkEvaluatedSubject({
        executable,
        executableSha256: Effect.pipe('b', EffectString.repeat(64)),
        sourceCommit: COMMIT,
      }),
    ).rejects.toThrow(/differs from its preregistered hash/u);
    await expect(
      verifyCodeMemoryLinkEvaluatedSubject({
        executable,
        executableSha256,
        sourceCommit: Effect.pipe('c', EffectString.repeat(40)),
      }),
    ).rejects.toThrow(/version does not bind/u);

    const alias = join(root, 'threadnote-alias');
    await symlink(executable, alias);
    await expect(
      verifyCodeMemoryLinkEvaluatedSubject({executable: alias, executableSha256, sourceCommit: COMMIT}),
    ).rejects.toThrow(/non-symlink regular file/u);
  });
});
