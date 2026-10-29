import {Array as EffectArray, Predicate} from 'effect';
import {chmod, mkdir, mkdtemp, readFile, rm, writeFile} from '@threadnote/testing/node-fs-promises';
import {tmpdir} from '@threadnote/testing/node-os';
import {delimiter, join} from '@threadnote/testing/node-path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {describe, expect, it} from 'vitest';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

const sourceUri = 'threadnote://user/test-user/memories/durable/projects/foo/bar.md';
const targetUri = 'threadnote://user/test-user/memories/shared/default/durable/projects/foo/bar.md';
const dependencyUri = 'threadnote://user/test-user/memories/shared/default/durable/projects/foo/dependency.md';

function joinTextContent(content: unknown): string {
  if (!EffectArray.isArray(content)) {
    throw new Error('Expected MCP result content to be an array.');
  }
  return EffectArray.join(
    EffectArray.map(content, item => {
      if (!Predicate.isObject(item) || item.type !== 'text' || typeof item.text !== 'string') {
        throw new Error('Expected every MCP result content block to be text.');
      }
      return item.text;
    }),
    '\n',
  );
}

async function makeHome(root: string): Promise<string> {
  const home = join(root, 'home');
  const worktree = join(home, 'share', 'worktrees', 'default');
  const sourcePath = join(
    home,
    'data',
    'local',
    'user',
    'test-user',
    'memories',
    'durable',
    'projects',
    'foo',
    'bar.md',
  );
  const gitdir = join(home, 'share', 'teams', 'default.gitdir');
  const dependencyContent = EffectArray.join(
    [
      'MEMORY',
      'kind: durable',
      'status: active',
      'visibility: shared',
      'project: foo',
      'topic: dependency',
      'memory_id: tn_shared_dependency',
      'source_agent_client: test',
      'timestamp: 2026-07-23T00:00:00.000Z',
      '',
      'Shared dependency.',
    ],
    '\n',
  );
  const canonicalDependencyPath = join(
    home,
    'data',
    'local',
    'user',
    'test-user',
    'memories',
    'shared',
    'default',
    'durable',
    'projects',
    'foo',
    'dependency.md',
  );
  const worktreeDependencyPath = join(worktree, 'durable', 'projects', 'foo', 'dependency.md');
  await mkdir(worktree, {recursive: true});
  await mkdir(join(sourcePath, '..'), {recursive: true});
  await mkdir(join(canonicalDependencyPath, '..'), {recursive: true});
  await mkdir(join(worktreeDependencyPath, '..'), {recursive: true});
  await writeFile(canonicalDependencyPath, dependencyContent);
  await writeFile(worktreeDependencyPath, dependencyContent);
  await writeFile(
    sourcePath,
    EffectArray.join(
      [
        'MEMORY',
        'kind: durable',
        'status: active',
        'project: foo',
        'topic: bar',
        'memory_id: tn_foo_bar',
        'source_agent_client: test',
        'timestamp: 2026-07-23T00:00:00.000Z',
        'visibility: personal',
        '',
        'Body',
        '',
        '<!-- threadnote:hygiene-sources:v1 -->',
        '## Threadnote Hygiene Sources',
        '',
        '- threadnote://user/test-user/memories/handoffs/archived/foo/private-task.md',
      ],
      '\n',
    ),
  );
  await mkdir(join(home, 'share'), {recursive: true});
  await writeFile(
    join(home, 'share', 'teams.json'),
    `${JSON.stringify(
      {
        defaultTeam: 'default',
        teams: {
          default: {
            addedAt: '2026-06-08T00:00:00.000Z',
            gitdir,
            name: 'default',
            remote: 'git@example.com:team/memories.git',
            worktree,
          },
        },
        version: 1,
      },
      undefined,
      2,
    )}\n`,
  );
  return home;
}

async function writeExecutable(path: string, contents: string): Promise<void> {
  await writeFile(path, contents, {encoding: 'utf8', mode: 0o700});
  await chmod(path, 0o700);
}

async function makeFakeBin(root: string, options: {readonly mutateSourceOnCommit?: boolean} = {}): Promise<string> {
  const bin = join(root, 'bin');
  const sourcePath = join(
    root,
    'home',
    'data',
    'local',
    'user',
    'test-user',
    'memories',
    'durable',
    'projects',
    'foo',
    'bar.md',
  );
  await mkdir(bin, {recursive: true});
  await writeExecutable(
    join(bin, 'git'),
    `#! /usr/bin/env node
const args = process.argv.slice(2);
if (args.includes('fetch') || args.includes('add') || args.includes('ls-files') || args.includes('status')) {
  process.exit(0);
}
if (args.includes('rev-parse') && args.includes('--git-path')) {
  process.stdout.write(${JSON.stringify(
    EffectArray.join(
      Array.from({length: 6}, (_, index) => join(root, `absent-git-operation-${index}`)),
      '\n',
    ) + '\n',
  )});
  process.exit(0);
}
if (args.includes('rev-list')) {
  process.stdout.write('0\\n');
  process.exit(0);
}
if (args.includes('diff') && args.includes('--cached')) {
  process.stdout.write(args[args.length - 1] + '\\0');
  process.exit(0);
}
if (args.includes('commit')) {
  if (${JSON.stringify(options.mutateSourceOnCommit === true)}) {
    require('node:fs').writeFileSync(
      ${JSON.stringify(sourcePath)},
      'MEMORY\\nkind: durable\\nstatus: active\\nproject: foo\\ntopic: bar\\nsource_agent_client: concurrent\\ntimestamp: 2026-07-23T01:00:00.000Z\\n\\nConcurrent newer body\\n',
    );
  }
  process.stdout.write('[main abc123] share\\n 1 file changed\\n');
  process.exit(0);
}
if (args.includes('push')) {
  process.stdout.write('pushed\\n');
  process.exit(0);
}
process.stderr.write('unexpected git command: ' + args.join(' ') + '\\n');
process.exit(1);
`,
  );
  return bin;
}

describe('Threadnote MCP share_publish', () => {
  it('does not write CLI progress to the stdio transport while publishing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'threadnote-mcp-share-publish-'));
    const home = await makeHome(root);
    const fakeBin = await makeFakeBin(root);
    const repoRoot = process.cwd();
    const transport = new StdioClientTransport({
      args: [join(repoRoot, 'apps', 'threadnote', 'src', 'standalone.ts'), 'mcp-server'],
      command: process.execPath,
      cwd: repoRoot,
      env: {
        PATH: `${fakeBin}${delimiter}${process.env.PATH ?? ''}`,
        THREADNOTE_ACCOUNT: 'local',
        THREADNOTE_AGENT_ID: 'threadnote',
        THREADNOTE_HOME: home,
        THREADNOTE_MANIFEST: join(home, 'seed-manifest.yaml'),
        THREADNOTE_USER: 'test-user',
      },
      stderr: 'pipe',
    });
    const stderrChunks: string[] = [];
    transport.stderr?.on('data', chunk => stderrChunks.push(String(chunk)));
    const client = new Client({name: 'threadnote-test', version: '0.0.0'});
    try {
      await client.connect(transport);
      const aliasPublish = await client.callTool(
        {
          arguments: {preview: true, uri: 'threadnote://memory/tn_foo_bar'},
          name: 'share_publish',
        },
        undefined,
        {timeout: 5000},
      );
      expect(aliasPublish.isError).toBe(true);
      expect(joinTextContent(aliasPublish.content)).toContain('threadnote://memory/tn_foo_bar');
      expect(
        await readFile(
          join(home, 'data', 'local', 'user', 'test-user', 'memories', 'durable', 'projects', 'foo', 'bar.md'),
          'utf8',
        ),
      ).toContain('Body');
      await expect(
        readFile(join(home, 'share', 'worktrees', 'default', 'durable', 'projects', 'foo', 'bar.md'), 'utf8'),
      ).rejects.toBeDefined();

      const preview = await client.callTool(
        {
          arguments: {preview: true, uri: sourceUri},
          name: 'share_publish',
        },
        undefined,
        {timeout: 5000},
      );
      const previewText = joinTextContent(preview.content);
      expect(previewText).toContain('Body');
      expect(previewText).toContain('visibility: shared');
      expect(previewText).not.toContain('visibility: personal');
      expect(previewText).not.toContain('threadnote:hygiene-sources');
      expect(previewText).not.toContain('/private-task.md');

      const legacyPublishedContent = EffectArray.join(
        [
          'MEMORY',
          'kind: durable',
          'status: active',
          'project: foo',
          'topic: bar',
          'memory_id: tn_foo_bar',
          'source_agent_client: test',
          'timestamp: 2026-07-23T00:00:00.000Z',
          '',
          'Body',
        ],
        '\n',
      );
      const canonicalTargetPath = join(
        home,
        'data',
        'local',
        'user',
        'test-user',
        'memories',
        'shared',
        'default',
        'durable',
        'projects',
        'foo',
        'bar.md',
      );
      const worktreeTargetPath = join(home, 'share', 'worktrees', 'default', 'durable', 'projects', 'foo', 'bar.md');
      await writeFile(
        canonicalTargetPath,
        Effect.pipe(
          legacyPublishedContent,
          EffectString.replace(
            'timestamp: 2026-07-23T00:00:00.000Z',
            'timestamp: 2026-07-23T00:00:00.000Z\nvisibility: shared',
          ),
        ),
      );
      await writeFile(worktreeTargetPath, legacyPublishedContent);

      const result = await client.callTool(
        {
          arguments: {
            push: false,
            uri: sourceUri,
          },
          name: 'share_publish',
        },
        undefined,
        {timeout: 5000},
      );

      expect(result.isError).toBe(false);
      expect(EffectArray.isArray(result.content)).toBe(true);
      const text = joinTextContent(result.content);
      expect(text).toContain(`Published ${sourceUri} -> ${targetUri}`);
      expect(text).toContain('git push skipped (push=false)');
      const published = await readFile(worktreeTargetPath, 'utf8');
      expect(published).toContain('Body');
      expect(published).toContain('memory_id: tn_foo_bar');
      expect(published).toContain('visibility: shared');
      expect(published).not.toContain('visibility: personal');
      expect(published).not.toContain('threadnote:hygiene-sources');
      expect(published).not.toContain('/private-task.md');
      await expect(readFile(canonicalTargetPath, 'utf8')).resolves.toBe(published);

      const replaced = await client.callTool(
        {
          arguments: {
            kind: 'durable',
            project: 'foo',
            relations: [{type: 'depends_on', uri: dependencyUri}],
            replaceUri: targetUri,
            text: 'Updated shared body with a stable dependency.',
            topic: 'bar',
          },
          name: 'remember_context',
        },
        undefined,
        {timeout: 30_000},
      );
      expect(replaced.isError, JSON.stringify(replaced)).not.toBe(true);
      const replacedContent = await readFile(
        join(
          home,
          'data',
          'local',
          'user',
          'test-user',
          'memories',
          'shared',
          'default',
          'durable',
          'projects',
          'foo',
          'bar.md',
        ),
        'utf8',
      );
      expect(replacedContent).toContain('memory_id: tn_foo_bar');
      expect(replacedContent).toContain('created_at: 2026-07-23T00:00:00.000Z');
      expect(replacedContent).toContain('visibility: shared');
      expect(replacedContent).toContain('relation: depends_on threadnote://memory/tn_shared_dependency');
      expect(replacedContent).toContain('Updated shared body with a stable dependency.');

      const aliasReplacement = await client.callTool(
        {
          arguments: {
            kind: 'durable',
            project: 'foo',
            replaceUri: 'threadnote://memory/tn_foo_bar',
            text: 'Updated shared body through its stable identity.',
            topic: 'bar',
          },
          name: 'remember_context',
        },
        undefined,
        {timeout: 30_000},
      );
      expect(aliasReplacement.isError, JSON.stringify(aliasReplacement)).not.toBe(true);
      expect(joinTextContent(aliasReplacement.content)).toContain(`Updated shared memory: ${targetUri}`);
      await expect(readFile(canonicalTargetPath, 'utf8')).resolves.toContain(
        'Updated shared body through its stable identity.',
      );
    } finally {
      await client.close().catch(() => undefined);
      await rm(root, {force: true, recursive: true});
    }
    expect(EffectArray.join(stderrChunks, '')).toContain('Threadnote local MCP adapter running');
  });

  it('does not delete a personal source that changes after the shared write', async () => {
    const root = await mkdtemp(join(tmpdir(), 'threadnote-mcp-share-publish-race-'));
    const home = await makeHome(root);
    const fakeBin = await makeFakeBin(root, {mutateSourceOnCommit: true});
    const repoRoot = process.cwd();
    const sourcePath = join(
      home,
      'data',
      'local',
      'user',
      'test-user',
      'memories',
      'durable',
      'projects',
      'foo',
      'bar.md',
    );
    const transport = new StdioClientTransport({
      args: [join(repoRoot, 'apps', 'threadnote', 'src', 'standalone.ts'), 'mcp-server'],
      command: process.execPath,
      cwd: repoRoot,
      env: {
        PATH: `${fakeBin}${delimiter}${process.env.PATH ?? ''}`,
        THREADNOTE_ACCOUNT: 'local',
        THREADNOTE_AGENT_ID: 'threadnote',
        THREADNOTE_HOME: home,
        THREADNOTE_MANIFEST: join(home, 'seed-manifest.yaml'),
        THREADNOTE_USER: 'test-user',
      },
      stderr: 'pipe',
    });
    const client = new Client({name: 'threadnote-test', version: '0.0.0'});
    try {
      await client.connect(transport);
      const result = await client.callTool(
        {
          arguments: {push: false, uri: sourceUri},
          name: 'share_publish',
        },
        undefined,
        {timeout: 5000},
      );

      expect(result.isError).toBe(true);
      const text = joinTextContent(result.content);
      expect(text).toContain('changed while publication was in progress');
      expect(await readFile(sourcePath, 'utf8')).toContain('Concurrent newer body');
      await expect(readFile(join(root, 'source-remove-invoked'), 'utf8')).rejects.toBeDefined();
    } finally {
      await client.close().catch(() => undefined);
      await rm(root, {force: true, recursive: true});
    }
  });
});
