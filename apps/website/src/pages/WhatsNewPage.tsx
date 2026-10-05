import {useEffect} from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import articles from 'virtual:threadnote-articles';
import releases from 'virtual:threadnote-release-notes';
import {Icon} from '../components/Icons';
import {PostShare} from '../components/PostShare';
import {SiteShell} from '../components/SiteShell';
import {
  filterWebsiteUpdatesByKind,
  orderWebsiteUpdatesDescending,
  websiteSocialImageForArticle,
  websiteSocialImageForRelease,
  type WebsiteSocialImage,
} from '../content/websiteArticles';
import {
  whatsNewArticlePath,
  whatsNewIndexViewForSearch,
  whatsNewPostForPathname,
  whatsNewReleasePath,
  type WhatsNewIndexView,
} from '../lib/routes';
import {docsArticleHref, setDocumentMeta, siteHref, whatsNewArticleHref, whatsNewReleaseHref} from '../lib/site';

const postDate = new Intl.DateTimeFormat('en', {
  day: 'numeric',
  month: 'long',
  timeZone: 'UTC',
  year: 'numeric',
});

type WebsiteUpdate = Readonly<{
  author: string;
  body: string;
  canonicalUrl: string;
  externalHref?: string;
  highlights: readonly string[];
  href: string;
  kind: 'article' | 'release';
  publishedAt: string;
  socialImage: WebsiteSocialImage;
  stableId: string;
  summary: string;
  title: string;
  version?: string;
}>;

function websiteUpdates(): readonly WebsiteUpdate[] {
  return orderWebsiteUpdatesDescending([
    ...articles.map(article => ({
      author: article.author,
      body: article.body,
      canonicalUrl: new URL(whatsNewArticlePath(article.slug), 'https://threadnote.io/').href,
      highlights: article.highlights,
      href: whatsNewArticleHref(article.slug),
      kind: 'article' as const,
      publishedAt: article.publishedAt,
      socialImage: websiteSocialImageForArticle(article),
      stableId: `article:${article.slug}`,
      summary: article.summary,
      title: article.title,
    })),
    ...releases.map(release => ({
      author: 'Threadnote',
      body: release.body,
      canonicalUrl: new URL(whatsNewReleasePath(release.version), 'https://threadnote.io/').href,
      externalHref: release.releaseUrl,
      highlights: release.highlights,
      href: whatsNewReleaseHref(release.version),
      kind: 'release' as const,
      publishedAt: release.publishedAt,
      socialImage: websiteSocialImageForRelease(release),
      stableId: `release:${release.version}`,
      summary: release.summary,
      title: `Threadnote ${release.version.replace(/^v/, '')}`,
      version: release.version,
    })),
  ]);
}

function UpdateMeta({update}: {readonly update: WebsiteUpdate}) {
  return (
    <div className={`release-meta release-meta--${update.kind}`}>
      <span>{update.kind === 'article' ? 'Article' : 'Release'}</span>
      <strong>{update.kind === 'article' ? `By ${update.author}` : update.version}</strong>
      <time dateTime={update.publishedAt}>{postDate.format(new Date(update.publishedAt))}</time>
    </div>
  );
}

function UpdateDetail({update}: {readonly update: WebsiteUpdate}) {
  useEffect(() => {
    setDocumentMeta(update.title, update.summary, update.socialImage);
  }, [
    update.socialImage.alt,
    update.socialImage.height,
    update.socialImage.type,
    update.socialImage.url,
    update.socialImage.width,
    update.summary,
    update.title,
  ]);

  return (
    <SiteShell page="whats-new" fullBleed>
      <article className="post-detail">
        <a
          className="post-detail__back"
          href={siteHref(`whats-new/?view=${update.kind === 'article' ? 'articles' : 'releases'}`)}
        >
          <span aria-hidden="true">←</span> {update.kind === 'article' ? 'All articles' : 'All release notes'}
        </a>
        <header className="post-detail__header">
          <UpdateMeta update={update} />
          <h1>{update.title}</h1>
          <p>{update.summary}</p>
          {update.kind === 'release' && update.externalHref ? (
            <a className="button button--ghost" href={update.externalHref} target="_blank" rel="noreferrer">
              GitHub release
              <Icon name="arrow" aria-hidden="true" />
            </a>
          ) : null}
        </header>
        <div className="post-detail__body">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{update.body}</ReactMarkdown>
        </div>
        <PostShare title={update.title} url={update.canonicalUrl} />
      </article>
    </SiteShell>
  );
}

function UpdateSwitch({updates, view}: {readonly updates: readonly WebsiteUpdate[]; readonly view: WhatsNewIndexView}) {
  const articleCount = filterWebsiteUpdatesByKind(updates, 'article').length;
  const releaseCount = filterWebsiteUpdatesByKind(updates, 'release').length;

  return (
    <nav className="update-switch" aria-label="What's new content">
      <span className="update-switch__label">Browse</span>
      <div className="update-switch__options">
        <a href={siteHref('whats-new/?view=articles')} aria-current={view === 'articles' ? 'page' : undefined}>
          Articles <span>{articleCount}</span>
        </a>
        <a href={siteHref('whats-new/?view=releases')} aria-current={view === 'releases' ? 'page' : undefined}>
          Release notes <span>{releaseCount}</span>
        </a>
      </div>
    </nav>
  );
}

function WhatsNewIndex({
  updates,
  view,
}: {
  readonly updates: readonly WebsiteUpdate[];
  readonly view: WhatsNewIndexView;
}) {
  const kind = view === 'articles' ? 'article' : 'release';
  const visibleUpdates = filterWebsiteUpdatesByKind(updates, kind);
  const latest = visibleUpdates[0];
  const earlier = visibleUpdates.slice(1);
  const isArticles = view === 'articles';

  useEffect(() => {
    setDocumentMeta(
      isArticles ? 'Threadnote articles' : 'Threadnote release notes',
      isArticles
        ? 'Engineering stories from building Threadnote, including the experiments that do not ship.'
        : 'Stable Threadnote releases, upgrade notes, and the changes worth knowing about.',
      latest?.socialImage,
    );
  }, [
    isArticles,
    latest?.socialImage.alt,
    latest?.socialImage.height,
    latest?.socialImage.type,
    latest?.socialImage.url,
    latest?.socialImage.width,
  ]);

  if (!latest) {
    return (
      <SiteShell page="whats-new" fullBleed>
        <UpdateSwitch updates={updates} view={view} />
        <section className="release-archive" aria-labelledby="empty-updates-title">
          <header className="release-archive__heading">
            <h1 id="empty-updates-title">{isArticles ? 'No articles yet.' : 'No release notes yet.'}</h1>
            <p>Check back for the next update from Threadnote.</p>
          </header>
        </section>
      </SiteShell>
    );
  }

  return (
    <SiteShell page="whats-new" fullBleed>
      <UpdateSwitch updates={updates} view={view} />

      <section className="release-hero" aria-labelledby="latest-update-title">
        <div className="release-hero__intro">
          <UpdateMeta update={latest} />
          <span className="eyebrow">Latest from Threadnote</span>
          <h1 id="latest-update-title">{latest.title}</h1>
          <p>{latest.summary}</p>
          <div className="release-hero__actions">
            <a className="button" href={latest.href}>
              {latest.kind === 'article' ? 'Read the article' : 'Read the release post'}
              <Icon name="arrow" aria-hidden="true" />
            </a>
            <a className="button button--ghost" href={docsArticleHref('installation')}>
              Install or update
            </a>
          </div>
        </div>

        <div className="release-hero__highlights" aria-label={`${latest.title} highlights`}>
          <div className="release-hero__index">
            <span>{isArticles ? 'Latest article' : 'Latest release'}</span>
            <strong>{isArticles ? 'A' : 'R'}</strong>
          </div>
          <ol>
            {latest.highlights.slice(0, 4).map((highlight, index) => (
              <li key={highlight}>
                <span>{String(index + 1).padStart(2, '0')}</span>
                <strong>{highlight}</strong>
              </li>
            ))}
          </ol>
        </div>
      </section>

      <section className="release-archive" aria-labelledby="release-archive-title">
        <header className="release-archive__heading">
          <div>
            <span className="eyebrow">{isArticles ? 'More articles' : 'Release notes'}</span>
            <h2 id="release-archive-title">
              {isArticles ? 'Engineering stories. No launch confetti.' : 'Earlier releases.'}
            </h2>
          </div>
          <p>
            {visibleUpdates.length} public {visibleUpdates.length === 1 ? 'post' : 'posts'}, ordered by publication
            time. Each has its own permanent, shareable page.
          </p>
        </header>

        <div className="release-grid">
          {earlier.map((update, index) => (
            <article className={`release-card release-card--${update.kind}`} key={update.stableId}>
              <UpdateMeta update={update} />
              <div className="release-card__number" aria-hidden="true">
                {String(index + 2).padStart(2, '0')}
              </div>
              <h3>{update.title}</h3>
              <p>{update.summary}</p>
              {update.highlights.length > 0 ? (
                <ul>
                  {update.highlights.slice(0, 3).map(highlight => (
                    <li key={highlight}>{highlight}</li>
                  ))}
                </ul>
              ) : null}
              <a className="text-link" href={update.href}>
                {update.kind === 'article' ? 'Read article' : 'Read release post'}
                <Icon name="arrow" aria-hidden="true" />
              </a>
            </article>
          ))}
        </div>
      </section>
    </SiteShell>
  );
}

export default function WhatsNewPage() {
  const updates = websiteUpdates();
  const route = whatsNewPostForPathname(window.location.pathname, import.meta.env.BASE_URL);
  const view = whatsNewIndexViewForSearch(window.location.search);
  const selected = route
    ? updates.find(update =>
        route.kind === 'article'
          ? update.stableId === `article:${route.slug}`
          : update.stableId === `release:${route.version}`,
      )
    : undefined;

  return selected ? <UpdateDetail update={selected} /> : <WhatsNewIndex updates={updates} view={view} />;
}
