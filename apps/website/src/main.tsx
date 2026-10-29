import '@fontsource-variable/spline-sans';
import '@fontsource-variable/jetbrains-mono';
import {
  Component,
  StrictMode,
  Suspense,
  lazy,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentType,
  type ReactNode,
} from 'react';
import {createRoot} from 'react-dom/client';
import {
  commitPreparedRoute,
  createSitePageModuleCache,
  isSameDocumentNavigation,
  sitePageForPathname,
  type SitePage,
} from './lib/routes';
import './styles.css';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

type PageModule = {default: ComponentType};

class RouteErrorBoundary extends Component<{readonly children: ReactNode}, {readonly failed: boolean}> {
  override state = {failed: false};

  static getDerivedStateFromError(): {readonly failed: boolean} {
    return {failed: true};
  }

  override render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <main className="page-error" role="alert">
        <span className="eyebrow">Page unavailable</span>
        <h1>Threadnote could not load this route.</h1>
        <p>The website may have been updated while this tab was open. Reload to fetch the current assets.</p>
        <button type="button" onClick={() => window.location.reload()}>
          Reload page
        </button>
      </main>
    );
  }
}

const pageLoaders: Readonly<Record<SitePage, () => Promise<PageModule>>> = {
  home: () => import('./pages/LandingPage'),
  performance: () => import('./pages/PerformancePage'),
  'performance-graphify': () => import('./pages/GraphifyPerformancePage'),
  docs: () => import('./pages/DocsPage'),
  agents: () => import('./pages/AgentsPage'),
  'whats-new': () => import('./pages/WhatsNewPage'),
  'pro-tips': () => import('./pages/ProTipsPage'),
  'manager-demo': () => import('./pages/ManagerDemoPage'),
  faq: () => import('./pages/FaqPage'),
};

const pageModuleCache = createSitePageModuleCache(pageLoaders);

function declaredInitialPage(): SitePage {
  const routedPage = sitePageForPathname(window.location.pathname, import.meta.env.BASE_URL);
  if (routedPage) return routedPage;
  const page = document.body.dataset.page;
  switch (page) {
    case 'docs':
      return page;
    case 'agents':
      return page;
    case 'performance':
      return page;
    case 'performance-graphify':
      return page;
    case 'whats-new':
      return page;
    case 'pro-tips':
      return page;
    case 'manager-demo':
      return page;
    case 'faq':
      return page;
    default:
      return 'home';
  }
}

const initialPage = declaredInitialPage();
const InitialPage = lazy(() => pageModuleCache.load(initialPage));

type ActiveRoute = Readonly<{
  page: SitePage;
  Page: ComponentType;
  href: string;
}>;

function scrollToRouteTarget(href: string): void {
  const url = new URL(href);
  if (!url.hash) {
    window.scrollTo({left: 0, top: 0});
    return;
  }
  let id: string;
  try {
    id = decodeURIComponent(Effect.pipe(url.hash, EffectString.slice(1)));
  } catch {
    id = Effect.pipe(url.hash, EffectString.slice(1));
  }
  const target = document.getElementById(id);
  if (!target) return;
  target.scrollIntoView();
  if (target instanceof HTMLElement) {
    if (!target.hasAttribute('tabindex')) target.tabIndex = -1;
    target.focus({preventScroll: true});
  }
}

function RoutedPage({route}: {readonly route: ActiveRoute}) {
  useLayoutEffect(() => {
    scrollToRouteTarget(route.href);
  }, [route.href]);

  return <route.Page key={new URL(route.href).pathname} />;
}

function WebsiteRouter() {
  const [route, setRoute] = useState<ActiveRoute>({
    page: initialPage,
    Page: InitialPage,
    href: window.location.href,
  });
  const requestedNavigation = useRef(0);

  useEffect(() => {
    const pageForAnchor = (anchor: HTMLAnchorElement): SitePage | undefined => {
      if (anchor.target && anchor.target !== '_self') return undefined;
      if (anchor.hasAttribute('download')) return undefined;
      const url = new URL(anchor.href, window.location.href);
      if (url.origin !== window.location.origin) return undefined;
      return sitePageForPathname(url.pathname, import.meta.env.BASE_URL);
    };

    const navigate = async (url: URL, mode: 'push' | 'pop'): Promise<void> => {
      const nextPage = sitePageForPathname(url.pathname, import.meta.env.BASE_URL);
      if (!nextPage) return;
      const request = requestedNavigation.current + 1;
      requestedNavigation.current = request;

      try {
        await commitPreparedRoute(
          () => pageModuleCache.load(nextPage),
          () => request === requestedNavigation.current,
          module => {
            if (mode === 'push') window.history.pushState({}, '', url);
            document.body.dataset.page = nextPage;
            setRoute({page: nextPage, Page: module.default, href: url.href});
          },
        );
      } catch {
        window.location.assign(url);
      }
    };

    const click = (event: MouseEvent) => {
      if (
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      ) {
        return;
      }
      const target = event.target;
      if (!(target instanceof Element)) return;
      const anchor = target.closest<HTMLAnchorElement>('a[href]');
      if (!anchor || !pageForAnchor(anchor)) return;

      const url = new URL(anchor.href, window.location.href);
      const currentUrl = new URL(window.location.href);
      if (url.href === currentUrl.href) return;
      if (isSameDocumentNavigation(currentUrl, url)) {
        event.preventDefault();
        window.history.pushState({}, '', url);
        scrollToRouteTarget(url.href);
        return;
      }
      event.preventDefault();
      void navigate(url, 'push');
    };

    const prefetch = (event: Event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const anchor = target.closest<HTMLAnchorElement>('a[href]');
      if (!anchor) return;
      const page = pageForAnchor(anchor);
      if (page) void pageModuleCache.prefetch(page);
    };

    const popstate = () => {
      void navigate(new URL(window.location.href), 'pop');
    };

    document.addEventListener('click', click);
    document.addEventListener('pointerover', prefetch, {passive: true});
    document.addEventListener('focusin', prefetch);
    window.addEventListener('popstate', popstate);
    return () => {
      requestedNavigation.current += 1;
      document.removeEventListener('click', click);
      document.removeEventListener('pointerover', prefetch);
      document.removeEventListener('focusin', prefetch);
      window.removeEventListener('popstate', popstate);
    };
  }, []);

  return (
    <RouteErrorBoundary key={route.page}>
      <Suspense
        fallback={
          <div className="page-loading" role="status">
            <span className="status-dot" />
            Loading Threadnote…
          </div>
        }
      >
        <RoutedPage route={route} />
      </Suspense>
    </RouteErrorBoundary>
  );
}

const root = document.getElementById('root');

if (!root) {
  throw new Error('Threadnote website root is missing.');
}

createRoot(root).render(
  <StrictMode>
    <WebsiteRouter />
  </StrictMode>,
);
