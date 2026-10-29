import {Array as EffectArray} from 'effect';
import {execFile} from '@threadnote/testing/node-child-process';
import {mkdtemp, readFile, rm, writeFile} from '@threadnote/testing/node-fs-promises';
import {tmpdir} from '@threadnote/testing/node-os';
import {join} from '@threadnote/testing/node-path';
import {promisify} from 'node:util';
import {afterEach, describe, expect, it} from 'vitest';
import {sha256HexSync} from '@threadnote/platform/sha256';

const execute = promisify(execFile);
const standalone = join(process.cwd(), 'apps', 'threadnote', 'src', 'standalone.ts');
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(EffectArray.map(roots.splice(0), root => rm(root, {recursive: true, force: true})));
});

describe('procedure CLI', () => {
  it('never executes during preview, dry-run, or status, including with --apply', async () => {
    const fixture = await makeFixture();
    for (const flags of [[], ['--apply', '--preview'], ['--apply', '--dry-run']]) {
      const result = await runCli(['procedure', 'verify', fixture.manifest, ...flags], fixture.root);
      expect(result.code, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({mode: 'preview', version: 1});
      await expect(readFile(fixture.marker, 'utf8')).rejects.toThrow();
    }
    const result = await runCli(
      ['procedure', 'status', fixture.manifest, '--artifact', fixture.artifact, '--json'],
      fixture.root,
    );
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({status: 'unverified', version: 1});
    await expect(readFile(fixture.marker, 'utf8')).rejects.toThrow();
  });

  it('emits a reusable receipt only after explicit execution with matching local bytes', async () => {
    const fixture = await makeFixture();
    const result = await runCli(
      ['procedure', 'verify', fixture.manifest, '--apply', '--artifact', fixture.artifact, '--json'],
      fixture.root,
    );
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({executedCommandIds: ['check'], receipt: {verifier: 'local-cli'}});
    expect(await readFile(fixture.marker, 'utf8')).toBe('verified');
    const receipt = join(fixture.root, 'receipt.json');
    await writeFile(receipt, result.stdout);
    const args = [
      'procedure',
      'status',
      fixture.manifest,
      '--artifact',
      fixture.artifact,
      '--receipt',
      receipt,
      '--json',
    ];
    expect(JSON.parse((await runCli(args, fixture.root)).stdout)).toEqual({status: 'current', version: 1});
    await writeFile(fixture.artifact, 'modified artifact');
    expect(JSON.parse((await runCli(args, fixture.root)).stdout)).toEqual({status: 'locally-modified', version: 1});
  });

  it('refuses missing or mismatched artifact evidence before executing', async () => {
    const fixture = await makeFixture();
    const missing = await runCli(['procedure', 'verify', fixture.manifest, '--apply'], fixture.root);
    expect(missing.code).not.toBe(0);
    await writeFile(fixture.artifact, 'wrong artifact');
    const mismatch = await runCli(
      ['procedure', 'verify', fixture.manifest, '--apply', '--artifact', fixture.artifact],
      fixture.root,
    );
    expect(mismatch.code).not.toBe(0);
    expect(mismatch.stdout).not.toContain('"receipt"');
    await expect(readFile(fixture.marker, 'utf8')).rejects.toThrow();
  });

  it('binds every fixture and suppresses receipts if commands change certified bytes', async () => {
    const fixture = await makeFixture();
    const fixturePath = join(fixture.root, 'fixture.txt');
    await writeFile(fixturePath, 'fixture');
    const manifest = JSON.parse(await readFile(fixture.manifest, 'utf8'));
    manifest.verification.fixtures = [{id: 'input', sha256: sha256HexSync('fixture')}];
    manifest.verification.commands = [
      {id: 'change', argv: [process.execPath, '-e', 'await Bun.write("artifact.txt", "changed");']},
    ];
    await writeFile(fixture.manifest, JSON.stringify(manifest));
    const args = ['procedure', 'verify', fixture.manifest, '--apply', '--artifact', fixture.artifact];
    const missingFixture = await runCli(args, fixture.root);
    expect(missingFixture.code).not.toBe(0);
    expect(await readFile(fixture.artifact, 'utf8')).toBe('artifact');
    const changed = await runCli([...args, '--fixture', `input=${fixturePath}`], fixture.root);
    expect(changed.code).not.toBe(0);
    expect(changed.stdout).not.toContain('"receipt"');
    expect(await readFile(fixture.artifact, 'utf8')).toBe('changed');
  });

  it('does not expose raw failed command output or accept remote manifests', async () => {
    const fixture = await makeFixture();
    const manifest = JSON.parse(await readFile(fixture.manifest, 'utf8'));
    manifest.verification.commands = [
      {
        id: 'fail',
        argv: [process.execPath, '-e', 'process.stderr.write("private-command-output\\n");process.exit(1);'],
      },
    ];
    await writeFile(fixture.manifest, JSON.stringify(manifest));
    const failed = await runCli(
      ['procedure', 'verify', fixture.manifest, '--apply', '--artifact', fixture.artifact],
      fixture.root,
    );
    expect(failed.code).not.toBe(0);
    expect(failed.stdout + failed.stderr).not.toContain('private-command-output');
    expect(failed.stdout).not.toContain('"receipt"');
    const remote = await runCli(['procedure', 'verify', 'https://example.invalid/procedure.json'], fixture.root);
    expect(remote.code).not.toBe(0);
  });

  it('reports an explicitly supplied newer local manifest as update-available', async () => {
    const fixture = await makeFixture();
    const availableManifest = join(fixture.root, 'procedure-available.json');
    const available = JSON.parse(await readFile(fixture.manifest, 'utf8'));
    available.artifact.semanticVersion = '1.1.0';
    await writeFile(availableManifest, JSON.stringify(available));

    const result = await runCli(
      [
        'procedure',
        'status',
        fixture.manifest,
        '--artifact',
        fixture.artifact,
        '--available-manifest',
        availableManifest,
        '--json',
      ],
      fixture.root,
    );

    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({status: 'update-available', version: 1});
  });
});

async function makeFixture() {
  const root = await mkdtemp(join(tmpdir(), 'threadnote-procedure-cli-'));
  roots.push(root);
  const artifact = join(root, 'artifact.txt');
  const marker = join(root, 'executed.txt');
  const manifest = join(root, 'procedure.json');
  await writeFile(artifact, 'artifact');
  await writeFile(
    manifest,
    JSON.stringify({
      artifact: {id: 'test/procedure', semanticVersion: '1.0.0', sha256: sha256HexSync('artifact')},
      compatible: {capabilities: [], surfaceIds: []},
      dependencies: [],
      owner: 'test',
      presentation: {summary: 'Run the reviewed test procedure.', taskKeywords: ['test']},
      relatedDurableMemoryIds: [],
      reviewedOn: '2026-09-17',
      rollout: {channel: 'stable', percentage: 100},
      schemaVersion: 2,
      verification: {
        commands: [{id: 'check', argv: [process.execPath, '-e', 'await Bun.write("executed.txt", "verified");']}],
        fixtures: [],
      },
    }),
  );
  return {artifact, manifest, marker, root};
}

async function runCli(args: readonly string[], root: string) {
  try {
    const output = await execute(process.execPath, [standalone, ...args], {
      // Different from manifest directory to verify the execution cwd contract.
      cwd: tmpdir(),
      env: {...process.env, NO_COLOR: '1', THREADNOTE_HOME: join(root, 'home'), THREADNOTE_USER: 'local'},
    });
    return {...output, code: 0};
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      typeof error.code === 'number' &&
      'stdout' in error &&
      typeof error.stdout === 'string' &&
      'stderr' in error &&
      typeof error.stderr === 'string'
    ) {
      return {code: error.code, stdout: error.stdout, stderr: error.stderr};
    }
    throw error;
  }
}
