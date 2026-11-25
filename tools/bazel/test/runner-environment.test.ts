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

  it('forwards only the two allowlisted native TypeScript variables, never over the fixed HOME and TMPDIR', () => {
    const root = mkdtempSync(join(tmpdir(), 'threadnote-bazel-inherit-'));
    try {
      const temporaryRoot = join(root, 'temporary');
      mkdirSync(temporaryRoot);
      const probe = join(root, 'probe.mjs');
      writeFileSync(
        probe,
        `process.stdout.write(JSON.stringify({asset: process.env.THREADNOTE_TYPESCRIPT_NATIVE_PREPARED_ASSET_DIR, required: process.env.THREADNOTE_NATIVE_TYPESCRIPT_REQUIRED, ci: process.env.CI, home: process.env.HOME, other: process.env.THREADNOTE_OTHER}));`,
      );
      const run = (inheritedEnv: readonly string[]) => {
        const manifest = join(root, 'manifest.json');
        writeFileSync(
          manifest,
          JSON.stringify({
            files: [{source: probe, destination: 'probe.mjs'}],
            args: ['probe.mjs'],
            env: {},
            inheritedEnv,
          }),
        );
        return Bun.spawnSync([process.execPath, resolve('tools/bazel/runner.mjs'), manifest, '--test'], {
          env: {
            ...process.env,
            TEST_TMPDIR: temporaryRoot,
            HOME: '/inherited-home',
            THREADNOTE_OTHER: 'host-secret',
            THREADNOTE_TYPESCRIPT_NATIVE_PREPARED_ASSET_DIR: '/fixed/prepared',
            THREADNOTE_NATIVE_TYPESCRIPT_REQUIRED: '1',
            CI: 'true',
          },
          stderr: 'pipe',
          stdout: 'pipe',
          timeout: 5_000,
        });
      };
      const allowed = run(['THREADNOTE_TYPESCRIPT_NATIVE_PREPARED_ASSET_DIR', 'THREADNOTE_NATIVE_TYPESCRIPT_REQUIRED']);
      expect(allowed.exitCode, allowed.stderr.toString()).toBe(0);
      const observed = JSON.parse(allowed.stdout.toString());
      expect(observed.asset).toBe('/fixed/prepared');
      // The required flag crosses, so a missing asset fails in CI; the generic CI variable itself does not.
      expect(observed.required).toBe('1');
      expect(observed.ci).toBeUndefined();
      expect(observed.other).toBeUndefined();
      expect(observed.home).not.toBe('/inherited-home');
      const undeclared = JSON.parse(run([]).stdout.toString());
      expect(undeclared.asset).toBeUndefined();
      expect(undeclared.required).toBeUndefined();
      const refused = run(['THREADNOTE_OTHER']);
      expect(refused.exitCode).not.toBe(0);
      expect(refused.stderr.toString()).toContain('may not inherit host variable THREADNOTE_OTHER');
    } finally {
      rmSync(root, {recursive: true, force: true});
    }
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
