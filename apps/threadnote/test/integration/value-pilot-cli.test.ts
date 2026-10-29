import {Array as EffectArray} from 'effect';
import {execFile} from '@threadnote/testing/node-child-process';
import {mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile} from '@threadnote/testing/node-fs-promises';
import {tmpdir} from '@threadnote/testing/node-os';
import {join} from '@threadnote/testing/node-path';
import {promisify} from 'node:util';
import {afterEach, expect, it} from 'vitest';
import {inspectCliInvocation} from '@threadnote/threadnote/effect/cli';
import {pilotInput} from '../helpers/value-pilot-fixture.js';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

const exec = promisify(execFile);
const homes: string[] = [];
afterEach(async () => {
  await Promise.all(EffectArray.map(homes.splice(0), home => rm(home, {force: true, recursive: true})));
});

it('previews offline, exports only after apply, and resets with content-free receipts', async () => {
  const home = await mkdtemp(join(tmpdir(), 'value-pilot-cli-'));
  homes.push(home);
  const input = join(home, 'private-input.json');
  const day = Effect.pipe(new Date(Date.now() - 86_400_000).toISOString(), EffectString.slice(0, 10));
  const raw = JSON.stringify({...pilotInput(), windowStart: day, elapsedDays: 1});
  await writeFile(input, raw);
  const args = ['value', 'pilot', '--input', input];
  expect(inspectCliInvocation(args)).toMatchObject({
    offline: true,
    writeAnonymousTelemetry: false,
    writeProductionLog: false,
  });
  const preview = await run(args, home);
  expect(JSON.parse(preview.stdout)).toMatchObject({
    pilotSuccess: 'not-assessed',
    evidenceBasis: 'operator-supplied-observations',
  });
  expect(preview.stdout).not.toContain(home);
  await expect(readdir(join(home, 'exports', 'value-reports'))).rejects.toThrow();
  const applied = await run([...args, '--action', 'export', '--apply'], home);
  expect(JSON.parse(applied.stdout)).toMatchObject({applied: true, publication: 'none'});
  const names = await readdir(join(home, 'exports', 'value-reports'));
  expect(names).toHaveLength(1);
  expect(Effect.pipe(await readFile(join(home, 'exports', 'value-reports', names[0]), 'utf8'), EffectString.trim)).toBe(
    Effect.pipe(preview.stdout, EffectString.trim),
  );
  const reset = await run(['value', 'pilot', '--action', 'reset'], home);
  expect(JSON.parse(reset.stdout)).toMatchObject({applied: false, selected: 1, removed: 0, correlationRecords: 0});
  await run(
    ['value', 'pilot', '--action', 'reset', '--apply', '--selection-digest', JSON.parse(reset.stdout).selectionDigest],
    home,
  );
  expect(await readdir(join(home, 'exports', 'value-reports'))).toEqual([]);
  expect(await readFile(input, 'utf8')).toBe(raw);
});

it('redacts parser and filesystem failures', async () => {
  const home = await mkdtemp(join(tmpdir(), 'value-pilot-invalid-'));
  homes.push(home);
  const input = join(home, 'secret-repository-name.json');
  await writeFile(input, JSON.stringify({...pilotInput(), query: 'private query text'}));
  await expect(run(['value', 'pilot', '--input', input], home)).rejects.toMatchObject({
    stdout: '',
    stderr: expect.not.stringContaining('private query text'),
  });
  await expect(run(['value', 'pilot', '--action', 'secret-provider-name'], home)).rejects.toMatchObject({
    stdout: expect.not.stringContaining('secret-provider-name'),
    stderr: expect.not.stringContaining('secret-provider-name'),
  });
  await expect(run(['value', 'pilot', '--secret-provider-flag'], home)).rejects.toMatchObject({
    stdout: expect.not.stringContaining('secret-provider-flag'),
    stderr: expect.not.stringContaining('secret-provider-flag'),
  });
  await expect(run(['value', 'pilot', '--input', join(home, 'missing-secret')], home)).rejects.toMatchObject({
    stdout: '',
    stderr: expect.not.stringContaining('missing-secret'),
  });
});

it.each(['malformed', 'symlink'])('ignores %s persistent identity configuration for offline pilots', async kind => {
  const home = await mkdtemp(join(tmpdir(), 'value-pilot-identity-'));
  homes.push(home);
  await mkdir(join(home, 'cursor-cloud'));
  const profile = join(home, 'cursor-cloud', 'profile.json');
  if (kind === 'symlink') {
    await writeFile(join(home, 'secret-provider-profile'), 'private identity');
    await symlink(join(home, 'secret-provider-profile'), profile);
  } else await writeFile(profile, 'secret-provider-invalid');
  const input = join(home, 'input.json');
  await writeFile(input, JSON.stringify(pilotInput()));
  const result = await run(['value', 'pilot', '--input', input, '--manifest', join(home, 'secret-manifest')], home);
  expect(JSON.parse(result.stdout).pilotSuccess).toBe('not-assessed');
  expect(result.stderr).toBe('');
  await expect(run(['value', 'pilot', '--action', 'reset', '--apply'], home)).rejects.toMatchObject({
    stdout: '',
    stderr: expect.not.stringContaining(home),
  });
});

function run(args: readonly string[], home: string) {
  return exec(process.execPath, [join(process.cwd(), 'apps', 'threadnote', 'src', 'standalone.ts'), ...args], {
    env: {...process.env, NO_COLOR: '1', THREADNOTE_HOME: home, THREADNOTE_USER: 'local'},
  });
}
