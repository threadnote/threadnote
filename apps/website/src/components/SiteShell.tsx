import {Array as EffectArray} from 'effect';
import {useEffect, useState, type ReactNode} from 'react';
import {docsArticleHref, githubUrl, siteHref, xUrl} from '../lib/site';
import type {SitePage} from '../lib/routes';
import {ThreadnoteMark} from './Brand';
import {Icon} from './Icons';

const navItems: Array<{activePages: readonly SitePage[]; label: string; href: string}> = [
  {activePages: ['home'], label: 'Product', href: ''},
  {activePages: ['performance', 'performance-graphify'], label: 'Performance', href: 'performance/'},
  {activePages: ['docs'], label: 'Docs', href: 'docs/'},
  {activePages: ['agents'], label: 'Agents', href: 'agents/'},
  {activePages: ['whats-new'], label: "What's new", href: 'whats-new/'},
  {activePages: ['pro-tips'], label: 'Pro tips', href: 'pro-tips/'},
  {activePages: ['faq'], label: 'FAQ', href: 'faq/'},
];

export function SiteShell({
  page,
  children,
  fullBleed = false,
}: {
  page: SitePage;
  children: ReactNode;
  fullBleed?: boolean;
}) {
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    setMenuOpen(false);
  }, [page]);

  useEffect(() => {
    const closeMenu = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenuOpen(false);
    };
    window.addEventListener('keydown', closeMenu);
    return () => window.removeEventListener('keydown', closeMenu);
  }, []);

  return (
    <>
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>
      <header className="site-header">
        <div className="site-header__inner">
          <ThreadnoteMark />
          <button
            className="nav-toggle"
            type="button"
            aria-expanded={menuOpen}
            aria-controls="site-nav"
            onClick={() => setMenuOpen(current => !current)}
          >
            <span />
            <span />
            <span />
            <span className="sr-only">Toggle navigation</span>
          </button>
          <nav id="site-nav" className={`site-nav${menuOpen ? ' site-nav--open' : ''}`} aria-label="Primary navigation">
            {EffectArray.map(navItems, item => (
              <a
                key={item.href}
                href={siteHref(item.href)}
                aria-current={item.activePages.includes(page) ? 'page' : undefined}
              >
                {item.label}
              </a>
            ))}
            <div className="site-nav__socials" role="group" aria-label="Threadnote social links">
              <a
                className="site-nav__icon-link"
                href={githubUrl}
                target="_blank"
                rel="noreferrer"
                aria-label="Threadnote on GitHub"
                title="Threadnote on GitHub"
              >
                <Icon name="github" aria-hidden="true" />
              </a>
              <a
                className="site-nav__icon-link"
                href={xUrl}
                target="_blank"
                rel="noreferrer"
                aria-label="Threadnote on X"
                title="Threadnote on X"
              >
                <Icon name="x" aria-hidden="true" />
              </a>
            </div>
            <a className="button button--small" href={docsArticleHref('installation')}>
              Install
            </a>
          </nav>
        </div>
      </header>
      <main id="main-content" tabIndex={-1} className={fullBleed ? 'site-main site-main--full' : 'site-main'}>
        {children}
      </main>
      <footer className="site-footer">
        <div>
          <ThreadnoteMark />
          <p>Shared, reviewable context for the coding agents your team uses.</p>
        </div>
        <div className="site-footer__links">
          <a href={siteHref('docs/')}>Documentation</a>
          <a href={siteHref('agents/')}>Supported agents</a>
          <a href={siteHref('performance/')}>Performance</a>
          <a href={siteHref('performance/graphify/')}>Threadnote vs Graphify</a>
          <a href={siteHref('whats-new/')}>What's new</a>
          <a href={siteHref('pro-tips/')}>Pro tips</a>
          <a href={siteHref('faq/')}>FAQ</a>
          <a href={siteHref('font-licenses.txt')}>Font licenses</a>
          <a href={githubUrl}>Source</a>
          <a href={`${githubUrl}/issues`}>Issues</a>
        </div>
        <p className="site-footer__meta">
          © Denys Kashkovskyi 2026 · AGPL-3.0 · Local-first · Built for reviewed reuse
        </p>
      </footer>
    </>
  );
}
