import {Array as EffectArray, Predicate} from 'effect';
import {execFile} from '@threadnote/testing/node-child-process';
import {chmod, mkdir, mkdtemp, readFile, rm, writeFile} from '@threadnote/testing/node-fs-promises';
import {tmpdir} from '@threadnote/testing/node-os';
import {join} from '@threadnote/testing/node-path';
import {promisify} from 'node:util';
import {afterEach, describe, expect, it} from 'vitest';
import {createMemoryCodeCitation} from '@threadnote/memory/code/citation';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {formatMemoryDocument} from '@threadnote/memory/document';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

const execute = promisify(execFile);
const standalone = join(process.cwd(), 'apps', 'threadnote', 'src', 'standalone.ts');
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(EffectArray.map(roots.splice(0), root => rm(root, {recursive: true, force: true})));
});

describe('context check CLI', () => {
  it('returns clean JSON and a non-fatal warning for uncited changes without current graph evidence', async () => {
    const {home, repository} = await fixture();
    const clean = await runCli(['context', 'check', '--project', 'cli-test', '--json'], home, repository);
    expect(clean.code).toBe(0);
    expect(JSON.parse(clean.stdout)).toMatchObject({exitCode: 0, evidenceStatus: 'complete', findings: []});
    await writeFile(join(repository, 'new-file.ts'), 'export const added = true;');
    const changed = await runCli(['context', 'check', '--project', 'cli-test', '--json'], home, repository);
    expect(changed.code).toBe(0);
    expect(JSON.parse(changed.stdout)).toMatchObject({
      evidenceReason: expect.stringMatching(/^graph-impact-evidence-/u),
      evidenceStatus: 'unavailable',
      exitClassification: 'clean-with-evidence-warning',
      exitCode: 0,
      findings: [],
      version: 2,
    });
    await expect(readFile(join(home, 'data'), 'utf8')).rejects.toThrow();
  });

  it('does not let unrelated project health truncation block an empty diff', async () => {
    const {home, repository} = await fixture();
    const directory = join(home, 'data', 'local', 'user', 'local', 'memories', 'durable', 'projects', 'cli-test');
    await mkdir(directory, {recursive: true});
    await Promise.all(
      Array.from({length: 101}, (_, index) =>
        writeFile(
          join(directory, `expired-${index}.md`),
          formatMemoryDocument(
            'MEMORY',
            {
              kind: 'durable',
              project: 'cli-test',
              sourceAgentClient: 'test',
              status: 'active',
              timestamp: '2026-09-01T00:00:00.000Z',
              topic: `expired-${index}`,
              validTo: '2026-09-16T00:00:00.000Z',
            },
            `Expired unrelated memory ${index}.`,
          ),
        ),
      ),
    );

    const health = await runCli(['context', 'health', '--project', 'cli-test', '--json'], home, repository);
    expect(JSON.parse(health.stdout).omittedFindings).toBe(1);
    const result = await runCli(['context', 'check', '--project', 'cli-test', '--format', 'json'], home, repository);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({evidenceStatus: 'complete', exitCode: 0, findings: []});
  });

  it('fails closed when an initially clean worktree changes before the final read fence', async () => {
    const {home, repository} = await fixture();
    const wrapperDirectory = join(home, 'git-wrapper');
    const statePath = join(wrapperDirectory, 'diff-count');
    const racedPath = join(repository, 'source.ts');
    const actualGit = Effect.pipe((await execute('which', ['git'])).stdout, EffectString.trim);
    await mkdir(wrapperDirectory);
    await writeFile(
      join(wrapperDirectory, 'git'),
      `#!/bin/sh
if [ "$1" = "diff" ]; then
  count=0
  if [ -f '${statePath}' ]; then count=$(cat '${statePath}'); fi
  count=$((count + 1))
  printf '%s' "$count" > '${statePath}'
  if [ "$count" -eq 2 ]; then printf '%s\n' 'export const raced = true;' > '${racedPath}'; fi
fi
exec '${actualGit}' "$@"
`,
    );
    await chmod(join(wrapperDirectory, 'git'), 0o755);

    const result = await runCli(['context', 'check', '--project', 'cli-test', '--json'], home, repository, {
      PATH: `${wrapperDirectory}:${process.env.PATH ?? ''}`,
    });

    expect(result.code).toBe(2);
    expect(JSON.parse(result.stdout)).toMatchObject({
      evidenceReason: 'changed-path-evidence-unavailable',
      evidenceStatus: 'unavailable',
      exitCode: 2,
    });
  });

  it('supports the provider-neutral --format selector and rejects conflicting selectors', async () => {
    const {home, repository} = await fixture();
    const json = await runCli(['context', 'check', '--project', 'cli-test', '--format', 'json'], home, repository);
    expect(json.code).toBe(0);
    expect(JSON.parse(json.stdout)).toMatchObject({exitCode: 0, evidenceStatus: 'complete'});
    const conflicting = await runCli(
      ['context', 'check', '--project', 'cli-test', '--format', 'text', '--sarif'],
      home,
      repository,
    );
    expect(conflicting.code).toBe(2);
  });

  it('returns exit 2 and sanitized JSON/SARIF when Git evidence is unavailable', async () => {
    const {home, repository} = await fixture();
    for (const format of ['--json', '--sarif']) {
      const result = await runCli(
        ['context', 'check', '--project', 'cli-test', '--base', 'private-missing-ref', format],
        home,
        repository,
      );
      expect(result.code).toBe(2);
      expect(result.stdout).not.toContain('private-missing-ref');
      expect(result.stdout).not.toContain(repository);
      const report = JSON.parse(result.stdout);
      if (format === '--json')
        expect(report).toMatchObject({exitCode: 2, evidenceReason: 'changed-path-evidence-unavailable'});
      else expect(report.runs[0].results[0].ruleId).toBe('threadnote/context-check/evidence-unavailable');
    }
    const invalid = await runCli(['context', 'check', '--project', 'cli-test', '--json', '--sarif'], home, repository);
    expect(invalid.code).toBe(2);
    expect((await runCli(['context', 'check'], home, repository)).code).toBe(2);
    expect((await runCli(['context', 'check', '--project', 'cli-test', '--unknown-flag'], home, repository)).code).toBe(
      2,
    );
    expect((await runCli(['context', 'health'], home, repository)).code).toBe(1);
  }, 90_000);

  it('keeps cold-graph citations unknown and includes the deleted side of a rename', async () => {
    const {home, repository} = await fixture();
    const directory = join(home, 'data', 'local', 'user', 'local', 'memories', 'durable', 'projects', 'cli-test');
    await mkdir(directory, {recursive: true});
    const citation = createMemoryCodeCitation({
      extractorSet: 'test-extractor',
      fileContentHash: {algorithm: 'sha256', value: sha256HexSync('export const before = true;\n')},
      path: 'source.ts',
      repositoryId: sha256HexSync('repository-v1\ngithub.com/example/context-cli-test'),
      repositoryIdentityKind: 'remote',
      sourceCommit: Effect.pipe(
        (await execute('git', ['rev-parse', 'HEAD'], {cwd: repository})).stdout,
        EffectString.trim,
      ),
      sourceDirty: false,
      sourceSnapshotId: `cgsn_${Effect.pipe('a', EffectString.repeat(40))}`,
      target: {kind: 'file'},
      version: 1,
    });
    const memoryPath = join(directory, 'example.md');
    await writeFile(
      memoryPath,
      formatMemoryDocument(
        'MEMORY',
        {
          codeCitations: [citation],
          kind: 'durable',
          project: 'cli-test',
          schemaVersion: 5,
          sourceAgentClient: 'test',
          status: 'active',
          timestamp: '2026-09-01T00:00:00.000Z',
          topic: 'example',
        },
        'Private content never emitted by CI.',
      ),
    );
    const before = await readFile(memoryPath, 'utf8');
    await execute('git', ['mv', 'source.ts', 'renamed.ts'], {cwd: repository});
    const result = await runCli(['context', 'check', '--project', 'cli-test', '--json'], home, repository);
    expect(result.code).toBe(2);
    expect(JSON.parse(result.stdout).findings).toEqual(
      expect.arrayContaining([expect.objectContaining({category: 'citation-unknown'})]),
    );
    expect(result.stdout).not.toContain('Private content');
    expect(result.stdout).not.toContain('source.ts');
    expect(result.stdout).not.toContain('threadnote://');
    expect(await readFile(memoryPath, 'utf8')).toBe(before);
  });

  it('returns actionable exit 1 for an affected citation with exact-current changed evidence', async () => {
    const {home, repository} = await fixture();
    expect((await runCli(['graph', 'index', '--cwd', repository, '--json'], home, repository)).code).toBe(0);
    const remember = await runCli(
      [
        'remember',
        '--project',
        'cli-test',
        '--topic',
        'verified',
        '--text',
        'An invariant.',
        '--code-ref',
        'source.ts',
        '--require-current-code-refs',
      ],
      home,
      repository,
    );
    expect(remember.code, remember.stderr).toBe(0);
    await writeFile(join(repository, 'source.ts'), 'export const after = false;\n');
    expect((await runCli(['graph', 'index', '--cwd', repository, '--json'], home, repository)).code).toBe(0);
    const result = await runCli(['context', 'check', '--project', 'cli-test', '--json'], home, repository);
    expect(result.code, result.stdout).toBe(1);
    expect(JSON.parse(result.stdout).findings).toEqual(
      expect.arrayContaining([expect.objectContaining({category: 'citation-changed'})]),
    );
  }, 60_000);

  it('uses exact-current graph evidence when a distinct ancestor has no stored snapshot', async () => {
    const {home, repository} = await fixture();
    await writeFile(join(repository, 'source.ts'), 'export const committed = true;\n');
    await execute('git', ['add', 'source.ts'], {cwd: repository});
    await execute(
      'git',
      ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'second fixture'],
      {cwd: repository},
    );
    expect((await runCli(['graph', 'index', '--cwd', repository, '--json'], home, repository)).code).toBe(0);
    await writeFile(join(repository, 'source.ts'), 'export const dirty = true;\n');
    expect((await runCli(['graph', 'index', '--cwd', repository, '--json'], home, repository)).code).toBe(0);

    const result = await runCli(
      ['context', 'check', '--project', 'cli-test', '--base', 'HEAD~1', '--json'],
      home,
      repository,
    );

    expect(result.code, result.stdout).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({evidenceStatus: 'complete', exitCode: 1});
    expect(result.stdout).not.toContain('graph-impact-evidence');
  }, 90_000);

  it('reports an exact-current indirectly impacted memory from the code graph', async () => {
    const {home, repository} = await fixture();
    expect((await runCli(['graph', 'index', '--cwd', repository, '--json'], home, repository)).code).toBe(0);
    const remember = await runCli(
      [
        'remember',
        '--project',
        'cli-test',
        '--topic',
        'dependent-contract',
        '--text',
        'The dependent module relies on the source export.',
        '--code-ref',
        'dependent.ts',
        '--require-current-code-refs',
      ],
      home,
      repository,
    );
    expect(remember.code, remember.stderr).toBe(0);
    await writeFile(join(repository, 'source.ts'), 'export const before = false;\n');
    expect((await runCli(['graph', 'index', '--cwd', repository, '--json'], home, repository)).code).toBe(0);

    const result = await runCli(['context', 'check', '--project', 'cli-test', '--json'], home, repository);

    expect(result.code, result.stdout).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({evidenceStatus: 'complete', exitCode: 1});
    expect(JSON.parse(result.stdout).findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({category: 'graph-impact'}),
        expect.objectContaining({category: 'capture-advisory'}),
      ]),
    );
    expect(result.stdout).not.toContain('dependent.ts');
    expect(result.stdout).not.toContain('threadnote://');
  }, 90_000);
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'threadnote-context-check-'));
  roots.push(root);
  const home = join(root, 'home');
  const repository = join(root, 'repo');
  await mkdir(home);
  await mkdir(repository);
  await execute('git', ['init', '-q'], {cwd: repository});
  await execute('git', ['remote', 'add', 'origin', 'https://github.com/example/context-cli-test.git'], {
    cwd: repository,
  });
  await writeFile(join(repository, 'source.ts'), 'export const before = true;\n');
  await writeFile(
    join(repository, 'dependent.ts'),
    "import {before} from './source.js';\nexport const dependent = before;\n",
  );
  await execute('git', ['add', 'source.ts', 'dependent.ts'], {cwd: repository});
  await execute('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture'], {
    cwd: repository,
  });
  return {home, repository};
}

async function runCli(
  args: readonly string[],
  home: string,
  cwd: string,
  env: Readonly<Record<string, string | undefined>> = {},
) {
  try {
    const output = await execute(process.execPath, [standalone, ...args], {
      cwd,
      env: {...process.env, ...env, NO_COLOR: '1', THREADNOTE_HOME: home, THREADNOTE_USER: 'local'},
      maxBuffer: 2_097_152,
    });
    return {...output, code: 0};
  } catch (error) {
    if (
      !Predicate.isObject(error) ||
      typeof error.code !== 'number' ||
      typeof error.stdout !== 'string' ||
      typeof error.stderr !== 'string'
    ) {
      throw error;
    }
    return {code: error.code, stdout: error.stdout, stderr: error.stderr};
  }
}
