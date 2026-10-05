import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from '@threadnote/testing/node-fs-promises';
import {tmpdir} from '@threadnote/testing/node-os';
import {join} from '@threadnote/testing/node-path';
import fc from 'fast-check';
import {afterEach, describe, expect, it} from 'vitest';
import {
  captureCodeMemoryLinkProcessGroup,
  codeMemoryLinkProcessGroupMembers,
} from '../../../../scripts/code-memory-link-process-boundary.js';
import {
  assertCodeMemoryLinkRepositorySnapshot,
  createCodeMemoryLinkRepositorySnapshot,
  removeCodeMemoryLinkRepositorySnapshot,
  type CodeMemoryLinkRepositorySnapshotV1,
} from '../../../../scripts/code-memory-link-repository-snapshot.js';
import {collectCodeMemoryLinkPublicArtifacts} from '../../../../scripts/code-memory-link-codex-judge.js';

describe('Code Memory Link evaluation boundaries', () => {
  const roots: string[] = [];
  const snapshots: CodeMemoryLinkRepositorySnapshotV1[] = [];

  afterEach(async () => {
    await Promise.all(snapshots.splice(0).map(snapshot => removeCodeMemoryLinkRepositorySnapshot(snapshot)));
    await Promise.all(roots.splice(0).map(root => rm(root, {force: true, maxRetries: 3, recursive: true})));
  });

  it('kills and observes an empty process group after a successful leader leaves a SIGTERM-resistant child', async () => {
    if (process.platform === 'win32') return;
    const root = await temporaryRoot(roots);
    const marker = join(root, 'descendant.pid');
    const helper = join(process.cwd(), 'packages/testing/src/code-memory-link-lingering-child.ts');
    const result = await captureCodeMemoryLinkProcessGroup({
      arguments: [helper, 'leader', marker],
      command: process.execPath,
      cwd: process.cwd(),
      environment: {HOME: root, PATH: process.env.PATH ?? '/usr/bin:/bin'},
      label: 'malicious descendant fixture',
      maxOutputBytes: 4_096,
      terminationGraceMilliseconds: 50,
      timeoutMilliseconds: 5_000,
    });

    const groupId = Number(result.stdout.trim());
    const descendantId = Number((await readFile(marker, 'utf8')).trim());
    expect(groupId).toBeGreaterThan(0);
    expect(descendantId).toBeGreaterThan(0);
    expect(descendantId).not.toBe(groupId);
    expect(await codeMemoryLinkProcessGroupMembers(groupId)).toEqual([]);
  });

  it('writes bounded string and byte stdin without changing process-group cleanup', async () => {
    if (process.platform === 'win32') return;
    const capture = (stdin: string | Uint8Array, label: string) =>
      captureCodeMemoryLinkProcessGroup({
        arguments: ['-e', "process.stdin.on('data', chunk => process.stdout.write(chunk));"],
        command: process.execPath,
        cwd: process.cwd(),
        environment: {PATH: process.env.PATH ?? '/usr/bin:/bin'},
        label,
        maxOutputBytes: 4_096,
        stdin,
        timeoutMilliseconds: 5_000,
      });

    const [stringResult, bytesResult] = await Promise.all([
      capture('bounded string stdin', 'string stdin fixture'),
      capture(new TextEncoder().encode('bounded byte stdin'), 'byte stdin fixture'),
    ]);
    expect(stringResult.stdout).toBe('bounded string stdin');
    expect(bytesResult.stdout).toBe('bounded byte stdin');
  });

  it('rejects stdin larger than the explicit boundary before spawning', async () => {
    if (process.platform === 'win32') return;
    await expect(
      captureCodeMemoryLinkProcessGroup({
        arguments: ['-e', 'process.stdin.resume()'],
        command: process.execPath,
        cwd: process.cwd(),
        environment: {PATH: process.env.PATH ?? '/usr/bin:/bin'},
        label: 'oversized stdin fixture',
        maxOutputBytes: 4_096,
        stdin: 'x'.repeat(1 * 1_024 * 1_024 + 1),
        timeoutMilliseconds: 5_000,
      }),
    ).rejects.toThrow('stdin exceeded its byte limit');
  });

  it('freezes one hash-bound tree used by both judge input verification and public inventory', async () => {
    const root = await temporaryRoot(roots);
    const source = join(root, 'source');
    await mkdir(join(source, 'src'), {recursive: true});
    await writeFile(join(source, 'src/service.ts'), 'export const value = 1;\n');
    await mkdir(join(source, '.git'));
    await writeFile(join(source, '.git/ignored'), 'mutable-control-data\n');
    const snapshot = await createCodeMemoryLinkRepositorySnapshot({
      destinationRoot: join(root, 'snapshot'),
      sourceRoot: source,
    });
    snapshots.push(snapshot);

    await writeFile(join(source, 'src/service.ts'), 'export const value = 2;\n');
    const files = await assertCodeMemoryLinkRepositorySnapshot(snapshot);
    const artifacts = await collectCodeMemoryLinkPublicArtifacts(snapshot);
    expect(files.map(file => file.relativePath)).toEqual(['src/service.ts']);
    expect(new TextDecoder().decode(files[0].bytes)).toContain('value = 1');
    expect(artifacts).toHaveLength(1);
    expect(snapshot.repositorySnapshotHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(await readFile(join(snapshot.root, 'src/service.ts'), 'utf8')).toContain('value = 1');
  });

  it('rejects source symlinks and hardlinks before a snapshot exists', async () => {
    const root = await temporaryRoot(roots);
    const symlinkSource = join(root, 'symlink-source');
    await mkdir(symlinkSource);
    await writeFile(join(root, 'outside.ts'), 'outside\n');
    await symlink(join(root, 'outside.ts'), join(symlinkSource, 'linked.ts'));
    await expect(
      createCodeMemoryLinkRepositorySnapshot({
        destinationRoot: join(root, 'symlink-snapshot'),
        sourceRoot: symlinkSource,
      }),
    ).rejects.toThrow('symlinks are forbidden');

    const hardlinkSource = join(root, 'hardlink-source');
    await mkdir(hardlinkSource);
    await writeFile(join(hardlinkSource, 'original.ts'), 'linked\n');
    await link(join(hardlinkSource, 'original.ts'), join(hardlinkSource, 'alias.ts'));
    await expect(
      createCodeMemoryLinkRepositorySnapshot({
        destinationRoot: join(root, 'hardlink-snapshot'),
        sourceRoot: hardlinkSource,
      }),
    ).rejects.toThrow('hardlinks are forbidden');
  });

  it('rejects a symlinked destination parent before writing into its target', async () => {
    const root = await temporaryRoot(roots);
    const source = join(root, 'source');
    await mkdir(source);
    await writeFile(join(source, 'value.txt'), 'source\n');
    const destinationAlias = join(root, 'destination-alias');
    await symlink(source, destinationAlias);

    await expect(
      createCodeMemoryLinkRepositorySnapshot({
        destinationRoot: join(destinationAlias, 'snapshot'),
        sourceRoot: source,
      }),
    ).rejects.toThrow('destination parent');
    await expect(readFile(join(source, 'snapshot/value.txt'), 'utf8')).rejects.toMatchObject({code: 'ENOENT'});
  });

  it('detects post-freeze mutation and has deterministic content identity', async () => {
    await fc.assert(
      fc.asyncProperty(fc.string({maxLength: 128}), async content => {
        const root = await temporaryRoot(roots);
        const [leftSource, rightSource] = [join(root, 'left'), join(root, 'right')];
        await Promise.all([mkdir(leftSource), mkdir(rightSource)]);
        await Promise.all([
          writeFile(join(leftSource, 'value.txt'), content),
          writeFile(join(rightSource, 'value.txt'), content),
        ]);
        const [left, right] = await Promise.all([
          createCodeMemoryLinkRepositorySnapshot({
            destinationRoot: join(root, 'left-snapshot'),
            sourceRoot: leftSource,
          }),
          createCodeMemoryLinkRepositorySnapshot({
            destinationRoot: join(root, 'right-snapshot'),
            sourceRoot: rightSource,
          }),
        ]);
        snapshots.push(left, right);
        expect(left.repositorySnapshotHash).toBe(right.repositorySnapshotHash);
      }),
      {numRuns: 12},
    );

    const root = await temporaryRoot(roots);
    const source = join(root, 'mutation-source');
    await mkdir(source);
    await writeFile(join(source, 'value.txt'), 'before\n');
    const snapshot = await createCodeMemoryLinkRepositorySnapshot({
      destinationRoot: join(root, 'mutation-snapshot'),
      sourceRoot: source,
    });
    snapshots.push(snapshot);
    await chmod(snapshot.root, 0o700);
    await chmod(join(snapshot.root, 'value.txt'), 0o600);
    await writeFile(join(snapshot.root, 'value.txt'), 'after\n');
    await expect(assertCodeMemoryLinkRepositorySnapshot(snapshot)).rejects.toThrow();
  });
});

async function temporaryRoot(roots: string[]): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'threadnote-code-memory-link-boundary-')));
  roots.push(root);
  return root;
}
