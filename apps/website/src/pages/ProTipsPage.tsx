import {Array as EffectArray, Option as EffectOption} from 'effect';
import {useEffect, useMemo, useRef, useState} from 'react';
import {AgentTrace} from '../components/AgentTrace';
import {Icon} from '../components/Icons';
import {SiteShell} from '../components/SiteShell';
import {proTips, type ProTip} from '../content/proTips';
import {docsArticleHref, setDocumentMeta} from '../lib/site';

const categories: Array<{id: 'all' | ProTip['category']; label: string}> = [
  {id: 'all', label: 'All workflows'},
  {id: 'team', label: 'Team'},
  {id: 'continuity', label: 'Task context'},
  {id: 'operations', label: 'Health & trust'},
  {id: 'graph', label: 'Current code'},
];

export default function ProTipsPage() {
  const [category, setCategory] = useState<(typeof categories)[number]['id']>('all');
  const [activeId, setActiveId] = useState(proTips[0].id);
  const activeHeadingRef = useRef<HTMLHeadingElement>(null);
  const shouldFocusActiveRef = useRef(false);
  const visibleTips = useMemo(
    () => (category === 'all' ? proTips : EffectArray.filter(proTips, tip => tip.category === category)),
    [category],
  );
  const active =
    EffectOption.getOrUndefined(EffectArray.findFirst(proTips, tip => tip.id === activeId)) ??
    visibleTips[0] ??
    proTips[0];

  const chooseCategory = (next: typeof category) => {
    shouldFocusActiveRef.current = true;
    setCategory(next);
    const first =
      next === 'all'
        ? proTips[0]
        : EffectOption.getOrUndefined(EffectArray.findFirst(proTips, tip => tip.category === next));
    if (first) {
      setActiveId(first.id);
      if (first.id === active.id) {
        shouldFocusActiveRef.current = false;
        window.requestAnimationFrame(() => activeHeadingRef.current?.focus({preventScroll: true}));
      }
    }
  };

  const chooseTip = (id: string): void => {
    shouldFocusActiveRef.current = true;
    setActiveId(id);
    if (id === active.id) {
      shouldFocusActiveRef.current = false;
      window.requestAnimationFrame(() => activeHeadingRef.current?.focus({preventScroll: true}));
    }
  };

  useEffect(() => {
    setDocumentMeta(
      'Pro tips',
      'Practical Threadnote 5 workflows for cited task context, reviewed closeout, cross-agent reuse, and continuous health.',
    );
  }, []);

  useEffect(() => {
    if (!shouldFocusActiveRef.current) return;
    shouldFocusActiveRef.current = false;
    window.requestAnimationFrame(() => activeHeadingRef.current?.focus({preventScroll: true}));
  }, [active.id]);

  return (
    <SiteShell page="pro-tips" fullBleed>
      <section className="subpage-hero">
        <div>
          <span className="eyebrow">Threadnote 5 field guide</span>
          <h1>Make context trustworthy across the whole task.</h1>
          <p>
            Threadnote is the source-verifiable context lifecycle for engineering work. These practical patterns cover a
            bounded Context Brief, exact local evidence, a reviewed Knowledge Delta, Git sharing, and context health
            across agent vendors.
          </p>
        </div>
        <div className="subpage-hero__metric">
          <strong>{proTips.length}</strong>
          <span>high-leverage workflows</span>
          <small>Each one includes a live agent simulation.</small>
        </div>
      </section>

      <section className="tips-explorer content-section">
        <div className="tips-filter" role="group" aria-label="Filter pro tips">
          {EffectArray.map(categories, item => (
            <button
              key={item.id}
              type="button"
              aria-pressed={category === item.id}
              onClick={() => chooseCategory(item.id)}
            >
              {item.label}
            </button>
          ))}
        </div>
        <div className="tips-layout">
          <nav className="tips-index" aria-label="Pro tip scenarios">
            {EffectArray.map(visibleTips, tip => (
              <button
                type="button"
                key={tip.id}
                aria-current={tip.id === active.id ? 'true' : undefined}
                className={tip.id === active.id ? 'is-active' : ''}
                onClick={() => chooseTip(tip.id)}
              >
                <span>{tip.number}</span>
                <div>
                  <small>{tip.category}</small>
                  <strong>{tip.title}</strong>
                </div>
                <Icon name="arrow" aria-hidden="true" />
              </button>
            ))}
          </nav>
          <article className="tip-detail" key={active.id}>
            <header>
              <span className="eyebrow">
                Tip {active.number} · {active.category}
              </span>
              <h2 ref={activeHeadingRef} tabIndex={-1}>
                {active.title}
              </h2>
              <p>{active.summary}</p>
            </header>
            <div className="tip-detail__why">
              <strong>Why it works</strong>
              <p>{active.why}</p>
            </div>
            <AgentTrace scenario={active.scenario} compact />
            <div className="tip-checklist">
              <h3>Put it into practice</h3>
              <ul>
                {EffectArray.map(active.practice, item => (
                  <li key={item}>
                    <Icon name="check" aria-hidden="true" />
                    {item}
                  </li>
                ))}
              </ul>
            </div>
          </article>
        </div>
      </section>

      <section className="content-section content-section--cta">
        <div className="cta-panel cta-panel--compact">
          <span className="eyebrow">Make it your default loop</span>
          <h2>Start with evidence. Review what changed. Prove another agent can use it.</h2>
          <p>
            Surface support comes from the public agent catalog. Connect the hosts you use, then follow one local and
            Git-backed context lifecycle without product-specific forks.
          </p>
          <a className="button" href={docsArticleHref('threadnote-5-journey')}>
            Follow the Threadnote 5 journey
            <Icon name="arrow" aria-hidden="true" />
          </a>
        </div>
      </section>
    </SiteShell>
  );
}
