import {TestError} from './helpers/test-error.js';
import {access, mkdir, mkdtemp, readFile, rm, writeFile} from './helpers/node-fs-promises.js';
import {join} from './helpers/node-path.js';
import {tmpdir} from './helpers/node-os.js';
import fc from 'fast-check';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {describe, expect, it} from 'vitest';
import {
  bindRetainedPerformanceArtifact,
  performanceArtifactPublicUrl,
  sha256Hex,
} from '../tools/site-performance-evidence.js';
import {
  loadWebsiteArticles,
  parseWebsiteArticle,
  renderWhatsNewIndexHtml,
  renderWebsitePostHtml,
} from '../tools/site-articles.js';
import {selectLatestMajorReleases} from '../tools/site-release-notes.js';
import {validateExternalRepositoryEvidence} from '@threadnote/evidence/external-evidence';
import {agentIntegrations, tierLabels} from '../src/content/agentIntegrations.js';
import {cliCommands, docsSections, mcpTools} from '../src/content/docs.js';
import {ManagerOperationsVisual, managerOperationsVisualKinds} from '../src/components/ManagerOperationsVisual.js';
import {graphAnalyzeScenario, graphInspectScenario, heroScenario} from '../src/content/landing.js';
import {
  graphifyReviewedSource,
  graphifySharedCapabilities,
  graphifyVerifiedDifferences,
} from '../src/content/graphifyComparison.js';
import {managerDemoShares, managerDemoTabs} from '../src/content/managerDemo.js';
import {
  createDocsSearchIndex,
  DOCS_SEARCH_MAXIMUM_LENGTH,
  DOCS_SEARCH_MAXIMUM_TERMS,
  searchDocs,
} from '../src/lib/docsSearch.js';
import {
  retainedPerformanceArtifactFieldPaths,
  retainedPerformanceObjectiveResults,
  validateRetainedPerformancePayload,
} from '@threadnote/evidence/performance';
import {
  docsArticleIdForPathname,
  docsArticlePath,
  commitPreparedRoute,
  createSitePageModuleCache,
  isSameDocumentNavigation,
  siteCanonicalUrlForPathname,
  sitePageForPathname,
  whatsNewArticlePath,
  whatsNewIndexViewForSearch,
  whatsNewPostForPathname,
  whatsNewReleasePath,
  type SitePage,
} from '../src/lib/routes.js';
import {renderDocsArticleHtml, renderDocsSitemap} from '../tools/site-doc-pages.js';
import {filterWebsiteUpdatesByKind, orderWebsiteUpdatesDescending} from '../src/content/websiteArticles.js';
import type {BenchmarkArtifactV1} from '@threadnote/evidence/benchmark';
import {proTips} from '../src/content/proTips.js';
import {EXTERNAL_REPOSITORY_REQUIRED_MEASUREMENTS} from '@threadnote/evidence/external-evidence';

const root = process.cwd();

function validateRetainedExternalPerformanceEvidence(artifact: BenchmarkArtifactV1): void {
  validateExternalRepositoryEvidence(artifact, {
    expectedControlLanguages: ['java', 'kotlin', 'typescript', 'bazel-build'],
    managerEdgeBudget: 1_500,
    managerNodeBudget: 500,
    releaseBound: true,
  });
}
const toolKeys = {
  analyze_code_graph: new Set([
    'callerCwd',
    'communityId',
    'includeHeuristic',
    'includeModelAssociations',
    'memberLimit',
    'operation',
  ]),
  context_brief: new Set(['budgetTokens', 'callerCwd', 'codeRefs', 'mode', 'project', 'task', 'workset']),
  inspect_code_graph: new Set([
    'base',
    'callerCwd',
    'depth',
    'direction',
    'edgeLimit',
    'from',
    'includeHeuristic',
    'includeModelAssociations',
    'nodeId',
    'nodeLimit',
    'operation',
    'package',
    'query',
    'symbol',
    'to',
    'workset',
  ]),
  read_context: new Set(['mode', 'section', 'uri', 'uris']),
  recall_context: new Set([
    'budgetTokens',
    'callerCwd',
    'explain',
    'includeArchived',
    'nodeLimit',
    'project',
    'query',
    'threshold',
    'uri',
    'workset',
  ]),
  remember_context: new Set([
    'callerCwd',
    'citationPolicy',
    'codeRefs',
    'kind',
    'project',
    'references',
    'relations',
    'replaceUri',
    'sourceAgentClient',
    'status',
    'text',
    'topic',
  ]),
  review_session_context: new Set([
    'callerCwd',
    'codeRefs',
    'constraints',
    'decisions',
    'evidence',
    'handoff',
    'invariants',
    'knowledgeInvalidated',
    'outcome',
    'preferences',
    'project',
    'rationale',
    'sourceAgentClient',
    'sourceCommit',
    'sourceSessionId',
    'task',
    'topic',
    'unresolvedRisks',
    'verificationPerformed',
  ]),
  apply_memory_candidates: new Set([
    'action',
    'approved',
    'candidateId',
    'editedText',
    'operation',
    'replaceUri',
    'reviewId',
    'revision',
  ]),
  share_propose: new Set(['approved', 'candidateIds', 'reviewId', 'revision', 'team']),
  share_publish: new Set(['message', 'preview', 'push', 'redact', 'team', 'uri']),
} as const;

type DisplayedTool = keyof typeof toolKeys;

function toolName(actor: string): DisplayedTool {
  const name = actor.split(' · ', 1)[0];
  if (!name || !(name in toolKeys)) {
    throw TestError.make({message: `Website scenario uses an unverified tool contract: ${actor}`});
  }
  return name as DisplayedTool;
}

function parseToolPayload(text: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(text);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw TestError.make({message: `Tool payload must be a JSON object: ${text}`});
  }
  return parsed as Record<string, unknown>;
}

function expectNonEmptyString(payload: Record<string, unknown>, key: string): void {
  expect(typeof payload[key]).toBe('string');
  expect((payload[key] as string).trim().length).toBeGreaterThan(0);
}

const fixtureLockfileSha256 = '1'.repeat(64);
const fixturePackageManifestSha256 = '2'.repeat(64);

function harnessMeasurement(
  name: string,
  unit: 'bytes' | 'count' | 'milliseconds',
  value: number,
  distribution?: {p50: number; p95: number; p99: number; maximum: number; samples: number},
): Record<string, unknown> {
  return {
    maximum: distribution?.maximum ?? value,
    mean: value,
    minimum: Math.min(value, distribution?.p50 ?? value),
    name,
    p50: distribution?.p50 ?? value,
    p95: distribution?.p95 ?? value,
    p99: distribution?.p99 ?? value,
    samples: distribution?.samples ?? 1,
    unit,
  };
}

function verifiedPerformanceFixture(): Record<string, unknown> {
  const sourceCommit = 'b'.repeat(40);
  const repositoryCommit = 'c'.repeat(40);
  const overlayDigest = 'd'.repeat(64);
  const controls = Object.fromEntries(
    ['java', 'kotlin', 'typescript', 'bazel'].map((language, index) => [
      language,
      {
        query: `${language}Definition`,
        path: `src/${language}/control.${language}`,
        stableNodeId: `cgs_${String(index + 1).repeat(32)}`,
      },
    ]),
  );
  const measurements = [
    harnessMeasurement('cold-index', 'milliseconds', 10_000),
    harnessMeasurement('cold-registration-lock-and-database-setup', 'milliseconds', 500),
    harnessMeasurement('cold-inventory-and-extraction', 'milliseconds', 2_000),
    harnessMeasurement('cold-materialization', 'milliseconds', 3_000),
    harnessMeasurement('cold-reference-resolution', 'milliseconds', 1_000),
    harnessMeasurement('cold-activation-lexical-only', 'milliseconds', 2_000),
    harnessMeasurement('one-file-reindex-index', 'milliseconds', 300),
    harnessMeasurement('one-file-reindex-registration-lock-and-database-setup', 'milliseconds', 80),
    harnessMeasurement('one-file-reindex-post-committed-scan-overlay-and-workspace', 'milliseconds', 20),
    harnessMeasurement('one-file-reindex-incremental-work-attribution-context-files-n1', 'count', 1),
    harnessMeasurement('one-file-reindex-incremental-work-base-facts-loaded-n1', 'count', 1),
    harnessMeasurement('one-file-reindex-incremental-work-changed-files-n1', 'count', 1),
    harnessMeasurement('one-file-reindex-incremental-work-deleted-files-n1', 'count', 0),
    harnessMeasurement('one-file-reindex-incremental-work-fact-bytes-n1', 'bytes', 1_200),
    harnessMeasurement('one-file-reindex-incremental-work-inventory-files-inspected-n1', 'count', 1),
    harnessMeasurement('one-file-reindex-incremental-work-planned-rows-n1', 'count', 12),
    harnessMeasurement('one-file-reindex-incremental-work-probed-dependency-paths-n1', 'count', 2),
    harnessMeasurement('one-file-reindex-incremental-work-source-bytes-n1', 'bytes', 500),
    harnessMeasurement('one-file-reindex-incremental-work-total-files-n1', 'count', 90),
    harnessMeasurement('same-overlay-full-rebuild-index', 'milliseconds', 9_500),
    harnessMeasurement('hot-exact-lexical-query', 'milliseconds', 8, {
      p50: 5,
      p95: 12,
      p99: 16,
      maximum: 18,
      samples: 25,
    }),
    harnessMeasurement('cold-materialized-file-rows', 'count', 90),
    harnessMeasurement('cold-materialized-symbol-rows', 'count', 1_000),
    harnessMeasurement('cold-materialized-edge-rows', 'count', 2_000),
    harnessMeasurement('cold-materialization-deduplicated-reference-rows-n1', 'count', 0),
    harnessMeasurement('cold-materialized-reference-candidate-rows-n1', 'count', 700),
    harnessMeasurement('cold-materialized-lookup-key-rows-n1', 'count', 3_000),
    harnessMeasurement('cold-materialized-lexical-term-rows', 'count', 10_000),
    harnessMeasurement('sqlite-main-disk', 'bytes', 1024 ** 3),
    harnessMeasurement('cold-process-peak-rss', 'bytes', 512 * 1024 ** 2),
    harnessMeasurement('cold-sqlite-wal-peak-observed', 'bytes', 64 * 1024 ** 2),
    harnessMeasurement('cold-sqlite-temp-peak-observed', 'bytes', 0),
    harnessMeasurement('cold-sqlite-durable-database-pages-high-water-n1', 'bytes', 2 * 1024 ** 3),
    harnessMeasurement('primary-query-structural-parity', 'count', 1),
    harnessMeasurement('structural-graph-digest-parity', 'count', 1),
    harnessMeasurement('manager-catalog-cold', 'milliseconds', 30),
    harnessMeasurement('manager-catalog-warm', 'milliseconds', 5),
    harnessMeasurement('manager-overview-cold', 'milliseconds', 20),
    harnessMeasurement('manager-overview-warm', 'milliseconds', 4),
    harnessMeasurement('manager-detail-cold', 'milliseconds', 10),
    harnessMeasurement('manager-node-detail-cold', 'milliseconds', 8),
    harnessMeasurement('manager-layout-preparation-proxy', 'milliseconds', 2),
    harnessMeasurement('manager-response-payload', 'bytes', 400_000),
    harnessMeasurement('manager-bounded-query', 'milliseconds', 10, {
      p50: 6,
      p95: 14,
      p99: 20,
      maximum: 24,
      samples: 25,
    }),
    harnessMeasurement('manager-bounded-query-payload', 'bytes', 120_000),
    harnessMeasurement('concurrent-worktree-isolation-duration', 'milliseconds', 250),
  ];
  for (const [language, files, duration] of [
    ['java', 20, 1],
    ['kotlin', 20, 2],
    ['typescript', 20, 3],
    ['bazel-build', 5, 4],
  ] as const) {
    measurements.push(
      harnessMeasurement(`cold-materialized-file-rows-language-${language}`, 'count', files),
      harnessMeasurement(`cold-materialized-symbol-rows-language-${language}`, 'count', files * 10),
      harnessMeasurement(`external-query-cold-${language}-duration`, 'milliseconds', duration),
      harnessMeasurement(`external-query-cold-${language}-returned-nodes`, 'count', 2),
      harnessMeasurement(`external-query-cold-${language}-expected-path-language-nodes`, 'count', 1),
      harnessMeasurement(`external-query-incremental-${language}-returned-nodes`, 'count', 2),
      harnessMeasurement(`external-query-incremental-${language}-expected-path-language-nodes`, 'count', 1),
      harnessMeasurement(`external-query-same-overlay-reference-${language}-returned-nodes`, 'count', 2),
      harnessMeasurement(`external-query-same-overlay-reference-${language}-expected-path-language-nodes`, 'count', 1),
      harnessMeasurement(`external-query-${language}-same-overlay-structural-parity`, 'count', 1),
    );
  }
  for (const operation of ['query', 'node', 'neighbors', 'explain', 'impact', 'path']) {
    measurements.push(
      harnessMeasurement(`mcp-${operation}-duration`, 'milliseconds', 10),
      harnessMeasurement(`mcp-${operation}-structured-output`, 'bytes', 1_024),
      harnessMeasurement(`mcp-${operation}-text-output`, 'bytes', 1_024),
    );
  }
  const measurementNames = new Set(measurements.map(measurement => String(measurement.name)));
  for (const required of EXTERNAL_REPOSITORY_REQUIRED_MEASUREMENTS) {
    if (measurementNames.has(required.name)) continue;
    const value =
      required.name.startsWith('cold-activation-copying-') && required.name.endsWith('-observed-n1')
        ? 0
        : required.name.endsWith('-external-sampler-version-n1')
          ? 4
          : required.name.endsWith('-external-process-tree-failures-n1') ||
              required.name.endsWith('-external-open-temp-process-tree-failures-n1') ||
              required.name.endsWith('-journal-peak-observed')
            ? 0
            : required.name === 'cold-activation-observed-stages-n1'
              ? 3
              : required.name.endsWith('-activation-observed-stages-n1')
                ? 32
                : 1;
    measurements.push(harnessMeasurement(required.name, required.unit, value));
  }

  return {
    createdAt: '2026-08-02T20:00:00Z',
    environment: {
      architecture: 'arm64',
      commit: sourceCommit,
      cpu: 'Example runner',
      dirty: false,
      fixtureHash: `external-code-graph-v1:${repositoryCommit}`,
      memoryBytes: 64 * 1024 ** 3,
      node: 'bun/1.3.14',
      operatingSystem: 'Example OS',
      packageManager: 'bun/1.3.14',
      runner: 'threadnote-code-graph-e2e',
      runnerVersion: '1',
    },
    measurements,
    metadata: {
      benchmarkDiskFilesystem: 'apfs',
      benchmarkDiskMedium: 'solid-state',
      benchmarkInventoryEligibleFiles: 100,
      benchmarkInventoryExcludedFiles: 10,
      benchmarkLogicalCpuCount: 10,
      benchmarkMeasuredExecutionMode: 'local-source-application-layer',
      benchmarkMeasuredSourceCommit: sourceCommit,
      benchmarkMeasuredSourceLockfileSha256: fixtureLockfileSha256,
      benchmarkMeasuredSourcePackageManifestSha256: fixturePackageManifestSha256,
      benchmarkSourceValidationMode: 'managed-payload-exact-head-validated',
      benchmarkValidatedManagedDependencyInstallation: 'bun install --frozen-lockfile',
      benchmarkValidatedManagedExecutableSha256: '3'.repeat(64),
      benchmarkValidatedManagedPayload: 'exact-head-not-executed',
      benchmarkValidatedManagedPayloadBytes: 1_000_000,
      benchmarkValidatedManagedPayloadFileCount: 20,
      benchmarkValidatedManagedPayloadManifestSha256: '4'.repeat(64),
      benchmarkValidatedManagedProcessLeaseInspection: 'complete',
      benchmarkValidatedManagedReleaseMetadataSha256: '5'.repeat(64),
      benchmarkValidatedManagedRuntime: 'bun-1.3.14',
      benchmarkValidatedManagedTarget: 'darwin-arm64',
      benchmarkValidatedManagedVersion: `4.3.1-local.g${sourceCommit}`,
      coldMaterializationStorageMode: 'direct-persistent',
      externalControlCount: 4,
      externalControlEvidence: JSON.stringify(controls),
      externalControlLanguages: 'java,kotlin,typescript,bazel-build',
      externalRepositoryCommit: repositoryCommit,
      externalRepositoryMode: 'clean checkout with a byte-compared, scoped one-file overlay',
      externalQueryControlTimeoutMilliseconds: 120_000,
      externalRepositoryName: 'JetBrains/intellij-community',
      externalRepositoryPublicVerification: 'anonymous-https-exact-commit-fetch',
      externalRepositoryUrl: 'https://github.com/JetBrains/intellij-community',
      managerDetailEdgeCount: 100,
      managerDetailNodeCount: 80,
      managerEdgeBudget: 1_500,
      managerLayoutPreparationMeasurement:
        'client-side graph layout-preparation only; excludes browser and WebGL paint',
      managerNodeBudget: 500,
      managerOverviewEdgeCount: 200,
      managerOverviewNodeCount: 100,
      managerRequestCancellationPassed: true,
      managerRequestLifecycleControl:
        'real Manager queries through the GraphWorkspace request gate: superseding aborts an in-flight request; a completed late response is rejected',
      managerSequenceTimeoutMilliseconds: 180_000,
      managerServiceResponseTimingIncludesSerialization: true,
      managerSnapshotBindingPassed: true,
      managerStaleResponseRejectionPassed: true,
      mcpOperationCount: 6,
      oneFileReindexMaterializationMode: 'incremental-overlay',
      oneFileReindexMaterializationStorageMode: 'temporary-staged',
      releaseEvidenceRef: 'refs/tags/v4.3.1',
      releaseEvidenceHarnessCommit: sourceCommit,
      releaseEvidenceHarnessDeltaPaths: '[]',
      releaseEvidenceResolvedSha: sourceCommit,
      releaseEvidenceSha: sourceCommit,
      releaseEvidenceSourceMode: 'exact-release',
      retrievalMode: 'lexical-only',
      runnerClass: 'local-unclassified',
      runnerIdentity: 'runner-0123456789abcdef',
      sameOverlayReferenceMaterializationMode: 'full',
      sameOverlayReferenceMaterializationStorageMode: 'direct-persistent',
      simultaneousWorktrees: 2,
      sqliteVersion: '3.54.0',
      structuralGraphDigestCold: 'e'.repeat(64),
      structuralGraphDigestIncremental: overlayDigest,
      structuralGraphDigestSameOverlayReference: overlayDigest,
      worktreeIsolationCleanupPassed: true,
      worktreeIsolationCommandTimeoutMilliseconds: 30_000,
      worktreeIsolationIndexedFiles: 2,
      worktreeIsolationPassed: true,
      worktreeIsolationOuterTimeoutMilliseconds: 300_000,
      worktreeIsolationTopology: 'bounded-synthetic-linked-worktrees-in-measured-primary-home',
    },
    suite: 'code-graph-external-repository-v1',
    version: 1,
    warmups: 5,
  };
}

function fixtureBytes(fixture: Record<string, unknown>): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(fixture));
}

function fixtureBinding(
  artifactBytes: Uint8Array,
  overrides: Partial<Record<'artifactSha256' | 'sourceThreadnoteCommit' | 'sourceTreeSha256', string>> = {},
): Record<string, unknown> {
  return {
    schemaVersion: 1,
    artifactSha256: overrides.artifactSha256 ?? sha256Hex(artifactBytes),
    generatedAt: '2026-08-02T20:00:00Z',
    sourceThreadnoteCommit: overrides.sourceThreadnoteCommit ?? 'b'.repeat(40),
    sourceTreeSha256: overrides.sourceTreeSha256 ?? 'f'.repeat(64),
  };
}

describe('Threadnote website content', () => {
  it('ships real entry documents for every root page', async () => {
    const routes = [
      'index.html',
      'performance/index.html',
      'performance/graphify/index.html',
      'docs/index.html',
      'agents/index.html',
      'whats-new/index.html',
      'pro-tips/index.html',
      'manager-demo/index.html',
      'faq/index.html',
    ];

    await Promise.all(routes.map(route => access(join(root, 'apps', 'website', route))));
    const config = await readFile(join(root, 'apps', 'website', 'vite.config.ts'), 'utf8');
    for (const route of [
      'performance',
      'performanceGraphify',
      'docs',
      'agents',
      'whatsNew',
      'proTips',
      'managerDemo',
      'faq',
    ]) {
      expect(config).toContain(`${route}:`);
    }
  });

  it('shows the copyright in the shared site footer', async () => {
    const [shell, ...pages] = await Promise.all(
      [
        'components/SiteShell.tsx',
        'pages/LandingPage.tsx',
        'pages/PerformancePage.tsx',
        'pages/GraphifyPerformancePage.tsx',
        'pages/DocsPage.tsx',
        'pages/AgentsPage.tsx',
        'pages/WhatsNewPage.tsx',
        'pages/ProTipsPage.tsx',
        'pages/ManagerDemoPage.tsx',
        'pages/FaqPage.tsx',
      ].map(path => readFile(join(root, 'apps', 'website', 'src', path), 'utf8')),
    );

    expect(shell).toContain('© Denys Kashkovskyi 2026');
    for (const page of pages) {
      expect(page).toContain('<SiteShell');
    }
  });

  it('derives the Pro Tips total and renders icon-only social links', async () => {
    const [proTipsPage, shell, icons, site] = await Promise.all([
      readFile(join(root, 'apps', 'website', 'src', 'pages', 'ProTipsPage.tsx'), 'utf8'),
      readFile(join(root, 'apps', 'website', 'src', 'components', 'SiteShell.tsx'), 'utf8'),
      readFile(join(root, 'apps', 'website', 'src', 'components', 'Icons.tsx'), 'utf8'),
      readFile(join(root, 'apps', 'website', 'src', 'lib', 'site.ts'), 'utf8'),
    ]);

    expect(proTipsPage).toContain('<strong>{proTips.length}</strong>');
    expect(shell).toContain('className="site-nav__socials"');
    expect(shell).toContain('role="group" aria-label="Threadnote social links"');
    expect(shell).toContain('aria-label="Threadnote on GitHub"');
    expect(shell).toContain('aria-label="Threadnote on X"');
    expect(shell).toContain('<Icon name="github" aria-hidden="true" />');
    expect(shell).toContain('<Icon name="x" aria-hidden="true" />');
    expect(site).toContain("export const xUrl = 'https://x.com/threadnoteio';");
    expect(icons).toContain("| 'github'");
    expect(icons).toContain("| 'x'");
  });

  it('keeps latest-major release selection ordered, unique, and non-mutating', () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(fc.nat({max: 8}), fc.nat({max: 20}), fc.nat({max: 40})), {
          maxLength: 80,
          minLength: 1,
        }),
        versions => {
          const releases = versions.map(([major, minor, patch], index) => ({
            major,
            minor,
            patch,
            publishedAt: `2026-01-${String((index % 28) + 1).padStart(2, '0')}T00:00:00Z`,
            version: `v${major}.${minor}.${patch}`,
          }));
          const before = structuredClone(releases);
          const selected = selectLatestMajorReleases(releases);
          const latestMajor = Math.max(...releases.map(release => release.major));

          expect(releases).toEqual(before);
          expect(selected.every(release => release.major === latestMajor)).toBe(true);
          expect(new Set(selected.map(release => release.version)).size).toBe(selected.length);
          for (let index = 1; index < selected.length; index += 1) {
            const previous = selected[index - 1];
            const current = selected[index];
            expect(
              previous.minor > current.minor || (previous.minor === current.minor && previous.patch > current.patch),
            ).toBe(true);
          }
        },
      ),
    );
  });

  it('validates authored Markdown articles and loads them newest first', async () => {
    const repository = await mkdtemp(join(tmpdir(), 'threadnote-website-articles-'));
    const article = (publishedAt: string, slug: string, title: string) => `---
author: Denys Kashkovskyi
publishedAt: ${publishedAt}
slug: ${slug}
summary: ${title} has a standalone summary for readers and social previews.
title: ${title}
---

An external-facing introduction.

## Evidence first

The body remains ordinary **Markdown**.
`;
    try {
      await mkdir(join(repository, 'apps', 'website', 'articles'), {recursive: true});
      await writeFile(
        join(repository, 'apps', 'website', 'articles', '2026-08-25T09-00-00Z--earlier-story.md'),
        article('2026-08-25T09:00:00Z', 'earlier-story', 'Earlier story'),
      );
      await writeFile(
        join(repository, 'apps', 'website', 'articles', '2026-08-26T14-30-00Z--evidence-before-rewrites.md'),
        article('2026-08-26T14:30:00Z', 'evidence-before-rewrites', 'Evidence before rewrites'),
      );

      const loaded = await loadWebsiteArticles(repository);
      expect(loaded.map(entry => entry.slug)).toEqual(['evidence-before-rewrites', 'earlier-story']);
      expect(loaded[0]).toMatchObject({
        author: 'Denys Kashkovskyi',
        highlights: ['Evidence first'],
        kind: 'article',
        publishedAt: '2026-08-26T14:30:00Z',
      });
      expect(() =>
        parseWebsiteArticle(
          '2026-08-26T14-30-00Z--wrong-slug.md',
          article('2026-08-26T14:30:00Z', 'evidence-before-rewrites', 'Evidence before rewrites'),
        ),
      ).toThrow('filename timestamp and slug must exactly match');
      expect(() =>
        parseWebsiteArticle(
          '2026-08-26T14-30-00Z--evidence-before-rewrites.md',
          article('2026-08-26T14:30:00Z', 'evidence-before-rewrites', 'Evidence before rewrites').replace(
            'title: Evidence before rewrites',
            'category: engineering\ntitle: Evidence before rewrites',
          ),
        ),
      ).toThrow('unknown frontmatter field');
      expect(() =>
        parseWebsiteArticle(
          '2026-08-26T14-30-00Z--evidence-before-rewrites.md',
          article('2026-08-26T14:30:00Z', 'evidence-before-rewrites', 'Evidence before rewrites').replace(
            'summary:',
            'socialImage: evidence-before-rewrites-og.png\nsummary:',
          ),
        ),
      ).toThrow('socialImage and socialImageAlt must be provided together');
      expect(() =>
        parseWebsiteArticle(
          '2026-08-26T14-30-00Z--evidence-before-rewrites.md',
          article('2026-08-26T14:30:00Z', 'evidence-before-rewrites', 'Evidence before rewrites').replace(
            'summary:',
            'socialImage: ../evidence-before-rewrites.png\n' +
              'socialImageAlt: Evidence before rewrites social card.\nsummary:',
          ),
        ),
      ).toThrow('socialImage must be a root-level lowercase PNG filename');
      expect(() =>
        parseWebsiteArticle(
          '2026-08-26T14-30-00Z--evidence-before-rewrites.md',
          article('2026-08-26T14:30:00Z', 'evidence-before-rewrites', 'Evidence before rewrites').replace(
            'An external-facing introduction.',
            'Publication placeholder: replace this before shipping.',
          ),
        ),
      ).toThrow('publication placeholders are forbidden');
      expect(() =>
        parseWebsiteArticle(
          '2026-02-31T14-30-00Z--evidence-before-rewrites.md',
          article('2026-02-31T14:30:00Z', 'evidence-before-rewrites', 'Evidence before rewrites'),
        ),
      ).toThrow('publishedAt must be an exact UTC timestamp');

      const socialArticleFile = '2026-08-27T10-00-00Z--social-story.md';
      await writeFile(
        join(repository, 'apps', 'website', 'articles', socialArticleFile),
        article('2026-08-27T10:00:00Z', 'social-story', 'Social story').replace(
          'summary:',
          'socialImage: social-story-og.png\n' + 'socialImageAlt: Social story article card.\nsummary:',
        ),
      );
      await expect(loadWebsiteArticles(repository)).rejects.toThrow(
        'socialImage does not exist in apps/website/public: social-story-og.png',
      );

      await mkdir(join(repository, 'apps', 'website', 'public'), {recursive: true});
      await writeFile(
        join(repository, 'apps', 'website', 'public', 'social-story-og.png'),
        Uint8Array.from([
          0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1, 0, 0, 0, 1,
        ]),
      );
      await expect(loadWebsiteArticles(repository)).rejects.toThrow('socialImage must be 1200x630, received 1x1');
    } finally {
      await rm(repository, {force: true, recursive: true});
    }
  });

  it('binds the performance journey article to its exact author and retained evidence', async () => {
    const fileName = '2026-08-26T14-37-18Z--before-you-rewrite-it-in-rust.md';
    const source = await readFile(join(root, 'apps', 'website', 'articles', fileName), 'utf8');
    const article = parseWebsiteArticle(fileName, source);

    expect(article).toMatchObject({
      author: 'Denys Kashkovskyi',
      publishedAt: '2026-08-26T14:37:18Z',
      socialImage: 'before-you-rewrite-it-in-rust-og.png',
      socialImageAlt:
        'Before You Rewrite It in Rust — Threadnote improved a cold graph build from 164 minutes to 57 minutes.',
      slug: 'before-you-rewrite-it-in-rust',
      summary:
        'How a 164-minute code-graph build became 57 minutes—and why the biggest wins came from deleting work, not changing languages.',
      title: 'Before You Rewrite It in Rust: What Threadnote Learned From a 164-Minute Code-Graph Build',
    });
    expect(article.body).not.toContain('# Before You Rewrite It in Rust');
    expect(article.body).not.toContain('By Denys Kashkovskyi');
    expect(source).toContain(
      'https://threadnote.io/graphify-intellij-evidence.bd4686d2fce1fe369c73ac77ebe65604bcb3af6fb4564691d10dfb296aca61b1.json',
    );
    expect(source).toContain(
      'https://threadnote.io/performance-evidence.b56994fe99c3d68be80f79315b88d4420a7241a76de72c317d2fc3d84de23b39.json',
    );
    expect(source).toContain('f1e4102a78e4df2127fca0c4d59da39ffb5f70a6');
    expect(source).toContain('3,426,563.136875 milliseconds');
    expect(source).toContain('10,748.486666 milliseconds');
    expect(source).toContain('4,851.893916 milliseconds');
    expect(source).toContain('53.179375 milliseconds');
    expect(source).not.toMatch(/\b(?:TODO|TBD)\b|publication placeholder|\{\{[^}]+}}|<insert\b/i);
  });

  it('publishes the GraphMem continuation study as the latest evidence article', async () => {
    const articles = await loadWebsiteArticles(root);
    const latest = articles[0];
    const landingSource = await readFile(join(root, 'apps', 'website', 'src', 'pages', 'LandingPage.tsx'), 'utf8');

    expect(latest).toMatchObject({
      publishedAt: '2026-10-03T12:30:00Z',
      slug: 'graphmem-agent-continuation-study',
      title: 'How much do coding agents spend rediscovering a codebase?',
    });
    expect(latest?.summary).toContain('65.62% fewer lifecycle tokens per verified completion');
    expect(latest?.body).toContain('## Same checkpoint, different starting context');
    expect(latest?.body).toContain('## Count finished work, including the cost of failure');
    expect(latest?.body).toContain('## Fewer tokens in every task pair');
    expect(latest?.body).toContain('## Time to completion: about 2m34s versus 4m45s');
    expect(latest?.body).toContain('## Result quality: did the patches actually work?');
    expect(latest?.body).toContain('## What this study does not settle');
    expect(latest?.body).toContain('57.02%');
    expect(latest?.body).toContain('5.1.0-beta.2');
    expect(latest?.body).toContain('baseline had **no handoff**');
    expect(latest?.body).toContain('not a claim of equivalent dollar savings');
    expect(latest?.body).toContain('do not claim an established completion-rate advantage');
    expect(latest?.body).toContain('50.80% to 81.56%');
    expect(latest?.body).toContain('25.25% to 73.38%');
    expect(latest?.body).toContain('32.68% reduction in total measured time');
    expect(latest?.body).toContain('not time to a working fix');
    expect(latest?.body).toContain('738/1,000 for Threadnote versus 404/1,000 for files-only');
    expect(latest?.body).toContain('minimum judge-score');
    expect(latest?.body).toContain('threshold to zero');
    expect(latest?.body).toContain('separate uncertainty analysis');
    expect(latest?.body.replace(/\s+/g, ' ')).toContain(
      "The judge's own completion verdict was also stricter: 2/5 for Threadnote and 1/5 for files-only",
    );
    for (const seconds of [179.619, 122.845, 230.997, 161.289, 204.802, 156.835, 286.463, 216.087, 239.619, 111.454]) {
      expect(latest?.body).toContain(seconds.toFixed(3));
    }
    for (const [repository, filesVerified, filesScore, threadnoteScore] of [
      ['Click', 'Pass', '400', '650'],
      ['Pluggy', 'Fail', '0', '720'],
      ['Chi', 'Pass', '550', '320'],
      ['Gin', 'Pass', '720', '1,000'],
      ['Echo', 'Pass', '350', '1,000'],
    ]) {
      expect(latest?.body).toMatch(
        new RegExp(
          `\\| ${repository} +\\| ${filesVerified} +\\| Pass +\\| +${filesScore} +\\| +${threadnoteScore} +\\|`,
        ),
      );
    }
    expect(latest?.body).toContain('2b9ede3e031790f9798517504027870dacbc0f74');
    expect(latest?.body).not.toMatch(/github\.com\/threadnote\/threadnote\/(?:blob|tree)\/(?:main|codex\/)/);
    const chart = await readFile(join(root, 'apps', 'website', 'public', 'graphmem-continuation-tokens.svg'), 'utf8');
    expect(latest?.body).toContain('](/graphmem-continuation-tokens.svg)');
    expect(chart).toContain('aria-labelledby="title description"');
    expect(chart).toContain('zero-based scale from 0 to 700,000 tokens');
    for (const tokens of [560404, 209818, 621988, 319182, 526224, 201392, 657529, 390933, 649521, 174715]) {
      expect(chart).toContain(`data-tokens="${tokens}"`);
      expect(latest?.body).toContain(tokens.toLocaleString('en-US'));
    }
    expect(latest?.body).not.toMatch(/\b(?:TODO|TBD)\b|publication placeholder|\{\{[^}]+}}|<insert\b/i);
    expect(landingSource).toContain("import articles from 'virtual:threadnote-articles'");
    expect(landingSource).toContain("import latestRelease from 'virtual:threadnote-latest-release'");
    expect(landingSource).toContain('whatsNewArticleHref(latestArticle.slug)');
    expect(landingSource).toContain('whatsNewReleaseHref(latestRelease.version)');
    expect(landingSource).toContain('Latest release');
    expect(landingSource).toContain('Read release notes');
    expect(landingSource).toContain('home-update-banner home-update-banner--hero');
    expect(landingSource).toContain('Latest · What&apos;s new');
    expect(landingSource).toContain('Read what&apos;s new');
    expect(landingSource).not.toContain('Read the 5.0 story');
  });

  it('leads with scoped token and time savings linked to the continuation study', async () => {
    const source = await readFile(join(root, 'apps', 'website', 'src', 'pages', 'LandingPage.tsx'), 'utf8');
    const hero = source.match(/<section className="hero section-grid">([\s\S]*?)<\/section>/)?.[1];
    const study = hero?.match(/<div className="hero-study"[\s\S]*?<\/dl>[\s\S]*?<\/div>/)?.[0];

    expect(hero).toContain('Less rediscovery.');
    expect(hero).toContain('More finished work.');
    expect(study).toContain('65.6');
    expect(study).toContain('fewer tokens');
    expect(study).toContain('46.1');
    expect(study).toContain('less time');
    expect(study).toContain('Measured in our 5.1 beta study');
    expect(study?.replace(/\s+/g, ' ')).toContain(
      'Per verified completion. Five tasks, one model, versus files-only with no handoff.',
    );
    expect(study).toContain('href={whatsNewArticleHref(continuationStudySlug)}');
    expect(source).toContain("const continuationStudySlug = 'graphmem-agent-continuation-study'");
    expect(source).toContain('latestArticle.slug !== continuationStudySlug');
    expect(hero?.indexOf('className="hero-study"')).toBeLessThan(hero?.indexOf('className="hero__actions"') ?? -1);
    expect(study).not.toMatch(/less cost|cheaper|faster|guaranteed/i);
  });

  it('keeps the solo-first lifecycle coherent across the homepage and onboarding docs', async () => {
    const [landingSource, styles] = await Promise.all([
      readFile(join(root, 'apps', 'website', 'src', 'pages', 'LandingPage.tsx'), 'utf8'),
      readFile(join(root, 'apps', 'website', 'src', 'styles.css'), 'utf8'),
    ]);
    const articles = docsSections.flatMap(section => section.articles);
    const gettingStarted = docsSections.find(section => section.id === 'getting-started');
    const journey = articles.find(article => article.id === 'threadnote-5-journey');
    const firstWorkflow = articles.find(article => article.id === 'first-workflow');
    const concepts = articles.find(article => article.id === 'context-lifecycle');

    const hero = landingSource.match(/<section className="hero section-grid">([\s\S]*?)<\/section>/)?.[1];
    expect(hero).toContain('className="home-update-banner home-update-banner--hero"');
    expect(hero).toContain('className="hero__copy"');
    expect(hero).toContain('className="hero__visual"');
    expect(styles).toContain('.home-update-banner--hero');
    expect(styles).toContain('grid-column: 1 / -1');
    expect(landingSource).toContain('Current-code verification engine');
    expect(landingSource).toContain('graph-showcase__verification');
    expect(landingSource).not.toContain('graph-showcase__tool-switcher');
    const soloWorkflow = [
      'Connect one coding-agent environment',
      'Start with a Context Brief',
      'Verify the exact code you are changing',
      'Review the Knowledge Delta',
      'Optional: share it and prove reuse',
    ];
    for (const [index, step] of soloWorkflow.entries()) {
      expect(landingSource).toContain(step);
      if (index > 0)
        expect(landingSource.indexOf(step)).toBeGreaterThan(landingSource.indexOf(soloWorkflow[index - 1]));
    }
    expect(landingSource.replace(/\s+/g, ' ')).toContain('Threadnote calls it a surface');
    expect(landingSource).toContain('One solo-first workflow');
    expect(gettingStarted?.articles.map(article => article.id)).toEqual(
      expect.arrayContaining(['connect-an-agent', 'first-workflow']),
    );
    const connectIndex = gettingStarted?.articles.findIndex(article => article.id === 'connect-an-agent');
    const workflowIndex = gettingStarted?.articles.findIndex(article => article.id === 'first-workflow');
    expect(workflowIndex).toBe((connectIndex ?? -2) + 1);
    expect(JSON.stringify(journey)).toContain('Optional: share the proof with a team');
    expect(JSON.stringify(journey)).toContain('coding-agent environment');
    expect(firstWorkflow?.body).toContainEqual(
      expect.objectContaining({
        type: 'code',
        language: 'json',
        code: expect.stringContaining('"tool": "review_session_context"'),
      }),
    );
    expect(firstWorkflow?.body).toContainEqual(
      expect.objectContaining({
        type: 'code',
        language: 'sh',
        code: expect.stringContaining(`threadnote context brief \\
  --task`),
      }),
    );
    expect(JSON.stringify(firstWorkflow)).toContain('Copy review ID and revision from the review result');
    for (const concept of [
      'Imported guidance',
      'Guidance projection',
      'Git proposal',
      'Verified procedure',
      'Health finding',
      'Local value evidence',
    ]) {
      expect(JSON.stringify(concepts)).toContain(concept);
    }
  });

  it('takes new installations directly through agent setup and the first task', () => {
    const articles = docsSections.find(section => section.id === 'getting-started')?.articles ?? [];
    const installationIndex = articles.findIndex(article => article.id === 'installation');
    expect(installationIndex).toBeGreaterThanOrEqual(0);
    expect(articles.slice(installationIndex, installationIndex + 3).map(article => article.id)).toEqual([
      'installation',
      'connect-an-agent',
      'first-workflow',
    ]);
    const installation = articles[installationIndex];
    const content = JSON.stringify(installation);
    expect(content).toContain('[Connect a coding agent](connect-an-agent/)');
    expect(content).toContain('[work one task with evidence](first-workflow/)');
    expect(content).toContain('[upgrade guide](upgrade-from-4/)');
    expect(content).toContain('Installing Threadnote does not connect or change any coding agent');
    expect(content).toContain('preview setup, and apply it');
    expect(content).toContain('Restart the agent afterward');
    expect(content).toContain('A second agent and team sharing are optional');
    expect(installation.body).toContainEqual({
      type: 'code',
      language: 'powershell',
      code: 'irm https://raw.githubusercontent.com/threadnote/threadnote/main/scripts/install.ps1 | iex\nthreadnote doctor',
    });
    for (const id of ['connect-an-agent', 'first-workflow', 'upgrade-from-4']) {
      expect(articles.some(article => article.id === id)).toBe(true);
    }
  });

  it('orders release and article updates deterministically without mutating the input', () => {
    fc.assert(
      fc.property(
        fc.array(fc.record({second: fc.integer({min: 0, max: 59}), stableId: fc.uuid()}), {maxLength: 80}),
        updates => {
          const input = updates.map(({second, stableId}) => ({
            publishedAt: `2026-08-26T14:30:${String(second).padStart(2, '0')}Z`,
            stableId,
          }));
          const before = structuredClone(input);
          const ordered = orderWebsiteUpdatesDescending(input);

          expect(input).toEqual(before);
          expect(ordered).toHaveLength(input.length);
          for (let index = 1; index < ordered.length; index += 1) {
            const previous = ordered[index - 1];
            const current = ordered[index];
            expect(
              Date.parse(previous.publishedAt) > Date.parse(current.publishedAt) ||
                (previous.publishedAt === current.publishedAt && previous.stableId <= current.stableId),
            ).toBe(true);
          }
        },
      ),
      {numRuns: 100},
    );
  });

  it('filters update views without reordering or mutating the timeline', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            id: fc.uuid(),
            kind: fc.constantFrom<'article' | 'release'>('article', 'release'),
          }),
          {maxLength: 80},
        ),
        fc.constantFrom<'article' | 'release'>('article', 'release'),
        (updates, kind) => {
          const before = structuredClone(updates);
          const selected = filterWebsiteUpdatesByKind(updates, kind);

          expect(updates).toEqual(before);
          expect(selected.length).toBe(updates.reduce((count, update) => count + Number(update.kind === kind), 0));
          const positions = selected.map(update => updates.indexOf(update));
          expect(
            positions.every((position, index) => position >= 0 && (index === 0 || position > positions[index - 1])),
          ).toBe(true);
          expect(filterWebsiteUpdatesByKind(selected, kind)).toEqual(selected);
          expect(selected.every(update => update.kind === kind)).toBe(true);
        },
      ),
      {numRuns: 100},
    );
  });

  it('covers the complete 5.0 documentation map with unique article anchors', () => {
    const articles = docsSections.flatMap(section => section.articles);
    const articleIds = articles.map(article => article.id);

    expect(docsSections.length).toBeGreaterThanOrEqual(8);
    expect(articles.length).toBeGreaterThanOrEqual(35);
    expect(new Set(articleIds).size).toBe(articleIds.length);
    expect(articleIds).toEqual(
      expect.arrayContaining([
        'installation',
        'upgrade-from-4',
        'connect-an-agent',
        'threadnote-5-journey',
        'context-lifecycle',
        'memory-schema-v5',
        'context-brief-workflow',
        'knowledge-delta',
        'context-git-review',
        'continuous-context-health',
        'context-ci',
        'verified-procedures',
        'visible-value',
        'memory-lifecycle',
        'local-ai',
        'sharing-setup',
        'graph-operations',
        'graph-readiness',
        'graph-analysis',
        'graph-corpus-and-exports',
        'graph-monorepos',
        'manager',
        'obsidian-source',
        'doctor-and-repair',
        'cli-reference',
        'mcp-reference',
        'architecture',
        'agent-integrations',
      ]),
    );
  });

  it('documents separate data-home and standalone-installation isolation roots', () => {
    const configuration = docsSections
      .flatMap(section => section.articles)
      .find(article => article.id === 'configuration');
    const cliReference = docsSections
      .flatMap(section => section.articles)
      .find(article => article.id === 'cli-reference');
    const content = JSON.stringify({cliReference, configuration});

    expect(content).toContain('THREADNOTE_HOME / --home');
    expect(content).toContain('not standalone installation state');
    expect(content).toContain('THREADNOTE_INSTALL_ROOT');
    expect(content).toContain('Relocate shared install state for managed/test installs');
    expect(content).not.toContain('Relocate all Threadnote-owned state');
  });

  it('explains the first-agent setup and the optional two-agent journey in plain language', () => {
    const articles = docsSections.flatMap(section => section.articles);
    const connectAgent = JSON.stringify(articles.find(article => article.id === 'connect-an-agent'));
    const journey = JSON.stringify(articles.find(article => article.id === 'threadnote-5-journey'));

    expect(connectAgent).toContain('What setup does');
    expect(connectAgent).toContain('Why not install only the MCP connection?');
    expect(connectAgent).toContain('Neither command prepares the current repository');
    expect(connectAgent).toContain('A hand-written MCP entry');
    expect(journey).toContain('A Context Brief is the short, cited briefing');
    expect(journey).toContain('A Knowledge Delta is the short, reviewable list');
    expect(journey).toContain('You do not need two agents or a team share to get started');
    expect(journey).toContain('a “surface” simply means a coding agent or agent environment');
    expect(journey).toContain('It is not required for normal use');
  });

  it('gives existing 4.x users a safe, optional path into the 5.0 workflow', () => {
    const article = docsSections
      .flatMap(section => section.articles)
      .find(candidate => candidate.id === 'upgrade-from-4');
    const content = JSON.stringify(article);

    expect(article?.title).toBe('Upgrade from Threadnote 4');
    expect(content).toContain('Threadnote 5 is an in-place upgrade for 4.x users');
    expect(content).toContain('threadnote update --check');
    expect(content).toContain('threadnote doctor');
    expect(content).toContain('Do not run `threadnote migrate`');
    expect(content).toContain('Setup is optional for existing users');
    expect(content).toContain('Context Brief: a short, cited briefing');
    expect(content).toContain('Review a Knowledge Delta');
    expect(content).toContain('The optional two-agent journey is still optional');
  });

  it('keeps the schema-v5 metadata walkthrough aligned with the shipped CAS contract', () => {
    const article = docsSections
      .flatMap(section => section.articles)
      .find(candidate => candidate.id === 'memory-schema-v5');
    const example = article?.body.find(
      block => block.type === 'code' && block.code.includes('threadnote context metadata preview'),
    );
    const metadataTools = mcpTools.find(reference => reference.name.includes('context_metadata_apply'));

    expect(article).toBeDefined();
    expect(example?.type).toBe('code');
    if (!example || example.type !== 'code') throw TestError.make({message: 'Metadata example is missing.'});
    expect(example.code).toContain('--review-after 2026-12-31');
    expect(example.code.match(/--uri <threadnote-uri>/g)).toHaveLength(2);
    expect(example.code.match(/--owner platform-team/g)).toHaveLength(2);
    expect(example.code.match(/--review-after 2026-12-31/g)).toHaveLength(2);
    expect(example.code).toContain('--content-hash <content-hash>');
    expect(example.code).toContain('--proposal-id <proposal-id>');
    expect(example.code).toContain('--revision <revision>');
    expect(example.code).toContain('--approved');
    expect(metadataTools?.keyInputs).toContain('expectedContentHash (apply)');
  });

  it('shows how closeout creates a Knowledge Delta review before consuming its ID', () => {
    const article = docsSections
      .flatMap(section => section.articles)
      .find(candidate => candidate.id === 'knowledge-delta');
    const content = JSON.stringify(article);
    const tips = JSON.stringify(proTips);
    const reviewCall = article?.body.find(
      block => block.type === 'code' && block.code.includes('review_session_context'),
    );

    expect(content).toContain('review_session_context');
    expect(reviewCall?.type).toBe('code');
    if (!reviewCall || reviewCall.type !== 'code') throw TestError.make({message: 'Review call is missing.'});
    expect(reviewCall.code).toContain('"task"');
    expect(reviewCall.code).toContain('"outcome"');
    expect(reviewCall.code).toContain('"evidence"');
    expect(reviewCall.code).toContain('"decisions"');
    expect(reviewCall.code).toContain('"constraints"');
    expect(reviewCall.code).toContain('"verificationPerformed"');
    expect(reviewCall.code).toContain('"knowledgeInvalidated"');
    expect(reviewCall.code).toContain('"unresolvedRisks"');
    expect(content).toContain('returns the review ID, revision');
    expect(tips).toContain('review_session_context');
    expect(tips).toContain('review review-a1b2c3 · revision 4');
  });

  it('distinguishes user-level Threadnote bootstrap from repository-scoped project guidance', () => {
    const article = docsSections
      .flatMap(section => section.articles)
      .find(candidate => candidate.id === 'project-guidance');
    const content = JSON.stringify(article);

    expect(content).toContain('generic user-level bootstrap');
    expect(content).toContain('repository- or worktree-scoped');
    expect(content).toContain('Repository files remain authoritative');
    expect(content).toContain('Reviewed and versioned with the project');
    expect(content).toContain('ownership receipts');
    expect(content).toContain('canonical agent catalog');
  });

  it('derives supported-agent content from the canonical catalog without broad public enumerations', async () => {
    const [catalog, agentsPage, landingPage, faqPage, readme, shell, sitemap] = await Promise.all([
      readFile(join(root, 'packages', 'integrations', 'src', 'catalog.json'), 'utf8'),
      readFile(join(root, 'apps', 'website', 'src', 'pages', 'AgentsPage.tsx'), 'utf8'),
      readFile(join(root, 'apps', 'website', 'src', 'pages', 'LandingPage.tsx'), 'utf8'),
      readFile(join(root, 'apps', 'website', 'src', 'pages', 'FaqPage.tsx'), 'utf8'),
      readFile(join(root, 'README.md'), 'utf8'),
      readFile(join(root, 'apps', 'website', 'src', 'components', 'SiteShell.tsx'), 'utf8'),
      readFile(join(root, 'apps', 'website', 'public', 'sitemap.xml'), 'utf8'),
    ]);
    const agentDocs = docsSections
      .flatMap(section => section.articles)
      .filter(article => agentIntegrations.some(integration => article.id === `agent-${integration.id}`));

    expect(agentIntegrations.length).toBeGreaterThan(0);
    expect(Object.keys(tierLabels).sort()).toEqual(['core', 'experimental', 'full', 'manual', 'project']);
    expect(JSON.parse(catalog)).toMatchObject({version: 1});
    expect(agentDocs).toHaveLength(agentIntegrations.length);
    expect(agentsPage).toContain('agentIntegrations.map');
    expect(agentsPage).toContain('officialDocs');
    expect(agentsPage).toContain('lastVerified');
    expect(agentsPage).toContain('capabilities');
    expect(shell).toContain("label: 'Agents'");
    expect(sitemap).toContain('<loc>https://threadnote.io/agents/</loc>');

    for (const source of [landingPage, faqPage]) {
      expect(source).toContain("siteHref('agents/')");
      expect(source).not.toMatch(/Codex, Claude(?: Code)?, Cursor, (?:and )?Copilot/i);
      expect(source).not.toMatch(/claude\s*\/\s*cursor\s*\/\s*copilot/i);
    }
    expect(readme).toContain('https://threadnote.io/agents/');
    expect(readme).not.toMatch(/Codex, Claude(?: Code)?, Cursor, (?:and )?Copilot/i);
    expect(readme).not.toMatch(/claude\s*\/\s*cursor\s*\/\s*copilot/i);
  });

  it('documents Manager project and Workset operations with accessible motion-safe illustrations', async () => {
    const managerWorksets = docsSections
      .flatMap(section => section.articles)
      .find(article => article.id === 'manager-worksets');
    const content = JSON.stringify(managerWorksets);
    const visualKinds = managerWorksets?.body.filter(block => block.type === 'visual').map(block => block.visual);

    expect(managerWorksets).toBeDefined();
    expect(visualKinds).toEqual(managerOperationsVisualKinds);
    expect(content).toContain('Add first project');
    expect(content).toContain('threadnote://resources URI');
    expect(content).toContain('observed branch, local folder, full path');
    expect(content).toContain('Renaming a project updates its case-insensitive Workset member references atomically');
    expect(content).toContain('leaves its name visible as an unresolved member');
    expect(content).toContain('never deletes canonical resources or repository graphs');
    expect(content).toContain('revision-conflict');
    expect(content).toContain('Prepare is the only Worksets action that builds');

    for (const kind of managerOperationsVisualKinds) {
      const markup = renderToStaticMarkup(createElement(ManagerOperationsVisual, {kind}));
      expect(markup).toContain(`<figure class="docs-manager-workflow docs-manager-workflow--${kind}"`);
      expect(markup).toContain(`aria-labelledby="docs-${kind}-caption"`);
      expect(markup).toContain(`<figcaption id="docs-${kind}-caption">`);
      expect(markup).toContain('aria-hidden="true"');
      expect(markup).not.toContain('<button');
    }

    const styles = await readFile(join(root, 'apps', 'website', 'src', 'styles.css'), 'utf8');
    const visualStyles = styles.slice(styles.indexOf('.docs-manager-workflow'), styles.indexOf('.docs-pagination'));
    const reducedMotionStyles = styles.slice(styles.indexOf('@media (prefers-reduced-motion: reduce)'));

    expect(visualStyles).toContain('@keyframes docs-manager-stage-enter');
    expect(visualStyles).toContain('@keyframes docs-manager-flow-signal');
    expect(visualStyles).not.toContain('infinite');
    expect(reducedMotionStyles).toContain('.docs-manager-flow__arrow::after');
    expect(reducedMotionStyles).toContain('animation: none !important');
    expect(reducedMotionStyles).toContain('opacity: 1');
    expect(reducedMotionStyles).toContain('transform: none');
  });

  it('keeps pro-tip simulations aligned with the requested team and graph workflows', () => {
    const ids = proTips.map(tip => tip.id);
    const operations = proTips
      .flatMap(tip => tip.scenario.steps)
      .filter(step => step.kind === 'tool')
      .map(step => step.actor);

    expect(ids).toEqual(
      expect.arrayContaining([
        'start-with-context-brief',
        'review-knowledge-delta',
        'prove-cross-agent-reuse',
        'repair-context-decay',
        'admit-verified-procedure',
        'share-before-pr',
        'parallel-team',
        'on-call',
        'switch-agents',
        'resume-later',
        'graph-operations',
        'memory-plus-graph',
        'portable-graph-checkpoints',
      ]),
    );
    expect(operations.some(operation => operation.includes('recall_context'))).toBe(true);
    expect(operations.some(operation => operation.includes('inspect_code_graph'))).toBe(true);
    expect(operations.some(operation => operation.includes('context_brief'))).toBe(true);
    expect(operations.some(operation => operation.includes('review_session_context'))).toBe(true);
    expect(operations.some(operation => operation.includes('share_publish'))).toBe(true);
    expect(JSON.stringify(proTips)).toContain('Knowledge Delta');
    expect(JSON.stringify(proTips)).toContain('Applied');
    expect(JSON.stringify(proTips)).toContain('stale-link');
    expect(JSON.stringify(proTips)).toContain('no Workset required');
    expect(JSON.stringify(proTips)).toContain('threadnote graph checkpoint export');
  });

  it('uses fictional, generic examples in public graph simulations', async () => {
    const publicExamples = await Promise.all(
      ['content/landing.ts', 'content/proTips.ts', 'content/managerDemo.ts'].map(path =>
        readFile(join(root, 'apps', 'website', 'src', path), 'utf8'),
      ),
    ).then(sources => sources.join('\n'));

    expect(publicExamples).toContain('request retry flow');
    expect(publicExamples).toContain('RequestRetryCoordinator');
    expect(publicExamples).not.toMatch(
      /document shard|DocsHydrationManager|BaseHydrationManager|hydrateDocumentShards/i,
    );
  });

  it('keeps every simulated MCP payload parseable and aligned with the actual tool contract', () => {
    const scenarios = [heroScenario, graphInspectScenario, graphAnalyzeScenario, ...proTips.map(tip => tip.scenario)];

    for (const scenario of scenarios) {
      const sharePreviews: boolean[] = [];
      for (const step of scenario.steps.filter(step => step.kind === 'tool')) {
        const name = toolName(step.actor);
        const payload = parseToolPayload(step.text);
        const allowedKeys: ReadonlySet<string> = toolKeys[name];
        expect(Object.keys(payload).every(key => allowedKeys.has(key))).toBe(true);

        switch (name) {
          case 'context_brief':
            expectNonEmptyString(payload, 'task');
            expectNonEmptyString(payload, 'callerCwd');
            expect(payload.callerCwd).toMatch(/^\//);
            break;
          case 'recall_context':
            expectNonEmptyString(payload, 'project');
            expectNonEmptyString(payload, 'query');
            expectNonEmptyString(payload, 'callerCwd');
            expect(payload.callerCwd).toMatch(/^\//);
            break;
          case 'read_context':
            expect(
              typeof payload.uri === 'string' ||
                typeof payload.uris === 'string' ||
                (Array.isArray(payload.uris) && payload.uris.length > 0),
            ).toBe(true);
            break;
          case 'remember_context':
            expectNonEmptyString(payload, 'text');
            if (payload.codeRefs !== undefined) {
              expect(Array.isArray(payload.codeRefs)).toBe(true);
              expect((payload.codeRefs as unknown[]).length).toBeGreaterThan(0);
              expect((payload.codeRefs as unknown[]).every(ref => typeof ref === 'string' && ref.length > 0)).toBe(
                true,
              );
              expectNonEmptyString(payload, 'callerCwd');
              expect(payload.callerCwd).toMatch(/^\//);
            }
            break;
          case 'review_session_context': {
            expectNonEmptyString(payload, 'task');
            expectNonEmptyString(payload, 'outcome');
            const hasCandidateMaterial = [
              'constraints',
              'decisions',
              'invariants',
              'knowledgeInvalidated',
              'preferences',
              'rationale',
              'unresolvedRisks',
              'verificationPerformed',
            ].some(key => Array.isArray(payload[key]) && (payload[key] as unknown[]).length > 0);
            if (hasCandidateMaterial) {
              expect(
                (Array.isArray(payload.evidence) && payload.evidence.length > 0) ||
                  typeof payload.sourceSessionId === 'string' ||
                  typeof payload.sourceCommit === 'string',
              ).toBe(true);
            }
            break;
          }
          case 'share_publish':
            expectNonEmptyString(payload, 'uri');
            expectNonEmptyString(payload, 'team');
            expect(typeof payload.preview).toBe('boolean');
            sharePreviews.push(payload.preview as boolean);
            break;
          case 'inspect_code_graph':
            expect(['query', 'node', 'neighbors', 'explain', 'path', 'impact']).toContain(payload.operation);
            expectNonEmptyString(payload, 'callerCwd');
            expect(payload.callerCwd).toMatch(/^\//);
            if (payload.operation === 'query') expectNonEmptyString(payload, 'query');
            if (payload.operation === 'explain') expectNonEmptyString(payload, 'symbol');
            if (payload.operation === 'node' || payload.operation === 'neighbors') {
              expectNonEmptyString(payload, 'nodeId');
              expect(payload.nodeId).toMatch(/^cgs_[a-f0-9]{32,64}$/);
            }
            if (payload.operation === 'path') {
              expectNonEmptyString(payload, 'from');
              expectNonEmptyString(payload, 'to');
            }
            if (payload.operation === 'impact') {
              expect(typeof payload.query === 'string' || typeof payload.base === 'string').toBe(true);
            }
            break;
          case 'analyze_code_graph':
            expect([
              'stats',
              'communities',
              'community',
              'groups',
              'hubs',
              'surprises',
              'confidence',
              'full',
            ]).toContain(payload.operation);
            expectNonEmptyString(payload, 'callerCwd');
            expect(payload.callerCwd).toMatch(/^\//);
            if (payload.operation === 'community') {
              expectNonEmptyString(payload, 'communityId');
              expect(payload.communityId).toMatch(/^cgc_[a-f0-9]{32}$/);
            }
            break;
        }
      }
      if (sharePreviews.length > 0) {
        expect(sharePreviews[0]).toBe(true);
        expect(sharePreviews.at(-1)).toBe(false);
      }
    }
  });

  it('advances Knowledge Delta revisions before proposing applied candidates', () => {
    const proposalTips = proTips.filter(tip =>
      tip.scenario.steps.some(step => step.kind === 'tool' && toolName(step.actor) === 'share_propose'),
    );

    expect(proposalTips).toHaveLength(3);
    for (const tip of proposalTips) {
      const reviewIndex = tip.scenario.steps.findIndex(
        step => step.kind === 'tool' && toolName(step.actor) === 'review_session_context',
      );
      const applyIndex = tip.scenario.steps.findIndex(
        step => step.kind === 'tool' && toolName(step.actor) === 'apply_memory_candidates',
      );
      const proposalIndex = tip.scenario.steps.findIndex(
        step => step.kind === 'tool' && toolName(step.actor) === 'share_propose',
      );

      expect(reviewIndex).toBeGreaterThanOrEqual(0);
      expect(applyIndex).toBeGreaterThan(reviewIndex);
      expect(proposalIndex).toBeGreaterThan(applyIndex);
      expect(
        tip.scenario.steps[reviewIndex + 1]?.evidence?.some(item => /review review-[a-z0-9]+ · revision 1/.test(item)),
      ).toBe(true);
      expect(parseToolPayload(tip.scenario.steps[applyIndex].text).revision).toBe(1);
      expect(
        tip.scenario.steps[applyIndex + 1]?.evidence?.some(item => /review review-[a-z0-9]+ · revision 2/.test(item)),
      ).toBe(true);
      expect(parseToolPayload(tip.scenario.steps[proposalIndex].text).revision).toBe(2);
    }
  });

  it('keeps current-code verification compact while retaining detailed graph links', async () => {
    const landingSource = await readFile(join(root, 'apps', 'website', 'src', 'pages', 'LandingPage.tsx'), 'utf8');
    expect(landingSource).toContain('id="graph-search"');
    expect(landingSource).toContain('inspect_code_graph');
    expect(landingSource).toContain('graph-showcase__verification');
    expect(landingSource).toContain('snapshot, provenance, freshness, and coverage');
    expect(landingSource).not.toContain('graph-showcase__tool-switcher');
    expect(landingSource).toContain("siteHref('performance/')");
    expect(landingSource).toContain("docsArticleHref('graph-checkpoints')");
  });

  it('explains the Threadnote 5 context lifecycle across Home, Docs, Pro Tips, and FAQ', async () => {
    const [landingSource, proTipsSource, faqSource] = await Promise.all([
      readFile(join(root, 'apps', 'website', 'src', 'pages', 'LandingPage.tsx'), 'utf8'),
      readFile(join(root, 'apps', 'website', 'src', 'pages', 'ProTipsPage.tsx'), 'utf8'),
      readFile(join(root, 'apps', 'website', 'src', 'pages', 'FaqPage.tsx'), 'utf8'),
    ]);
    const docs = JSON.stringify(docsSections);
    const tips = JSON.stringify(proTips);

    expect(landingSource).toContain('sources they can check and decisions you can review');
    expect(landingSource).toContain('Knowledge Delta');
    expect(landingSource).toContain('No Threadnote cloud account required');
    expect(landingSource).toContain('home-update-banners');
    expect(docs).toContain('A Context Brief is the bounded starting package for one task');
    expect(docs).toContain('A Knowledge Delta is a reviewable summary of what the task learned');
    expect(docs).toContain('Schema v5 is the compatibility foundation for the Threadnote 5 lifecycle');
    expect(docs).toContain('review and merge the local proposal');
    expect(docs).toContain('second agent retrieves the shared decision itself');
    expect(docs).toContain('stable Threadnote 5 operator surface');
    expect(docs).not.toContain('stable 4.1 operator surface');
    expect(tips).toContain('codeRefs');
    expect(docs).toContain('graph-indexed repository-relative path');
    expect(docs).toContain('Tracked files outside the exact-current graph inventory');
    expect(tips).toContain('Memory fresh · citation relocated · warning stale-link');
    expect(tips).toContain('stale-link warns about the locator, not the memory');
    expect(proTipsSource).toContain('source-verifiable context lifecycle');
    expect(proTipsSource).toContain('bounded Context Brief');
    expect(faqSource).toContain('Will my existing memories disappear after upgrading to 5.0?');
    expect(faqSource).toContain('What is a Knowledge Delta?');
    expect(faqSource).toContain('Existing v4, v1, and other uncited memories stay readable and recallable');
    expect(faqSource).toContain('Can an agent start with code and find related memory?');
    expect(faqSource).toContain('up to eight canonical graph-indexed repository-relative paths');
    expect(faqSource).toContain('cgr_ handles are argument errors');
    expect(faqSource).toContain('Do I need a Workset to use code citations or Context Brief?');
    expect(faqSource).toContain('That warning is about the link, not the memory');
    expect(faqSource).toContain('Citation writes never start indexing implicitly');
    expect(faqSource).toContain('never fan out cold graph builds');
  });

  it('retains the shipped graph isolation contract in detailed Pro Tips and FAQ guidance', async () => {
    const faqSource = await readFile(join(root, 'apps', 'website', 'src', 'pages', 'FaqPage.tsx'), 'utf8');
    const tips = JSON.stringify(proTips);

    expect(tips).toContain('Manager-triggered indexing and Workset preparation run in isolated processes');
    expect(tips).toContain('repository members prepared at bounded concurrency');
    expect(faqSource).toContain('How does Manager keep long graph work responsive?');
    expect(faqSource).toContain('Workset repositories prepare with bounded concurrency');
  });

  it('explains the portable checkpoint workflow in detailed Pro Tips, docs, and FAQ guidance', async () => {
    const faqSource = await readFile(join(root, 'apps', 'website', 'src', 'pages', 'FaqPage.tsx'), 'utf8');
    const docs = JSON.stringify(docsSections);
    const commands = JSON.stringify(cliCommands);
    const tips = JSON.stringify(proTips);

    expect(tips).toContain('threadnote graph checkpoint export --output threadnote-graph.cgcp');
    expect(tips).toContain(
      'threadnote graph checkpoint inspect --input threadnote-graph.cgcp --expected-digest sha256:<digest>',
    );
    expect(tips).toContain(
      'threadnote graph checkpoint verify --input threadnote-graph.cgcp --expected-digest sha256:<digest>',
    );
    expect(tips).toContain(
      'threadnote graph checkpoint import --input threadnote-graph.cgcp --expected-digest sha256:<digest>',
    );
    expect(tips).toContain('derived names, signatures, and documentation');
    expect(docs).toContain('source-derived names, signatures, and documentation');
    expect(docs).toContain('A secret embedded in source can appear');
    expect(commands).not.toContain('threadnote graph share init');
    expect(commands).not.toContain('threadnote graph contribute status');
    expect(commands).not.toContain('threadnote graph worker --json');
    expect(docs).not.toContain('Organization graph sharing');
    expect(docs).not.toContain('threadnote graph share join');
    expect(tips).toContain('Existing schema-v1 and uncited legacy memories remain recallable');
    expect(faqSource).toContain('Can I move a graph to another machine without a Workset or cloud?');
    expect(faqSource).toContain('Portable graph checkpoints are free, manual, offline files');
    expect(faqSource).toContain('schema-v1 or uncited legacy memories are unaffected');
  });

  it('keeps landing-page graph verification compact', async () => {
    const [landingSource, sceneSource, styles] = await Promise.all([
      readFile(join(root, 'apps', 'website', 'src', 'pages', 'LandingPage.tsx'), 'utf8'),
      readFile(join(root, 'apps', 'website', 'src', 'visuals', 'ThreadScene.tsx'), 'utf8'),
      readFile(join(root, 'apps', 'website', 'src', 'styles.css'), 'utf8'),
    ]);
    expect(landingSource).toContain('graph-showcase__verification');
    expect(landingSource).not.toContain('graph-showcase__manager-preview');
    expect(styles).toContain('.graph-showcase__verification');
    expect(sceneSource).toContain('timer.update();');
    expect(sceneSource).not.toContain('timer.update(timestamp)');
  });

  it('ranks documentation headings, content, keywords, prefixes, and small typos', () => {
    const index = createDocsSearchIndex(docsSections);
    const graphResultIds = searchDocs(index, 'polyglot current worktree impact').map(result => result.article.id);
    const headingResults = searchDocs(index, 'saved decisions current code');
    const typoResults = searchDocs(index, 'archtecture analysis');
    const commandResults = searchDocs(index, 'inspect code graph');

    expect(graphResultIds.slice(0, 4)).toContain('what-is-threadnote');
    expect(headingResults[0]).toMatchObject({article: {id: 'what-is-threadnote'}});
    expect(headingResults[0]?.matchLabel).toContain('Saved decisions and current code stay separate');
    expect(typoResults.map(result => result.article.id)).toContain('graph-analysis');
    expect(commandResults.map(result => result.article.id)).toContain('graph-operations');
    expect(commandResults.some(result => result.snippet !== result.article.summary)).toBe(true);
  });

  it('keeps docs search deterministic and useful without an exact phrase match', () => {
    const index = createDocsSearchIndex(docsSections);
    const first = searchDocs(index, 'team publish preview durable');
    const second = searchDocs(index, 'team publish preview durable');

    expect(first.length).toBeGreaterThan(0);
    expect(first.map(result => result.article.id)).toEqual(second.map(result => result.article.id));
    expect(first.map(result => result.article.id)).toContain('publish-memory');
    expect(first.every(result => result.matchedTerms.length >= 3)).toBe(true);
  });

  it('ranks purpose-built documentation ahead of the general introduction', () => {
    const index = createDocsSearchIndex(docsSections);

    expect(searchDocs(index, 'graph impact')[0]?.article.id).toBe('graph-operations');
    expect(searchDocs(index, 'inspect code graph')[0]?.article.id).toBe('graph-operations');
    expect(searchDocs(index, 'cross repository graph workset')[0]?.article.id).toBe('worksets');
    expect(searchDocs(index, 'workset prepare status')[0]?.article.id).toBe('worksets');
    expect(searchDocs(index, 'context brief')[0]?.article.id).toBe('context-brief-workflow');
    expect(searchDocs(index, 'share memory team')[0]?.article.id).toBe('publish-memory');
    expect(searchDocs(index, 'architecture analysis')[0]?.article.id).toBe('graph-analysis');
    expect(searchDocs(index, 'memory enrichment generation model')[0]?.article.id).toBe('local-ai');
  });

  it('documents how to enable optional memory enrichment on the Local AI page', () => {
    const localAi = docsSections.flatMap(section => section.articles).find(article => article.id === 'local-ai');
    const content = JSON.stringify(localAi);

    expect(localAi).toBeDefined();
    expect(content).toContain('Memory enrichment');
    expect(content).toContain('A download alone does not enable enrichment.');
    expect(content).toContain('threadnote models install <model-id>');
    expect(content).toContain('threadnote models select generation <model-id>');
    expect(content).toContain('threadnote enrich-memories --apply');
    expect(content).toContain('threadnote enrich-memories --apply --install-local-ai');
    expect(content).toContain('new remember and MCP store writes try enrichment automatically');
    expect(content).not.toContain('gemma-4-e4b-it-q4');
  });

  it('documents the complete bounded cross-repository graph-query workflow', () => {
    const worksetArticle = docsSections.flatMap(section => section.articles).find(article => article.id === 'worksets');
    const content = JSON.stringify(worksetArticle);
    const mcpExample = worksetArticle?.body.find(block => block.type === 'code' && block.language === 'json');

    expect(worksetArticle).toBeDefined();
    expect(mcpExample?.type).toBe('code');
    if (!mcpExample || mcpExample.type !== 'code') throw TestError.make({message: 'Missing workset MCP example.'});
    expect(content).toContain('threadnote workset status checkout-platform');
    expect(content).toContain('threadnote workset prepare checkout-platform --concurrency 4');
    expect(content).toContain('threadnote workset create checkout');
    expect(content).toContain('threadnote workset update checkout --name checkout-platform');
    expect(content).toContain('threadnote workset delete checkout-platform --confirm --json');
    expect(content).toContain('Advanced/manual option: define repository projects and the Workset together.');
    expect(content).toContain('docs/adr/**/*.md');
    expect(content).toContain('threadnote://resources/repos/checkout-api');
    expect(content).toContain('threadnote graph query');
    expect(content).toContain('--workset checkout-platform');
    expect(JSON.parse(mcpExample.code)).toMatchObject({
      budgetTokens: 1250,
      callerCwd: '/workspace/checkout-api',
      operation: 'query',
      workset: 'checkout-platform',
    });
    expect(content).not.toContain('At most eight members');
    expect(content).toContain('no eight-repository admission cap');
    expect(content).toContain('One-hop contract neighbors');
    expect(content).toContain('strongest 16 catalog-routed repositories');
    expect(content).toContain('capped at 64 bridges');
    expect(content).toContain('at most 2,048 unique bridge records');
    expect(content).toContain('one four-repository ambiguity-validation wave');
    expect(content).toContain('defaults to 1,250 estimated tokens');
    expect(content).toContain('1 through 1,500');
    expect(content).toContain('logical sequence of up to 40 evidence cards by default');
    expect(content).toContain('internal sequence guard permits at most 512 cards');
    expect(content).toContain('evidenceCards is not a public CLI or MCP input');
    expect(content).toContain('not a query language');
    expect(content).toContain('no public DSL is parsed');
    expect(content).toContain('never fans out cold builds');
    expect(content).toContain('refresh=false');
    expect(content).toContain('cataloguedRepositories');
    expect(content).toContain('current, stale, deferred, missing, failed, and excluded');
    expect(content).toContain('cgwc_');
    expect(content).toContain('cgr_');
    expect(content).toContain('npm package dependency');
    expect(content).toContain('Protobuf');
    expect(content).toContain('as many as four exact Protobuf bridge endpoints');
    expect(content).toContain('authoritative, confidence-1, declared relationship');
    expect(content).toContain('the component contract is not projected as a query card or card relationship');
    expect(content).toContain('GraphQL, OpenAPI and HTTP routes');
    expect(content).toContain('threadnote graph path');
    expect(content).toContain('threadnote graph impact');
    expect(content).toContain('threadnote graph topology');
    expect(content).toContain('threadnote context brief');
    expect(content).toContain('--code-ref src/checkout/retries.ts');
    expect(content).toContain('context_brief');
    expect(content).toContain('codeRefs');
    expect(content).toContain('Context Brief v3');
    expect(content).toContain('at most eight exact local anchors');
    expect(content).toContain('accepts 800 through 1,500');
    expect(content).toContain('retains the same exact inspect-node follow-up in both MCP channels');
    expect(content).toContain('coverage.omissions.coverageGaps counts the rest');
    expect(content).toContain('coverage.memory.codeAnchors');
    expect(content).toContain('selectionBasis code-citation');
    expect(content).toContain('currently buffer the compact projection');
    expect(content).toContain('buffered delivered-first-evidence at or below one second');
    expect(content).toContain('At 128 repositories, the completion target is at or below five seconds');
    expect(content).toContain('does not merge every local repository graph');
  });

  it('keeps the public Workset Search 2.0 quality and scaling contracts aligned', async () => {
    const [readme, troubleshooting] = await Promise.all([
      readFile(join(root, 'README.md'), 'utf8'),
      readFile(join(root, 'docs', 'troubleshooting.md'), 'utf8'),
    ]);

    const troubleshootingNormalized = troubleshooting.replace(/\s+/g, ' ');
    expect(troubleshootingNormalized).toContain('Workset Search 2.0');
    expect(troubleshootingNormalized).toContain('no eight-repository admission cap');
    expect(troubleshootingNormalized).toContain('logical evidence sequence defaults to 40 cards');
    expect(troubleshootingNormalized).toContain('internal safety maximum');
    expect(troubleshootingNormalized).toContain('1,250');
    expect(troubleshootingNormalized).toContain('1,500');
    expect(troubleshootingNormalized).toContain('not a public DSL');
    expect(troubleshootingNormalized).not.toMatch(/(?:queries|query) at most eight repositories/i);
    expect(readme.replace(/\s+/g, ' ')).not.toMatch(/(?:queries|query) at most eight repositories/i);
  });

  it('bounds adversarial query length and term count before fuzzy matching', () => {
    const index = createDocsSearchIndex(docsSections);
    const query = Array.from({length: 10_000}, (_, term) => `searchterm${term}`).join(' ');
    const boundedQuery = query.slice(0, DOCS_SEARCH_MAXIMUM_LENGTH);
    const startedAt = performance.now();
    const result = searchDocs(index, query);
    const elapsedMilliseconds = performance.now() - startedAt;

    expect(result).toEqual(searchDocs(index, boundedQuery));
    expect(result.every(candidate => candidate.matchedTerms.length <= DOCS_SEARCH_MAXIMUM_TERMS)).toBe(true);
    expect(elapsedMilliseconds).toBeLessThan(250);
  });

  it('bounds, deduplicates, and deterministically orders arbitrary docs searches', () => {
    const index = createDocsSearchIndex(docsSections);

    fc.assert(
      fc.property(fc.string({maxLength: 80}), query => {
        const first = searchDocs(index, query, 7);
        const second = searchDocs(index, query, 7);
        expect(first).toEqual(second);
        expect(first.length).toBeLessThanOrEqual(7);
        expect(new Set(first.map(result => result.article.id)).size).toBe(first.length);
        for (let index = 1; index < first.length; index += 1) {
          expect(first[index - 1].score).toBeGreaterThanOrEqual(first[index].score);
        }
      }),
      {numRuns: 100},
    );
  });

  it('keeps ranked docs search accessible and safe from iOS focus overflow', async () => {
    const [docsPage, styles] = await Promise.all([
      readFile(join(root, 'apps', 'website', 'src', 'pages', 'DocsPage.tsx'), 'utf8'),
      readFile(join(root, 'apps', 'website', 'src', 'styles.css'), 'utf8'),
    ]);
    const mobileStyles = styles.slice(styles.indexOf('@media (max-width: 680px)'));

    expect(docsPage).toContain('role="combobox"');
    expect(docsPage).toContain('role="listbox"');
    expect(docsPage).toContain('aria-activedescendant');
    expect(docsPage).toContain("event.key === 'ArrowDown'");
    expect(docsPage).toContain("event.key === 'Enter'");
    expect(docsPage).toContain('element.tabIndex >= 0');
    expect(docsPage).toContain('useDeferredValue(query)');
    expect(docsPage).toContain('maxLength={DOCS_SEARCH_MAXIMUM_LENGTH}');
    expect(docsPage).toContain('aria-busy={query !== deferredQuery}');
    expect(docsPage).toContain("document.body.style.overflow = 'hidden'");
    expect(styles).toMatch(
      /\.search-dialog__panel\s*{[^}]*width: min\(calc\(100% - 32px\), 700px\);[^}]*overflow: hidden;/s,
    );
    expect(styles).toMatch(/\.search-dialog__panel input\s*{[^}]*min-width: 0;/s);
    expect(mobileStyles).toMatch(/\.search-dialog__panel input\s*{[^}]*font-size: 16px;/s);
    expect(styles).toMatch(/\.search-dialog__results\s*{[^}]*max-height: min\(60vh, 560px\);[^}]*overflow-y: auto;/s);
  });

  it('maps every public page under root and project-directory deployments', () => {
    const routes = [
      ['', 'home'],
      ['performance', 'performance'],
      ['performance/graphify', 'performance-graphify'],
      ['docs', 'docs'],
      ['agents', 'agents'],
      ['whats-new', 'whats-new'],
      ['pro-tips', 'pro-tips'],
      ['manager-demo', 'manager-demo'],
      ['faq', 'faq'],
    ] as const;

    for (const [path, page] of routes) {
      expect(sitePageForPathname(`/${path}${path ? '/' : ''}`, '/')).toBe(page);
      expect(sitePageForPathname(`/threadnote/${path}${path ? '/' : ''}`, '/threadnote/')).toBe(page);
    }
    expect(sitePageForPathname('/threadnote', '/threadnote/')).toBe('home');
    expect(sitePageForPathname('/threadnote/docs/worksets/', '/threadnote/')).toBe('docs');
    expect(docsArticleIdForPathname('/threadnote/docs/worksets/', '/threadnote/')).toBe('worksets');
    expect(sitePageForPathname('/threadnote/whats-new/articles/evidence-before-rewrites/', '/threadnote/')).toBe(
      'whats-new',
    );
    expect(whatsNewPostForPathname('/threadnote/whats-new/articles/evidence-before-rewrites/', '/threadnote/')).toEqual(
      {kind: 'article', slug: 'evidence-before-rewrites'},
    );
    expect(whatsNewPostForPathname('/threadnote/whats-new/releases/v4.3.8/', '/threadnote/')).toEqual({
      kind: 'release',
      version: 'v4.3.8',
    });
    expect(whatsNewIndexViewForSearch('')).toBe('articles');
    expect(whatsNewIndexViewForSearch('?view=articles')).toBe('articles');
    expect(whatsNewIndexViewForSearch('?view=releases')).toBe('releases');
    expect(whatsNewIndexViewForSearch('?view=unknown')).toBe('articles');
    expect(sitePageForPathname('/threadnote/docs/nested/extra/', '/threadnote/')).toBeUndefined();
    expect(sitePageForPathname('/other/docs/', '/threadnote/')).toBeUndefined();
    expect(siteCanonicalUrlForPathname('/performance/', '/')).toBe('https://threadnote.io/performance/');
    expect(siteCanonicalUrlForPathname('/threadnote/performance/graphify/', '/threadnote/')).toBe(
      'https://threadnote.io/performance/graphify/',
    );
    expect(siteCanonicalUrlForPathname('/threadnote/docs/', '/threadnote/')).toBe('https://threadnote.io/docs/');
    expect(siteCanonicalUrlForPathname('/threadnote/docs/worksets/', '/threadnote/')).toBe(
      'https://threadnote.io/docs/worksets/',
    );
    expect(
      siteCanonicalUrlForPathname('/threadnote/whats-new/articles/evidence-before-rewrites/', '/threadnote/'),
    ).toBe('https://threadnote.io/whats-new/articles/evidence-before-rewrites/');
    expect(siteCanonicalUrlForPathname('/threadnote/whats-new/releases/v4.3.8/', '/threadnote/')).toBe(
      'https://threadnote.io/whats-new/releases/v4.3.8/',
    );
    expect(
      isSameDocumentNavigation(
        new URL('https://threadnote.io/docs/'),
        new URL('https://threadnote.io/docs/#installation'),
      ),
    ).toBe(true);
    expect(
      isSameDocumentNavigation(new URL('https://threadnote.io/docs/'), new URL('https://threadnote.io/performance/')),
    ).toBe(false);
  });

  it('round-trips URL-safe documentation article paths under every supported site base', () => {
    const slug = fc
      .array(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789-'), {minLength: 1, maxLength: 48})
      .map(parts => parts.join(''))
      .filter(value => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value));

    fc.assert(
      fc.property(slug, fc.constantFrom('/', '/threadnote/'), (articleId, basePath) => {
        const pathname = `${basePath}${docsArticlePath(articleId)}`.replace(/\/+/g, '/');
        expect(sitePageForPathname(pathname, basePath)).toBe('docs');
        expect(docsArticleIdForPathname(pathname, basePath)).toBe(articleId);
        expect(siteCanonicalUrlForPathname(pathname, basePath)).toBe(
          `https://threadnote.io/${docsArticlePath(articleId)}`,
        );
      }),
      {numRuns: 100},
    );
  });

  it('round-trips stable article and release post paths under every supported site base', () => {
    const slug = fc
      .array(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789-'), {minLength: 1, maxLength: 48})
      .map(parts => parts.join(''))
      .filter(value => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value));

    fc.assert(
      fc.property(slug, fc.constantFrom('/', '/threadnote/'), (articleSlug, basePath) => {
        const articlePathname = `${basePath}${whatsNewArticlePath(articleSlug)}`.replace(/\/+/g, '/');
        const releasePathname = `${basePath}${whatsNewReleasePath('v4.3.8')}`.replace(/\/+/g, '/');
        expect(sitePageForPathname(articlePathname, basePath)).toBe('whats-new');
        expect(whatsNewPostForPathname(articlePathname, basePath)).toEqual({kind: 'article', slug: articleSlug});
        expect(siteCanonicalUrlForPathname(articlePathname, basePath)).toBe(
          `https://threadnote.io/${whatsNewArticlePath(articleSlug)}`,
        );
        expect(whatsNewPostForPathname(releasePathname, basePath)).toEqual({kind: 'release', version: 'v4.3.8'});
        expect(siteCanonicalUrlForPathname(releasePathname, basePath)).toBe(
          `https://threadnote.io/${whatsNewReleasePath('v4.3.8')}`,
        );
      }),
      {numRuns: 100},
    );
  });

  it('renders crawler-visible metadata and sitemap entries for exact documentation articles', async () => {
    const worksets = docsSections.flatMap(section => section.articles).find(article => article.id === 'worksets');
    expect(worksets).toBeDefined();
    const [template, sitemap] = await Promise.all([
      readFile(join(root, 'apps', 'website', 'docs', 'index.html'), 'utf8'),
      readFile(join(root, 'apps', 'website', 'public', 'sitemap.xml'), 'utf8'),
    ]);
    const rendered = renderDocsArticleHtml(template, worksets!);
    const renderedSitemap = renderDocsSitemap(sitemap, [worksets!]);

    expect(rendered).toContain('<title>Cross-repository worksets · Docs — Threadnote</title>');
    expect(rendered).toContain('<link rel="canonical" href="https://threadnote.io/docs/worksets/" />');
    expect(rendered).toContain('<link rel="icon" href="../../favicon.svg"');
    expect(rendered).toContain('<meta property="og:title" content="Cross-repository worksets · Docs — Threadnote" />');
    expect(rendered).toContain('<meta property="og:type" content="article" />');
    expect(rendered).toContain('<meta property="og:url" content="https://threadnote.io/docs/worksets/" />');
    expect(rendered).toContain(`content="${worksets!.summary}"`);
    expect(renderedSitemap).toContain('<loc>https://threadnote.io/docs/worksets/</loc>');
    expect(renderDocsSitemap(renderedSitemap, [worksets!])).toBe(renderedSitemap);
  });

  it("keeps the What's New root image aligned with the newest post for arbitrary timelines", async () => {
    const template = await readFile(join(root, 'apps', 'website', 'whats-new', 'index.html'), 'utf8');
    const publicationOffsets = fc.uniqueArray(fc.integer({min: 0, max: 31_536_000}), {
      maxLength: 8,
      minLength: 1,
    });

    fc.assert(
      fc.property(publicationOffsets, offsets => {
        const posts = offsets.map(offset => ({
          author: 'Threadnote',
          body: 'A generated article body.',
          highlights: ['A generated highlight'],
          kind: 'article' as const,
          publishedAt: new Date(Date.UTC(2026, 0, 1) + offset * 1_000).toISOString(),
          slug: `generated-${offset}`,
          socialImage: `generated-${offset}.png`,
          socialImageAlt: `Generated article ${offset}`,
          summary: `Generated summary ${offset}.`,
          title: `Generated article ${offset}`,
        }));
        const latestOffset = Math.max(...offsets);
        const latestImageUrl = `https://threadnote.io/generated-${latestOffset}.png`;
        const rendered = renderWhatsNewIndexHtml(template, posts);

        expect(rendered).toContain(`<meta property="og:image" content="${latestImageUrl}" />`);
        expect(rendered).toContain(`<meta name="twitter:image" content="${latestImageUrl}" />`);
        expect(rendered).toContain(`"image":"${latestImageUrl}"`);
        for (const olderOffset of offsets.filter(offset => offset !== latestOffset)) {
          expect(rendered).not.toContain(`https://threadnote.io/generated-${olderOffset}.png`);
        }
      }),
      {numRuns: 100},
    );
  });

  it('maps every valid authored article image to exact crawler metadata', async () => {
    const template = await readFile(join(root, 'apps', 'website', 'whats-new', 'index.html'), 'utf8');
    const article = parseWebsiteArticle(
      '2026-08-26T14-30-00Z--evidence-before-rewrites.md',
      `---
author: Denys Kashkovskyi
publishedAt: 2026-08-26T14:30:00Z
slug: evidence-before-rewrites
summary: An evidence-led engineering story.
title: Evidence before rewrites
---

Measure the system before changing its implementation language.
`,
    );
    const imageStem = fc
      .array(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789'), {minLength: 1, maxLength: 24})
      .map(characters => characters.join(''));

    fc.assert(
      fc.property(imageStem, stem => {
        const socialImage = `${stem}-article-card.png`;
        const socialImageAlt = `Evidence card ${stem}`;
        const rendered = renderWebsitePostHtml(template, {...article, socialImage, socialImageAlt});

        expect(rendered).toContain(`<meta property="og:image" content="https://threadnote.io/${socialImage}" />`);
        expect(rendered).toContain(`<meta name="twitter:image" content="https://threadnote.io/${socialImage}" />`);
        expect(rendered).toContain(`<meta property="og:image:alt" content="${socialImageAlt}" />`);
        expect(rendered).toContain(`"image":"https://threadnote.io/${socialImage}"`);
        expect(rendered).not.toContain('whats-new-og.png');
      }),
      {numRuns: 100},
    );
  });

  it('binds exact v4.3.8 evidence and never substitutes retired performance studies', async () => {
    const [performancePage, landingPage, viteConfig, retainedArtifactBytes, retainedBindingBytes] = await Promise.all([
      readFile(join(root, 'apps', 'website', 'src', 'pages', 'PerformancePage.tsx'), 'utf8'),
      readFile(join(root, 'apps', 'website', 'src', 'pages', 'LandingPage.tsx'), 'utf8'),
      readFile(join(root, 'apps', 'website', 'vite.config.ts'), 'utf8'),
      readFile(join(root, 'apps', 'website', 'public', 'performance-evidence.json')),
      readFile(join(root, 'apps', 'website', 'performance', 'evidence.binding.json'), 'utf8'),
    ]);
    const retainedArtifactInput = JSON.parse(retainedArtifactBytes.toString('utf8')) as {
      environment: {commit: string; dirty: boolean};
      metadata: {releaseEvidenceRef: string; releaseEvidenceSha: string; releaseEvidenceSourceMode: string};
      measurements: Array<{name: string; p50: number}>;
    };
    const retainedArtifact = validateRetainedPerformancePayload(retainedArtifactInput);
    const retainedBinding = JSON.parse(retainedBindingBytes) as {
      artifactSha256: string;
      sourceThreadnoteCommit: string;
    };
    const measurement = (name: string) => {
      const matches = retainedArtifact.measurements.filter(candidate => candidate.name === name);
      expect(matches).toHaveLength(1);
      return matches[0].p50;
    };

    expect(retainedArtifact).toMatchObject({
      environment: {commit: retainedBinding.sourceThreadnoteCommit, dirty: false},
      metadata: {
        releaseEvidenceRef: 'refs/tags/v4.3.8',
        releaseEvidenceSha: retainedBinding.sourceThreadnoteCommit,
        releaseEvidenceSourceMode: 'exact-release',
      },
    });
    expect(retainedBinding.sourceThreadnoteCommit).toBe('f1e4102a78e4df2127fca0c4d59da39ffb5f70a6');
    expect(retainedBinding.artifactSha256).toBe('b56994fe99c3d68be80f79315b88d4420a7241a76de72c317d2fc3d84de23b39');
    expect(sha256Hex(retainedArtifactBytes)).toBe(retainedBinding.artifactSha256);
    expect(measurement('cold-index')).toBe(3_426_563.136875);
    expect(measurement('one-file-reindex-index')).toBe(10_748.486666);
    expect(measurement('one-file-reindex-registration-lock-and-database-setup')).toBe(4_851.893916);
    expect(measurement('one-file-reindex-post-committed-scan-overlay-and-workspace')).toBe(53.179375);

    expect(performancePage).toContain('Current evidence pending');
    expect(performancePage).toContain('Historical observations are not');
    expect(performancePage).toContain('rather than falling back to results from an older release');
    expect(performancePage).toContain('The release-run adapter verified all');
    expect(performancePage).toContain('source-mismatched evidence');
    expect(performancePage).toContain('{artifact.source.threadnote.version} release commit');
    expect(performancePage).not.toContain('v4.3.1 release commit');
    expect(performancePage).not.toContain('Historical tuning study');
    expect(performancePage).not.toContain('Historical worktree study');
    expect(performancePage).not.toContain('checkedInPerformanceEvidence');
    expect(performancePage).not.toMatch(/4\.0\.1|4\.2\.5/);
    expect(performancePage).not.toContain('Threadnote 4.2.5 candidate evidence');
    expect(performancePage).not.toContain('Measured in Threadnote 4.0.1');
    expect(performancePage).toContain('Evidence discipline');
    expect(performancePage).toContain('v4.3.4 observation 1');
    expect(performancePage).toContain('v4.3.4 observation 2');
    expect(performancePage).toContain('Registration open by 212 ms');
    expect(performancePage).toContain('Registration open by 191 ms');
    expect(performancePage).toContain('v4.3.5 observation 1');
    expect(performancePage).toContain('Registration open by 234 ms');
    expect(performancePage).toContain('v4.3.6 observation 1');
    expect(performancePage).toContain('Registration open by 178 ms');
    expect(performancePage).toContain('v4.3.7 observation 1');
    expect(performancePage).toContain('Registration open by 255 ms');
    expect(performancePage).toContain('All four targets passed');
    expect(performancePage).toContain('no unchanged run');
    expect(performancePage).toContain('Correctness held while diagnosis narrowed');
    expect(performancePage).toContain('Final closure stays pending until the exact release adapter verifies');
    expect(performancePage).toContain('only the final v4.3.8 artifact is publicly bound on this page');
    expect(performancePage).toContain('Exact-current graph query p95');
    expect(performancePage).toContain('Includes exact Git/worktree observation');
    expect(performancePage).toContain('git status --porcelain');
    expect(performancePage).toContain('the four headline target');
    expect(performancePage).toContain('c25e1dc8cdbc96e5aa0e4803f37bc949e9b4220e109ecf0245171471d5f8bc9d');
    expect(performancePage).toContain('0f3ba956f491d4de39d81101ddfaae029eb097146cea29ce3f848f69bbf79fad');
    expect(performancePage).toContain('cc337e8778eb8e2d0590b995f43985f21f6da3ec50ec2bdb53d201cbce1110f7');
    expect(performancePage).toContain('731f8694ac4e4617601ba814dacba7d95729ad32a7537c7dea1bfd2d7efcd569');
    expect(performancePage).toContain('899faf6380b2fb6a69078b5cd79837451453be02541df4956854da1df6414a97');
    expect(performancePage).toContain("siteHref('performance/graphify/')");
    expect(performancePage).toContain('Compare with Graphify');
    expect(landingPage).toContain("siteHref('performance/')");
    expect(landingPage).toContain('Performance evidence');
    expect(landingPage).not.toMatch(/13\.2×|9\.9×|Threadnote 4\.0\.1/);
    expect(viteConfig).not.toMatch(
      /worktreeReadiness|embeddingContextPerformance|threadnote-4\.0\.1|threadnote-4\.2\.5/,
    );
    expect(viteConfig).toContain('performance-evidence.${evidence.artifact.artifact.sha256}.json');
    expect(viteConfig).toContain('performanceArtifactText');
    expect(landingPage).not.toMatch(/values stay visibly pending|retained artifact is complete/i);
  });

  it('keeps the current route until a page chunk is ready and retries failed prefetches', async () => {
    let resolveDocs: ((value: string) => void) | undefined;
    const deferredDocs = new Promise<string>(resolve => {
      resolveDocs = resolve;
    });
    const loaders = Object.fromEntries(
      (
        [
          'home',
          'performance',
          'performance-graphify',
          'docs',
          'agents',
          'whats-new',
          'pro-tips',
          'manager-demo',
          'faq',
        ] as const
      ).map(page => [page, page === 'docs' ? () => deferredDocs : async () => page]),
    ) as Record<SitePage, () => Promise<string>>;
    const cache = createSitePageModuleCache(loaders);
    let currentRoute = 'home';
    const navigation = commitPreparedRoute(
      () => cache.load('docs'),
      () => true,
      prepared => {
        currentRoute = prepared;
      },
    );

    expect(currentRoute).toBe('home');
    resolveDocs?.('docs');
    await expect(navigation).resolves.toBe(true);
    expect(currentRoute).toBe('docs');

    let faqAttempts = 0;
    const retryingCache = createSitePageModuleCache({
      ...loaders,
      faq: async () => {
        faqAttempts += 1;
        if (faqAttempts === 1) throw TestError.make({message: 'transient chunk failure'});
        return 'faq';
      },
    });
    await expect(retryingCache.prefetch('faq')).resolves.toBeUndefined();
    await expect(retryingCache.load('faq')).resolves.toBe('faq');
    expect(faqAttempts).toBe(2);
  });

  it('binds verified performance evidence to exact local bytes and source', () => {
    const artifactBytes = fixtureBytes(verifiedPerformanceFixture());
    const evidence = bindRetainedPerformanceArtifact({
      artifactBytes,
      artifactPublicUrl: performanceArtifactPublicUrl('/'),
      binding: fixtureBinding(artifactBytes),
      currentLockfileSha256: fixtureLockfileSha256,
      currentPackageManifestSha256: fixturePackageManifestSha256,
      currentSourceTreeSha256: 'f'.repeat(64),
    });

    expect(evidence).toMatchObject({
      state: 'verified',
      artifact: {
        artifact: {
          url: '/performance-evidence.json',
          sha256: sha256Hex(artifactBytes),
          generatedAt: '2026-08-02T20:00:00Z',
        },
        source: {threadnote: {commit: 'b'.repeat(40), version: 'v4.3.1'}},
        phases: {
          incremental: {
            attributionContextFiles: 1,
            baseFactsLoaded: 1,
            changedFiles: 1,
            deletedFiles: 0,
            factBytes: 1_200,
            inventoryFilesInspected: 1,
            plannedRows: 12,
            postCommittedScanMilliseconds: 20,
            probedDependencyPaths: 2,
            registrationMilliseconds: 80,
            sourceBytes: 500,
            totalFiles: 90,
            totalMilliseconds: 300,
          },
        },
        graph: {referenceCandidates: 700},
      },
    });
  });

  it('derives every supported Threadnote 4 release version from exact release provenance', () => {
    fc.assert(
      fc.property(
        fc.record({
          channel: fc.option(fc.constantFrom('beta', 'rc'), {nil: undefined}),
          channelVersion: fc.integer({max: 99, min: 0}),
          minor: fc.integer({max: 99, min: 0}),
          patch: fc.integer({max: 99, min: 0}),
        }),
        ({channel, channelVersion, minor, patch}) => {
          const version = `4.${minor}.${patch}${channel === undefined ? '' : `-${channel}.${channelVersion}`}`;
          const fixture = verifiedPerformanceFixture();
          const sourceCommit = String((fixture.environment as Record<string, unknown>).commit);
          (fixture.metadata as Record<string, unknown>).releaseEvidenceRef = `refs/tags/v${version}`;
          (fixture.metadata as Record<string, unknown>).benchmarkValidatedManagedVersion =
            `${version}-local.g${sourceCommit}`;
          const artifactBytes = fixtureBytes(fixture);
          const evidence = bindRetainedPerformanceArtifact({
            artifactBytes,
            artifactPublicUrl: performanceArtifactPublicUrl('/'),
            binding: fixtureBinding(artifactBytes),
            currentLockfileSha256: fixtureLockfileSha256,
            currentPackageManifestSha256: fixturePackageManifestSha256,
            currentSourceTreeSha256: 'f'.repeat(64),
          });

          expect(evidence.state).toBe('verified');
          if (evidence.state === 'verified') expect(evidence.artifact.source.threadnote.version).toBe(`v${version}`);
        },
      ),
      {numRuns: 50},
    );
  });

  it('classifies every retained performance target at its exclusive boundary', () => {
    const targets = [
      ['cold-index', 60 * 60_000],
      ['one-file-reindex-index', 30_000],
      ['one-file-reindex-registration-lock-and-database-setup', 5_000],
      ['one-file-reindex-post-committed-scan-overlay-and-workspace', 5_000],
    ] as const;
    fc.assert(
      fc.property(fc.constantFrom(...targets), fc.integer({min: -1_000, max: 1_000}), ([name, limit], delta) => {
        const fixture = verifiedPerformanceFixture();
        const measurement = (fixture.measurements as Record<string, unknown>[]).find(row => row.name === name);
        if (measurement === undefined) throw TestError.make({message: `Missing fixture measurement ${name}.`});
        const observed = limit + delta;
        for (const field of ['maximum', 'mean', 'minimum', 'p50', 'p95', 'p99'] as const) {
          measurement[field] = observed;
        }
        const artifactBytes = fixtureBytes(fixture);
        const evidence = bindRetainedPerformanceArtifact({
          artifactBytes,
          artifactPublicUrl: performanceArtifactPublicUrl('/'),
          binding: fixtureBinding(artifactBytes),
          currentLockfileSha256: fixtureLockfileSha256,
          currentPackageManifestSha256: fixturePackageManifestSha256,
          currentSourceTreeSha256: 'f'.repeat(64),
        });
        expect(evidence.state).toBe('verified');
        if (evidence.state !== 'verified') return;
        const objective = retainedPerformanceObjectiveResults(evidence.artifact).find(
          candidate => candidate.measurement === name,
        );
        expect(objective).toMatchObject({
          observedMilliseconds: observed,
          passed: observed < limit,
          targetMilliseconds: limit,
        });
      }),
      {numRuns: 100},
    );
  });

  it('rejects one-file evidence whose assessed work expands to the whole repository', () => {
    for (const name of [
      'one-file-reindex-incremental-work-attribution-context-files-n1',
      'one-file-reindex-incremental-work-base-facts-loaded-n1',
      'one-file-reindex-incremental-work-inventory-files-inspected-n1',
      'one-file-reindex-incremental-work-probed-dependency-paths-n1',
    ] as const) {
      const fixture = verifiedPerformanceFixture();
      const measurement = (fixture.measurements as Record<string, unknown>[]).find(row => row.name === name);
      if (measurement === undefined) throw TestError.make({message: `Missing fixture measurement ${name}.`});
      for (const field of ['maximum', 'mean', 'minimum', 'p50', 'p95', 'p99'] as const) measurement[field] = 90;
      const artifactBytes = fixtureBytes(fixture);

      expect(() =>
        bindRetainedPerformanceArtifact({
          artifactBytes,
          artifactPublicUrl: performanceArtifactPublicUrl('/'),
          binding: fixtureBinding(artifactBytes),
          currentLockfileSha256: fixtureLockfileSha256,
          currentPackageManifestSha256: fixturePackageManifestSha256,
          currentSourceTreeSha256: 'f'.repeat(64),
        }),
      ).toThrow('Performance evidence one-file work must remain below a repository-wide scan.');
    }
  });

  it('retains zero dependency probes for a body-only one-file edit', () => {
    const fixture = verifiedPerformanceFixture();
    const measurement = (fixture.measurements as Record<string, unknown>[]).find(
      row => row.name === 'one-file-reindex-incremental-work-probed-dependency-paths-n1',
    );
    if (measurement === undefined) throw TestError.make({message: 'Missing dependency-probe fixture measurement.'});
    for (const field of ['maximum', 'mean', 'minimum', 'p50', 'p95', 'p99'] as const) measurement[field] = 0;
    const artifactBytes = fixtureBytes(fixture);
    const evidence = bindRetainedPerformanceArtifact({
      artifactBytes,
      artifactPublicUrl: performanceArtifactPublicUrl('/'),
      binding: fixtureBinding(artifactBytes),
      currentLockfileSha256: fixtureLockfileSha256,
      currentPackageManifestSha256: fixturePackageManifestSha256,
      currentSourceTreeSha256: 'f'.repeat(64),
    });

    expect(evidence.state).toBe('verified');
    if (evidence.state === 'verified') {
      expect(evidence.artifact.phases.incremental.probedDependencyPaths).toBe(0);
    }
  });

  it('projects canonical Threadnote 5 release provenance into retained website evidence', () => {
    const fixture = verifiedPerformanceFixture();
    const metadata = fixture.metadata as Record<string, unknown>;
    const commit = (fixture.environment as Record<string, unknown>).commit;
    metadata.releaseEvidenceRef = 'refs/tags/v5.0.2';
    metadata.benchmarkValidatedManagedVersion = `5.0.2-local.g${commit}`;
    const artifactBytes = fixtureBytes(fixture);
    const evidence = bindRetainedPerformanceArtifact({
      artifactBytes,
      artifactPublicUrl: performanceArtifactPublicUrl('/'),
      binding: fixtureBinding(artifactBytes),
      currentLockfileSha256: fixtureLockfileSha256,
      currentPackageManifestSha256: fixturePackageManifestSha256,
      currentSourceTreeSha256: 'f'.repeat(64),
    });

    expect(evidence.state).toBe('verified');
    if (evidence.state === 'verified') {
      expect(evidence.artifact.source.threadnote.version).toBe('v5.0.2');
    }
  });

  it('keeps harness and website validation fail-closed under the same adversarial mutations', () => {
    const mutations: readonly [string, (fixture: Record<string, unknown>) => void][] = [
      [
        'MCP output',
        fixture => {
          fixture.measurements = (fixture.measurements as Record<string, unknown>[]).filter(
            measurement => measurement.name !== 'mcp-path-text-output',
          );
        },
      ],
      [
        'sampler observation',
        fixture => {
          fixture.measurements = (fixture.measurements as Record<string, unknown>[]).filter(
            measurement => measurement.name !== 'cold-external-storage-samples-n1',
          );
        },
      ],
      [
        'activation observation',
        fixture => {
          fixture.measurements = (fixture.measurements as Record<string, unknown>[]).filter(
            measurement => measurement.name !== 'cold-activation-committing-snapshot-observed-n1',
          );
        },
      ],
      [
        'unknown metadata',
        fixture => {
          (fixture.metadata as Record<string, unknown>).privateRepositoryRoot = '/private/repository';
        },
      ],
      [
        'credential metadata',
        fixture => {
          (fixture.metadata as Record<string, unknown>).runnerIdentity = 'token=github_pat_example';
        },
      ],
      [
        'pre-Threadnote-4 release tag',
        fixture => {
          (fixture.metadata as Record<string, unknown>).releaseEvidenceRef = 'refs/tags/v3.9.9';
        },
      ],
      [
        'local-path metadata',
        fixture => {
          (fixture.metadata as Record<string, unknown>).runnerIdentity = '/Users/private/runner';
        },
      ],
      [
        'insufficient p95 samples',
        fixture => {
          const measurement = (fixture.measurements as Record<string, unknown>[]).find(
            candidate => candidate.name === 'manager-bounded-query',
          )!;
          measurement.samples = 24;
        },
      ],
      ['insufficient warmups', fixture => void (fixture.warmups = 4)],
    ];
    for (const [label, mutate] of mutations) {
      const fixture = structuredClone(verifiedPerformanceFixture());
      mutate(fixture);
      for (const validate of [
        (input: unknown) => validateRetainedExternalPerformanceEvidence(input as BenchmarkArtifactV1),
        validateRetainedPerformancePayload,
      ]) {
        expect(() => validate(fixture), label).toThrow();
      }
    }
  });

  it('rejects retained artifact tampering and a wrong bound SHA-256', () => {
    const artifactBytes = fixtureBytes(verifiedPerformanceFixture());
    const binding = fixtureBinding(artifactBytes);
    const tamperedBytes = new Uint8Array([...artifactBytes, 10]);

    expect(() =>
      bindRetainedPerformanceArtifact({
        artifactBytes: tamperedBytes,
        artifactPublicUrl: performanceArtifactPublicUrl('/'),
        binding,
        currentLockfileSha256: fixtureLockfileSha256,
        currentPackageManifestSha256: fixturePackageManifestSha256,
        currentSourceTreeSha256: 'f'.repeat(64),
      }),
    ).toThrow('artifact SHA-256 mismatch');
    expect(() =>
      bindRetainedPerformanceArtifact({
        artifactBytes,
        artifactPublicUrl: performanceArtifactPublicUrl('/'),
        binding: fixtureBinding(artifactBytes, {artifactSha256: '0'.repeat(64)}),
        currentLockfileSha256: fixtureLockfileSha256,
        currentPackageManifestSha256: fixturePackageManifestSha256,
        currentSourceTreeSha256: 'f'.repeat(64),
      }),
    ).toThrow('artifact SHA-256 mismatch');
  });

  it('rejects sensitive or machine-local public control evidence at the site binder', () => {
    for (const [field, value] of [
      ['query', `ghp_${'a'.repeat(24)}`],
      ['query', `sk-proj_${'b'.repeat(24)}`],
      ['path', '/Users/example/private.ts'],
      ['path', '/home/example/private.ts'],
      ['path', '/mnt/c/Users/example/private.ts'],
      ['path', '/c/Users/example/private.ts'],
      ['path', 'C:\\Users\\example\\private.ts'],
      ['path', '\\\\server\\share\\private.ts'],
      ['path', '../outside/private.ts'],
    ] as const) {
      const fixture = verifiedPerformanceFixture();
      const metadata = fixture.metadata as Record<string, unknown>;
      const controls = JSON.parse(String(metadata.externalControlEvidence)) as Record<string, Record<string, string>>;
      controls.java = {...controls.java, [field]: value};
      metadata.externalControlEvidence = JSON.stringify(controls);
      const artifactBytes = fixtureBytes(fixture);

      expect(() =>
        bindRetainedPerformanceArtifact({
          artifactBytes,
          artifactPublicUrl: performanceArtifactPublicUrl('/'),
          binding: fixtureBinding(artifactBytes),
          currentLockfileSha256: fixtureLockfileSha256,
          currentPackageManifestSha256: fixturePackageManifestSha256,
          currentSourceTreeSha256: 'f'.repeat(64),
        }),
      ).toThrow(/privacy-safe|repository-relative/);
    }
  });

  it('rejects evidence bound to the wrong source commit or source tree', () => {
    const artifactBytes = fixtureBytes(verifiedPerformanceFixture());

    expect(() =>
      bindRetainedPerformanceArtifact({
        artifactBytes,
        artifactPublicUrl: performanceArtifactPublicUrl('/'),
        binding: fixtureBinding(artifactBytes, {sourceThreadnoteCommit: '9'.repeat(40)}),
        currentLockfileSha256: fixtureLockfileSha256,
        currentPackageManifestSha256: fixturePackageManifestSha256,
        currentSourceTreeSha256: 'f'.repeat(64),
      }),
    ).toThrow('different Threadnote source commits');
    expect(() =>
      bindRetainedPerformanceArtifact({
        artifactBytes,
        artifactPublicUrl: performanceArtifactPublicUrl('/'),
        binding: fixtureBinding(artifactBytes),
        currentLockfileSha256: fixtureLockfileSha256,
        currentPackageManifestSha256: fixturePackageManifestSha256,
        currentSourceTreeSha256: '8'.repeat(64),
      }),
    ).toThrow('does not match its measured Threadnote source tree');
  });

  it('rejects partial, extra, and mixed retained result payloads', () => {
    const partial = verifiedPerformanceFixture();
    delete partial.environment;
    const partialBytes = fixtureBytes(partial);
    expect(() =>
      bindRetainedPerformanceArtifact({
        artifactBytes: partialBytes,
        artifactPublicUrl: performanceArtifactPublicUrl('/'),
        binding: fixtureBinding(partialBytes),
        currentLockfileSha256: fixtureLockfileSha256,
        currentPackageManifestSha256: fixturePackageManifestSha256,
        currentSourceTreeSha256: 'f'.repeat(64),
      }),
    ).toThrow('Missing key');

    const extra = verifiedPerformanceFixture();
    extra.unreviewedResult = 42;
    const extraBytes = fixtureBytes(extra);
    expect(() =>
      bindRetainedPerformanceArtifact({
        artifactBytes: extraBytes,
        artifactPublicUrl: performanceArtifactPublicUrl('/'),
        binding: fixtureBinding(extraBytes),
        currentLockfileSha256: fixtureLockfileSha256,
        currentPackageManifestSha256: fixturePackageManifestSha256,
        currentSourceTreeSha256: 'f'.repeat(64),
      }),
    ).toThrow('unexpected or missing fields');

    const mismatched = verifiedPerformanceFixture();
    const metadata = mismatched.metadata as Record<string, unknown>;
    metadata.structuralGraphDigestSameOverlayReference = '0'.repeat(64);
    const mismatchedBytes = fixtureBytes(mismatched);
    expect(() =>
      bindRetainedPerformanceArtifact({
        artifactBytes: mismatchedBytes,
        artifactPublicUrl: performanceArtifactPublicUrl('/'),
        binding: fixtureBinding(mismatchedBytes),
        currentLockfileSha256: fixtureLockfileSha256,
        currentPackageManifestSha256: fixturePackageManifestSha256,
        currentSourceTreeSha256: 'f'.repeat(64),
      }),
    ).toThrow('overlay digests must match');
  });

  it('rejects fabricated, mixed-runtime, and separately supplied Manager evidence', () => {
    const githubMode = verifiedPerformanceFixture();
    (githubMode.metadata as Record<string, unknown>).benchmarkSourceValidationMode = 'github-actions-clean-source';
    const githubBytes = fixtureBytes(githubMode);
    expect(() =>
      bindRetainedPerformanceArtifact({
        artifactBytes: githubBytes,
        artifactPublicUrl: performanceArtifactPublicUrl('/'),
        binding: fixtureBinding(githubBytes),
        currentLockfileSha256: fixtureLockfileSha256,
        currentPackageManifestSha256: fixturePackageManifestSha256,
        currentSourceTreeSha256: 'f'.repeat(64),
      }),
    ).toThrow('managed-payload-exact-head-validated');

    const missingRuntimeHash = verifiedPerformanceFixture();
    delete (missingRuntimeHash.metadata as Record<string, unknown>).benchmarkValidatedManagedExecutableSha256;
    const runtimeBytes = fixtureBytes(missingRuntimeHash);
    expect(() =>
      bindRetainedPerformanceArtifact({
        artifactBytes: runtimeBytes,
        artifactPublicUrl: performanceArtifactPublicUrl('/'),
        binding: fixtureBinding(runtimeBytes),
        currentLockfileSha256: fixtureLockfileSha256,
        currentPackageManifestSha256: fixturePackageManifestSha256,
        currentSourceTreeSha256: 'f'.repeat(64),
      }),
    ).toThrow('benchmarkValidatedManagedExecutableSha256');

    for (const [label, mutate] of [
      [
        'dirty source',
        (fixture: Record<string, unknown>) => {
          (fixture.environment as Record<string, unknown>).dirty = true;
        },
      ],
      [
        'dependency installation',
        (fixture: Record<string, unknown>) => {
          (fixture.metadata as Record<string, unknown>).benchmarkValidatedManagedDependencyInstallation = 'bun install';
        },
      ],
      [
        'payload manifest hash',
        (fixture: Record<string, unknown>) => {
          delete (fixture.metadata as Record<string, unknown>).benchmarkValidatedManagedPayloadManifestSha256;
        },
      ],
      [
        'release metadata hash',
        (fixture: Record<string, unknown>) => {
          delete (fixture.metadata as Record<string, unknown>).benchmarkValidatedManagedReleaseMetadataSha256;
        },
      ],
      [
        'runtime target',
        (fixture: Record<string, unknown>) => {
          (fixture.metadata as Record<string, unknown>).benchmarkValidatedManagedTarget = 'linux-x64';
        },
      ],
    ] as const) {
      const fixture = verifiedPerformanceFixture();
      mutate(fixture);
      const bytes = fixtureBytes(fixture);
      expect(
        () =>
          bindRetainedPerformanceArtifact({
            artifactBytes: bytes,
            artifactPublicUrl: performanceArtifactPublicUrl('/'),
            binding: fixtureBinding(bytes),
            currentLockfileSha256: fixtureLockfileSha256,
            currentPackageManifestSha256: fixturePackageManifestSha256,
            currentSourceTreeSha256: 'f'.repeat(64),
          }),
        label,
      ).toThrow();
    }

    const withoutManagerQuery = verifiedPerformanceFixture();
    withoutManagerQuery.measurements = (withoutManagerQuery.measurements as Record<string, unknown>[]).filter(
      measurement => measurement.name !== 'manager-bounded-query',
    );
    const managerBytes = fixtureBytes(withoutManagerQuery);
    expect(() =>
      bindRetainedPerformanceArtifact({
        artifactBytes: managerBytes,
        artifactPublicUrl: performanceArtifactPublicUrl('/'),
        binding: fixtureBinding(managerBytes),
        currentLockfileSha256: fixtureLockfileSha256,
        currentPackageManifestSha256: fixturePackageManifestSha256,
        currentSourceTreeSha256: 'f'.repeat(64),
      }),
    ).toThrow('manager-bounded-query');
  });

  it('cross-binds source dependency hashes and the configured site base', () => {
    const artifactBytes = fixtureBytes(verifiedPerformanceFixture());
    expect(performanceArtifactPublicUrl('/')).toBe('/performance-evidence.json');
    expect(performanceArtifactPublicUrl('/threadnote/')).toBe('/threadnote/performance-evidence.json');
    expect(() => performanceArtifactPublicUrl('/threadnote')).toThrow('THREADNOTE_SITE_BASE');
    expect(() => performanceArtifactPublicUrl('/../')).toThrow('THREADNOTE_SITE_BASE');
    expect(() => performanceArtifactPublicUrl('//')).toThrow('THREADNOTE_SITE_BASE');
    expect(() =>
      bindRetainedPerformanceArtifact({
        artifactBytes,
        artifactPublicUrl: performanceArtifactPublicUrl('/threadnote/'),
        binding: fixtureBinding(artifactBytes),
        currentLockfileSha256: '0'.repeat(64),
        currentPackageManifestSha256: fixturePackageManifestSha256,
        currentSourceTreeSha256: 'f'.repeat(64),
      }),
    ).toThrow('lockfile SHA-256');
    expect(() =>
      bindRetainedPerformanceArtifact({
        artifactBytes,
        artifactPublicUrl: performanceArtifactPublicUrl('/threadnote/'),
        binding: fixtureBinding(artifactBytes),
        currentLockfileSha256: fixtureLockfileSha256,
        currentPackageManifestSha256: '0'.repeat(64),
        currentSourceTreeSha256: 'f'.repeat(64),
      }),
    ).toThrow('package manifest SHA-256');
  });

  it('keeps the Performance page pending until bound evidence is emitted at build time', async () => {
    const [pageSource, evidenceSource] = await Promise.all([
      readFile(join(root, 'apps', 'website', 'src', 'pages', 'PerformancePage.tsx'), 'utf8'),
      readFile(join(root, 'packages', 'evidence', 'src', 'performance.ts'), 'utf8'),
    ]);

    expect(retainedPerformanceArtifactFieldPaths).toEqual(
      expect.arrayContaining([
        'artifact.url',
        'artifact.sha256',
        'artifact.generatedAt',
        'source.threadnote.version',
        'source.threadnote.commit',
        'source.threadnote.lockfileSha256',
        'source.threadnote.packageManifestSha256',
        'source.repository.commit',
        'runner.hardware',
        'runner.runtime.version',
        'runner.runtime.target',
        'runner.runtime.executionMode',
        'runner.runtime.executableSha256',
        'runner.runtime.payloadManifestSha256',
        'runner.runtime.releaseMetadataSha256',
        'runner.database.version',
        'inventory.languages.java',
        'inventory.languages.kotlin',
        'inventory.languages.typescript',
        'inventory.languages.bazel',
        'phases.cold.materializationMilliseconds',
        'phases.incremental.totalMilliseconds',
        'phases.incremental.registrationMilliseconds',
        'phases.incremental.postCommittedScanMilliseconds',
        'phases.incremental.attributionContextFiles',
        'phases.incremental.baseFactsLoaded',
        'phases.incremental.changedFiles',
        'phases.incremental.deletedFiles',
        'phases.incremental.factBytes',
        'phases.incremental.inventoryFilesInspected',
        'phases.incremental.plannedRows',
        'phases.incremental.probedDependencyPaths',
        'phases.incremental.sourceBytes',
        'phases.incremental.totalFiles',
        'phases.independentRebuild.totalMilliseconds',
        'queries.p95Milliseconds',
        'controls.java.stableNodeId',
        'controls.kotlin.stableNodeId',
        'controls.typescript.stableNodeId',
        'controls.bazel.stableNodeId',
        'parity.incrementalOverlayDigest',
        'parity.independentOverlayDigest',
        'storage.peakResidentBytes',
        'storage.peakWalBytes',
        'storage.peakTemporaryBytes',
        'storage.durableFilesystemGrowthBytes',
        'storage.peakJournalBytes',
        'manager.overviewColdMilliseconds',
        'manager.layoutPreparationProxyMilliseconds',
        'manager.queryP95Milliseconds',
        'manager.queryMaxPayloadBytes',
        'manager.requestCancellationPassed',
        'manager.snapshotBindingPassed',
        'manager.staleResponseRejectionPassed',
        'concurrency.simultaneousWorktrees',
      ]),
    );

    expect(pageSource).toContain('Large codebases are a normal case');
    expect(pageSource).toContain('Repository size is never an admission test');
    expect(pageSource).toContain('bounded parser worker pool');
    expect(pageSource).toContain('one backpressured SQLite writer');
    expect(pageSource).toContain('Graph responses stay deliberately bounded');
    expect(pageSource).toContain('provide explicit continuation');
    expect(pageSource).toContain('postCommittedScanMilliseconds');
    expect(pageSource).toContain('changed/fanout work from a repository-wide scan');
    expect(pageSource).toContain('plannedRows');
    expect(pageSource).toContain('sourceBytes');
    expect(pageSource).toContain('factBytes');
    expect(pageSource).toContain('Your agents will love it');
    expect(pageSource).not.toMatch(/232_750|2_658_990|7_308_099|33_285_996_544/);
    expect(evidenceSource).toContain('derives every displayed measurement and provenance field from this one artifact');
    expect(evidenceSource).not.toContain('export function validateBoundRetainedPerformanceArtifact');
  });

  it('documents explicit publishing, Cursor Marketplace, and supported hook boundaries', () => {
    const content = JSON.stringify(docsSections);
    const cursorPluginArticle = docsSections
      .flatMap(section => section.articles)
      .find(article => article.id === 'cursor-marketplace-plugin');

    expect(content).toContain('threadnote install-hooks claude --dry-run');
    expect(content).toContain('threadnote install-hooks codex --dry-run');
    expect(content).toContain('UserPromptSubmit');
    expect(content).toContain('THREADNOTE_CODEX_RESUME_PRELOAD=off');
    expect(content).toContain('threadnote share publish');
    expect(content).toContain('--preview');
    expect(content).toContain('selected vector generation');
    expect(cursorPluginArticle).toBeDefined();
    expect(JSON.stringify(cursorPluginArticle)).toContain('threadnote mcp-install cursor --apply');
    expect(JSON.stringify(cursorPluginArticle)).toContain('/add-plugin threadnote');
    expect(JSON.stringify(cursorPluginArticle)).toContain('https://cursor.com/marketplace/publish');
    expect(JSON.stringify(cursorPluginArticle)).toContain('never deletes it automatically');
    expect(content).toContain('Threadnote never injects a Cursor plugin under ~/.cursor/plugins/local');
    expect(content).not.toContain('Cursor, and Copilot rely on the user-level instructions Threadnote installs');
  });

  it('withholds Cursor organization setup until its live flow is verified', () => {
    const articles = docsSections.flatMap(section => section.articles);
    expect(articles.some(article => article.id === 'cursor-cloud-agents')).toBe(false);
    expect(JSON.stringify(articles)).not.toContain('Bootstrap Threadnote for a Cursor organization');
    expect(
      searchDocs(createDocsSearchIndex(docsSections), 'Cursor organization managed remote memory').some(
        result => result.article.id === 'cursor-cloud-agents',
      ),
    ).toBe(false);
  });

  it('documents the standalone Personal Cursor Cloud one-MCP multi-share setup', () => {
    const article = docsSections
      .flatMap(section => section.articles)
      .find(candidate => candidate.id === 'personal-cursor-cloud');
    const content = JSON.stringify(article);
    const mcpConfiguration = article?.body.find(
      block =>
        block.type === 'code' && block.language === 'json' && block.code.includes('THREADNOTE_CURSOR_CLOUD_TEAMS'),
    );
    const install = article?.body.find(
      block => block.type === 'code' && block.language === 'sh' && block.code.includes('cloud cursor bootstrap'),
    );

    expect(article?.title).toBe('Personal Cursor Cloud setup');
    expect(content).toContain('one personal stdio MCP');
    expect(content).toContain('up to 16');
    expect(content).toContain('create a new environment');
    expect(content).toContain('personal environment');
    expect(content).toContain('MCP dropdown');
    expect(content).toContain('Register exactly one Threadnote personal MCP');
    expect(content).toContain('one bootstrap command per Git repository');
    expect(content).toContain('Cursor 4.6');
    expect(content).toContain('does not copy the skills from your laptop');
    expect(content).toContain('Do not run `threadnote mcp-install cursor --apply`');
    expect(content).toContain('`remember_context requires team`');
    expect(content).not.toContain('Git beta');

    if (!mcpConfiguration || mcpConfiguration.type !== 'code') {
      throw TestError.make({message: 'Missing Personal Cursor Cloud MCP configuration.'});
    }
    expect(JSON.parse(mcpConfiguration.code)).toEqual({
      type: 'stdio',
      command: '/bin/sh',
      args: ['-lc', 'exec "$HOME/.local/bin/threadnote-mcp-server"'],
      env: {
        THREADNOTE_ACCOUNT: 'local',
        THREADNOTE_AGENT_ID: 'cursor-cloud',
        THREADNOTE_CURSOR_CLOUD_TEAM: 'docs',
        THREADNOTE_CURSOR_CLOUD_TEAMS: '["docs","personal"]',
        THREADNOTE_MCP_TOOLSET: 'cursor-cloud-personal',
        THREADNOTE_USER: 'cursor-cloud',
      },
    });
    if (!install || install.type !== 'code')
      throw TestError.make({message: 'Missing Personal Cursor Cloud install command.'});
    expect(install.code.match(/cloud cursor bootstrap/gu)).toHaveLength(2);
    expect(install.code).toContain('$HOME/.cursor/skills/threadnote-memory/SKILL.md');
    expect(
      searchDocs(createDocsSearchIndex(docsSections), 'personal Cursor Cloud multiple shares one MCP')[0]?.article.id,
    ).toBe('personal-cursor-cloud');
  });

  it('uses the real Manager labels and share status fields in the mock data', () => {
    expect(managerDemoTabs.map(tab => tab.label)).toEqual(['Graph', 'Library', 'Sharing', 'Health', 'Tools']);
    for (const share of managerDemoShares) {
      expect(share.name).toBe(share.label);
      expect(share.remote).not.toBe('');
      expect(share.worktree).not.toBe('');
      expect(share.gitdir).not.toBe('');
      expect(typeof share.default).toBe('boolean');
      expect(typeof share.dirty).toBe('boolean');
      expect(['two-way', 'publish', 'read-only']).not.toContain(share.direction);
    }
  });

  it('labels synthetic Manager data and publishes a parity-first Graphify performance subpage', async () => {
    const [
      managerSource,
      faqSource,
      graphifyPage,
      graphifyHtml,
      mainSource,
      shellSource,
      sitemap,
      evidenceSource,
      addressedEvidenceSource,
    ] = await Promise.all([
      readFile(join(root, 'apps', 'website', 'src', 'components', 'ManagerMock.tsx'), 'utf8'),
      readFile(join(root, 'apps', 'website', 'src', 'pages', 'FaqPage.tsx'), 'utf8'),
      readFile(join(root, 'apps', 'website', 'src', 'pages', 'GraphifyPerformancePage.tsx'), 'utf8'),
      readFile(join(root, 'apps', 'website', 'performance', 'graphify', 'index.html'), 'utf8'),
      readFile(join(root, 'apps', 'website', 'src', 'main.tsx'), 'utf8'),
      readFile(join(root, 'apps', 'website', 'src', 'components', 'SiteShell.tsx'), 'utf8'),
      readFile(join(root, 'apps', 'website', 'public', 'sitemap.xml'), 'utf8'),
      readFile(join(root, 'apps', 'website', 'public', 'graphify-intellij-evidence.json'), 'utf8'),
      readFile(
        join(
          root,
          'apps',
          'website',
          'public',
          'graphify-intellij-evidence.bd4686d2fce1fe369c73ac77ebe65604bcb3af6fb4564691d10dfb296aca61b1.json',
        ),
        'utf8',
      ),
    ]);
    const sharedCopy = JSON.stringify(graphifySharedCapabilities).toLowerCase();
    const differenceCopy = JSON.stringify(graphifyVerifiedDifferences).toLowerCase();

    expect(managerSource).toContain('Mock data — no local files read');
    expect(faqSource).not.toMatch(/Graphify|SHOW_GRAPHIFY_COMPARISON|comparisonOnly/);
    expect(faqSource).toContain('Will every new worktree rebuild its graph from scratch?');
    expect(faqSource).toContain('Agents never query partial rows from an unpromoted snapshot');
    expect(faqSource).toContain('optional vectors and whole-graph summaries finish in the background');

    expect(graphifyReviewedSource).toEqual({
      commit: '282976b2f4066b55cf2fa346c3d5568f7ac044e2',
      reviewedAt: '2026-08-25',
      version: 'v0.9.49',
      sourceUrl: 'https://github.com/Graphify-Labs/graphify/tree/282976b2f4066b55cf2fa346c3d5568f7ac044e2',
      packageUrl: 'https://pypi.org/project/graphifyy/0.9.49/',
    });
    for (const sharedTerm of [
      'communities',
      'hubs and god nodes',
      'surprising links',
      'confidence audits',
      'n-ary',
      'hyperedge-style',
      'reports',
      'json',
      'graphml',
      'html',
      'svg',
    ]) {
      expect(sharedCopy).toContain(sharedTerm);
      expect(differenceCopy).not.toContain(sharedTerm);
    }
    expect(graphifyPage).toContain('These are parity, not reasons to choose one');
    expect(graphifyPage).toContain('No graph after 5h 32m 40s');
    expect(graphifyPage).toContain('Right-censored artifact non-arrival');
    expect(graphifyPage).toContain('right-censored lower bound');
    expect(graphifyPage).toContain('both stay on deterministic local extraction and spend no provider tokens');
    expect(graphifyPage).toContain('still consumes local CPU or GPU, memory, and energy');
    expect(differenceCopy).toContain('installed local embedding model');
    expect(differenceCopy).toContain('without a hosted embedding service or provider-token spend');
    expect(differenceCopy).toContain('37 tree-sitter grammars');
    expect(differenceCopy).toContain('graphify_out');
    expect(differenceCopy).toContain('deliberately skip linked-worktree rebuilds');
    expect(differenceCopy).toContain('primary checkout');
    expect(graphifyPage).toContain('embedding model for semantic vector seeds');
    expect(graphifyPage).toContain('this structural timing arm');
    expect(graphifyPage).toContain('A graph file is not the finish line');
    expect(graphifyPage).toContain('default 512 MiB file guard had no artifact');
    expect(graphifyPage).toContain('hydrate nodes and links into NetworkX');
    expect(graphifyPage).toContain('Exact-symbol, natural structural, and affected-node controls remained unrun');
    expect(graphifyPage).toContain('does not claim Graphify could never finish on another machine');
    expect(graphifyPage).toContain('graphify extract . --code-only --no-cluster --timing --max-workers 4');
    expect(graphifyPage).toContain('formatInteger(artifact.inventory.indexedFiles)');
    expect(graphifyPage).toContain('exact v4.3.8 comparator artifact passes its source and digest');
    expect(graphifyPage).toContain('Graphify reported 191,249 code files');
    expect(graphifyPage).toContain('neither a completion-time nor a throughput');
    expect(graphifyPage).toContain('found no durable checkpoint');
    expect(graphifyPage).toContain(
      'graphify-intellij-evidence.bd4686d2fce1fe369c73ac77ebe65604bcb3af6fb4564691d10dfb296aca61b1.json',
    );
    expect(graphifyPage).toContain("performanceEvidence.state === 'verified'");
    expect(graphifyPage).toContain('verifiedArtifact?.source.threadnote.version === threadnoteComparator.version');
    expect(graphifyPage).toContain('20,309.960 CPU-seconds');
    expect(graphifyPage).toContain('Parent RSS was 12.1 GB immediately before termination');
    expect(graphifyPage).toContain('separately retained operator launcher');
    expect(graphifyPage).toContain('bound benchmark artifact does not serialize that field');
    expect(graphifyPage).not.toMatch(/Graphify-exclusive|Graphify only|Threadnote-exclusive|Threadnote only/);

    const graphifyEvidence = JSON.parse(evidenceSource) as {
      threadnoteComparator: {artifactSha256: string; commit: string; version: string};
    };
    expect(graphifyEvidence).toMatchObject({
      result: 'operator-terminated-right-censored-artifact-non-arrival',
      scope: {package: 'graphifyy', product: 'Graphify'},
      runner: {cpu: 'Apple M1 Max', pythonVersion: '3.12.5', workers: 4},
      run: {startedAt: '2026-08-25T11:40:45.238Z', completedAt: '2026-08-25T17:13:25.168Z'},
      threadnoteComparator: {
        artifactSha256: 'b56994fe99c3d68be80f79315b88d4420a7241a76de72c317d2fc3d84de23b39',
        commit: 'f1e4102a78e4df2127fca0c4d59da39ffb5f70a6',
        version: 'v4.3.8',
      },
      decision: {naturalTimeout: false, resourceCapTriggered: false, rightCensored: true},
      observations: {
        graphJsonExists: false,
        parentRssBytesBeforeTermination: 12_079_448_064,
        processTreeCpuMilliseconds: 20_309_960,
        queryabilityReached: false,
        swapGrowthBytesPeak: 0,
      },
      progress: {interruptStackFunction: 'disambiguate_ambiguous_candidates', interruptStackLine: 260},
      comparisonBoundary: {
        completionTimeRatioClaimed: false,
        graphifyDetectedCodeFiles: 191_249,
        threadnoteOperatorLauncherSha256: '3d8edfd86376f6aaaa9efbf3989cbcea5a02f414e82a653637c9b2eea061c9cd',
        threadnoteParserWorkerEvidence: 'separately-retained-operator-launcher',
        threadnoteParserWorkers: 4,
        threadnoteIndexedFiles: 225_852,
      },
      restartBoundary: {perFileAstCachePersisted: true, postParseResumeArtifactPersisted: false},
    });
    expect(graphifyPage).toContain(`artifactSha256: '${graphifyEvidence.threadnoteComparator.artifactSha256}'`);
    expect(graphifyPage).toContain(`commit: '${graphifyEvidence.threadnoteComparator.commit}'`);
    expect(graphifyPage).toContain(`version: '${graphifyEvidence.threadnoteComparator.version}'`);
    expect(addressedEvidenceSource).toBe(evidenceSource);
    expect(sha256Hex(evidenceSource)).toBe('bd4686d2fce1fe369c73ac77ebe65604bcb3af6fb4564691d10dfb296aca61b1');

    expect(graphifyHtml).toContain('<link rel="canonical" href="https://threadnote.io/performance/graphify/" />');
    expect(graphifyHtml).toContain('<body data-page="performance-graphify">');
    expect(mainSource).toContain("'performance-graphify': () => import('./pages/GraphifyPerformancePage')");
    expect(shellSource).toContain("['performance', 'performance-graphify']");
    expect(shellSource).toContain("siteHref('performance/graphify/')");
    expect(sitemap).toContain('<loc>https://threadnote.io/performance/graphify/</loc>');
  });

  it('documents the separate whole-graph analysis and corpus/export contracts', () => {
    const content = JSON.stringify(docsSections);
    const analysisTool = mcpTools.find(tool => tool.name === 'analyze_code_graph');

    expect(analysisTool).toMatchObject({toolset: 'core'});
    expect(analysisTool?.keyInputs).toContain(
      'operation: stats | communities | community | groups | hubs | surprises | confidence | full',
    );
    expect(content).toContain('analyze_code_graph');
    expect(content).toContain('threadnote graph communities');
    expect(content).toContain('threadnote graph community --community-id cgc_…');
    expect(content).toContain('threadnote graph groups');
    expect(content).toContain('threadnote graph confidence');
    expect(content).toContain('threadnote graph report --output architecture-report.md');
    expect(content).toContain('OpenXML, OpenDocument, and EPUB');
    expect(content).toContain('does not claim OCR, pixel understanding, or transcription');
    expect(content).toContain('64 MiB per-artifact source budget');
    expect(content).toContain('not repository or graph-size admission caps');
    expect(content).toContain('threadnote graph export --format graphml');
    expect(content).toContain('[Performance page](../performance/)');
    expect(content).toContain('graph-equivalent commit');
    expect(content).toContain('materializes changed, renamed, and deleted paths');
    expect(content).toContain('Agents cannot query partial rows from an unpromoted snapshot');
    expect(content).toContain('optional vector enrichment and whole-graph summaries continue in the background');
    expect(content).toContain('current headline claims to one exact-release large-repository artifact');
    expect(content).not.toContain('same-machine v4.0.1 worktree-readiness comparison');
    expect(JSON.stringify(proTips)).toContain('a graph-equivalent commit can reuse ready content');
  });

  it('keeps the docs Performance link inside a configured Pages subpath', () => {
    const content = JSON.stringify(docsSections);
    const relativeLink = content.match(/\[Performance page\]\(([^)]+)\)/)?.[1];

    expect(relativeLink).toBe('../performance/');
    expect(new URL(relativeLink ?? '', 'https://example.test/threadnote/docs/').pathname).toBe(
      '/threadnote/performance/',
    );
  });

  it('pins the Manager canvas to its stage without a resize feedback loop', async () => {
    const styles = await readFile(join(root, 'apps', 'website', 'src', 'styles.css'), 'utf8');

    expect(styles).toMatch(/\.manager-demo-graph-stage\s*{[^}]*min-height: 480px;/s);
    expect(styles).toMatch(/\.manager-demo-scene\s*{[^}]*position: absolute;[^}]*inset: 0;/s);
    expect(styles).toMatch(/\.manager-demo-scene-canvas\s*{[^}]*display: block;[^}]*height: 100%;/s);
    expect(styles).not.toContain('.manager-demo-graph-stage > div:first-child');
  });

  it('contains the landing hero and install command at narrow mobile widths', async () => {
    const styles = await readFile(join(root, 'apps', 'website', 'src', 'styles.css'), 'utf8');
    const tabletStart = styles.indexOf('@media (max-width: 980px)');
    const mobileStart = styles.indexOf('@media (max-width: 680px)', tabletStart);
    const tabletStyles = styles.slice(tabletStart, mobileStart);
    const mobileStyles = styles.slice(mobileStart);

    expect(styles).toMatch(/\.hero__copy\s*{[^}]*min-width: 0;/s);
    expect(styles).toMatch(/\.hero__visual\s*{[^}]*min-width: 0;/s);
    expect(tabletStyles).toMatch(/\.hero\s*{[^}]*grid-template-columns: minmax\(0, 1fr\);/s);
    expect(mobileStyles).toMatch(/\.hero__actions \.button\s*{[^}]*width: 100%;[^}]*min-width: 0;/s);
    expect(mobileStyles).toMatch(
      /\.hero__install code\s*{[^}]*width: 100%;[^}]*overflow-wrap: anywhere;[^}]*white-space: normal;/s,
    );
  });

  it('keeps the Pro Tips explorer contained at mobile widths', async () => {
    const styles = await readFile(join(root, 'apps', 'website', 'src', 'styles.css'), 'utf8');
    const tabletStart = styles.indexOf('@media (max-width: 980px)');
    const mobileStart = styles.indexOf('@media (max-width: 680px)', tabletStart);
    const tabletStyles = styles.slice(tabletStart, mobileStart);
    const mobileStyles = styles.slice(mobileStart);

    expect(styles).toMatch(/\.tips-layout\s*{[^}]*min-width: 0;/s);
    expect(styles).toMatch(/\.tips-index\s*{[^}]*min-width: 0;/s);
    expect(styles).toMatch(/\.tip-detail\s*{[^}]*min-width: 0;/s);
    expect(tabletStyles).toMatch(/\.tips-layout\s*{[^}]*grid-template-columns: minmax\(0, 1fr\);/s);
    expect(tabletStyles).toMatch(/\.tips-index\s*{[^}]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/s);
    expect(mobileStyles).toMatch(/\.tips-index\s*{[^}]*grid-template-columns: minmax\(0, 1fr\);/s);
  });

  it('wraps inline post code without disabling code-block or table scrolling', async () => {
    const styles = await readFile(join(root, 'apps', 'website', 'src', 'styles.css'), 'utf8');

    expect(styles).toMatch(
      /\.post-detail__body :not\(pre\) > code\s*{[^}]*overflow-wrap: anywhere;[^}]*word-break: break-word;/s,
    );
    expect(styles).toMatch(/\.post-detail__body pre\s*{[^}]*overflow-x: auto;/s);
    expect(styles).toMatch(/\.post-detail__body table\s*{[^}]*overflow-x: auto;/s);
  });

  it('keeps every explicit site text size at or above the shared 12px minimum', async () => {
    const styles = await readFile(join(root, 'apps', 'website', 'src', 'styles.css'), 'utf8');
    const explicitPixelSizes = [...styles.matchAll(/(?:font-size:\s*|font:\s*)(\d+(?:\.\d+)?)px/g)].map(match =>
      Number(match[1]),
    );

    expect(styles).toContain('--font-size-min: 12px;');
    expect(explicitPixelSizes.filter(size => size < 12)).toEqual([]);
  });

  it('stacks the worktree-readiness evidence without connector overflow on mobile', async () => {
    const styles = await readFile(join(root, 'apps', 'website', 'src', 'styles.css'), 'utf8');
    const tabletStart = styles.indexOf('@media (max-width: 980px)');
    const mobileStart = styles.indexOf('@media (max-width: 680px)', tabletStart);
    const tabletStyles = styles.slice(tabletStart, mobileStart);
    const mobileStyles = styles.slice(mobileStart);

    expect(tabletStart).toBeGreaterThan(-1);
    expect(mobileStart).toBeGreaterThan(tabletStart);
    expect(tabletStyles).toMatch(
      /\.performance-hero,\s*\.performance-worktrees,\s*\.performance-methodology\s*{[^}]*grid-template-columns: 1fr;/s,
    );
    expect(mobileStyles).toMatch(/\.performance-worktrees__branches\s*{[^}]*grid-template-columns: 1fr;/s);
    expect(mobileStyles).toMatch(
      /\.performance-worktrees__branches::before,\s*\.performance-worktrees__branches article::before,\s*\.performance-worktrees__base::after\s*{[^}]*display: none;/s,
    );
  });

  it('reveals the skip link only when it receives keyboard focus', async () => {
    const styles = await readFile(join(root, 'apps', 'website', 'src', 'styles.css'), 'utf8');

    expect(styles).toMatch(/\.skip-link\s*{[^}]*opacity: 0;[^}]*pointer-events: none;/s);
    expect(styles).toMatch(
      /\.skip-link:focus,\s*\.skip-link:focus-visible\s*{[^}]*opacity: 1;[^}]*pointer-events: auto;[^}]*transform: translateY\(0\);/s,
    );
  });

  it('collapses the footer before its six links can overflow narrow tablet widths', async () => {
    const styles = await readFile(join(root, 'apps', 'website', 'src', 'styles.css'), 'utf8');
    const tabletStart = styles.indexOf('@media (max-width: 760px)');
    const mobileStart = styles.indexOf('@media (max-width: 680px)', tabletStart);
    const tabletFooter = styles.slice(tabletStart, mobileStart);

    expect(tabletStart).toBeGreaterThan(-1);
    expect(mobileStart).toBeGreaterThan(tabletStart);
    expect(tabletFooter).toMatch(/\.site-footer\s*{[^}]*grid-template-columns: 1fr;/s);
    expect(tabletFooter).toMatch(/\.site-footer__links\s*{[^}]*grid-template-columns: repeat\(3, minmax\(0, 1fr\)\);/s);
  });

  it('includes a project-bound social card and Pages marker', async () => {
    await Promise.all([
      access(join(root, 'apps', 'website', 'public', 'og.png')),
      access(join(root, 'apps', 'website', 'public', '.nojekyll')),
    ]);
  });
});
