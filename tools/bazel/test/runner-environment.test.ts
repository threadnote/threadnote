import {mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from '@threadnote/testing/node-fs';
import {tmpdir} from '@threadnote/testing/node-os';
import {join, resolve} from '@threadnote/testing/node-path';
import {describe, expect, it} from 'vitest';

describe('Bazel test runner environment', () => {
  it('exposes Git to process-boundary integration tests', () => {
    const result = Bun.spawnSync(['git', '--version'], {stderr: 'pipe', stdout: 'pipe'});

    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(result.stdout.toString()).toMatch(/^git version /u);
  });

  it('does not inject product telemetry kill switches into the test process', () => {
    const source = readFileSync('tools/bazel/runner.mjs', 'utf8');

    expect(source).not.toContain('DO_NOT_TRACK:');
  });

  it.skipIf(process.platform !== 'darwin').each(['--test', '--workspace-test'])(
    'exposes real macOS hardware tools with a restricted incoming PATH in %s mode',
    mode => {
      const root = mkdtempSync(join(tmpdir(), 'threadnote-bazel-hardware-'));
      try {
        const temporaryRoot = join(root, 'temporary');
        mkdirSync(temporaryRoot);
        const probe = join(root, 'probe.mjs');
        writeFileSync(
          probe,
          `const cpu = Bun.spawnSync(['sysctl', '-n', 'machdep.cpu.brand_string']);
const memory = Bun.spawnSync(['sysctl', '-n', 'hw.memsize']);
const version = Bun.spawnSync(['sw_vers', '-productVersion']);
process.stdout.write(JSON.stringify({
  exitCodes: [cpu.exitCode, memory.exitCode, version.exitCode],
  cpu: cpu.stdout.toString().trim(),
  memoryBytes: Number(memory.stdout.toString().trim()),
  version: version.stdout.toString().trim(),
}));`,
        );
        const manifest = join(root, 'manifest.json');
        writeFileSync(
          manifest,
          JSON.stringify({
            files: [{source: probe, destination: 'probe.mjs'}],
            args: [mode === '--test' ? 'probe.mjs' : probe],
            env: {},
          }),
        );
        const result = Bun.spawnSync([process.execPath, resolve('tools/bazel/runner.mjs'), manifest, mode], {
          env: {...process.env, PATH: '/usr/bin:/bin', TEST_TMPDIR: temporaryRoot},
          stderr: 'pipe',
          stdout: 'pipe',
          timeout: 5_000,
        });

        expect(result.exitCode, result.stderr.toString()).toBe(0);
        const hardware = JSON.parse(result.stdout.toString());
        expect(hardware.exitCodes).toEqual([0, 0, 0]);
        expect(hardware.cpu.length).toBeGreaterThan(0);
        expect(hardware.memoryBytes).toBeGreaterThan(0);
        expect(hardware.version.length).toBeGreaterThan(0);
      } finally {
        rmSync(root, {recursive: true, force: true});
      }
    },
  );
});
