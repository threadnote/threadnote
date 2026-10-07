import {createHash} from './helpers/node-crypto.js';
import {execFileSync} from './helpers/node-child-process.js';
import {access, cp, mkdir, mkdtemp, readFile, rm, stat, writeFile} from './helpers/node-fs-promises.js';
import {tmpdir} from './helpers/node-os.js';
import {join} from './helpers/node-path.js';
import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {
  assertPerformanceSourceClean,
  assertPerformanceSourcesMatchCommit,
  canonicalPerformanceRuntimePackageManifest,
  computePerformanceSourceTreeSha256AtCommit,
  loadRetainedPerformanceEvidence,
  measuredPerformanceSourcePathspecs,
  performanceSourcePathspecs,
  performanceSourceDependencyHashesAtCommit,
  writePerformanceArtifactBinding,
} from '../tools/site-performance-evidence.js';
import {loadLatestMajorWebsiteReleases, selectPublishedReleaseRefs} from '../tools/site-release-notes.js';
import {
  loadPreparedWebsiteMetadata,
  parsePreparedWebsiteMetadata,
  preparedWebsiteMetadataSchemaVersion,
} from '../tools/site-prepared-metadata.js';

const root = process.cwd();

describe('website and standalone release boundary', () => {
  it('consumes a versioned prepared metadata artifact without Git and rejects malformed or mismatched artifacts', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'threadnote-site-metadata-'));
    const metadataPath = join(directory, 'site-metadata.json');
    const metadata = {
      articles: [],
      performanceEvidence: {reason: 'Awaiting retained evidence.', state: 'pending'},
      performanceArtifactText: null,
      releaseMode: 'public',
      releases: [],
      schemaVersion: preparedWebsiteMetadataSchemaVersion,
      siteBase: '/',
    };
    try {
      await writeFile(metadataPath, `${JSON.stringify(metadata)}\n`);
      await expect(loadPreparedWebsiteMetadata({metadataPath, releaseMode: 'public', siteBase: '/'})).resolves.toEqual(
        metadata,
      );
      await expect(loadPreparedWebsiteMetadata({metadataPath, releaseMode: 'local', siteBase: '/'})).rejects.toThrow(
        'does not match this site base and release mode',
      );
      expect(() => parsePreparedWebsiteMetadata({...metadata, repositoryRoot: root})).toThrow(
        'unexpected or missing fields',
      );
    } finally {
      await rm(directory, {force: true, recursive: true});
    }
  });

  it('keeps documentation and website trees out of the standalone build', async () => {
    const buildSource = await readFile(join(root, 'scripts', 'build.ts'), 'utf8');

    expect(buildSource).toContain("const RELEASE_DIRECTORIES = ['assets', 'config', 'cursor-plugin'] as const;");
    expect(buildSource).toContain(
      "fs.copy(path.join(root, 'packages', 'manager', 'static'), path.join(outputRoot, 'manager')",
    );
    expect(buildSource).toContain(
      "const FORBIDDEN_RELEASE_DIRECTORIES = ['docs', 'training', 'apps', 'packages', 'site-dist'] as const;",
    );
  });

  it('uses the approved Continuum mark across README, website, and packaged Manager surfaces', async () => {
    const canonicalPath = join(root, 'assets', 'brand', 'threadnote-logo.svg');
    const websitePath = join(root, 'apps', 'website', 'public', 'threadnote-logo.svg');
    const [canonical, website, readme, brand, managerSource, managerUi, selfContainedCheck] = await Promise.all([
      readFile(canonicalPath, 'utf8'),
      readFile(websitePath, 'utf8'),
      readFile(join(root, 'README.md'), 'utf8'),
      readFile(join(root, 'apps', 'website', 'src', 'components', 'Brand.tsx'), 'utf8'),
      readFile(join(root, 'packages', 'manager', 'src', 'server.ts'), 'utf8'),
      readFile(join(root, 'packages', 'manager', 'src', 'navigation.tsx'), 'utf8'),
      readFile(join(root, 'scripts', 'check-self-contained.ts'), 'utf8'),
    ]);

    expect(website).toBe(canonical);
    const [favicon, circle] = await Promise.all([
      readFile(join(root, 'apps', 'website', 'public', 'favicon.svg'), 'utf8'),
      readFile(join(root, 'assets/brand/continuum/threadnote-circle-brand-dark.svg'), 'utf8'),
    ]);
    expect(favicon).toBe(circle);
    expect(favicon).toContain('<circle cx="128" cy="128" r="128" fill="#141b1e"/>');
    expect(readme).toContain('(prefers-color-scheme: dark)');
    expect(readme).toContain('threadnote-naked-brand-light.svg');
    expect(readme).toContain('./assets/brand/threadnote-logo.svg');
    expect(brand).toContain("siteHref('threadnote-logo.svg')");
    expect(brand).not.toContain('<svg');
    expect(managerSource).toContain("directory: 'assets/brand'");
    expect(managerSource).not.toContain('threadnote-logo-inverted.svg');
    for (const theme of ['light', 'dark']) {
      expect(managerSource).toContain(`'/threadnote-logo-${theme}.svg'`);
      expect(managerSource).toContain(`path: 'continuum/threadnote-circle-brand-${theme}.svg'`);
      expect(managerUi).toContain(`src="/threadnote-logo-${theme}.svg"`);
    }
    expect(selfContainedCheck).toContain('standalone build output does not contain the canonical Threadnote logo');

    expect(canonical).toContain('viewBox="0 0 256 256"');
    expect(canonical).toContain('fill="#67e8c7"');
    expect(canonical).not.toContain('linearGradient');
    expect(canonical).not.toContain('stop-color=');
    expect(canonical).toContain('stroke="#67e8c7"');
    expect(canonical).toContain('stroke-width="36"');
    expect(canonical).toContain('translate(128 128) scale(.86) translate(-134 -128)');
    expect(canonical).not.toMatch(
      /<\?(?:xml)|<!DOCTYPE|<(?:circle|filter|foreignObject|image|rect|script|text)\b|(?:href|xlink:href)=/,
    );
    const markPaths = [...canonical.matchAll(/<path\b[^>]*\bd="([^"]+)"[^>]*\/>/g)].map(match => match[1]);
    expect(markPaths).toHaveLength(1);
    expect(markPaths[0]).toContain('H238M30 96H110');
    expect(
      createHash('sha256')
        .update(markPaths[0] ?? '')
        .digest('hex'),
    ).toBe('18c5a6586497960a69da473e7ededade79525f43c33115a546c7c31042a6d648');

    for (const legacyPath of [
      join(root, 'docs', 'threadnote-logo.svg'),
      join(root, 'docs', 'threadnote-logo-inverted.svg'),
      join(root, 'manager', 'threadnote-logo.svg'),
      join(root, 'manager', 'threadnote-logo-inverted.svg'),
    ]) {
      await expect(access(legacyPath)).rejects.toThrow();
    }

    for (const entry of [
      'index.html',
      'performance/index.html',
      'performance/graphify/index.html',
      'docs/index.html',
      'agents/index.html',
      'whats-new/index.html',
      'pro-tips/index.html',
      'manager-demo/index.html',
      'faq/index.html',
    ]) {
      const html = await readFile(join(root, 'apps', 'website', entry), 'utf8');
      expect(html).toMatch(/<link rel="icon" href="(?:\.\/|\.\.\/)+favicon\.svg"/);
      expect(html).not.toMatch(/rel="icon"[^>]*threadnote-logo/);
    }
  });

  it('does not invoke the public website from the CLI build', async () => {
    const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as {
      devDependencies: Record<string, string>;
      scripts: Record<string, string>;
    };

    expect(manifest.scripts.build).not.toContain('site:');
    expect(manifest.scripts['site:build']).toBeDefined();
    expect(manifest.scripts['site:build']).toContain('apps/website/tools/site-articles.ts');
    expect(manifest.scripts['site:check']).toContain('site:test');
    expect(manifest.devDependencies).toMatchObject({
      '@expo-google-fonts/spline-sans': '0.4.2',
      '@resvg/resvg-js': '2.6.2',
    });
  });

  it('keeps retained evidence binding Bun-only and outside the standalone payload', async () => {
    const [evidenceBuild, viteConfig, standaloneBuild, manifest, thirdParty] = await Promise.all([
      readFile(join(root, 'apps', 'website', 'tools', 'site-performance-evidence.ts'), 'utf8'),
      readFile(join(root, 'apps', 'website', 'vite.config.ts'), 'utf8'),
      readFile(join(root, 'scripts', 'build.ts'), 'utf8'),
      readFile(join(root, 'package.json'), 'utf8'),
      readFile(join(root, 'THIRD_PARTY.md'), 'utf8'),
    ]);

    expect(evidenceBuild).toContain("new Bun.CryptoHasher('sha256')");
    expect(evidenceBuild).toContain('performance-evidence.json');
    expect(evidenceBuild).toContain('evidence.binding.json');
    expect(evidenceBuild).not.toMatch(/from ['"]node:/);
    expect(viteConfig).not.toMatch(/from ['"]node:/);
    expect(viteConfig).toContain('virtual:threadnote-performance-evidence');
    expect(JSON.parse(manifest)).toMatchObject({
      scripts: {'site:bind-performance-evidence': 'bun apps/website/tools/site-performance-evidence.ts'},
    });
    expect(evidenceBuild).toContain('writePerformanceArtifactBinding');
    expect(evidenceBuild).toContain('assertPerformanceSourceClean');
    expect(evidenceBuild).toContain("'scripts/site-articles.ts'");
    expect(evidenceBuild).toContain("'scripts/site-release-social-image.ts'");
    expect(evidenceBuild).toContain("'scripts/site-performance-evidence.ts'");
    expect(evidenceBuild).toContain("'apps/website/tools/site-performance-evidence.ts'");
    expect(evidenceBuild).toContain("!name.startsWith('site:')");
    expect(measuredPerformanceSourcePathspecs).toContain('bun.lock');
    expect(measuredPerformanceSourcePathspecs).toContain(':(glob)packages/*/src/**');
    expect(measuredPerformanceSourcePathspecs).toContain(':(glob)packages/*/package.json');
    expect(measuredPerformanceSourcePathspecs).toContain(':(glob)packages/*/static/**');
    expect(measuredPerformanceSourcePathspecs).toContain(':(exclude)package.json');
    expect(standaloneBuild).toContain(
      "const FORBIDDEN_RELEASE_DIRECTORIES = ['docs', 'training', 'apps', 'packages', 'site-dist'] as const;",
    );
    expect(standaloneBuild).not.toContain('site-performance-evidence');
    expect(thirdParty).toContain('`@resvg/resvg-js` 2.6.2');
    expect(thirdParty).toContain('`@expo-google-fonts/spline-sans` 0.4.2');
  });

  it('normalizes arbitrary site package scripts without weakening runtime package fields', () => {
    const manifest = {
      dependencies: {effect: '4.0.0-rc.112'},
      name: 'threadnote',
      scripts: {build: 'bun scripts/build.ts', 'site:build': 'bun --bun vite build', test: 'bun test'},
      version: '4.3.8',
    };
    const before = structuredClone(manifest);
    const baseline = canonicalPerformanceRuntimePackageManifest(JSON.stringify(manifest));

    fc.assert(
      fc.property(fc.dictionary(fc.string({maxLength: 32, minLength: 1}), fc.string({maxLength: 120})), siteScripts => {
        const additions = Object.fromEntries(
          Object.entries(siteScripts).map(([name, command]) => [`site:${name}`, command]),
        );
        expect(
          canonicalPerformanceRuntimePackageManifest(
            JSON.stringify({...manifest, scripts: {...manifest.scripts, ...additions}}),
          ),
        ).toBe(baseline);
      }),
      {numRuns: 100},
    );

    expect(manifest).toEqual(before);
    expect(
      canonicalPerformanceRuntimePackageManifest(JSON.stringify({...manifest, dependencies: {effect: '4.0.0-rc.113'}})),
    ).not.toBe(baseline);
    expect(
      canonicalPerformanceRuntimePackageManifest(
        JSON.stringify({...manifest, scripts: {...manifest.scripts, build: 'bun scripts/other-build.ts'}}),
      ),
    ).not.toBe(baseline);
  });

  it('rejects tracked, staged, and untracked changes in performance-bound source paths', async () => {
    const repository = await mkdtemp(join(tmpdir(), 'threadnote-performance-source-'));
    const git = (...arguments_: string[]) =>
      execFileSync('git', arguments_, {cwd: repository, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']});
    try {
      await mkdir(join(repository, 'src'));
      await writeFile(join(repository, 'src', 'tracked.ts'), 'export const value = 1;\n');
      await writeFile(join(repository, '.gitignore'), 'src/ignored.ts\n');
      git('init');
      git('add', '.');
      git('-c', 'user.name=Threadnote Test', '-c', 'user.email=threadnote@example.invalid', 'commit', '-m', 'fixture');
      expect(() => assertPerformanceSourceClean(repository)).not.toThrow();

      await writeFile(join(repository, 'src', 'tracked.ts'), 'export const value = 2;\n');
      expect(() => assertPerformanceSourceClean(repository)).toThrow('tracked working-tree modifications');
      git('restore', 'src/tracked.ts');

      await writeFile(join(repository, 'src', 'tracked.ts'), 'export const value = 3;\n');
      git('add', 'src/tracked.ts');
      expect(() => assertPerformanceSourceClean(repository)).toThrow('staged modifications');
      git('restore', '--staged', '--worktree', 'src/tracked.ts');

      await writeFile(join(repository, 'src', 'untracked.ts'), 'export const untracked = true;\n');
      expect(() => assertPerformanceSourceClean(repository)).toThrow('untracked files');
      await rm(join(repository, 'src', 'untracked.ts'));

      await mkdir(join(repository, 'packages', 'graph', 'src'), {recursive: true});
      await writeFile(join(repository, 'packages', 'graph', 'src', 'untracked.ts'), 'export const untracked = true;\n');
      expect(() => assertPerformanceSourceClean(repository)).toThrow('untracked files');
      await rm(join(repository, 'packages'), {recursive: true});

      await writeFile(join(repository, 'src', 'ignored.ts'), 'export const ignored = true;\n');
      expect(() => assertPerformanceSourceClean(repository)).toThrow('untracked files');
    } finally {
      await rm(repository, {force: true, recursive: true});
    }
  });

  it('accepts byte-identical governed sources after a squash merge and rejects source drift', async () => {
    const repository = await mkdtemp(join(tmpdir(), 'threadnote-performance-squash-'));
    const git = (...arguments_: string[]) =>
      execFileSync('git', arguments_, {cwd: repository, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']}).trim();
    const commit = (...arguments_: string[]) =>
      git('-c', 'user.name=Threadnote Test', '-c', 'user.email=threadnote@example.invalid', ...arguments_);
    try {
      await mkdir(join(repository, 'src'));
      await writeFile(
        join(repository, 'package.json'),
        '{"name":"threadnote","scripts":{"site:build":"bun --bun vite build"},"version":"4.3.8"}\n',
      );
      await writeFile(join(repository, 'src', 'governed.ts'), 'export const value = 1;\n');
      git('init');
      git('add', '.');
      commit('commit', '-m', 'benchmark source');
      const sourceCommit = git('rev-parse', 'HEAD');
      const sourceTree = git('rev-parse', 'HEAD^{tree}');
      const squashCommit = commit('commit-tree', sourceTree, '-m', 'squash merge');
      git('switch', '--detach', squashCommit);

      expect(() => assertPerformanceSourcesMatchCommit(repository, sourceCommit)).not.toThrow();

      await writeFile(join(repository, 'src', 'governed.ts'), 'export const value = 2;\n');
      git('add', '.');
      commit('commit', '-m', 'runtime drift');
      expect(() => assertPerformanceSourcesMatchCommit(repository, sourceCommit)).toThrow(
        'runtime sources changed after the retained performance run',
      );
    } finally {
      await rm(repository, {force: true, recursive: true});
    }
  });

  it('detects package source and manifest drift in cleanliness, commit comparison, and source digests', async () => {
    const repository = await mkdtemp(join(tmpdir(), 'threadnote-performance-packages-'));
    const git = (...arguments_: string[]) =>
      execFileSync('git', arguments_, {cwd: repository, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']}).trim();
    const commit = (...arguments_: string[]) =>
      git('-c', 'user.name=Threadnote Test', '-c', 'user.email=threadnote@example.invalid', ...arguments_);
    try {
      await mkdir(join(repository, 'packages', 'graph', 'src'), {recursive: true});
      await writeFile(join(repository, 'package.json'), '{"name":"threadnote"}\n');
      await writeFile(join(repository, 'bun.lock'), 'lockfileVersion = 1\n');
      await writeFile(join(repository, 'packages', 'graph', 'package.json'), '{"name":"@threadnote/graph"}\n');
      await writeFile(join(repository, 'packages', 'graph', 'src', 'index.ts'), 'export const value = 1;\n');
      git('init');
      git('add', '.');
      commit('commit', '-m', 'measured packages');
      const sourceCommit = git('rev-parse', 'HEAD');
      const sourceDigest = computePerformanceSourceTreeSha256AtCommit(repository, sourceCommit);

      await writeFile(join(repository, 'packages', 'graph', 'src', 'index.ts'), 'export const value = 2;\n');
      expect(() => assertPerformanceSourceClean(repository)).toThrow('tracked working-tree modifications');
      git('add', '.');
      commit('commit', '-m', 'package source drift');
      const sourceDriftCommit = git('rev-parse', 'HEAD');
      expect(() => assertPerformanceSourcesMatchCommit(repository, sourceCommit)).toThrow(
        'runtime sources changed after the retained performance run',
      );
      expect(computePerformanceSourceTreeSha256AtCommit(repository, sourceDriftCommit)).not.toBe(sourceDigest);

      git('switch', '--detach', sourceCommit);
      await writeFile(
        join(repository, 'packages', 'graph', 'package.json'),
        '{"name":"@threadnote/graph","dependencies":{"effect":"4.0.0-rc.113"}}\n',
      );
      expect(() => assertPerformanceSourceClean(repository)).toThrow('tracked working-tree modifications');
      git('add', '.');
      commit('commit', '-m', 'package manifest drift');
      const manifestDriftCommit = git('rev-parse', 'HEAD');
      expect(() => assertPerformanceSourcesMatchCommit(repository, sourceCommit)).toThrow(
        'runtime sources changed after the retained performance run',
      );
      expect(computePerformanceSourceTreeSha256AtCommit(repository, manifestDriftCommit)).not.toBe(sourceDigest);
    } finally {
      await rm(repository, {force: true, recursive: true});
    }
  });

  it('accepts committed site generators while rejecting post-benchmark dependency drift', async () => {
    const repository = await mkdtemp(join(tmpdir(), 'threadnote-performance-site-only-'));
    const git = (...arguments_: string[]) =>
      execFileSync('git', arguments_, {cwd: repository, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']}).trim();
    const commit = (...arguments_: string[]) =>
      git('-c', 'user.name=Threadnote Test', '-c', 'user.email=threadnote@example.invalid', ...arguments_);
    try {
      await mkdir(join(repository, 'apps', 'website', 'tools'), {recursive: true});
      await mkdir(join(repository, 'src'));
      await writeFile(join(repository, 'bun.lock'), 'lockfileVersion = 1\n');
      await writeFile(
        join(repository, 'package.json'),
        `${JSON.stringify({
          dependencies: {effect: '4.0.0-rc.112'},
          name: 'threadnote',
          scripts: {build: 'bun scripts/build.ts', 'site:build': 'bun --bun vite build'},
          version: '4.3.8',
        })}\n`,
      );
      await writeFile(
        join(repository, 'apps', 'website', 'tools', 'site-doc-pages.ts'),
        'export const pages = true;\n',
      );
      await writeFile(
        join(repository, 'apps', 'website', 'tools', 'site-release-notes.ts'),
        'export const releases = true;\n',
      );
      await writeFile(join(repository, 'src', 'runtime.ts'), 'export const runtime = true;\n');
      git('init');
      git('add', '.');
      commit('commit', '-m', 'benchmark source');
      const sourceCommit = git('rev-parse', 'HEAD');

      const helperPath = 'apps/website/tools/site-performance-evidence.ts';
      const sourceDigest = computePerformanceSourceTreeSha256AtCommit(repository, sourceCommit);
      await writeFile(join(repository, helperPath), 'export const binding = true;\n');
      git('add', '.');
      commit('commit', '-m', 'reviewed website harness helper');
      expect(git('diff', '--name-only', sourceCommit, 'HEAD', '--', ...performanceSourcePathspecs)).toBe(helperPath);
      expect(() => assertPerformanceSourcesMatchCommit(repository, sourceCommit)).not.toThrow();
      expect(computePerformanceSourceTreeSha256AtCommit(repository, git('rev-parse', 'HEAD'))).toBe(sourceDigest);

      await writeFile(
        join(repository, 'apps', 'website', 'tools', 'site-articles.ts'),
        'export const articles = true;\n',
      );
      await writeFile(
        join(repository, 'apps', 'website', 'tools', 'site-release-notes.ts'),
        'export const releases = {body: true};\n',
      );
      await writeFile(
        join(repository, 'package.json'),
        `${JSON.stringify({
          dependencies: {effect: '4.0.0-rc.112'},
          name: 'threadnote',
          scripts: {
            build: 'bun scripts/build.ts',
            'site:build': 'bun --bun vite build && bun apps/website/tools/site-articles.ts',
          },
          version: '4.3.8',
        })}\n`,
      );
      git('add', '.');
      commit('commit', '-m', 'site article infrastructure');
      expect(() => assertPerformanceSourcesMatchCommit(repository, sourceCommit)).not.toThrow();

      await writeFile(
        join(repository, 'package.json'),
        `${JSON.stringify({
          dependencies: {effect: '4.0.0-rc.113'},
          name: 'threadnote',
          scripts: {
            build: 'bun scripts/build.ts',
            'site:build': 'bun --bun vite build && bun apps/website/tools/site-articles.ts',
          },
          version: '4.3.8',
        })}\n`,
      );
      git('add', 'package.json');
      commit('commit', '-m', 'dependency drift');
      expect(() => assertPerformanceSourcesMatchCommit(repository, sourceCommit)).toThrow(
        'package manifest changed outside site-only scripts',
      );
    } finally {
      await rm(repository, {force: true, recursive: true});
    }
  });

  it('keeps retained source identity bound to the measured commit after later runtime changes', async () => {
    const repository = await mkdtemp(join(tmpdir(), 'threadnote-performance-history-'));
    const git = (...arguments_: string[]) =>
      execFileSync('git', arguments_, {cwd: repository, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']}).trim();
    const commit = (...arguments_: string[]) =>
      git('-c', 'user.name=Threadnote Test', '-c', 'user.email=threadnote@example.invalid', ...arguments_);
    try {
      await mkdir(join(repository, 'src'));
      await writeFile(join(repository, 'bun.lock'), 'lockfileVersion = 1\n');
      await writeFile(
        join(repository, 'package.json'),
        `${JSON.stringify({dependencies: {effect: '4.0.0-rc.111'}, name: 'threadnote', version: '4.3.8'})}\n`,
      );
      await writeFile(join(repository, 'src', 'runtime.ts'), 'export const runtime = 1;\n');
      git('init');
      git('add', '.');
      commit('commit', '-m', 'measured runtime');
      const sourceCommit = git('rev-parse', 'HEAD');
      const measuredSourceTree = computePerformanceSourceTreeSha256AtCommit(repository, sourceCommit);
      const measuredDependencies = performanceSourceDependencyHashesAtCommit(repository, sourceCommit);

      await writeFile(join(repository, 'bun.lock'), 'lockfileVersion = 2\n');
      await writeFile(
        join(repository, 'package.json'),
        `${JSON.stringify({dependencies: {effect: '4.0.0-rc.112'}, name: 'threadnote', version: '4.3.8'})}\n`,
      );
      await writeFile(join(repository, 'src', 'runtime.ts'), 'export const runtime = 2;\n');
      git('add', '.');
      commit('commit', '-m', 'later runtime');
      const laterCommit = git('rev-parse', 'HEAD');

      expect(computePerformanceSourceTreeSha256AtCommit(repository, sourceCommit)).toBe(measuredSourceTree);
      expect(performanceSourceDependencyHashesAtCommit(repository, sourceCommit)).toEqual(measuredDependencies);
      expect(computePerformanceSourceTreeSha256AtCommit(repository, laterCommit)).not.toBe(measuredSourceTree);
      expect(performanceSourceDependencyHashesAtCommit(repository, laterCommit)).not.toEqual(measuredDependencies);
      expect(() => assertPerformanceSourcesMatchCommit(repository, sourceCommit)).toThrow(
        'runtime sources changed after the retained performance run',
      );
      expect(() => computePerformanceSourceTreeSha256AtCommit(repository, '0'.repeat(40))).toThrow(
        'source commit 0000000000000000000000000000000000000000 is unavailable',
      );
    } finally {
      await rm(repository, {force: true, recursive: true});
    }
  });

  it('loads the exact historical artifact after a later runtime and dependency commit', async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), 'threadnote-performance-load-history-'));
    const repository = join(temporaryRoot, 'repository');
    try {
      const sourceHead = execFileSync('git', ['rev-parse', 'HEAD'], {cwd: root, encoding: 'utf8'}).trim();
      execFileSync('git', ['clone', '--shared', '--no-checkout', root, repository], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const git = (...arguments_: string[]) =>
        execFileSync('git', arguments_, {cwd: repository, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']}).trim();
      const commit = (...arguments_: string[]) =>
        git('-c', 'user.name=Threadnote Test', '-c', 'user.email=threadnote@example.invalid', ...arguments_);
      git('checkout', '--detach', sourceHead);
      await cp(join(root, 'apps', 'website', 'public'), join(repository, 'apps', 'website', 'public'), {
        recursive: true,
      });
      await cp(join(root, 'apps', 'website', 'performance'), join(repository, 'apps', 'website', 'performance'), {
        recursive: true,
      });
      const manifest = JSON.parse(await readFile(join(repository, 'package.json'), 'utf8')) as Record<string, unknown>;
      await writeFile(
        join(repository, 'apps', 'threadnote', 'src', 'later-runtime.ts'),
        'export const laterRuntime = true;\n',
      );
      await writeFile(join(repository, 'bun.lock'), 'later dependency lock\n');
      await writeFile(
        join(repository, 'package.json'),
        `${JSON.stringify({...manifest, dependencies: {...(manifest.dependencies as object), effect: 'later'}})}\n`,
      );
      git('add', '.');
      commit('commit', '-m', 'later runtime and dependencies');

      const evidence = await loadRetainedPerformanceEvidence(repository, '/');
      expect(evidence.state).toBe('verified');
      if (evidence.state !== 'verified') throw new Error('Expected retained performance evidence.');
      expect(evidence.artifact.source.threadnote).toMatchObject({
        commit: 'f1e4102a78e4df2127fca0c4d59da39ffb5f70a6',
        version: 'v4.3.8',
      });
      expect(evidence.artifact.artifact.sha256).toBe(
        'b56994fe99c3d68be80f79315b88d4420a7241a76de72c317d2fc3d84de23b39',
      );
      await expect(writePerformanceArtifactBinding(repository)).rejects.toThrow(
        'runtime sources changed after the retained performance run',
      );
    } finally {
      await rm(temporaryRoot, {force: true, recursive: true});
    }
  });

  it('keeps measured hashes invariant across arbitrary subsequent runtime commits', async () => {
    const repository = await mkdtemp(join(tmpdir(), 'threadnote-performance-history-property-'));
    const git = (...arguments_: string[]) =>
      execFileSync('git', arguments_, {cwd: repository, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']}).trim();
    const commit = (...arguments_: string[]) =>
      git('-c', 'user.name=Threadnote Test', '-c', 'user.email=threadnote@example.invalid', ...arguments_);
    try {
      await mkdir(join(repository, 'src'));
      await writeFile(join(repository, 'bun.lock'), 'baseline lock\n');
      await writeFile(
        join(repository, 'package.json'),
        `${JSON.stringify({dependencies: {effect: 'baseline'}, name: 'threadnote', version: '4.3.8'})}\n`,
      );
      await writeFile(join(repository, 'src', 'runtime.ts'), 'export const baseline = true;\n');
      git('init');
      git('add', '.');
      commit('commit', '-m', 'measured runtime');
      const sourceCommit = git('rev-parse', 'HEAD');
      const measuredSourceTree = computePerformanceSourceTreeSha256AtCommit(repository, sourceCommit);
      const measuredDependencies = performanceSourceDependencyHashesAtCommit(repository, sourceCommit);
      let sequence = 0;

      await fc.assert(
        fc.asyncProperty(
          fc.record({
            dependency: fc.string({maxLength: 32}),
            lockfile: fc.string({maxLength: 80}),
            runtime: fc.string({maxLength: 80}),
          }),
          async change => {
            sequence += 1;
            await writeFile(join(repository, 'bun.lock'), `${change.lockfile}\nproperty-run = ${sequence}\n`);
            await writeFile(
              join(repository, 'package.json'),
              `${JSON.stringify({
                dependencies: {effect: change.dependency},
                name: 'threadnote',
                propertyRun: sequence,
                version: '4.3.8',
              })}\n`,
            );
            await writeFile(
              join(repository, 'src', 'runtime.ts'),
              `${change.runtime}\nexport const propertyRun = ${sequence};\n`,
            );
            git('add', '.');
            commit('commit', '-m', `later runtime ${sequence}`);

            expect(computePerformanceSourceTreeSha256AtCommit(repository, sourceCommit)).toBe(measuredSourceTree);
            expect(performanceSourceDependencyHashesAtCommit(repository, sourceCommit)).toEqual(measuredDependencies);
            expect(() => assertPerformanceSourcesMatchCommit(repository, sourceCommit)).toThrow(
              'runtime sources changed after the retained performance run',
            );
          },
        ),
        {numRuns: 10},
      );
    } finally {
      await rm(repository, {force: true, recursive: true});
    }
  });

  it('gates the Pages deployment on website contract checks', async () => {
    const workflow = await readFile(join(root, '.github', 'workflows', 'pages.yml'), 'utf8');

    await expect(access(join(root, 'docs', 'index.html'))).rejects.toThrow();
    await expect(access(join(root, 'apps', 'website', 'public', 'CNAME'))).rejects.toThrow();
    expect(workflow).toContain('bun run site:check');
    expect(workflow).toContain('bun run site:build');
    expect(workflow).toContain('Load published immutable stable releases');
    expect(workflow).toContain('.immutable == true');
    expect(workflow).toContain("THREADNOTE_SITE_PUBLIC_BUILD: '1'");
    expect(workflow).toContain('THREADNOTE_SITE_PUBLISHED_RELEASES=');
    expect(workflow).toContain('EXPECTED_RELEASE_TAG: ${{ inputs.release_tag }}');
    expect(workflow).toContain('fetch-depth: 0');
    const pushTrigger = workflow.slice(workflow.indexOf('  push:'), workflow.indexOf('  workflow_dispatch:'));
    expect(pushTrigger).toContain('paths:');
    expect(pushTrigger).toContain('branches: [main]');
    expect(pushTrigger).not.toContain('tags:');
    expect(pushTrigger).toContain("'package.json'");
    expect(pushTrigger).toContain("'apps/website/**'");
    expect(pushTrigger).toContain("'apps/website/tools/site-doc-pages.ts'");
    expect(pushTrigger).toContain("'apps/website/tools/site-articles.ts'");
    expect(pushTrigger).toContain("'apps/website/tools/site-performance-evidence.ts'");
    expect(pushTrigger).toContain("'apps/website/tools/site-release-notes.ts'");
    expect(pushTrigger).toContain("'apps/website/tools/site-release-social-image.ts'");
    expect(pushTrigger).toContain("'packages/evidence/**'");
    expect(pushTrigger).not.toContain("'src/**'");
    expect(workflow).toContain('path: site-dist');
    expect(workflow).toContain('actions/deploy-pages@');
    expect(workflow).toMatch(/^ {2}THREADNOTE_SITE_BASE: \/$/m);
  });

  it('keeps prepared and tagged releases off the public site until publication', async () => {
    const repository = await mkdtemp(join(tmpdir(), 'threadnote-prepared-site-release-'));
    const git = (...arguments_: string[]) =>
      execFileSync('git', arguments_, {cwd: repository, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']});
    const gitAt = (date: string, ...arguments_: string[]) =>
      execFileSync('git', arguments_, {
        cwd: repository,
        encoding: 'utf8',
        env: {...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date},
        stdio: ['ignore', 'pipe', 'pipe'],
      });

    try {
      await mkdir(join(repository, '.github', 'release-notes'), {recursive: true});
      await writeFile(join(repository, 'package.json'), '{"version":"4.0.0"}\n');
      await writeFile(
        join(repository, '.github', 'release-notes', 'v4.0.0.md'),
        "## What's new\n\nThreadnote 4.0 is ready.\n\n### Standalone runtime\n",
      );
      git('init');
      git('add', '.');
      gitAt(
        '2026-08-10T10:00:00Z',
        '-c',
        'user.name=Threadnote Test',
        '-c',
        'user.email=threadnote@example.invalid',
        'commit',
        '-m',
        '4.0 release',
      );
      gitAt(
        '2026-08-10T10:05:00Z',
        '-c',
        'user.name=Threadnote Test',
        '-c',
        'user.email=threadnote@example.invalid',
        'tag',
        '-a',
        'v4.0.0',
        '-m',
        'v4.0.0',
      );

      await writeFile(join(repository, 'package.json'), '{"version":"4.1.1"}\n');
      await writeFile(
        join(repository, '.github', 'release-notes', 'v4.1.1.md'),
        "## What's new\n\nThreadnote 4.1.1 is ready.\n\n### Faster refreshes\n",
      );
      git('add', '.');
      gitAt(
        '2026-08-11T11:00:00Z',
        '-c',
        'user.name=Threadnote Test',
        '-c',
        'user.email=threadnote@example.invalid',
        'commit',
        '-m',
        'prepare 4.1.1',
      );

      const prepared = loadLatestMajorWebsiteReleases(repository);
      expect(prepared.map(release => release.version)).toEqual(['v4.0.0']);

      gitAt(
        '2026-08-12T12:00:00Z',
        '-c',
        'user.name=Threadnote Test',
        '-c',
        'user.email=threadnote@example.invalid',
        'tag',
        '-a',
        'v4.1.1',
        '-m',
        'v4.1.1',
      );
      const tagged = loadLatestMajorWebsiteReleases(repository);
      expect(tagged.map(release => release.version)).toEqual(['v4.1.1', 'v4.0.0']);
      expect(new Date(tagged[0].publishedAt).toISOString()).toBe('2026-08-12T12:00:00.000Z');

      const earlierPublished = {tagName: 'v4.0.0', publishedAt: '2026-08-10T12:00:00Z'};
      const unpublished = loadLatestMajorWebsiteReleases(repository, JSON.stringify([earlierPublished]));
      expect(unpublished.map(release => release.version)).toEqual(['v4.0.0']);
      const released = loadLatestMajorWebsiteReleases(
        repository,
        JSON.stringify([earlierPublished, {tagName: 'v4.1.1', publishedAt: '2026-08-13T09:00:00Z'}]),
      );
      expect(released.map(release => release.version)).toEqual(['v4.1.1', 'v4.0.0']);
      expect(released[0]).toMatchObject({
        releaseUrl: 'https://github.com/threadnote/threadnote/releases/tag/v4.1.1',
        summary: 'Threadnote 4.1.1 is ready.',
        publishedAt: '2026-08-13T09:00:00Z',
      });
      expect(() => loadLatestMajorWebsiteReleases(repository, '[]')).toThrow('must contain releases');
    } finally {
      await rm(repository, {force: true, recursive: true});
    }
  });

  it('selects only published tagged refs without changing the input or order', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.record({patch: fc.nat({max: 1000}), published: fc.boolean()}), {
          maxLength: 30,
          minLength: 1,
          selector: entry => entry.patch,
        }),
        entries => {
          const tagged = entries.map(({patch}) => ({
            major: 4,
            minor: 1,
            patch,
            version: `v4.1.${patch}`,
            publishedAt: 'tag-date',
          }));
          const original = structuredClone(tagged);
          const publishedAtByTag = new Map(
            entries.filter(entry => entry.published).map(entry => [`v4.1.${entry.patch}`, 'release-date']),
          );
          const selected = selectPublishedReleaseRefs(tagged, publishedAtByTag);
          expect(selected.map(release => release.version)).toEqual(
            tagged.filter(release => publishedAtByTag.has(release.version)).map(release => release.version),
          );
          expect(selected.every(release => release.publishedAt === 'release-date')).toBe(true);
          expect(tagged).toEqual(original);
        },
      ),
      {numRuns: 100},
    );
  });

  it('fails a public site build when publication metadata is unavailable', () => {
    const previousMode = process.env.THREADNOTE_SITE_PUBLIC_BUILD;
    const previousReleases = process.env.THREADNOTE_SITE_PUBLISHED_RELEASES;
    try {
      process.env.THREADNOTE_SITE_PUBLIC_BUILD = '1';
      delete process.env.THREADNOTE_SITE_PUBLISHED_RELEASES;
      expect(() => loadLatestMajorWebsiteReleases(root)).toThrow(
        'Public website builds require published GitHub release metadata',
      );
    } finally {
      if (previousMode === undefined) delete process.env.THREADNOTE_SITE_PUBLIC_BUILD;
      else process.env.THREADNOTE_SITE_PUBLIC_BUILD = previousMode;
      if (previousReleases === undefined) delete process.env.THREADNOTE_SITE_PUBLISHED_RELEASES;
      else process.env.THREADNOTE_SITE_PUBLISHED_RELEASES = previousReleases;
    }
  });

  it('uses threadnote.io as the single public website origin', async () => {
    const origin = 'https://threadnote.io';
    const entries = [
      ['index.html', '/', 'og.png'],
      ['performance/index.html', '/performance/', 'og.png'],
      ['performance/graphify/index.html', '/performance/graphify/', 'og.png'],
      ['docs/index.html', '/docs/', 'og.png'],
      ['agents/index.html', '/agents/', 'og.png'],
      ['whats-new/index.html', '/whats-new/', 'og.png'],
      ['pro-tips/index.html', '/pro-tips/', 'og.png'],
      ['manager-demo/index.html', '/manager-demo/', 'og.png'],
      ['faq/index.html', '/faq/', 'og.png'],
    ] as const;
    const htmlDocuments = await Promise.all(
      entries.map(async ([entry, route, socialImage]) => ({
        route,
        socialImage,
        html: await readFile(join(root, 'apps', 'website', entry), 'utf8'),
      })),
    );

    for (const {route, socialImage, html} of htmlDocuments) {
      expect(html).toContain(`<link rel="canonical" href="${origin}${route}" />`);
      expect(html).toContain(`<meta property="og:url" content="${origin}${route}" />`);
      expect(html).toContain(`<meta property="og:image" content="${origin}/${socialImage}" />`);
      expect(html).toContain(`<meta name="twitter:image" content="${origin}/${socialImage}" />`);
      expect(html).not.toContain('kashkovsky.github.io/threadnote');
    }

    await expect(access(join(root, 'apps', 'website', 'public', 'whats-new-og.png'))).rejects.toThrow();

    const structuredDataSource = htmlDocuments[0]?.html.match(
      /<script type="application\/ld\+json">([\s\S]*?)<\/script>/,
    )?.[1];
    expect(structuredDataSource).toBeDefined();
    expect(JSON.parse(structuredDataSource ?? '{}')).toMatchObject({
      '@context': 'https://schema.org',
      '@graph': [
        {'@type': 'WebSite', url: `${origin}/`},
        {'@type': 'SoftwareApplication', url: `${origin}/`},
      ],
    });

    const [sitemap, robots, readme, manifest, pagesWorkflow, ciWorkflow, bazelTargets] = await Promise.all([
      readFile(join(root, 'apps', 'website', 'public', 'sitemap.xml'), 'utf8'),
      readFile(join(root, 'apps', 'website', 'public', 'robots.txt'), 'utf8'),
      readFile(join(root, 'README.md'), 'utf8'),
      readFile(join(root, 'package.json'), 'utf8'),
      readFile(join(root, '.github', 'workflows', 'pages.yml'), 'utf8'),
      readFile(join(root, '.github', 'workflows', 'ci.yml'), 'utf8'),
      readFile(join(root, 'tools', 'bazel', 'target-specs.mjs'), 'utf8'),
    ]);
    const sitemapLocations = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map(match => match[1]);

    expect(sitemapLocations).toEqual(entries.map(([, route]) => `${origin}${route}`));
    expect(robots).toContain(`Sitemap: ${origin}/sitemap.xml`);
    expect(readme).toContain(`**Website:** ${origin}/`);
    expect(readme).toContain(`**Documentation:** ${origin}/docs/`);
    expect(JSON.parse(manifest)).toMatchObject({homepage: `${origin}/`});
    expect(pagesWorkflow).toMatch(/^ {2}THREADNOTE_SITE_BASE: \/$/m);
    expect(bazelTargets).toContain("THREADNOTE_SITE_BASE: '/'");
    expect(ciWorkflow).toContain('fetch-depth: 0');

    for (const source of [sitemap, robots, readme, manifest, pagesWorkflow, ciWorkflow, bazelTargets]) {
      expect(source).not.toContain('kashkovsky.github.io/threadnote');
    }
  });

  it('packages agent instruction profiles outside the public docs tree', async () => {
    const agentIntegrations = await readFile(
      join(root, 'apps', 'threadnote', 'src', 'agent_integration', 'index.ts'),
      'utf8',
    );
    const [defaultTemplate, personalCursorCloudTemplate] = await Promise.all([
      stat(join(root, 'config', 'agent-instructions.md')),
      stat(join(root, 'config', 'agent-profiles', 'cursor-cloud-personal', 'agent-instructions.md')),
    ]);

    expect(agentIntegrations).toContain("path.join(root, 'config')");
    expect(agentIntegrations).toContain("path.join(root, 'config', 'agent-profiles', profile)");
    expect(agentIntegrations).not.toContain("'docs', 'agent-instructions.md'");
    expect(defaultTemplate.isFile()).toBe(true);
    expect(personalCursorCloudTemplate.isFile()).toBe(true);
  });
});
