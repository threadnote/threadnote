import {CODE_GRAPH_ISOLATED_BUILDER_ENV} from '@threadnote/graph/scope/routing';
import {execFile} from '@threadnote/testing/node-child-process';
import {mkdir, mkdtemp, rm, writeFile} from '@threadnote/testing/node-fs-promises';
import {tmpdir} from '@threadnote/testing/node-os';
import {join} from '@threadnote/testing/node-path';
import {promisify} from '@threadnote/testing/node-util';
import {describe, expect, it} from 'vitest';

const execFilePromise = promisify(execFile);

describe('code graph CLI project selection', () => {
  it('parses --project on scoped graph commands', async () => {
    for (const command of [
      'inventory',
      'index',
      'status',
      'query',
      'node',
      'neighbors',
      'explain',
      'path',
      'impact',
      'watch',
      'analyze',
    ]) {
      const help = await runCli(['graph', command, '--help']);
      expect(help.stdout, command).toContain('--project string');
    }
  }, 30_000);

  it('uses an explicit project to resolve an ambiguous cwd and retains named full-graph projects', async () => {
    const root = await mkdtemp(join(tmpdir(), 'threadnote-graph-cli-project-'));
    const home = join(root, '.threadnote-home');
    const manifest = join(home, 'seed-manifest.yaml');
    try {
      for (const name of ['a', 'b']) {
        await mkdir(join(root, 'apps', name), {recursive: true});
        await writeFile(join(root, 'apps', name, 'package.json'), JSON.stringify({name: `@fixture/${name}`}));
        await writeFile(join(root, 'apps', name, 'index.ts'), `export const ${name} = '${name}';\n`);
      }
      await writeFile(join(root, 'package.json'), JSON.stringify({private: true, workspaces: ['apps/*']}));
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
      await mkdir(home, {recursive: true});
      await writeFile(
        manifest,
        [
          'version: 1',
          'projects:',
          '  - name: a',
          `    path: ${root}`,
          '    seed: []',
          '    uri: threadnote://resources/repos/a',
          '    graph:',
          '      closure: dependencies',
          '      roots: [apps/a]',
          '  - name: b',
          `    path: ${root}`,
          '    seed: []',
          '    uri: threadnote://resources/repos/b',
          '    graph:',
          '      closure: dependencies',
          '      roots: [apps/b]',
          '  - name: full',
          `    path: ${root}`,
          '    seed: []',
          '    uri: threadnote://resources/repos/full',
          '',
        ].join('\n'),
      );
      const base = ['--home', home, '--manifest', manifest, '--cwd', root];
      const ambiguous = await runCli(['graph', 'index', ...base, '--no-vectors']).catch(asProcessError);
      expect(ambiguous).toMatchObject({code: 1});
      expect(String(ambiguous.stderr)).toContain('Graph scope is ambiguous');
      expect(String(ambiguous.stderr)).toContain('2 configured scopes match');
      expect(String(ambiguous.stderr)).toContain('Set project (or CLI --project)');
      expect(String(ambiguous.stderr)).toContain('- a: apps/a');
      expect(String(ambiguous.stderr)).toContain('- b: apps/b');

      const ambiguousBrief = await runCli(['context', 'brief', ...base, '--task', 'find a']).catch(asProcessError);
      expect(ambiguousBrief).toMatchObject({code: 1});
      expect(String(ambiguousBrief.stderr)).toContain('Graph scope is ambiguous');
      expect(String(ambiguousBrief.stderr)).toContain('- a: apps/a');
      expect(String(ambiguousBrief.stderr)).toContain('- b: apps/b');
      expect(String(ambiguousBrief.stderr)).not.toContain('graph-query-unavailable');
      const isolatedEnvironment = {...process.env, [CODE_GRAPH_ISOLATED_BUILDER_ENV]: '1'};
      const child = await runCli(['graph', 'index', ...base, '--no-vectors'], isolatedEnvironment).catch(
        asProcessError,
      );
      expect(child).toMatchObject({code: 78});
      const markedBrief = await runCli(['context', 'brief', ...base, '--task', 'find a'], isolatedEnvironment).catch(
        asProcessError,
      );
      expect(markedBrief).toMatchObject({code: 1});

      const indexed = await runCli(['graph', 'index', ...base, '--project', 'a', '--no-vectors', '--json']);
      expect(JSON.parse(indexed.stdout)).toMatchObject({
        snapshot: {scopeId: expect.stringMatching(/^code-graph-scope:/)},
      });

      const status = JSON.parse((await runCli(['graph', 'status', ...base, '--project', 'a', '--json'])).stdout);
      expect(status).toMatchObject({projectCoverage: {kind: 'project', project: 'a'}});

      const query = JSON.parse(
        (await runCli(['graph', 'query', ...base, '--project', 'a', '--query', 'a', '--json'])).stdout,
      );
      expect(query).toMatchObject({projectCoverage: {project: 'a'}});

      const brief = JSON.parse(
        (await runCli(['context', 'brief', ...base, '--project', 'a', '--task', 'find a', '--json'])).stdout,
      );
      expect(brief).toMatchObject({scope: {projectCoverage: {project: 'a'}, readyRepositories: 1}});

      const nestedBrief = JSON.parse(
        (
          await runCli([
            'context',
            'brief',
            '--home',
            home,
            '--manifest',
            manifest,
            '--cwd',
            join(root, 'apps', 'a'),
            '--task',
            'find a',
            '--json',
          ])
        ).stdout,
      );
      expect(nestedBrief).toMatchObject({scope: {projectCoverage: {project: 'a'}, readyRepositories: 1}});

      const inventory = JSON.parse((await runCli(['graph', 'inventory', ...base, '--project', 'a', '--json'])).stdout);
      expect(inventory.totals.repository.files).toBeLessThan(5);

      const full = JSON.parse(
        (await runCli(['graph', 'index', ...base, '--project', 'full', '--no-vectors', '--json'])).stdout,
      );
      expect(full.snapshot.scopeId).toBeUndefined();

      const unknown = await runCli(['graph', 'status', ...base, '--project', 'missing']).catch(asProcessError);
      expect(unknown).toMatchObject({code: 1});
      expect(String(unknown.stderr)).toContain('No configured graph project named "missing" exists.');
      expect(String(unknown.stderr)).toContain('threadnote project list');
      expect(String(unknown.stderr)).toContain('threadnote project create <name> --path <repository>');
      expect(String(unknown.stderr)).toContain('omit project/--project to infer scope from callerCwd/--cwd');
    } finally {
      await rm(root, {force: true, recursive: true});
    }
  }, 60_000);

  it('selects a configured project by checkout identity from a linked worktree', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'threadnote-graph-cli-linked-project-'));
    const root = join(fixture, 'repository');
    const linked = join(fixture, 'linked');
    const home = join(fixture, '.threadnote-home');
    const manifest = join(home, 'seed-manifest.yaml');
    try {
      await mkdir(join(root, 'apps', 'web'), {recursive: true});
      await writeFile(join(root, 'package.json'), JSON.stringify({private: true, workspaces: ['apps/*']}));
      await writeFile(join(root, 'apps', 'web', 'package.json'), JSON.stringify({name: '@fixture/web'}));
      await writeFile(join(root, 'apps', 'web', 'index.ts'), 'export const web = true;\n');
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
      await execFilePromise('git', ['-C', root, 'worktree', 'add', '--detach', linked, 'HEAD']);
      await mkdir(home, {recursive: true});
      await writeFile(
        manifest,
        [
          'version: 1',
          'projects:',
          '  - name: web',
          `    path: ${root}`,
          '    seed: []',
          '    uri: threadnote://resources/repos/web',
          '    graph:',
          '      closure: dependencies',
          '      roots: [apps/web]',
          '',
        ].join('\n'),
      );
      const base = ['--home', home, '--manifest', manifest, '--cwd', linked];
      const indexed = JSON.parse(
        (await runCli(['graph', 'index', ...base, '--project', 'web', '--no-vectors', '--json'])).stdout,
      );
      expect(indexed).toMatchObject({snapshot: {scopeId: expect.stringMatching(/^code-graph-scope:/u)}});
      const status = JSON.parse((await runCli(['graph', 'status', ...base, '--json'])).stdout);
      expect(status).toMatchObject({projectCoverage: {kind: 'project', project: 'web'}});
      const automaticQuery = JSON.parse((await runCli(['graph', 'query', ...base, '--query', 'web', '--json'])).stdout);
      expect(automaticQuery).toMatchObject({projectCoverage: {kind: 'project', project: 'web'}});
      const explicitStatus = JSON.parse(
        (await runCli(['graph', 'status', ...base, '--project', 'web', '--json'])).stdout,
      );
      expect(explicitStatus).toMatchObject({projectCoverage: {kind: 'project', project: 'web'}});
    } finally {
      await rm(fixture, {force: true, recursive: true});
    }
  }, 60_000);

  it('coalesces explicit and nested inferred routes inside a linked worktree while isolating sibling scopes', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'threadnote-graph-cli-linked-siblings-'));
    const root = join(fixture, 'repository');
    const linked = join(fixture, 'linked');
    const home = join(fixture, '.threadnote-home');
    const manifest = join(home, 'seed-manifest.yaml');
    try {
      for (const name of ['a', 'b']) {
        await mkdir(join(root, 'apps', name), {recursive: true});
        await writeFile(join(root, 'apps', name, 'package.json'), JSON.stringify({name: `@fixture/${name}`}));
        await writeFile(join(root, 'apps', name, 'index.ts'), `export const ${name} = '${name}';\n`);
      }
      await writeFile(join(root, 'package.json'), JSON.stringify({private: true, workspaces: ['apps/*']}));
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
      await execFilePromise('git', ['-C', root, 'worktree', 'add', '--detach', linked, 'HEAD']);
      await mkdir(home, {recursive: true});
      await writeFile(
        manifest,
        [
          'version: 1',
          'projects:',
          ...['a', 'b'].flatMap(name => [
            `  - name: ${name}`,
            `    path: ${root}`,
            '    seed: []',
            `    uri: threadnote://resources/repos/${name}`,
            '    graph:',
            '      closure: dependencies',
            `      roots: [apps/${name}]`,
          ]),
          '',
        ].join('\n'),
      );

      const explicit = JSON.parse(
        (
          await runCli([
            'graph',
            'index',
            '--home',
            home,
            '--manifest',
            manifest,
            '--cwd',
            linked,
            '--project',
            'a',
            '--no-vectors',
            '--json',
          ])
        ).stdout,
      );
      const inferred = JSON.parse(
        (
          await runCli([
            'graph',
            'status',
            '--home',
            home,
            '--manifest',
            manifest,
            '--cwd',
            join(linked, 'apps', 'a'),
            '--json',
          ])
        ).stdout,
      );
      expect(inferred).toMatchObject({
        projectCoverage: {kind: 'project', project: 'a'},
        readySnapshot: {id: explicit.snapshot.id},
      });

      const sibling = JSON.parse(
        (
          await runCli([
            'graph',
            'status',
            '--home',
            home,
            '--manifest',
            manifest,
            '--cwd',
            join(linked, 'apps', 'b'),
            '--json',
          ])
        ).stdout,
      );
      expect(sibling).toMatchObject({projectCoverage: {kind: 'project', project: 'b'}});
      expect(sibling.readySnapshot).toBeNull();
    } finally {
      await rm(fixture, {force: true, recursive: true});
    }
  }, 60_000);

  it('does not infer a nested independent repository from an outer linked worktree', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'threadnote-graph-cli-linked-nested-repository-'));
    const root = join(fixture, 'repository');
    const linked = join(fixture, 'linked');
    const nested = join(root, 'vendor', 'other');
    const home = join(fixture, '.threadnote-home');
    const manifest = join(home, 'seed-manifest.yaml');
    try {
      for (const name of ['a', 'b']) {
        await mkdir(join(root, 'apps', name), {recursive: true});
        await writeFile(join(root, 'apps', name, 'package.json'), JSON.stringify({name: `@fixture/${name}`}));
        await writeFile(join(root, 'apps', name, 'index.ts'), `export const ${name} = '${name}';\n`);
      }
      await writeFile(join(root, 'package.json'), JSON.stringify({private: true, workspaces: ['apps/*']}));
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
      await execFilePromise('git', ['-C', root, 'worktree', 'add', '--detach', linked, 'HEAD']);

      await mkdir(join(nested, 'apps', 'b'), {recursive: true});
      await writeFile(join(nested, 'apps', 'b', 'package.json'), JSON.stringify({name: '@fixture/foreign-b'}));
      await writeFile(join(nested, 'apps', 'b', 'index.ts'), 'export const foreignB = true;\n');
      await execFilePromise('git', ['-C', nested, 'init', '-q']);
      await execFilePromise('git', ['-C', nested, 'add', '.']);
      await execFilePromise('git', [
        '-C',
        nested,
        '-c',
        'user.name=Threadnote Test',
        '-c',
        'user.email=test@threadnote.local',
        'commit',
        '-qm',
        'nested fixture',
      ]);

      await mkdir(home, {recursive: true});
      await writeFile(
        manifest,
        [
          'version: 1',
          'projects:',
          '  - name: outer',
          `    path: ${root}`,
          '    seed: []',
          '    uri: threadnote://resources/repos/outer',
          '    graph:',
          '      closure: dependencies',
          '      roots: [apps/a]',
          '  - name: foreign',
          `    path: ${nested}`,
          '    seed: []',
          '    uri: threadnote://resources/repos/foreign',
          '    graph:',
          '      closure: dependencies',
          '      roots: [apps/b]',
          '',
        ].join('\n'),
      );

      const explicit = JSON.parse(
        (
          await runCli([
            'graph',
            'index',
            '--home',
            home,
            '--manifest',
            manifest,
            '--cwd',
            linked,
            '--project',
            'outer',
            '--no-vectors',
            '--json',
          ])
        ).stdout,
      );
      const inferred = JSON.parse(
        (
          await runCli([
            'graph',
            'status',
            '--home',
            home,
            '--manifest',
            manifest,
            '--cwd',
            join(linked, 'apps', 'b'),
            '--json',
          ])
        ).stdout,
      );
      expect(inferred).toMatchObject({
        projectCoverage: {kind: 'project', project: 'outer'},
        readySnapshot: {id: explicit.snapshot.id},
      });
    } finally {
      await rm(fixture, {force: true, recursive: true});
    }
  }, 60_000);

  it('selects the sole configured scope from the monorepo root without building the full repository', async () => {
    const root = await mkdtemp(join(tmpdir(), 'threadnote-graph-cli-root-scope-'));
    const home = join(root, '.threadnote-home');
    const manifest = join(home, 'seed-manifest.yaml');
    try {
      await mkdir(join(root, 'apps', 'web'), {recursive: true});
      await mkdir(join(root, 'apps', 'unrelated'), {recursive: true});
      await writeFile(join(root, 'package.json'), JSON.stringify({private: true, workspaces: ['apps/*']}));
      await writeFile(join(root, 'apps', 'web', 'package.json'), JSON.stringify({name: '@fixture/web'}));
      await writeFile(join(root, 'apps', 'web', 'index.ts'), 'export const web = true;\n');
      await writeFile(join(root, 'apps', 'unrelated', 'package.json'), JSON.stringify({name: '@fixture/unrelated'}));
      await writeFile(join(root, 'apps', 'unrelated', 'index.ts'), 'export const unrelated = true;\n');
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
      await mkdir(home, {recursive: true});
      await writeFile(
        manifest,
        [
          'version: 1',
          'projects:',
          '  - name: web',
          `    path: ${root}`,
          '    seed: []',
          '    uri: threadnote://resources/repos/web',
          '    graph:',
          '      closure: dependencies',
          '      roots: [apps/web]',
          '',
        ].join('\n'),
      );

      const base = ['--home', home, '--manifest', manifest, '--cwd', root];
      const indexed = JSON.parse((await runCli(['graph', 'index', ...base, '--no-vectors', '--json'])).stdout);
      expect(indexed).toMatchObject({snapshot: {scopeId: expect.stringMatching(/^code-graph-scope:/u)}});
      expect(indexed.snapshot.fileCount).toBeLessThan(4);
      const status = JSON.parse((await runCli(['graph', 'status', ...base, '--json'])).stdout);
      expect(status).toMatchObject({projectCoverage: {kind: 'project', project: 'web'}});
    } finally {
      await rm(root, {force: true, recursive: true});
    }
  }, 60_000);

  it('resolves a configured graph root alias to its owning multi-app project', async () => {
    const root = await mkdtemp(join(tmpdir(), 'threadnote-graph-cli-root-alias-'));
    const home = join(root, '.threadnote-home');
    const manifest = join(home, 'seed-manifest.yaml');
    try {
      for (const name of ['docs', 'docs-mobile', 'unrelated']) {
        await mkdir(join(root, 'apps', name), {recursive: true});
        await writeFile(join(root, 'apps', name, 'package.json'), JSON.stringify({name: `@fixture/${name}`}));
        await writeFile(join(root, 'apps', name, 'index.ts'), `export const ${name.replace('-', '_')} = true;\n`);
      }
      await writeFile(join(root, 'package.json'), JSON.stringify({private: true, workspaces: ['apps/*']}));
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
      await mkdir(home, {recursive: true});
      await writeFile(
        manifest,
        [
          'version: 1',
          'projects:',
          '  - name: docs',
          `    path: ${root}`,
          '    seed: []',
          '    uri: threadnote://resources/repos/docs',
          '    graph:',
          '      closure: dependencies',
          '      roots: [apps/docs, apps/docs-mobile]',
          '',
        ].join('\n'),
      );

      const base = ['--home', home, '--manifest', manifest, '--cwd', join(root, 'apps', 'docs-mobile')];
      const indexed = JSON.parse((await runCli(['graph', 'index', ...base, '--no-vectors', '--json'])).stdout);
      expect(indexed.snapshot.fileCount).toBeLessThan(6);
      expect(indexed.snapshot.scopeId).toMatch(/^code-graph-scope:/u);

      const status = JSON.parse(
        (await runCli(['graph', 'status', ...base, '--project', 'docs-mobile', '--json'])).stdout,
      );
      expect(status).toMatchObject({projectCoverage: {kind: 'project', project: 'docs'}});
    } finally {
      await rm(root, {force: true, recursive: true});
    }
  }, 60_000);

  it('resolves duplicate graph root aliases within the caller repository', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'threadnote-graph-cli-repository-alias-'));
    const first = join(fixture, 'first');
    const second = join(fixture, 'second');
    const home = join(fixture, '.threadnote-home');
    const manifest = join(home, 'seed-manifest.yaml');
    try {
      for (const root of [first, second]) {
        await mkdir(join(root, 'apps', 'web'), {recursive: true});
        await writeFile(join(root, 'package.json'), JSON.stringify({private: true, workspaces: ['apps/*']}));
        await writeFile(join(root, 'apps', 'web', 'package.json'), JSON.stringify({name: '@fixture/web'}));
        await writeFile(join(root, 'apps', 'web', 'index.ts'), `export const repository = '${root}';\n`);
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
      }
      await mkdir(home, {recursive: true});
      await writeFile(
        manifest,
        [
          'version: 1',
          'projects:',
          '  - name: first-web',
          `    path: ${first}`,
          '    seed: []',
          '    uri: threadnote://resources/repos/first-web',
          '    graph:',
          '      closure: dependencies',
          '      roots: [apps/web]',
          '  - name: second-web',
          `    path: ${second}`,
          '    seed: []',
          '    uri: threadnote://resources/repos/second-web',
          '    graph:',
          '      closure: dependencies',
          '      roots: [apps/web]',
          '',
        ].join('\n'),
      );

      const selected = JSON.parse(
        (
          await runCli([
            'graph',
            'index',
            '--home',
            home,
            '--manifest',
            manifest,
            '--cwd',
            join(second, 'apps', 'web'),
            '--project',
            'web',
            '--no-vectors',
            '--json',
          ])
        ).stdout,
      );
      expect(selected).toMatchObject({snapshot: {scopeId: expect.stringMatching(/^code-graph-scope:/u)}});
      const status = JSON.parse(
        (
          await runCli([
            'graph',
            'status',
            '--home',
            home,
            '--manifest',
            manifest,
            '--cwd',
            join(second, 'apps', 'web'),
            '--project',
            'web',
            '--json',
          ])
        ).stdout,
      );
      expect(status).toMatchObject({projectCoverage: {kind: 'project', project: 'second-web'}});
    } finally {
      await rm(fixture, {force: true, recursive: true});
    }
  }, 60_000);

  it('does not treat a nested independent repository as an alias candidate for its parent repository', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'threadnote-graph-cli-nested-repository-alias-'));
    const outer = join(fixture, 'outer');
    const nested = join(outer, 'nested');
    const home = join(fixture, '.threadnote-home');
    const manifest = join(home, 'seed-manifest.yaml');
    try {
      await mkdir(join(outer, 'apps', 'web'), {recursive: true});
      await writeFile(join(outer, 'package.json'), JSON.stringify({private: true, workspaces: ['apps/*']}));
      await writeFile(join(outer, 'apps', 'web', 'package.json'), JSON.stringify({name: '@fixture/outer-web'}));
      await writeFile(join(outer, 'apps', 'web', 'index.ts'), 'export const outerWeb = true;\n');
      await writeFile(join(outer, '.gitignore'), 'nested/\n');
      await execFilePromise('git', ['-C', outer, 'init', '-q']);
      await execFilePromise('git', ['-C', outer, 'add', '.']);
      await execFilePromise('git', [
        '-C',
        outer,
        '-c',
        'user.name=Threadnote Test',
        '-c',
        'user.email=test@threadnote.local',
        'commit',
        '-qm',
        'outer fixture',
      ]);

      await mkdir(join(nested, 'apps', 'web'), {recursive: true});
      await writeFile(join(nested, 'package.json'), JSON.stringify({private: true, workspaces: ['apps/*']}));
      await writeFile(join(nested, 'apps', 'web', 'package.json'), JSON.stringify({name: '@fixture/nested-web'}));
      await writeFile(join(nested, 'apps', 'web', 'index.ts'), 'export const nestedWeb = true;\n');
      await execFilePromise('git', ['-C', nested, 'init', '-q']);
      await execFilePromise('git', ['-C', nested, 'add', '.']);
      await execFilePromise('git', [
        '-C',
        nested,
        '-c',
        'user.name=Threadnote Test',
        '-c',
        'user.email=test@threadnote.local',
        'commit',
        '-qm',
        'nested fixture',
      ]);

      await mkdir(home, {recursive: true});
      await writeFile(
        manifest,
        [
          'version: 1',
          'projects:',
          '  - name: outer-web',
          `    path: ${outer}`,
          '    seed: []',
          '    uri: threadnote://resources/repos/outer-web',
          '    graph:',
          '      closure: dependencies',
          '      roots: [apps/web]',
          '  - name: nested-web',
          `    path: ${nested}`,
          '    seed: []',
          '    uri: threadnote://resources/repos/nested-web',
          '    graph:',
          '      closure: dependencies',
          '      roots: [apps/web]',
          '',
        ].join('\n'),
      );

      const indexed = JSON.parse(
        (
          await runCli([
            'graph',
            'index',
            '--home',
            home,
            '--manifest',
            manifest,
            '--cwd',
            outer,
            '--project',
            'web',
            '--no-vectors',
            '--json',
          ])
        ).stdout,
      );
      expect(indexed).toMatchObject({snapshot: {scopeId: expect.stringMatching(/^code-graph-scope:/u)}});
      const status = JSON.parse(
        (
          await runCli([
            'graph',
            'status',
            '--home',
            home,
            '--manifest',
            manifest,
            '--cwd',
            outer,
            '--project',
            'web',
            '--json',
          ])
        ).stdout,
      );
      expect(status).toMatchObject({projectCoverage: {kind: 'project', project: 'outer-web'}});
    } finally {
      await rm(fixture, {force: true, recursive: true});
    }
  }, 60_000);
});

function asProcessError(cause: unknown): NodeJS.ErrnoException & {stderr?: string} {
  return cause as NodeJS.ErrnoException & {stderr?: string};
}

function runCli(args: readonly string[], env?: NodeJS.ProcessEnv) {
  return execFilePromise(
    process.execPath,
    [join(process.cwd(), 'apps', 'threadnote', 'src', 'standalone.ts'), ...args],
    {
      cwd: process.cwd(),
      ...(env === undefined ? {} : {env}),
      maxBuffer: 8 * 1024 * 1024,
    },
  );
}
