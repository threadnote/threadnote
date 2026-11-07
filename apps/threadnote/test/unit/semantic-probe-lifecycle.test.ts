import {isJsonObject} from '@threadnote/platform/json';
import * as Schema from 'effect/Schema';
import * as EffectString from 'effect/String';
/* oxlint-disable effecttsgo/node-builtin-import -- Integration regressions exercise actual runner processes and OS signals. */
import {spawn} from 'node:child_process';
import {access, chmod, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {expect, it} from 'vitest';
import {
  withinProbeDeadline,
  ownedProbeGroup,
  releaseProbeHandles,
} from '../../../../tools/semantic/semantic_probe_process.js';
const fixture = resolve('apps/threadnote/test/fixtures/semantic/fake-provider.ts');
const quote = (value: string) => `'${EffectString.replaceAll("'", "'\\''")(value)}'`;
const observe = async (path: string) => {
  const deadline = performance.now() + 5000;
  while (performance.now() < deadline) {
    try {
      return Schema.decodeUnknownSync(
        Schema.Struct({
          pid: Schema.Finite,
          descendant: Schema.optional(Schema.Finite),
          cwd: Schema.String,
        }),
      )(JSON.parse(await readFile(path, 'utf8')));
    } catch {
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  }
  throw new Error('Owned process did not report startup');
};
const gone = (pid: number) => {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    if (isJsonObject(error) && error.code === 'ESRCH') return true;
    throw error;
  }
};
const reap = (pid: number) => {
  try {
    process.kill(-pid, 'SIGKILL');
  } catch (error) {
    if (!isJsonObject(error) || error.code !== 'ESRCH') throw error;
  }
};
it.skipIf(process.platform === 'win32')(
  'returns an unknown-exit receipt and releases handles when group signals are denied',
  async () => {
    const scratch = await mkdtemp(join(tmpdir(), 'semantic-denied-exit-test-'));
    const pidReceipt = join(scratch, 'pid.json');
    const output = join(scratch, 'result.json');
    const config = join(scratch, 'config.json');
    await writeFile(
      config,
      JSON.stringify({
        id: 'uncooperative-fixture',
        version: 'test',
        language: 'python',
        command: process.execPath,
        args: [fixture, 'deny-exit', pidReceipt],
      }),
    );
    const child = spawn(
      process.execPath,
      [
        '--preload',
        resolve('apps/threadnote/test/fixtures/semantic/deny-process-kill.ts'),
        'scripts/qualify-semantic-providers.ts',
        '--probe',
        '--config',
        config,
        '--output',
        output,
      ],
      {stdio: 'ignore', detached: true},
    );
    const exited = new Promise<number | null>(resolve => child.once('exit', resolve));
    const group = ownedProbeGroup(child);
    let owned: Awaited<ReturnType<typeof observe>> | undefined;
    try {
      owned = await observe(pidReceipt);
      expect(await withinProbeDeadline(exited, 10000)).toBe(1);
      const report = JSON.parse(await readFile(output, 'utf8'));
      expect(report).toMatchObject({
        scratchRetained: true,
        stop: {exitObserved: false, exitTimedOut: true, code: null, signal: null, cleanup: {drained: false}},
      });
      expect(gone(owned.pid)).toBe(false);
      await access(owned.cwd);
    } finally {
      if (owned) {
        reap(owned.pid);
        await rm(owned.cwd, {recursive: true, force: true});
      }
      await group.cleanup();
      releaseProbeHandles(child);
      await rm(scratch, {recursive: true, force: true});
    }
  },
  15000,
);
it.skipIf(process.platform === 'win32').each([
  ['provider', 'SIGINT'],
  ['provider', 'SIGTERM'],
  ['editor', 'SIGINT'],
  ['editor', 'SIGTERM'],
] as const)(
  'cleans the live owned %s group on %s',
  async (kind, signal) => {
    const scratch = await mkdtemp(join(tmpdir(), 'semantic-interrupt-test-'));
    const pidReceipt = join(scratch, 'pid.json');
    const output = join(scratch, 'result.json');
    let args: string[];
    if (kind === 'provider') {
      const config = join(scratch, 'config.json');
      await writeFile(
        config,
        JSON.stringify({
          id: 'interrupt-fixture',
          version: 'test',
          language: 'python',
          command: process.execPath,
          args: [fixture, 'interrupt-provider', pidReceipt],
        }),
      );
      args = ['scripts/qualify-semantic-providers.ts', '--probe', '--config', config, '--output', output];
    } else {
      const editor = join(scratch, 'editor');
      await writeFile(
        editor,
        `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(fixture)} interrupt-editor ${quote(pidReceipt)} "$@"\n`,
      );
      await chmod(editor, 0o755);
      args = ['scripts/qualify-semantic-editors.ts', '--probe', '--editor', editor, '--output', output];
    }
    const child = spawn(process.execPath, args, {stdio: 'ignore', detached: true});
    const exited = new Promise<number | null>(resolve => child.once('exit', resolve));
    const group = ownedProbeGroup(child);
    let owned: Awaited<ReturnType<typeof observe>> | undefined;
    try {
      owned = await observe(pidReceipt);
      expect(gone(owned.pid)).toBe(false);
      child.kill(signal);
      expect(await withinProbeDeadline(exited, 10000)).toBe(signal === 'SIGINT' ? 130 : 143);
      const report = JSON.parse(await readFile(output, 'utf8'));
      expect(report).toMatchObject({status: 'interrupted', signal, scratchRetained: false});
      expect(kind === 'provider' ? report.stop.cleanup.drained : report.cleanup.drained).toBe(true);
      expect(gone(owned.pid)).toBe(true);
      expect(gone(owned.descendant!)).toBe(true);
      await expect(access(owned.cwd)).rejects.toThrow();
    } finally {
      if (owned) reap(owned.pid);
      await group.cleanup();
      releaseProbeHandles(child);
      await rm(scratch, {recursive: true, force: true});
    }
  },
  15000,
);
