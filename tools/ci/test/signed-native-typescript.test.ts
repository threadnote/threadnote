import {copyFile, mkdtemp, open, realpath, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {Array as EffectArray, Schema} from 'effect';
import {
  nativeTypeScriptHostKey,
  nativeTypeScriptReviewedBinarySha256,
} from '@threadnote/graph/typescript_native_asset_pins';
import {MachOCodeIdentityError} from '../macho-code-identity.js';
import {
  RELEASE_APPLE_TEAM_ID,
  SIGNED_NATIVE_TYPESCRIPT_IDENTIFIER,
  assertSigningTeam,
  developerIdRequirement,
  releaseAppleTeamId,
  isSignedNativeTypeScriptHost,
  signedNativeTypeScriptCanonicalForms,
  verifySignedNativeTypeScript,
} from '../signed-native-typescript.js';

/**
 * The publish verifier against ad-hoc signed copies of the reviewed prepared compiler (macOS with the prepared asset
 * only). Ad-hoc signing takes the same codesign path as Developer ID except for the CMS blob; only the Team ID
 * requirement needs the real identity, so here it must refuse.
 */
const host = nativeTypeScriptHostKey(process.platform, process.arch);
const prepared = process.env.THREADNOTE_TYPESCRIPT_NATIVE_PREPARED_ASSET_DIR;
const darwin = process.platform === 'darwin' && isSignedNativeTypeScriptHost(host);
const enabled = darwin && prepared !== undefined;
// The macOS release-smoke legs restore the asset and export THREADNOTE_NATIVE_TYPESCRIPT_REQUIRED: never skip there.
if (darwin && prepared === undefined && ['1', 'true'].includes(process.env.THREADNOTE_NATIVE_TYPESCRIPT_REQUIRED ?? ''))
  throw new Error(
    'THREADNOTE_TYPESCRIPT_NATIVE_PREPARED_ASSET_DIR is required for the signed compiler verifier tests.',
  );
const reference = prepared === undefined ? '' : join(prepared, 'tsc');
let directory = '';

async function codesign(args: readonly string[]): Promise<void> {
  const child = Bun.spawn(['/usr/bin/codesign', ...args], {stdout: 'ignore', stderr: 'pipe'});
  const [status, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  if (status !== 0) throw new Error(`codesign ${EffectArray.join(args, ' ')} failed: ${stderr}`);
}
/** A private copy of the reviewed compiler, optionally changed at one offset, then signed ad-hoc. */
async function signedCopy(name: string, sign: readonly string[], change?: number): Promise<string> {
  const path = join(directory, name);
  await copyFile(reference, path);
  if (change !== undefined) {
    const handle = await open(path, 'r+');
    try {
      await handle.write(new Uint8Array([0x5a]), 0, 1, change);
    } finally {
      await handle.close();
    }
  }
  await codesign(['--force', '-s', '-', ...sign, path]);
  return path;
}
const release = ['--options', 'runtime,kill,hard', '--identifier', SIGNED_NATIVE_TYPESCRIPT_IDENTIFIER];
async function violations(executable: string, requirement?: string): Promise<readonly string[]> {
  try {
    await verifySignedNativeTypeScript({
      host: isSignedNativeTypeScriptHost(host) ? host : 'darwin-arm64',
      executable,
      reference,
      ...(requirement === undefined ? {} : {requirement}),
    });
  } catch (error) {
    if (Schema.is(MachOCodeIdentityError)(error)) return error.violations;
    throw error;
  }
  return [];
}

describe('release Apple Team ID', () => {
  it('requires the committed release team and refuses a malformed value or another team', () => {
    expect(releaseAppleTeamId()).toBe(RELEASE_APPLE_TEAM_ID);
    expect(() => assertSigningTeam(RELEASE_APPLE_TEAM_ID)).not.toThrow();
    expect(() => assertSigningTeam('ZYXWV98765')).toThrow('does not belong');
    expect(() => assertSigningTeam('')).toThrow('does not belong');
    for (const malformed of ['UNSET-APPLE-TEAM-ID', 'abcde12345', 'abc"; true'])
      expect(() => releaseAppleTeamId(malformed), malformed).toThrow('not set');
    expect(() => developerIdRequirement('abc"; true')).toThrow('not set');
    expect(developerIdRequirement()).toContain(`certificate leaf[subject.OU] = "${RELEASE_APPLE_TEAM_ID}"`);
  });
});

it('binds the canonical forms to exactly the reviewed darwin pins', () => {
  expect(nativeTypeScriptReviewedBinarySha256('darwin-arm64')).toBe(
    '6453082c0e4fa16b78a37106fce911d0df9b79192025a1b4fdecdf92286e3c47',
  );
  expect(signedNativeTypeScriptCanonicalForms['darwin-x64']).toMatchObject({
    form: 'unsigned-origin-v1',
    sha256: '0bff3b247bf35c5cc8f7544c665cd5cfaaacfa424400ca6e956d777ca3397458',
  });
  expect(signedNativeTypeScriptCanonicalForms['darwin-arm64']).toMatchObject({
    form: 'macho-code-v1',
    sha256: '04ca16a8f2f0d831a2eb0bff378e15e4cc73e77508e0834dbd02db29eb22af0d',
  });
});

describe.skipIf(!enabled)('signed native TypeScript publish verifier', () => {
  beforeAll(async () => {
    directory = await realpath(await mkdtemp(join(tmpdir(), 'threadnote-signed-tsc-')));
  });
  afterAll(async () => {
    if (directory) await rm(directory, {recursive: true, force: true});
  });

  it('records the exact signed digest and cdhash of a policy-compliant hardened runtime signature', async () => {
    const executable = await signedCopy('tsc.release', release);
    const record = await verifySignedNativeTypeScript({
      host: isSignedNativeTypeScriptHost(host) ? host : 'darwin-arm64',
      executable,
      reference,
      // The mechanism of the requirement check, with a requirement an ad-hoc signature can satisfy.
      requirement: `identifier "${SIGNED_NATIVE_TYPESCRIPT_IDENTIFIER}"`,
    });
    const canonical = signedNativeTypeScriptCanonicalForms[record.host];
    expect(record).toMatchObject({
      identifier: SIGNED_NATIVE_TYPESCRIPT_IDENTIFIER,
      canonicalForm: canonical.form,
      canonicalSha256: canonical.sha256,
      codeLimit: expect.any(Number),
    });
    expect(record.sha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(record.cdhash).toMatch(/^[0-9a-f]{40}$/u);
    const displayed = Bun.spawnSync(['/usr/bin/codesign', '-dvvv', executable], {stderr: 'pipe'}).stderr.toString();
    expect(displayed).toContain(`CDHash=${record.cdhash}`);
    expect(Bun.SHA256.hash(await Bun.file(executable).bytes(), 'hex')).toBe(record.sha256);
  });

  it('refuses the Developer ID Team requirement for an ad-hoc signature', async () => {
    const executable = await signedCopy('tsc.team', release);
    const refused = await violations(executable, developerIdRequirement('ABCDE12345'));
    expect(refused).toHaveLength(1);
    expect(refused[0]).toMatch(/^codesign requirement check failed with status 3/u);
  });

  it('refuses a signed binary whose code differs from the reviewed binary', async () => {
    const executable = await signedCopy('tsc.changed', release, 20_000_000);
    expect(await violations(executable)).toEqual([
      `${signedNativeTypeScriptCanonicalForms[isSignedNativeTypeScriptHost(host) ? host : 'darwin-arm64'].form} digest differs from the reviewed binary`,
    ]);
  });

  it('refuses added entitlements', async () => {
    const entitlements = join(directory, 'debug.plist');
    await writeFile(
      entitlements,
      '<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>com.apple.security.get-task-allow</key><true/></dict></plist>',
    );
    const executable = await signedCopy('tsc.entitlements', [...release, '--entitlements', entitlements]);
    expect(await violations(executable)).toEqual(['forbidden superblob slot 0x5', 'forbidden superblob slot 0x7']);
  });

  it('refuses a signature without the hardened runtime', async () => {
    const executable = await signedCopy('tsc.no-runtime', ['--identifier', SIGNED_NATIVE_TYPESCRIPT_IDENTIFIER]);
    expect(await violations(executable)).toEqual([
      'hardened runtime flag is not set',
      'kill flag is not set',
      'hard flag is not set',
    ]);
  });

  it('refuses a hardened runtime signature without the kill and hard flags', async () => {
    const runtimeOnly = ['--options', 'runtime', '--identifier', SIGNED_NATIVE_TYPESCRIPT_IDENTIFIER];
    const executable = await signedCopy('tsc.runtime-only', runtimeOnly);
    expect(await violations(executable)).toEqual(['kill flag is not set', 'hard flag is not set']);
  });

  it('refuses an extra CodeDirectory', async () => {
    const executable = await signedCopy('tsc.two-directories', [...release, '--digest-algorithm=sha1,sha256']);
    const refused = await violations(executable);
    expect(refused).toContain('forbidden superblob slot 0x1000');
    expect(refused).toContain('expected one CodeDirectory, found 2');
  });

  it('refuses a reference payload that is not the reviewed binary', async () => {
    const executable = await signedCopy('tsc.reference', release);
    await expect(
      verifySignedNativeTypeScript({
        host: isSignedNativeTypeScriptHost(host) ? host : 'darwin-arm64',
        executable,
        reference: executable,
      }),
    ).rejects.toThrow('reference payload is not the reviewed binary');
  });
});
