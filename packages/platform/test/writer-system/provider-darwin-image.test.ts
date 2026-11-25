import {mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, copyFileSync, existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Schema} from 'effect';
import {afterAll, beforeAll, expect, it} from 'vitest';
import {RuntimeWriterFault} from '../../src/writer-system/fault.js';
import {
  runtimeCloseOwnedProviderTree,
  runtimeObserveOwnedProviderTree,
  runtimeSpawnOwnedProviderTree,
  type RuntimeOwnedProviderExpectedDarwinImage,
} from '../../src/system.js';

/**
 * Kernel image binding at the owned-process boundary (POSIX_SPAWN_START_SUSPENDED, csops, SIGCONT or SIGKILL). These
 * are operating-system process tests, so they use plain Vitest. The subject is a tiny clang-built program, signed
 * ad-hoc on private copies only; it creates the file named by its argument, then reads one 16 KiB page of constants.
 */
const darwin = process.platform === 'darwin';
const tools =
  darwin && existsSync('/usr/bin/codesign') && Bun.spawnSync(['/usr/bin/xcrun', '--find', 'clang']).exitCode === 0;
const program = String.raw`
#include <fcntl.h>
#include <stdio.h>
#include <unistd.h>
/* The marker sits alone in the middle of three pages of constants, so reading it touches only its own page. */
__attribute__((used)) static const char block[49152] = {[24576] = 'R', [24577] = 'E', [24578] = 'V', [24579] = 'I',
  [24580] = 'E', [24581] = 'W', [24582] = 'E', [24583] = 'D', [24584] = '-', [24585] = 'P', [24586] = 'A',
  [24587] = 'G', [24588] = 'E'};
volatile int at = 24576;
int main(int argc, char **argv) {
  if (argc > 1) { int fd = open(argv[1], O_CREAT | O_WRONLY, 0600); if (fd >= 0) close(fd); }
  printf("ran %c\n", block[at]);
  return 0;
}
`;
// The macOS release-smoke legs run these tests: there a missing toolchain fails at load instead of skipping them all
// (Vitest does not run beforeAll when every test is skipped).
if (darwin && !tools && process.env.CI) throw new Error('codesign and clang are required on macOS CI.');
let directory = '';
const signed: Record<string, {readonly path: string; readonly cdhash: string}> = {};
let launches = 0;

function run(command: string, args: readonly string[]): string {
  const result = Bun.spawnSync([command, ...args], {stdout: 'pipe', stderr: 'pipe'});
  if (result.exitCode !== 0) throw new Error(`${command} failed: ${result.stderr.toString()}`);
  return `${result.stdout.toString()}${result.stderr.toString()}`;
}
const cdhashOf = (path: string) => {
  const match = /^CDHash=([0-9a-f]{40})$/mu.exec(run('/usr/bin/codesign', ['-dvvv', path]));
  if (!match) throw new Error('codesign reported no cdhash');
  return match[1];
};
function variant(name: string, source: string, sign: readonly string[] | undefined) {
  const path = join(directory, name);
  copyFileSync(source, path);
  if (sign) run('/usr/bin/codesign', ['--force', '-s', '-', ...sign, path]);
  signed[name] = {path, cdhash: cdhashOf(path)};
}

beforeAll(() => {
  if (!tools) return;
  directory = realpathSync(mkdtempSync(join(tmpdir(), 'threadnote-darwin-image-')));
  writeFileSync(join(directory, 'program.c'), program);
  run('/usr/bin/xcrun', ['clang', '-O0', '-o', join(directory, 'program'), join(directory, 'program.c')]);
  writeFileSync(
    join(directory, 'debug.plist'),
    '<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>com.apple.security.get-task-allow</key><true/></dict></plist>',
  );
  const source = join(directory, 'program');
  variant('runtime', source, ['--options', 'runtime', '--identifier', 'dev.threadnote.image-test']);
  variant('plain', source, ['--identifier', 'dev.threadnote.image-test']);
  variant('debuggable', source, ['--options', 'runtime', '--entitlements', join(directory, 'debug.plist')]);
  // Same CodeDirectory as `runtime`, one changed byte in the marker page: the cdhash still matches.
  const tampered = join(directory, 'tampered');
  copyFileSync(signed.runtime.path, tampered);
  const bytes = readFileSync(tampered);
  const marker = bytes.indexOf('REVIEWED-PAGE');
  if (marker < 0) throw new Error('marker not found');
  bytes[marker + 1] = 0x58;
  writeFileSync(tampered, bytes);
  signed.tampered = {path: tampered, cdhash: signed.runtime.cdhash};
});
afterAll(() => {
  if (directory) rmSync(directory, {recursive: true, force: true});
});

async function launch(name: string, image: RuntimeOwnedProviderExpectedDarwinImage) {
  const marker = join(directory, `${name}-${(launches += 1)}.ran`);
  const provider = runtimeSpawnOwnedProviderTree({
    command: signed[name].path,
    args: [marker],
    cwd: directory,
    environment: {},
    expectedDarwinImage: image,
  });
  const stdout = new Response(provider.stdout).text(),
    stderr = new Response(provider.stderr).text();
  await provider.closeInput();
  const [output] = await Promise.all([stdout, stderr]);
  const until = Date.now() + 10_000;
  let observation = runtimeObserveOwnedProviderTree(provider.handle);
  while (observation.state !== 'drained' && Date.now() < until) {
    await Bun.sleep(5);
    observation = runtimeObserveOwnedProviderTree(provider.handle);
  }
  expect(observation.state).toBe('drained');
  runtimeCloseOwnedProviderTree(provider.handle);
  return {output, exitCode: observation.leaderExitCode, ran: existsSync(marker)};
}
/** A refused launch throws the typed reason; the child was killed before it created its marker. */
function refused(name: string, image: RuntimeOwnedProviderExpectedDarwinImage) {
  const marker = join(directory, `${name}-${(launches += 1)}.ran`);
  let reason: string | undefined;
  try {
    runtimeSpawnOwnedProviderTree({
      command: signed[name].path,
      args: [marker],
      cwd: directory,
      environment: {},
      expectedDarwinImage: image,
    });
  } catch (error) {
    reason = Schema.is(RuntimeWriterFault)(error) ? error.reason : String(error);
  }
  return {reason, ran: existsSync(marker)};
}

it.skipIf(!tools)('resumes an image the kernel reports with the expected cdhash and hardened runtime', async () => {
  await expect(launch('runtime', {cdhash: signed.runtime.cdhash, requireRuntime: true})).resolves.toEqual({
    output: 'ran R\n',
    exitCode: 0,
    ran: true,
  });
});

it.skipIf(!tools)('kills a refused image while suspended and does not quarantine the next launch', async () => {
  const cases: readonly [string, RuntimeOwnedProviderExpectedDarwinImage][] = [
    ['runtime', {cdhash: signed.plain.cdhash, requireRuntime: true}],
    ['plain', {cdhash: signed.plain.cdhash, requireRuntime: true}],
    ['debuggable', {cdhash: signed.debuggable.cdhash, requireRuntime: true}],
  ];
  for (const [name, image] of cases) {
    expect(refused(name, image), name).toEqual({reason: 'image-mismatch', ran: false});
    // The refused child was reaped within the bound, so the very next launch is admitted.
    await expect(launch('runtime', {cdhash: signed.runtime.cdhash, requireRuntime: true})).resolves.toMatchObject({
      exitCode: 0,
      ran: true,
    });
  }
});

it.skipIf(!tools || process.arch !== 'arm64')(
  'admits an image without the hardened runtime only when the runtime is not required',
  async () => {
    // arm64 kernels run every image with CS_KILL; this is the source-mode linker-signed shape.
    await expect(launch('plain', {cdhash: signed.plain.cdhash, requireRuntime: false})).resolves.toMatchObject({
      exitCode: 0,
      ran: true,
    });
  },
);

it.skipIf(!tools)('lets the kernel kill an image whose executed page differs from its CodeDirectory', async () => {
  // The cdhash binding passes: the CodeDirectory is unchanged. CS_KILL then ends the child when it touches the page.
  const result = await launch('tampered', {cdhash: signed.tampered.cdhash, requireRuntime: true});
  expect(result.output).toBe('');
  expect(result.exitCode).toBe(128 + 9);
});

it.skipIf(darwin)('refuses an expected Darwin image on other platforms before launch', () => {
  let reason: string | undefined;
  try {
    runtimeSpawnOwnedProviderTree({
      command: process.execPath,
      args: ['-e', 'process.exit(0)'],
      cwd: process.cwd(),
      environment: {},
      expectedDarwinImage: {cdhash: '0000000000000000000000000000000000000000', requireRuntime: true},
    });
  } catch (error) {
    reason = Schema.is(RuntimeWriterFault)(error) ? error.reason : String(error);
  }
  expect(reason).toBe('unsupported-platform');
});
