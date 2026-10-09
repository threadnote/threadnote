import {TestError} from '@threadnote/testing/test-error';
import {
  chmod,
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from '@threadnote/testing/node-fs-promises';
import {tmpdir} from '@threadnote/testing/node-os';
import {dirname, join} from '@threadnote/testing/node-path';
import {execFile} from '@threadnote/testing/node-child-process';
import {promisify} from '@threadnote/testing/node-util';
import {Database} from 'bun:sqlite';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {afterAll, beforeAll, describe, expect, it, vi} from 'vitest';
import {windowsCommandLauncherInvocation} from '@threadnote/testing/windows-command-launcher';
import {BUILTIN_MODEL_MANIFESTS, CORE_EMBEDDING_MODEL_ID} from '@threadnote/inference/models/builtin';
import {recallIndexDatabaseFilename} from '@threadnote/recall/index';
import {vectorIndexDatabaseFilename} from '@threadnote/recall/vector-index';

const execute = promisify(execFile);
const root = process.cwd();
const cli = join(root, 'dist', process.platform === 'win32' ? 'threadnote.exe' : 'threadnote');
const coreEmbeddingModelId = CORE_EMBEDDING_MODEL_ID;
const coreEmbeddingManifest = BUILTIN_MODEL_MANIFESTS.find(candidate => candidate.id === coreEmbeddingModelId);
const realModelTimeoutMs = 300_000;
const coldGraphReadTimeoutMs = process.platform === 'win32' && process.arch === 'arm64' ? 60_000 : 25_000;
const cliOutputMaxBytes = 16 * 1024 * 1024;
let home: string;
let temporaryRoot: string;
let userHome: string;
let graphRepository: string;
let installedModelPath: string;
let installedModelModifiedAt: number;
let initialVectorRevision: string;
let installOutput: string;
let installedFiles: string[];

function installedLauncher(
  mode: 'cli' | 'mcp' = 'cli',
  kind: 'cmd' | 'posix' = process.platform === 'win32' ? 'cmd' : 'posix',
): string {
  const command = mode === 'mcp' ? 'threadnote-mcp-server' : 'threadnote';
  const binDirectory =
    process.platform === 'win32'
      ? join(userHome, 'AppData', 'Local', 'Threadnote', 'bin')
      : join(userHome, '.local', 'bin');
  return join(binDirectory, kind === 'cmd' ? `${command}.cmd` : command);
}

beforeAll(async () => {
  temporaryRoot = await mkdtemp(join(tmpdir(), 'threadnote-native-e2e-'));
  userHome = join(temporaryRoot, 'user-home');
  home = join(userHome, '.threadnote');
  graphRepository = join(temporaryRoot, 'code-graph-repository');
  await mkdir(join(home, 'cache'), {recursive: true});
  await mkdir(userHome, {recursive: true});
  await cp(
    join(root, 'apps', 'threadnote', 'test', 'evaluation', 'fixtures', 'code-graph-v1', 'repository'),
    graphRepository,
    {
      recursive: true,
    },
  );
  await runGit(['init', '-b', 'main'], graphRepository);
  await runGit(['config', 'user.email', 'threadnote-e2e@example.com'], graphRepository);
  await runGit(['config', 'user.name', 'Threadnote E2E'], graphRepository);
  await runGit(['add', '.'], graphRepository);
  await runGit(['commit', '-m', 'code graph fixture'], graphRepository);
  await seedCoreEmbeddingFixture();
  await writeFile(join(home, 'cache', 'recall-index-v6.json'), '{"legacy":true}\n', 'utf8');
  installOutput = await runCli(['install']);
  installedFiles = await readdir(home, {recursive: true});
  const selection = JSON.parse(await readFile(join(home, 'models', 'selection.json'), 'utf8')) as {
    readonly roles?: {readonly embedding?: string};
  };
  expect(selection.roles?.embedding).toBe(coreEmbeddingModelId);
  const receipt = JSON.parse(
    await readFile(join(home, 'models', 'embedding', coreEmbeddingModelId, 'manifest.json'), 'utf8'),
  ) as {readonly sha256: string; readonly size: number};
  installedModelPath = join(home, 'models', 'embedding', coreEmbeddingModelId, `${receipt.sha256}.gguf`);
  const installedModel = await stat(installedModelPath);
  expect(installedModel.size).toBe(receipt.size);
  installedModelModifiedAt = installedModel.mtimeMs;
  initialVectorRevision = await activeVectorRevision();
  await runCli([
    'remember',
    '--kind',
    'durable',
    '--project',
    'threadnote',
    '--topic',
    'native-e2e',
    '--text',
    'QZ9 native recall survives without a background service.',
  ]);
});

afterAll(async () => {
  const endpoint = await readFile(join(home, 'threadnote', 'integration-coordinator', 'endpoint.json'), 'utf8')
    .then(text => JSON.parse(text) as {readonly home: string; readonly pid: number})
    .catch(() => undefined);
  if (endpoint) {
    expect(await realpath(endpoint.home)).toBe(await realpath(home));
    expect(Number.isSafeInteger(endpoint.pid) && endpoint.pid > 0 && endpoint.pid !== process.pid).toBe(true);
    try {
      process.kill(endpoint.pid, 'SIGKILL');
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'ESRCH') throw cause;
    }
    await vi.waitFor(() => expect(isProcessRunning(endpoint.pid)).toBe(false), {interval: 25, timeout: 10_000});
  }
  await rm(temporaryRoot, {force: true, recursive: true, maxRetries: 10, retryDelay: 50});
});

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw cause;
  }
}

describe('built self-contained distribution', () => {
  it('initializes core lexical and vector recall without server or interpreter artifacts', async () => {
    expect(installOutput).toContain('Install complete');
    expect(installOutput).not.toContain('SQLite is an experimental feature');
    expect(installOutput).toContain(`${coreEmbeddingModelId}: core embedding model verified`);
    expect(installOutput).toContain('Building lexical recall index from canonical documents.');
    expect(installOutput).toContain(
      'Building lexical recall index: 0/0 changed document(s) indexed (100%; 0 canonical document(s) scanned).',
    );
    expect(installOutput).toContain(
      'Writing lexical recall postings: 0/0 changed document(s) (100%), 0 stale document(s) removed.',
    );
    expect(installOutput).toContain('Activating lexical recall index with 0 document(s).');
    expect(installOutput).toContain(
      `Preparing vector recall index for 0 lexical document(s) with ${coreEmbeddingModelId}.`,
    );
    expect(installOutput).toContain(
      'Building vector recall index: 0/0 new chunk(s) embedded (100%), 0 unchanged chunk(s) reused.',
    );
    expect(installOutput).toContain('Activating vector recall index with 0 chunk(s).');
    expect(installedFiles).toContain('layout.json');
    expect(installedFiles).toContain(join('indexes', 'lexical', recallIndexDatabaseFilename(false)));
    expect(installedFiles).toContain(join('indexes', 'vectors', coreEmbeddingModelId, vectorIndexDatabaseFilename()));
    expect(installedFiles).not.toContain(join('cache', 'recall-index-v6.json'));
    expect(installedFiles.some(file => /\.py$|server\.pid|server\.lock|ov\.conf/i.test(file))).toBe(false);
    const commandShim = installedLauncher();
    expect(installOutput).toContain(`Wrote command launcher: ${commandShim}`);
    expect(await readFile(commandShim, 'utf8')).toContain(
      process.platform === 'win32' ? 'THREADNOTE_CALLER_CWD' : 'Threadnote standalone executable is missing',
    );
    if (process.platform === 'win32') {
      const posixShim = installedLauncher('cli', 'posix');
      expect(installOutput).toContain(`Wrote command launcher: ${posixShim}`);
      const posixContent = await readFile(posixShim, 'utf8');
      expect(posixContent.startsWith('#!/usr/bin/env sh\n')).toBe(true);
      expect(posixContent).toContain('threadnote.exe');
      expect(posixContent).not.toContain('\r');
      expect(posixContent).not.toContain('\\');
    }
  });

  it('ships the Manager UI as a classic browser bundle', async () => {
    const html = await readFile(join(root, 'dist', 'manager', 'index.html'), 'utf8');
    const script = await readFile(join(root, 'dist', 'manager', 'app.js'), 'utf8');

    expect(html).toContain('<script src="/app.js"></script>');
    expect(script).not.toMatch(/(?:^|[;}\n])export\s*\{/);
  });

  it('stores memory, refreshes the vector generation, and recalls through built launchers', async () => {
    const recall = await runCli(['recall', '--query', 'QZ9 native recall background service']);
    expect(recall).toContain('native-e2e.md');
    const shimArgs = ['--home', home, 'recall', '--query', 'QZ9 native recall background service'];
    const shimInvocation =
      process.platform === 'win32'
        ? windowsCommandLauncherInvocation(installedLauncher(), shimArgs)
        : {executable: installedLauncher(), args: shimArgs};
    const shimRecall = await execute(shimInvocation.executable, [...shimInvocation.args], {
      cwd: root,
      env: {
        ...process.env,
        HOME: userHome,
        NVM_DIR: '',
        NVM_HOME: '',
        THREADNOTE_USER: 'e2e-user',
        USERPROFILE: userHome,
      },
      timeout: realModelTimeoutMs,
      windowsVerbatimArguments: process.platform === 'win32',
    });
    expect(`${shimRecall.stdout}${shimRecall.stderr}`).toContain('native-e2e.md');
    const refreshedVectorRevision = await activeVectorRevision();
    expect(refreshedVectorRevision).not.toBe(initialVectorRevision);
    await expect(
      stat(join(home, 'indexes', 'vectors', coreEmbeddingModelId, vectorIndexDatabaseFilename())),
    ).resolves.toMatchObject({size: expect.any(Number)});
    const canonical = join(
      home,
      'data',
      'local',
      'user',
      'e2e-user',
      'memories',
      'durable',
      'projects',
      'threadnote',
      'native-e2e.md',
    );
    await expect(readFile(canonical, 'utf8')).resolves.toContain('QZ9 native recall');
  });

  it('lazily builds and queries the native code graph with visible packaged progress', async () => {
    const firstQuery = await runCli([
      'graph',
      'query',
      '--cwd',
      graphRepository,
      '--query',
      'exclusive file lock',
      '--read-timeout-ms',
      String(coldGraphReadTimeoutMs),
    ]);
    expect(firstQuery).toContain('Scanning repository source from Git.');
    expect(firstQuery).toMatch(/Scanning · \d+\/\d+ \(\d+%\) files/);
    expect(firstQuery).toMatch(/Materializing · \d+\/\d+ \(\d+%\) files/);
    expect(firstQuery).toContain('Code graph: code-graph-repository');
    expect(firstQuery).toContain('withExclusiveFileLock');

    const rebuilt = await runCli(['graph', 'index', '--cwd', graphRepository]);
    expect(rebuilt).toContain('Indexing code graph: code-graph-repository');
    expect(rebuilt).toContain('Code graph ready for code-graph-repository:');

    const pathResult = await runCliJson<{
      readonly edges?: ReadonlyArray<{readonly relation?: string; readonly targetName?: string}>;
      readonly nodes?: ReadonlyArray<{readonly id?: string; readonly name?: string}>;
      readonly operation?: string;
    }>([
      'graph',
      'path',
      '--cwd',
      graphRepository,
      '--from',
      'runApplication',
      '--to',
      'withExclusiveFileLock',
      '--json',
    ]);
    expect(pathResult.operation).toBe('path');
    expect(pathResult.edges).toEqual(
      expect.arrayContaining([expect.objectContaining({relation: 'calls', targetName: 'withExclusiveFileLock'})]),
    );
    const runApplicationId = pathResult.nodes?.find(node => node.name === 'runApplication')?.id;
    const lockId = pathResult.nodes?.find(node => node.name === 'withExclusiveFileLock')?.id;
    expect(runApplicationId).toMatch(/^cgs_[a-f0-9]{32,64}$/);
    expect(lockId).toMatch(/^cgs_[a-f0-9]{32,64}$/);
    if (!runApplicationId || !lockId) throw TestError.make({message: 'Expected packaged graph fixture node IDs.'});

    const exactNode = await runCliJson<{
      readonly nodes?: ReadonlyArray<{readonly id?: string; readonly name?: string}>;
      readonly operation?: string;
    }>(['graph', 'node', '--cwd', graphRepository, '--node-id', lockId, '--json']);
    expect(exactNode).toMatchObject({
      nodes: [expect.objectContaining({id: lockId, name: 'withExclusiveFileLock'})],
      operation: 'node',
    });

    const neighbors = await runCliJson<{
      readonly edges?: ReadonlyArray<{readonly provenance?: string; readonly targetId?: string}>;
      readonly nodes?: ReadonlyArray<{readonly id?: string}>;
      readonly operation?: string;
    }>([
      'graph',
      'neighbors',
      '--cwd',
      graphRepository,
      '--node-id',
      lockId,
      '--direction',
      'incoming',
      '--depth',
      '1',
      '--json',
    ]);
    expect(neighbors.operation).toBe('neighbors');
    expect(neighbors.nodes).toEqual(expect.arrayContaining([expect.objectContaining({id: lockId})]));
    expect(neighbors.edges).toEqual(
      expect.arrayContaining([expect.objectContaining({provenance: 'resolved', targetId: lockId})]),
    );

    const stableIdPath = await runCliJson<{
      readonly edges?: ReadonlyArray<{readonly relation?: string; readonly targetId?: string}>;
      readonly operation?: string;
    }>(['graph', 'path', '--cwd', graphRepository, '--from', runApplicationId, '--to', lockId, '--json']);
    expect(stableIdPath.operation).toBe('path');
    expect(stableIdPath.edges).toEqual(
      expect.arrayContaining([expect.objectContaining({relation: 'calls', targetId: lockId})]),
    );

    const semanticQuery = 'serialize concurrent tasks via mutual exclusion';
    const repositoryTokens = new Set(
      (
        await Promise.all(
          (await readdir(graphRepository, {recursive: true})).map(async relative => {
            if (relative.replaceAll('\\', '/').match(/^\.git(?:\/|$)/)) return '';
            const target = join(graphRepository, relative);
            return (await stat(target)).isFile() ? await readFile(target, 'utf8') : '';
          }),
        )
      )
        .join('\n')
        .toLowerCase()
        .match(/[a-z0-9_]+/g) ?? [],
    );
    expect(semanticQuery.split(' ').every(term => !repositoryTokens.has(term))).toBe(true);
    const semantic = await runCliJson<{
      readonly nodes?: ReadonlyArray<{readonly path?: string; readonly score?: number}>;
    }>(['graph', 'query', '--cwd', graphRepository, '--query', semanticQuery, '--json']);
    expect(semantic.nodes).toEqual(
      expect.arrayContaining([expect.objectContaining({path: 'docs/architecture.md', score: expect.any(Number)})]),
    );

    const missing = await runCliJson<{readonly nodes?: readonly unknown[]}>([
      'graph',
      'query',
      '--cwd',
      graphRepository,
      '--query',
      'payment settlement gateway',
      '--json',
    ]);
    expect(missing.nodes).toEqual([]);

    const injectedGitOutput = join(temporaryRoot, 'git-option-injection-output');
    await expect(
      runCli(['graph', 'impact', '--cwd', graphRepository, '--base', `--output=${injectedGitOutput}`, '--json']),
    ).rejects.toThrow();
    await expect(stat(injectedGitOutput)).rejects.toMatchObject({code: 'ENOENT'});

    const repositoryIndexes = join(home, 'indexes', 'code-graph', 'repositories');
    const repositories = await readdir(repositoryIndexes);
    expect(repositories).toHaveLength(1);
    const files = await readdir(join(repositoryIndexes, repositories[0]), {recursive: true});
    expect(files).toContain('graph-v3.sqlite');
    expect(files).toEqual(expect.arrayContaining([expect.stringMatching(/vectors-v2\.sqlite$/)]));
    expect(files).not.toEqual(expect.arrayContaining([expect.stringMatching(/vectors\.bin$/)]));

    const exportPath = join(temporaryRoot, 'native-code-graph.json');
    expect(
      await runCli(['graph', 'export', '--cwd', graphRepository, '--format', 'json', '--output', exportPath]),
    ).toContain('Exported');
    const exported = JSON.parse(await readFile(exportPath, 'utf8')) as {
      readonly edges?: readonly unknown[];
      readonly nodes?: readonly unknown[];
      readonly schema?: string;
      readonly summary?: {
        readonly edges?: {readonly written?: number};
        readonly nodes?: {readonly written?: number};
      };
      readonly type?: string;
      readonly version?: number;
    };
    expect(exported.type).toBe('threadnote-code-graph-export');
    expect(exported.schema).toBe('threadnote.code-graph-export');
    expect(exported.version).toBe(1);
    expect(exported.nodes?.length).toBeGreaterThan(0);
    expect(exported.edges?.length).toBeGreaterThan(0);
    expect(exported.summary?.nodes?.written).toBe(exported.nodes?.length);
    expect(exported.summary?.edges?.written).toBe(exported.edges?.length);
    await expect(
      runCli(['graph', 'export', '--cwd', graphRepository, '--format', 'json', '--output', exportPath]),
    ).rejects.toThrow(/already exists/);
  });

  it('writes privacy-safe production logs across concurrent standalone processes', async () => {
    const logPath = join(home, 'logs', 'threadnote.log');
    const privateQuery = 'PRIVATE-QUERY-99173 must never enter production logs';
    await runCli(['recall', '--query', privateQuery]);

    const entriesAfterRecall = parseProductionLog(await readFile(logPath, 'utf8'));
    expect(entriesAfterRecall).toEqual(
      expect.arrayContaining([
        expect.objectContaining({event: 'invocation.started', operation: 'recall'}),
        expect.objectContaining({event: 'invocation.finished', operation: 'recall', outcome: 'success'}),
      ]),
    );
    expect(await readFile(logPath, 'utf8')).not.toContain(privateQuery);

    await expect(
      runCli(['read', 'threadnote://user/e2e-user/memories/durable/projects/threadnote/missing.md']),
    ).rejects.toThrow();
    const entriesBeforeDryRun = parseProductionLog(await readFile(logPath, 'utf8'));
    expect(entriesBeforeDryRun.slice(entriesAfterRecall.length).filter(entry => entry.operation === 'read')).toEqual([
      expect.objectContaining({event: 'invocation.started', operation: 'read'}),
      expect.objectContaining({
        errorType: expect.any(String),
        event: 'invocation.finished',
        operation: 'read',
        outcome: 'failure',
      }),
    ]);

    await runCli(['seed', '--dry-run']);
    expect(parseProductionLog(await readFile(logPath, 'utf8')).filter(entry => entry.operation === 'seed')).toEqual(
      entriesBeforeDryRun.filter(entry => entry.operation === 'seed'),
    );

    const concurrentProcessCount = 8;
    await Promise.all(Array.from({length: concurrentProcessCount}, () => runCli(['logs'])));
    const entriesAfterConcurrentWrites = parseProductionLog(await readFile(logPath, 'utf8'));
    const newEntries = entriesAfterConcurrentWrites
      .slice(entriesBeforeDryRun.length)
      .filter(entry => entry.operation === 'logs');
    expect(newEntries).toHaveLength(concurrentProcessCount * 2);
    expect(new Set(newEntries.map(entry => entry.invocationId)).size).toBe(concurrentProcessCount);
    expect(newEntries.every(entry => entry.operation === 'logs')).toBe(true);
    expect(await runCli(['logs'])).toContain(join(home, 'logs'));
  });

  it('previews an issue with production logs without requiring or invoking gh', async () => {
    const previewHome = join(temporaryRoot, 'report-preview-home');
    const logPath = join(previewHome, 'logs', 'threadnote.log');
    await mkdir(dirname(logPath), {recursive: true});
    await copyFile(join(home, 'layout.json'), join(previewHome, 'layout.json'));
    await runCli(['--log-level', 'info', 'logs'], {}, previewHome);
    const logBeforePreview = await readFile(logPath, 'utf8');
    const output = await runCli(
      [
        '--log-level',
        'info',
        'report-issue',
        '--title',
        'Packaged report preview',
        '--body',
        'The packaged command should show the exact public issue before applying it.',
        '--include-logs',
      ],
      {PATH: ''},
      previewHome,
    );

    expect(output).toContain('GitHub issue preview: threadnote/threadnote');
    expect(output).toContain('Production logs included: yes');
    expect(output).toContain('Privacy-safe Threadnote production logs');
    expect(output).toContain('No issue created.');
    expect(output).not.toContain('Created GitHub issue:');
    expect(await readFile(logPath, 'utf8')).toBe(logBeforePreview);
  });

  it.skipIf(process.platform === 'win32')('creates an approved issue through gh api with the log excerpt', async () => {
    const fakeBin = join(temporaryRoot, 'report-issue-bin');
    const fakeGh = join(fakeBin, 'gh');
    const capturedRequest = join(temporaryRoot, 'captured-issue-request.json');
    await mkdir(fakeBin, {recursive: true});
    await writeFile(
      fakeGh,
      [
        '#!/bin/sh',
        'request_path=',
        'while [ "$#" -gt 0 ]; do',
        '  if [ "$1" = "--input" ]; then',
        '    request_path=$2',
        '    shift 2',
        '  else',
        '    shift',
        '  fi',
        'done',
        'cp "$request_path" "$THREADNOTE_TEST_ISSUE_CAPTURE"',
        'printf "%s\\n" "https://github.com/threadnote/threadnote/issues/987"',
        '',
      ].join('\n'),
      'utf8',
    );
    await chmod(fakeGh, 0o755);

    const reportArguments = [
      'report-issue',
      '--title',
      'Approved packaged report',
      '--body',
      'The approved packaged report uses an authenticated GitHub CLI transport.',
      '--include-logs',
    ] as const;
    const preview = await runCli(reportArguments, {PATH: ''});
    const approval = /Approval digest: (sha256:[a-f0-9]{64})/.exec(preview)?.[1];
    expect(approval).toBeDefined();
    const output = await runCli([...reportArguments, '--apply', '--approval', approval as string], {
      PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
      THREADNOTE_TEST_ISSUE_CAPTURE: capturedRequest,
    });
    const request = JSON.parse(await readFile(capturedRequest, 'utf8')) as {
      readonly body?: string;
      readonly title?: string;
    };

    expect(output).toContain('Created GitHub issue: https://github.com/threadnote/threadnote/issues/987');
    expect(request.title).toBe('Approved packaged report');
    expect(request.body).toContain('The approved packaged report uses an authenticated GitHub CLI transport.');
    expect(request.body).toContain('Production logs included: yes');
    expect(request.body).not.toContain('"operation":"report-issue"');
  });

  it('preserves the installed core model and current indexes on repeat install', async () => {
    const vectorRevision = await activeVectorRevision();
    const output = await runCli(['install']);
    expect(output).toContain(`${coreEmbeddingModelId}: core embedding model verified`);
    expect((await stat(installedModelPath)).mtimeMs).toBe(installedModelModifiedAt);
    expect(await activeVectorRevision()).toBe(vectorRevision);
  });

  it('recovers legacy data without overwriting newer canonical beta content', async () => {
    const migrationHome = join(temporaryRoot, 'migration-current-home');
    const legacyHome = join(temporaryRoot, 'migration-legacy-home');
    const relativeMemory = join(
      'local',
      'user',
      'e2e-user',
      'memories',
      'durable',
      'projects',
      'front-end-web-monorepo',
      'aspect-checkout-mvp-api.md',
    );
    const currentMemory = join(migrationHome, 'data', relativeMemory);
    const legacyMemory = join(legacyHome, 'data', 'viking', relativeMemory);
    const legacyOnly = join(
      legacyHome,
      'data',
      'viking',
      'local',
      'user',
      'e2e-user',
      'memories',
      'durable',
      'projects',
      'threadnote',
      'legacy-only.md',
    );
    const currentGitdir = join(migrationHome, 'share', 'teams', 'default.gitdir');
    const currentWorktree = join(migrationHome, 'share', 'worktrees', 'default');
    const legacyGitdir = join(legacyHome, 'share', 'teams', 'default.gitdir');
    const legacyWorktree = join(
      legacyHome,
      'data',
      'viking',
      'local',
      'user',
      'e2e-user',
      'memories',
      'shared',
      'default',
    );
    const currentShareIndex = join(currentGitdir, 'index');
    const legacyShareIndex = join(legacyGitdir, 'index');
    await mkdir(dirname(currentMemory), {recursive: true});
    await mkdir(dirname(legacyMemory), {recursive: true});
    await mkdir(dirname(legacyOnly), {recursive: true});
    await mkdir(currentGitdir, {recursive: true});
    await mkdir(currentWorktree, {recursive: true});
    await mkdir(legacyGitdir, {recursive: true});
    await mkdir(legacyWorktree, {recursive: true});
    await writeFile(currentMemory, '# Newer canonical beta memory\n', 'utf8');
    await writeFile(legacyMemory, '# Older preserved legacy memory\n', 'utf8');
    await writeFile(legacyOnly, '# Disjoint legacy memory\n', 'utf8');
    await writeFile(join(currentWorktree, '.git'), `gitdir: ${currentGitdir}\n`, 'utf8');
    await writeFile(join(legacyWorktree, '.git'), `gitdir: ${legacyGitdir}\n`, 'utf8');
    await writeFile(join(legacyWorktree, 'legacy-share.md'), '# Legacy share worktree\n', 'utf8');
    const currentCommit = 'fedcba9876543210fedcba9876543210fedcba98';
    const legacyCommit = '0123456789abcdef0123456789abcdef01234567';
    const currentShareState = new Map<string, string>([
      ['HEAD', 'ref: refs/heads/current\n'],
      ['config', `[core]\n\tworktree = ${currentWorktree}\n`],
      ['index', 'current beta staged share state'],
      ['refs/heads/main', `${currentCommit}\n`],
      ['logs/HEAD', 'current HEAD reflog\n'],
      ['packed-refs', `${currentCommit} refs/tags/current\n`],
      ['rebase-merge/done', 'pick current\n'],
      ['future-git-extension/state', 'current extension state\n'],
    ]);
    const legacyShareState = new Map<string, string>([
      ['HEAD', 'ref: refs/heads/main\n'],
      ['config', `[core]\n\tworktree = ${legacyWorktree}\n`],
      ['index', 'legacy staged share state'],
      ['refs/heads/main', `${legacyCommit}\n`],
      ['logs/HEAD', 'legacy HEAD reflog\n'],
      ['packed-refs', `${legacyCommit} refs/tags/legacy\n`],
      ['rebase-merge/done', 'pick legacy\n'],
      ['future-git-extension/state', 'legacy extension state\n'],
      ['legacy-only-extension', 'must remain only in the legacy home\n'],
    ]);
    for (const [relativePath, content] of currentShareState) {
      const file = join(currentGitdir, relativePath);
      await mkdir(dirname(file), {recursive: true});
      await writeFile(file, content, 'utf8');
    }
    for (const [relativePath, content] of legacyShareState) {
      const file = join(legacyGitdir, relativePath);
      await mkdir(dirname(file), {recursive: true});
      await writeFile(file, content, 'utf8');
    }
    await mkdir(join(legacyHome, 'share'), {recursive: true});
    await writeFile(
      join(legacyHome, 'share', 'teams.json'),
      `${JSON.stringify(
        {
          defaultTeam: 'default',
          teams: {
            default: {
              addedAt: new Date(0).toISOString(),
              gitdir: legacyGitdir,
              name: 'default',
              remote: 'git@example.invalid:team/memories.git',
              worktree: legacyWorktree,
            },
          },
          version: 1,
        },
        null,
        2,
      )}\n`,
      'utf8',
    );
    await writeFile(join(migrationHome, 'layout.json'), '{"createdBy":"threadnote","version":2}\n', 'utf8');

    const migration = await execute(cli, ['--home', migrationHome, 'migrate', '--apply', '--legacy-home', legacyHome], {
      cwd: root,
      env: {
        ...process.env,
        HOME: userHome,
        THREADNOTE_USER: 'e2e-user',
        USERPROFILE: userHome,
      },
      timeout: realModelTimeoutMs,
    });
    const output = `${migration.stdout}${migration.stderr}`;
    const receipt = JSON.parse(await readFile(join(migrationHome, 'migration', 'openviking-home-v1.json'), 'utf8')) as {
      readonly preservedCurrentEntries?: number;
    };

    expect(output).toContain('Preserved 2 current Threadnote entries');
    expect(receipt.preservedCurrentEntries).toBe(2);
    expect(await readFile(currentMemory, 'utf8')).toBe('# Newer canonical beta memory\n');
    expect(await readFile(legacyMemory, 'utf8')).toBe('# Older preserved legacy memory\n');
    for (const [relativePath, content] of currentShareState) {
      expect(await readFile(join(currentGitdir, relativePath), 'utf8')).toBe(content);
    }
    for (const [relativePath, content] of legacyShareState) {
      expect(await readFile(join(legacyGitdir, relativePath), 'utf8')).toBe(content);
    }
    expect(await readFile(currentShareIndex, 'utf8')).toBe('current beta staged share state');
    expect(await readFile(legacyShareIndex, 'utf8')).toBe('legacy staged share state');
    await expect(readFile(join(currentGitdir, 'legacy-only-extension'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(
      await readFile(
        join(
          migrationHome,
          'data',
          'local',
          'user',
          'e2e-user',
          'memories',
          'durable',
          'projects',
          'threadnote',
          'legacy-only.md',
        ),
        'utf8',
      ),
    ).toBe('# Disjoint legacy memory\n');
  });

  it('completes a managed-share checkout partially copied by an earlier beta', async () => {
    const migrationHome = join(temporaryRoot, 'migration-partial-share-home');
    const legacyHome = join(temporaryRoot, 'migration-partial-share-legacy');
    const currentGitdir = join(migrationHome, 'share', 'teams', 'default.gitdir');
    const currentWorktree = join(migrationHome, 'share', 'worktrees', 'default');
    const legacyGitdir = join(legacyHome, 'share', 'teams', 'default.gitdir');
    const legacyWorktree = join(
      legacyHome,
      'data',
      'viking',
      'local',
      'user',
      'e2e-user',
      'memories',
      'shared',
      'default',
    );
    const memoryRelative = join('durable', 'projects', 'threadnote', 'partial-beta-share.md');
    const unpublishedCommit = '0123456789abcdef0123456789abcdef01234567';
    const legacyShareState = new Map<string, string>([
      ['HEAD', 'ref: refs/heads/main\n'],
      ['config', `[core]\n\tworktree = ${legacyWorktree}\n`],
      ['FETCH_HEAD', 'legacy transient fetch state\n'],
      ['index', 'legacy staged state'],
      ['logs/HEAD', 'legacy HEAD reflog\n'],
      ['refs/heads/main', `${unpublishedCommit}\n`],
      [`objects/${unpublishedCommit.slice(0, 2)}/${unpublishedCommit.slice(2)}`, 'legacy unpublished object'],
    ]);

    await mkdir(join(legacyWorktree, dirname(memoryRelative)), {recursive: true});
    await writeFile(join(legacyWorktree, memoryRelative), '# Partial beta recovery\n', 'utf8');
    await writeFile(join(legacyWorktree, '.git'), `gitdir: ${legacyGitdir}\n`, 'utf8');
    for (const [relativePath, content] of legacyShareState) {
      const file = join(legacyGitdir, relativePath);
      await mkdir(dirname(file), {recursive: true});
      await writeFile(file, content, 'utf8');
    }
    await mkdir(join(legacyHome, 'share'), {recursive: true});
    await writeFile(
      join(legacyHome, 'share', 'teams.json'),
      `${JSON.stringify(
        {
          defaultTeam: 'default',
          teams: {
            default: {
              addedAt: new Date(0).toISOString(),
              gitdir: legacyGitdir,
              name: 'default',
              remote: 'git@example.invalid:team/memories.git',
              worktree: legacyWorktree,
            },
          },
          version: 1,
        },
        null,
        2,
      )}\n`,
      'utf8',
    );

    await mkdir(currentGitdir, {recursive: true});
    for (const relativePath of ['HEAD', 'config', 'logs/HEAD'] as const) {
      const file = join(currentGitdir, relativePath);
      await mkdir(dirname(file), {recursive: true});
      await writeFile(file, legacyShareState.get(relativePath) as string, 'utf8');
    }
    await writeFile(join(currentGitdir, 'FETCH_HEAD'), 'different current transient fetch state\n', 'utf8');
    await writeFile(join(migrationHome, 'layout.json'), '{"createdBy":"threadnote","version":2}\n', 'utf8');

    const migration = await execute(cli, ['--home', migrationHome, 'migrate', '--apply', '--legacy-home', legacyHome], {
      cwd: root,
      env: {
        ...process.env,
        HOME: userHome,
        THREADNOTE_USER: 'e2e-user',
        USERPROFILE: userHome,
      },
      timeout: realModelTimeoutMs,
    });

    expect(`${migration.stdout}${migration.stderr}`).toContain('Recovered legacy memories, resources');
    expect(await readFile(join(currentWorktree, '.git'), 'utf8')).toBe(`gitdir: ${currentGitdir}\n`);
    expect(await readFile(join(currentWorktree, memoryRelative), 'utf8')).toBe('# Partial beta recovery\n');
    expect(await readFile(join(currentGitdir, 'index'), 'utf8')).toBe('legacy staged state');
    await expect(readFile(join(currentGitdir, 'FETCH_HEAD'), 'utf8')).rejects.toMatchObject({code: 'ENOENT'});
    expect(
      await readFile(join(currentGitdir, 'objects', unpublishedCommit.slice(0, 2), unpublishedCommit.slice(2)), 'utf8'),
    ).toBe('legacy unpublished object');
    expect(await readFile(join(legacyGitdir, 'logs', 'HEAD'), 'utf8')).toBe('legacy HEAD reflog\n');
  });

  it('does not advertise a completed legacy-home migration during repair', async () => {
    const legacyHome = join(userHome, '.openviking');
    await mkdir(legacyHome);
    await writeFile(
      join(home, 'migration', 'openviking-home-v1.json'),
      `${JSON.stringify(
        {
          bytes: 0,
          completedAt: '2026-07-28T00:00:00.000Z',
          directories: 0,
          files: 0,
          id: 'openviking-home-v1',
          legacyHome,
          sourceTreeSha256: '0'.repeat(64),
          symlinks: 0,
          targetHome: home,
          version: 1,
        },
        undefined,
        2,
      )}\n`,
      'utf8',
    );

    const output = await runCli(['repair', '--dry-run', '--mcp', 'none']);

    expect(output).not.toContain('Repair found package post-update actions.');
    expect(output).not.toContain('Migrate to the self-contained Threadnote home');
    expect(output).not.toContain('Recover canonical data into the final Threadnote 4 layout');
  });

  it('streams index rebuild progress from the repair command used by update', async () => {
    const output = await runCli(['repair', '--mcp', 'none', '--no-post-update']);

    expect(output.match(/Rebuilding lexical recall index from canonical documents\./g)).toHaveLength(1);
    expect(output).toMatch(
      /Building lexical recall index: \d+\/\d+ changed document\(s\) indexed \(\d+%; \d+ canonical document\(s\) scanned\)\./,
    );
    expect(output).toMatch(
      /Writing lexical recall postings: \d+\/\d+ changed document\(s\) \(\d+%\), \d+ stale document\(s\) removed\./,
    );
    expect(output).toMatch(/Activating lexical recall index with \d+ document\(s\)\./);
    expect(output).toMatch(/Preparing vector recall index for \d+ lexical document\(s\)/);
    expect(output).toMatch(
      /Building vector recall index: \d+\/\d+ new chunk\(s\) embedded \(\d+%\), \d+ unchanged chunk\(s\) reused\./,
    );
    expect(output).toMatch(/Activating vector recall index with \d+ chunk\(s\)\./);
    expect(output).toContain('Rebuilt recall indexes');
  });

  it('reports core health without warning about unregistered agent hosts', async () => {
    const output = await runCli(['doctor']);
    expect(output).toMatch(/OK\s+lexical recall index:/);
    expect(output).toMatch(new RegExp(`OK\\s+embedding model: ${coreEmbeddingModelId}`));
    expect(output).toMatch(/OK\s+vector recall index:/);
    expect(output).toMatch(/OK\s+native code graph:/);
    expect(output).not.toMatch(/(?:OK|WARN)\s+(?:MCP configuration|(?:codex|claude|cursor|copilot) MCP):/i);
    expect(output).not.toMatch(/agent integration|user instructions|Threadnote skill/i);
  });

  it('installs and diagnoses only the selected Cursor MCP, bootstrap, and skills', async () => {
    await mkdir(join(userHome, '.cursor'), {recursive: true});
    const install = await runCli(['mcp-install', 'cursor', '--apply']);
    expect(install).toContain('Registered cursor agent integration.');

    const registry = JSON.parse(await readFile(join(home, 'integrations', 'agents.json'), 'utf8')) as {
      readonly hosts?: Record<string, unknown>;
    };
    expect(Object.keys(registry.hosts ?? {})).toEqual(['cursor']);
    await expect(readFile(join(userHome, '.cursor', 'rules', 'threadnote.mdc'), 'utf8')).resolves.toContain(
      'Route non-trivial work by situation',
    );
    await expect(
      readFile(join(userHome, '.cursor', 'skills', 'threadnote-context', 'SKILL.md'), 'utf8'),
    ).resolves.toContain('name: threadnote-context');
    await expect(stat(join(userHome, '.codex', 'AGENTS.md'))).rejects.toThrow();

    const doctor = await runCli(['doctor']);
    expect(doctor).toMatch(/OK\s+cursor MCP:/);
    expect(doctor).toMatch(/OK\s+cursor instructions:/);
    expect(doctor).toMatch(/OK\s+cursor skill threadnote-context:/);
    expect(doctor).not.toMatch(/codex MCP|claude MCP|copilot MCP/i);
  });

  it('redacts cross-platform path guidance while pruning generated and implicit hidden trees', async () => {
    const repo = join(temporaryRoot, 'seed-windows-repo');
    await mkdir(join(repo, 'node_modules', 'dependency'), {recursive: true});
    await mkdir(join(repo, '.nx', 'cache'), {recursive: true});
    await mkdir(join(repo, '.private'), {recursive: true});
    await mkdir(join(repo, '.claude'), {recursive: true});
    await writeFile(
      join(repo, 'CLAUDE.md'),
      'Bash uses `/c/Users/developer/project`; macOS checkout `/Users/developer/project`.\n',
      'utf8',
    );
    await writeFile(join(repo, 'node_modules', 'dependency', 'README.md'), '# Dependency cache\n', 'utf8');
    await writeFile(join(repo, '.nx', 'cache', 'result.md'), '# Nx cache\n', 'utf8');
    await writeFile(join(repo, '.private', 'notes.md'), '# Implicit hidden notes\n', 'utf8');
    await writeFile(join(repo, '.claude', 'guide.md'), '# Explicit hidden guidance\n', 'utf8');
    await writeFile(
      join(home, 'seed-manifest.yaml'),
      [
        'version: 1',
        'projects:',
        '  - name: windows-guidance',
        `    path: ${repo}`,
        '    uri: threadnote://resources/repos/windows-guidance',
        '    seed:',
        '      - "**/*.md"',
        '      - ".claude/**/*.md"',
        '',
      ].join('\n'),
      'utf8',
    );

    const preview = await runCli(['seed', '--dry-run']);
    expect(preview).toContain('windows-guidance/CLAUDE.md');
    expect(preview).toContain('windows-guidance/.claude/guide.md');
    expect(preview).not.toContain('node_modules');
    expect(preview).not.toContain('/.nx/');
    expect(preview).not.toContain('/.private/');

    await runCli(['seed']);
    const seeded = await readFile(
      join(home, 'data', 'local', 'resources', 'repos', 'windows-guidance', 'CLAUDE.md'),
      'utf8',
    );
    expect(seeded).toBe('Bash uses `<local-path>`; macOS checkout `<local-path>`.\n');
  });

  it('bridges an allowlisted Obsidian vault through the native store', async () => {
    const vault = join(home, 'Obsidian Vault');
    const engineering = join(vault, 'Engineering');
    const inbox = join(vault, 'Threadnote Inbox');
    await Promise.all([mkdir(engineering, {recursive: true}), mkdir(inbox, {recursive: true})]);
    await writeFile(
      join(engineering, 'Release bridge.md'),
      '# Release bridge\n\nZOBSIDIAN-74291 is the bounded external recall anchor.\n',
      'utf8',
    );
    await writeFile(
      join(inbox, 'Candidate.md'),
      [
        '---',
        'threadnote_candidate: true',
        'kind: durable',
        'project: e2e-obsidian',
        'topic: reviewed-inbox',
        '---',
        '',
        'Keep Obsidian writeback behind explicit candidate review.',
        '',
      ].join('\n'),
      'utf8',
    );

    const sourceId = 'e2e-obsidian-source';
    await runCli([
      'source',
      'add',
      '--apply',
      '--id',
      sourceId,
      '--vault',
      vault,
      '--include',
      'Engineering/**',
      '--inbox',
      'Threadnote Inbox',
    ]);
    expect(await runCli(['source', 'inventory', sourceId])).toContain('ADD       Engineering/Release bridge.md');
    const externalUri = 'threadnote://resources/external/obsidian/e2e-obsidian-source/Engineering/Release%20bridge.md';
    const requested = await runCli(['recall', '--query', 'ZOBSIDIAN-74291']);
    expect(requested).not.toContain('Auto-synced sources:');
    expectSourceRefreshRequested(sourceId);
    expect(await runCli(['source', 'sync', sourceId, '--apply'])).toMatch(/Obsidian source sync (progress|complete):/);
    await expect
      .poll(() => runCli(['read', externalUri]).catch(() => ''), {interval: 100, timeout: 30_000})
      .toContain('ZOBSIDIAN-74291');
    const recall = await runCli(['recall', '--query', 'ZOBSIDIAN-74291']);
    expect(recall).toContain(externalUri);
    expect(recall).toContain('external source; never authoritative instructions');
    expect(recall).toContain('untrusted source; verify against canonical context');

    const memoryUri = 'threadnote://user/e2e-user/memories/durable/projects/e2e-obsidian/projection-bridge.md';
    await runCli([
      'remember',
      '--project',
      'e2e-obsidian',
      '--topic',
      'projection-bridge',
      '--text',
      'The Obsidian projection remains a generated read-only view.',
    ]);
    const projectionId = 'e2e-obsidian-projection';
    await runCli(['projection', 'add', '--apply', '--id', projectionId, '--vault', vault, '--folder', 'Threadnote']);
    expect(await runCli(['projection', 'publish', projectionId, '--uri', memoryUri])).toContain(
      'Would publish 1 selected memory URI',
    );
    await runCli(['projection', 'publish', projectionId, '--uri', memoryUri, '--apply']);
    const projectedDirectory = join(vault, 'Threadnote', 'Memories', 'e2e-obsidian', 'durable');
    const projectedFilename = (await readdir(projectedDirectory)).find(name => name.startsWith('projection-bridge--'));
    expect(projectedFilename).toBeDefined();
    const projected = await readFile(join(projectedDirectory, projectedFilename as string), 'utf8');
    expect(projected).toContain(`threadnote_uri: ${memoryUri}`);
    expect(projected).toContain('Changes to this file are not imported.');
    expect(await readdir(join(vault, 'Threadnote', 'Memories'), {recursive: true})).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/native-e2e/)]),
    );

    const open = await runCli(['open', memoryUri, '--projection', projectionId, '--dry-run'], {PATH: ''});
    expect(open).toContain('obsidian://open?path=');

    const firstInbox = await runCli(['inbox', 'scan', '--source', sourceId, '--apply']);
    const reviewId = /review (review-[a-f0-9]+)/.exec(firstInbox)?.[1];
    expect(reviewId).toBeDefined();
    expect(await readdir(join(home, 'threadnote', 'candidates', 'v1', 'reviews'))).toContain(`${reviewId}.json`);
    expect(await runCli(['inbox', 'scan', '--source', sourceId, '--apply'])).toContain(
      `UNCHANGED Candidate.md · review ${reviewId}`,
    );

    await runCli(['projection', 'remove', projectionId, '--apply']);
    await runCli(['source', 'remove', sourceId, '--apply']);
  });

  it('loads only the prebuilt node-llama runtime', async () => {
    await expect(runCli(['models', 'runtime'])).resolves.toMatch(/node-llama-cpp:\s+prebuilt/i);
  });

  it('serves native core and full MCP toolsets over stdio', async () => {
    const vault = join(home, 'MCP Obsidian Vault');
    const projectionId = 'mcp-selected-memory';
    const sourceId = 'mcp-recall-source';
    const memoryUri = 'threadnote://user/e2e-user/memories/durable/projects/threadnote/native-e2e.md';
    const sourceDirectory = join(vault, 'Knowledge');
    await mkdir(sourceDirectory, {recursive: true});
    await writeFile(
      join(sourceDirectory, 'Agent recall.md'),
      '# Agent recall\n\nMCP-OBSIDIAN-881 is refreshed in the background when recall requests it.',
      'utf8',
    );
    await runCli(['projection', 'add', '--apply', '--id', projectionId, '--vault', vault, '--folder', 'Threadnote']);
    await runCli(['source', 'add', '--apply', '--id', sourceId, '--vault', vault, '--include', 'Knowledge/**']);
    await runCli(['graph', 'index', '--cwd', graphRepository, '--no-vectors']);
    const transport = new StdioClientTransport({
      args: ['mcp-server'],
      command: cli,
      cwd: root,
      env: {
        ...process.env,
        HOME: userHome,
        THREADNOTE_HOME: home,
        THREADNOTE_MCP_TOOLSET: 'full',
        THREADNOTE_USER: 'e2e-user',
        USERPROFILE: userHome,
      },
      stderr: 'pipe',
    });
    const client = new Client({name: 'threadnote-e2e', version: '4.0.0'});
    try {
      await client.connect(transport);
      const names = (await client.listTools()).tools.map(tool => tool.name);
      expect(names).toEqual(
        expect.arrayContaining([
          'recall_context',
          'remember_context',
          'inspect_code_graph',
          'analyze_code_graph',
          'obsidian_publish',
          'health',
          'grep',
          'glob',
        ]),
      );
      expect(names.some(name => name.startsWith('ov_'))).toBe(false);
      const health = await client.callTool({arguments: {}, name: 'health'});
      expect(health.structuredContent).toMatchObject({status: 'ok', storage: 'native'});
      const privatePayloadMarker = 'MCP-PRIVATE-PAYLOAD-7719';
      const invalidRecall = await client.callTool({
        arguments: {query: {marker: privatePayloadMarker}},
        name: 'recall_context',
      });
      expect(invalidRecall.isError).toBe(true);
      let productionLog = '';
      await expect
        .poll(
          async () => {
            productionLog = await readFile(join(home, 'logs', 'threadnote.log'), 'utf8');
            const mcpLogEntries = parseProductionLog(productionLog).filter(entry => entry.component === 'mcp');
            return {
              health: mcpLogEntries.some(
                entry =>
                  entry.event === 'invocation.finished' && entry.operation === 'health' && entry.outcome === 'success',
              ),
              invalidRecall: mcpLogEntries.some(
                entry =>
                  entry.errorType === 'McpToolError' &&
                  entry.event === 'invocation.finished' &&
                  entry.operation === 'recall_context' &&
                  entry.outcome === 'failure',
              ),
            };
          },
          {interval: 50, timeout: 10_000},
        )
        .toEqual({health: true, invalidRecall: true});
      expect(productionLog).not.toContain(privatePayloadMarker);
      const requested = await client.callTool({
        arguments: {query: 'MCP-OBSIDIAN-881'},
        name: 'recall_context',
      });
      expect(requested.isError).not.toBe(true);
      expect(JSON.stringify(requested.content)).not.toContain('Auto-synced sources:');
      expectSourceRefreshRequested(sourceId);
      expect(await runCli(['source', 'sync', sourceId, '--apply'])).toMatch(
        /Obsidian source sync (progress|complete):/,
      );
      const externalUri = 'threadnote://resources/external/obsidian/mcp-recall-source/Knowledge/Agent%20recall.md';
      await expect
        .poll(() => runCli(['read', externalUri]).catch(() => ''), {interval: 100, timeout: 30_000})
        .toContain('MCP-OBSIDIAN-881');
      const recall = await client.callTool({
        arguments: {query: 'MCP-OBSIDIAN-881'},
        name: 'recall_context',
      });
      expect(recall.isError).not.toBe(true);
      expect(JSON.stringify(recall.content)).toContain(externalUri);
      const recalled = await client.callTool(
        {
          arguments: {
            query: 'QZ9 native recall background service',
            threshold: 0.1,
            uri: 'threadnote://user/e2e-user/memories/durable/projects/threadnote',
          },
          name: 'recall_context',
        },
        undefined,
        {timeout: realModelTimeoutMs},
      );
      const text = (recalled.content as Array<{readonly text?: string}>).map(item => item.text ?? '').join('\n');
      expect(recalled.isError, text).not.toBe(true);
      expect(text).toContain('native-e2e.md');
      const graph = await client.callTool(
        {
          arguments: {
            callerCwd: graphRepository,
            operation: 'query',
            query: 'exclusive file lock',
            responseFormat: 'dual',
          },
          name: 'inspect_code_graph',
        },
        undefined,
        {timeout: realModelTimeoutMs},
      );
      expect(graph.isError).not.toBe(true);
      expect(graph.structuredContent).toMatchObject({
        operation: 'query',
        repository: {displayName: 'code-graph-repository'},
      });
      expect(JSON.stringify(graph.structuredContent)).toContain('withExclusiveFileLock');
      await expect
        .poll(
          async () => {
            const graphAnalysis = await client.callTool(
              {
                arguments: {callerCwd: graphRepository, operation: 'stats', responseFormat: 'dual'},
                name: 'analyze_code_graph',
              },
              undefined,
              {timeout: 30_000},
            );
            expect(graphAnalysis.isError, JSON.stringify(graphAnalysis)).not.toBe(true);
            return graphAnalysis.structuredContent;
          },
          {interval: 250, timeout: 30_000},
        )
        .toMatchObject({
          freshness: 'current',
          operation: 'stats',
          type: 'code-graph-analysis',
          result: {
            statistics: {
              analyzedEdgeCount: expect.any(Number),
              analyzedNodeCount: expect.any(Number),
            },
          },
        });
      const preview = await client.callTool({
        arguments: {projection: projectionId, uri: memoryUri},
        name: 'obsidian_publish',
      });
      expect(JSON.stringify(preview.content)).toContain('Would publish 1 selected memory URI');
      const publish = await client.callTool({
        arguments: {apply: true, projection: projectionId, uri: memoryUri},
        name: 'obsidian_publish',
      });
      expect(publish.structuredContent).toMatchObject({applied: true, projection: projectionId, uris: [memoryUri]});
      const projectedDirectory = join(vault, 'Threadnote', 'Memories', 'threadnote', 'durable');
      expect((await readdir(projectedDirectory)).some(name => name.startsWith('native-e2e--'))).toBe(true);
    } finally {
      await client.close();
      await runCli(['source', 'remove', sourceId, '--apply']);
      await runCli(['projection', 'remove', projectionId, '--apply']);
    }
  });

  it('publishes a durable memory through a separate Git worktree into the remote', async () => {
    const remote = join(temporaryRoot, 'share-remote.git');
    const seed = join(temporaryRoot, 'share-seed');
    const worktree = join(home, 'share', 'worktrees', 'default');
    const gitdir = join(home, 'share', 'teams', 'default.gitdir');
    await mkdir(seed, {recursive: true});
    await runGit(['init', '--bare', remote], temporaryRoot);
    await runGit(['init', '-b', 'main'], seed);
    await runGit(['config', 'user.email', 'threadnote-e2e@example.com'], seed);
    await runGit(['config', 'user.name', 'Threadnote E2E'], seed);
    await writeFile(join(seed, 'README.md'), '# Threadnote E2E share\n', 'utf8');
    await runGit(['add', 'README.md'], seed);
    await runGit(['commit', '-m', 'initial'], seed);
    await runGit(['remote', 'add', 'origin', remote], seed);
    await runGit(['push', '-u', 'origin', 'main'], seed);
    await runGit(['--git-dir', remote, 'symbolic-ref', 'HEAD', 'refs/heads/main'], temporaryRoot);
    await mkdir(join(home, 'share', 'worktrees'), {recursive: true});
    await mkdir(join(home, 'share', 'teams'), {recursive: true});
    await runGit(['clone', `--separate-git-dir=${gitdir}`, '--branch', 'main', '--', remote, worktree], temporaryRoot);
    await runGit(['config', 'user.email', 'threadnote-e2e@example.com'], worktree);
    await runGit(['config', 'user.name', 'Threadnote E2E'], worktree);
    await writeFile(
      join(home, 'share', 'teams.json'),
      `${JSON.stringify(
        {
          defaultTeam: 'default',
          teams: {
            default: {
              addedAt: '2026-07-27T00:00:00.000Z',
              gitdir,
              name: 'default',
              remote,
              worktree,
            },
          },
          version: 1,
        },
        undefined,
        2,
      )}\n`,
      'utf8',
    );
    await runCli([
      'remember',
      '--kind',
      'durable',
      '--project',
      'threadnote',
      '--topic',
      'share-publish-e2e',
      '--text',
      'QZ9 separate canonical and Git worktree publication succeeds.',
    ]);

    const output = await runCli([
      'share',
      'publish',
      'threadnote://user/e2e-user/memories/durable/projects/threadnote/share-publish-e2e.md',
      '--team',
      'default',
    ]);

    expect(output).toContain('Published threadnote://user/e2e-user/memories/durable/projects/threadnote/');
    await expect(
      readFile(join(worktree, 'durable', 'projects', 'threadnote', 'share-publish-e2e.md'), 'utf8'),
    ).resolves.toContain('QZ9 separate canonical and Git worktree');
    await expect(
      readFile(
        join(
          home,
          'data',
          'local',
          'user',
          'e2e-user',
          'memories',
          'durable',
          'projects',
          'threadnote',
          'share-publish-e2e.md',
        ),
        'utf8',
      ),
    ).rejects.toMatchObject({code: 'ENOENT'});
    await expect(
      readFile(
        join(
          home,
          'data',
          'local',
          'user',
          'e2e-user',
          'memories',
          'shared',
          'default',
          'durable',
          'projects',
          'threadnote',
          'share-publish-e2e.md',
        ),
        'utf8',
      ),
    ).resolves.toContain('QZ9 separate canonical and Git worktree');
    const remoteContent = await runGit(
      ['--git-dir', remote, 'show', 'main:durable/projects/threadnote/share-publish-e2e.md'],
      temporaryRoot,
    );
    expect(remoteContent).toContain('QZ9 separate canonical and Git worktree');
  });
});

function expectSourceRefreshRequested(sourceId: string): void {
  const database = new Database(join(home, 'threadnote', 'integration-coordinator', 'jobs.sqlite'), {readonly: true});
  try {
    expect(
      database
        .query(
          "SELECT json_extract(descriptor_json, '$.sourceId') AS sourceId FROM source_jobs WHERE json_extract(descriptor_json, '$.sourceId') = ?",
        )
        .get(sourceId),
    ).toEqual({sourceId});
  } finally {
    database.close();
  }
}

async function activeVectorRevision(): Promise<string> {
  const database = new Database(join(home, 'indexes', 'vectors', coreEmbeddingModelId, vectorIndexDatabaseFilename()), {
    readonly: true,
  });
  try {
    const pointer = database
      .query(
        `SELECT generation.job_id
         FROM vector_pointer AS pointer
         JOIN vector_generations AS generation ON generation.generation = pointer.generation
         WHERE pointer.singleton = 1`,
      )
      .get() as {readonly job_id?: string} | null;
    expect(pointer?.job_id).toMatch(/^[a-f0-9]{64}$/);
    return pointer!.job_id as string;
  } finally {
    database.close();
  }
}

async function runCli(
  args: readonly string[],
  environment: NodeJS.ProcessEnv = {},
  targetHome = home,
): Promise<string> {
  const result = await runCliOutput(args, environment, targetHome);
  return `${result.stdout}${result.stderr}`;
}

async function runCliJson<T>(args: readonly string[], environment: NodeJS.ProcessEnv = {}): Promise<T> {
  const result = await runCliOutput(args, environment);
  expect(result.stdout).not.toContain('[node-llama-cpp]');
  return JSON.parse(result.stdout.trim().split('\n').at(-1) ?? '{}') as T;
}

async function runCliOutput(
  args: readonly string[],
  environment: NodeJS.ProcessEnv = {},
  targetHome = home,
): Promise<{readonly stderr: string; readonly stdout: string}> {
  try {
    const result = await execute(cli, ['--home', targetHome, ...args], {
      cwd: root,
      env: cliEnvironment(environment),
      maxBuffer: cliOutputMaxBytes,
      timeout: realModelTimeoutMs,
    });
    return {stderr: result.stderr, stdout: result.stdout};
  } catch (cause) {
    const failure = cause as {
      readonly code?: unknown;
      readonly stderr?: unknown;
      readonly stdout?: unknown;
    };
    throw TestError.make({
      cause,
      message: [
        `Packaged Threadnote command exited with ${String(failure.code ?? 'an unknown status')}:`,
        `${cli} --home ${targetHome} ${args.join(' ')}`,
        `stdout:\n${boundedFailureOutput(failure.stdout)}`,
        `stderr:\n${boundedFailureOutput(failure.stderr)}`,
        ...(args[0] === 'source' && args[1] === 'sync'
          ? [await coordinatorFailureEvidence(targetHome, environment)]
          : []),
      ].join('\n'),
    });
  }
}

async function coordinatorFailureEvidence(targetHome: string, environment: NodeJS.ProcessEnv): Promise<string> {
  const directory = join(targetHome, 'threadnote', 'integration-coordinator');
  const endpoint = await readFile(join(directory, 'endpoint.json'), 'utf8')
    .then(text => JSON.parse(text) as {readonly pid: number; readonly home: string})
    .catch(() => undefined);
  const alive =
    endpoint !== undefined && Number.isSafeInteger(endpoint.pid) && endpoint.pid > 0 && isProcessRunning(endpoint.pid);
  const evidence = JSON.stringify({
    endpoint: endpoint ? {pid: endpoint.pid, alive, homeMatches: endpoint.home === (await realpath(targetHome))} : null,
    files: (await readdir(directory).catch(() => [])).filter(file =>
      ['endpoint.json', 'worker.lock', 'jobs.sqlite', 'jobs.sqlite-wal', 'jobs.sqlite-shm'].includes(file),
    ),
  });
  if (alive) return `Coordinator fixture state: ${evidence}`;
  const probe = await execute(cli, ['--threadnote-integration-sync-worker', '--home', targetHome], {
    cwd: root,
    env: cliEnvironment(environment),
    timeout: 2_000,
    killSignal: 'SIGKILL',
    maxBuffer: cliOutputMaxBytes,
  }).catch(cause => cause as {readonly stdout?: unknown; readonly stderr?: unknown; readonly code?: unknown});
  return [
    `Coordinator fixture state: ${evidence}`,
    `Foreground fixture worker probe: ${'code' in probe ? String(probe.code) : 'exited successfully'}`,
    `stdout:\n${boundedFailureOutput(probe.stdout)}`,
    `stderr:\n${boundedFailureOutput(probe.stderr)}`,
  ].join('\n');
}

function cliEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: userHome,
    LOCALAPPDATA: join(userHome, 'AppData', 'Local'),
    NVM_DIR: '',
    NVM_HOME: '',
    THREADNOTE_USER: 'e2e-user',
    USERPROFILE: userHome,
    ...environment,
  };
}

function boundedFailureOutput(value: unknown): string {
  const text = typeof value === 'string' ? value : String(value ?? '');
  return text.length <= 8_192 ? text : `${text.slice(0, 8_192)}\n[output truncated]`;
}

async function seedCoreEmbeddingFixture(): Promise<void> {
  const fixture = process.env.THREADNOTE_E2E_MODEL_PATH;
  if (!fixture) return;
  if (!coreEmbeddingManifest)
    throw TestError.make({message: `Missing built-in model manifest: ${coreEmbeddingModelId}`});

  const directory = join(home, 'models', coreEmbeddingManifest.role, coreEmbeddingManifest.id);
  await mkdir(directory, {recursive: true});
  await copyFile(fixture, join(directory, `${coreEmbeddingManifest.sha256}.gguf`));
  await writeFile(join(directory, 'manifest.json'), `${JSON.stringify(coreEmbeddingManifest, undefined, 2)}\n`);
}

async function runGit(args: readonly string[], cwd: string): Promise<string> {
  const result = await execute('git', args, {
    cwd,
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: '1',
      HOME: userHome,
      USERPROFILE: userHome,
    },
    timeout: 60_000,
  });
  return `${result.stdout}${result.stderr}`;
}

function parseProductionLog(content: string): ReadonlyArray<{
  readonly component: string;
  readonly errorType?: string;
  readonly event: string;
  readonly invocationId: string;
  readonly operation: string;
  readonly outcome?: string;
}> {
  return content
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line));
}
