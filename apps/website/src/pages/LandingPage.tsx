import {lazy, Suspense} from 'react';
import articles from 'virtual:threadnote-articles';
import latestRelease from 'virtual:threadnote-latest-release';
import {AgentTrace} from '../components/AgentTrace';
import {CodeBlock} from '../components/CodeBlock';
import {Icon, type IconName} from '../components/Icons';
import {SiteShell} from '../components/SiteShell';
import {heroScenario} from '../content/landing';
import {
  docsArticleHref,
  githubUrl,
  setDocumentMeta,
  siteHref,
  whatsNewArticleHref,
  whatsNewReleaseHref,
} from '../lib/site';

const ThreadScene = lazy(() => import('../visuals/ThreadScene'));
const continuationStudySlug = 'graphmem-agent-continuation-study';

const features: Array<{
  icon: IconName;
  accent: string;
  label: string;
  title: string;
  body: string;
  detail: string;
}> = [
  {
    icon: 'memory',
    accent: 'teal',
    label: 'Context Brief',
    title: 'Give the agent a useful briefing before it starts.',
    body: 'A Context Brief is a short, cited summary of the decisions, open work, and code related to the task. It also shows what may be missing or out of date.',
    detail: 'Short · cited · current',
  },
  {
    icon: 'local',
    accent: 'teal',
    label: 'Knowledge Delta',
    title: 'Save the useful lesson, not the whole chat.',
    body: 'A Knowledge Delta is a short list of new decisions, checks, outdated notes, and open risks. You approve, edit, defer, or reject every item.',
    detail: 'You stay in control',
  },
  {
    icon: 'team',
    accent: 'blue',
    label: 'Cross-agent sharing',
    title: 'Reuse approved decisions in another coding agent.',
    body: 'Keep decisions private or share selected ones through Git. Your normal branch review and CODEOWNERS rules still apply.',
    detail: 'Git-backed · portable',
  },
  {
    icon: 'graph',
    accent: 'violet',
    label: 'Continuous health',
    title: 'See when saved context may no longer be true.',
    body: 'Threadnote checks code links, review dates, conflicting notes, and changed guidance. Repairs are previewed before anything is updated.',
    detail: 'Find · review · repair',
  },
  {
    icon: 'manager',
    accent: 'magenta',
    label: 'Verified procedures',
    title: 'Reuse team workflows without running mystery automation.',
    body: 'Procedures show their owner, version, dependencies, compatible agents, and verification. Threadnote previews them and never runs downloaded steps automatically.',
    detail: 'Reviewed · compatible · explicit',
  },
  {
    icon: 'obsidian',
    accent: 'amber',
    label: 'Private by default',
    title: 'Keep your code and saved context on your machine.',
    body: 'Threadnote stores local files, indexes, models, and code maps under your control. Only the decisions you explicitly share leave the machine.',
    detail: 'Local · offline-capable · explicit sharing',
  },
];

const workflow = [
  {
    number: '01',
    title: 'Connect one coding-agent environment',
    body: 'Choose one supported editor, CLI, or other catalog integration, preview its managed setup, and connect it.',
  },
  {
    number: '02',
    title: 'Start with a Context Brief',
    body: 'Give the connected agent a real task; its installed guidance automatically compiles a bounded brief with citations, freshness, and visible gaps.',
  },
  {
    number: '03',
    title: 'Verify the exact code you are changing',
    body: 'Use recalled context to get oriented, then check consequential claims against the current worktree.',
  },
  {
    number: '04',
    title: 'Review the Knowledge Delta',
    body: 'At meaningful closeout, the agent writes a private handoff and, when there is reusable knowledge, presents proposed decisions, constraints, verification, invalidations, and risks for your review.',
  },
  {
    number: '05',
    title: 'Keep approved context healthy',
    body: 'Review drift, contradictions, citations, and expiry without silently deleting uncertain knowledge.',
  },
  {
    number: '06',
    title: 'Optional: share it and prove reuse',
    body: 'When the solo loop is working, propose approved context through Git or retrieve it from a second environment.',
  },
];

function GraphSearchShowcase() {
  return (
    <section className="graph-showcase" id="graph-search">
      <header className="section-heading section-heading--split graph-showcase__heading">
        <div>
          <span className="eyebrow">Current-code verification engine</span>
          <h2>Verify a source claim against the worktree you are changing.</h2>
        </div>
        <p>
          When the task needs current-code evidence, Threadnote gives agents two graph views: one for a scoped source
          question and one for whole-repository topology. Neither is mixed into historical memory recall.
        </p>
      </header>

      <div className="graph-showcase__verification">
        <ol>
          <li>
            <span>01</span> Ask <code>inspect_code_graph</code> a scoped source question in this worktree.
          </li>
          <li>
            <span>02</span> Read its snapshot, provenance, freshness, and coverage before relying on the result.
          </li>
          <li>
            <span>03</span> Open the exact file or symbol before changing code; use topology only when the task needs
            it.
          </li>
        </ol>
        <div>
          <a className="button" href={docsArticleHref('graph-operations')}>
            Verify current code <Icon name="arrow" aria-hidden="true" />
          </a>
          <a className="button button--ghost" href={docsArticleHref('graph-checkpoints')}>
            Graph checkpoint docs
          </a>
          <a className="button button--ghost" href={siteHref('performance/')}>
            Performance evidence
          </a>
        </div>
      </div>
    </section>
  );
}

export default function LandingPage() {
  const latestArticle = articles[0];
  setDocumentMeta(
    'Shared context for coding agents',
    'Give coding agents the decisions and current code they need, then review what they leave for the next task.',
  );

  return (
    <SiteShell page="home" fullBleed>
      <section className="hero section-grid">
        <div className="hero__copy">
          <div className="hero__version">
            <span className="status-dot" />
            Threadnote 5.0 · local and Git-backed
          </div>
          <h1>
            Less rediscovery.
            <span>More finished work.</span>
          </h1>
          <p className="hero__lede">
            New session. Same codebase. Skip the repeat investigation. Threadnote carries useful context between coding
            agents, with sources they can check and decisions you can review.
          </p>
          <div className="hero-study" role="group" aria-label="Measured continuation study results">
            <span className="hero-study__eyebrow">Measured in our 5.1 beta study</span>
            <dl className="hero-study__metrics">
              <div>
                <dt>fewer tokens</dt>
                <dd>
                  65.6<span>%</span>
                </dd>
              </div>
              <div>
                <dt>less time</dt>
                <dd>
                  46.1<span>%</span>
                </dd>
              </div>
            </dl>
            <p className="hero-study__scope">
              Per verified completion. Five tasks, one model, versus files-only with no handoff.
            </p>
            <a className="hero-study__link" href={whatsNewArticleHref(continuationStudySlug)}>
              Read the study <Icon name="arrow" aria-hidden="true" />
            </a>
          </div>
          <div className="hero__actions">
            <a className="button" href={docsArticleHref('installation')}>
              Install Threadnote
              <Icon name="arrow" aria-hidden="true" />
            </a>
            <a className="button button--ghost" href={docsArticleHref('threadnote-5-journey')}>
              See how it works
            </a>
          </div>
          <div className="hero__install">
            <code>curl -fsSL https://raw.githubusercontent.com/threadnote/threadnote/main/scripts/install.sh | sh</code>
            <span>macOS & Linux · standalone runtime</span>
          </div>
        </div>
        <div className="hero__visual">
          <Suspense fallback={<div className="thread-scene thread-scene--fallback" />}>
            <ThreadScene />
          </Suspense>
          <div className="hero-node hero-node--memory">
            <span>why it was built this way</span>
            <strong>reviewed decision</strong>
          </div>
          <div className="hero-node hero-node--graph">
            <span>what the code does now</span>
            <strong>current local files</strong>
          </div>
          <div className="hero-node hero-node--share">
            <span>what this task learned</span>
            <strong>your review</strong>
          </div>
          <div className="hero__caption">
            <span>Reviewed context</span>
            <i />
            <span>Current evidence</span>
          </div>
        </div>
        {latestArticle && latestArticle.slug !== continuationStudySlug ? (
          <a className="home-update-banner home-update-banner--hero" href={whatsNewArticleHref(latestArticle.slug)}>
            <span className="home-update-banner__label">Latest · What&apos;s new</span>
            <div>
              <strong>{latestArticle.title}</strong>
              <p>{latestArticle.summary}</p>
            </div>
            <span className="home-update-banner__action">
              Read what&apos;s new
              <Icon name="arrow" aria-hidden="true" />
            </span>
          </a>
        ) : null}
      </section>

      {latestRelease ? (
        <div className="home-update-banners" aria-label="Latest Threadnote release">
          <a
            className="home-update-banner home-update-banner--release"
            href={whatsNewReleaseHref(latestRelease.version)}
          >
            <span className="home-update-banner__label">Latest release</span>
            <div>
              <strong>Threadnote {latestRelease.version.replace(/^v/, '')}</strong>
              <p>{latestRelease.headline}</p>
            </div>
            <span className="home-update-banner__action">
              Read release notes
              <Icon name="arrow" aria-hidden="true" />
            </span>
          </a>
        </div>
      ) : null}

      <section className="trust-strip" aria-label="Threadnote runtime guarantees">
        <div>
          <strong>Works across agents</strong>
          <span>One source of approved context</span>
        </div>
        <div>
          <strong>Shows its sources</strong>
          <span>See where a decision came from</span>
        </div>
        <div>
          <strong>You approve changes</strong>
          <span>Nothing is silently saved or shared</span>
        </div>
        <div>
          <strong>Local by default</strong>
          <span>No Threadnote cloud account required</span>
        </div>
      </section>

      <section className="content-section content-section--trace">
        <header className="section-heading">
          <span className="eyebrow">Meet the Context Brief</span>
          <h2>A short, useful briefing before the agent starts.</h2>
          <p>
            A Context Brief brings together the decisions, unfinished work, and current code that matter for one task.
            Every important claim keeps a link to its source, and missing information stays clearly marked as unknown.
          </p>
        </header>
        <AgentTrace scenario={heroScenario} />
      </section>

      <section className="content-section" id="features">
        <header className="section-heading section-heading--split">
          <div>
            <span className="eyebrow">What Threadnote does</span>
            <h2>Useful context before the task. Better context after it.</h2>
          </div>
          <p>
            Threadnote does not replace your repository, Git review, or coding-agent environment. It connects them with
            context that stays cited, reviewable, and reusable.
          </p>
        </header>
        <div className="feature-grid">
          {features.map((feature, index) => (
            <article className={`feature-card feature-card--${feature.accent}`} key={feature.label}>
              <div className="feature-card__top">
                <span className="feature-card__index">0{index + 1}</span>
                <Icon name={feature.icon} aria-hidden="true" />
              </div>
              <span className="eyebrow">{feature.label}</span>
              <h3>{feature.title}</h3>
              <p>{feature.body}</p>
              <code>{feature.detail}</code>
            </article>
          ))}
        </div>
      </section>

      <section className="architecture-band">
        <div className="architecture-band__copy">
          <span className="eyebrow">Private by default</span>
          <h2>Your context stays on your machine.</h2>
          <p>
            Saved decisions, indexes, local models, and code maps live under <code>~/.threadnote</code>. Threadnote
            shows you a preview before anything is shared.
          </p>
          <a className="text-link" href={docsArticleHref('architecture')}>
            Read the architecture
            <Icon name="arrow" aria-hidden="true" />
          </a>
        </div>
        <div className="architecture-map" aria-label="Threadnote data flow">
          <div className="architecture-map__boundary">
            <span>Your machine</span>
            <div className="architecture-map__core">
              <small>~/.threadnote</small>
              <strong>Canonical memory</strong>
              <strong>SQLite indexes</strong>
              <strong>Local models</strong>
              <strong>Code snapshots</strong>
            </div>
            <div className="architecture-map__agents">
              <span>Supported</span>
              <span>coding-agent</span>
              <span>environments</span>
              <span>↗</span>
            </div>
          </div>
          <div className="architecture-map__external">
            <div>
              <span>Explicit</span>
              <strong>Team share</strong>
            </div>
            <div>
              <span>Allowlisted</span>
              <strong>Obsidian</strong>
            </div>
          </div>
        </div>
      </section>

      <section className="content-section">
        <header className="section-heading">
          <span className="eyebrow">One solo-first workflow</span>
          <h2>Start informed. Finish with context the next engineer can trust.</h2>
          <p>
            A coding-agent environment is the editor, CLI, or other{' '}
            <a href={siteHref('agents/')}>supported catalog integration</a> where an agent works; Threadnote calls it a
            surface. Connect one, then work normally: its installed guidance starts with a cited Context Brief and ends
            meaningful work with a Knowledge Delta you can review.
          </p>
        </header>
        <ol className="workflow-list">
          {workflow.map(item => (
            <li key={item.number}>
              <span>{item.number}</span>
              <div>
                <h3>{item.title}</h3>
                <p>{item.body}</p>
              </div>
            </li>
          ))}
        </ol>
      </section>

      <GraphSearchShowcase />

      <section className="manager-teaser">
        <div className="manager-teaser__copy">
          <span className="eyebrow">Threadnote Manager</span>
          <h2>See what Threadnote knows and when it needs attention.</h2>
          <p>
            Browse saved decisions, check team shares and agent guidance, explore the current code map, and see which
            context is current, outdated, or waiting for review.
          </p>
          <a className="button button--light" href={siteHref('manager-demo/')}>
            Open interactive demo
            <Icon name="arrow" aria-hidden="true" />
          </a>
        </div>
        <div className="manager-teaser__window">
          <div className="manager-teaser__chrome">
            <span />
            <span />
            <span />
            <code>localhost · Manager</code>
          </div>
          <div className="manager-teaser__app">
            <aside>
              <img alt="Threadnote" className="manager-teaser__brand" src={siteHref('threadnote-logo.svg')} />
              <span className="is-active">Graph</span>
              <span>Memory</span>
              <span>Shares</span>
              <span>Doctor</span>
            </aside>
            <div className="manager-teaser__canvas">
              <svg viewBox="0 0 620 300" aria-hidden="true">
                <g className="preview-lines">
                  <path d="M90 150 220 82 330 152 475 70" />
                  <path d="M90 150 215 245 330 152 500 226" />
                  <path d="M220 82 325 45 475 70" />
                  <path d="M215 245 360 255 500 226" />
                </g>
                <g className="preview-nodes">
                  <circle cx="90" cy="150" r="13" />
                  <circle cx="220" cy="82" r="10" />
                  <circle cx="215" cy="245" r="11" />
                  <circle cx="330" cy="152" r="16" />
                  <circle cx="325" cy="45" r="8" />
                  <circle cx="475" cy="70" r="12" />
                  <circle cx="360" cy="255" r="9" />
                  <circle cx="500" cy="226" r="13" />
                </g>
              </svg>
              <div className="manager-teaser__legend">
                <span>
                  <i className="dot dot--ts" /> TypeScript
                </span>
                <span>
                  <i className="dot dot--kt" /> Kotlin
                </span>
                <span>
                  <i className="dot dot--swift" /> Swift
                </span>
              </div>
            </div>
            <div className="manager-teaser__detail">
              <span>SYMBOL</span>
              <h3>AuthSession</h3>
              <code>libs/auth/session.ts:18</code>
              <dl>
                <div>
                  <dt>Inbound</dt>
                  <dd>7</dd>
                </div>
                <div>
                  <dt>Outbound</dt>
                  <dd>5</dd>
                </div>
              </dl>
            </div>
          </div>
        </div>
      </section>

      <section className="content-section content-section--cta">
        <div className="cta-panel">
          <span className="eyebrow">Keep the context lifecycle moving</span>
          <h2>Give the next agent reviewed decisions and current evidence—not another transcript.</h2>
          <CodeBlock
            label="macOS & Linux"
            code="curl -fsSL https://raw.githubusercontent.com/threadnote/threadnote/main/scripts/install.sh | sh"
          />
          <div className="cta-panel__actions">
            <a className="button" href={siteHref('docs/')}>
              Read the docs
            </a>
            <a className="button button--ghost" href={githubUrl}>
              View on GitHub
            </a>
          </div>
        </div>
      </section>
    </SiteShell>
  );
}
