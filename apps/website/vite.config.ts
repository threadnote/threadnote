import react from '@vitejs/plugin-react';
import {defineConfig, type Plugin} from 'vite';
import {loadWebsiteArticles} from './tools/site-articles.js';
import {loadRetainedPerformanceEvidence} from './tools/site-performance-evidence.js';
import {loadLatestMajorWebsiteReleases} from './tools/site-release-notes.js';
import {loadPreparedWebsiteMetadataFromEnvironment} from './tools/site-prepared-metadata.js';

const repositoryRoot = process.cwd();
const siteRoot = `${repositoryRoot}/apps/website`;
const siteBase = process.env.THREADNOTE_SITE_BASE ?? '/';
const virtualEvidenceId = 'virtual:threadnote-performance-evidence';
const resolvedVirtualEvidenceId = `\0${virtualEvidenceId}`;
const virtualReleaseNotesId = 'virtual:threadnote-release-notes';
const resolvedVirtualReleaseNotesId = `\0${virtualReleaseNotesId}`;
const virtualLatestReleaseId = 'virtual:threadnote-latest-release';
const resolvedVirtualLatestReleaseId = `\0${virtualLatestReleaseId}`;
const virtualArticlesId = 'virtual:threadnote-articles';
const resolvedVirtualArticlesId = `\0${virtualArticlesId}`;
const preparedMetadata = loadPreparedWebsiteMetadataFromEnvironment(siteBase);
let cachedWebsiteData:
  | Promise<{
      readonly articles: Awaited<ReturnType<typeof loadWebsiteArticles>>;
      readonly releases: ReturnType<typeof loadLatestMajorWebsiteReleases>;
      readonly performanceEvidence: Awaited<ReturnType<typeof loadRetainedPerformanceEvidence>>;
      readonly performanceArtifactText: string | null;
    }>
  | undefined;

function loadWebsiteBuildData() {
  cachedWebsiteData ??= preparedMetadata.then(async prepared => {
    if (prepared) {
      return {
        articles: prepared.articles,
        releases: prepared.releases,
        performanceEvidence: prepared.performanceEvidence,
        performanceArtifactText: prepared.performanceArtifactText,
      };
    }
    const [articles, performanceEvidence] = await Promise.all([
      loadWebsiteArticles(repositoryRoot),
      loadRetainedPerformanceEvidence(repositoryRoot, siteBase),
    ]);
    return {
      articles,
      releases: loadLatestMajorWebsiteReleases(repositoryRoot),
      performanceEvidence,
      performanceArtifactText:
        performanceEvidence.state === 'verified'
          ? await Bun.file(`${repositoryRoot}/apps/website/public/performance-evidence.json`).text()
          : null,
    };
  });
  return cachedWebsiteData;
}

const performanceEvidencePlugin: Plugin = {
  name: 'threadnote-performance-evidence',
  resolveId(id: string) {
    return id === virtualEvidenceId ? resolvedVirtualEvidenceId : undefined;
  },
  async load(id: string) {
    if (id !== resolvedVirtualEvidenceId) return undefined;
    const {performanceEvidence: evidence} = await loadWebsiteBuildData();
    return `export default ${JSON.stringify(evidence)};`;
  },
  async generateBundle() {
    const {performanceEvidence: evidence, performanceArtifactText} = await loadWebsiteBuildData();
    if (evidence.state !== 'verified') return;
    if (!performanceArtifactText)
      throw new Error('Verified website performance evidence is missing its artifact text.');
    this.emitFile({
      fileName: `performance-evidence.${evidence.artifact.artifact.sha256}.json`,
      source: performanceArtifactText,
      type: 'asset',
    });
  },
};

const releaseNotesPlugin: Plugin = {
  name: 'threadnote-release-notes',
  resolveId(id: string) {
    if (id === virtualReleaseNotesId) return resolvedVirtualReleaseNotesId;
    if (id === virtualLatestReleaseId) return resolvedVirtualLatestReleaseId;
    return undefined;
  },
  async load(id: string) {
    if (id !== resolvedVirtualReleaseNotesId && id !== resolvedVirtualLatestReleaseId) return undefined;
    const {releases} = await loadWebsiteBuildData();
    if (id === resolvedVirtualReleaseNotesId) return `export default ${JSON.stringify(releases)};`;
    if (id === resolvedVirtualLatestReleaseId) {
      const latest = releases[0];
      const banner = latest === undefined ? undefined : {headline: latest.headline, version: latest.version};
      return `export default ${JSON.stringify(banner)};`;
    }
    return undefined;
  },
};

const articlesPlugin: Plugin = {
  name: 'threadnote-articles',
  resolveId(id: string) {
    return id === virtualArticlesId ? resolvedVirtualArticlesId : undefined;
  },
  async load(id: string) {
    if (id !== resolvedVirtualArticlesId) return undefined;
    const {articles} = await loadWebsiteBuildData();
    return `export default ${JSON.stringify(articles)};`;
  },
};

export default defineConfig({
  root: siteRoot,
  base: siteBase,
  plugins: [react(), performanceEvidencePlugin, releaseNotesPlugin, articlesPlugin],
  build: {
    outDir: `${repositoryRoot}/site-dist`,
    emptyOutDir: true,
    sourcemap: false,
    chunkSizeWarningLimit: 600,
    rollupOptions: {
      input: {
        home: `${siteRoot}/index.html`,
        performance: `${siteRoot}/performance/index.html`,
        performanceGraphify: `${siteRoot}/performance/graphify/index.html`,
        docs: `${siteRoot}/docs/index.html`,
        agents: `${siteRoot}/agents/index.html`,
        whatsNew: `${siteRoot}/whats-new/index.html`,
        proTips: `${siteRoot}/pro-tips/index.html`,
        faq: `${siteRoot}/faq/index.html`,
      },
    },
  },
});
