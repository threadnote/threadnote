import {describe, expect, it} from 'vitest';
import {
  NATIVE_TYPESCRIPT_PREPARED_ASSET_ENV,
  nativeTypeScriptHostKey,
  nativeTypeScriptReviewedBinarySha256,
} from '@threadnote/graph/typescript_native_asset_pins';
import {nativeTypeScriptSourceModeRefused} from '../helpers/native-typescript-session.js';

// The gate decides at module load, so each case imports it in a child process with a controlled environment.
const gate = Bun.fileURLToPath(new URL('../helpers/native-typescript-session.ts', import.meta.url));
const REQUIRED = 'THREADNOTE_NATIVE_TYPESCRIPT_REQUIRED';
const load = (environment: Record<string, string | undefined>) =>
  Bun.spawnSync(
    [
      process.execPath,
      '--eval',
      `const m = await import(${JSON.stringify(gate)}); process.stdout.write(m.nativeTypeScriptSkipReason ?? 'runs');`,
    ],
    {env: {...process.env, ...environment}, stderr: 'pipe', stdout: 'pipe', timeout: 30_000},
  );
const host = nativeTypeScriptHostKey(process.platform, process.arch);
const pinned = nativeTypeScriptReviewedBinarySha256(host) !== undefined;
const absent = {[NATIVE_TYPESCRIPT_PREPARED_ASSET_ENV]: undefined};

describe('native TypeScript test gate', () => {
  for (const ci of [undefined, '', '0', 'false', 'FALSE'])
    it(`skips visibly without the prepared asset when CI is ${JSON.stringify(ci)}`, () => {
      const result = load({...absent, CI: ci, [REQUIRED]: undefined});
      expect(result.exitCode, result.stderr.toString()).toBe(0);
      expect(result.stdout.toString()).toBe(
        pinned ? `${NATIVE_TYPESCRIPT_PREPARED_ASSET_ENV} is not set` : `no reviewed native TypeScript pin for ${host}`,
      );
    });

  for (const required of [{CI: '1'}, {CI: 'true'}, {CI: undefined, [REQUIRED]: '1'}])
    it(`fails instead of skipping on a reviewed-pin host without the asset (${JSON.stringify(required)})`, () => {
      const result = load({...absent, [REQUIRED]: undefined, ...required});
      if (pinned) {
        expect(result.exitCode).not.toBe(0);
        expect(result.stderr.toString()).toContain(`must provide ${NATIVE_TYPESCRIPT_PREPARED_ASSET_ENV}`);
      } else {
        // Windows and unpinned hosts have nothing to provision, so they still skip visibly.
        expect(result.exitCode, result.stderr.toString()).toBe(0);
        expect(result.stdout.toString()).toContain('no reviewed native TypeScript pin');
      }
    });

  it('runs when the asset is configured, whether or not it is required', () => {
    for (const required of [{CI: undefined}, {CI: '1'}]) {
      // Configuration alone decides; the asset itself is verified only when a test opens a session.
      const result = load({...required, [NATIVE_TYPESCRIPT_PREPARED_ASSET_ENV]: '/configured/prepared'});
      expect(result.exitCode, result.stderr.toString()).toBe(0);
      const configuredReason = nativeTypeScriptSourceModeRefused
        ? 'this macOS kernel refuses the source-mode compiler (image-mismatch: kill)'
        : 'runs';
      expect(result.stdout.toString()).toBe(pinned ? configuredReason : `no reviewed native TypeScript pin for ${host}`);
    }
  });
});
