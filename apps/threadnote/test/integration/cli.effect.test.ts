import {TestError} from '@threadnote/testing/test-error';
import {execFile} from '@threadnote/testing/node-child-process';
import {access, mkdir, mkdtemp, readFile, rm, writeFile} from '@threadnote/testing/node-fs-promises';
import {tmpdir} from '@threadnote/testing/node-os';
import {join} from '@threadnote/testing/node-path';
import {promisify} from '@threadnote/testing/node-util';
import {describe, expect, it} from 'vitest';

const execFilePromise = promisify(execFile);

describe('Effect CLI', () => {
  it('exposes a core repair mode that skips host integrations', async () => {
    const result = await runCli(['repair', '--help']);
    expect(result.stdout).toContain('--core-only');
    expect(result.stdout).toContain('without host instructions, hooks, or MCP settings');
  });

  it('renders the command tree without collapsing long names into descriptions', async () => {
    const result = await runCli(['--help']);
    expect(result.stdout).toContain('migrate-projects    Move memories');
    expect(result.stdout).not.toContain('migrate-project-namesMove');
  });

  it('distinguishes the data home from shared standalone installation state', async () => {
    const [rootHelp, installHelp] = await Promise.all([runCli(['--help']), runCli(['install', '--help'])]);

    expect(rootHelp.stdout).toContain('Override the Threadnote data home; not the standalone installation root');
    expect(installHelp.stdout).toContain('maintain the shared standalone installation');
  });

  it('retains the historical migrate-project-names command', async () => {
    const result = await runCli(['migrate-project-names', '--help']);
    expect(result.stdout).toContain('threadnote migrate-project-names [flags]');
  });

  it('exposes explicit beta and stable update channels', async () => {
    const result = await runCli(['update', '--help']);
    expect(result.stdout).toContain('--beta');
    expect(result.stdout).toContain('newest stable or prerelease release');
    expect(result.stdout).toContain('--stable');
  });

  it('keeps the setup verification task built in', async () => {
    const help = await runCli(['setup', 'gemini-cli', '--help']);
    expect(help.stdout).not.toContain('--task');

    const error = await runCli(['setup', 'gemini-cli', '--task', 'custom verification']).catch(
      cause => cause as NodeJS.ErrnoException & {stderr?: string},
    );
    expect(error).toMatchObject({code: 1});
    expect(String(error.stderr)).toContain('--task');
  });

  it('exposes explicit preview/apply telemetry consent commands', async () => {
    const telemetry = await runCli(['telemetry', '--help']);
    const enable = await runCli(['telemetry', 'enable', '--help']);
    const disable = await runCli(['telemetry', 'disable', '--help']);

    expect(telemetry.stdout).toContain('status');
    expect(telemetry.stdout).toContain('enable');
    expect(telemetry.stdout).toContain('disable');
    expect(enable.stdout).toContain('--apply');
    expect(enable.stdout).toContain('--auto-accept');
    expect(enable.stdout).toContain('--endpoint string');
    expect(disable.stdout).toContain('--apply');
  });

  it('exposes immediate enable and disable flags for MCP image projection', async () => {
    const help = await runCli(['image-projection', '--help']);
    expect(help.stdout).toContain('--enable');
    expect(help.stdout).toContain('--disable');
  });

  it('describes citation paths as exact-current graph locators', async () => {
    const remember = await runCli(['remember', '--help']);
    const handoff = await runCli(['handoff', '--help']);
    const contextBrief = await runCli(['context', 'brief', '--help']);

    expect(remember.stdout).toContain('Graph-indexed repository-relative path');
    expect(remember.stdout).toContain('--require-current-code-refs');
    expect(remember.stdout).toContain('--relation string');
    expect(remember.stdout).toContain('default private store-now/anchor-later');
    expect(handoff.stdout).toContain('Graph-indexed repository-relative path');
    expect(handoff.stdout).toContain('--require-current-code-refs');
    expect(contextBrief.stdout).toContain('1-4096 UTF-8 bytes');
    expect(contextBrief.stdout).toContain('at most 256 UTF-8 bytes');
    expect(contextBrief.stdout).toContain('--cwd string');
    expect(contextBrief.stdout).not.toContain('--caller-cwd');
  });

  it('stores repeatable typed relations as stable memory identities', async () => {
    const root = await mkdtemp(join(tmpdir(), 'threadnote-effect-cli-relations-'));
    const memoryRoot = join(root, 'data', 'local', 'user', 'local', 'memories', 'durable', 'projects', 'threadnote');
    const targetUri = 'threadnote://user/local/memories/durable/projects/threadnote/relation-target.md';
    try {
      await mkdir(memoryRoot, {recursive: true});
      await writeFile(
        join(memoryRoot, 'relation-target.md'),
        [
          'MEMORY',
          'kind: durable',
          'status: active',
          'project: threadnote',
          'topic: relation-target',
          'memory_id: tn_cli_relation_target',
          'source_agent_client: test',
          'timestamp: 2026-08-31T00:00:00.000Z',
          '',
          'CLI relation target.',
        ].join('\n'),
      );

      const stored = await runCli(
        [
          'remember',
          '--project',
          'threadnote',
          '--topic',
          'relation-source',
          '--relation',
          `depends_on=${targetUri}`,
          '--relation',
          'evidence_for=threadnote://memory/tn_cli_relation_target',
          '--text',
          'CLI relation source.',
        ],
        {THREADNOTE_HOME: root, THREADNOTE_USER: 'local'},
      );
      expect(stored.stdout).toContain('Stored memory:');

      const sourceUri = 'threadnote://user/local/memories/durable/projects/threadnote/relation-source.md';
      const read = await runCli(['read', sourceUri], {THREADNOTE_HOME: root, THREADNOTE_USER: 'local'});
      expect(read.stdout).toContain('relation: depends_on threadnote://memory/tn_cli_relation_target');
      expect(read.stdout).toContain('relation: evidence_for threadnote://memory/tn_cli_relation_target');

      const preview = await runCli(
        [
          'remember',
          '--dry-run',
          '--project',
          'threadnote',
          '--topic',
          'relation-source',
          '--replace',
          sourceUri,
          '--text',
          'Preview a replacement without edges.',
        ],
        {THREADNOTE_HOME: root, THREADNOTE_USER: 'local'},
      );
      expect(preview.stdout).not.toContain('Cleared 2 prior memory relation(s)');
      const afterPreview = await runCli(['read', sourceUri], {THREADNOTE_HOME: root, THREADNOTE_USER: 'local'});
      expect(afterPreview.stdout).toContain('relation: depends_on threadnote://memory/tn_cli_relation_target');

      const replaced = await runCli(
        [
          'remember',
          '--project',
          'threadnote',
          '--topic',
          'relation-source',
          '--replace',
          sourceUri,
          '--text',
          'CLI relation source without replacement edges.',
        ],
        {THREADNOTE_HOME: root, THREADNOTE_USER: 'local'},
      );
      expect(replaced.stdout).toContain('Cleared 2 prior memory relation(s)');
      const cleared = await runCli(['read', sourceUri], {THREADNOTE_HOME: root, THREADNOTE_USER: 'local'});
      expect(cleared.stdout).not.toContain('relation:');

      const tooMany = await runCli(
        [
          'remember',
          '--text',
          'Too many relations.',
          ...Array.from({length: 17}, (_, index) => [
            '--relation',
            `related_to=threadnote://memory/tn_${index}`,
          ]).flat(),
        ],
        {THREADNOTE_HOME: root, THREADNOTE_USER: 'local'},
      ).catch(cause => cause as NodeJS.ErrnoException & {stderr?: string});
      expect(tooMany).toMatchObject({code: 1});
      expect(String(tooMany.stderr)).toContain('at most 16 relations');
    } finally {
      await rm(root, {force: true, recursive: true});
    }
  });

  it('rejects deferred citation policy without a requested code reference', async () => {
    const root = await mkdtemp(join(tmpdir(), 'threadnote-effect-cli-deferred-policy-'));
    try {
      const failure = await runCli(
        ['remember', '--dry-run', '--defer-code-refs', '--text', 'No locator was supplied.'],
        {THREADNOTE_HOME: root},
      ).catch(cause => cause as NodeJS.ErrnoException & {stderr?: string});
      expect(failure).toMatchObject({code: 1});
      expect(String(failure.stderr)).toContain('--defer-code-refs requires at least one --code-ref');
    } finally {
      await rm(root, {force: true, recursive: true});
    }
  });

  it('keeps deferred citation dry runs out of the private outbox', async () => {
    const root = await mkdtemp(join(tmpdir(), 'threadnote-effect-cli-deferred-preview-'));
    try {
      const result = await runCli(
        [
          'remember',
          '--dry-run',
          '--code-ref',
          'apps/threadnote/src/types.ts',
          '--project',
          'threadnote',
          '--topic',
          'deferred-preview',
          '--text',
          'Preview only.',
        ],
        {THREADNOTE_HOME: root},
      );
      expect(result.stdout).toContain('Would stage 1 code reference(s)');
      expect(result.stdout).not.toContain('Stored memory without finalized code citations');
      await expect(
        access(join(root, 'data', 'local', 'user', 'local', 'private', 'deferred-code-anchors')),
      ).rejects.toMatchObject({code: 'ENOENT'});
    } finally {
      await rm(root, {force: true, recursive: true});
    }
  });

  it('defaults a private handoff to deferred capture with the stable identity required for finalization', async () => {
    const root = await mkdtemp(join(tmpdir(), 'threadnote-effect-cli-deferred-handoff-'));
    try {
      const result = await runCli(
        [
          'handoff',
          '--code-ref',
          'apps/threadnote/src/types.ts',
          '--project',
          'threadnote',
          '--topic',
          'deferred-handoff',
          '--task',
          'Verify deferred handoff persistence.',
        ],
        {THREADNOTE_HOME: root},
      );

      expect(result.stdout).toContain('Stored memory without finalized code citations');
      expect(result.stdout).toContain('retries automatically after graph indexing');
      expect(result.stdout).toContain('finalize-code-refs` as a repair fallback');
      const memoryUri = /Stored memory: (threadnote:\/\/\S+)/u.exec(result.stdout)?.[1];
      expect(memoryUri).toBeDefined();
      const stored = await runCli(['read', memoryUri!], {THREADNOTE_HOME: root});
      expect(stored.stdout).toMatch(/^memory_id: tn_[a-f0-9]{32}$/mu);
    } finally {
      await rm(root, {force: true, recursive: true});
    }
  });

  it('omits derived-index status when finalize-code-refs finalizes nothing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'threadnote-effect-cli-finalize-empty-'));
    try {
      const result = await runCli(['finalize-code-refs'], {THREADNOTE_HOME: root});
      expect(JSON.parse(result.stdout)).toMatchObject({
        conflictCount: 0,
        failedCount: 0,
        finalizedCount: 0,
        pendingCount: 0,
        scannedCount: 0,
      });
      expect(JSON.parse(result.stdout)).not.toHaveProperty('derivedIndexes');
    } finally {
      await rm(root, {force: true, recursive: true});
    }
  });

  it('keeps exact-current citation capture available as an explicit fail-before-write policy', async () => {
    const root = await mkdtemp(join(tmpdir(), 'threadnote-effect-cli-require-current-'));
    try {
      const failure = await runCli(
        [
          'remember',
          '--require-current-code-refs',
          '--code-ref',
          'apps/threadnote/src/types.ts',
          '--project',
          'threadnote',
          '--topic',
          'require-current',
          '--text',
          'Do not write without exact-current evidence.',
        ],
        {THREADNOTE_HOME: root},
      ).catch(cause => cause as NodeJS.ErrnoException & {stderr?: string});

      expect(failure).toMatchObject({code: 1});
      expect(String(failure.stderr)).toContain('already-published ready graph');
      expect(String(failure.stderr)).toContain('No indexing was started');
      await expect(
        access(
          join(
            root,
            'data',
            'local',
            'user',
            'local',
            'memories',
            'durable',
            'projects',
            'threadnote',
            'require-current.md',
          ),
        ),
      ).rejects.toMatchObject({code: 'ENOENT'});
    } finally {
      await rm(root, {force: true, recursive: true});
    }
  });

  it('autoheals a deferred citation on the first cold graph publication', async () => {
    const root = await mkdtemp(join(tmpdir(), 'threadnote-effect-cli-first-cold-anchor-'));
    const home = join(root, 'home');
    const repository = join(root, 'repository');
    const environment = {THREADNOTE_HOME: home};
    try {
      await mkdir(join(repository, 'src'), {recursive: true});
      await writeFile(join(repository, 'package.json'), '{"name":"first-cold-anchor"}\n');
      await writeFile(join(repository, 'src', 'value.ts'), 'export const value = 1;\n');
      await execFilePromise('git', ['init', '--quiet'], {cwd: repository});
      await execFilePromise('git', ['config', 'user.email', 'threadnote@example.test'], {cwd: repository});
      await execFilePromise('git', ['config', 'user.name', 'Threadnote Test'], {cwd: repository});
      await execFilePromise('git', ['add', '.'], {cwd: repository});
      await execFilePromise('git', ['commit', '--quiet', '--message', 'fixture'], {cwd: repository});

      const remembered = await runCli(
        [
          'remember',
          '--code-ref',
          'src/value.ts',
          '--project',
          'threadnote',
          '--topic',
          'first-cold-anchor',
          '--text',
          'The first cold publication must finalize this citation.',
        ],
        environment,
        repository,
      );
      const memoryUri = /Stored memory: (threadnote:\/\/\S+)/u.exec(remembered.stdout)?.[1];
      expect(memoryUri).toBeDefined();
      expect((await runCli(['read', memoryUri!], environment)).stdout).not.toContain('code_citation:');

      await runCli(['graph', 'index', '--cwd', repository, '--no-vectors', '--json'], environment);

      expect((await runCli(['read', memoryUri!], environment)).stdout).toContain('code_citation:');
      const diagnosis = await runCli(['doctor', '--dry-run'], environment).catch(
        cause => cause as NodeJS.ErrnoException & {stdout?: string},
      );
      expect(String(diagnosis.stdout)).toContain('OK   lexical recall index:');
    } finally {
      await rm(root, {force: true, recursive: true});
    }
  });

  it('rejects contradictory citation policies before capture', async () => {
    const root = await mkdtemp(join(tmpdir(), 'threadnote-effect-cli-citation-policy-conflict-'));
    try {
      const failure = await runCli(
        [
          'remember',
          '--defer-code-refs',
          '--require-current-code-refs',
          '--code-ref',
          'apps/threadnote/src/types.ts',
          '--text',
          'Contradictory policy.',
        ],
        {THREADNOTE_HOME: root},
      ).catch(cause => cause as NodeJS.ErrnoException & {stderr?: string});

      expect(failure).toMatchObject({code: 1});
      expect(String(failure.stderr)).toContain('Choose only one of --defer-code-refs or --require-current-code-refs');
    } finally {
      await rm(root, {force: true, recursive: true});
    }
  });

  it('rejects explicit deferred anchors for an inactive memory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'threadnote-effect-cli-inactive-defer-'));
    try {
      const failure = await runCli(
        [
          'remember',
          '--defer-code-refs',
          '--status',
          'archived',
          '--code-ref',
          'apps/threadnote/src/types.ts',
          '--text',
          'Inactive memories cannot own pending anchors.',
        ],
        {THREADNOTE_HOME: root},
      ).catch(cause => cause as NodeJS.ErrnoException & {stderr?: string});

      expect(failure).toMatchObject({code: 1});
      expect(String(failure.stderr)).toContain('--defer-code-refs can be used only when storing an active memory');
    } finally {
      await rm(root, {force: true, recursive: true});
    }
  });

  it('keeps regular and negated boolean flags optional with their historical defaults', async () => {
    const root = await mkdtemp(join(tmpdir(), 'threadnote-effect-cli-boolean-defaults-'));
    const environment = {
      THREADNOTE_HOME: join(root, 'home'),
      THREADNOTE_INSTALL_ROOT: join(root, 'install'),
    };
    try {
      const textProcesses = await runCli(['processes'], environment);
      const jsonProcesses = await runCli(['processes', '--json'], environment);
      const defaultStart = await runCli(['install', '--dry-run'], environment);
      const disabledStart = await runCli(['install', '--dry-run', '--no-start'], environment);

      expect(textProcesses.stdout).toMatch(/^(?:PID|No live Threadnote processes found\.)/u);
      expect(JSON.parse(jsonProcesses.stdout)).toMatchObject({schemaVersion: 1});
      expect(defaultStart.stdout).toContain('no background server is required');
      expect(disabledStart.stdout).not.toContain('no background server is required');
    } finally {
      await rm(root, {force: true, recursive: true});
    }
  });

  it('keeps automatic-update policy dry runs read-only and rejects mixed update modes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'threadnote-effect-cli-auto-update-'));
    const environment = {
      THREADNOTE_HOME: join(root, 'home'),
      THREADNOTE_INSTALL_ROOT: join(root, 'install'),
    };
    try {
      const preview = await runCli(['update', '--auto', 'on', '--dry-run'], environment);
      expect(preview.stdout).toContain('Would enable automatic Threadnote updates.');
      await expect(access(join(root, 'install', 'auto-update.json'))).rejects.toMatchObject({code: 'ENOENT'});

      const mixed = await runCli(['update', '--auto', 'off', '--json'], environment).catch(
        cause => cause as NodeJS.ErrnoException & {stderr?: string},
      );
      expect(mixed).toMatchObject({code: 1});
      expect(String(mixed.stderr)).toContain('Choose one update mode');
      await expect(access(join(root, 'install', 'auto-update.json'))).rejects.toMatchObject({code: 'ENOENT'});
    } finally {
      await rm(root, {force: true, recursive: true});
    }
  });

  it('disambiguates reused boolean and value flag names by selected command', async () => {
    const root = await mkdtemp(join(tmpdir(), 'threadnote-effect-cli-reused-flags-'));
    const home = join(root, 'home');
    const firstRepo = join(root, 'first-repo');
    const secondRepo = join(root, 'second-repo');
    try {
      await Promise.all([mkdir(firstRepo), mkdir(secondRepo)]);
      await Promise.all([
        execFilePromise('git', ['-C', firstRepo, 'init', '-q']),
        execFilePromise('git', ['-C', secondRepo, 'init', '-q']),
      ]);

      const replaceBeforeRepos = await runCli([
        'init-manifest',
        '--home',
        home,
        '--dry-run',
        '--replace',
        '--repo',
        firstRepo,
        '--repo',
        secondRepo,
      ]);
      const replaceAfterRepo = await runCli([
        'init-manifest',
        '--home',
        home,
        '--dry-run',
        '--repo',
        firstRepo,
        '--replace',
      ]);
      const updateStatus = await runCli(['update', '--status', '--json'], {
        THREADNOTE_HOME: home,
        THREADNOTE_INSTALL_ROOT: join(root, 'install'),
      });
      const replacementUri = 'threadnote://user/test/memories/durable/projects/threadnote/old.md';
      const rememberReplace = await runCli([
        'remember',
        '--home',
        home,
        '--dry-run',
        '--text',
        'replacement',
        '--project',
        'threadnote',
        '--topic',
        'reused-replace',
        '--replace',
        replacementUri,
      ]);
      const projectionStatus = await runCli([
        'projection',
        'add',
        '--home',
        home,
        '--id',
        'reused-status',
        '--vault',
        root,
        '--status',
        'active',
      ]);

      expect(replaceBeforeRepos.stdout).toContain('name: first-repo');
      expect(replaceBeforeRepos.stdout).toContain('name: second-repo');
      expect(replaceAfterRepo.stdout).toContain('name: first-repo');
      expect(JSON.parse(updateStatus.stdout)).toMatchObject({version: 1});
      expect(rememberReplace.stdout).toContain(`supersedes: ${replacementUri}`);
      expect(projectionStatus.stdout).toContain('statuses: active');
    } finally {
      await rm(root, {force: true, recursive: true});
    }
  });

  it('exposes local AI model installation and switching commands', async () => {
    const install = await runCli(['local-ai', 'install', '--help']);
    const switching = await runCli(['local-ai', 'model', 'switch', '--help']);

    expect(install.stdout).toContain('--model string');
    expect(install.stdout).toContain('gemma-4-E4B-it-Q4_0');
    expect(install.stdout).not.toContain('LFM2.5-350M');
    expect(switching.stdout).toContain('threadnote local-ai model switch [flags]');
    expect(switching.stdout).toContain('--model string');
  });

  it('exposes code graph search as a dedicated command family', async () => {
    const graph = await runCli(['graph', '--help']);
    const query = await runCli(['graph', 'query', '--help']);
    const node = await runCli(['graph', 'node', '--help']);
    const neighbors = await runCli(['graph', 'neighbors', '--help']);
    const explain = await runCli(['graph', 'explain', '--help']);
    const path = await runCli(['graph', 'path', '--help']);
    const impact = await runCli(['graph', 'impact', '--help']);
    const topology = await runCli(['graph', 'topology', '--help']);
    const contextBrief = await runCli(['context', 'brief', '--help']);
    const inventory = await runCli(['graph', 'inventory', '--help']);
    const analyze = await runCli(['graph', 'analyze', '--help']);
    const report = await runCli(['graph', 'report', '--help']);
    const diagnostics = await runCli(['graph', 'diagnostics', '--help']);
    const exportHelp = await runCli(['graph', 'export', '--help']);
    const purge = await runCli(['graph', 'purge', '--help']);
    const removeView = await runCli(['graph', 'remove-view', '--help']);
    const repair = await runCli(['graph', 'repair', '--help']);

    expect(graph.stdout).toContain('status');
    expect(graph.stdout).toContain('index');
    expect(graph.stdout).toContain('explain');
    expect(graph.stdout).toContain('node');
    expect(graph.stdout).toContain('neighbors');
    expect(graph.stdout).toContain('path');
    expect(graph.stdout).toContain('impact');
    expect(graph.stdout).toContain('topology');
    expect(graph.stdout).toContain('inventory');
    expect(graph.stdout).toContain('communities');
    expect(graph.stdout).toContain('community');
    expect(graph.stdout).toContain('diagnostics');
    expect(graph.stdout).toContain('groups');
    expect(graph.stdout).toContain('report');
    expect(graph.stdout).toContain('repair');
    expect(query.stdout).toContain('--query string');
    expect(query.stdout).toContain('--cwd string');
    expect(query.stdout).toContain('--package string');
    expect(query.stdout).toContain('--workset string');
    expect(query.stdout).toContain('--budget-tokens integer');
    expect(query.stdout).toContain('--cursor string');
    expect(query.stdout).toContain('workset prepare');
    expect(node.stdout).toContain('--node-id string');
    expect(neighbors.stdout).toContain('--node-id string');
    expect(neighbors.stdout).toContain('--direction choice');
    expect(neighbors.stdout).toContain('choices: both, incoming, outgoing');
    expect(neighbors.stdout).toContain('--depth integer');
    for (const command of [query, neighbors, explain, path, impact]) {
      expect(command.stdout).toContain('--node-limit, --limit integer');
    }
    expect(path.stdout).toContain('--workset string');
    expect(impact.stdout).toContain('--workset string');
    expect(topology.stdout).toContain('--workset string');
    expect(topology.stdout).toContain('--edge-limit integer');
    expect(topology.stdout).toContain('--node-limit, --limit integer');
    expect(contextBrief.stdout).toContain('--task string');
    expect(contextBrief.stdout).toContain('--budget-tokens integer');
    expect(contextBrief.stdout).toContain('(800-1500)');
    expect(contextBrief.stdout).toContain('--code-ref string');
    expect(contextBrief.stdout).toContain('Canonical graph-indexed repository-relative path (no ./ or ..)');
    expect(contextBrief.stdout).toContain('cgr_ unsupported');
    expect(contextBrief.stdout).toContain('repeat up to eight times');
    expect(contextBrief.stdout).toContain('--workset string');
    expect(contextBrief.stdout).toContain('choices: brief, locate, explain, trace, impact, resume');
    expect(analyze.stdout).toContain('--view choice');
    expect(analyze.stdout).toContain(
      'choices: stats, communities, community, groups, hubs, surprises, confidence, full',
    );
    expect(analyze.stdout).toContain('--community-id string');
    expect(analyze.stdout).toContain('--freshness choice');
    expect(analyze.stdout).toContain('choices: ready, current, allow-stale');
    expect(analyze.stdout).toContain('--read-timeout-ms integer');
    expect(report.stdout).toContain('--read-timeout-ms integer');
    expect(diagnostics.stdout).toContain('--analyze');
    expect(diagnostics.stdout).toContain('--deep');
    expect(diagnostics.stdout).not.toContain('--cwd');
    expect(inventory.stdout).toContain('--cwd string');
    expect(inventory.stdout).toContain('--json');
    const community = await runCli(['graph', 'community', '--help']);
    expect(community.stdout).toContain('--community-id string');
    expect(community.stdout).toContain('--member-limit integer');
    expect(exportHelp.stdout).toContain('--format choice');
    expect(exportHelp.stdout).toContain('choices: json, graphml, html, svg');
    expect(exportHelp.stdout).toContain('--node-limit, --limit string');
    expect(exportHelp.stdout).toContain('--edge-limit string');
    expect(purge.stdout).toContain('--obsolete');
    expect(purge.stdout).toContain('--snapshot-id string');
    expect(purge.stdout).toContain('--approval string');
    expect(purge.stdout).toContain('--apply');
    expect(purge.stdout).toContain('--json');
    expect(removeView.stdout).toContain('--checkout-id string');
    expect(removeView.stdout).toContain('--worktree-id string');
    expect(removeView.stdout).toContain('--snapshot-id string');
    expect(removeView.stdout).toContain('--apply');
    expect(removeView.stdout).toContain('--json');
    expect(repair.stdout).toContain('--all');
    expect(repair.stdout).toContain('--deep');
    expect(repair.stdout).toContain('--dry-run');
  });

  it('transports a pre-status refresh-demand supersession as private exit code 75', async () => {
    const root = await mkdtemp(join(tmpdir(), 'threadnote-effect-cli-refresh-demand-'));
    const home = join(root, 'home');
    const repository = join(root, 'repository');
    try {
      await mkdir(home, {mode: 0o700, recursive: true});
      await mkdir(repository, {recursive: true});
      await writeFile(join(repository, 'source.ts'), 'export const value = 1;\n');
      await execFilePromise('git', ['init', '--quiet'], {cwd: repository});
      await execFilePromise('git', ['config', 'user.email', 'threadnote@example.test'], {cwd: repository});
      await execFilePromise('git', ['config', 'user.name', 'Threadnote Test'], {cwd: repository});
      await execFilePromise('git', ['add', '.'], {cwd: repository});
      await execFilePromise('git', ['commit', '--quiet', '--message', 'fixture'], {cwd: repository});

      await expect(
        runCli(['graph', 'index', '--home', home, '--cwd', repository, '--no-vectors'], {
          THREADNOTE_CODE_GRAPH_REFRESH_DEMAND_TOKEN: `cgdq_${'a'.repeat(32)}`,
        }),
      ).rejects.toMatchObject({code: 75});
    } finally {
      await rm(root, {force: true, recursive: true});
    }
  });

  it('rejects more than eight Context Brief code references during CLI parsing', async () => {
    const args = ['context', 'brief', '--task', 'Find memories linked to these files.'];
    for (let index = 0; index < 9; index += 1) args.push('--code-ref', `src/ref-${index}.ts`);

    const error = await runCli(args).catch(cause => cause as NodeJS.ErrnoException & {stderr?: string});

    expect(error).toMatchObject({code: 1});
    expect(String(error.stderr)).toContain('--code-ref');
  });

  it('rejects below-minimum Context Brief budgets and noncanonical code references actionably', async () => {
    const home = await mkdtemp(join(tmpdir(), 'threadnote-effect-cli-context-contract-'));
    try {
      const budgetError = await runCli(
        ['context', 'brief', '--budget-tokens', '799', '--task', 'Find the current contract.'],
        {THREADNOTE_HOME: home},
      ).catch(cause => cause as NodeJS.ErrnoException & {stderr?: string});
      expect(budgetError).toMatchObject({code: 1});
      expect(String(budgetError.stderr)).toContain('800');

      for (const [codeRef, expectedMessage] of [
        ['./src/index.ts', 'canonical'],
        [`cgs_${'a'.repeat(31)}`, 'cgs_<32 lowercase hex>'],
        [`cgr_${'a'.repeat(40)}`, 'cgr_ handle, which Context Brief does not support'],
      ] as const) {
        const refError = await runCli(
          ['context', 'brief', '--cwd', process.cwd(), '--code-ref', codeRef, '--task', 'Find the current contract.'],
          {THREADNOTE_HOME: home},
        ).catch(cause => cause as NodeJS.ErrnoException & {stderr?: string});
        expect(refError, codeRef).toMatchObject({code: 1});
        expect(String(refError.stderr), codeRef).toContain(expectedMessage);
      }
    } finally {
      await rm(home, {force: true, recursive: true});
    }
  });

  it('documents graph query paging scope and token bounds before execution', async () => {
    const query = await runCli(['graph', 'query', '--help']);

    expect(query.stdout).toContain('Requires --workset; maximum estimated tokens (1-1500)');
    expect(query.stdout).toContain('Requires --workset; opaque cgwc_ continuation from a prior query');
  });

  it('emits a path-free aggregate graph inventory preview', async () => {
    const root = await mkdtemp(join(tmpdir(), 'threadnote-effect-cli-inventory-'));
    try {
      await mkdir(join(root, 'assets'), {recursive: true});
      await mkdir(join(root, 'src'), {recursive: true});
      await mkdir(join(root, 'test', '__fixtures__'), {recursive: true});
      await writeFile(join(root, 'package.json'), '{"name":"inventory-preview"}\n');
      await writeFile(join(root, 'src', 'active.ts'), 'export const active = true;\n');
      await writeFile(join(root, 'src', 'ignored.ts'), 'export const ignored = true;\n');
      await writeFile(join(root, '.threadnoteignore'), 'src/ignored.ts\n');
      await writeFile(join(root, 'assets', 'icon.svg'), '<svg/>');
      await writeFile(join(root, 'test', '__fixtures__', 'payload.json'), '{}\n');
      await execFilePromise('git', ['-C', root, 'init', '-q']);
      await execFilePromise('git', ['-C', root, 'add', '.']);
      await execFilePromise('git', [
        '-C',
        root,
        '-c',
        'user.name=Threadnote Test',
        '-c',
        'user.email=test@threadnote.local',
        'commit',
        '-qm',
        'fixture',
      ]);

      const output = await runCli(['graph', 'inventory', '--cwd', root, '--json']);
      const preview = JSON.parse(output.stdout) as {
        readonly groups: ReadonlyArray<{
          readonly classifier: string;
          readonly disposition: string;
          readonly language: string;
          readonly reason: string;
          readonly role: string;
        }>;
        readonly totals: {readonly eligible: {readonly files: number}; readonly skipped: {readonly files: number}};
        readonly type: string;
        readonly version: number;
      };

      expect(preview).toMatchObject({type: 'code-graph-inventory-preview', version: 1});
      expect(preview.totals.eligible.files).toBe(2);
      expect(preview.totals.skipped.files).toBe(4);
      expect(preview.groups).toContainEqual(
        expect.objectContaining({
          classifier: 'corpus',
          disposition: 'skipped',
          language: 'document',
          reason: 'svg',
          role: 'corpus',
        }),
      );
      expect(preview.groups).toContainEqual(
        expect.objectContaining({
          classifier: 'typescript',
          disposition: 'skipped',
          reason: 'threadnote-ignore',
        }),
      );
      expect(output.stdout).not.toContain(root);
      for (const repositoryPath of ['src/active.ts', 'src/ignored.ts', 'assets/icon.svg']) {
        expect(output.stdout).not.toContain(repositoryPath);
      }
    } finally {
      await rm(root, {force: true, recursive: true});
    }
  });

  it('previews and applies an exact selected graph view through path-free JSON', async () => {
    const root = await mkdtemp(join(tmpdir(), 'threadnote-effect-cli-remove-view-'));
    const home = join(root, '.threadnote-test-home');
    try {
      await writeFile(join(root, 'package.json'), '{"name":"remove-view"}\n');
      await writeFile(join(root, 'index.ts'), 'export function selectedView(): number { return 1; }\n');
      await execFilePromise('git', ['-C', root, 'init', '-q']);
      await execFilePromise('git', ['-C', root, 'add', '.']);
      await execFilePromise('git', [
        '-C',
        root,
        '-c',
        'user.name=Threadnote Test',
        '-c',
        'user.email=test@threadnote.local',
        'commit',
        '-qm',
        'fixture',
      ]);
      const indexed = JSON.parse(
        (await runCli(['graph', 'index', '--home', home, '--cwd', root, '--no-vectors', '--json'])).stdout,
      ) as {
        readonly identity: {readonly checkoutId: string; readonly worktreeId: string};
        readonly snapshot: {readonly id: string};
      };
      const target = [
        '--home',
        home,
        '--checkout-id',
        indexed.identity.checkoutId,
        '--worktree-id',
        indexed.identity.worktreeId,
        '--snapshot-id',
        indexed.snapshot.id,
        '--json',
      ];

      const staleFailure = await runCli([
        'graph',
        'remove-view',
        '--home',
        home,
        '--checkout-id',
        indexed.identity.checkoutId,
        '--worktree-id',
        indexed.identity.worktreeId,
        '--snapshot-id',
        `cgsn_${'e'.repeat(40)}-direct`,
        '--json',
      ]).catch(cause => cause as NodeJS.ErrnoException & {readonly stderr?: string; readonly stdout?: string});
      const notFoundFailure = await runCli([
        'graph',
        'remove-view',
        '--home',
        home,
        '--checkout-id',
        indexed.identity.checkoutId,
        '--worktree-id',
        'f'.repeat(64),
        '--snapshot-id',
        indexed.snapshot.id,
        '--json',
      ]).catch(cause => cause as NodeJS.ErrnoException & {readonly stderr?: string; readonly stdout?: string});
      expect(staleFailure).toMatchObject({code: 1});
      expect(notFoundFailure).toMatchObject({code: 1});
      const stale = JSON.parse(String(staleFailure.stdout)) as {readonly applied: boolean; readonly state: string};
      const notFound = JSON.parse(String(notFoundFailure.stdout)) as {
        readonly applied: boolean;
        readonly state: string;
      };
      expect(stale).toMatchObject({applied: false, state: 'stale-target'});
      expect(notFound).toMatchObject({applied: false, state: 'not-found'});
      for (const failure of [staleFailure, notFoundFailure]) {
        expect(String(failure.stdout)).not.toContain(root);
        expect(String(failure.stdout)).not.toContain(home);
        expect(String(failure.stdout)).not.toContain('databasePath');
        expect(String(failure.stderr)).not.toContain(root);
      }

      const preview = JSON.parse((await runCli(['graph', 'remove-view', ...target])).stdout) as {
        readonly applied: boolean;
        readonly state: string;
      };
      const applied = JSON.parse((await runCli(['graph', 'remove-view', ...target, '--apply'])).stdout) as {
        readonly applied: boolean;
        readonly state: string;
        readonly type: string;
        readonly version: number;
      };
      const retry = JSON.parse((await runCli(['graph', 'remove-view', ...target, '--apply'])).stdout) as {
        readonly state: string;
      };

      expect(preview).toMatchObject({applied: false, state: 'ready'});
      expect(applied).toMatchObject({
        applied: true,
        state: 'removed',
        type: 'code-graph-view-removal',
        version: 1,
      });
      expect(retry.state).toBe('already-removed');
      expect(JSON.stringify(applied)).not.toContain(root);
      expect(JSON.stringify(applied)).not.toContain('databasePath');
      await expect(
        runCli(['graph', 'remove-view', '--checkout-id', indexed.identity.checkoutId]),
      ).rejects.toMatchObject({code: 1});
    } finally {
      await rm(root, {force: true, recursive: true});
    }
  }, 30_000);

  it('keeps graph index JSON parseable while streaming structured progress to stderr', async () => {
    const root = await mkdtemp(join(tmpdir(), 'threadnote-effect-cli-graph-json-progress-'));
    const home = join(root, '.threadnote-test-home');
    try {
      await writeFile(join(root, 'package.json'), '{"name":"json-progress"}\n');
      await writeFile(join(root, 'index.ts'), 'export function indexedSymbol(): number { return 1; }\n');
      await execFilePromise('git', ['-C', root, 'init', '-q']);
      await execFilePromise('git', ['-C', root, 'add', '.']);
      await execFilePromise('git', [
        '-C',
        root,
        '-c',
        'user.name=Threadnote Test',
        '-c',
        'user.email=test@threadnote.local',
        'commit',
        '-qm',
        'fixture',
      ]);

      const result = await runCli(['graph', 'index', '--home', home, '--cwd', root, '--json']);
      const summary = JSON.parse(result.stdout) as {readonly snapshot?: {readonly fileCount?: number}};
      const progress = result.stderr
        .split('\n')
        .filter(Boolean)
        .map(line => JSON.parse(line) as {readonly phase?: string; readonly type?: string});

      expect(summary.snapshot?.fileCount).toBe(2);
      expect(progress.length).toBeGreaterThan(0);
      expect(progress.every(event => event.type === 'code-graph-progress')).toBe(true);
      expect(progress.some(event => event.phase === 'scanning')).toBe(true);
    } finally {
      await rm(root, {force: true, recursive: true});
    }
  });

  it('returns a ready stale graph immediately after the checked-out commit changes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'threadnote-effect-cli-graph-stale-query-'));
    const home = join(root, '.threadnote-test-home');
    try {
      await writeFile(join(root, 'package.json'), '{"name":"stale-query"}\n');
      await writeFile(join(root, 'index.ts'), 'export function indexedBeforePull(): number { return 1; }\n');
      await execFilePromise('git', ['-C', root, 'init', '-q']);
      await execFilePromise('git', ['-C', root, 'add', '.']);
      await execFilePromise('git', [
        '-C',
        root,
        '-c',
        'user.name=Threadnote Test',
        '-c',
        'user.email=test@threadnote.local',
        'commit',
        '-qm',
        'indexed commit',
      ]);
      const indexedCommit = (await execFilePromise('git', ['-C', root, 'rev-parse', 'HEAD'])).stdout.trim();
      await runCli(['graph', 'index', '--home', home, '--cwd', root, '--json']);

      await writeFile(join(root, 'after-pull.ts'), 'export function addedAfterPull(): number { return 2; }\n');
      await execFilePromise('git', ['-C', root, 'add', 'after-pull.ts']);
      await execFilePromise('git', [
        '-C',
        root,
        '-c',
        'user.name=Threadnote Test',
        '-c',
        'user.email=test@threadnote.local',
        'commit',
        '-qm',
        'simulated pull',
      ]);

      const result = await runCli([
        'graph',
        'query',
        '--home',
        home,
        '--cwd',
        root,
        '--query',
        'indexedBeforePull',
        '--limit',
        '1',
        '--depth',
        '0',
        '--edge-limit',
        '1',
        '--json',
      ]);
      const graph = JSON.parse(result.stdout) as {
        readonly freshness?: string;
        readonly nodes?: readonly {readonly name?: string}[];
        readonly snapshot?: {readonly commit?: string};
      };

      expect(graph.freshness).toBe('stale');
      expect(graph.snapshot?.commit).toBe(indexedCommit);
      expect(graph.nodes?.some(node => node.name === 'indexedBeforePull')).toBe(true);
      expect(result.stderr).toBe('');
    } finally {
      await rm(root, {force: true, recursive: true});
    }
  }, 30_000);

  it('bounds cold analysis and report refreshes without leaving an indexing owner or report', async () => {
    const root = await mkdtemp(join(tmpdir(), 'threadnote-effect-cli-graph-analysis-timeout-'));
    const home = join(root, '.threadnote-test-home');
    const report = join(root, 'architecture.md');
    try {
      await writeFile(join(root, 'package.json'), '{"name":"analysis-timeout"}\n');
      await writeFile(join(root, 'index.ts'), 'export function boundedAnalysis(): number { return 1; }\n');
      await execFilePromise('git', ['-C', root, 'init', '-q']);
      await execFilePromise('git', ['-C', root, 'add', '.']);
      await execFilePromise('git', [
        '-C',
        root,
        '-c',
        'user.name=Threadnote Test',
        '-c',
        'user.email=test@threadnote.local',
        'commit',
        '-qm',
        'fixture',
      ]);

      const timedOut = await runCli([
        'graph',
        'analyze',
        '--home',
        home,
        '--cwd',
        root,
        '--view',
        'stats',
        '--read-timeout-ms',
        '1',
        '--json',
      ]);
      expect(JSON.parse(timedOut.stdout)).toMatchObject({
        budgetMilliseconds: 1,
        freshnessPolicy: 'ready',
        operation: 'stats',
        reason: 'read-timeout',
        state: 'timed-out',
        type: 'code-graph-analysis-state',
        version: 1,
      });
      expect(timedOut.stdout).not.toContain('"result"');

      const reportFailure = await runCli([
        'graph',
        'report',
        '--home',
        home,
        '--cwd',
        root,
        '--output',
        report,
        '--read-timeout-ms',
        '1',
      ]).catch(cause => cause as NodeJS.ErrnoException & {stderr?: string});
      expect(reportFailure).toMatchObject({code: 1});
      expect(String(reportFailure.stderr)).toContain('No analysis result was returned');
      expect(String(reportFailure.stderr)).toContain('Run graph index explicitly');
      expect(String(reportFailure.stderr)).toContain('report output was not created');
      await expect(access(report)).rejects.toMatchObject({code: 'ENOENT'});

      const recovered = JSON.parse(
        (await runCli(['graph', 'index', '--home', home, '--cwd', root, '--json'])).stdout,
      ) as {readonly snapshot?: {readonly fileCount?: number}};
      expect(recovered.snapshot?.fileCount).toBe(2);
    } finally {
      await rm(root, {force: true, recursive: true});
    }
  }, 30_000);

  it('analyzes a stale ready snapshot by default and refreshes only when current is requested', async () => {
    const root = await mkdtemp(join(tmpdir(), 'threadnote-effect-cli-graph-stale-analysis-'));
    const home = join(root, '.threadnote-test-home');
    try {
      await writeFile(join(root, 'package.json'), '{"name":"stale-analysis"}\n');
      await writeFile(join(root, 'index.ts'), 'export function indexedForAnalysis(): number { return 1; }\n');
      await execFilePromise('git', ['-C', root, 'init', '-q']);
      await execFilePromise('git', ['-C', root, 'add', '.']);
      await execFilePromise('git', [
        '-C',
        root,
        '-c',
        'user.name=Threadnote Test',
        '-c',
        'user.email=test@threadnote.local',
        'commit',
        '-qm',
        'fixture',
      ]);

      const unavailable = await runCli([
        'graph',
        'analyze',
        '--home',
        home,
        '--cwd',
        root,
        '--view',
        'stats',
        '--freshness',
        'allow-stale',
        '--json',
      ]);
      expect(JSON.parse(unavailable.stdout)).toMatchObject({
        freshnessPolicy: 'allow-stale',
        operation: 'stats',
        reason: 'no-ready-snapshot',
        state: 'unavailable',
        type: 'code-graph-analysis-state',
        version: 1,
      });
      expect(unavailable.stderr).toBe('');

      const indexed = JSON.parse(
        (await runCli(['graph', 'index', '--home', home, '--cwd', root, '--json'])).stdout,
      ) as {readonly snapshot: {readonly id: string}};
      await writeFile(join(root, 'index.ts'), 'export function changedForAnalysis(): number { return 2; }\n');

      const ready = await runCli(['graph', 'analyze', '--home', home, '--cwd', root, '--view', 'stats', '--json']);
      const readyAnalysis = JSON.parse(ready.stdout) as {
        readonly freshness: string;
        readonly freshnessPolicy: string;
        readonly result: {readonly snapshot: {readonly id: string}};
      };
      expect(readyAnalysis).toMatchObject({freshness: 'stale', freshnessPolicy: 'ready'});
      expect(readyAnalysis.result.snapshot.id).toBe(indexed.snapshot.id);
      expect(ready.stderr).toBe('');

      const current = await runCli([
        'graph',
        'analyze',
        '--home',
        home,
        '--cwd',
        root,
        '--view',
        'stats',
        '--freshness',
        'current',
        '--json',
      ]);
      const currentAnalysis = JSON.parse(current.stdout) as {
        readonly freshness: string;
        readonly freshnessPolicy: string;
        readonly result: {readonly snapshot: {readonly id: string}};
      };
      expect(currentAnalysis).toMatchObject({freshness: 'current', freshnessPolicy: 'current'});
      expect(currentAnalysis.result.snapshot.id).not.toBe(indexed.snapshot.id);
    } finally {
      await rm(root, {force: true, recursive: true});
    }
  }, 30_000);

  it('drains graph query JSON larger than the platform pipe buffer before exiting', async () => {
    const root = await mkdtemp(join(tmpdir(), 'threadnote-effect-cli-graph-large-output-'));
    const home = join(root, '.threadnote-test-home');
    try {
      const declarations = Array.from({length: 80}, (_, index) => {
        const name = `pipedOutputSymbol${'x'.repeat(2_500)}${index.toString().padStart(3, '0')}`;
        return `export const ${name} = ${index};`;
      }).join('\n');
      await writeFile(join(root, 'package.json'), '{"name":"large-piped-output"}\n');
      await writeFile(join(root, 'symbols.ts'), `${declarations}\n`);
      await execFilePromise('git', ['-C', root, 'init', '-q']);
      await execFilePromise('git', ['-C', root, 'add', '.']);
      await execFilePromise('git', [
        '-C',
        root,
        '-c',
        'user.name=Threadnote Test',
        '-c',
        'user.email=test@threadnote.local',
        'commit',
        '-qm',
        'fixture',
      ]);

      await runCli(['graph', 'index', '--home', home, '--cwd', root, '--json']);

      const result = await runCliThroughJsonPipe([
        'graph',
        'query',
        '--home',
        home,
        '--cwd',
        root,
        '--query',
        'pipedOutputSymbol',
        '--depth',
        '0',
        '--edge-limit',
        '1',
        '--node-limit',
        '200',
        '--json',
      ]);

      expect(result.bytes).toBeGreaterThan(65_536);
      expect(result.nodeCount).toBeGreaterThan(0);
      expect(result.allNamesMatched).toBe(true);
    } finally {
      await rm(root, {force: true, recursive: true});
    }
  }, 30_000);

  it('drains a large final payload before one-shot runtime teardown', async () => {
    const startedAt = performance.now();
    const child = Bun.spawn([process.execPath, 'apps/threadnote/test/fixtures/cli-output-exit-race.ts'], {
      cwd: process.cwd(),
      lazy: true,
      stderr: 'pipe',
      stdout: 'pipe',
    });
    await Bun.sleep(250);
    const [exitCode, stderr, stdout] = await Promise.all([
      child.exited,
      new Response(child.stderr).text(),
      new Response(child.stdout).text(),
    ]);

    expect(exitCode, stderr).toBe(0);
    expect(performance.now() - startedAt).toBeGreaterThanOrEqual(450);
    expect(Buffer.byteLength(stdout)).toBeGreaterThan(65_536);
    expect((JSON.parse(stdout) as {readonly value?: string}).value).toHaveLength(128 * 1024);
  });

  it('drains large generic CLI output through the application-wide safety net', async () => {
    const home = await mkdtemp(join(tmpdir(), 'threadnote-effect-cli-large-generic-output-'));
    const memoryText = `generic-output-start\n${'x'.repeat(128 * 1024)}\ngeneric-output-end`;
    try {
      const result = await runCliThroughTextPipe(
        [
          'remember',
          '--home',
          home,
          '--dry-run',
          '--stdin',
          '--project',
          'threadnote',
          '--topic',
          'generic-cli-output',
        ],
        memoryText,
      );

      expect(result.bytes).toBeGreaterThan(65_536);
      expect(result.hasStart).toBe(true);
      expect(result.hasEnd).toBe(true);
    } finally {
      await rm(home, {force: true, recursive: true});
    }
  });

  it('treats an early-closing stdout consumer as a normal CLI termination', async () => {
    const home = await mkdtemp(join(tmpdir(), 'threadnote-effect-cli-broken-pipe-'));
    const input = `consumer-prefix\n${'synthetic-memory-line\n'.repeat(64 * 1024)}`;
    try {
      const child = Bun.spawn(
        [
          process.execPath,
          'apps/threadnote/src/standalone.ts',
          'remember',
          '--home',
          home,
          '--dry-run',
          '--stdin',
          '--project',
          'threadnote',
          '--topic',
          'synthetic-broken-pipe',
        ],
        {
          cwd: process.cwd(),
          env: {...process.env, NO_COLOR: '1'},
          stdin: 'pipe',
          stderr: 'pipe',
          stdout: 'pipe',
        },
      );
      await child.stdin.write(input);
      await child.stdin.end();

      const stdout = child.stdout.getReader();
      const prefix = await stdout.read();
      await stdout.cancel();
      const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);

      expect(new TextDecoder().decode(prefix.value)).toContain('consumer-prefix');
      expect(stderr).toBe('');
      expect(exitCode).toBe(0);
    } finally {
      await rm(home, {force: true, recursive: true});
    }
  });

  it('includes eligible untracked files in Git-base impact analysis', async () => {
    const root = await mkdtemp(join(tmpdir(), 'threadnote-effect-cli-graph-'));
    const home = join(root, '.threadnote-test-home');
    try {
      await writeFile(join(root, 'tracked.ts'), 'export function trackedSymbol(): number { return 1; }\n');
      await execFilePromise('git', ['-C', root, 'init', '-q']);
      await execFilePromise('git', ['-C', root, 'add', 'tracked.ts']);
      await execFilePromise('git', [
        '-C',
        root,
        '-c',
        'user.name=Threadnote Test',
        '-c',
        'user.email=test@threadnote.local',
        'commit',
        '-qm',
        'fixture',
      ]);
      await writeFile(join(root, 'untracked.ts'), 'export function untrackedSymbol(): number { return 2; }\n');

      const result = await runCli([
        'graph',
        'impact',
        '--home',
        home,
        '--cwd',
        root,
        '--base',
        'HEAD',
        '--depth',
        '0',
        '--edge-limit',
        '1',
        '--node-limit',
        '20',
        '--json',
      ]);

      expect(result.stdout).toContain('"path":"untracked.ts"');
      expect(result.stdout).toContain('"name":"untrackedSymbol"');
    } finally {
      await rm(root, {force: true, recursive: true});
    }
  });

  it('recovers committed deletions from the exact CLI impact base', async () => {
    const root = await mkdtemp(join(tmpdir(), 'threadnote-effect-cli-graph-deleted-base-'));
    const home = join(root, '.threadnote-test-home');
    try {
      await writeFile(join(root, 'package.json'), '{"name":"deleted-base"}\n');
      await writeFile(join(root, 'dependency.ts'), 'export function deletedDependency(): number { return 1; }\n');
      await writeFile(
        join(root, 'consumer.ts'),
        "import {deletedDependency} from './dependency.js';\n" +
          'export function survivingConsumer(): number { return deletedDependency(); }\n',
      );
      await execFilePromise('git', ['-C', root, 'init', '-q']);
      await execFilePromise('git', ['-C', root, 'add', '.']);
      await execFilePromise('git', [
        '-C',
        root,
        '-c',
        'user.name=Threadnote Test',
        '-c',
        'user.email=test@threadnote.local',
        'commit',
        '-qm',
        'base',
      ]);
      const base = (await execFilePromise('git', ['-C', root, 'rev-parse', 'HEAD'])).stdout.trim();
      await rm(join(root, 'dependency.ts'));
      await execFilePromise('git', [
        '-C',
        root,
        '-c',
        'user.name=Threadnote Test',
        '-c',
        'user.email=test@threadnote.local',
        'commit',
        '-qam',
        'delete dependency',
      ]);

      const result = await runCli([
        'graph',
        'impact',
        '--home',
        home,
        '--cwd',
        root,
        '--base',
        base,
        '--depth',
        '1',
        '--json',
      ]);

      expect(result.stdout).toContain('"name":"survivingConsumer"');
      expect(result.stdout).toContain('deleted path(s) from base snapshot');
    } finally {
      await rm(root, {force: true, recursive: true});
    }
  });

  it('uses ready snapshots by default and refreshes stale reads only when current freshness is requested', async () => {
    const root = await mkdtemp(join(tmpdir(), 'threadnote-effect-cli-graph-freshness-'));
    const home = join(root, '.threadnote-test-home');
    try {
      await writeFile(join(root, 'package.json'), '{"name":"graph-freshness"}\n');
      await writeFile(join(root, 'index.ts'), 'export function firstGraphSymbol(): number { return 1; }\n');
      await execFilePromise('git', ['-C', root, 'init', '-q']);
      await execFilePromise('git', ['-C', root, 'add', '.']);
      await execFilePromise('git', [
        '-C',
        root,
        '-c',
        'user.name=Threadnote Test',
        '-c',
        'user.email=test@threadnote.local',
        'commit',
        '-qm',
        'fixture',
      ]);

      const first = await runCli([
        'graph',
        'query',
        '--home',
        home,
        '--cwd',
        root,
        '--query',
        'firstGraphSymbol',
        '--json',
      ]);
      expect(first.stdout).toContain('"name":"firstGraphSymbol"');

      await writeFile(join(root, 'index.ts'), 'export function queryRefreshSymbol(): number { return 2; }\n');
      const ready = await runCli([
        'graph',
        'query',
        '--home',
        home,
        '--cwd',
        root,
        '--query',
        'firstGraphSymbol',
        '--json',
      ]);
      expect(ready.stdout).toContain('"freshness":"stale"');
      expect(ready.stdout).toContain('"name":"firstGraphSymbol"');
      expect(ready.stdout).not.toContain('"name":"queryRefreshSymbol"');

      const query = await runCli([
        'graph',
        'query',
        '--home',
        home,
        '--cwd',
        root,
        '--query',
        'queryRefreshSymbol',
        '--freshness',
        'current',
        '--json',
      ]);
      expect(query.stdout).toContain('"freshness":"current"');
      expect(query.stdout).toContain('"name":"queryRefreshSymbol"');

      await writeFile(join(root, 'index.ts'), 'export function explainRefreshSymbol(): number { return 3; }\n');
      const explain = await runCli([
        'graph',
        'explain',
        '--home',
        home,
        '--cwd',
        root,
        '--symbol',
        'explainRefreshSymbol',
        '--freshness',
        'current',
        '--json',
      ]);
      expect(explain.stdout).toContain('"freshness":"current"');
      expect(explain.stdout).toContain('"name":"explainRefreshSymbol"');
    } finally {
      await rm(root, {force: true, recursive: true});
    }
  }, 30_000);

  it('fails fast for allow-stale without a snapshot and cancels bounded current refreshes cleanly', async () => {
    const root = await mkdtemp(join(tmpdir(), 'threadnote-effect-cli-graph-read-budget-'));
    const home = join(root, '.threadnote-test-home');
    try {
      await writeFile(join(root, 'package.json'), '{"name":"graph-read-budget"}\n');
      await writeFile(join(root, 'index.ts'), 'export function boundedReadSymbol(): number { return 1; }\n');
      await execFilePromise('git', ['-C', root, 'init', '-q']);
      await execFilePromise('git', ['-C', root, 'add', '.']);
      await execFilePromise('git', [
        '-C',
        root,
        '-c',
        'user.name=Threadnote Test',
        '-c',
        'user.email=test@threadnote.local',
        'commit',
        '-qm',
        'fixture',
      ]);

      const unavailable = await runCli([
        'graph',
        'query',
        '--home',
        home,
        '--cwd',
        root,
        '--query',
        'boundedReadSymbol',
        '--freshness',
        'allow-stale',
        '--json',
      ]);
      expect(JSON.parse(unavailable.stdout)).toMatchObject({
        freshnessPolicy: 'allow-stale',
        reason: 'no-ready-snapshot',
        state: 'unavailable',
        type: 'code-graph-query-state',
      });

      const humanTimedOut = await runCli([
        'graph',
        'query',
        '--home',
        home,
        '--cwd',
        root,
        '--query',
        'boundedReadSymbol',
        '--freshness',
        'current',
        '--read-timeout-ms',
        '1',
      ]);
      expect(humanTimedOut.stdout).toContain('Run graph index, then retry');
      expect(humanTimedOut.stdout).toContain('larger --read-timeout-ms');

      const timedOut = await runCli([
        'graph',
        'query',
        '--home',
        home,
        '--cwd',
        root,
        '--query',
        'boundedReadSymbol',
        '--freshness',
        'current',
        '--read-timeout-ms',
        '1',
        '--json',
      ]);
      const finalLine = timedOut.stdout.trim().split('\n').at(-1);
      expect(finalLine).toBeDefined();
      expect(JSON.parse(finalLine!)).toMatchObject({
        budgetMilliseconds: 1,
        freshnessPolicy: 'current',
        reason: 'read-timeout',
        state: 'timed-out',
        type: 'code-graph-query-state',
      });

      const recovered = await runCli([
        'graph',
        'query',
        '--home',
        home,
        '--cwd',
        root,
        '--query',
        'boundedReadSymbol',
        '--freshness',
        'current',
        '--json',
      ]);
      expect(recovered.stdout).toContain('"freshness":"current"');
      expect(recovered.stdout).toContain('"name":"boundedReadSymbol"');
    } finally {
      await rm(root, {force: true, recursive: true});
    }
  }, 30_000);

  it('rejects conflicting explicit update channels before checking GitHub', async () => {
    await expect(runCli(['update', '--beta', '--stable', '--check'])).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining('Choose either --beta or --stable'),
    });
  });

  it('accepts shared runtime flags after the subcommand', async () => {
    const home = await mkdtemp(join(tmpdir(), 'threadnote-effect-cli-'));
    try {
      const result = await runCli([
        'remember',
        '--home',
        home,
        '--dry-run',
        '--text',
        'CLI Effect composition',
        '--project',
        'threadnote',
        '--topic',
        'effect-cli',
      ]);
      expect(result.stdout).toContain('project: threadnote');
      expect(result.stdout).toContain('topic: effect-cli');
      expect(result.stdout).toContain('CLI Effect composition');
    } finally {
      await rm(home, {force: true, recursive: true});
    }
  });

  it('accepts explicit caller workspace context for recall', async () => {
    const result = await runCli([
      'recall',
      '--dry-run',
      '--caller-cwd',
      process.cwd(),
      '--query',
      'current repo latest handoff',
    ]);

    expect(result.stdout).toContain('current repo latest handoff');
    expect(result.stdout).toContain('threadnote');
    expect(result.stdout).toContain('threadnote://user/');
  });

  it('accepts compatibility aliases for memory command options', async () => {
    const home = await mkdtemp(join(tmpdir(), 'threadnote-effect-cli-compatibility-aliases-'));
    const durableUri = 'threadnote://user/compat/memories/durable/projects/threadnote/previous.md';
    const handoffUri = 'threadnote://user/compat/memories/handoffs/active/threadnote/previous.md';
    const environment = {THREADNOTE_HOME: home};
    try {
      const [recallResult, rememberResult, handoffResult, listResult] = await Promise.all([
        runCli(
          ['recall', '--dry-run', '--cwd', process.cwd(), '--limit', '1', '--query', 'compatibility aliases'],
          environment,
        ),
        runCli(
          [
            'remember',
            '--dry-run',
            '--text',
            'compatibility aliases',
            '--project',
            'threadnote',
            '--topic',
            'compatibility-aliases',
            `--replace-uri=${durableUri}`,
          ],
          environment,
        ),
        runCli(
          [
            'handoff',
            '--dry-run',
            '--task',
            'compatibility aliases',
            '--project',
            'threadnote',
            '--topic',
            'compatibility-aliases',
            `--replace-uri=${handoffUri}`,
          ],
          environment,
        ),
        runCli(['list', '--dry-run', '--limit', '1', 'threadnote://user/compat/memories'], environment),
      ]);

      expect(recallResult.stdout).toContain('Would search native recall index for "compatibility aliases"');
      expect(recallResult.stdout).toContain('/memories/durable/projects/threadnote');
      expect(rememberResult.stdout).toContain(`supersedes: ${durableUri}`);
      expect(rememberResult.stdout).toContain(`Would remove superseded native resource: ${durableUri}`);
      expect(handoffResult.stdout).toContain(`supersedes: ${handoffUri}`);
      expect(handoffResult.stdout).toContain(`Would remove superseded native resource: ${handoffUri}`);
      expect(listResult.stdout).toContain('Would list native resource: threadnote://user/compat/memories');
    } finally {
      await rm(home, {force: true, recursive: true});
    }
  });

  it('rejects retired daemon port flags', async () => {
    await expect(runCli(['--port', '70000', 'doctor', '--dry-run'])).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining('Unrecognized flag: --port'),
    });
  });

  it('does not revive daemon networking through legacy environment variables', async () => {
    const result = await runCli(['start', '--dry-run'], {
      THREADNOTE_HOST: '127.0.0.2',
      THREADNOTE_PORT: '24567',
    });

    expect(result.stdout).toContain('no daemon would be started');
    expect(result.stdout).not.toContain('127.0.0.2');
    expect(result.stdout).not.toContain('24567');
  });

  it('preserves dash-prefixed and equals-containing string values', async () => {
    const result = await runCli([
      'handoff',
      '--dry-run',
      '--project',
      'threadnote',
      '--topic',
      'cli-values',
      '--blockers',
      '- none',
      '--task=review=polish',
    ]);

    expect(result.stdout).toContain('blockers:\n- none');
    expect(result.stdout).toContain('task: review=polish');
  });

  it('renders expected Effect failures without a fiber dump', async () => {
    const error = await runCli(['remember', '--dry-run', '--text', '   ']).catch(
      cause => cause as NodeJS.ErrnoException,
    );

    expect(error).toMatchObject({code: 1});
    expect(String((error as NodeJS.ErrnoException & {stderr?: string}).stderr)).toContain(
      'Provide memory text with --text or --stdin.',
    );
    expect(String((error as NodeJS.ErrnoException & {stderr?: string}).stderr)).not.toContain('FiberFailure');
  });

  it('returns a non-zero exit code for an unknown subcommand', async () => {
    await expect(runCli(['definitely-not-a-command'])).rejects.toMatchObject({code: 1});
  });

  it('manages Threadnote projects through the public CLI and creates a missing scoped project from cwd', async () => {
    const root = await mkdtemp(join(tmpdir(), 'threadnote-effect-cli-projects-'));
    const manifestPath = join(root, 'seed-manifest.yaml');
    const repository = join(root, 'repository');
    try {
      await mkdir(repository, {recursive: true});
      await execFilePromise('git', ['init', '-q', '-b', 'main'], {cwd: repository});
      await writeFile(manifestPath, 'version: 1\nprojects: []\n');
      const environment = {THREADNOTE_HOME: root, THREADNOTE_MANIFEST: manifestPath};

      const created = await runCli(
        [
          'project',
          'create',
          'mobile',
          '--path',
          repository,
          '--uri',
          'threadnote://resources/repos/mobile',
          '--seed',
          'AGENTS.md',
          '--json',
        ],
        environment,
      );
      expect(JSON.parse(created.stdout)).toMatchObject({changed: true, operation: 'create', version: 1});
      expect(JSON.parse((await runCli(['project', 'list', '--json'], environment)).stdout)).toMatchObject({
        projects: [{name: 'mobile'}],
        version: 1,
      });
      expect(JSON.parse((await runCli(['project', 'show', 'MOBILE', '--json'], environment)).stdout)).toMatchObject({
        project: {name: 'mobile', seed: ['AGENTS.md'], uri: 'threadnote://resources/repos/mobile'},
        version: 1,
      });

      const beforeConflict = await readFile(manifestPath, 'utf8');
      await expect(
        runCli(['project', 'update', 'mobile', '--seed', 'docs/**/*.md', '--clear-seed'], environment),
      ).rejects.toMatchObject({code: 1});
      expect(await readFile(manifestPath, 'utf8')).toBe(beforeConflict);

      const updated = await runCli(
        ['project', 'update', 'mobile', '--name', 'mobile-app', '--seed', 'docs/**/*.md', '--json'],
        environment,
      );
      expect(JSON.parse(updated.stdout)).toMatchObject({changed: true, operation: 'update', version: 1});
      const cleared = await runCli(['project', 'update', 'mobile-app', '--clear-seed', '--json'], environment);
      expect(JSON.parse(cleared.stdout)).toMatchObject({changed: true, operation: 'update', version: 1});
      expect(JSON.parse((await runCli(['project', 'show', 'mobile-app', '--json'], environment)).stdout)).toMatchObject(
        {
          project: {name: 'mobile-app', seed: []},
        },
      );

      const beforeDelete = await readFile(manifestPath, 'utf8');
      await expect(runCli(['project', 'delete', 'mobile-app'], environment)).rejects.toMatchObject({code: 1});
      expect(await readFile(manifestPath, 'utf8')).toBe(beforeDelete);
      expect(
        JSON.parse((await runCli(['project', 'delete', 'mobile-app', '--confirm', '--json'], environment)).stdout),
      ).toMatchObject({changed: true, operation: 'delete', version: 1});

      const scoped = await runCli(
        ['graph', 'scope', 'set', 'docs-mobile', '--root', 'packages/mobile', '--json'],
        environment,
        repository,
      );
      expect(JSON.parse(scoped.stdout)).toMatchObject({changed: true, operation: 'created', project: 'docs-mobile'});
      expect(
        JSON.parse((await runCli(['project', 'show', 'docs-mobile', '--json'], environment)).stdout),
      ).toMatchObject({
        project: {graph: {closure: 'dependencies', roots: ['packages/mobile']}, name: 'docs-mobile'},
      });
    } finally {
      await rm(root, {force: true, recursive: true});
    }
  });

  it('keeps packaged examples immutable while bootstrapping project and scope state under --home', async () => {
    const home = await mkdtemp(join(tmpdir(), 'threadnote-effect-cli-isolated-home-'));
    const repository = join(home, 'repository');
    const packagedExample = join(process.cwd(), 'config', 'seed-manifest.example.yaml');
    const packagedBefore = await readFile(packagedExample, 'utf8');
    try {
      await mkdir(join(repository, 'apps', 'demo'), {recursive: true});
      await execFilePromise('git', ['init', '-q', '-b', 'main'], {cwd: repository});

      await runCli(['project', 'create', 'isolated', '--home', home, '--path', repository, '--json'], {}, repository);
      await runCli(
        ['graph', 'scope', 'set', 'isolated', '--home', home, '--root', 'apps/demo', '--json'],
        {},
        repository,
      );

      const userManifest = await readFile(join(home, 'seed-manifest.yaml'), 'utf8');
      expect(userManifest).toContain('name: isolated');
      expect(userManifest).toContain('roots:');
      expect(userManifest).toContain('apps/demo');
      expect(await readFile(packagedExample, 'utf8')).toBe(packagedBefore);
    } finally {
      await rm(home, {recursive: true, force: true});
    }
  });

  it('manages workset definitions through the CLI with stable JSON output and explicit deletion confirmation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'threadnote-effect-cli-worksets-'));
    const manifestPath = join(root, 'seed-manifest.yaml');
    try {
      await writeFile(
        manifestPath,
        [
          'version: 1',
          'projects:',
          '  - name: api',
          '    path: /workspace/api',
          '    uri: threadnote://resources/repos/api',
          '    seed: []',
          '  - name: worker',
          '    path: /workspace/worker',
          '    uri: threadnote://resources/repos/worker',
          '    seed: []',
          '',
        ].join('\n'),
      );
      const environment = {THREADNOTE_HOME: root, THREADNOTE_MANIFEST: manifestPath};

      await expect(runCli(['workset', 'create', 'empty', '--json'], environment)).rejects.toMatchObject({code: 1});
      const created = await runCli(
        ['workset', 'create', 'platform', '--project', 'api', '--description', 'Shared runtime', '--json'],
        environment,
      );
      expect(JSON.parse(created.stdout)).toMatchObject({changed: true, operation: 'create', version: 1});

      const listed = await runCli(['workset', 'list', '--json'], environment);
      expect(JSON.parse(listed.stdout)).toMatchObject({
        version: 1,
        worksets: [{description: 'Shared runtime', memberCount: 1, name: 'platform'}],
      });

      const shown = await runCli(['workset', 'show', 'PLATFORM', '--json'], environment);
      expect(JSON.parse(shown.stdout)).toMatchObject({
        version: 1,
        workset: {
          name: 'platform',
          members: [{configured: true, project: 'api', uri: 'threadnote://resources/repos/api'}],
        },
      });
      const shownText = await runCli(['workset', 'show', 'platform'], environment);
      expect(shownText.stdout).toContain('- api (threadnote://resources/repos/api)');

      const updated = await runCli(
        ['workset', 'update', 'platform', '--name', 'core', '--project', 'worker', '--json'],
        environment,
      );
      expect(JSON.parse(updated.stdout)).toMatchObject({changed: true, operation: 'update', version: 1});

      const renamedText = await runCli(['workset', 'update', 'core', '--name', 'platform'], environment);
      expect(renamedText.stdout).toContain('Updated workset: platform');

      const unchanged = await runCli(['workset', 'update', 'platform', '--json'], environment);
      expect(JSON.parse(unchanged.stdout)).toMatchObject({changed: false, operation: 'update', version: 1});

      await expect(runCli(['workset', 'delete', 'platform'], environment)).rejects.toMatchObject({code: 1});
      expect((await runCli(['workset', 'show', 'platform', '--json'], environment)).stdout).toContain('"platform"');

      const deleted = await runCli(['workset', 'delete', 'platform', '--confirm', '--json'], environment);
      expect(JSON.parse(deleted.stdout)).toMatchObject({changed: true, operation: 'delete', version: 1});

      // Manager permits U+0085, so every CLI selector must use its shared validator rather than a Unicode category check.
      const c1Name = 'platform\u0085';
      await runCli(['workset', 'create', c1Name, '--project', 'api'], environment);
      expect(JSON.parse((await runCli(['workset', 'show', c1Name, '--json'], environment)).stdout)).toMatchObject({
        workset: {name: c1Name},
      });
      await expect(runCli(['workset', 'update', c1Name, '--json'], environment)).resolves.toBeDefined();
      await expect(runCli(['workset', 'delete', c1Name, '--confirm', '--json'], environment)).resolves.toBeDefined();

      for (const invalid of [' ', 'bad\u001fname', 'x'.repeat(257)]) {
        await expect(runCli(['workset', 'show', invalid], environment)).rejects.toMatchObject({
          code: 1,
          stderr: expect.stringContaining('workset must be bounded text without control characters.'),
        });
        await expect(runCli(['workset', 'update', invalid], environment)).rejects.toMatchObject({
          code: 1,
          stderr: expect.stringContaining('workset must be bounded text without control characters.'),
        });
        await expect(runCli(['workset', 'delete', invalid, '--confirm'], environment)).rejects.toMatchObject({
          code: 1,
          stderr: expect.stringContaining('workset must be bounded text without control characters.'),
        });
      }
    } finally {
      await rm(root, {force: true, recursive: true});
    }
  });

  it('makes the full Workset lifecycle discoverable without changing prepare compatibility', async () => {
    const help = await runCli(['workset', '--help']);
    expect(help.stdout).toContain('create');
    expect(help.stdout).toContain('update');
    expect(help.stdout).toContain('delete');
    expect(help.stdout).toContain('prepare');
    expect((await runCli(['workset', 'delete', '--help'])).stdout).toContain('--confirm');
  });
});

function runCli(args: readonly string[], environment: NodeJS.ProcessEnv = {}, cwd = process.cwd()) {
  return execFilePromise(
    process.execPath,
    [join(process.cwd(), 'apps', 'threadnote', 'src', 'standalone.ts'), ...args],
    {
      cwd,
      env: {...process.env, ...environment, NO_COLOR: '1'},
    },
  );
}

async function runCliThroughJsonPipe(args: readonly string[]) {
  return (await runCliThroughPlatformPipe(args, 'json')) as {
    readonly allNamesMatched: boolean;
    readonly bytes: number;
    readonly nodeCount: number;
  };
}

async function runCliThroughTextPipe(args: readonly string[], input: string) {
  return (await runCliThroughPlatformPipe(args, 'text', input)) as {
    readonly bytes: number;
    readonly hasEnd: boolean;
    readonly hasStart: boolean;
  };
}

async function runCliThroughPlatformPipe(
  args: readonly string[],
  mode: 'json' | 'text',
  input?: string,
): Promise<unknown> {
  const root = await mkdtemp(join(tmpdir(), 'threadnote-effect-cli-platform-pipe-'));
  try {
    const windows = process.platform === 'win32';
    const scriptPath = join(root, windows ? 'pipeline.cmd' : 'pipeline.sh');
    const inputPath = join(root, 'input.txt');
    if (input !== undefined) await writeFile(inputPath, input);
    const quote = (value: string): string =>
      windows ? `"${value.replaceAll('%', '%%').replaceAll('"', '""')}"` : `'${value.replaceAll("'", `'\\''`)}'`;
    const producer = [process.execPath, 'apps/threadnote/src/standalone.ts', ...args].map(quote).join(' ');
    const consumer = [process.execPath, 'apps/threadnote/test/fixtures/cli-output-consumer.ts', mode]
      .map(quote)
      .join(' ');
    const pipeline = `${producer}${input === undefined ? '' : ` < ${quote(inputPath)}`} | ${consumer}`;
    await writeFile(scriptPath, windows ? `@echo off\r\n${pipeline}\r\n` : `set -eu\n${pipeline}\n`);

    const shell = windows
      ? [process.env.ComSpec ?? process.env.COMSPEC ?? 'cmd.exe', '/d', '/s', '/c', scriptPath]
      : ['/bin/sh', scriptPath];
    const child = Bun.spawn(shell, {
      cwd: process.cwd(),
      env: {...process.env, NO_COLOR: '1'},
      stderr: 'pipe',
      stdout: 'pipe',
    });
    const [exitCode, stderr, stdout] = await Promise.all([
      child.exited,
      new Response(child.stderr).text(),
      new Response(child.stdout).text(),
    ]);
    if (exitCode !== 0) {
      throw TestError.make({message: `CLI ${mode} platform pipe failed with ${exitCode}.\n${stderr}`});
    }
    return JSON.parse(stdout);
  } finally {
    await rm(root, {force: true, recursive: true});
  }
}
